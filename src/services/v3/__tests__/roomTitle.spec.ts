/**
 * The room's name is the room's, not the tab's.
 *
 * A member who arrives with nothing but a link has no way to guess what the
 * room is called, so the title has to travel [M-01]. These cover the ways it
 * has to survive: a fresh join, a rename, competing renames, and a rotation
 * that moves the room to a route the old record cannot be found on.
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
import { generateUserKeyPair } from '../../crypto';
import { generateRoomSecret } from '../keys';

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

let dbSeq = 0;
const freshDb = () => new DatabaseService(`TitleDB_${Date.now()}_${dbSeq++}`);

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

describe('room title propagation -- [M-01]', () => {
  it('a member who joins by link adopts the creator title', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'a',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      isInitialCreator: true,
      channelTitle: 'The Grapevine',
      database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    // Bob has the link and nothing else -- no title came with it.
    const bobRoom = new RoomSession({
      tabId: 'b',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();

    expect(bobRoom.channelTitle).toBe('The Grapevine');

    aliceRoom.destroy();
    bobRoom.destroy();
  }, 20000);

  it('adopts the title even when it arrives before the genesis that vouches for it', async () => {
    // A first subscription replays the room newest-first, so the title lands
    // before genesis. One relay, so no second delivery can paper over it: the
    // packet is seen exactly once, and dedup makes that the only chance.
    relayPool.configure([URLS[0]]);
    await settle(50);

    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'a',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      isInitialCreator: true,
      channelTitle: 'The Grapevine',
      database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle(150);

    const bobRoom = new RoomSession({
      tabId: 'b',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      // What the app passes for a room it has joined but cannot yet name.
      channelTitle: 'Untitled Room',
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle(200);

    expect(bobRoom.channelTitle).toBe('The Grapevine');

    aliceRoom.destroy();
    bobRoom.destroy();
    relayPool.configure(URLS);
    await settle(50);
  }, 30000);

  it('shows the member who admitted you before they say anything', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'a',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      isInitialCreator: true,
      channelTitle: 'The Grapevine',
      database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    const bobRoom = new RoomSession({
      tabId: 'b', convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();
    await aliceRoom.approveJoinRequest(aliceRoom.pendingJoinRequests[0].requestId);
    await settle(150);

    expect(bobRoom.isApproved).toBe(true);

    // Nobody has spoken yet, and the roster already knows who is here.
    const alicesEntry = bobRoom.participants.find(
      (p) => p.participantId === alice.participantId
    );
    expect(alicesEntry).toBeTruthy();
    expect(alicesEntry!.screenName).toBe('Alice');
    expect(alicesEntry!.isApproved).toBe(true);
    // She just signed the admission, so she is genuinely here.
    expect(alicesEntry!.status).toBe('online');
    expect(bobRoom.participants.length).toBe(2);

    aliceRoom.destroy();
    bobRoom.destroy();
  }, 30000);

  it('a rename reaches a member already in the room', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'a',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      isInitialCreator: true,
      channelTitle: 'The Grapevine',
      database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    const bobRoom = new RoomSession({
      tabId: 'b',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();
    await aliceRoom.approveJoinRequest(aliceRoom.pendingJoinRequests[0].requestId);
    await settle();

    await aliceRoom.updateChannelTitle('Test2');
    await settle();

    expect(bobRoom.channelTitle).toBe('Test2');

    aliceRoom.destroy();
    bobRoom.destroy();
  }, 20000);

  it('the newest rename wins however the records come back', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const carol = await makeProfile('Carol');

    const aliceRoom = new RoomSession({
      tabId: 'a',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      isInitialCreator: true,
      channelTitle: 'The Grapevine',
      database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    const bobRoom = new RoomSession({
      tabId: 'b',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();
    await aliceRoom.approveJoinRequest(aliceRoom.pendingJoinRequests[0].requestId);
    await settle();

    // Two members rename in turn, so two records sit on the same stable tag
    // under different keys. Whoever joins next must land on the later one.
    await bobRoom.updateChannelTitle('Bob Was Here');
    await settle();
    await aliceRoom.updateChannelTitle('Top of the Morning');
    await settle();

    const carolRoom = new RoomSession({
      tabId: 'c',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      database: freshDb(),
    });
    await carolRoom.init(carol);
    await settle();

    expect(carolRoom.channelTitle).toBe('Top of the Morning');

    aliceRoom.destroy();
    bobRoom.destroy();
    carolRoom.destroy();
  }, 30000);

  it('a secret-holder who is not a member cannot rename the room', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const mallory = await makeProfile('Mallory');
    const bob = await makeProfile('Bob');

    const aliceRoom = new RoomSession({
      tabId: 'a',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      isInitialCreator: true,
      channelTitle: 'Corner Booth',
      database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    // Mallory has the link, so she can reach the room's tags and its root key,
    // but she was never admitted [M-01][O-18].
    const malloryRoom = new RoomSession({
      tabId: 'm', convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
    await malloryRoom.init(mallory);
    await settle();
    expect(malloryRoom.isApproved).toBe(false);

    await malloryRoom.updateChannelTitle('Hijacked');
    await settle(150);

    expect(aliceRoom.channelTitle).toBe('Corner Booth');

    // And a newcomer reading the tag fresh lands on the members' title, not
    // on the newer record sitting beside it.
    const bobRoom = new RoomSession({
      tabId: 'b', convId, roomMode: 'private', roomSecret: secret, database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();

    expect(bobRoom.channelTitle).toBe('Corner Booth');

    aliceRoom.destroy();
    malloryRoom.destroy();
    bobRoom.destroy();
  }, 30000);

  it('the title follows the room onto the route a removal moves it to', async () => {
    const convId = crypto.randomUUID();
    const secret = generateRoomSecret();
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const carol = await makeProfile('Carol');

    const aliceRoom = new RoomSession({
      tabId: 'a',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      isInitialCreator: true,
      channelTitle: 'Panel by Panel',
      database: freshDb(),
    });
    await aliceRoom.init(alice);
    await settle();

    const bobRoom = new RoomSession({
      tabId: 'b',
      convId,
      roomMode: 'private',
      roomSecret: secret,
      database: freshDb(),
    });
    await bobRoom.init(bob);
    await settle();
    await aliceRoom.approveJoinRequest(aliceRoom.pendingJoinRequests[0].requestId);
    await settle();

    await aliceRoom.removeParticipant(bob.participantId);
    await settle();

    // Carol gets a link carrying the rotated secret: the old `meta:` tag is
    // unreachable from here, so the title has to have been republished.
    const carolRoom = new RoomSession({
      tabId: 'c',
      convId,
      roomMode: 'private',
      roomSecret: aliceRoom.roomSecret,
      database: freshDb(),
    });
    await carolRoom.init(carol);
    await settle();

    expect(carolRoom.channelTitle).toBe('Panel by Panel');

    aliceRoom.destroy();
    bobRoom.destroy();
    carolRoom.destroy();
  }, 30000);
});
