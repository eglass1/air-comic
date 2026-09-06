/**
 * airthread/3 room session -- implementation plan [X-13].
 *
 * Nostr is the authoritative transport for every room [R-01]. WebRTC, when it
 * is available, carries the byte-identical envelope as an accelerator only
 * [R-02][P-03]; nothing in this file depends on a peer being reachable.
 *
 * Gone from v2: roster gossip, state summaries/requests/chunks, the envelope
 * re-serve cache, and application-level re-flooding [H-03][W-05][O-07][O-22].
 */

import {
  importPrivateKeyFromJwk,
  importRawAesKey,
  importSigningPrivateKeyFromJwk,
  normalizePublicKey,
} from '../crypto';
import { relayPool } from '../nostr/relayPool';
import { Outbox } from '../nostr/outbox';
import {
  buildNostrEvent,
  replaceableTags,
  roomPacketTags,
  tagValue,
  type NostrEvent,
} from '../nostr/nostrEvent';
import { historyFilters, roomFilters, dTagFilters } from '../nostr/subscriptions';
import {
  CHAT_RETENTION_SEC,
  D_GENESIS_PREFIX,
  D_METADATA_PREFIX,
  JOIN_REQUEST_MAX_ATTEMPTS,
  JOIN_REQUEST_RETRY_MS,
  LIVE_PAST_WINDOW_MS,
  MAX_CHAT_TEXT_BYTES,
  OLD_ROUTE_MONITOR_MS,
  PUBLIC_KEY_ID,
  PUBLIC_PRESENCE_REFRESH_MS,
  ROOT_KEY_ID,
  T_ROOM_PACKET,
  WEBRTC_MEMBER_THRESHOLD,
} from './constants';
import { db as defaultDb, type ConversationRecord, type DatabaseService, type UserProfile } from './db';
import { DedupLedger } from './dedup';
import {
  buildEnvelope,
  openEnvelope,
  verifyEnvelope,
  type EnvelopeVerifyResult,
} from './envelope';
import {
  adoptGenesis,
  applyCapabilityRotation,
  applyRekey,
  chainHead,
  createChainState,
  currentMembers,
  deserializeChain,
  isMember,
  membersAt,
  serializeChain,
  type ChainState,
} from './epochChain';
import {
  derivePrivateRoutingTag,
  derivePublicRoomId,
  deriveRoomFingerprint,
  deriveRootControlKey,
  deriveScopedNostrSecretKey,
  generateEpochKey,
  generateRoomSecret,
  makeEpochKeyId,
} from './keys';
import {
  buildCapabilityRotation,
  buildGenesis,
  buildJoinDecision,
  buildJoinRequest,
  buildMessagePayload,
  buildRekey,
  buildRoomMetadata,
  openRekeySlot,
  openRotationSlot,
  verifyCapabilityRotation,
  verifyGenesis,
  verifyJoinDecision,
  verifyJoinRequest,
  verifyMessagePayload,
  verifyRekey,
  verifyRoomMetadata,
} from './packets';
import { byteLength } from './validate';
import {
  buildPublicRoomDescriptor,
  directoryService,
  occupancyBucket,
  PublicRoomPresenceBeacon,
} from './directory';
import { accelerator } from './accelerator';
import type {
  AccelerationStatus,
  CapabilityRotationPacket,
  ChatMessage,
  JoinDecisionPacket,
  JoinRequestPacket,
  KeyRecord,
  MessagePayload,
  Participant,
  PacketClass,
  PendingJoinRequest,
  PublicRoomDescriptorPacket,
  RekeyPacket,
  RoomGenesisPacket,
  RoomMetadataPacket,
  RoomMode,
  SendState,
} from './types';

const outbox = new Outbox(relayPool);
outbox.start();

/** Per-database outbox, so isolated profiles do not share a publish queue. */
const outboxes = new Map<DatabaseService, Outbox>();
function outboxFor(database: DatabaseService): Outbox {
  if (database === defaultDb) return outbox;
  let existing = outboxes.get(database);
  if (!existing) {
    existing = new Outbox(relayPool, database);
    existing.start();
    outboxes.set(database, existing);
  }
  return existing;
}

export interface RoomSessionConfig {
  tabId: string;
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string;
  publicJoinToken?: string;
  isInitialCreator?: boolean;
  channelTitle?: string;
  /** Injectable so tests can run isolated profiles against one relay set. */
  database?: DatabaseService;
}

export interface RoomSessionCallbacks {
  onStateChange?: (session: RoomSession) => void;
  onNewMessage?: (session: RoomSession, message: ChatMessage) => void;
}

export class RoomSession {
  // --- Identity of the room -------------------------------------------------
  public tabId: string;
  public convId: string;
  public roomMode: RoomMode;
  public roomSecret: string;
  public publicJoinToken: string | null;
  public publicRoomId: string | null;
  public isInitialCreator: boolean;
  public channelTitle: string;
  public routingTag = '';
  public capabilityGeneration = 0;

  // --- Observable state -----------------------------------------------------
  /** Nostr connectivity only. Acceleration is reported separately [W-04]. */
  public connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'error' = 'connecting';
  public accelerationStatus: AccelerationStatus = 'unavailable';
  public connectedPeersCount = 0;
  public participantsMap: Map<string, Participant> = new Map();
  /**
   * A snapshot of `participantsMap`, replaced whenever the map changes. React
   * reads this: the map is mutated in place, so its identity says nothing about
   * whether a name, avatar or status moved.
   */
  public participants: Participant[] = [];
  public messages: ChatMessage[] = [];
  public activeKeyId: string = ROOT_KEY_ID;
  public activeEpoch = 0;
  public isApproved = false;
  public isRekeying = false;
  public roomFingerprint = '';
  public pendingJoinRequests: PendingJoinRequest[] = [];
  public isSecretMissing = false;
  /** A public room answers to its directory listing's creator alone [PU-02]. */
  public publicRoomCreatorId: string | null = null;
  public pendingSendCount = 0;
  public failedSendCount = 0;
  public collisions = 0;
  public isForeground = false;
  /** Public rooms only. Approximate by construction [PU-04]. */
  public approximateOccupancy: string | null = null;

  // --- Internals ------------------------------------------------------------
  private profile: UserProfile | null = null;
  private privateKey: CryptoKey | null = null;
  private signingPrivateKey: CryptoKey | null = null;
  private nostrSecretKey: Uint8Array | null = null;
  private rootKey: CryptoKey | null = null;
  private keysMap: Map<string, KeyRecord> = new Map();
  private chain: ChainState;
  private genesis: RoomGenesisPacket | null = null;
  /** Timestamp of the newest room_metadata we have applied [M-01]. */
  private titleUpdatedAt = 0;
  /** A title that arrived before there was a chain to judge its author by. */
  private pendingMetadata: RoomMetadataPacket | null = null;
  private dedup: DedupLedger;

  private subscription: { close(): void; update(f: unknown[]): void } | null = null;
  private oldRouteSubscription: { close(): void } | null = null;
  private joinRetryTimer: ReturnType<typeof setInterval> | null = null;
  private joinRequestAttempts = 0;
  private pendingRequestsMap: Map<string, PendingJoinRequest> = new Map();
  private declinedRequesters = new Set<string>();
  private autoApproveIds = new Set<string>();
  private previousRoutes: ConversationRecord['previousRoutingTags'] = [];
  /**
   * Control packets that verified but could not yet be linked into the chain
   * because their parent (or genesis) has not arrived. Relay history has no
   * guaranteed order, and dedup has already recorded them, so without this they
   * would be dropped permanently.
   */
  private orphanControl: Array<RekeyPacket | CapabilityRotationPacket> = [];
  private unsubHealth: (() => void) | null = null;
  private unsubOutbox: (() => void) | null = null;
  private publicDescriptor: PublicRoomDescriptorPacket | null = null;
  private beacon: PublicRoomPresenceBeacon | null = null;
  private occupancyTimer: ReturnType<typeof setInterval> | null = null;

  private isDestroyed = false;
  private isInitialized = false;
  private callbacks: RoomSessionCallbacks;
  private db: DatabaseService;
  private outbox: Outbox;

  constructor(config: RoomSessionConfig, callbacks: RoomSessionCallbacks = {}) {
    this.tabId = config.tabId;
    this.convId = config.convId;
    this.roomMode = config.roomMode;
    this.roomSecret = config.roomSecret || '';
    this.publicJoinToken = config.publicJoinToken || null;
    this.publicRoomId = null;
    this.isInitialCreator = config.isInitialCreator ?? false;
    this.channelTitle = config.channelTitle || 'Untitled';
    this.callbacks = callbacks;
    this.db = config.database ?? defaultDb;
    this.outbox = outboxFor(this.db);
    this.dedup = new DedupLedger({
      get: (id) => this.db.getProcessed(id),
      put: (record) => this.db.putProcessed(record),
    });
    this.chain = createChainState(this.convId);

    if (this.roomMode === 'private' && !this.roomSecret) this.isSecretMissing = true;
  }

  // --------------------------------------------------------------------------
  // Public surface
  // --------------------------------------------------------------------------

  get inviteUrl(): string {
    if (typeof window === 'undefined') return '';
    const base = `${window.location.origin}${window.location.pathname}`;
    if (this.roomMode === 'public') {
      return `${base}?id=${encodeURIComponent(this.convId)}&public=1&join=${encodeURIComponent(
        this.publicJoinToken || ''
      )}`;
    }
    return this.roomSecret
      ? `${base}?id=${encodeURIComponent(this.convId)}#secret=${encodeURIComponent(this.roomSecret)}`
      : `${base}?id=${encodeURIComponent(this.convId)}`;
  }

  get memberCount(): number {
    return this.roomMode === 'public' ? this.participantsMap.size : currentMembers(this.chain).length;
  }

  /** 20 is a WebRTC threshold, never a cap on the room [L-17]. */
  get acceleratorEligible(): boolean {
    return (
      this.roomMode === 'private' &&
      this.isForeground &&
      this.isApproved &&
      this.memberCount <= WEBRTC_MEMBER_THRESHOLD
    );
  }

  private notify() {
    if (!this.isDestroyed) this.callbacks.onStateChange?.(this);
  }

  /** Call after every write to `participantsMap`, so the snapshot keeps up. */
  private commitParticipants() {
    this.participants = Array.from(this.participantsMap.values());
  }

  // --------------------------------------------------------------------------
  // Initialisation
  // --------------------------------------------------------------------------

  async init(profile: UserProfile): Promise<void> {
    if (this.isDestroyed || this.isInitialized) return;
    this.isInitialized = true;
    this.profile = profile;
    this.privateKey = await importPrivateKeyFromJwk(profile.privateKeyJwk);
    this.signingPrivateKey = await importSigningPrivateKeyFromJwk(profile.signingPrivateKeyJwk);

    const stored = await this.db.getConversation(this.convId);
    if (stored) {
      if (stored.roomSecret && !this.roomSecret) this.roomSecret = stored.roomSecret;
      if (stored.publicJoinToken && !this.publicJoinToken) {
        this.publicJoinToken = stored.publicJoinToken;
      }
      this.capabilityGeneration = stored.capabilityGeneration;
      this.previousRoutes = stored.previousRoutingTags ?? [];
      this.channelTitle = stored.channelTitle || this.channelTitle;
      this.titleUpdatedAt = stored.titleUpdatedAt ?? 0;
      this.publicRoomCreatorId = stored.publicRoomCreatorId ?? null;
      if (stored.isCreator) this.isInitialCreator = true;
    }

    if (this.roomMode === 'private' && !this.roomSecret) {
      this.isSecretMissing = true;
      this.connectionStatus = 'error';
      this.notify();
      return;
    }
    this.isSecretMissing = false;

    this.addSelfParticipant();
    await this.deriveRoute();
    await this.restoreLocalState();

    this.messages = await this.db.getMessages(this.convId);

    this.unsubHealth = relayPool.onHealthChange(() => this.refreshConnectionStatus());
    this.unsubOutbox = this.outbox.onChange((change) => {
      if (change.convId !== this.convId) return;
      void this.refreshSendCounts();
      const message = this.messages.find((m) => m.id === change.packetId);
      if (message && message.sendState !== change.state) {
        const updated = { ...message, sendState: change.state };
        this.messages = this.messages.map((m) => (m.id === updated.id ? updated : m));
        void this.db.saveMessage(updated);
        this.notify();
      }
    });

    await this.subscribeRoom();
    this.refreshConnectionStatus();

    if (this.roomMode === 'private') {
      if (this.isInitialCreator && !this.genesis) {
        await this.createRoom();
      } else if (!this.isApproved) {
        this.startJoinRetry();
        void this.sendJoinRequest();
      }
      this.watchPreviousRoutes();
    } else {
      // Public rooms have no join request, epoch, rekey or roster [PU-05].
      await this.persistConversation();
      await this.startOccupancy();
      // Only then go and ask the directory who owns the room -- the room is
      // usable while that query is in flight.
      await this.loadPublicRoomAuthority();
      if (this.isInitialCreator) await this.publishRoomMetadata();
    }

    // Anchor the chain before replaying history: without genesis, every rekey
    // is unvalidatable and would be buffered rather than applied [L-05].
    if (this.roomMode === 'private') await this.fetchGenesis();
    await this.catchUpHistory();
    // The room's own name, so a member who arrived by link shows what everyone
    // else shows instead of inventing one locally [M-01].
    await this.fetchRoomMetadata();
    this.notify();
  }

  /**
   * Announces our presence in a public room and tracks the approximate count.
   * The beacon carries no identity beyond a room-scoped pseudonym [PU-04][L-09].
   */
  private async startOccupancy(): Promise<void> {
    if (this.roomMode !== 'public' || !this.profile || !this.publicRoomId) return;

    this.beacon = new PublicRoomPresenceBeacon();
    await this.beacon.start(this.profile.signingPrivateKeyJwk, this.publicRoomId);

    const refresh = async () => {
      if (!this.publicRoomId) return;
      const counts = await directoryService.fetchOccupancy([this.publicRoomId]);
      const next = occupancyBucket(counts.get(this.publicRoomId) ?? 0);
      if (next !== this.approximateOccupancy) {
        this.approximateOccupancy = next;
        this.notify();
      }
    };
    void refresh();
    this.occupancyTimer = setInterval(() => void refresh(), PUBLIC_PRESENCE_REFRESH_MS);
  }

  /**
   * Establishes who may rename this public room. The directory descriptor is
   * signed by a key only the creator holds, so the identity it names is the
   * one authority a room with no roster has [PU-02].
   */
  private async loadPublicRoomAuthority(): Promise<void> {
    if (this.roomMode !== 'public' || !this.profile) return;

    if (this.isInitialCreator) this.publicRoomCreatorId = this.profile.participantId;
    if (!this.publicRoomId) return;

    const descriptor = await directoryService.fetchRoom(this.publicRoomId);
    if (!descriptor || descriptor.convId !== this.convId) return;

    this.publicDescriptor = descriptor;
    this.publicRoomCreatorId = descriptor.creatorId;
    await this.persistConversation();
    this.notify();
  }

  /** True when this identity is allowed to rename the room [PU-02][M-01]. */
  get canRenameRoom(): boolean {
    if (this.roomMode === 'private') return this.isApproved;
    return (
      this.publicRoomCreatorId !== null &&
      this.publicRoomCreatorId === this.profile?.participantId
    );
  }

  /**
   * Keeps the directory listing and the room title the same thing. Only the
   * creator can do this at all -- the descriptor's Nostr key is derived from
   * their signing key, so nobody else's republish would replace it.
   */
  private async republishPublicDescriptor(name: string): Promise<void> {
    const previous = this.publicDescriptor;
    if (!previous || !this.profile || !this.signingPrivateKey) return;
    if (previous.creatorId !== this.profile.participantId) return;

    const descriptor = await buildPublicRoomDescriptor({
      publicRoomId: previous.publicRoomId,
      convId: previous.convId,
      publicJoinToken: previous.publicJoinToken,
      name,
      description: previous.description,
      creatorId: previous.creatorId,
      creatorScreenName: previous.creatorScreenName,
      creatorSigningPublicKey: previous.creatorSigningPublicKey,
      signingPrivateKey: this.signingPrivateKey,
      relayUrls: previous.relayUrls,
      language: previous.language,
      tags: previous.tags,
      historyPolicy: previous.historyPolicy,
      createdAt: previous.createdAt,
    });

    this.publicDescriptor = descriptor;
    await directoryService.publishDescriptor({
      descriptor,
      signingPrivateKeyJwk: this.profile.signingPrivateKeyJwk,
    });
  }

  private addSelfParticipant() {
    if (!this.profile) return;
    this.participantsMap.set(this.profile.participantId, {
      participantId: this.profile.participantId,
      publicKey: normalizePublicKey(this.profile.publicKeyBase64),
      signingPublicKey: normalizePublicKey(this.profile.signingPublicKeyBase64),
      screenName: this.profile.screenName,
      avatarName: this.profile.avatarName || 'Armando',
      contactInfo: this.profile.contactInfo,
      lastSeen: Date.now(),
      isSelf: true,
      status: 'online',
      isApproved: this.isApproved,
    });
    this.commitParticipants();
  }

  /**
   * Adopts an edited profile without tearing the room down. A rename or a new
   * avatar has to reach the roster and everything we sign from here on;
   * different key material is a different member, so that re-initialises.
   */
  async applyProfile(profile: UserProfile): Promise<void> {
    if (!this.profile || this.isDestroyed) return;

    if (profile.participantId !== this.profile.participantId) {
      this.isInitialized = false;
      this.subscription?.close();
      this.subscription = null;
      this.beacon?.stop();
      this.beacon = null;
      if (this.occupancyTimer) clearInterval(this.occupancyTimer);
      this.occupancyTimer = null;
      this.participantsMap.clear();
      this.commitParticipants();
      await this.init(profile);
      return;
    }

    this.profile = profile;
    this.addSelfParticipant();
    this.notify();
  }

  /** Recomputes every route-dependent value from the current room secret. */
  private async deriveRoute(): Promise<void> {
    if (!this.profile) return;

    if (this.roomMode === 'public') {
      this.publicRoomId = await derivePublicRoomId(this.convId, this.publicJoinToken || '');
      this.routingTag = this.publicRoomId;
      this.activeKeyId = PUBLIC_KEY_ID;
      this.activeEpoch = 0;
      this.isApproved = true;
    } else {
      this.routingTag = await derivePrivateRoutingTag(this.roomSecret, this.convId);
      this.rootKey = await deriveRootControlKey(this.roomSecret, this.convId);
    }

    this.roomFingerprint = await deriveRoomFingerprint(this.routingTag);
    this.nostrSecretKey = await deriveScopedNostrSecretKey(
      this.profile.signingPrivateKeyJwk,
      this.routingTag
    );
  }

  private async restoreLocalState(): Promise<void> {
    if (this.roomMode !== 'private' || !this.profile) return;

    const storedChain = await this.db.getChain(this.convId);
    if (storedChain) this.chain = deserializeChain(storedChain);

    for (const record of await this.db.getEpochKeys(this.convId)) {
      try {
        this.keysMap.set(record.keyId, {
          keyId: record.keyId,
          epoch: record.epoch,
          createdAt: record.savedAt,
          key: await importRawAesKey(record.rawBase64Url),
          rawBase64Url: record.rawBase64Url,
          parentKeyId: record.parentKeyId,
          signerId: record.signerId,
          members: record.members,
        });
      } catch {
        /* a key that no longer imports is simply unavailable */
      }
    }

    const head = chainHead(this.chain);
    if (head) {
      this.activeKeyId = head.keyId;
      this.activeEpoch = head.epoch;
      this.isApproved = head.members.includes(this.profile.participantId);
      this.syncParticipantApproval();
    }
  }

  // --------------------------------------------------------------------------
  // Room creation  [PR-01]
  // --------------------------------------------------------------------------

  /**
   * Publishes genesis and opens epoch 1 with the creator as sole member. The
   * root key is control-only and is never a chat content key, so a creator
   * talking before anyone joins is not writing under a key every future
   * secret-holder can read -- closing v2 [O-03].
   */
  private async createRoom(): Promise<void> {
    if (!this.profile || !this.signingPrivateKey) return;

    const genesis = await buildGenesis({
      convId: this.convId,
      creatorId: this.profile.participantId,
      creatorSigningPublicKey: this.profile.signingPublicKeyBase64,
      creatorScreenName: this.profile.screenName,
      signingPrivateKey: this.signingPrivateKey,
    });

    this.genesis = genesis;
    adoptGenesis(this.chain, genesis);
    await this.recordChainPacket(genesis.packetId, 0, genesis);
    await this.publishControl(genesis, genesis.packetId, {
      dTag: D_GENESIS_PREFIX + this.routingTag,
    });

    const opened = await this.rekeyTo({
      action: 'genesis_epoch',
      members: [this.profile.participantId],
      parentPacketId: genesis.packetId,
      parentKeyId: ROOT_KEY_ID,
      epoch: 1,
    });

    if (!opened) {
      // [PR-01]: sending is disabled rather than falling back to the root key.
      this.connectionStatus = 'error';
      this.notify();
      return;
    }

    // Without this the room has no name anyone else can discover, and every
    // joiner falls back to a locally generated one [M-01].
    await this.publishRoomMetadata();
    await this.persistConversation(true);
  }

  private async persistConversation(isCreator = this.isInitialCreator): Promise<void> {
    await this.db.saveConversation({
      convId: this.convId,
      roomMode: this.roomMode,
      roomSecret: this.roomMode === 'private' ? this.roomSecret : undefined,
      publicJoinToken: this.publicJoinToken ?? undefined,
      publicRoomId: this.publicRoomId ?? undefined,
      routingTag: this.routingTag,
      capabilityGeneration: this.capabilityGeneration,
      previousRoutingTags: this.previousRoutes,
      activeEpoch: this.activeEpoch,
      activeKeyId: this.activeKeyId,
      isCreator,
      channelTitle: this.channelTitle,
      titleUpdatedAt: this.titleUpdatedAt,
      publicRoomCreatorId: this.publicRoomCreatorId ?? undefined,
      historyPolicy: this.genesis?.historyPolicy ?? 'from_admission',
      metadataPolicy: this.genesis?.metadataPolicy ?? 'members',
      genesisPacketId: this.genesis?.packetId,
      updatedAt: Date.now(),
    });
  }

  // --------------------------------------------------------------------------
  // Publishing
  // --------------------------------------------------------------------------

  private get contentKey(): CryptoKey | null {
    if (this.roomMode === 'public') return null;
    return this.keysMap.get(this.activeKeyId)?.key ?? null;
  }

  /**
   * Builds, persists and publishes one envelope. The serialized string is
   * produced once and reused, so the WebRTC copy cannot hash differently [G-06].
   */
  private async publishEnvelope(params: {
    payload: unknown;
    packetClass: PacketClass;
    packetId?: string;
    keyId: string;
    contentKey: CryptoKey | null;
    dTag?: string;
    expirationSec?: number | undefined;
  }): Promise<{ packetId: string; serialized: string; state: SendState } | null> {
    if (!this.profile || !this.signingPrivateKey || !this.nostrSecretKey) return null;

    const built = await buildEnvelope({
      convId: this.convId,
      packetId: params.packetId,
      roomMode: this.roomMode,
      packetClass: params.packetClass,
      keyId: params.keyId,
      senderId: this.profile.participantId,
      senderSigningPublicKey: this.profile.signingPublicKeyBase64,
      signingPrivateKey: this.signingPrivateKey,
      payload: params.payload,
      contentKey: params.contentKey ?? undefined,
    });

    // Claim our own packet so an echo from any transport is a duplicate.
    await this.dedup.claim({
      convId: this.convId,
      packetId: built.envelope.packetId,
      contentHash: built.contentHash,
      senderId: this.profile.participantId,
      packetTimestamp: built.envelope.timestamp,
      retentionClass: params.packetClass === 'chat' ? 'chat' : 'control',
    });

    const event = await buildNostrEvent({
      secretKey: this.nostrSecretKey,
      tags: params.dTag
        ? replaceableTags({
            d: params.dTag,
            topic: T_ROOM_PACKET,
            expirationSec: params.expirationSec,
            extra: [['r', this.routingTag], ['m', this.roomMode]],
          })
        : roomPacketTags({
            packetId: built.envelope.packetId,
            routingTag: this.routingTag,
            roomMode: this.roomMode,
            topic: T_ROOM_PACKET,
            expirationSec: params.expirationSec,
          }),
      content: built.serialized,
    });

    const state = await this.outbox.publish({
      packetId: built.envelope.packetId,
      convId: this.convId,
      event,
    });

    void this.refreshSendCounts();
    return { packetId: built.envelope.packetId, serialized: built.serialized, state };
  }

  /** Control packets carry no expiration so the chain stays rebuildable [L-05][L-06]. */
  private async publishControl(
    payload: unknown,
    packetId?: string,
    opts?: { dTag?: string }
  ): Promise<boolean> {
    const key = this.roomMode === 'public' ? null : this.rootKey;
    if (this.roomMode === 'private' && !key) return false;
    const result = await this.publishEnvelope({
      payload,
      packetClass: 'control',
      packetId,
      keyId: this.roomMode === 'public' ? PUBLIC_KEY_ID : ROOT_KEY_ID,
      contentKey: key,
      dTag: opts?.dTag,
      expirationSec: undefined,
    });
    return result !== null;
  }

  private async refreshSendCounts(): Promise<void> {
    const [pending, failed] = await Promise.all([
      this.outbox.pendingCount(this.convId),
      this.outbox.failedCount(this.convId),
    ]);
    if (pending !== this.pendingSendCount || failed !== this.failedSendCount) {
      this.pendingSendCount = pending;
      this.failedSendCount = failed;
      this.notify();
    }
  }

  // --------------------------------------------------------------------------
  // Subscription and receive
  // --------------------------------------------------------------------------

  private async subscribeRoom(): Promise<void> {
    this.subscription?.close();
    const cursors = await this.db.getCursorsForTag(this.routingTag);
    const since = cursors.length
      ? Math.min(...cursors.map((c) => c.lastCommittedTimestamp))
      : undefined;

    this.subscription = relayPool.subscribe({
      id: `room-${this.tabId}`,
      filters: roomFilters([this.routingTag], since),
      onEvent: (event, relayUrl) => void this.handleNostrEvent(event, relayUrl),
    });
  }

  /**
   * Keeps a read-only watch on routes we have rotated away from, purely so an
   * offline member can still collect the capability-rotation packet [PR-07].
   * No chat is accepted there.
   */
  private watchPreviousRoutes(): void {
    this.oldRouteSubscription?.close();
    const live = this.previousRoutes.filter((r) => r.until > Date.now());
    this.previousRoutes = live;
    if (live.length === 0) return;

    this.oldRouteSubscription = relayPool.subscribe({
      id: `room-old-${this.tabId}`,
      filters: roomFilters(live.map((r) => r.routingTag)),
      onEvent: (event) => void this.handleOldRouteEvent(event),
    });
  }

  private async handleNostrEvent(event: NostrEvent, relayUrl: string): Promise<void> {
    if (this.isDestroyed) return;
    if (tagValue(event, 'r') !== this.routingTag) return;

    const result = await verifyEnvelope(event.content, {
      convId: this.convId,
      roomMode: this.roomMode,
    });
    if (!result.ok) return;

    await this.acceptEnvelope(result, false);

    await this.db.saveCursor({
      relayUrl,
      routingTag: this.routingTag,
      lastCommittedTimestamp: event.created_at * 1000,
      lastEventId: event.id,
    });
  }

  /** On a rotated-away route, only a capability rotation is meaningful. */
  private async handleOldRouteEvent(event: NostrEvent): Promise<void> {
    const route = this.previousRoutes.find((r) => r.routingTag === tagValue(event, 'r'));
    if (!route) return;

    const result = await verifyEnvelope(event.content, {
      convId: this.convId,
      roomMode: 'private',
    });
    if (!result.ok || !result.envelope) return;

    try {
      const oldRoot = await deriveRootControlKey(route.roomSecret, this.convId);
      const payload = (await openEnvelope(result.envelope, oldRoot)) as { type?: string } | null;
      if (payload?.type === 'capability_rotation') {
        await this.handleCapabilityRotation(payload as CapabilityRotationPacket);
      }
    } catch {
      /* an unopenable packet on a dead route is expected */
    }
  }

  /**
   * The receive pipeline shared by both transports [P-03]. Steps 8-10 of the
   * mandatory order [X-03]: dedup, authorize, then decrypt.
   */
  async acceptEnvelope(result: EnvelopeVerifyResult, viaAccelerator: boolean): Promise<void> {
    const envelope = result.envelope;
    if (!envelope || !result.contentHash) return;

    const retentionClass = envelope.packetClass === 'chat' ? 'chat' : 'control';
    const verdict = await this.dedup.check({
      convId: this.convId,
      packetId: envelope.packetId,
      contentHash: result.contentHash,
      senderId: envelope.senderId,
      packetTimestamp: envelope.timestamp,
      retentionClass,
    });

    if (verdict === 'collision') {
      this.collisions = this.dedup.collisions;
      this.notify();
      return;
    }
    if (verdict === 'duplicate') return;

    // Chat is authorized against the membership epoch in force when it was
    // sent [M-02]; control packets carry their own authority rules.
    if (this.roomMode === 'private' && envelope.packetClass === 'chat') {
      if (!membersAt(this.chain, envelope.timestamp).includes(envelope.senderId)) return;
    }

    const key =
      this.roomMode === 'public'
        ? null
        : this.keysMap.get(envelope.keyId)?.key ??
          (envelope.keyId === ROOT_KEY_ID ? this.rootKey : null);

    if (this.roomMode === 'private' && !key) return;

    const payload = (await openEnvelope(envelope, key)) as
      | { type?: string; [k: string]: unknown }
      | null;
    if (!payload?.type) return;

    switch (payload.type) {
      case 'message':
        await this.handleMessage(payload as unknown as MessagePayload, envelope.keyId, viaAccelerator);
        break;
      case 'room_genesis':
        await this.handleGenesis(payload as unknown as RoomGenesisPacket);
        break;
      case 'key':
        await this.handleRekey(payload as unknown as RekeyPacket);
        break;
      case 'capability_rotation':
        await this.handleCapabilityRotation(payload as unknown as CapabilityRotationPacket);
        break;
      case 'join_request':
        await this.handleJoinRequest(payload as unknown as JoinRequestPacket);
        break;
      case 'join_decision':
        await this.handleJoinDecision(payload as unknown as JoinDecisionPacket);
        break;
      case 'room_metadata':
        await this.handleMetadata(payload as unknown as RoomMetadataPacket);
        break;
      default:
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Packet handlers
  // --------------------------------------------------------------------------

  private async handleMessage(
    payload: MessagePayload,
    keyId: string,
    isBackfill: boolean
  ): Promise<void> {
    if (payload.convId !== this.convId) return;
    if (byteLength(payload.text ?? '') > MAX_CHAT_TEXT_BYTES) return;
    // Signed in both modes now, closing v2 [O-02].
    if (!(await verifyMessagePayload(payload))) return;

    const isSelf = payload.senderId === this.profile?.participantId;
    const message: ChatMessage = {
      id: payload.msgId,
      convId: this.convId,
      senderId: payload.senderId,
      sender: {
        screenName: payload.sender.screenName,
        avatarName: payload.sender.avatarName,
        signingPublicKey: payload.senderSigningPublicKey,
        contactInfo: payload.sender.contactInfo,
      },
      timestamp: payload.timestamp,
      text: payload.text,
      keyId,
      keyEpoch: this.keysMap.get(keyId)?.epoch,
      isSelf,
      emotion: payload.emotion,
      emotionIntensity: payload.emotionIntensity,
      balloonMode: payload.balloonMode,
      sendState: 'relayed',
    };

    this.trackParticipantFromMessage(payload);
    this.insertMessage(message, isBackfill);
  }

  /**
   * A rekey is the first thing a newly admitted member hears, and it names who
   * admitted them. Without this the roster shows nobody but yourself until
   * somebody happens to speak, even though the chain already says who is here.
   */
  private trackParticipantsFromRekey(packet: RekeyPacket) {
    const selfId = this.profile?.participantId;
    let changed = false;

    const remember = (
      participantId: string,
      options: {
        screenName?: string;
        avatarName?: string;
        signingKey?: string;
        active?: boolean;
      }
    ) => {
      if (!participantId || participantId === selfId) return;
      const existing = this.participantsMap.get(participantId);
      const name = options.screenName?.trim() || existing?.screenName || 'Anonymous';
      // Whoever the packet names is drawn as themselves straight away; the
      // default character is for someone we genuinely have not met yet.
      const avatar = options.avatarName?.trim() || existing?.avatarName || 'Armando';
      const signing = options.signingKey
        ? normalizePublicKey(options.signingKey)
        : existing?.signingPublicKey ?? '';
      // Membership is not evidence of being online; acting just now is.
      const status: Participant['status'] = options.active
        ? 'online'
        : existing?.status ?? 'offline';
      const approved = packet.members.includes(participantId);

      if (
        existing &&
        existing.screenName === name &&
        existing.avatarName === avatar &&
        existing.signingPublicKey === signing &&
        existing.status === status &&
        existing.isApproved === approved
      ) {
        return;
      }

      this.participantsMap.set(participantId, {
        participantId,
        // The packet wraps a key to each member but carries nobody's public
        // key, so this stays empty until they introduce themselves.
        publicKey: existing?.publicKey ?? '',
        signingPublicKey: signing,
        screenName: name,
        avatarName: avatar,
        contactInfo: existing?.contactInfo,
        lastSeen: options.active ? packet.timestamp : existing?.lastSeen ?? packet.timestamp,
        isSelf: false,
        status,
        isApproved: approved,
      });
      changed = true;
    };

    // The rest are known to be here, but not by name and not necessarily now.
    packet.members.forEach((id) => remember(id, {}));
    // These two are the only identities a rekey actually names.
    remember(packet.signerId, {
      screenName: packet.signerScreenName,
      avatarName: packet.signerAvatarName,
      signingKey: packet.signerSigningPublicKey,
      active: true,
    });
    if (packet.targetParticipantId) {
      remember(packet.targetParticipantId, {
        screenName: packet.targetScreenName,
        avatarName: packet.targetAvatarName,
        active: true,
      });
    }

    if (changed) this.commitParticipants();
  }

  private trackParticipantFromMessage(payload: MessagePayload) {
    if (payload.senderId === this.profile?.participantId) return;
    const existing = this.participantsMap.get(payload.senderId);
    this.participantsMap.set(payload.senderId, {
      participantId: payload.senderId,
      publicKey: existing?.publicKey ?? '',
      signingPublicKey: payload.senderSigningPublicKey,
      screenName: payload.sender.screenName?.trim() || existing?.screenName || 'Anonymous',
      avatarName: payload.sender.avatarName || existing?.avatarName || 'Armando',
      contactInfo: payload.sender.contactInfo ?? existing?.contactInfo,
      lastSeen: Date.now(),
      isSelf: false,
      status: 'online',
      isApproved: this.roomMode === 'public' || isMember(this.chain, payload.senderId),
    });
    this.commitParticipants();
  }

  /** Ordering is deterministic: timestamp, senderId, packetId [D-03]. */
  private insertMessage(message: ChatMessage, isBackfill: boolean) {
    if (this.messages.some((m) => m.id === message.id)) return;

    const rank = (m: ChatMessage) => [m.timestamp, m.senderId, m.id] as const;
    const target = rank(message);
    let index = this.messages.length;
    while (index > 0) {
      const other = rank(this.messages[index - 1]);
      const after =
        other[0] < target[0] ||
        (other[0] === target[0] && other[1] < target[1]) ||
        (other[0] === target[0] && other[1] === target[1] && other[2] <= target[2]);
      if (after) break;
      index--;
    }
    // A new array, never a splice in place: `messages` is read by React, and a
    // memo keyed on it (the comic strip's panel layout) only recomputes when the
    // reference changes.
    const next = this.messages.slice();
    next.splice(index, 0, message);
    this.messages = next;

    void this.db.saveMessage(message);
    if (!isBackfill) this.callbacks.onNewMessage?.(this, message);
    this.notify();
  }

  private async handleGenesis(packet: RoomGenesisPacket): Promise<void> {
    if (packet.convId !== this.convId) return;
    if (this.genesis) return;
    if (!(await verifyGenesis(packet))) return;
    if (!adoptGenesis(this.chain, packet)) return;

    this.genesis = packet;
    await this.recordChainPacket(packet.packetId, 0, packet);
    await this.persistChain();
    await this.persistConversation();
    await this.drainOrphans();
    this.notify();
  }

  private bufferOrphan(packet: RekeyPacket | CapabilityRotationPacket) {
    if (this.orphanControl.some((p) => p.packetId === packet.packetId)) return;
    // Bounded: a room cannot be made to buffer unbounded control packets [A-02].
    if (this.orphanControl.length >= 256) this.orphanControl.shift();
    this.orphanControl.push(packet);
  }

  /**
   * Re-applies buffered control packets now that a new chain node exists, and
   * re-judges a title that arrived before there was any chain to judge it by.
   */
  private async drainOrphans(): Promise<void> {
    await this.drainOrphanControl();
    await this.applyPendingMetadata();
  }

  /** Repeats while progress is being made, since one link can unblock the next. */
  private async drainOrphanControl(): Promise<void> {
    for (let pass = 0; pass < 8; pass++) {
      const pending = this.orphanControl;
      if (pending.length === 0) return;
      this.orphanControl = [];
      let progressed = false;

      for (const packet of pending) {
        const before = this.chain.nodes.size;
        if (packet.type === 'key') await this.handleRekey(packet);
        else await this.handleCapabilityRotation(packet);
        if (this.chain.nodes.size > before) progressed = true;
      }
      if (!progressed) return;
    }
  }

  private async handleRekey(packet: RekeyPacket): Promise<void> {
    if (packet.convId !== this.convId || !this.profile || !this.privateKey) return;
    if (!(await verifyRekey(packet))) return;

    const outcome = applyRekey(this.chain, packet);
    if (!outcome.accepted) {
      if (outcome.reason === 'no_genesis' || outcome.reason === 'unknown_parent') {
        this.bufferOrphan(packet);
      }
      return;
    }

    // A reshare re-delivers key material without adding a node, so it is not
    // part of the transcript a newcomer has to walk.
    if (packet.action !== 'reshare') {
      await this.recordChainPacket(packet.packetId, packet.epoch, packet);
    }

    this.trackParticipantsFromRekey(packet);

    const slot = await openRekeySlot(packet, this.profile.participantId, this.privateKey);
    if (slot) {
      const record: KeyRecord = {
        keyId: packet.keyId,
        epoch: packet.epoch,
        createdAt: packet.timestamp,
        key: slot.key,
        rawBase64Url: slot.rawBase64Url,
        parentKeyId: packet.parentKeyId,
        signerId: packet.signerId,
        members: packet.members,
      };
      this.keysMap.set(packet.keyId, record);
      await this.db.saveEpochKey({
        convId: this.convId,
        keyId: record.keyId,
        epoch: record.epoch,
        parentKeyId: record.parentKeyId,
        rawBase64Url: slot.rawBase64Url,
        signerId: record.signerId,
        members: record.members,
      });
    }

    if (outcome.isCanonicalHead) {
      this.activeKeyId = packet.keyId;
      this.activeEpoch = packet.epoch;
      const wasApproved = this.isApproved;
      this.isApproved = packet.members.includes(this.profile.participantId);

      if (!this.isApproved && wasApproved) {
        // Removed. In v3 the route rotates too, so this is mostly informational.
        this.startJoinRetry();
      } else if (this.isApproved) {
        this.stopJoinRetry();
      }

      packet.members.forEach((id) => {
        this.pendingRequestsMap.delete(id);
        this.declinedRequesters.delete(id);
      });
      this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
      this.syncParticipantApproval();
    }

    await this.persistChain();
    await this.persistConversation();
    await this.drainOrphans();
    this.notify();
  }

  /** Strong removal: adopt the new secret, re-derive every route [X-08][PR-07]. */
  private async handleCapabilityRotation(packet: CapabilityRotationPacket): Promise<void> {
    if (packet.convId !== this.convId || !this.profile || !this.privateKey) return;
    if (packet.generation <= this.capabilityGeneration) return;
    if (!(await verifyCapabilityRotation(packet))) return;

    const outcome = applyCapabilityRotation(this.chain, packet);
    if (!outcome.accepted) {
      if (outcome.reason === 'no_genesis' || outcome.reason === 'unknown_parent') {
        this.bufferOrphan(packet);
      }
      return;
    }

    await this.recordChainPacket(packet.packetId, packet.newEpoch, packet);

    const secrets = await openRotationSlot(packet, this.profile.participantId, this.privateKey);
    if (!secrets) {
      // No slot: we are the removed member. Stop here.
      this.isApproved = false;
      this.syncParticipantApproval();
      this.notify();
      return;
    }

    const oldRoute = { routingTag: this.routingTag, roomSecret: this.roomSecret };
    this.roomSecret = secrets.roomSecret;
    this.capabilityGeneration = packet.generation;

    const epochKey = await importRawAesKey(secrets.epochKey);
    this.keysMap.set(packet.newKeyId, {
      keyId: packet.newKeyId,
      epoch: packet.newEpoch,
      createdAt: packet.timestamp,
      key: epochKey,
      rawBase64Url: secrets.epochKey,
      parentKeyId: packet.parentKeyId,
      signerId: packet.signerId,
      members: packet.members,
    });
    await this.db.saveEpochKey({
      convId: this.convId,
      keyId: packet.newKeyId,
      epoch: packet.newEpoch,
      parentKeyId: packet.parentKeyId,
      rawBase64Url: secrets.epochKey,
      signerId: packet.signerId,
      members: packet.members,
    });

    this.activeKeyId = packet.newKeyId;
    this.activeEpoch = packet.newEpoch;
    this.isApproved = packet.members.includes(this.profile.participantId);

    this.previousRoutes = [
      ...this.previousRoutes.filter((r) => r.routingTag !== oldRoute.routingTag),
      { ...oldRoute, until: Date.now() + OLD_ROUTE_MONITOR_MS },
    ];

    await this.deriveRoute();
    await this.subscribeRoom();
    this.watchPreviousRoutes();
    this.syncParticipantApproval();
    await this.persistChain();
    await this.persistConversation();
    await this.drainOrphans();
    this.notify();
  }

  private async handleJoinRequest(packet: JoinRequestPacket): Promise<void> {
    if (packet.convId !== this.convId || !this.profile) return;
    if (packet.sender.participantId === this.profile.participantId) return;
    if (!(await verifyJoinRequest(packet))) return;
    if (!this.isApproved) return;

    const senderId = packet.sender.participantId;
    if (isMember(this.chain, senderId)) {
      await this.reshareActiveKey(packet);
      return;
    }

    const pending: PendingJoinRequest = {
      requestId: packet.requestId,
      sender: packet.sender,
      timestamp: packet.timestamp,
      verified: true,
    };

    if (this.autoApproveIds.has(senderId)) {
      this.autoApproveIds.delete(senderId);
      this.pendingRequestsMap.set(senderId, pending);
      this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
      await this.approveJoinRequest(packet.requestId);
      return;
    }

    if (!this.declinedRequesters.has(senderId)) {
      this.pendingRequestsMap.set(senderId, pending);
      this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
      this.notify();
    }
  }

  private async handleJoinDecision(packet: JoinDecisionPacket): Promise<void> {
    if (packet.convId !== this.convId) return;
    if (packet.decision !== 'approved') return;
    if (!(await verifyJoinDecision(packet))) return;
    // Authority: only a member of the epoch in force may clear a prompt [M-02].
    if (!membersAt(this.chain, packet.timestamp).includes(packet.deciderId)) return;

    if (this.pendingRequestsMap.delete(packet.targetParticipantId)) {
      this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
      this.notify();
    }
  }

  private async handleMetadata(packet: RoomMetadataPacket): Promise<void> {
    if (packet.convId !== this.convId) return;
    if (!(await verifyRoomMetadata(packet))) return;

    // Enforce the room's declared metadata authority [M-01][O-18].
    const policy = this.genesis?.metadataPolicy ?? 'members';
    if (this.roomMode === 'private') {
      if (policy === 'creator') {
        if (packet.setterId !== this.genesis?.creatorId) return;
      } else if (!this.setterWasMember(packet)) {
        // A first subscription replays the room newest-first, so the title
        // routinely lands before the genesis that would vouch for its author.
        // Dedup means we only ever see a given packet once, so dropping it
        // here loses the room's name for good -- hold it instead [M-01].
        if (!this.genesis || this.chain.nodes.size === 0) this.deferMetadata(packet);
        return;
      }
    } else if (!this.publicRoomCreatorId || packet.setterId !== this.publicRoomCreatorId) {
      // A public room is world-writable on the wire, so the title has to be
      // pinned to the identity its listing names. With no listing to read we
      // leave the name alone rather than take anyone's word for it [PU-02].
      return;
    }

    // History replays newest-first and relays hand back records in no
    // particular order, so an older record must never undo a newer rename.
    if (packet.timestamp <= this.titleUpdatedAt) return;

    const title = packet.title?.trim();
    if (!title) return;

    this.titleUpdatedAt = packet.timestamp;
    const changed = title !== this.channelTitle;
    this.channelTitle = title;
    await this.persistConversation();
    if (changed) this.notify();
  }

  /**
   * A rotation republishes genesis on the new route but not the epochs behind
   * it, so someone arriving there has a creator and no roster. Epoch 1 is the
   * creator alone [PR-01], which is enough to accept the creator's own record.
   */
  private deferMetadata(packet: RoomMetadataPacket): void {
    if (!this.pendingMetadata || packet.timestamp > this.pendingMetadata.timestamp) {
      this.pendingMetadata = packet;
    }
  }

  /** Re-judges a held title once the chain can actually answer the question. */
  private async applyPendingMetadata(): Promise<void> {
    const held = this.pendingMetadata;
    if (!held) return;
    this.pendingMetadata = null;
    await this.handleMetadata(held);
  }

  private setterWasMember(packet: RoomMetadataPacket): boolean {
    if (membersAt(this.chain, packet.timestamp).includes(packet.setterId)) return true;
    return this.chain.nodes.size === 0 && packet.setterId === this.genesis?.creatorId;
  }

  /**
   * Publishes the current title on a stable `d` tag, so one query finds the
   * room's name whether it was just created, renamed, or is being joined from
   * a link years later [M-01].
   */
  private async publishRoomMetadata(): Promise<boolean> {
    if (!this.profile || !this.signingPrivateKey) return false;
    const title = this.channelTitle.trim();
    if (!title) return false;

    const packet = await buildRoomMetadata({
      convId: this.convId,
      publicRoomId: this.publicRoomId ?? undefined,
      title,
      setterId: this.profile.participantId,
      setterSigningPublicKey: this.profile.signingPublicKeyBase64,
      signingPrivateKey: this.signingPrivateKey,
    });

    // Claim it locally first: our own echo is then an older-or-equal record.
    this.titleUpdatedAt = Math.max(this.titleUpdatedAt, packet.timestamp);
    return this.publishControl(packet, undefined, {
      dTag: D_METADATA_PREFIX + this.routingTag,
    });
  }

  /** Fetches the room title from its stable tag [M-01]. */
  private async fetchRoomMetadata(): Promise<void> {
    const events = await relayPool.query(
      dTagFilters([D_METADATA_PREFIX + this.routingTag], 5)
    );
    for (const event of events) await this.handleHistoricalEvent(event);
  }

  // --------------------------------------------------------------------------
  // Membership operations
  // --------------------------------------------------------------------------

  async sendJoinRequest(): Promise<boolean> {
    if (!this.profile || !this.signingPrivateKey) return false;
    if (this.isApproved || this.roomMode !== 'private') return false;

    this.joinRequestAttempts += 1;
    const request = await buildJoinRequest({
      convId: this.convId,
      participantId: this.profile.participantId,
      screenName: this.profile.screenName,
      avatarName: this.profile.avatarName,
      publicKey: this.profile.publicKeyBase64,
      signingPublicKey: this.profile.signingPublicKeyBase64,
      contactInfo: this.profile.contactInfo,
      signingPrivateKey: this.signingPrivateKey,
    });
    return this.publishControl(request, request.requestId);
  }

  async retryJoinRequest(): Promise<boolean> {
    this.joinRequestAttempts = 0;
    this.startJoinRetry();
    return this.sendJoinRequest();
  }

  private startJoinRetry() {
    if (this.joinRetryTimer || this.roomMode !== 'private') return;
    this.joinRetryTimer = setInterval(() => {
      if (this.isDestroyed || this.isApproved || this.joinRequestAttempts >= JOIN_REQUEST_MAX_ATTEMPTS) {
        this.stopJoinRetry();
        return;
      }
      void this.sendJoinRequest();
    }, JOIN_REQUEST_RETRY_MS);
  }

  private stopJoinRetry() {
    if (this.joinRetryTimer) clearInterval(this.joinRetryTimer);
    this.joinRetryTimer = null;
  }

  setAutoApprove(participantId: string) {
    if (!participantId) return;
    this.autoApproveIds.add(participantId);
    this.declinedRequesters.delete(participantId);
  }

  clearAutoApprove(participantId: string) {
    this.autoApproveIds.delete(participantId);
  }

  async approveJoinRequest(requestId: string): Promise<boolean> {
    const request = this.pendingJoinRequests.find((r) => r.requestId === requestId);
    if (!request || !this.profile || !this.signingPrivateKey) return false;

    const targetId = request.sender.participantId;
    this.pendingRequestsMap.delete(targetId);
    this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());

    // Key material comes from the signed request, not from a roster entry.
    this.participantsMap.set(targetId, {
      participantId: targetId,
      publicKey: normalizePublicKey(request.sender.publicKey),
      signingPublicKey: normalizePublicKey(request.sender.signingPublicKey),
      screenName: request.sender.screenName?.trim() || 'Anonymous',
      avatarName: request.sender.avatarName || 'Armando',
      contactInfo: request.sender.contactInfo,
      lastSeen: Date.now(),
      isSelf: false,
      status: 'online',
      isApproved: true,
    });
    this.commitParticipants();

    const head = chainHead(this.chain);
    if (!head) return false;

    const ok = await this.rekeyTo({
      action: 'add',
      targetParticipantId: targetId,
      targetScreenName: request.sender.screenName,
      targetAvatarName: request.sender.avatarName,
      members: [...head.members, targetId],
      parentPacketId: head.packetId,
      parentKeyId: head.keyId,
      epoch: head.epoch + 1,
    });

    const decision = await buildJoinDecision({
      convId: this.convId,
      requestId,
      targetParticipantId: targetId,
      decision: 'approved',
      deciderId: this.profile.participantId,
      deciderScreenName: this.profile.screenName,
      deciderSigningPublicKey: this.profile.signingPublicKeyBase64,
      signingPrivateKey: this.signingPrivateKey,
    });
    await this.publishControl(decision);

    return ok;
  }

  declineJoinRequest(requestId: string): void {
    const request = this.pendingJoinRequests.find((r) => r.requestId === requestId);
    if (request) {
      // Local only: another member may still admit them.
      this.declinedRequesters.add(request.sender.participantId);
      this.pendingRequestsMap.delete(request.sender.participantId);
    }
    this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
    this.notify();
  }

  /** Re-delivers the current epoch key without advancing the chain [X-07] (h). */
  private async reshareActiveKey(request: JoinRequestPacket): Promise<void> {
    const head = chainHead(this.chain);
    const record = this.keysMap.get(this.activeKeyId);
    if (!head || !record?.rawBase64Url || !this.profile || !this.signingPrivateKey) return;

    const publicKeys = this.collectPublicKeys(head.members);
    publicKeys.set(request.sender.participantId, normalizePublicKey(request.sender.publicKey));

    const raw = await crypto.subtle.exportKey('raw', record.key);
    const packet = await buildRekey({
      convId: this.convId,
      keyId: head.keyId,
      epoch: head.epoch,
      parentPacketId: head.packetId,
      parentKeyId: head.parentKeyId,
      action: 'reshare',
      targetParticipantId: request.sender.participantId,
      targetScreenName: request.sender.screenName,
      targetAvatarName: request.sender.avatarName,
      members: head.members,
      publicKeys,
      rawEpochKey: raw,
      signerId: this.profile.participantId,
      signerSigningPublicKey: this.profile.signingPublicKeyBase64,
      signerScreenName: this.profile.screenName,
      signerAvatarName: this.profile.avatarName,
      signingPrivateKey: this.signingPrivateKey,
    });
    await this.publishControl(packet, packet.packetId);
  }

  private collectPublicKeys(members: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const id of members) {
      const participant = this.participantsMap.get(id);
      if (participant?.publicKey) map.set(id, participant.publicKey);
    }
    return map;
  }

  private async rekeyTo(params: {
    action: RekeyPacket['action'];
    members: string[];
    parentPacketId: string;
    parentKeyId: string;
    epoch: number;
    targetParticipantId?: string;
    targetScreenName?: string;
    targetAvatarName?: string;
  }): Promise<boolean> {
    if (!this.profile || !this.signingPrivateKey) return false;

    this.isRekeying = true;
    this.notify();
    try {
      const members = Array.from(new Set(params.members)).sort();
      const publicKeys = this.collectPublicKeys(members);
      if (publicKeys.size !== members.length) return false;

      const keyId = makeEpochKeyId(params.epoch);
      const epochKey = await generateEpochKey();

      const packet = await buildRekey({
        convId: this.convId,
        keyId,
        epoch: params.epoch,
        parentPacketId: params.parentPacketId,
        parentKeyId: params.parentKeyId,
        action: params.action,
        targetParticipantId: params.targetParticipantId,
        targetScreenName: params.targetScreenName,
        targetAvatarName: params.targetAvatarName,
        members,
        publicKeys,
        rawEpochKey: epochKey.rawBuffer,
        signerId: this.profile.participantId,
        signerSigningPublicKey: this.profile.signingPublicKeyBase64,
        signerScreenName: this.profile.screenName,
        signerAvatarName: this.profile.avatarName,
        signingPrivateKey: this.signingPrivateKey,
      });

      const outcome = applyRekey(this.chain, packet);
      if (!outcome.accepted) return false;

      await this.recordChainPacket(packet.packetId, packet.epoch, packet);

      this.keysMap.set(keyId, {
        keyId,
        epoch: params.epoch,
        createdAt: packet.timestamp,
        key: epochKey.key,
        rawBase64Url: epochKey.rawBase64Url,
        parentKeyId: params.parentKeyId,
        signerId: this.profile.participantId,
        members,
      });
      await this.db.saveEpochKey({
        convId: this.convId,
        keyId,
        epoch: params.epoch,
        parentKeyId: params.parentKeyId,
        rawBase64Url: epochKey.rawBase64Url,
        signerId: this.profile.participantId,
        members,
      });

      this.activeKeyId = keyId;
      this.activeEpoch = params.epoch;
      this.isApproved = members.includes(this.profile.participantId);
      this.syncParticipantApproval();

      await this.publishControl(packet, packet.packetId);
      await this.persistChain();
      await this.persistConversation();
      return true;
    } finally {
      this.isRekeying = false;
      this.notify();
    }
  }

  async rekeyConversation(): Promise<boolean> {
    if (this.roomMode === 'public') return true;
    const head = chainHead(this.chain);
    if (!head) return false;
    return this.rekeyTo({
      action: 'rekey',
      members: head.members,
      parentPacketId: head.packetId,
      parentKeyId: head.keyId,
      epoch: head.epoch + 1,
    });
  }

  /**
   * Strong removal [PR-07]: rotates the room secret as well as the epoch key,
   * so a removed member cannot even locate the room's new traffic. Closes the
   * v2 gap [O-05] where removal left the secret, and therefore mesh access and
   * control visibility, intact forever.
   */
  async removeParticipant(participantId: string): Promise<boolean> {
    if (this.roomMode !== 'private' || !this.profile || !this.signingPrivateKey) return false;
    const head = chainHead(this.chain);
    if (!head || !head.members.includes(participantId)) return false;

    this.isRekeying = true;
    this.notify();
    try {
      const remaining = head.members.filter((id) => id !== participantId);
      if (remaining.length === 0) return false;

      const publicKeys = this.collectPublicKeys(remaining);
      if (publicKeys.size !== remaining.length) return false;

      const newSecret = generateRoomSecret();
      const newEpochKey = await generateEpochKey();
      const newKeyId = makeEpochKeyId(head.epoch + 1);
      const generation = this.capabilityGeneration + 1;

      const packet = await buildCapabilityRotation({
        convId: this.convId,
        generation,
        newEpoch: head.epoch + 1,
        newKeyId,
        parentPacketId: head.packetId,
        parentKeyId: head.keyId,
        removedParticipantId: participantId,
        members: remaining,
        publicKeys,
        secrets: { roomSecret: newSecret, epochKey: newEpochKey.rawBase64Url },
        signerId: this.profile.participantId,
        signerSigningPublicKey: this.profile.signingPublicKeyBase64,
        signingPrivateKey: this.signingPrivateKey,
      });

      const outcome = applyCapabilityRotation(this.chain, packet);
      if (!outcome.accepted) return false;

      await this.recordChainPacket(packet.packetId, packet.newEpoch, packet);

      // Publish on the OLD route, where every remaining member -- including any
      // that are offline -- is already looking [PR-07] step 4.
      await this.publishControl(packet, packet.packetId);

      const oldRoute = { routingTag: this.routingTag, roomSecret: this.roomSecret };
      this.roomSecret = newSecret;
      this.capabilityGeneration = generation;
      this.previousRoutes = [
        ...this.previousRoutes,
        { ...oldRoute, until: Date.now() + OLD_ROUTE_MONITOR_MS },
      ];

      this.keysMap.set(newKeyId, {
        keyId: newKeyId,
        epoch: head.epoch + 1,
        createdAt: packet.timestamp,
        key: newEpochKey.key,
        rawBase64Url: newEpochKey.rawBase64Url,
        parentKeyId: head.keyId,
        signerId: this.profile.participantId,
        members: remaining,
      });
      await this.db.saveEpochKey({
        convId: this.convId,
        keyId: newKeyId,
        epoch: head.epoch + 1,
        parentKeyId: head.keyId,
        rawBase64Url: newEpochKey.rawBase64Url,
        signerId: this.profile.participantId,
        members: remaining,
      });

      this.activeKeyId = newKeyId;
      this.activeEpoch = head.epoch + 1;
      this.participantsMap.delete(participantId);
      this.commitParticipants();
      this.autoApproveIds.delete(participantId);

      await this.deriveRoute();
      await this.subscribeRoom();
      this.watchPreviousRoutes();

      // Genesis alone is not enough: a newcomer arriving here has to walk the
      // chain from genesis to the head to validate their own admission, and
      // every link is on a route they cannot reach [PR-07].
      await this.republishChainTranscript();
      // Same for the title: the old `meta:` tag is unreachable from here on.
      await this.publishRoomMetadata();

      this.syncParticipantApproval();
      await this.persistChain();
      await this.persistConversation();
      return true;
    } finally {
      this.isRekeying = false;
      this.notify();
    }
  }

  private syncParticipantApproval() {
    const members = currentMembers(this.chain);
    let changed = false;
    for (const [id, participant] of this.participantsMap.entries()) {
      const approved = this.roomMode === 'public' || members.includes(id);
      if (participant.isApproved !== approved) {
        this.participantsMap.set(id, { ...participant, isApproved: approved });
        changed = true;
      }
    }
    if (changed) this.commitParticipants();
  }

  /**
   * Keeps the signed packet a chain node was built from. The chain state alone
   * cannot be republished -- the packets are signed by their original authors
   * and only they carry the wrapped key slots [PR-07].
   */
  private async recordChainPacket(
    packetId: string,
    epoch: number,
    packet: RoomGenesisPacket | RekeyPacket | CapabilityRotationPacket
  ): Promise<void> {
    if (this.roomMode !== 'private') return;
    try {
      await this.db.saveChainPacket({ convId: this.convId, packetId, epoch, packet });
    } catch {
      /* a transcript we cannot store only costs a future joiner a retry */
    }
  }

  /**
   * Re-publishes genesis and every membership transition onto the route we
   * have just moved to. The packets keep their own signatures, so a newcomer
   * validates the chain exactly as they would on the original route; only the
   * envelope around them is re-encrypted, under the new root key.
   *
   * The envelope gets a fresh packetId: reusing the original would look like
   * one packetId with two different bodies to everyone who already holds it.
   */
  private async republishChainTranscript(): Promise<void> {
    if (this.roomMode !== 'private') return;

    if (this.genesis) {
      await this.publishControl(this.genesis, undefined, {
        dTag: D_GENESIS_PREFIX + this.routingTag,
      });
    }

    for (const record of await this.db.getChainPackets(this.convId)) {
      const packet = record.packet as { type?: string } | null;
      if (!packet?.type || packet.type === 'room_genesis') continue;
      await this.publishControl(packet);
    }
  }

  private async persistChain(): Promise<void> {
    if (this.roomMode !== 'private') return;
    await this.db.saveChain(serializeChain(this.chain));
  }

  // --------------------------------------------------------------------------
  // Messages and metadata
  // --------------------------------------------------------------------------

  async sendMessage(
    text: string,
    options?: {
      emotion?: number;
      emotionIntensity?: number;
      balloonMode?: MessagePayload['balloonMode'];
    }
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || !this.profile || !this.signingPrivateKey) return false;
    if (byteLength(trimmed) > MAX_CHAT_TEXT_BYTES) return false;

    const key = this.contentKey;
    // [PR-01]: no root-key fallback. Without an epoch key, sending is disabled.
    if (this.roomMode === 'private' && (!key || !this.isApproved)) return false;

    const payload = await buildMessagePayload({
      convId: this.convId,
      roomMode: this.roomMode,
      publicRoomId: this.publicRoomId ?? undefined,
      senderId: this.profile.participantId,
      senderSigningPublicKey: this.profile.signingPublicKeyBase64,
      signingPrivateKey: this.signingPrivateKey,
      screenName: this.profile.screenName,
      avatarName: this.profile.avatarName,
      contactInfo: this.profile.contactInfo,
      text: trimmed,
      emotion: options?.emotion,
      emotionIntensity: options?.emotionIntensity,
      balloonMode: options?.balloonMode,
    });

    const result = await this.publishEnvelope({
      payload,
      packetClass: 'chat',
      packetId: payload.msgId,
      keyId: this.roomMode === 'public' ? PUBLIC_KEY_ID : this.activeKeyId,
      contentKey: key,
      expirationSec: CHAT_RETENTION_SEC,
    });
    if (!result) return false;

    // Optimistic local insert; only relay quorum makes it 'relayed' [L-12][D-05].
    this.insertMessage(
      {
        id: payload.msgId,
        convId: this.convId,
        senderId: this.profile.participantId,
        sender: {
          screenName: this.profile.screenName,
          avatarName: this.profile.avatarName,
          signingPublicKey: normalizePublicKey(this.profile.signingPublicKeyBase64),
          contactInfo: this.profile.contactInfo,
        },
        timestamp: payload.timestamp,
        text: payload.text,
        keyId: this.roomMode === 'public' ? PUBLIC_KEY_ID : this.activeKeyId,
        keyEpoch: this.activeEpoch,
        isSelf: true,
        emotion: options?.emotion,
        emotionIntensity: options?.emotionIntensity,
        balloonMode: options?.balloonMode,
        sendState: result.state,
      },
      false
    );

    this.accelerate(result.serialized);
    return true;
  }

  /**
   * Hands the envelope to the accelerator when this room owns the mesh. The
   * exact same serialized bytes already went to the relays [P-03][G-06].
   */
  private accelerate(serialized: string) {
    if (this.acceleratorEligible && accelerator.getStatus() === 'active') {
      accelerator.send(serialized);
    }
  }

  /** Entry point used by the accelerator for inbound envelopes [P-03]. */
  async receiveFromAccelerator(serialized: string): Promise<void> {
    const result = await verifyEnvelope(serialized, {
      convId: this.convId,
      roomMode: this.roomMode,
    });
    if (result.ok) await this.acceptEnvelope(result, false);
  }

  async updateChannelTitle(title: string): Promise<boolean> {
    const clean = title.trim();
    if (!clean || !this.profile || !this.signingPrivateKey) return false;
    // Refuse rather than rename locally into a name nobody else will accept.
    if (this.roomMode === 'public' && !this.canRenameRoom) return false;

    this.channelTitle = clean;
    // Publishing queues the event rather than waiting on the relays, so the
    // rename is on screen immediately either way.
    const published = await this.publishRoomMetadata();
    // The directory listing is the room's public name; it must not go stale.
    if (this.roomMode === 'public') await this.republishPublicDescriptor(clean);
    await this.persistConversation();
    this.notify();
    return published;
  }

  // --------------------------------------------------------------------------
  // History  [H-01]
  // --------------------------------------------------------------------------

  /**
   * Relay-first catch-up. Every valid sender publishes through Nostr, so there
   * is no peer-to-peer history protocol at all in v3 [H-03].
   */
  async catchUpHistory(maxPages = 5): Promise<void> {
    let until = Date.now();
    for (let page = 0; page < maxPages; page++) {
      const events = await relayPool.query(historyFilters(this.routingTag, until));
      if (events.length === 0) break;

      for (const event of events) {
        await this.handleHistoricalEvent(event);
      }

      const oldest = Math.min(...events.map((e) => e.created_at * 1000));
      if (!Number.isFinite(oldest) || oldest >= until) break;
      until = oldest;
    }
    this.notify();
  }

  private async handleHistoricalEvent(event: NostrEvent): Promise<void> {
    if (tagValue(event, 'r') !== this.routingTag) return;
    const result = await verifyEnvelope(event.content, {
      convId: this.convId,
      roomMode: this.roomMode,
    });
    // Historical packets legitimately predate the live window [D-04].
    if (!result.ok) return;
    await this.acceptEnvelope(result, true);
  }

  /** Fetches the genesis packet from its stable tag [L-05]. */
  async fetchGenesis(): Promise<void> {
    if (this.roomMode !== 'private' || this.genesis) return;
    const events = await relayPool.query(dTagFilters([D_GENESIS_PREFIX + this.routingTag], 1));
    for (const event of events) await this.handleHistoricalEvent(event);
  }

  // --------------------------------------------------------------------------
  // Connectivity and lifecycle
  // --------------------------------------------------------------------------

  private refreshConnectionStatus() {
    const health = relayPool.getHealth();
    const connected = health.filter((h) => h.connected).length;
    const next =
      connected > 0 ? 'connected' : health.length === 0 ? 'error' : 'connecting';
    if (next !== this.connectionStatus) {
      this.connectionStatus = next;
      this.notify();
    }
  }

  get relayHealth() {
    return relayPool.getHealth();
  }

  /**
   * Selecting another private room closes the previous room's mesh, so at most
   * one exists at a time [R-03][W-03]. Nostr delivery to background rooms is
   * unaffected, because their subscriptions live in the shared pool.
   */
  setForeground(isForeground: boolean): void {
    if (this.isForeground === isForeground) return;
    this.isForeground = isForeground;
    if (isForeground) void this.activateAccelerator();
    this.notify();
  }

  private async activateAccelerator(): Promise<void> {
    if (!this.profile || !this.signingPrivateKey) return;
    if (!this.acceleratorEligible) {
      this.accelerationStatus = 'unavailable';
      this.notify();
      return;
    }
    await accelerator.activate(
      {
        tabId: this.tabId,
        convId: this.convId,
        roomSecret: this.roomSecret,
        roomMode: this.roomMode,
        isApproved: this.isApproved,
        memberCount: this.memberCount,
        receive: (serialized) => this.receiveFromAccelerator(serialized),
        onStatus: (status, peerCount) => {
          this.accelerationStatus = status;
          this.connectedPeersCount = peerCount;
          this.notify();
        },
      },
      this.profile,
      this.signingPrivateKey
    );
  }

  async provideRoomSecret(input: string): Promise<void> {
    const match = input.trim().match(/secret=([A-Za-z0-9_-]+)/);
    const secret = match?.[1] ?? input.trim();
    if (!secret || !this.profile) return;

    this.roomSecret = secret;
    this.isSecretMissing = false;
    this.isInitialized = false;
    this.subscription?.close();
    this.subscription = null;
    await this.init(this.profile);
  }

  async clearHistory(): Promise<void> {
    await this.db.clearMessages(this.convId);
    this.messages = [];
    this.dedup.forgetConversation(this.convId);
    this.notify();
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.isForeground) accelerator.deactivate();
    this.stopJoinRetry();
    this.subscription?.close();
    this.oldRouteSubscription?.close();
    this.beacon?.stop();
    if (this.occupancyTimer) clearInterval(this.occupancyTimer);
    this.unsubHealth?.();
    this.unsubOutbox?.();
    this.participantsMap.clear();
    this.commitParticipants();
    this.pendingRequestsMap.clear();
  }
}

export { outbox };
