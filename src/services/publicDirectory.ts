import { schnorr } from '@noble/secp256k1';
import type {
  PublicRoomDescriptorPacket,
  PublicRoomTombstonePacket,
} from '../types';
import {
  verifyPublicRoomDescriptorSignature,
  verifyPublicRoomTombstoneSignature,
} from './crypto';
import { DIRECTORY_RELAY_URLS } from './relays';

const NOSTR_PUBLIC_ROOM_KIND = 30078;
const NOSTR_TAG_IDENTIFIER = 'airthread-public-room';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class PublicDirectoryService {
  private static instance: PublicDirectoryService | null = null;
  private nostrKeys: { secretKey: Uint8Array; publicKey: Uint8Array };
  private nostrPubHex: string;

  private constructor() {
    this.nostrKeys = schnorr.keygen();
    this.nostrPubHex = toHex(this.nostrKeys.publicKey);
  }

  public static getInstance(): PublicDirectoryService {
    if (!PublicDirectoryService.instance) {
      PublicDirectoryService.instance = new PublicDirectoryService();
    }
    return PublicDirectoryService.instance;
  }

  /**
   * Returns prioritized list of active Nostr relays for public room directory
   */
  public getRelayUrls(customRelays?: string[]): string[] {
    if (customRelays && customRelays.length > 0) {
      return customRelays;
    }
    return [...DIRECTORY_RELAY_URLS];
  }

  /**
   * Publishes a signed PublicRoomDescriptor to Nostr relays
   */
  public async publishDescriptor(
    descriptor: PublicRoomDescriptorPacket,
    customRelays?: string[]
  ): Promise<number> {
    const relays = this.getRelayUrls(customRelays);
    const content = JSON.stringify(descriptor);
    const createdAtSec = Math.floor(descriptor.updatedAt / 1000);
    const expiresAtSec = Math.floor(descriptor.expiresAt / 1000);

    const tags = [
      ['d', descriptor.publicRoomId],
      ['t', NOSTR_TAG_IDENTIFIER],
      ['p', this.nostrPubHex],
      ['expiration', String(expiresAtSec)],
    ];

    const nostrEvent = await this.createNostrEvent(
      NOSTR_PUBLIC_ROOM_KIND,
      tags,
      content,
      createdAtSec
    );

    return await this.broadcastEventToRelays(nostrEvent, relays);
  }

  /**
   * Publishes a signed PublicRoomTombstone to close / unlist a room
   */
  public async publishTombstone(
    tombstone: PublicRoomTombstonePacket,
    customRelays?: string[]
  ): Promise<number> {
    const relays = this.getRelayUrls(customRelays);
    const content = JSON.stringify(tombstone);
    const createdAtSec = Math.floor(tombstone.closedAt / 1000);

    const tags = [
      ['d', tombstone.publicRoomId],
      ['t', NOSTR_TAG_IDENTIFIER],
      ['p', this.nostrPubHex],
    ];

    const nostrEvent = await this.createNostrEvent(
      NOSTR_PUBLIC_ROOM_KIND,
      tags,
      content,
      createdAtSec
    );

    return await this.broadcastEventToRelays(nostrEvent, relays);
  }

  /**
   * Queries Nostr relays for active public room descriptors, validates signatures and expiration,
   * merges by publicRoomId (handling tombstones and keeping newest updatedAt), and returns verified descriptors.
   */
  public async fetchPublicRooms(customRelays?: string[]): Promise<PublicRoomDescriptorPacket[]> {
    const relays = this.getRelayUrls(customRelays);
    const subId = 'aircomic-pub-' + Math.random().toString(36).substring(2, 9);
    const reqPayload = JSON.stringify([
      'REQ',
      subId,
      {
        kinds: [NOSTR_PUBLIC_ROOM_KIND],
        '#t': [NOSTR_TAG_IDENTIFIER],
        limit: 150,
      },
    ]);

    const descriptorsMap = new Map<string, PublicRoomDescriptorPacket>();
    const tombstonesMap = new Map<string, PublicRoomTombstonePacket>();

    const queryPromises = relays.map((url) => {
      return new Promise<void>((resolve) => {
        let ws: WebSocket | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (ws) {
            try {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(['CLOSE', subId]));
                ws.close();
              }
            } catch {
              // ignore
            }
          }
          resolve();
        };

        timer = setTimeout(cleanup, 4000); // 4 second timeout per relay

        try {
          ws = new WebSocket(url);
          ws.onopen = () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(reqPayload);
            }
          };

          ws.onmessage = async (e) => {
            try {
              const msg = JSON.parse(e.data);
              if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
                const event = msg[2];
                if (event.content) {
                  const rawPacket = JSON.parse(event.content);
                  if (rawPacket.type === 'public_room_descriptor') {
                    const desc = rawPacket as PublicRoomDescriptorPacket;
                    const isValid = await verifyPublicRoomDescriptorSignature(desc);
                    const now = Date.now();
                    // Clock skew allowance: 60s
                    if (isValid && desc.expiresAt > now - 60000) {
                      const existing = descriptorsMap.get(desc.publicRoomId);
                      if (!existing || desc.updatedAt > existing.updatedAt) {
                        descriptorsMap.set(desc.publicRoomId, desc);
                      }
                    }
                  } else if (rawPacket.type === 'public_room_tombstone') {
                    const tomb = rawPacket as PublicRoomTombstonePacket;
                    const isValid = await verifyPublicRoomTombstoneSignature(tomb);
                    if (isValid) {
                      const existing = tombstonesMap.get(tomb.publicRoomId);
                      if (!existing || tomb.closedAt > existing.closedAt) {
                        tombstonesMap.set(tomb.publicRoomId, tomb);
                      }
                    }
                  }
                }
              } else if (Array.isArray(msg) && msg[0] === 'EOSE' && msg[1] === subId) {
                cleanup();
              }
            } catch {
              // ignore malformed events
            }
          };

          ws.onerror = cleanup;
          ws.onclose = cleanup;
        } catch {
          cleanup();
        }
      });
    });

    await Promise.all(queryPromises);

    // Filter out tombstones and expired rooms
    const activeRooms: PublicRoomDescriptorPacket[] = [];
    const now = Date.now();

    for (const [roomId, descriptor] of descriptorsMap.entries()) {
      const tombstone = tombstonesMap.get(roomId);
      if (tombstone && tombstone.closedAt >= descriptor.updatedAt) {
        // Room was closed by creator
        continue;
      }
      if (descriptor.expiresAt <= now - 60000) {
        // Expired
        continue;
      }
      activeRooms.push(descriptor);
    }

    // Sort by latest updated / created
    activeRooms.sort((a, b) => b.updatedAt - a.updatedAt);
    return activeRooms;
  }

  private async createNostrEvent(
    kind: number,
    tags: string[][],
    content: string,
    createdAtSec: number
  ) {
    const payload = [
      0,
      this.nostrPubHex,
      createdAtSec,
      kind,
      tags,
      content,
    ];

    const idBuffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(payload))
    );
    const idHex = toHex(new Uint8Array(idBuffer));
    const sigHex = toHex(await schnorr.signAsync(new Uint8Array(idBuffer), this.nostrKeys.secretKey));

    return {
      id: idHex,
      pubkey: this.nostrPubHex,
      created_at: createdAtSec,
      kind,
      tags,
      content,
      sig: sigHex,
    };
  }

  private async broadcastEventToRelays(event: any, relays: string[]): Promise<number> {
    const msg = JSON.stringify(['EVENT', event]);
    let successCount = 0;

    const promises = relays.map((url) => {
      return new Promise<void>((resolve) => {
        let ws: WebSocket | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (ws) {
            try {
              ws.close();
            } catch {
              // ignore
            }
          }
          resolve();
        };

        timer = setTimeout(cleanup, 4000);

        try {
          ws = new WebSocket(url);
          ws.onopen = () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(msg);
              successCount++;
            }
          };
          ws.onmessage = (e) => {
            try {
              const res = JSON.parse(e.data);
              if (Array.isArray(res) && res[0] === 'OK' && res[1] === event.id) {
                cleanup();
              }
            } catch {
              cleanup();
            }
          };
          ws.onerror = cleanup;
          ws.onclose = cleanup;
        } catch {
          cleanup();
        }
      });
    });

    await Promise.all(promises);
    return successCount;
  }
}

export const publicDirectoryService = PublicDirectoryService.getInstance();
