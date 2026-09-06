import { describe, it, expect, beforeAll } from 'vitest';
import { buildEnvelope, openEnvelope, parseEnvelope, verifyEnvelope } from '../envelope';
import { generateEpochKey } from '../keys';
import { generateUserKeyPair, importSigningPrivateKeyFromJwk, type GeneratedUserIdentity } from '../../crypto';

let id: GeneratedUserIdentity;
let signKey: CryptoKey;
let contentKey: CryptoKey;

const CONV = 'conv-1';

beforeAll(async () => {
  id = await generateUserKeyPair();
  signKey = await importSigningPrivateKeyFromJwk(id.signingPrivateKeyJwk);
  contentKey = (await generateEpochKey()).key;
});

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    convId: CONV,
    roomMode: 'private' as const,
    packetClass: 'chat' as const,
    keyId: 'epoch-1-abcd1234',
    senderId: id.participantId,
    senderSigningPublicKey: id.signingPublicKeyBase64,
    signingPrivateKey: signKey,
    payload: { type: 'message', text: 'hello' },
    contentKey,
    ...overrides,
  };
}

describe('private envelope round trip', () => {
  it('encrypts, signs, verifies and opens', async () => {
    const { serialized } = await buildEnvelope(baseParams());
    const result = await verifyEnvelope(serialized, { convId: CONV, roomMode: 'private' });
    expect(result.ok).toBe(true);
    const payload = await openEnvelope(result.envelope!, contentKey);
    expect(payload).toEqual({ type: 'message', text: 'hello' });
  });

  it('produces a stable content hash for identical bytes -- [G-06]', async () => {
    const built = await buildEnvelope(baseParams());
    const again = await verifyEnvelope(built.serialized, { convId: CONV, roomMode: 'private' });
    expect(again.contentHash).toBe(built.contentHash);
  });

  it('will not build without a content key', async () => {
    await expect(buildEnvelope(baseParams({ contentKey: undefined }))).rejects.toThrow();
  });

  it('does not open under the wrong key', async () => {
    const { envelope } = await buildEnvelope(baseParams());
    const other = (await generateEpochKey()).key;
    expect(await openEnvelope(envelope, other)).toBeNull();
  });
});

describe('public envelope', () => {
  it('carries an empty iv and readable payload -- [L-11]', async () => {
    const { envelope, serialized } = await buildEnvelope(
      baseParams({ roomMode: 'public', keyId: 'public-v3', contentKey: undefined })
    );
    expect(envelope.iv).toBe('');
    const result = await verifyEnvelope(serialized, { convId: CONV, roomMode: 'public' });
    expect(result.ok).toBe(true);
    expect(await openEnvelope(result.envelope!, null)).toEqual({
      type: 'message',
      text: 'hello',
    });
  });
});

describe('AAD binds every header field -- [P-02]', () => {
  const mutations: Array<[string, unknown]> = [
    ['convId', 'other-conv'],
    ['packetId', 'other-packet'],
    ['packetClass', 'control'],
    ['keyId', 'epoch-2-ffffffff'],
    ['senderId', 'someone-else'],
    ['timestamp', 999],
  ];

  for (const [field, value] of mutations) {
    it(`rejects a rewritten ${field}`, async () => {
      const { envelope } = await buildEnvelope(baseParams());
      const tampered = { ...envelope, [field]: value };
      // The signature covers the header, so verification fails first...
      const result = await verifyEnvelope(JSON.stringify(tampered), {
        convId: CONV,
        roomMode: 'private',
      });
      expect(result.ok).toBe(false);
      // ...and even given the tampered header, the AAD prevents decryption.
      expect(await openEnvelope(tampered as typeof envelope, contentKey)).toBeNull();
    });
  }
});

describe('signature covers the ciphertext', () => {
  it('rejects swapped ciphertext', async () => {
    const a = await buildEnvelope(baseParams());
    const b = await buildEnvelope(baseParams({ payload: { type: 'message', text: 'other' } }));
    const spliced = { ...a.envelope, data: b.envelope.data, iv: b.envelope.iv };
    const result = await verifyEnvelope(JSON.stringify(spliced), {
      convId: CONV,
      roomMode: 'private',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });
});

describe('receive-order rejections', () => {
  it('rejects a sender id that does not hash from the signing key', async () => {
    const { envelope } = await buildEnvelope(baseParams());
    const forged = { ...envelope, senderId: 'not-a-hash-of-that-key' };
    const result = await verifyEnvelope(JSON.stringify(forged), {
      convId: CONV,
      roomMode: 'private',
    });
    expect(result.reason).toBe('identity_mismatch');
  });

  it('rejects a packet for another room', async () => {
    const { serialized } = await buildEnvelope(baseParams());
    const result = await verifyEnvelope(serialized, { convId: 'different', roomMode: 'private' });
    expect(result.reason).toBe('wrong_room');
  });

  it('rejects a far-future timestamp -- [D-04]', async () => {
    const { serialized } = await buildEnvelope(
      baseParams({ timestamp: Date.now() + 10 * 60 * 1000 })
    );
    const result = await verifyEnvelope(serialized, { convId: CONV, roomMode: 'private' });
    expect(result.reason).toBe('future_timestamp');
  });

  it('rejects oversized input before parsing', async () => {
    const huge = JSON.stringify({ data: 'x'.repeat(70000) });
    const result = await verifyEnvelope(huge, { convId: CONV, roomMode: 'private' });
    expect(result.reason).toBe('too_large');
  });

  it('rejects malformed and foreign-protocol input', async () => {
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope(JSON.stringify({ protocol: 'airthread/2' }))).toBeNull();
    const result = await verifyEnvelope('{}', { convId: CONV, roomMode: 'private' });
    expect(result.reason).toBe('malformed');
  });

  it('rejects a private envelope with no iv and a public one with an iv', async () => {
    const { envelope } = await buildEnvelope(baseParams());
    expect(parseEnvelope(JSON.stringify({ ...envelope, iv: '' }))).toBeNull();
    const pub = await buildEnvelope(
      baseParams({ roomMode: 'public', keyId: 'public-v3', contentKey: undefined })
    );
    expect(parseEnvelope(JSON.stringify({ ...pub.envelope, iv: 'AAAAAAAAAAAAAAAA' }))).toBeNull();
  });
});
