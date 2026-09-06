/**
 * Presence, sealed inbox and quick messages -- phase 6 acceptance.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  closeAllSockets,
  installFakeWebSocket,
  registerRelay,
  resetRelays,
} from '../../../test/fakeRelay';
import { relayPool } from '../../nostr/relayPool';
import { PresenceService, openSealedEnvelope, sealForParticipant } from '../presence';
import { DatabaseService, type Friend, type UserProfile } from '../db';
import {
  generateUserKeyPair,
  importPrivateKeyFromJwk,
  importSigningPrivateKeyFromJwk,
} from '../../crypto';
import { buildQuickMessage } from '../packets';

const URLS = ['wss://n1.test', 'wss://n2.test', 'wss://n3.test'];
installFakeWebSocket();

let dbSeq = 0;
const freshDb = () => new DatabaseService(`PresDB_${Date.now()}_${dbSeq++}`);
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function makeProfile(screenName: string): Promise<UserProfile> {
  const identity = await generateUserKeyPair();
  return {
    id: 'current_user', participantId: identity.participantId, screenName,
    avatarName: 'Armando',
    publicKeyBase64: identity.publicKeyBase64, publicKeyPem: identity.publicKeyPem,
    privateKeyJwk: identity.privateKeyJwk, privateKeyPem: identity.privateKeyPem,
    signingPublicKeyBase64: identity.signingPublicKeyBase64,
    signingPublicKeyPem: identity.signingPublicKeyPem,
    signingPrivateKeyJwk: identity.signingPrivateKeyJwk,
    signingPrivateKeyPem: identity.signingPrivateKeyPem,
    contactInfo: {}, createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function asFriend(profile: UserProfile, capability?: string, generation?: number): Friend {
  return {
    id: profile.participantId,
    participantId: profile.participantId,
    screenName: profile.screenName,
    publicKey: profile.publicKeyBase64,
    signingPublicKey: profile.signingPublicKeyBase64,
    theirPresenceCapability: capability,
    theirCapabilityGeneration: generation,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

beforeAll(async () => {
  URLS.forEach(registerRelay);
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

describe('signed sealed envelope -- closes v2 [O-06]', () => {
  it('round-trips and rejects a forged sender', async () => {
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const aliceSign = await importSigningPrivateKeyFromJwk(alice.signingPrivateKeyJwk);
    const bobPriv = await importPrivateKeyFromJwk(bob.privateKeyJwk);

    const sealed = await sealForParticipant({
      recipientParticipantId: bob.participantId,
      recipientPublicKey: bob.publicKeyBase64,
      senderParticipantId: alice.participantId,
      senderSigningPublicKey: alice.signingPublicKeyBase64,
      signingPrivateKey: aliceSign,
      payload: { type: 'test', value: 42 },
    });

    expect(await openSealedEnvelope(sealed, bobPriv)).toEqual({ type: 'test', value: 42 });

    // v2 had no envelope signature at all, so anyone knowing Bob's public key
    // could write to his inbox claiming to be Alice.
    const forged = { ...sealed, senderParticipantId: 'someone-else' };
    expect(await openSealedEnvelope(forged, bobPriv)).toBeNull();
  }, 20000);
});

describe('contact-capability presence -- closes v2 [O-11]', () => {
  it('is visible only to a contact who was issued a capability', async () => {
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const stranger = await makeProfile('Stranger');

    const aliceService = new PresenceService(freshDb());
    const bobService = new PresenceService(freshDb());
    const strangerService = new PresenceService(freshDb());
    await aliceService.start(alice);
    await bobService.start(bob);
    await strangerService.start(stranger);
    await settle();

    // Alice issues her capability to Bob only.
    const bobFriend = asFriend(bob);
    expect(await aliceService.issueCapability(bobFriend)).toBe(true);
    await settle();

    let received: string | undefined;
    bobService.setCallbacks({
      onCapabilityReceived: (packet) => {
        received = packet.capability;
      },
    });
    // Re-subscribe so Bob picks up the sealed capability packet.
    await bobService.start(bob);
    await settle(150);
    expect(received).toBe(aliceService.currentCapability.capability);

    // Bob can watch Alice; the stranger cannot derive her tag from her
    // participantId, which is all v2 required.
    await bobService.watchContacts([asFriend(alice, received!, 1)]);
    await strangerService.watchContacts([asFriend(alice)]);
    await aliceService.publishPresence('online');
    await settle(150);

    expect(bobService.isOnline(alice.participantId)).toBe(true);
    expect(strangerService.getPresence(alice.participantId)).toBeNull();

    await aliceService.stop();
    await bobService.stop();
    await strangerService.stop();
  }, 30000);

  it('rotation issues a new capability and retires the old tag', async () => {
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const service = new PresenceService(freshDb());
    await service.start(alice);

    const first = service.currentCapability;
    await service.rotateCapability([asFriend(bob)]);
    const second = service.currentCapability;

    expect(second.capability).not.toBe(first.capability);
    expect(second.generation).toBe(first.generation + 1);

    await service.stop();
  }, 20000);
});

describe('quick messages are signed -- closes v2 [O-06][N-03]', () => {
  it('delivers a genuine message and drops a tampered one', async () => {
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const aliceSign = await importSigningPrivateKeyFromJwk(alice.signingPrivateKeyJwk);

    const aliceService = new PresenceService(freshDb());
    const bobService = new PresenceService(freshDb());
    await aliceService.start(alice);

    const seen: string[] = [];
    bobService.setCallbacks({ onQuickMessage: (m) => seen.push(m.text) });
    await bobService.start(bob);
    await settle();

    const message = await buildQuickMessage({
      senderParticipantId: alice.participantId,
      senderScreenName: 'Alice', senderAvatarName: 'Armando',
      senderPublicKey: alice.publicKeyBase64,
      senderSigningPublicKey: alice.signingPublicKeyBase64,
      recipientParticipantId: bob.participantId,
      text: 'ping', emotion: 0, intensity: 0.5, signingPrivateKey: aliceSign,
    });
    await aliceService.sendQuickMessage(bob.participantId, bob.publicKeyBase64, message);
    await settle(150);
    expect(seen).toContain('ping');

    // A relabelled message must not be delivered under the new text.
    await aliceService.sendQuickMessage(bob.participantId, bob.publicKeyBase64, {
      ...message,
      id: crypto.randomUUID(),
      text: 'send me your keys',
    });
    await settle(150);
    expect(seen).not.toContain('send me your keys');

    await aliceService.stop();
    await bobService.stop();
  }, 30000);

  it('replays until acknowledged, then stops', async () => {
    const alice = await makeProfile('Alice');
    const bob = await makeProfile('Bob');
    const aliceSign = await importSigningPrivateKeyFromJwk(alice.signingPrivateKeyJwk);
    // One browser profile across three visits.
    const bobDb = freshDb();

    const aliceService = new PresenceService(freshDb());
    await aliceService.start(alice);

    const firstVisit: string[] = [];
    const bobService = new PresenceService(bobDb);
    bobService.setCallbacks({ onQuickMessage: (m) => firstVisit.push(m.id) });
    await bobService.start(bob);
    await settle();

    const message = await buildQuickMessage({
      senderParticipantId: alice.participantId,
      senderScreenName: 'Alice', senderAvatarName: 'Armando',
      senderPublicKey: alice.publicKeyBase64,
      senderSigningPublicKey: alice.signingPublicKeyBase64,
      recipientParticipantId: bob.participantId,
      text: 'knock knock', emotion: 0, intensity: 0.5, signingPrivateKey: aliceSign,
    });
    await aliceService.sendQuickMessage(bob.participantId, bob.publicKeyBase64, message);
    await settle(150);
    expect(firstVisit).toEqual([message.id]);
    await bobService.stop();

    // Bob clicked past it without reading it. The sealed record is still on the
    // relay, so the next visit is expected to show it again.
    const secondVisit: string[] = [];
    const reopened = new PresenceService(bobDb);
    reopened.setCallbacks({ onQuickMessage: (m) => secondVisit.push(m.id) });
    await reopened.start(bob);
    await settle(200);
    expect(secondVisit).toEqual([message.id]);

    // This time he acknowledged it.
    await reopened.ackQuickMessage(message.id, alice.participantId);
    await reopened.stop();

    const thirdVisit: string[] = [];
    const again = new PresenceService(bobDb);
    again.setCallbacks({ onQuickMessage: (m) => thirdVisit.push(m.id) });
    await again.start(bob);
    await settle(200);
    expect(thirdVisit).toEqual([]);

    await aliceService.stop();
    await again.stop();
  }, 30000);
});
