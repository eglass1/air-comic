/**
 * Public rooms and directory -- phase 4 acceptance, [Q-08].
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  closeAllSockets,
  installFakeWebSocket,
  registerRelay,
  resetRelays,
  type FakeRelay,
} from '../../../test/fakeRelay';
import { relayPool } from '../../nostr/relayPool';
import { RoomSession } from '../roomSession';
import { DatabaseService, type UserProfile } from '../db';
import { generateUserKeyPair, importSigningPrivateKeyFromJwk } from '../../crypto';
import { derivePublicRoomId, generateRoomSecret } from '../keys';
import {
  directoryService,
  occupancyBucket,
  PublicRoomPresenceBeacon,
} from '../directory';
import { buildPublicRoomDescriptor, buildPublicRoomTombstone } from '../packets';

const URLS = ['wss://p1.test', 'wss://p2.test', 'wss://p3.test'];
let relays: FakeRelay[] = [];

installFakeWebSocket();

let dbSeq = 0;
const freshDb = () => new DatabaseService(`PubDB_${Date.now()}_${dbSeq++}`);
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function makeProfile(screenName: string): Promise<UserProfile> {
  const identity = await generateUserKeyPair();
  return {
    id: 'current_user',
    participantId: identity.participantId,
    screenName,
    avatarName: 'Armando',
    publicKeyBase64: identity.publicKeyBase64,
    publicKeyPem: identity.publicKeyPem,
    privateKeyJwk: identity.privateKeyJwk,
    privateKeyPem: identity.privateKeyPem,
    signingPublicKeyBase64: identity.signingPublicKeyBase64,
    signingPublicKeyPem: identity.signingPublicKeyPem,
    signingPrivateKeyJwk: identity.signingPrivateKeyJwk,
    signingPrivateKeyPem: identity.signingPrivateKeyPem,
    contactInfo: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

beforeAll(async () => {
  relays = URLS.map(registerRelay);
  relayPool.configure(URLS);
  await settle(50);
});

beforeEach(async () => {
  resetRelays();
  await settle(10);
});

afterAll(() => {
  closeAllSockets();
  relayPool.close();
});

describe('public room messaging', () => {
  it('carries signed but unencrypted payloads -- [PU-01][L-11]', async () => {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'pa', convId, roomMode: 'public', publicJoinToken: joinToken,
      isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    const bobRoom = new RoomSession({
      tabId: 'pb', convId, roomMode: 'public', publicJoinToken: joinToken,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();

    // No join request, no epoch, no roster [PU-05].
    expect(aliceRoom.isApproved).toBe(true);
    expect(bobRoom.isApproved).toBe(true);
    expect(aliceRoom.pendingJoinRequests.length).toBe(0);
    expect(aliceRoom.activeKeyId).toBe('public-v3');

    await aliceRoom.sendMessage('anyone can read this');
    await settle(120);
    expect(bobRoom.messages.some((m) => m.text === 'anyone can read this')).toBe(true);

    // The relay stores it readable by anyone: public means world-readable, and
    // v2's token-derived AES key was obfuscation, not confidentiality [L-11].
    // `data` is Base64URL(UTF8(payload)) with no encryption step [P-01].
    const chatEvents = relays[0].events.filter((e) => e.content.includes('room_envelope'));
    expect(chatEvents.length).toBeGreaterThan(0);
    const decoded = chatEvents
      .map((e) => JSON.parse(e.content) as { iv: string; data: string })
      .filter((env) => env.iv === '')
      .map((env) => Buffer.from(env.data, 'base64url').toString('utf8'));
    expect(decoded.some((d) => d.includes('anyone can read this'))).toBe(true);

    aliceRoom.destroy();
    bobRoom.destroy();
  }, 20000);

  it('rejects a public message with a broken signature -- [PU-01]', async () => {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const alice = await makeProfile('Alice');

    const room = new RoomSession({
      tabId: 'pc', convId, roomMode: 'public', publicJoinToken: joinToken,
      database: freshDb(),
    });
    await room.init(alice);
    await settle();

    const before = room.messages.length;
    await room.receiveFromAccelerator(JSON.stringify({ protocol: 'airthread/3', junk: true }));
    await settle();
    expect(room.messages.length).toBe(before);

    room.destroy();
  }, 20000);
});

describe('directory -- [Q-08]', () => {
  async function publishRoom(profile: UserProfile, name: string) {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const publicRoomId = await derivePublicRoomId(convId, joinToken);
    const signingPrivateKey = await importSigningPrivateKeyFromJwk(profile.signingPrivateKeyJwk);
    const descriptor = await buildPublicRoomDescriptor({
      publicRoomId, convId, publicJoinToken: joinToken, name, description: 'a room',
      creatorId: profile.participantId, creatorScreenName: profile.screenName,
      creatorSigningPublicKey: profile.signingPublicKeyBase64, signingPrivateKey,
    });
    const outcome = await directoryService.publishDescriptor({
      descriptor, signingPrivateKeyJwk: profile.signingPrivateKeyJwk,
    });
    return { convId, joinToken, publicRoomId, descriptor, outcome, signingPrivateKey };
  }

  it('lists a published room and counts only real acknowledgements -- [PU-03][O-12]', async () => {
    const alice = await makeProfile('Alice');
    const { descriptor, outcome } = await publishRoom(alice, 'Corner Booth');
    await settle();

    expect(outcome.ok).toBe(true);
    expect(outcome.acceptedRelays).toBeGreaterThanOrEqual(2);

    const rooms = await directoryService.fetchRooms();
    expect(rooms.some((r) => r.publicRoomId === descriptor.publicRoomId)).toBe(true);
  }, 20000);

  it('a refresh from a later session REPLACES the listing -- closes v2 [O-08]', async () => {
    const alice = await makeProfile('Alice');
    const { convId, joinToken, publicRoomId, signingPrivateKey } = await publishRoom(
      alice,
      'First Name'
    );
    await settle();

    // Simulates a reload: same identity, same room, brand new publish.
    const renamed = await buildPublicRoomDescriptor({
      publicRoomId, convId, publicJoinToken: joinToken, name: 'Renamed',
      description: 'a room', creatorId: alice.participantId,
      creatorScreenName: alice.screenName,
      creatorSigningPublicKey: alice.signingPublicKeyBase64, signingPrivateKey,
    });
    await directoryService.publishDescriptor({
      descriptor: renamed, signingPrivateKeyJwk: alice.signingPrivateKeyJwk,
    });
    await settle();

    const rooms = await directoryService.fetchRooms();
    const matching = rooms.filter((r) => r.publicRoomId === publicRoomId);
    // v2 generated an ephemeral key per page load, so this would have been two.
    expect(matching.length).toBe(1);
    expect(matching[0].name).toBe('Renamed');

    // And the relay itself holds one event, not two.
    const stored = relays[0].events.filter(
      (e) => e.tags.find((t) => t[0] === 'd')?.[1] === publicRoomId
    );
    expect(stored.length).toBe(1);
  }, 20000);

  it('a creator tombstone suppresses the listing -- [PU-05]', async () => {
    const alice = await makeProfile('Alice');
    const { convId, publicRoomId, signingPrivateKey } = await publishRoom(alice, 'Closing Soon');
    await settle();
    expect((await directoryService.fetchRooms()).some((r) => r.publicRoomId === publicRoomId)).toBe(
      true
    );

    const tombstone = await buildPublicRoomTombstone({
      publicRoomId, convId, creatorId: alice.participantId,
      creatorSigningPublicKey: alice.signingPublicKeyBase64, signingPrivateKey,
    });
    await directoryService.publishTombstone({
      tombstone, signingPrivateKeyJwk: alice.signingPrivateKeyJwk,
    });
    await settle();

    const rooms = await directoryService.fetchRooms();
    expect(rooms.some((r) => r.publicRoomId === publicRoomId)).toBe(false);
  }, 20000);

  it('ignores a descriptor whose signature does not match its creator', async () => {
    const alice = await makeProfile('Alice');
    const mallory = await makeProfile('Mallory');
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const publicRoomId = await derivePublicRoomId(convId, joinToken);

    // Mallory signs but claims Alice's identity.
    const malloryKey = await importSigningPrivateKeyFromJwk(mallory.signingPrivateKeyJwk);
    const forged = await buildPublicRoomDescriptor({
      publicRoomId, convId, publicJoinToken: joinToken, name: 'Impostor',
      description: '', creatorId: alice.participantId, creatorScreenName: 'Alice',
      creatorSigningPublicKey: alice.signingPublicKeyBase64, signingPrivateKey: malloryKey,
    });
    await directoryService.publishDescriptor({
      descriptor: forged, signingPrivateKeyJwk: mallory.signingPrivateKeyJwk,
    });
    await settle();

    const rooms = await directoryService.fetchRooms();
    expect(rooms.some((r) => r.name === 'Impostor')).toBe(false);
  }, 20000);
});

describe('approximate occupancy -- [PU-04][X-12]', () => {
  it('buckets counts rather than reporting a precise figure', () => {
    expect(occupancyBucket(0)).toBe('0');
    expect(occupancyBucket(3)).toBe('1-4');
    expect(occupancyBucket(7)).toBe('5-9');
    expect(occupancyBucket(24)).toBe('10-24');
    expect(occupancyBucket(99)).toBe('25-99');
    expect(occupancyBucket(500)).toBe('500+');
  });

  it('counts distinct publishers once across relays, and ages out', async () => {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const publicRoomId = await derivePublicRoomId(convId, joinToken);

    const beacons: PublicRoomPresenceBeacon[] = [];
    for (let i = 0; i < 3; i++) {
      const profile = await makeProfile(`User${i}`);
      const beacon = new PublicRoomPresenceBeacon();
      await beacon.start(profile.signingPrivateKeyJwk, publicRoomId);
      beacons.push(beacon);
    }
    await settle(150);

    // Every relay holds every beacon, but each publisher counts once [PU-04].
    const counts = await directoryService.fetchOccupancy([publicRoomId]);
    expect(counts.get(publicRoomId)).toBe(3);
    expect(occupancyBucket(counts.get(publicRoomId)!)).toBe('1-4');

    beacons.forEach((b) => b.stop());

    // An expired beacon is not counted.
    for (const relay of relays) {
      relay.events = relay.events.map((e) =>
        e.content.includes('public_room_presence')
          ? { ...e, content: JSON.stringify({ ...JSON.parse(e.content), expiresAt: Date.now() - 1 }) }
          : e
      );
    }
    const after = await directoryService.fetchOccupancy([publicRoomId]);
    expect(after.get(publicRoomId)).toBe(0);
  }, 20000);
});
