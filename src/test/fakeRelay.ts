/**
 * In-memory NIP-01 relay and WebSocket, for integration tests.
 *
 * Lets the whole v3 stack run end to end in node: two sessions talk through a
 * shared relay set with no browser and no network. Supports the failure modes
 * [Q-04] asks about: offline, write-rejecting, and slow relays.
 */

import type { NostrEvent } from '../services/nostr/nostrEvent';

type Filter = Record<string, unknown>;

export class FakeRelay {
  public events: NostrEvent[] = [];
  public rejectWrites = false;
  public offline = false;
  public delayMs = 0;
  public publishCount = 0;

  constructor(public url: string) {}

  reset() {
    this.events = [];
    this.rejectWrites = false;
    this.offline = false;
    this.delayMs = 0;
    this.publishCount = 0;
  }

  matches(event: NostrEvent, filter: Filter): boolean {
    const kinds = filter.kinds as number[] | undefined;
    if (kinds && !kinds.includes(event.kind)) return false;
    if (typeof filter.since === 'number' && event.created_at < filter.since) return false;
    if (typeof filter.until === 'number' && event.created_at > filter.until) return false;

    for (const [key, value] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue;
      const tagName = key.slice(1);
      const wanted = value as string[];
      const has = event.tags.some((t) => t[0] === tagName && wanted.includes(t[1]));
      if (!has) return false;
    }
    return true;
  }

  /** NIP-33 replacement: newest event per (pubkey, kind, d) wins. */
  store(event: NostrEvent) {
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    if (d !== undefined) {
      const index = this.events.findIndex(
        (e) =>
          e.pubkey === event.pubkey &&
          e.kind === event.kind &&
          e.tags.find((t) => t[0] === 'd')?.[1] === d
      );
      if (index >= 0) {
        if (this.events[index].created_at > event.created_at) return;
        this.events.splice(index, 1);
      }
    }
    this.events.push(event);
  }

  /**
   * NIP-01 stored-event replay: newest first, and each filter capped by its own
   * `limit`. Replaying in insertion order shows a client a room's history in an
   * order no real relay produces, which is exactly where ordering bugs hide.
   *
   * created_at has one-second resolution, so a test writes many events in the
   * same second. Ties break on reverse insertion order -- the pessimistic
   * reading of "newest first", and the one a client must cope with anyway.
   */
  stored(filters: Filter[]): NostrEvent[] {
    const indexed = this.events.map((event, seq) => ({ event, seq }));
    indexed.sort((a, b) => b.event.created_at - a.event.created_at || b.seq - a.seq);

    const chosen = new Set<NostrEvent>();
    for (const filter of filters) {
      const limit = typeof filter.limit === 'number' ? filter.limit : Infinity;
      let taken = 0;
      for (const { event } of indexed) {
        if (taken >= limit) break;
        if (!this.matches(event, filter)) continue;
        chosen.add(event);
        taken += 1;
      }
    }

    return indexed.filter(({ event }) => chosen.has(event)).map(({ event }) => event);
  }
}

const registry = new Map<string, FakeRelay>();

/** Idempotent: relay identity must stay stable, or live sockets are orphaned. */
export function registerRelay(url: string): FakeRelay {
  const existing = registry.get(url);
  if (existing) return existing;
  const relay = new FakeRelay(url);
  registry.set(url, relay);
  return relay;
}

export function resetRelays() {
  registry.forEach((r) => r.reset());
}

export function clearRelays() {
  registry.clear();
}

const OPEN = 1;
const CLOSED = 3;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  private relay: FakeRelay | undefined;
  private subs = new Map<string, Filter[]>();

  constructor(public url: string) {
    this.relay = registry.get(url);
    queueMicrotask(() => {
      if (!this.relay || this.relay.offline) {
        this.readyState = CLOSED;
        this.onerror?.();
        this.onclose?.();
        return;
      }
      this.readyState = OPEN;
      this.onopen?.();
    });
  }

  private emit(payload: unknown) {
    const send = () => this.onmessage?.({ data: JSON.stringify(payload) });
    if (this.relay?.delayMs) setTimeout(send, this.relay.delayMs);
    else queueMicrotask(send);
  }

  send(raw: string) {
    if (this.readyState !== OPEN || !this.relay) return;
    // A relay that goes offline mid-session stops answering, as a real one does.
    if (this.relay.offline) return;
    const msg = JSON.parse(raw);

    if (msg[0] === 'EVENT') {
      const event = msg[1] as NostrEvent;
      this.relay.publishCount += 1;
      if (this.relay.rejectWrites) {
        this.emit(['OK', event.id, false, 'blocked: relay is read-only']);
        return;
      }
      this.relay.store(event);
      this.emit(['OK', event.id, true, '']);
      // Fan out to every open socket subscribed to a matching filter.
      for (const socket of sockets) {
        if (socket.relay !== this.relay || socket.readyState !== OPEN) continue;
        if (socket.relay.offline) continue;
        for (const [subId, filters] of socket.subs) {
          if (filters.some((f) => this.relay!.matches(event, f))) {
            socket.emit(['EVENT', subId, event]);
          }
        }
      }
      return;
    }

    if (msg[0] === 'REQ') {
      const [, subId, ...filters] = msg as [string, string, ...Filter[]];
      this.subs.set(subId, filters);
      for (const event of this.relay.stored(filters)) {
        this.emit(['EVENT', subId, event]);
      }
      this.emit(['EOSE', subId]);
      return;
    }

    if (msg[0] === 'CLOSE') this.subs.delete(msg[1]);
  }

  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.();
  }
}

const sockets: FakeWebSocket[] = [];

export function installFakeWebSocket() {
  const Wrapped = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  };
  (globalThis as { WebSocket?: unknown }).WebSocket = Wrapped;
}

export function closeAllSockets() {
  sockets.splice(0).forEach((s) => s.close());
}
