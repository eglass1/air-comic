/**
 * End-to-end private room tests over an in-memory relay set.
 *
 * These cover the phase-3 acceptance criteria without a browser:
 *   [Q-01] transport independence -- WebRTC is never involved here
 *   [Q-05] membership security
 *   [Q-06] strong removal
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
import { RoomSession, outbox } from '../roomSession';
import { DatabaseService, type UserProfile } from '../db';
import { generateUserKeyPair } from '../../crypto';
import { generateRoomSecret, derivePrivateRoutingTag } from '../keys';

const URLS = ['wss://r1.test', 'wss://r2.test', 'wss://r3.test'];
let relays: FakeRelay[] = [];

installFakeWebSocket();

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

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** Each simulated user gets its own IndexedDB, as separate browsers would. */
let dbSeq = 0;
const freshDb = () => new DatabaseService(`TestDB_${Date.now()}_${dbSeq++}`);

// The pool is a singleton, so relay objects and sockets are established once
// and only their contents are reset between tests.
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

describe('private room over Nostr alone -- [Q-01]', () => {
  it('creates a room, admits a second member, and exchanges messages', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();

    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 't1', convId, roomMode: 'private', roomSecret: secret, isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    // Genesis and epoch 1 exist; the creator is the only member.
    expect(aliceRoom.isApproved).toBe(true);
    expect(aliceRoom.activeEpoch).toBe(1);
    expect(aliceRoom.memberCount).toBe(1);
    // The root key is control-only: epoch 1 opened immediately [O-03].
    expect(aliceRoom.activeKeyId).toMatch(/^epoch-1-/);

    const bobRoom = new RoomSession({
      tabId: 't2', convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();

    // Bob holds the secret but is not yet a member.
    expect(bobRoom.isApproved).toBe(false);
    expect(aliceRoom.pendingJoinRequests.length).toBe(1);

    await aliceRoom.approveJoinRequest(aliceRoom.pendingJoinRequests[0].requestId);
    await settle();

    expect(aliceRoom.memberCount).toBe(2);
    expect(bobRoom.isApproved).toBe(true);
    expect(bobRoom.activeEpoch).toBe(2);

    // Messages flow both ways with no WebRTC anywhere.
    await aliceRoom.sendMessage('hello bob');
    await settle();
    expect(bobRoom.messages.some((m) => m.text === 'hello bob')).toBe(true);

    await bobRoom.sendMessage('hello alice');
    await settle();
    expect(aliceRoom.messages.some((m) => m.text === 'hello alice')).toBe(true);

    // Publishing does not block on quorum [D-01]; the record starts 'pending'
    // and the outbox promotes it to 'relayed' once the quorum lands [L-12][D-05].
    await settle(120);
    expect(aliceRoom.messages.find((m) => m.text === 'hello bob')!.sendState).toBe('relayed');

    aliceRoom.destroy();
    bobRoom.destroy();
  }, 20000);

  it('an unapproved secret-holder cannot send', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const mallory = await makeProfile('Mallory');

    const aliceRoom = new RoomSession({
      tabId: 'a', convId, roomMode: 'private', roomSecret: secret, isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    const malloryRoom = new RoomSession({
      tabId: 'm', convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
    await malloryRoom.init(mallory);
    await settle();

    expect(malloryRoom.isApproved).toBe(false);
    expect(await malloryRoom.sendMessage('let me in')).toBe(false);
    await settle();
    expect(aliceRoom.messages.some((m) => m.text === 'let me in')).toBe(false);

    aliceRoom.destroy();
    malloryRoom.destroy();
  }, 20000);
});

describe('strong removal -- [Q-06][PR-07]', () => {
  it('rotates the route so the removed member cannot follow the room', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'a', convId, roomMode: 'private', roomSecret: secret, isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    const bobRoom = new RoomSession({ tabId: 'b', convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();
    await aliceRoom.approveJoinRequest(aliceRoom.pendingJoinRequests[0].requestId);
    await settle();
    expect(bobRoom.isApproved).toBe(true);

    const routeBefore = aliceRoom.routingTag;
    const secretBefore = aliceRoom.roomSecret;

    expect(await aliceRoom.removeParticipant(bob.participantId)).toBe(true);
    await settle();

    // The room secret and every derived route have changed [O-05].
    expect(aliceRoom.roomSecret).not.toBe(secretBefore);
    expect(aliceRoom.routingTag).not.toBe(routeBefore);
    expect(aliceRoom.capabilityGeneration).toBe(1);
    expect(aliceRoom.memberCount).toBe(1);

    // Bob observed the rotation but had no wrapped slot, so he is out.
    expect(bobRoom.isApproved).toBe(false);
    expect(bobRoom.roomSecret).toBe(secretBefore);
    expect(bobRoom.routingTag).toBe(routeBefore);

    // Post-removal traffic is on a route Bob cannot even compute.
    await aliceRoom.sendMessage('after removal');
    await settle();
    expect(bobRoom.messages.some((m) => m.text === 'after removal')).toBe(false);

    // And the old secret does not derive the new route.
    expect(await derivePrivateRoutingTag(secretBefore, convId)).not.toBe(aliceRoom.routingTag);

    aliceRoom.destroy();
    bobRoom.destroy();
  }, 20000);

  it('a remaining member who was offline recovers the rotation on return', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const carol = await makeProfile('Carol');

    const aliceRoom = new RoomSession({
      tabId: 'a', convId, roomMode: 'private', roomSecret: secret, isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    for (const [tab, profile] of [['b', bob], ['c', carol]] as const) {
      const room = new RoomSession({ tabId: tab, convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
      await room.init(profile as UserProfile);
      await settle();
      await aliceRoom.approveJoinRequest(aliceRoom.pendingJoinRequests[0].requestId);
      await settle();
      room.destroy();
    }
    expect(aliceRoom.memberCount).toBe(3);

    // Carol is offline while Bob is removed.
    await aliceRoom.removeParticipant(bob.participantId);
    await settle();
    const newRoute = aliceRoom.routingTag;

    // Carol comes back holding only the old secret and finds the rotation.
    const carolRoom = new RoomSession({ tabId: 'c2', convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
    await carolRoom.init(carol);
    await settle(150);

    expect(carolRoom.routingTag).toBe(newRoute);
    expect(carolRoom.capabilityGeneration).toBe(1);
    expect(carolRoom.isApproved).toBe(true);

    aliceRoom.destroy();
    carolRoom.destroy();
  }, 30000);
});

describe('relay failure modes -- [Q-04]', () => {
  it('still reaches quorum with one relay offline and one read-only', async () => {
    relays[0].offline = true;
    relays[1].rejectWrites = true;
    relayPool.configure(URLS);
    await settle(50);

    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const room = new RoomSession({
      tabId: 'a', convId, roomMode: 'private', roomSecret: secret, isInitialCreator: true, database: freshDb(),
    });
    await room.init(alice);
    await settle();

    // The room is fully usable even though only one relay can store anything.
    expect(room.isApproved).toBe(true);
    expect(await room.sendMessage('through one good relay')).toBe(true);
    await settle(150);

    // Only the healthy relay holds it: an offline relay never sees the write and
    // a read-only relay's rejection is not counted as an acceptance [T-07][O-12].
    expect(relays[2].events.some((e) => e.content.includes('"data"'))).toBe(true);
    expect(relays[0].events.length).toBe(0);
    expect(relays[1].events.length).toBe(0);
    expect(relays[1].publishCount).toBeGreaterThan(0);

    room.destroy();
  }, 20000);

  it('a duplicate event delivered by every relay is stored once -- [D-02]', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'a', convId, roomMode: 'private', roomSecret: secret, isInitialCreator: true, database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();
    const bobRoom = new RoomSession({ tabId: 'b', convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();
    await aliceRoom.approveJoinRequest(aliceRoom.pendingJoinRequests[0].requestId);
    await settle();

    await aliceRoom.sendMessage('exactly once');
    await settle(120);

    // Every relay holds it and every relay delivered it to Bob's subscription.
    const copies = bobRoom.messages.filter((m) => m.text === 'exactly once');
    expect(copies.length).toBe(1);
    expect(bobRoom.collisions).toBe(0);

    aliceRoom.destroy();
    bobRoom.destroy();
  }, 20000);
});

describe('membership security at the session level -- [Q-05]', () => {
  it('a joiner that arrives late still rebuilds the chain from relay history', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const carol = await makeProfile('Carol');

    const aliceRoom = new RoomSession({
      tabId: 'a', convId, roomMode: 'private', roomSecret: secret, isInitialCreator: true,
      database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    // Build several epochs before Carol has ever subscribed, so she must
    // replay genesis and every rekey out of order [L-05][H-01].
    const bobRoom = new RoomSession({
      tabId: 'b', convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();
    await aliceRoom.approveJoinRequest(aliceRoom.pendingJoinRequests[0].requestId);
    await settle();
    await aliceRoom.rekeyConversation();
    await settle();
    await aliceRoom.sendMessage('said before carol arrived');
    await settle();

    const carolRoom = new RoomSession({
      tabId: 'c', convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
    await carolRoom.init(carol);
    await settle(150);

    // Carol anchored genesis and followed the chain to the current head.
    expect(carolRoom.activeEpoch).toBe(aliceRoom.activeEpoch);
    expect(carolRoom.memberCount).toBe(2);
    expect(carolRoom.isApproved).toBe(false);

    // History policy is from_admission: she can see that traffic exists but
    // holds no key for the epoch it was sent under [PR-09].
    expect(carolRoom.messages.some((m) => m.text === 'said before carol arrived')).toBe(false);

    aliceRoom.destroy();
    bobRoom.destroy();
    carolRoom.destroy();
  }, 30000);

  it('rejects a message whose sender id does not match its signing key', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');

    const room = new RoomSession({
      tabId: 'a', convId, roomMode: 'private', roomSecret: secret, isInitialCreator: true,
      database: freshDb(),
    });
    await room.init(alice);
    await settle();

    const before = room.messages.length;
    // A structurally valid envelope whose signature does not belong to the
    // claimed sender must never reach the message list [X-03] steps 4-5.
    await room.receiveFromAccelerator(
      JSON.stringify({
        protocol: 'airthread/3',
        extension: 'airthread/3-nostr-transport',
        type: 'room_envelope',
        convId,
        packetId: crypto.randomUUID(),
        roomMode: 'private',
        packetClass: 'chat',
        keyId: room.activeKeyId,
        senderId: 'forged-participant-id',
        senderSigningPublicKey: alice.signingPublicKeyBase64,
        timestamp: Date.now(),
        iv: 'AAAAAAAAAAAAAAAA',
        data: 'AAAA',
        signature: 'AAAA',
      })
    );
    await settle();
    expect(room.messages.length).toBe(before);

    room.destroy();
  }, 20000);
});
