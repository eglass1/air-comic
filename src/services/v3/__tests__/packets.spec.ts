import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildCapabilityRotation,
  buildContactCapability,
  buildMessagePayload,
  buildQuickMessage,
  buildRekey,
  buildRoomMetadata,
  openRekeySlot,
  openRotationSlot,
  verifyContactCapability,
  verifyMessagePayload,
  verifyQuickMessage,
  verifyRekey,
  verifyRoomMetadata,
} from '../packets';
import { generateEpochKey, generateRoomSecret } from '../keys';
import {
  generateUserKeyPair,
  importPrivateKeyFromJwk,
  importSigningPrivateKeyFromJwk,
  type GeneratedUserIdentity,
} from '../../crypto';

let alice: GeneratedUserIdentity;
let bob: GeneratedUserIdentity;
let aliceSign: CryptoKey;
let bobSign: CryptoKey;

beforeAll(async () => {
  alice = await generateUserKeyPair();
  bob = await generateUserKeyPair();
  aliceSign = await importSigningPrivateKeyFromJwk(alice.signingPrivateKeyJwk);
  bobSign = await importSigningPrivateKeyFromJwk(bob.signingPrivateKeyJwk);
});

describe('private messages are signed -- closes v2 [O-02]', () => {
  it('verifies a genuine private message', async () => {
    const msg = await buildMessagePayload({
      convId: 'c1', roomMode: 'private', senderId: alice.participantId,
      senderSigningPublicKey: alice.signingPublicKeyBase64, signingPrivateKey: aliceSign,
      screenName: 'Alice', text: 'hi',
    });
    expect(msg.signature).toBeTruthy();
    expect(await verifyMessagePayload(msg)).toBe(true);
  });

  it('a member cannot forge a message from another member', async () => {
    const msg = await buildMessagePayload({
      convId: 'c1', roomMode: 'private', senderId: alice.participantId,
      senderSigningPublicKey: alice.signingPublicKeyBase64, signingPrivateKey: aliceSign,
      screenName: 'Alice', text: 'hi',
    });
    // Bob relabels it as his own; the id no longer hashes from the carried key.
    expect(await verifyMessagePayload({ ...msg, senderId: bob.participantId })).toBe(false);
    // And swapping in his own key breaks the signature.
    expect(
      await verifyMessagePayload({
        ...msg,
        senderId: bob.participantId,
        senderSigningPublicKey: bob.signingPublicKeyBase64,
      })
    ).toBe(false);
  });

  it('rejects tampered text', async () => {
    const msg = await buildMessagePayload({
      convId: 'c1', roomMode: 'private', senderId: alice.participantId,
      senderSigningPublicKey: alice.signingPublicKeyBase64, signingPrivateKey: aliceSign,
      screenName: 'Alice', text: 'hi',
    });
    expect(await verifyMessagePayload({ ...msg, text: 'goodbye' })).toBe(false);
  });

  it('public messages use a distinct domain from private ones', async () => {
    const priv = await buildMessagePayload({
      convId: 'c1', roomMode: 'private', senderId: alice.participantId,
      senderSigningPublicKey: alice.signingPublicKeyBase64, signingPrivateKey: aliceSign,
      screenName: 'Alice', text: 'hi', msgId: 'm1', timestamp: 5,
    });
    // Re-labelling a private message as public must not verify.
    expect(await verifyMessagePayload({ ...priv, roomMode: 'public' })).toBe(false);
  });

  it('omits contact info in public rooms', async () => {
    const pub = await buildMessagePayload({
      convId: 'c1', roomMode: 'public', senderId: alice.participantId,
      senderSigningPublicKey: alice.signingPublicKeyBase64, signingPrivateKey: aliceSign,
      screenName: 'Alice', text: 'hi', contactInfo: { email: 'a@example.com' },
    });
    expect(pub.sender.contactInfo).toBeUndefined();
    expect(await verifyMessagePayload(pub)).toBe(true);
  });
});

describe('rekey wrapping', () => {
  it('wraps the epoch key to each member and only they can open it', async () => {
    const { rawBuffer } = await generateEpochKey();
    const packet = await buildRekey({
      convId: 'c1', keyId: 'k2', epoch: 2, parentPacketId: 'e1', parentKeyId: 'k1',
      action: 'add', targetParticipantId: bob.participantId,
      members: [alice.participantId, bob.participantId],
      publicKeys: new Map([
        [alice.participantId, alice.publicKeyBase64],
        [bob.participantId, bob.publicKeyBase64],
      ]),
      rawEpochKey: rawBuffer,
      signerId: alice.participantId,
      signerSigningPublicKey: alice.signingPublicKeyBase64,
      signerScreenName: 'Alice',
      signingPrivateKey: aliceSign,
    });

    expect(await verifyRekey(packet)).toBe(true);
    expect(packet.members).toEqual([alice.participantId, bob.participantId].sort());

    const bobKey = await importPrivateKeyFromJwk(bob.privateKeyJwk);
    expect(await openRekeySlot(packet, bob.participantId, bobKey)).not.toBeNull();
    expect(await openRekeySlot(packet, 'stranger', bobKey)).toBeNull();
  });

  it('rejects a tampered member list', async () => {
    const { rawBuffer } = await generateEpochKey();
    const packet = await buildRekey({
      convId: 'c1', keyId: 'k1', epoch: 1, parentPacketId: 'g', parentKeyId: 'root-v3',
      action: 'genesis_epoch', members: [alice.participantId],
      publicKeys: new Map([[alice.participantId, alice.publicKeyBase64]]),
      rawEpochKey: rawBuffer, signerId: alice.participantId,
      signerSigningPublicKey: alice.signingPublicKeyBase64,
      signerScreenName: 'Alice', signingPrivateKey: aliceSign,
    });
    expect(await verifyRekey({ ...packet, members: [alice.participantId, 'intruder'] })).toBe(false);
  });

  it('refuses to build without a public key for a member', async () => {
    const { rawBuffer } = await generateEpochKey();
    await expect(
      buildRekey({
        convId: 'c1', keyId: 'k1', epoch: 1, parentPacketId: 'g', parentKeyId: 'root-v3',
        action: 'genesis_epoch', members: [alice.participantId, 'ghost'],
        publicKeys: new Map([[alice.participantId, alice.publicKeyBase64]]),
        rawEpochKey: rawBuffer, signerId: alice.participantId,
        signerSigningPublicKey: alice.signingPublicKeyBase64,
        signerScreenName: 'Alice', signingPrivateKey: aliceSign,
      })
    ).rejects.toThrow(/No public key/);
  });
});

describe('capability rotation payload -- [X-08]', () => {
  it('delivers the new secret only to remaining members', async () => {
    const secrets = { roomSecret: generateRoomSecret(), epochKey: generateRoomSecret() };
    const packet = await buildCapabilityRotation({
      convId: 'c1', generation: 1, newEpoch: 3, newKeyId: 'k3',
      parentPacketId: 'e2', parentKeyId: 'k2',
      removedParticipantId: 'evicted',
      members: [alice.participantId, bob.participantId],
      publicKeys: new Map([
        [alice.participantId, alice.publicKeyBase64],
        [bob.participantId, bob.publicKeyBase64],
      ]),
      secrets, signerId: alice.participantId,
      signerSigningPublicKey: alice.signingPublicKeyBase64,
      signingPrivateKey: aliceSign,
    });

    const bobKey = await importPrivateKeyFromJwk(bob.privateKeyJwk);
    expect(await openRotationSlot(packet, bob.participantId, bobKey)).toEqual(secrets);
    // The removed member has no slot at all.
    expect(packet.wrapped['evicted']).toBeUndefined();
    expect(await openRotationSlot(packet, 'evicted', bobKey)).toBeNull();
  });
});

describe('sealed-inbox payloads are signed -- closes v2 [O-06]', () => {
  it('quick messages verify and resist sender spoofing', async () => {
    const qm = await buildQuickMessage({
      senderParticipantId: alice.participantId,
      senderScreenName: 'Alice', senderAvatarName: 'Armando',
      senderPublicKey: alice.publicKeyBase64,
      senderSigningPublicKey: alice.signingPublicKeyBase64,
      recipientParticipantId: bob.participantId,
      text: 'hey', emotion: 0, intensity: 0.5, signingPrivateKey: aliceSign,
    });
    expect(await verifyQuickMessage(qm)).toBe(true);
    expect(await verifyQuickMessage({ ...qm, text: 'transfer the money' })).toBe(false);
    expect(await verifyQuickMessage({ ...qm, senderScreenName: 'Bob' })).toBe(false);
  });

  it('contact capabilities are signed by their issuer', async () => {
    const cap = await buildContactCapability({
      issuerId: alice.participantId,
      issuerSigningPublicKey: alice.signingPublicKeyBase64,
      issuerScreenName: 'Alice', capability: 'cap-value', generation: 2,
      signingPrivateKey: aliceSign,
    });
    expect(await verifyContactCapability(cap)).toBe(true);
    expect(await verifyContactCapability({ ...cap, capability: 'stolen' })).toBe(false);
  });
});

describe('metadata is signed -- closes v2 [O-18]', () => {
  it('verifies and rejects a rewritten title', async () => {
    const meta = await buildRoomMetadata({
      convId: 'c1', title: 'Corner Booth', setterId: alice.participantId,
      setterSigningPublicKey: alice.signingPublicKeyBase64, signingPrivateKey: aliceSign,
    });
    expect(await verifyRoomMetadata(meta)).toBe(true);
    expect(await verifyRoomMetadata({ ...meta, title: 'Hijacked' })).toBe(false);
  });

  it('rejects a packet signed by someone else', async () => {
    const meta = await buildRoomMetadata({
      convId: 'c1', title: 'Corner Booth', setterId: alice.participantId,
      setterSigningPublicKey: alice.signingPublicKeyBase64, signingPrivateKey: bobSign,
    });
    expect(await verifyRoomMetadata(meta)).toBe(false);
  });
});
