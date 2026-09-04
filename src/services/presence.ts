import { schnorr } from '@noble/secp256k1';
import type {
  UserProfile,
  PresencePacket,
  PresenceStatus,
  RoomInvitePayload,
  RoomInviteResponsePayload,
  SealedEnvelope,
  FriendPresence,
  QuickMessagePayload,
} from '../types';
import {
  createSignedPresence,
  verifyPresenceSignature,
  verifyRoomInviteSignature,
  verifyInviteResponseSignature,
  derivePresenceTag,
  deriveInboxTag,
  deriveNostrSecretKey,
  sealForParticipant,
  openSealedEnvelope,
} from './crypto';
import { DIRECTORY_RELAY_URLS } from './relays';

const NOSTR_KIND = 30078;
const PRESENCE_TOPIC = 'airthread-presence';
const INVITE_TOPIC = 'airthread-invite';

/**
 * Re-announce cadence. Presence is a replaceable Nostr event rather than a
 * per-peer heartbeat, so this is one small event every couple of minutes for the
 * whole friends list, not traffic that scales with the number of contacts.
 */
const PRESENCE_REPUBLISH_MS = 120000;
/** A presence announcement older than this is treated as "not here any more". */
const PRESENCE_FRESH_MS = 330000;
/** Sweep cadence for ageing out presence records. */
const PRESENCE_SWEEP_MS = 30000;
const PRESENCE_TTL_SEC = 900;
const INVITE_TTL_SEC = 7 * 24 * 60 * 60;

const RECONNECT_BASE_MS = 4000;
const RECONNECT_MAX_MS = 60000;
const MAX_RELAYS = 5;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface RelayConnection {
  url: string;
  socket: WebSocket | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface PresenceServiceCallbacks {
  onPresenceChange?: (presence: FriendPresence, previous: FriendPresence | null) => void;
  onInvite?: (invite: RoomInvitePayload) => void;
  onInviteResponse?: (response: RoomInviteResponsePayload) => void;
  onQuickMessage?: (message: QuickMessagePayload) => void;
}

/**
 * Publishes the local user's presence and delivers directly-addressed room
 * invites over Nostr relays. Both ride replaceable events, so a relay only ever
 * stores the newest announcement per (author, kind, tag) rather than a log.
 */
export class PresenceService {
  private profile: UserProfile | null = null;
  private privateKey: CryptoKey | null = null;
  private signingPrivateKey: CryptoKey | null = null;

  private nostrSecretKey: Uint8Array | null = null;
  private nostrPubHex: string = '';

  private relays: Map<string, RelayConnection> = new Map();
  private started: boolean = false;

  private myPresenceTag: string = '';
  private myInboxTag: string = '';
  private myResponseTag: string = '';
  private myQuickMsgTag: string = '';

  /** presence routing tag -> friend participantId */
  private watchedTags: Map<string, string> = new Map();
  private presenceByParticipant: Map<string, FriendPresence> = new Map();
  private handledInviteIds: Set<string> = new Set();
  private handledQuickMsgIds: Set<string> = new Set();

  private callbacks: PresenceServiceCallbacks = {};
  private republishTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private unloadHandler: (() => void) | null = null;

  public getRelayUrls(): string[] {
    return DIRECTORY_RELAY_URLS.slice(0, MAX_RELAYS);
  }

  public setCallbacks(callbacks: PresenceServiceCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public getPresence(participantId: string): FriendPresence | null {
    return this.presenceByParticipant.get(participantId) || null;
  }

  public getAllPresence(): FriendPresence[] {
    return Array.from(this.presenceByParticipant.values());
  }

  public isOnline(participantId: string): boolean {
    const presence = this.presenceByParticipant.get(participantId);
    if (!presence || presence.status === 'offline') return false;
    return Date.now() - presence.lastSeen <= PRESENCE_FRESH_MS;
  }

  public async start(
    profile: UserProfile,
    privateKey: CryptoKey,
    signingPrivateKey: CryptoKey
  ): Promise<void> {
    this.profile = profile;
    this.privateKey = privateKey;
    this.signingPrivateKey = signingPrivateKey;

    this.nostrSecretKey = await deriveNostrSecretKey(profile.signingPrivateKeyJwk);
    this.nostrPubHex = toHex(schnorr.getPublicKey(this.nostrSecretKey));

    this.myPresenceTag = await derivePresenceTag(profile.participantId);
    this.myInboxTag = await deriveInboxTag(profile.participantId);
    this.myResponseTag = this.myInboxTag + '~r';
    this.myQuickMsgTag = this.myInboxTag + '~qm';

    this.loadHandledInvites();

    if (this.started) {
      await this.publishPresence('online');
      this.resubscribeAll();
      return;
    }
    this.started = true;

    for (const url of this.getRelayUrls()) {
      const connection: RelayConnection = { url, socket: null, reconnectAttempts: 0, reconnectTimer: null };
      this.relays.set(url, connection);
      this.openRelay(connection);
    }

    this.republishTimer = setInterval(() => {
      this.publishPresence('online').catch(() => {});
    }, PRESENCE_REPUBLISH_MS);

    this.sweepTimer = setInterval(() => this.sweepStalePresence(), PRESENCE_SWEEP_MS);

    if (typeof window !== 'undefined') {
      this.unloadHandler = () => {
        // Best effort only; the freshness window is what really retires a peer.
        this.publishPresence('offline').catch(() => {});
      };
      window.addEventListener('pagehide', this.unloadHandler);
    }
  }

  /** Points the presence subscription at the current friends list. */
  public async watchFriends(participantIds: string[]): Promise<void> {
    const next = new Map<string, string>();
    for (const participantId of participantIds) {
      if (!participantId || participantId === this.profile?.participantId) continue;
      next.set(await derivePresenceTag(participantId), participantId);
    }

    const changed =
      next.size !== this.watchedTags.size ||
      Array.from(next.keys()).some((tag) => !this.watchedTags.has(tag));

    this.watchedTags = next;

    for (const participantId of Array.from(this.presenceByParticipant.keys())) {
      if (!participantIds.includes(participantId)) this.presenceByParticipant.delete(participantId);
    }

    if (changed) this.resubscribeAll();
  }

  // --------------------------------------------------------------------------
  // Publishing
  // --------------------------------------------------------------------------

  public async publishPresence(status: PresenceStatus): Promise<void> {
    if (!this.profile || !this.signingPrivateKey || !this.myPresenceTag) return;

    const packet = await createSignedPresence(
      this.profile.participantId,
      this.profile.screenName,
      this.profile.publicKeyBase64,
      this.profile.signingPublicKeyBase64,
      this.signingPrivateKey,
      status,
      this.profile.avatarName
    );

    await this.publishEvent(
      [
        ['d', this.myPresenceTag],
        ['t', PRESENCE_TOPIC],
        ['expiration', String(Math.floor(Date.now() / 1000) + PRESENCE_TTL_SEC)],
      ],
      JSON.stringify(packet)
    );
  }

  /**
   * Publishes the caller's whole outstanding invite set for one recipient as a
   * single sealed, replaceable event. Re-publishing supersedes the previous one,
   * which is exactly what a queue drained from IndexedDB needs.
   */
  public async publishInviteBundle(
    recipientParticipantId: string,
    recipientPublicKey: string,
    invites: RoomInvitePayload[]
  ): Promise<boolean> {
    if (!this.profile) return false;

    const inboxTag = await deriveInboxTag(recipientParticipantId);
    const sealed = await sealForParticipant(
      recipientParticipantId,
      recipientPublicKey,
      this.profile.participantId,
      JSON.stringify({ type: 'invite_bundle', invites })
    );

    return this.publishEvent(
      [
        ['d', inboxTag],
        ['t', INVITE_TOPIC],
        ['expiration', String(Math.floor(Date.now() / 1000) + INVITE_TTL_SEC)],
      ],
      JSON.stringify(sealed)
    );
  }

  public async publishInviteResponse(
    inviterParticipantId: string,
    inviterPublicKey: string,
    response: RoomInviteResponsePayload
  ): Promise<boolean> {
    if (!this.profile) return false;

    const responseTag = (await deriveInboxTag(inviterParticipantId)) + '~r';
    const sealed = await sealForParticipant(
      inviterParticipantId,
      inviterPublicKey,
      this.profile.participantId,
      JSON.stringify({ type: 'invite_response_bundle', responses: [response] })
    );

    return this.publishEvent(
      [
        ['d', responseTag],
        ['t', INVITE_TOPIC],
        ['expiration', String(Math.floor(Date.now() / 1000) + INVITE_TTL_SEC)],
      ],
      JSON.stringify(sealed)
    );
  }

  /** Clears a delivered invite bundle by replacing it with an empty one. */
  public async clearInviteBundle(recipientParticipantId: string, recipientPublicKey: string): Promise<void> {
    await this.publishInviteBundle(recipientParticipantId, recipientPublicKey, []);
  }

  public markInviteHandled(inviteId: string) {
    this.handledInviteIds.add(inviteId);
    this.saveHandledInvites();
  }

  public async publishQuickMessage(
    recipientParticipantId: string,
    recipientPublicKey: string,
    message: QuickMessagePayload
  ): Promise<boolean> {
    if (!this.profile) return false;

    const quickMsgTag = (await deriveInboxTag(recipientParticipantId)) + '~qm';
    const sealed = await sealForParticipant(
      recipientParticipantId,
      recipientPublicKey,
      this.profile.participantId,
      JSON.stringify(message)
    );

    return this.publishEvent(
      [
        ['d', quickMsgTag],
        ['t', 'airthread-quickmsg'],
        ['expiration', String(Math.floor(Date.now() / 1000) + 3600)],
      ],
      JSON.stringify(sealed)
    );
  }

  // --------------------------------------------------------------------------
  // Relay transport
  // --------------------------------------------------------------------------

  private openRelay(connection: RelayConnection) {
    if (!this.started) return;
    try {
      const socket = new WebSocket(connection.url);
      connection.socket = socket;

      socket.onopen = () => {
        connection.reconnectAttempts = 0;
        this.subscribe(connection);
        this.publishPresence('online').catch(() => {});
      };

      socket.onmessage = (event) => this.handleRelayMessage(event);

      socket.onerror = () => {
        try {
          socket.close();
        } catch {
          // ignore
        }
      };

      socket.onclose = () => {
        connection.socket = null;
        this.scheduleReconnect(connection);
      };
    } catch {
      this.scheduleReconnect(connection);
    }
  }

  private scheduleReconnect(connection: RelayConnection) {
    if (!this.started || connection.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** connection.reconnectAttempts, RECONNECT_MAX_MS);
    connection.reconnectAttempts += 1;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null;
      this.openRelay(connection);
    }, delay);
  }

  private send(connection: RelayConnection, payload: unknown): boolean {
    const socket = connection.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  private subscribe(connection: RelayConnection) {
    const presenceTags = Array.from(this.watchedTags.keys());

    this.send(connection, ['CLOSE', 'ac-presence']);
    if (presenceTags.length > 0) {
      this.send(connection, [
        'REQ',
        'ac-presence',
        { kinds: [NOSTR_KIND], '#d': presenceTags, limit: presenceTags.length * 2 },
      ]);
    }

    this.send(connection, ['CLOSE', 'ac-inbox']);
    if (this.myInboxTag) {
      this.send(connection, [
        'REQ',
        'ac-inbox',
        { kinds: [NOSTR_KIND], '#d': [this.myInboxTag, this.myResponseTag, this.myQuickMsgTag], limit: 50 },
      ]);
    }
  }

  private resubscribeAll() {
    for (const connection of this.relays.values()) {
      if (connection.socket?.readyState === WebSocket.OPEN) this.subscribe(connection);
    }
  }

  private async publishEvent(tags: string[][], content: string): Promise<boolean> {
    if (!this.nostrSecretKey) return false;

    const event = await this.createNostrEvent(NOSTR_KIND, tags, content);
    let delivered = false;
    for (const connection of this.relays.values()) {
      if (this.send(connection, ['EVENT', event])) delivered = true;
    }
    return delivered;
  }

  private async createNostrEvent(kind: number, tags: string[][], content: string) {
    const createdAtSec = Math.floor(Date.now() / 1000);
    const payload = [0, this.nostrPubHex, createdAtSec, kind, tags, content];

    const idBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
    const idBytes = new Uint8Array(idBuffer);
    const sigHex = toHex(await schnorr.signAsync(idBytes, this.nostrSecretKey!));

    return {
      id: toHex(idBytes),
      pubkey: this.nostrPubHex,
      created_at: createdAtSec,
      kind,
      tags,
      content,
      sig: sigHex,
    };
  }

  private handleRelayMessage(event: MessageEvent) {
    let message: any;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!Array.isArray(message) || message[0] !== 'EVENT' || !message[2]?.content) return;

    const subId = message[1];
    const nostrEvent = message[2];

    if (subId === 'ac-presence') {
      this.handlePresenceEvent(nostrEvent).catch(() => {});
    } else if (subId === 'ac-inbox') {
      this.handleInboxEvent(nostrEvent).catch(() => {});
    }
  }

  private async handlePresenceEvent(nostrEvent: any) {
    let packet: PresencePacket;
    try {
      packet = JSON.parse(nostrEvent.content);
    } catch {
      return;
    }
    if (packet?.type !== 'presence') return;
    if (!(await verifyPresenceSignature(packet))) return;

    const tag = (nostrEvent.tags || []).find((t: string[]) => t[0] === 'd')?.[1];
    if (!tag || this.watchedTags.get(tag) !== packet.participantId) return;

    const previous = this.presenceByParticipant.get(packet.participantId) || null;
    if (previous && previous.lastSeen > packet.timestamp) return;

    const isFresh = Date.now() - packet.timestamp <= PRESENCE_FRESH_MS;
    const next: FriendPresence = {
      participantId: packet.participantId,
      screenName: packet.screenName,
      avatarName: packet.avatarName,
      status: packet.status === 'offline' || !isFresh ? 'offline' : packet.status,
      lastSeen: packet.timestamp,
    };

    this.presenceByParticipant.set(packet.participantId, next);
    if (!previous || previous.status !== next.status) {
      this.callbacks.onPresenceChange?.(next, previous);
    }
  }

  private async handleInboxEvent(nostrEvent: any) {
    if (!this.privateKey) return;

    let sealed: SealedEnvelope;
    try {
      sealed = JSON.parse(nostrEvent.content);
    } catch {
      return;
    }
    if (sealed?.type !== 'sealed') return;
    if (sealed.recipientParticipantId !== this.profile?.participantId) return;

    let body: any;
    try {
      body = JSON.parse(await openSealedEnvelope(sealed, this.privateKey));
    } catch {
      // Not addressed to our current key material.
      return;
    }

    if (body?.type === 'invite_bundle' && Array.isArray(body.invites)) {
      for (const invite of body.invites as RoomInvitePayload[]) {
        if (invite?.type !== 'room_invite') continue;
        if (invite.recipientParticipantId !== this.profile.participantId) continue;
        if (invite.inviter?.participantId !== sealed.senderParticipantId) continue;
        if (this.handledInviteIds.has(invite.inviteId)) continue;
        if (!(await verifyRoomInviteSignature(invite))) continue;
        this.callbacks.onInvite?.(invite);
      }
      return;
    }

    if (body?.type === 'invite_response_bundle' && Array.isArray(body.responses)) {
      for (const response of body.responses as RoomInviteResponsePayload[]) {
        if (response?.type !== 'room_invite_response') continue;
        if (response.responderParticipantId !== sealed.senderParticipantId) continue;
        if (!(await verifyInviteResponseSignature(response))) continue;
        this.callbacks.onInviteResponse?.(response);
      }
      return;
    }

    if (body?.type === 'quick_message') {
      const qm = body as QuickMessagePayload;
      if (qm.recipientParticipantId !== this.profile.participantId) return;
      if (this.handledQuickMsgIds.has(qm.id)) return;
      this.handledQuickMsgIds.add(qm.id);
      this.callbacks.onQuickMessage?.(qm);
      return;
    }
  }

  private sweepStalePresence() {
    const now = Date.now();
    for (const [participantId, presence] of this.presenceByParticipant.entries()) {
      if (presence.status !== 'offline' && now - presence.lastSeen > PRESENCE_FRESH_MS) {
        const next: FriendPresence = { ...presence, status: 'offline' };
        this.presenceByParticipant.set(participantId, next);
        this.callbacks.onPresenceChange?.(next, presence);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Handled-invite bookkeeping (relays keep replaceable events around)
  // --------------------------------------------------------------------------

  private handledInvitesKey(): string {
    return `aircomic_handled_invites_${this.profile?.participantId || 'anon'}`;
  }

  private loadHandledInvites() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.handledInvitesKey());
      if (raw) this.handledInviteIds = new Set(JSON.parse(raw));
    } catch {
      // ignore
    }
  }

  private saveHandledInvites() {
    if (typeof localStorage === 'undefined') return;
    try {
      const recent = Array.from(this.handledInviteIds).slice(-200);
      this.handledInviteIds = new Set(recent);
      localStorage.setItem(this.handledInvitesKey(), JSON.stringify(recent));
    } catch {
      // ignore
    }
  }

  public async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    await this.publishPresence('offline').catch(() => {});

    if (this.republishTimer) clearInterval(this.republishTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.republishTimer = null;
    this.sweepTimer = null;

    if (this.unloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.unloadHandler);
      this.unloadHandler = null;
    }

    for (const connection of this.relays.values()) {
      if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
      try {
        connection.socket?.close();
      } catch {
        // ignore
      }
    }
    this.relays.clear();
    this.presenceByParticipant.clear();
  }
}

export const presenceService = new PresenceService();
