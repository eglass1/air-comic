/**
 * Shared Nostr relay pool -- implementation plan [X-09].
 *
 * One pool owns every WebSocket used by rooms, presence, inboxes and the
 * directory [T-01][L-14]. v2 had three subsystems independently opening sockets
 * to the same relays, and counted a socket opening as a successful publish.
 * Here only a positive OK naming the exact event id counts [T-07][O-12].
 */

import {
  PUBLISH_QUORUM,
  PUBLISH_TARGET_RELAYS,
  PUBLISH_TIMEOUT_MS,
  RELAY_RECONNECT_BASE_MS,
  RELAY_RECONNECT_MAX_MS,
} from '../v3/constants';
import type { NostrEvent, NostrFilter } from './nostrEvent';

export interface RelayHealth {
  url: string;
  /** The socket is open. Says nothing about whether the relay accepts writes. */
  connected: boolean;
  /** A recent EVENT was answered with OK true. */
  writable: boolean;
  /** A subscription has produced EOSE or events. */
  readable: boolean;
  rttMs: number | null;
  lastEventAt: number | null;
  backlog: number;
  lastError: string | null;
}

export interface PublishResult {
  eventId: string;
  accepted: string[];
  rejected: Array<{ url: string; reason: string }>;
  failed: string[];
  quorumMet: boolean;
}

export interface SubscriptionSpec {
  /** Stable id; re-subscribing with the same id replaces the previous filters. */
  id: string;
  filters: NostrFilter[];
  onEvent: (event: NostrEvent, relayUrl: string) => void;
  onEose?: (relayUrl: string) => void;
}

export interface Subscription {
  id: string;
  update(filters: NostrFilter[]): void;
  close(): void;
}

type OkWaiter = {
  eventId: string;
  resolve: (v: { url: string; ok: boolean; reason: string }) => void;
};

interface RelayConn {
  url: string;
  socket: WebSocket | null;
  health: RelayHealth;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** eventId -> waiters for that relay's OK. */
  okWaiters: Map<string, OkWaiter[]>;
  pendingSince: Map<string, number>;
  closedByUs: boolean;
}

function freshHealth(url: string): RelayHealth {
  return {
    url,
    connected: false,
    writable: false,
    readable: false,
    rttMs: null,
    lastEventAt: null,
    backlog: 0,
    lastError: null,
  };
}

export class RelayPool {
  private relays = new Map<string, RelayConn>();
  private subs = new Map<string, SubscriptionSpec>();
  private healthListeners = new Set<(health: RelayHealth[]) => void>();
  private started = false;

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  /** Hot-swappable relay set [T-01]. Adds and removes without dropping others. */
  configure(urls: string[]): void {
    this.started = true;
    const wanted = new Set(urls.filter((u) => /^wss?:\/\//i.test(u)));

    for (const [url, conn] of Array.from(this.relays.entries())) {
      if (!wanted.has(url)) {
        this.teardown(conn);
        this.relays.delete(url);
      }
    }

    for (const url of wanted) {
      if (this.relays.has(url)) continue;
      const conn: RelayConn = {
        url,
        socket: null,
        health: freshHealth(url),
        reconnectAttempts: 0,
        reconnectTimer: null,
        okWaiters: new Map(),
        pendingSince: new Map(),
        closedByUs: false,
      };
      this.relays.set(url, conn);
      this.open(conn);
    }
    this.emitHealth();
  }

  getUrls(): string[] {
    return Array.from(this.relays.keys());
  }

  getHealth(): RelayHealth[] {
    return Array.from(this.relays.values()).map((c) => ({ ...c.health }));
  }

  onHealthChange(listener: (health: RelayHealth[]) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  private emitHealth() {
    const snapshot = this.getHealth();
    this.healthListeners.forEach((l) => {
      try {
        l(snapshot);
      } catch {
        /* a listener must never break the pool */
      }
    });
  }

  // --------------------------------------------------------------------------
  // Socket lifecycle
  // --------------------------------------------------------------------------

  private open(conn: RelayConn) {
    if (!this.started || conn.closedByUs) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(conn.url);
    } catch (err) {
      conn.health.lastError = String(err);
      this.scheduleReconnect(conn);
      return;
    }
    conn.socket = socket;

    socket.onopen = () => {
      conn.reconnectAttempts = 0;
      conn.health.connected = true;
      conn.health.lastError = null;
      // Re-establish every live subscription on this relay [T-08].
      for (const spec of this.subs.values()) this.sendReq(conn, spec);
      this.emitHealth();
    };

    socket.onmessage = (event) => this.handleMessage(conn, event.data);

    socket.onerror = () => {
      conn.health.lastError = 'socket error';
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    };

    socket.onclose = () => {
      conn.socket = null;
      conn.health.connected = false;
      conn.health.writable = false;
      conn.health.readable = false;
      // Fail anything still waiting on this relay rather than leaking timers.
      for (const waiters of conn.okWaiters.values()) {
        waiters.forEach((w) => w.resolve({ url: conn.url, ok: false, reason: 'disconnected' }));
      }
      conn.okWaiters.clear();
      conn.pendingSince.clear();
      conn.health.backlog = 0;
      this.emitHealth();
      this.scheduleReconnect(conn);
    };
  }

  private scheduleReconnect(conn: RelayConn) {
    if (!this.started || conn.closedByUs || conn.reconnectTimer) return;
    const delay = Math.min(
      RELAY_RECONNECT_BASE_MS * 2 ** conn.reconnectAttempts,
      RELAY_RECONNECT_MAX_MS
    );
    conn.reconnectAttempts += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this.open(conn);
    }, delay);
  }

  private teardown(conn: RelayConn) {
    conn.closedByUs = true;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    try {
      conn.socket?.close();
    } catch {
      /* ignore */
    }
    conn.socket = null;
  }

  private send(conn: RelayConn, payload: unknown): boolean {
    const socket = conn.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      conn.health.lastError = String(err);
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Inbound
  // --------------------------------------------------------------------------

  private handleMessage(conn: RelayConn, raw: unknown) {
    if (typeof raw !== 'string') return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return;

    switch (msg[0]) {
      case 'EVENT': {
        const subId = msg[1];
        const event = msg[2] as NostrEvent;
        if (typeof subId !== 'string' || !event?.id) return;
        conn.health.readable = true;
        conn.health.lastEventAt = Date.now();
        const spec = this.subs.get(subId);
        if (spec) {
          try {
            spec.onEvent(event, conn.url);
          } catch {
            /* a handler must never break the pool */
          }
        }
        return;
      }
      case 'OK': {
        const [, eventId, accepted, reason] = msg as [string, string, boolean, string];
        if (typeof eventId !== 'string') return;
        const started = conn.pendingSince.get(eventId);
        if (started !== undefined) {
          conn.health.rttMs = Date.now() - started;
          conn.pendingSince.delete(eventId);
        }
        if (accepted === true) conn.health.writable = true;
        const waiters = conn.okWaiters.get(eventId);
        if (waiters) {
          conn.okWaiters.delete(eventId);
          conn.health.backlog = conn.okWaiters.size;
          waiters.forEach((w) =>
            w.resolve({ url: conn.url, ok: accepted === true, reason: reason ?? '' })
          );
        }
        this.emitHealth();
        return;
      }
      case 'EOSE': {
        const subId = msg[1];
        if (typeof subId !== 'string') return;
        conn.health.readable = true;
        this.subs.get(subId)?.onEose?.(conn.url);
        this.emitHealth();
        return;
      }
      case 'CLOSED': {
        // The relay refused this subscription -- commonly an unsupported kind.
        // Drop it here and keep the rest of the pool working [T-02].
        conn.health.lastError = `subscription closed: ${String(msg[2] ?? '')}`;
        this.emitHealth();
        return;
      }
      case 'NOTICE': {
        conn.health.lastError = String(msg[1] ?? '');
        this.emitHealth();
        return;
      }
      default:
        return;
    }
  }

  // --------------------------------------------------------------------------
  // Subscriptions  [T-08]
  // --------------------------------------------------------------------------

  private sendReq(conn: RelayConn, spec: SubscriptionSpec) {
    if (spec.filters.length === 0) return;
    this.send(conn, ['REQ', spec.id, ...spec.filters]);
  }

  subscribe(spec: SubscriptionSpec): Subscription {
    const existing = this.subs.get(spec.id);
    if (existing) {
      for (const conn of this.relays.values()) this.send(conn, ['CLOSE', spec.id]);
    }
    this.subs.set(spec.id, spec);
    for (const conn of this.relays.values()) this.sendReq(conn, spec);

    return {
      id: spec.id,
      update: (filters) => {
        const current = this.subs.get(spec.id);
        if (!current) return;
        current.filters = filters;
        for (const conn of this.relays.values()) {
          this.send(conn, ['CLOSE', spec.id]);
          this.sendReq(conn, current);
        }
      },
      close: () => {
        this.subs.delete(spec.id);
        for (const conn of this.relays.values()) this.send(conn, ['CLOSE', spec.id]);
      },
    };
  }

  // --------------------------------------------------------------------------
  // Publishing  [T-07]
  // --------------------------------------------------------------------------

  /**
   * Publishes to up to PUBLISH_TARGET_RELAYS and resolves once the quorum of
   * positive OKs is reached, every relay has answered, or the timeout expires.
   *
   * A socket opening is never treated as delivery, and a relay rejection is
   * recorded separately from a network failure [T-07][O-12].
   */
  async publish(
    event: NostrEvent,
    opts?: { quorum?: number; timeoutMs?: number; relays?: string[] }
  ): Promise<PublishResult> {
    const candidates = (
      opts?.relays ? opts.relays.map((u) => this.relays.get(u)) : Array.from(this.relays.values())
    ).filter((c): c is RelayConn => !!c);

    const targets = candidates.slice(0, PUBLISH_TARGET_RELAYS);
    // With a single usable relay one acknowledgment is provisionally enough,
    // and the UI is expected to show reduced redundancy [T-07].
    const quorum = opts?.quorum ?? Math.min(PUBLISH_QUORUM, Math.max(1, targets.length));
    const timeoutMs = opts?.timeoutMs ?? PUBLISH_TIMEOUT_MS;

    const accepted: string[] = [];
    const rejected: Array<{ url: string; reason: string }> = [];
    const failed: string[] = [];

    if (targets.length === 0) {
      return { eventId: event.id, accepted, rejected, failed, quorumMet: false };
    }

    await new Promise<void>((resolve) => {
      let settled = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        for (const conn of targets) {
          const waiters = conn.okWaiters.get(event.id);
          if (waiters) {
            conn.okWaiters.delete(event.id);
            conn.pendingSince.delete(event.id);
            if (!failed.includes(conn.url) && !accepted.includes(conn.url)) failed.push(conn.url);
          }
        }
        finish();
      }, timeoutMs);

      const record = (r: { url: string; ok: boolean; reason: string }) => {
        if (r.ok) accepted.push(r.url);
        else if (r.reason === 'disconnected' || r.reason === 'send failed') failed.push(r.url);
        else rejected.push({ url: r.url, reason: r.reason });

        settled += 1;
        if (accepted.length >= quorum || settled >= targets.length) finish();
      };

      for (const conn of targets) {
        const waiters = conn.okWaiters.get(event.id) ?? [];
        waiters.push({ eventId: event.id, resolve: record });
        conn.okWaiters.set(event.id, waiters);
        conn.pendingSince.set(event.id, Date.now());
        conn.health.backlog = conn.okWaiters.size;

        if (!this.send(conn, ['EVENT', event])) {
          conn.okWaiters.delete(event.id);
          conn.pendingSince.delete(event.id);
          record({ url: conn.url, ok: false, reason: 'send failed' });
        }
      }
    });

    this.emitHealth();
    return {
      eventId: event.id,
      accepted,
      rejected,
      failed,
      quorumMet: accepted.length >= quorum,
    };
  }

  /**
   * One-shot query that resolves on EOSE from every relay or a timeout.
   * Used for directory reads and history pagination [H-01].
   */
  async query(
    filters: NostrFilter[],
    opts?: { timeoutMs?: number; onEvent?: (e: NostrEvent, url: string) => void }
  ): Promise<NostrEvent[]> {
    const id = 'q-' + Math.random().toString(36).slice(2, 10);
    const seen = new Map<string, NostrEvent>();
    const timeoutMs = opts?.timeoutMs ?? PUBLISH_TIMEOUT_MS;
    const expected = this.relays.size;

    return new Promise((resolve) => {
      let eosed = 0;
      let done = false;
      const sub = this.subscribe({
        id,
        filters,
        onEvent: (event, url) => {
          if (!seen.has(event.id)) {
            seen.set(event.id, event);
            opts?.onEvent?.(event, url);
          }
        },
        onEose: () => {
          eosed += 1;
          if (eosed >= expected) finish();
        },
      });

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub.close();
        resolve(Array.from(seen.values()));
      };
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  close(): void {
    this.started = false;
    for (const conn of this.relays.values()) this.teardown(conn);
    this.relays.clear();
    this.subs.clear();
  }
}

export const relayPool = new RelayPool();
