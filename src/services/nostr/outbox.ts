/**
 * Durable publish queue -- implementation plan [X-09], [D-01] step 3, [A-05].
 *
 * Every publish is written to IndexedDB before the socket write, so a pending
 * send survives a reload and retries on its own. Retrying re-sends the
 * byte-identical signed event with the same packetId [T-07].
 */

import {
  PUBLISH_BACKOFF_BASE_MS,
  PUBLISH_BACKOFF_CAP_MS,
  PUBLISH_BACKOFF_JITTER,
  PUBLISH_MAX_ATTEMPTS,
} from '../v3/constants';
import { db, type OutboxRecord, type OutboxState } from '../v3/db';
import type { NostrEvent } from './nostrEvent';
import type { RelayPool } from './relayPool';

function backoffDelay(attempts: number): number {
  const base = Math.min(PUBLISH_BACKOFF_BASE_MS * 2 ** attempts, PUBLISH_BACKOFF_CAP_MS);
  const jitter = base * PUBLISH_BACKOFF_JITTER * (Math.random() * 2 - 1);
  return Math.max(1000, Math.round(base + jitter));
}

export interface OutboxChange {
  packetId: string;
  convId?: string;
  state: OutboxState;
}

export class Outbox {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private listeners = new Set<(change: OutboxChange) => void>();

  constructor(private pool: RelayPool) {}

  onChange(listener: (change: OutboxChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: OutboxChange) {
    this.listeners.forEach((l) => {
      try {
        l(change);
      } catch {
        /* a listener must never break delivery */
      }
    });
  }

  start(intervalMs = 5000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), intervalMs);
    void this.drain();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Persists then publishes. Resolves as soon as the first attempt settles;
   * a failure leaves the record queued for the background drain.
   */
  async publish(params: {
    packetId: string;
    convId?: string;
    event: NostrEvent;
    expiresAt?: number | null;
  }): Promise<OutboxState> {
    const record: OutboxRecord = {
      packetId: params.packetId,
      convId: params.convId,
      signedEvent: params.event,
      targetRelays: this.pool.getUrls(),
      acknowledgedRelays: [],
      rejectedRelays: [],
      attempts: 0,
      nextAttemptAt: Date.now(),
      expiresAt: params.expiresAt ?? null,
      state: 'pending',
      createdAt: Date.now(),
    };
    await db.saveOutbox(record);
    this.emit({ packetId: record.packetId, convId: record.convId, state: 'pending' });
    return this.attempt(record);
  }

  private async attempt(record: OutboxRecord): Promise<OutboxState> {
    const result = await this.pool.publish(record.signedEvent);
    record.attempts += 1;
    record.acknowledgedRelays = result.accepted;
    record.rejectedRelays = result.rejected.map((r) => r.url);

    if (result.quorumMet) {
      record.state = 'relayed';
      await db.saveOutbox(record);
      this.emit({ packetId: record.packetId, convId: record.convId, state: 'relayed' });
      return 'relayed';
    }

    const expired = record.expiresAt !== null && Date.now() > record.expiresAt;
    if (record.attempts >= PUBLISH_MAX_ATTEMPTS || expired) {
      record.state = 'failed';
      record.lastError = expired
        ? 'expired before reaching a relay quorum'
        : result.rejected[0]?.reason || 'no relay quorum';
      await db.saveOutbox(record);
      this.emit({ packetId: record.packetId, convId: record.convId, state: 'failed' });
      return 'failed';
    }

    record.nextAttemptAt = Date.now() + backoffDelay(record.attempts);
    record.lastError = result.rejected[0]?.reason || 'no relay quorum';
    await db.saveOutbox(record);
    return 'pending';
  }

  /** Retries everything due. Runs on a timer and on reconnect. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const due = (await db.getPendingOutbox()).filter((r) => r.nextAttemptAt <= Date.now());
      for (const record of due) await this.attempt(record);
    } catch {
      /* a drain failure is retried on the next tick */
    } finally {
      this.draining = false;
    }
  }

  /** Cancels a send that has not yet reached a relay. A relay may already hold it [A-05]. */
  async cancel(packetId: string): Promise<void> {
    await db.deleteOutbox(packetId);
  }

  async pendingCount(convId?: string): Promise<number> {
    const rows = await db.getPendingOutbox();
    return convId ? rows.filter((r) => r.convId === convId).length : rows.length;
  }

  async failedCount(convId?: string): Promise<number> {
    const rows = (await db.getOutbox()).filter((r) => r.state === 'failed');
    return convId ? rows.filter((r) => r.convId === convId).length : rows.length;
  }

  /** Puts a failed record back into the queue for a manual retry from the UI. */
  async requeue(packetId: string): Promise<void> {
    const rows = await db.getOutbox();
    const record = rows.find((r) => r.packetId === packetId);
    if (!record) return;
    record.state = 'pending';
    record.attempts = 0;
    record.nextAttemptAt = Date.now();
    await db.saveOutbox(record);
    void this.drain();
  }
}
