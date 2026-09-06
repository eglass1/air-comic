/**
 * RoomEnvelope build and verify -- implementation plan [X-03].
 *
 * The receive ordering in verifyEnvelope() is mandatory and must not be
 * reordered: structure, identity binding and signature all complete before any
 * decryption is attempted. Never decrypt to decide whether to verify.
 */

import {
  arrayBufferToBase64Url,
  base64UrlToArrayBuffer,
  canonicalStringify,
  getParticipantId,
  normalizePublicKey,
  signData,
  verifySignature,
} from '../crypto';
import {
  DOMAIN_ROOM_ENVELOPE,
  ENVELOPE_AAD_PREFIX,
  EXT_TRANSPORT,
  LIVE_FUTURE_SKEW_MS,
  MAX_ENVELOPE_BYTES,
  PROTOCOL,
} from './constants';
import type { PacketClass, RoomEnvelope, RoomMode } from './types';
import {
  byteLength,
  requireInt,
  requireLiteral,
  requireObject,
  requireString,
  safeParse,
  ValidationError,
} from './validate';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ----------------------------------------------------------------------------
// AAD  [P-02]
// ----------------------------------------------------------------------------

export function envelopeAad(e: {
  convId: string;
  packetId: string;
  roomMode: RoomMode;
  packetClass: PacketClass;
  keyId: string;
  senderId: string;
  timestamp: number;
}): string {
  return (
    ENVELOPE_AAD_PREFIX +
    `${e.convId}:${e.packetId}:${e.roomMode}:${e.packetClass}:${e.keyId}:${e.senderId}:${e.timestamp}`
  );
}

function signingInput(envelope: Omit<RoomEnvelope, 'signature'>): string {
  return DOMAIN_ROOM_ENVELOPE + canonicalStringify(envelope);
}

/** Content hash used by the dedup ledger [L-13][X-06]. */
export async function envelopeContentHash(serialized: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(serialized));
  return arrayBufferToBase64Url(hash);
}

// ----------------------------------------------------------------------------
// Build
// ----------------------------------------------------------------------------

export interface BuildEnvelopeParams {
  convId: string;
  packetId?: string;
  roomMode: RoomMode;
  packetClass: PacketClass;
  keyId: string;
  senderId: string;
  senderSigningPublicKey: string;
  signingPrivateKey: CryptoKey;
  payload: unknown;
  timestamp?: number;
  /** Required for private rooms; must be absent for public rooms [L-11]. */
  contentKey?: CryptoKey;
}

/**
 * Builds one signed envelope. Private payloads are AES-256-GCM encrypted under
 * the epoch (or root, for control) key; public payloads are carried in the
 * clear, because a key derived from a published join token is obfuscation
 * rather than confidentiality [L-11][PU-01].
 */
export async function buildEnvelope(params: BuildEnvelopeParams): Promise<{
  envelope: RoomEnvelope;
  serialized: string;
  contentHash: string;
}> {
  const packetId = params.packetId ?? crypto.randomUUID();
  const timestamp = params.timestamp ?? Date.now();
  const plaintext = canonicalStringify(params.payload);

  const header = {
    convId: params.convId,
    packetId,
    roomMode: params.roomMode,
    packetClass: params.packetClass,
    keyId: params.keyId,
    senderId: params.senderId,
    timestamp,
  };

  let iv = '';
  let data: string;

  if (params.roomMode === 'private') {
    if (!params.contentKey) throw new Error('Private envelope requires a content key');
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
        additionalData: encoder.encode(envelopeAad(header)),
      },
      params.contentKey,
      encoder.encode(plaintext)
    );
    iv = arrayBufferToBase64Url(ivBytes);
    data = arrayBufferToBase64Url(ciphertext);
  } else {
    data = arrayBufferToBase64Url(encoder.encode(plaintext));
  }

  const unsigned: Omit<RoomEnvelope, 'signature'> = {
    protocol: PROTOCOL,
    extension: EXT_TRANSPORT,
    type: 'room_envelope',
    ...header,
    senderSigningPublicKey: normalizePublicKey(params.senderSigningPublicKey),
    iv,
    data,
  };

  const signature = await signData(params.signingPrivateKey, signingInput(unsigned));
  const envelope: RoomEnvelope = { ...unsigned, signature };

  // Serialize exactly once and reuse the string on both transports, so the
  // content hash cannot diverge between them [G-06][P-03].
  const serialized = JSON.stringify(envelope);
  if (byteLength(serialized) > MAX_ENVELOPE_BYTES) {
    throw new Error(`Envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`);
  }

  return { envelope, serialized, contentHash: await envelopeContentHash(serialized) };
}

// ----------------------------------------------------------------------------
// Parse and verify
// ----------------------------------------------------------------------------

export type EnvelopeRejection =
  | 'too_large'
  | 'malformed'
  | 'wrong_protocol'
  | 'identity_mismatch'
  | 'bad_signature'
  | 'wrong_room'
  | 'future_timestamp';

export interface EnvelopeVerifyResult {
  ok: boolean;
  envelope?: RoomEnvelope;
  serialized?: string;
  contentHash?: string;
  reason?: EnvelopeRejection;
  detail?: string;
}

/** Structural shape check only. Does not verify signatures. */
export function parseEnvelope(raw: string): RoomEnvelope | null {
  const parsed = safeParse(raw, MAX_ENVELOPE_BYTES);
  if (parsed === null) return null;
  try {
    const obj = requireObject(parsed, '$');
    if (obj.protocol !== PROTOCOL || obj.extension !== EXT_TRANSPORT) return null;
    if (obj.type !== 'room_envelope') return null;

    const envelope: RoomEnvelope = {
      protocol: PROTOCOL,
      extension: EXT_TRANSPORT,
      type: 'room_envelope',
      convId: requireString(obj, 'convId', 128, '$'),
      packetId: requireString(obj, 'packetId', 128, '$'),
      roomMode: requireLiteral(obj, 'roomMode', ['private', 'public'] as const, '$'),
      packetClass: requireLiteral(
        obj,
        'packetClass',
        ['chat', 'control', 'metadata', 'system'] as const,
        '$'
      ),
      keyId: requireString(obj, 'keyId', 128, '$'),
      senderId: requireString(obj, 'senderId', 128, '$'),
      senderSigningPublicKey: requireString(obj, 'senderSigningPublicKey', 2048, '$'),
      timestamp: requireInt(obj, 'timestamp', '$'),
      iv: requireString(obj, 'iv', 64, '$'),
      data: requireString(obj, 'data', MAX_ENVELOPE_BYTES, '$'),
      signature: requireString(obj, 'signature', 512, '$'),
    };

    if (envelope.roomMode === 'private' && !envelope.iv) return null;
    if (envelope.roomMode === 'public' && envelope.iv !== '') return null;
    return envelope;
  } catch (err) {
    if (err instanceof ValidationError) return null;
    return null;
  }
}

/**
 * Steps 1-7 of the mandatory receive order [X-03]. Dedup (8), authorization (9)
 * and decryption (10) are the caller's responsibility, in that order.
 */
export async function verifyEnvelope(
  raw: string,
  expect: { convId: string; roomMode: RoomMode }
): Promise<EnvelopeVerifyResult> {
  if (byteLength(raw) > MAX_ENVELOPE_BYTES) return { ok: false, reason: 'too_large' };

  const envelope = parseEnvelope(raw);
  if (!envelope) return { ok: false, reason: 'malformed' };

  // Identity binding before signature: the key we verify with must be the key
  // the claimed sender id hashes from.
  const derivedId = await getParticipantId(envelope.senderSigningPublicKey);
  if (derivedId !== envelope.senderId) {
    return { ok: false, reason: 'identity_mismatch' };
  }

  const { signature, ...unsigned } = envelope;
  const valid = await verifySignature(
    envelope.senderSigningPublicKey,
    signingInput(unsigned),
    signature
  );
  if (!valid) return { ok: false, reason: 'bad_signature' };

  if (envelope.convId !== expect.convId || envelope.roomMode !== expect.roomMode) {
    return { ok: false, reason: 'wrong_room' };
  }

  if (envelope.timestamp > Date.now() + LIVE_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'future_timestamp' };
  }

  return {
    ok: true,
    envelope,
    serialized: raw,
    contentHash: await envelopeContentHash(raw),
  };
}

/** Step 10. Only call this after dedup and authorization have passed. */
export async function openEnvelope(
  envelope: RoomEnvelope,
  contentKey: CryptoKey | null
): Promise<unknown | null> {
  try {
    let json: string;
    if (envelope.roomMode === 'private') {
      if (!contentKey) return null;
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(base64UrlToArrayBuffer(envelope.iv)),
          additionalData: encoder.encode(envelopeAad(envelope)),
        },
        contentKey,
        base64UrlToArrayBuffer(envelope.data)
      );
      json = decoder.decode(plaintext);
    } else {
      json = decoder.decode(base64UrlToArrayBuffer(envelope.data));
    }
    return safeParse(json, MAX_ENVELOPE_BYTES);
  } catch {
    return null;
  }
}
