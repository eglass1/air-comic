/**
 * Public room directory and approximate occupancy -- plan [X-12], [PU-02..05].
 *
 * Two v2 defects are closed here:
 *   [O-08] the directory key was regenerated per page load, so a refresh or
 *          tombstone never replaced the earlier event. It is now derived per
 *          public room and stable across sessions.
 *   [O-12] publication was counted by sockets opening. Only a positive relay
 *          OK counts now [PU-03].
 */

import { relayPool } from '../nostr/relayPool';
import {
  buildNostrEvent,
  publicKeyHex,
  replaceableTags,
  tagValue,
  verifyNostrEvent,
  type NostrEvent,
} from '../nostr/nostrEvent';
import { topicFilters } from '../nostr/subscriptions';
import {
  D_PUBLIC_PRESENCE_PREFIX,
  MAX_ENVELOPE_BYTES,
  OCCUPANCY_BUCKETS,
  PUBLIC_DESCRIPTOR_SEC,
  PUBLIC_ROOM_PRESENCE_SEC,
  PUBLIC_PRESENCE_REFRESH_MS,
  T_PUBLIC_PRESENCE,
  T_PUBLIC_ROOM,
} from './constants';
import { deriveScopedNostrSecretKey } from './keys';
import {
  buildPublicRoomDescriptor,
  buildPublicRoomTombstone,
  verifyPublicRoomDescriptor,
  verifyPublicRoomTombstone,
} from './packets';
import { safeParse } from './validate';
import type {
  PublicRoomDescriptorPacket,
  PublicRoomPresenceRecord,
  PublicRoomTombstonePacket,
} from './types';
import { PROTOCOL, EXT_PUBLIC_ROOMS } from './constants';

export type OccupancyBucket = string;

export function occupancyBucket(count: number): OccupancyBucket {
  return OCCUPANCY_BUCKETS.find((b) => count >= b.min)?.label ?? '0';
}

export interface PublishOutcome {
  acceptedRelays: number;
  ok: boolean;
}

export class DirectoryService {
  /**
   * Per-room, deterministic Nostr key. Stable enough for NIP-33 replacement and
   * isolated from the creator's presence identity and their other rooms [PU-02].
   */
  private async roomKey(
    signingPrivateKeyJwk: JsonWebKey,
    publicRoomId: string
  ): Promise<Uint8Array> {
    return deriveScopedNostrSecretKey(signingPrivateKeyJwk, publicRoomId);
  }

  async publishDescriptor(params: {
    descriptor: PublicRoomDescriptorPacket;
    signingPrivateKeyJwk: JsonWebKey;
  }): Promise<PublishOutcome> {
    const secretKey = await this.roomKey(
      params.signingPrivateKeyJwk,
      params.descriptor.publicRoomId
    );
    const event = await buildNostrEvent({
      secretKey,
      tags: replaceableTags({
        d: params.descriptor.publicRoomId,
        topic: T_PUBLIC_ROOM,
        expirationSec: PUBLIC_DESCRIPTOR_SEC,
      }),
      content: JSON.stringify(params.descriptor),
    });

    const result = await relayPool.publish(event);
    // Only real acknowledgements count [PU-03][O-12].
    return { acceptedRelays: result.accepted.length, ok: result.quorumMet };
  }

  async publishTombstone(params: {
    tombstone: PublicRoomTombstonePacket;
    signingPrivateKeyJwk: JsonWebKey;
  }): Promise<PublishOutcome> {
    const secretKey = await this.roomKey(
      params.signingPrivateKeyJwk,
      params.tombstone.publicRoomId
    );
    // Same key and same `d` tag as the descriptor, so this genuinely replaces
    // the listing instead of racing it [O-08].
    const event = await buildNostrEvent({
      secretKey,
      tags: replaceableTags({ d: params.tombstone.publicRoomId, topic: T_PUBLIC_ROOM }),
      content: JSON.stringify(params.tombstone),
    });
    const result = await relayPool.publish(event);
    return { acceptedRelays: result.accepted.length, ok: result.quorumMet };
  }

  /** Verified, unexpired, tombstone-suppressed listings, newest first. */
  async fetchRooms(): Promise<PublicRoomDescriptorPacket[]> {
    const events = await relayPool.query(topicFilters(T_PUBLIC_ROOM), { timeoutMs: 6000 });

    const descriptors = new Map<string, PublicRoomDescriptorPacket>();
    const tombstones = new Map<string, PublicRoomTombstonePacket>();

    for (const event of events) {
      const parsed = safeParse(event.content, MAX_ENVELOPE_BYTES) as
        | { type?: string }
        | null;
      if (!parsed?.type) continue;

      if (parsed.type === 'public_room_descriptor') {
        const descriptor = parsed as PublicRoomDescriptorPacket;
        if (descriptor.protocol !== PROTOCOL || descriptor.extension !== EXT_PUBLIC_ROOMS) continue;
        if (!(await verifyPublicRoomDescriptor(descriptor, descriptor.publicRoomId))) continue;
        const existing = descriptors.get(descriptor.publicRoomId);
        if (!existing || descriptor.updatedAt > existing.updatedAt) {
          descriptors.set(descriptor.publicRoomId, descriptor);
        }
      } else if (parsed.type === 'public_room_tombstone') {
        const tombstone = parsed as PublicRoomTombstonePacket;
        if (!(await verifyPublicRoomTombstone(tombstone))) continue;
        const existing = tombstones.get(tombstone.publicRoomId);
        if (!existing || tombstone.closedAt > existing.closedAt) {
          tombstones.set(tombstone.publicRoomId, tombstone);
        }
      }
    }

    const now = Date.now();
    const live: PublicRoomDescriptorPacket[] = [];
    for (const [roomId, descriptor] of descriptors) {
      const tombstone = tombstones.get(roomId);
      // A tombstone only wins if it is at least as new as the listing, and only
      // from the creator identity the descriptor names.
      if (
        tombstone &&
        tombstone.closedAt >= descriptor.updatedAt &&
        tombstone.creatorId === descriptor.creatorId
      ) {
        continue;
      }
      if (descriptor.expiresAt <= now - 60000) continue;
      live.push(descriptor);
    }

    return live.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Counts distinct valid unexpired publishers for a room [PU-04].
   *
   * Authentication is the Nostr event's own Schnorr signature: presenceId IS
   * the room-scoped public key, and there is deliberately no inner application
   * signature that would deanonymise the publisher [L-09].
   */
  async fetchOccupancy(publicRoomIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (publicRoomIds.length === 0) return counts;

    const events = await relayPool.query(
      [
        {
          kinds: [30078],
          '#t': [T_PUBLIC_PRESENCE],
          '#d': publicRoomIds.map((id) => D_PUBLIC_PRESENCE_PREFIX + id),
          limit: 1000,
        },
      ],
      { timeoutMs: 5000 }
    );

    const seen = new Map<string, Set<string>>();
    const now = Date.now();

    for (const event of events) {
      const parsed = safeParse(event.content, 4096) as PublicRoomPresenceRecord | null;
      if (parsed?.type !== 'public_room_presence') continue;
      if (!publicRoomIds.includes(parsed.publicRoomId)) continue;
      if (parsed.expiresAt <= now) continue;
      // The claimed publisher must be the key that signed the event.
      if (parsed.presenceId !== event.pubkey) continue;
      if (!(await verifyNostrEvent(event))) continue;

      const set = seen.get(parsed.publicRoomId) ?? new Set<string>();
      set.add(event.pubkey);
      seen.set(parsed.publicRoomId, set);
    }

    for (const id of publicRoomIds) counts.set(id, seen.get(id)?.size ?? 0);
    return counts;
  }
}

export const directoryService = new DirectoryService();

/**
 * Publishes a short-lived occupancy beacon while a public room is open.
 * Refreshed every 45 s, expiring after 120 s [PU-04].
 */
export class PublicRoomPresenceBeacon {
  private timer: ReturnType<typeof setInterval> | null = null;
  private secretKey: Uint8Array | null = null;

  async start(signingPrivateKeyJwk: JsonWebKey, publicRoomId: string): Promise<void> {
    this.stop();
    this.secretKey = await deriveScopedNostrSecretKey(signingPrivateKeyJwk, publicRoomId);
    const beat = () => void this.publish(publicRoomId);
    beat();
    this.timer = setInterval(beat, PUBLIC_PRESENCE_REFRESH_MS);
  }

  private async publish(publicRoomId: string): Promise<void> {
    if (!this.secretKey) return;
    const now = Date.now();
    const record: PublicRoomPresenceRecord = {
      type: 'public_room_presence',
      protocol: PROTOCOL,
      extension: EXT_PUBLIC_ROOMS,
      publicRoomId,
      presenceId: publicKeyHex(this.secretKey),
      observedAt: now,
      expiresAt: now + PUBLIC_ROOM_PRESENCE_SEC * 1000,
    };
    // No screen name, avatar, contact info or participantId [PU-04].
    const event = await buildNostrEvent({
      secretKey: this.secretKey,
      tags: replaceableTags({
        d: D_PUBLIC_PRESENCE_PREFIX + publicRoomId,
        topic: T_PUBLIC_PRESENCE,
        expirationSec: PUBLIC_ROOM_PRESENCE_SEC,
      }),
      content: JSON.stringify(record),
    });
    await relayPool.publish(event);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.secretKey = null;
  }
}

export function descriptorRelayHints(descriptor: PublicRoomDescriptorPacket): string[] {
  return Array.isArray(descriptor.relayUrls) ? descriptor.relayUrls : [];
}

export { buildPublicRoomDescriptor, buildPublicRoomTombstone, tagValue };
export type { NostrEvent };
