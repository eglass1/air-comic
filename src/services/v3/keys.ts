/**
 * airthread/3 key derivations -- implementation plan [X-02].
 *
 * Identity keypairs are unchanged from v2 (RSA-OAEP 2048 for key transport,
 * ECDSA P-256 for signatures). Everything room-scoped is derived here.
 */

import {
  arrayBufferToBase64Url,
  base64UrlToArrayBuffer,
  normalizePublicKey,
} from '../crypto';
import {
  SALT_ROOT,
  SALT_ROUTING,
  SALT_WEBRTC,
  INFO_ROOT,
  INFO_ROUTING,
  INFO_WEBRTC_ROOM,
  INFO_WEBRTC_PASSWORD,
  PREFIX_ROOM_TAG,
  PREFIX_PUBLIC_ROOM_ID,
  PREFIX_INBOX_TAG,
  PREFIX_PRESENCE_CAP_TAG,
  PREFIX_NOSTR_ROOM_KEY,
  PREFIX_NOSTR_INBOX_SCOPE,
  SUFFIX_RESPONSE_TAG,
  SUFFIX_QUICKMSG_TAG,
} from './constants';

const encoder = new TextEncoder();

// ----------------------------------------------------------------------------
// Generic HKDF helpers
// ----------------------------------------------------------------------------

async function hkdfSalt(prefix: string, convId: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(prefix + convId.trim().toLowerCase()));
}

async function importHkdf(secret: string, usage: 'deriveBits' | 'deriveKey'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret.trim()), { name: 'HKDF' }, false, [
    usage,
  ]);
}

async function deriveBits256(secret: string, convId: string, saltPrefix: string, info: string) {
  const key = await importHkdf(secret, 'deriveBits');
  return crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(await hkdfSalt(saltPrefix, convId)),
      info: encoder.encode(info),
    },
    key,
    256
  );
}

async function deriveAesKey(secret: string, convId: string, saltPrefix: string, info: string) {
  const key = await importHkdf(secret, 'deriveKey');
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(await hkdfSalt(saltPrefix, convId)),
      info: encoder.encode(info),
    },
    key,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// ----------------------------------------------------------------------------
// Room secrets
// ----------------------------------------------------------------------------

/** 256-bit room secret, Base64URL. Note v2 used 128 bits. [PR-01] */
export function generateRoomSecret(): string {
  return arrayBufferToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 256-bit random capability, Base64URL. Used for contact presence. [X-11] */
export function generateCapability(): string {
  return arrayBufferToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

// ----------------------------------------------------------------------------
// Private room derivations
// ----------------------------------------------------------------------------

/** Root control key. Control packets only -- never a chat content key. [PR-01] */
export async function deriveRootControlKey(roomSecret: string, convId: string): Promise<CryptoKey> {
  return deriveAesKey(roomSecret, convId, SALT_ROOT, INFO_ROOT);
}

/**
 * Private routing tag. [T-04], with the string-encoding question ruled by [L-02]:
 * the derived routing key is Base64URL-encoded first, then concatenated as text.
 */
export async function derivePrivateRoutingTag(roomSecret: string, convId: string): Promise<string> {
  const bits = await deriveBits256(roomSecret, convId, SALT_ROUTING, INFO_ROUTING);
  const routingKey = arrayBufferToBase64Url(bits);
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(PREFIX_ROOM_TAG + routingKey));
  return arrayBufferToBase64Url(hash);
}

/** Trystero roomId. Never the raw convId. [W-02] */
export async function deriveWebrtcRoomId(roomSecret: string, convId: string): Promise<string> {
  const bits = await deriveBits256(roomSecret, convId, SALT_WEBRTC, INFO_WEBRTC_ROOM);
  return arrayBufferToBase64Url(bits);
}

/** Trystero password. Full-entropy derived value, never a human password. [W-02][O-17] */
export async function deriveWebrtcPassword(roomSecret: string, convId: string): Promise<string> {
  const bits = await deriveBits256(roomSecret, convId, SALT_WEBRTC, INFO_WEBRTC_PASSWORD);
  return arrayBufferToBase64Url(bits);
}

/** Short human-comparable fingerprint of the room route. Display only. */
export async function deriveRoomFingerprint(routingTag: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(routingTag));
  return Array.from(new Uint8Array(hash))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();
}

// ----------------------------------------------------------------------------
// Public room derivations
// ----------------------------------------------------------------------------

/** publicRoomId, which is also the public routing tag. [T-05][X-02] */
export async function derivePublicRoomId(convId: string, publicJoinToken: string): Promise<string> {
  const input = `${PREFIX_PUBLIC_ROOM_ID}${convId.trim().toLowerCase()}:${publicJoinToken.trim()}`;
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return arrayBufferToBase64Url(hash);
}

// ----------------------------------------------------------------------------
// Inbox and presence tags
// ----------------------------------------------------------------------------

/** [L-08]: inbox routing stays derived from participantId. */
export async function deriveInboxTag(participantId: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(PREFIX_INBOX_TAG + participantId));
  return arrayBufferToBase64Url(hash);
}

export async function deriveResponseTag(participantId: string): Promise<string> {
  return (await deriveInboxTag(participantId)) + SUFFIX_RESPONSE_TAG;
}

export async function deriveQuickMessageTag(participantId: string): Promise<string> {
  return (await deriveInboxTag(participantId)) + SUFFIX_QUICKMSG_TAG;
}

/** Presence is published to a capability tag, not a participantId hash. [X-11][O-11] */
export async function derivePresenceCapabilityTag(capability: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(PREFIX_PRESENCE_CAP_TAG + capability)
  );
  return arrayBufferToBase64Url(hash);
}

// ----------------------------------------------------------------------------
// Per-room Nostr publishing identity  [T-06], ruled by [L-03]
// ----------------------------------------------------------------------------

/** secp256k1 group order. */
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

async function importScalarAsHmacKey(signingPrivateKeyJwk: JsonWebKey): Promise<CryptoKey> {
  if (!signingPrivateKeyJwk.d) throw new Error('Signing private key JWK has no scalar');
  const scalar = base64UrlToArrayBuffer(signingPrivateKeyJwk.d);
  return crypto.subtle.importKey('raw', scalar, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/**
 * Derives a room-scoped secp256k1 secret key so a participant's Nostr traffic is
 * not trivially linkable across rooms, presence and inboxes. [T-06]
 *
 * The scope string is the routing tag for a room, or "inbox:<participantId>"
 * for the user's own inbox publisher.
 */
export async function deriveScopedNostrSecretKey(
  signingPrivateKeyJwk: JsonWebKey,
  scope: string
): Promise<Uint8Array> {
  const hmacKey = await importScalarAsHmacKey(signingPrivateKeyJwk);
  let seed = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(PREFIX_NOSTR_ROOM_KEY + scope))
  );

  for (let i = 0; i < 32; i++) {
    const asInt = bytesToBigInt(seed);
    if (asInt > 0n && asInt < SECP256K1_N) return seed;
    const next = new Uint8Array(seed.length + 1);
    next.set(seed, 0);
    next[seed.length] = i;
    seed = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, next));
  }
  throw new Error('Failed to derive a valid scoped Nostr secret key');
}

/** Scope string for the user's own inbox publisher identity. */
export function inboxNostrScope(participantId: string): string {
  return PREFIX_NOSTR_INBOX_SCOPE + participantId;
}

// ----------------------------------------------------------------------------
// Epoch keys
// ----------------------------------------------------------------------------

export async function generateEpochKey(): Promise<{
  key: CryptoKey;
  rawBuffer: ArrayBuffer;
  rawBase64Url: string;
}> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const rawBuffer = await crypto.subtle.exportKey('raw', key);
  return { key, rawBuffer, rawBase64Url: arrayBufferToBase64Url(rawBuffer) };
}

export function makeEpochKeyId(epoch: number): string {
  return `epoch-${epoch}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Re-export so callers do not reach past this module for key normalisation. */
export { normalizePublicKey };
