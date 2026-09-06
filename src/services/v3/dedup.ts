/**
 * Packet deduplication -- implementation plan [X-06], closing v2 [O-10].
 *
 * v2 used a pure FIFO ledger of 4000 ids with no time dimension, so a replayed
 * envelope was accepted again once the oldest entries aged out. v3 keys on
 * (convId, packetId), records a content hash, and persists.
 */

import { DEDUP_MEMORY_LRU_SIZE } from './constants';

export type RetentionClass = 'chat' | 'control';

export interface ProcessedPacket {
  /** `${convId}::${packetId}` */
  id: string;
  convId: string;
  packetId: string;
  contentHash: string;
  senderId: string;
  packetTimestamp: number;
  firstSeenAt: number;
  retentionClass: RetentionClass;
}

export type DedupVerdict = 'new' | 'duplicate' | 'collision';

/** Persistence is injected so the ledger is testable without a browser. */
export interface DedupStore {
  get(id: string): Promise<ProcessedPacket | undefined>;
  put(record: ProcessedPacket): Promise<void>;
}

export function dedupKey(convId: string, packetId: string): string {
  return `${convId}::${packetId}`;
}

export class DedupLedger {
  private memory = new Map<string, ProcessedPacket>();
  private collisionCount = 0;

  constructor(private store: DedupStore | null = null) {}

  get collisions(): number {
    return this.collisionCount;
  }

  private remember(record: ProcessedPacket) {
    this.memory.set(record.id, record);
    if (this.memory.size > DEDUP_MEMORY_LRU_SIZE) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.memory.keys().next();
      if (!oldest.done) this.memory.delete(oldest.value);
    }
  }

  /**
   * Records a packet and reports whether it is new.
   *
   * 'collision' means the same (convId, packetId) arrived with different bytes.
   * The first valid packet is kept and the second must never be displayed.
   */
  async check(input: {
    convId: string;
    packetId: string;
    contentHash: string;
    senderId: string;
    packetTimestamp: number;
    retentionClass: RetentionClass;
  }): Promise<DedupVerdict> {
    const id = dedupKey(input.convId, input.packetId);

    const known = this.memory.get(id) ?? (this.store ? await this.store.get(id) : undefined);
    if (known) {
      if (known.contentHash !== input.contentHash) {
        this.collisionCount += 1;
        return 'collision';
      }
      return 'duplicate';
    }

    const record: ProcessedPacket = {
      id,
      convId: input.convId,
      packetId: input.packetId,
      contentHash: input.contentHash,
      senderId: input.senderId,
      packetTimestamp: input.packetTimestamp,
      firstSeenAt: Date.now(),
      retentionClass: input.retentionClass,
    };
    this.remember(record);
    if (this.store) await this.store.put(record);
    return 'new';
  }

  /** Pre-claims a locally generated packet so an echo of it is a duplicate. */
  async claim(input: {
    convId: string;
    packetId: string;
    contentHash: string;
    senderId: string;
    packetTimestamp: number;
    retentionClass: RetentionClass;
  }): Promise<void> {
    await this.check(input);
  }

  async has(convId: string, packetId: string): Promise<boolean> {
    const id = dedupKey(convId, packetId);
    if (this.memory.has(id)) return true;
    if (!this.store) return false;
    return (await this.store.get(id)) !== undefined;
  }

  /** Drops in-memory state for a room whose local history was cleared. */
  forgetConversation(convId: string): void {
    const prefix = `${convId}::`;
    for (const key of Array.from(this.memory.keys())) {
      if (key.startsWith(prefix)) this.memory.delete(key);
    }
  }
}
