import { describe, it, expect } from 'vitest';
import {
  deriveInboxTag,
  derivePresenceCapabilityTag,
  derivePrivateRoutingTag,
  derivePublicRoomId,
  deriveRootControlKey,
  deriveScopedNostrSecretKey,
  deriveWebrtcPassword,
  deriveWebrtcRoomId,
  generateCapability,
  generateRoomSecret,
} from '../keys';
import { generateUserKeyPair } from '../../crypto';

const CONV = '11111111-2222-3333-4444-555555555555';
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('room secret generation', () => {
  it('produces 256 bits of base64url', () => {
    const s = generateRoomSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes -> 43 unpadded base64url chars
    expect(s.length).toBe(43);
    expect(generateRoomSecret()).not.toBe(s);
  });

  it('capabilities are distinct and full width', () => {
    expect(generateCapability().length).toBe(43);
    expect(generateCapability()).not.toBe(generateCapability());
  });
});

describe('private room derivations', () => {
  it('routing tag is stable for the same inputs', async () => {
    const a = await derivePrivateRoutingTag(SECRET, CONV);
    const b = await derivePrivateRoutingTag(SECRET, CONV);
    expect(a).toBe(b);
  });

  it('routing tag changes when the secret rotates -- [PR-07] strong removal', async () => {
    const before = await derivePrivateRoutingTag(SECRET, CONV);
    const after = await derivePrivateRoutingTag(generateRoomSecret(), CONV);
    expect(after).not.toBe(before);
  });

  it('routing tag is not derivable from convId alone -- closes v2 [O-01]', async () => {
    const a = await derivePrivateRoutingTag('secret-one', CONV);
    const b = await derivePrivateRoutingTag('secret-two', CONV);
    expect(a).not.toBe(b);
  });

  it('convId is case-insensitive in the salt', async () => {
    const lower = await derivePrivateRoutingTag(SECRET, CONV.toLowerCase());
    const upper = await derivePrivateRoutingTag(SECRET, CONV.toUpperCase());
    expect(lower).toBe(upper);
  });

  it('each purpose derives a distinct value from one secret', async () => {
    const routing = await derivePrivateRoutingTag(SECRET, CONV);
    const room = await deriveWebrtcRoomId(SECRET, CONV);
    const pass = await deriveWebrtcPassword(SECRET, CONV);
    const rootRaw = await crypto.subtle.exportKey('raw', await deriveRootControlKey(SECRET, CONV));
    const root = Buffer.from(rootRaw).toString('base64url');
    const all = new Set([routing, room, pass, root]);
    expect(all.size).toBe(4);
  });

  it('webrtc room id and password differ despite a shared salt', async () => {
    expect(await deriveWebrtcRoomId(SECRET, CONV)).not.toBe(
      await deriveWebrtcPassword(SECRET, CONV)
    );
  });
});

describe('public room id', () => {
  it('binds convId and join token together', async () => {
    const a = await derivePublicRoomId(CONV, 'token-a');
    const b = await derivePublicRoomId(CONV, 'token-b');
    expect(a).not.toBe(b);
    expect(await derivePublicRoomId(CONV, 'token-a')).toBe(a);
  });
});

describe('routing tags for inbox and presence', () => {
  it('inbox tag is derived from participantId -- [L-08]', async () => {
    const a = await deriveInboxTag('pid-one');
    expect(await deriveInboxTag('pid-one')).toBe(a);
    expect(await deriveInboxTag('pid-two')).not.toBe(a);
  });

  it('presence tag is derived from a capability, not an identity -- closes v2 [O-11]', async () => {
    const cap = generateCapability();
    const tag = await derivePresenceCapabilityTag(cap);
    expect(await derivePresenceCapabilityTag(cap)).toBe(tag);
    expect(await derivePresenceCapabilityTag(generateCapability())).not.toBe(tag);
  });
});

describe('scoped Nostr identities -- [T-06]', () => {
  it('is stable within a scope and distinct across scopes', async () => {
    const id = await generateUserKeyPair();
    const roomA = await deriveScopedNostrSecretKey(id.signingPrivateKeyJwk, 'tag-a');
    const roomA2 = await deriveScopedNostrSecretKey(id.signingPrivateKeyJwk, 'tag-a');
    const roomB = await deriveScopedNostrSecretKey(id.signingPrivateKeyJwk, 'tag-b');

    expect(Buffer.from(roomA)).toEqual(Buffer.from(roomA2));
    expect(Buffer.from(roomA)).not.toEqual(Buffer.from(roomB));
    expect(roomA.length).toBe(32);
  });

  it('differs per identity for the same scope', async () => {
    const one = await generateUserKeyPair();
    const two = await generateUserKeyPair();
    const a = await deriveScopedNostrSecretKey(one.signingPrivateKeyJwk, 'tag');
    const b = await deriveScopedNostrSecretKey(two.signingPrivateKeyJwk, 'tag');
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
  });

  it('yields a scalar inside the secp256k1 group order', async () => {
    const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    for (let i = 0; i < 5; i++) {
      const id = await generateUserKeyPair();
      const key = await deriveScopedNostrSecretKey(id.signingPrivateKeyJwk, `scope-${i}`);
      const value = BigInt('0x' + Buffer.from(key).toString('hex'));
      expect(value > 0n && value < n).toBe(true);
    }
  });
});
