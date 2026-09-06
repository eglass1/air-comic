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

  it('replaces the messages array rather than mutating it, so React sees the change', async () => {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'ia', convId, roomMode: 'public', publicJoinToken: joinToken,
      isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    const bobRoom = new RoomSession({
      tabId: 'ib', convId, roomMode: 'public', publicJoinToken: joinToken,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();

    // The comic strip lays its panels out in a useMemo keyed on this array, so
    // an in-place splice would leave the view frozen until something else --
    // a tab switch -- handed it a different reference.
    const bobBefore = bobRoom.messages;
    const aliceBefore = aliceRoom.messages;

    await aliceRoom.sendMessage('a new panel please');
    await settle(120);

    expect(aliceRoom.messages).not.toBe(aliceBefore);
    expect(bobRoom.messages).not.toBe(bobBefore);
    expect(bobRoom.messages.some((m) => m.text === 'a new panel please')).toBe(true);

    // The send-state promotion is a replacement too: the record reaches
    // 'relayed' on a fresh array and a fresh message object.
    const sent = aliceRoom.messages.find((m) => m.text === 'a new panel please')!;
    expect(sent.sendState).toBe('relayed');
    expect(aliceBefore.some((m) => m.id === sent.id)).toBe(false);

    aliceRoom.destroy();
    bobRoom.destroy();
  }, 20000);

  it('carries a renamed profile into the roster and the participants snapshot', async () => {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const alice = await makeProfile('Alice');

    const room = new RoomSession({
      tabId: 'ra', convId, roomMode: 'public', publicJoinToken: joinToken,
      isInitialCreator: true, database: freshDb(),
    });
    await room.init(alice);
    await settle();

    expect(room.participants.map((p) => p.screenName)).toEqual(['Alice']);
    const before = room.participants;

    // Renaming keeps the identity: the same roster entry, under a new name, on
    // a new array so a memo downstream of it recomputes.
    await room.applyProfile({ ...alice, screenName: 'Alicia' });

    expect(room.participants).not.toBe(before);
    expect(room.participants.map((p) => p.screenName)).toEqual(['Alicia']);
    expect(room.participantsMap.size).toBe(1);
    expect(room.participants[0].participantId).toBe(alice.participantId);

    // ...and the name we go on to sign with is the new one.
    await room.sendMessage('renamed and still me');
    await settle(120);
    expect(room.messages.at(-1)!.sender.screenName).toBe('Alicia');

    room.destroy();
  }, 20000);

  it('shows the people already in the room before anyone has spoken -- [PU-06]', async () => {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'sa', convId, roomMode: 'public', publicJoinToken: joinToken,
      isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    // Bob arrives second and says nothing at all.
    const bobRoom = new RoomSession({
      tabId: 'sb', convId, roomMode: 'public', publicJoinToken: joinToken,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle(150);

    // Bob learns of Alice from the record she left on the room's roster tag;
    // Alice learns of Bob from his announcement arriving live.
    expect(bobRoom.participants.map((p) => p.screenName).sort()).toEqual(['Alice', 'Bob']);
    expect(aliceRoom.participants.map((p) => p.screenName).sort()).toEqual(['Alice', 'Bob']);

    const seenAlice = bobRoom.participantsMap.get(alice.participantId)!;
    expect(seenAlice.status).toBe('online');
    expect(seenAlice.isSelf).toBe(false);
    // Enough of an identity to open a contact card or add them as a friend.
    expect(seenAlice.publicKey).toBe(alice.publicKeyBase64);
    expect(seenAlice.avatarName).toBe('Armando');

    aliceRoom.destroy();
    bobRoom.destroy();
  }, 20000);

  it('takes a departing occupant off everyone elses roster -- [PU-06]', async () => {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'la', convId, roomMode: 'public', publicJoinToken: joinToken,
      isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    const bobRoom = new RoomSession({
      tabId: 'lb', convId, roomMode: 'public', publicJoinToken: joinToken,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle(150);
    expect(aliceRoom.participantsMap.has(bob.participantId)).toBe(true);

    bobRoom.destroy();
    await settle(200);

    // Nothing vouches for a public-room occupant except being here.
    expect(aliceRoom.participantsMap.has(bob.participantId)).toBe(false);
    expect(aliceRoom.participants.map((p) => p.screenName)).toEqual(['Alice']);

    aliceRoom.destroy();
  }, 20000);

  it('does not mistake replayed history for company in the room -- [PU-06]', async () => {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'ha', convId, roomMode: 'public', publicJoinToken: joinToken,
      isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    await aliceRoom.sendMessage('leaving this here');
    await settle(120);
    aliceRoom.destroy();
    await settle(120);

    // Bob arrives to an empty room with a transcript in it.
    const bobRoom = new RoomSession({
      tabId: 'hb', convId, roomMode: 'public', publicJoinToken: joinToken,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle(200);

    expect(bobRoom.messages.some((m) => m.text === 'leaving this here')).toBe(true);
    // Alice is named by her message, but a month-old transcript is not a room
    // full of people: only an announcement lights somebody up.
    expect(bobRoom.participantsMap.get(alice.participantId)?.status).not.toBe('online');
    expect(bobRoom.participants.filter((p) => p.status === 'online').map((p) => p.screenName))
      .toEqual(['Bob']);

    bobRoom.destroy();
  }, 20000);

  it('announces a rename to the room without waiting for a message -- [PU-06]', async () => {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'na', convId, roomMode: 'public', publicJoinToken: joinToken,
      isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    const bobRoom = new RoomSession({
      tabId: 'nb', convId, roomMode: 'public', publicJoinToken: joinToken,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle(150);

    await aliceRoom.applyProfile({ ...alice, screenName: 'Alicia', avatarName: 'Susan' });
    await settle(200);

    const seen = bobRoom.participantsMap.get(alice.participantId)!;
    expect(seen.screenName).toBe('Alicia');
    expect(seen.avatarName).toBe('Susan');

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

  it('respawns an expired public room under the same ID when creator rejoins from saved state', async () => {
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const publicRoomId = await derivePublicRoomId(convId, joinToken);
    const aliceDb = freshDb();

    // 1. Creator creates and enters the public room
    const firstSession = new RoomSession({
      tabId: 'a1',
      convId,
      roomMode: 'public',
      publicJoinToken: joinToken,
      channelTitle: 'Recreation Lounge',
      isInitialCreator: true,
      database: aliceDb,
    });
    await firstSession.init(alice);
    await settle();

    // The room is active and listed
    expect((await directoryService.fetchRooms()).some((r) => r.publicRoomId === publicRoomId)).toBe(
      true
    );

    // 2. All users close out and the room eventually goes away (expires / purged from relays)
    firstSession.destroy();
    resetRelays();
    await settle();

    // Directory list shows the room is now gone
    expect((await directoryService.fetchRooms()).some((r) => r.publicRoomId === publicRoomId)).toBe(
      false
    );

    // 3. User restarts and rejoins from saved state (same convId, joinToken, title, database)
    const secondSession = new RoomSession({
      tabId: 'a2',
      convId,
      roomMode: 'public',
      publicJoinToken: joinToken,
      channelTitle: 'Recreation Lounge',
      isInitialCreator: true,
      database: aliceDb,
    });
    await secondSession.init(alice);
    await settle(150);

    // 4. Room is respawned under the exact same ID and listed in active rooms
    const liveRooms = await directoryService.fetchRooms();
    const listed = liveRooms.find((r) => r.publicRoomId === publicRoomId);
    expect(listed).toBeDefined();
    expect(listed!.convId).toBe(convId);
    expect(listed!.publicJoinToken).toBe(joinToken);
    expect(listed!.publicRoomId).toBe(publicRoomId);
    expect(listed!.name).toBe('Recreation Lounge');

    // 5. Another user enters via the active directory listing and communicates under the same ID
    const bobRoom = new RoomSession({
      tabId: 'b1',
      convId: listed!.convId,
      roomMode: 'public',
      publicJoinToken: listed!.publicJoinToken,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle(150);

    await bobRoom.sendMessage('welcome back!');
    await settle(150);
    expect(secondSession.messages.some((m) => m.text === 'welcome back!')).toBe(true);

    secondSession.destroy();
    bobRoom.destroy();
  }, 30000);

  it('respawns an unpurged but expired descriptor when creator rejoins', async () => {
    const alice = await makeProfile('Alice');
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const publicRoomId = await derivePublicRoomId(convId, joinToken);
    const aliceDb = freshDb();

    // Publish an already-expired descriptor to the relays
    const signingPrivateKey = await importSigningPrivateKeyFromJwk(alice.signingPrivateKeyJwk);
    const expiredDescriptor = await buildPublicRoomDescriptor({
      publicRoomId,
      convId,
      publicJoinToken: joinToken,
      name: 'Old Lounge',
      description: 'expired descriptor',
      creatorId: alice.participantId,
      creatorScreenName: alice.screenName,
      creatorSigningPublicKey: alice.signingPublicKeyBase64,
      signingPrivateKey,
      lifetimeSec: -120, // Expired 2 minutes ago
    });
    await directoryService.publishDescriptor({
      descriptor: expiredDescriptor,
      signingPrivateKeyJwk: alice.signingPrivateKeyJwk,
    });
    await settle();

    // Relay has the event, but fetchRooms ignores it because it is expired
    expect((await directoryService.fetchRooms()).some((r) => r.publicRoomId === publicRoomId)).toBe(
      false
    );

    // Creator restarts and rejoins
    const session = new RoomSession({
      tabId: 'exp1',
      convId,
      roomMode: 'public',
      publicJoinToken: joinToken,
      channelTitle: 'Old Lounge',
      isInitialCreator: true,
      database: aliceDb,
    });
    await session.init(alice);
    await settle(150);

    // Now directoryService.fetchRooms() returns the respawned, unexpired descriptor
    const rooms = await directoryService.fetchRooms();
    const respawned = rooms.find((r) => r.publicRoomId === publicRoomId);
    expect(respawned).toBeDefined();
    expect(respawned!.expiresAt).toBeGreaterThan(Date.now());
    expect(respawned!.publicRoomId).toBe(publicRoomId);

    session.destroy();
  }, 30000);
});

describe('public room naming -- [PU-02][M-01]', () => {
  async function listRoom(profile: UserProfile, name: string) {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const publicRoomId = await derivePublicRoomId(convId, joinToken);
    const signingPrivateKey = await importSigningPrivateKeyFromJwk(profile.signingPrivateKeyJwk);
    const descriptor = await buildPublicRoomDescriptor({
      publicRoomId, convId, publicJoinToken: joinToken, name, description: 'a room',
      creatorId: profile.participantId, creatorScreenName: profile.screenName,
      creatorSigningPublicKey: profile.signingPublicKeyBase64, signingPrivateKey,
    });
    await directoryService.publishDescriptor({
      descriptor, signingPrivateKeyJwk: profile.signingPrivateKeyJwk,
    });
    return { convId, joinToken, publicRoomId };
  }

  it('the creator renames the room, and the listing follows', async () => {
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const { convId, joinToken, publicRoomId } = await listRoom(alice, 'Corner Booth');
    await settle();

    const aliceRoom = new RoomSession({
      tabId: 'ca', convId, roomMode: 'public', publicJoinToken: joinToken,
      isInitialCreator: true, channelTitle: 'Corner Booth', database: freshDb(),
    });
    await aliceRoom.init(alice);
    const bobRoom = new RoomSession({
      tabId: 'cb', convId, roomMode: 'public', publicJoinToken: joinToken, database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle(150);

    expect(aliceRoom.canRenameRoom).toBe(true);
    expect(bobRoom.publicRoomCreatorId).toBe(alice.participantId);

    expect(await aliceRoom.updateChannelTitle('Diner Talk')).toBe(true);
    await settle(200);

    expect(bobRoom.channelTitle).toBe('Diner Talk');
    // The directory is the room's public name; it must not be left behind.
    const listed = await directoryService.fetchRoom(publicRoomId);
    expect(listed?.name).toBe('Diner Talk');

    aliceRoom.destroy();
    bobRoom.destroy();
  }, 30000);

  it('anyone else is refused, on their own screen and on everyone elses', async () => {
    const alice = await makeProfile('Alice');
    const mallory = await makeProfile('Mallory');
    const bob = await makeProfile('Bob');
    const { convId, joinToken, publicRoomId } = await listRoom(alice, 'Corner Booth');
    await settle();

    const aliceRoom = new RoomSession({
      tabId: 'ra', convId, roomMode: 'public', publicJoinToken: joinToken,
      isInitialCreator: true, channelTitle: 'Corner Booth', database: freshDb(),
    });
    await aliceRoom.init(alice);
    // Mallory declares herself the creator on her own machine. The listing,
    // which she cannot replace, says otherwise.
    const malloryRoom = new RoomSession({
      tabId: 'rm', convId, roomMode: 'public', publicJoinToken: joinToken,
      isInitialCreator: true, database: freshDb(),
    });
    await malloryRoom.init(mallory);
    const bobRoom = new RoomSession({
      tabId: 'rb', convId, roomMode: 'public', publicJoinToken: joinToken, database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle(150);

    expect(malloryRoom.canRenameRoom).toBe(false);
    expect(await malloryRoom.updateChannelTitle('Hijacked')).toBe(false);
    await settle(200);

    expect(malloryRoom.channelTitle).not.toBe('Hijacked');
    expect(aliceRoom.channelTitle).toBe('Corner Booth');
    expect(bobRoom.channelTitle).toBe('Corner Booth');
    const listed = await directoryService.fetchRoom(publicRoomId);
    expect(listed?.name).toBe('Corner Booth');

    aliceRoom.destroy();
    malloryRoom.destroy();
    bobRoom.destroy();
  }, 30000);

  it('remembers who the listing named when the directory goes quiet', async () => {
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const { convId, joinToken } = await listRoom(alice, 'Corner Booth');
    await settle();

    // Bob reads the listing once, on a normal visit.
    const bobDb = freshDb();
    const first = new RoomSession({
      tabId: 'pa1', convId, roomMode: 'public', publicJoinToken: joinToken, database: bobDb,
    });
    await first.init(bob);
    await settle(150);
    expect(first.publicRoomCreatorId).toBe(alice.participantId);
    first.destroy();

    // He comes back with every relay down, so there is no listing to read.
    relays.forEach((r) => { r.offline = true; });
    relayPool.configure(URLS);
    await settle(50);

    const second = new RoomSession({
      tabId: 'pa2', convId, roomMode: 'public', publicJoinToken: joinToken, database: bobDb,
    });
    await second.init(bob);
    await settle(150);

    expect(second.publicRoomCreatorId).toBe(alice.participantId);
    second.destroy();

    relays.forEach((r) => { r.offline = false; });
    relayPool.configure(URLS);
    await settle(50);
  }, 30000);

  it('with no listing to read, nobody renames the room', async () => {
    const convId = crypto.randomUUID();
    const joinToken = generateRoomSecret();
    const alice = await makeProfile('Alice');

    // A room reached by link whose descriptor has expired or was never
    // published: there is no authority to check a rename against.
    const room = new RoomSession({
      tabId: 'na', convId, roomMode: 'public', publicJoinToken: joinToken,
      channelTitle: 'Corner Booth', database: freshDb(),
    });
    await room.init(alice);
    await settle(150);

    expect(room.publicRoomCreatorId).toBeNull();
    expect(room.canRenameRoom).toBe(false);
    expect(await room.updateChannelTitle('Anything At All')).toBe(false);
    expect(room.channelTitle).toBe('Corner Booth');

    room.destroy();
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
