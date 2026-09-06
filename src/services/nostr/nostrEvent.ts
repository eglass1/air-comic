/**
 * NIP-01 event construction and signing.
 *
 * Events are signed with a scoped secp256k1 key derived per room, inbox or
 * public room [T-06], so a relay cannot trivially link one participant's
 * traffic across rooms from the Nostr layer alone.
 */

import { schnorr } from '@noble/secp256k1';
import {
  NOSTR_KIND,
  TAG_D,
  TAG_EXPIRATION,
  TAG_MODE,
  TAG_R,
  TAG_T,
  TAG_VERSION,
  PROTOCOL_VERSION_TAG,
} from '../v3/constants';
import type { RoomMode } from '../v3/types';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type NostrFilter = {
  kinds?: number[];
  authors?: string[];
  ids?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [tagFilter: `#${string}`]: string[] | number[] | number | undefined;
};

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function publicKeyHex(secretKey: Uint8Array): string {
  return toHex(schnorr.getPublicKey(secretKey));
}

/** NIP-01 event id: SHA-256 over the canonical serialization array. */
async function computeEventId(
  pubkey: string,
  createdAt: number,
  kind: number,
  tags: string[][],
  content: string
): Promise<Uint8Array> {
  const serialized = JSON.stringify([0, pubkey, createdAt, kind, tags, content]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return new Uint8Array(digest);
}

export async function buildNostrEvent(params: {
  secretKey: Uint8Array;
  kind?: number;
  tags: string[][];
  content: string;
  createdAt?: number;
}): Promise<NostrEvent> {
  const pubkey = publicKeyHex(params.secretKey);
  const kind = params.kind ?? NOSTR_KIND;
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);
  const idBytes = await computeEventId(pubkey, createdAt, kind, params.tags, params.content);

  return {
    id: toHex(idBytes),
    pubkey,
    created_at: createdAt,
    kind,
    tags: params.tags,
    content: params.content,
    sig: toHex(await schnorr.signAsync(idBytes, params.secretKey)),
  };
}

/** Recomputes the id and checks the Schnorr signature on a received event. */
export async function verifyNostrEvent(event: NostrEvent): Promise<boolean> {
  try {
    const idBytes = await computeEventId(
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content
    );
    if (toHex(idBytes) !== event.id) return false;
    // verifyAsync uses the WebCrypto backend. The synchronous schnorr.verify
    // needs @noble/hashes wired into secp.hashes.sha256 and throws without it.
    return await schnorr.verifyAsync(hexToBytes(event.sig), idBytes, hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Tag builders  [T-03]
// ----------------------------------------------------------------------------

export function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags?.find((t) => t[0] === name)?.[1];
}

/**
 * Tags for a room packet. Deliberately carries no participantId, screen name,
 * convId, epoch number or packet type in the clear [T-03].
 */
export function roomPacketTags(params: {
  packetId: string;
  routingTag: string;
  roomMode: RoomMode;
  topic: string;
  expirationSec?: number;
}): string[][] {
  const tags: string[][] = [
    [TAG_D, params.packetId],
    [TAG_T, params.topic],
    [TAG_R, params.routingTag],
    [TAG_MODE, params.roomMode],
    [TAG_VERSION, PROTOCOL_VERSION_TAG],
  ];
  // Control packets omit expiration entirely so the membership chain stays
  // reconstructible [L-05][L-06].
  if (params.expirationSec !== undefined) {
    tags.push([TAG_EXPIRATION, String(Math.floor(Date.now() / 1000) + params.expirationSec)]);
  }
  return tags;
}

export function replaceableTags(params: {
  d: string;
  topic: string;
  expirationSec?: number;
  extra?: string[][];
}): string[][] {
  const tags: string[][] = [
    [TAG_D, params.d],
    [TAG_T, params.topic],
    [TAG_VERSION, PROTOCOL_VERSION_TAG],
    ...(params.extra ?? []),
  ];
  if (params.expirationSec !== undefined) {
    tags.push([TAG_EXPIRATION, String(Math.floor(Date.now() / 1000) + params.expirationSec)]);
  }
  return tags;
}
