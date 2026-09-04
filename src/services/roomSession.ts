import type {
  UserProfile,
  Participant,
  ChatMessage,
  KeyRecord,
  PlaintextMessagePayload,
  IdentityHelloPacket,
  RekeyPacket,
  JoinRequestPacket,
  ChannelTitlePacket,
  PendingJoinRequest,
  EncryptedNetworkEnvelope,
  StateSummaryPacket,
  StateRequestPacket,
  StateChunkPacket,
  RelaySocketStatus,
  RoomMode,
  PublicRoomDescriptorPacket,
  RosterGossipPacket,
  JoinDecisionPacket,
  QuickMessagePayload,
} from '../types';
import {
  generateRandomRoomSecret,
  deriveRootKeyV2,
  deriveTrysteroPassword,
  derivePublicRoomId,
  derivePublicSignalingPassword,
  derivePublicTransportKey,
  createSignedPublicMessagePayload,
  verifyPublicMessageSignature,
  generateNewConversationKey,
  createSignedHello,
  verifyHelloSignature,
  createSignedJoinRequest,
  verifyJoinRequestSignature,
  createSignedRekeyPacket,
  verifyRekeyPacketSignature,
  decryptRekeyPacket,
  createSignedJoinDecision,
  verifyJoinDecisionSignature,
  createSignedStateSummary,
  verifyStateSummarySignature,
  createEncryptedEnvelope,
  decryptEnvelope,
  normalizePublicKey,
  getPublicKeyFingerprint,
} from './crypto';
import { getOrInitChannelTitle, getRandomChannelTitle } from '../utils/channelNameGenerator';
import { dbService } from './db';
import { TrysteroService } from './trystero';
import { SIGNALING_RELAY_URLS } from './relays';

/** How often we re-announce our own signed hello so relayed presence stays fresh. */
const HELLO_REANNOUNCE_MS = 25000;
/** No proof of life within this window and a participant is shown as offline. */
const PARTICIPANT_STALE_MS = 90000;
/** Non-member participants are dropped from the roster entirely after this long. */
const PARTICIPANT_EVICT_MS = 600000;
/** Cadence of the presence sweep / hello re-announce timer. */
const PRESENCE_SWEEP_MS = 15000;
/** Retry cadence for an unapproved peer waiting to be let into a private room. */
const JOIN_REQUEST_RETRY_MS = 8000;
const JOIN_REQUEST_MAX_ATTEMPTS = 24;
/** Bounds on the gossip dedup ledger and the re-serve cache. */
const MAX_TRACKED_PACKET_IDS = 4000;
const MAX_SEEN_HELLO_NONCES = 2000;
const MAX_CACHED_ENVELOPES = 500;
/** History sync limits. */
const MAX_SYNC_MESSAGE_IDS = 200;
const MAX_CHUNK_ENVELOPES = 40;
const MAX_CHUNKS_PER_REQUEST = 5;
const MAX_ROSTER_HELLOS = 64;

export interface RoomSessionConfig {
  tabId: string;
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string;
  publicJoinToken?: string;
  publicRoomId?: string;
  isInitialCreator?: boolean;
  channelTitle?: string;
}

export class RoomSession {
  public tabId: string;
  public convId: string;
  public roomMode: RoomMode;
  public roomSecret: string;
  public publicJoinToken: string | null;
  public publicRoomId: string | null;
  public isInitialCreator: boolean;
  public channelTitle: string;

  public connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'error' = 'connecting';
  public participantsMap: Map<string, Participant> = new Map();
  public messages: ChatMessage[] = [];
  public activeKeyId: string = 'root-v2';
  public activeEpoch: number = 0;
  public isApproved: boolean = false;
  public isRekeying: boolean = false;
  public rootFingerprint: string = '';
  public pendingJoinRequests: PendingJoinRequest[] = [];
  public channelOwnerName: string | null = null;
  public connectedPeersCount: number = 0;
  public relayStatuses: RelaySocketStatus[] = [];
  public isSecretMissing: boolean = false;

  private profile: UserProfile | null = null;
  private privateKey: CryptoKey | null = null;
  private signingPrivateKey: CryptoKey | null = null;
  private rootKey: CryptoKey | null = null;
  private keysMap: Map<string, KeyRecord> = new Map();
  private trysteroService: TrysteroService | null = null;
  private onQuickMessageCb: ((payload: QuickMessagePayload) => void) | null = null;

  private approvedMembers: Set<string> = new Set();
  private processedPacketIds: Set<string> = new Set();
  private processedPacketOrder: string[] = [];
  private pendingRequestsMap: Map<string, PendingJoinRequest> = new Map();
  private peerIdToParticipantId: Map<string, string> = new Map();
  private sentHelloPeers: Set<string> = new Set();

  // Roster gossip: signed hellos are relayed verbatim so participants that cannot
  // form a direct WebRTC link still see one another.
  private knownHellos: Map<string, IdentityHelloPacket> = new Map();
  private helloSeenAt: Map<string, number> = new Map();
  private seenHelloNonces: Set<string> = new Set();
  private seenHelloNonceOrder: string[] = [];
  private directPeerIds: Set<string> = new Set();

  // Membership decisions
  private declinedRequesters: Set<string> = new Set();
  private autoApproveIds: Set<string> = new Set();
  private joinRequestAttempts: number = 0;

  // History re-serve cache (packetId -> original wire envelope)
  private envelopeCache: Map<string, EncryptedNetworkEnvelope> = new Map();

  // State summaries that arrived before we knew the sender's signing key.
  private deferredSummaries: Map<string, { packet: StateSummaryPacket; peerId: string }> = new Map();

  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private joinRetryTimer: ReturnType<typeof setInterval> | null = null;
  private lastHelloBroadcastAt: number = 0;

  private isDestroyed: boolean = false;
  private isInitialized: boolean = false;
  private onStateChangeCb?: (session: RoomSession) => void;
  private onNewMessageCb?: (session: RoomSession, msg: ChatMessage) => void;

  constructor(
    config: RoomSessionConfig,
    onStateChange?: (session: RoomSession) => void,
    onNewMessage?: (session: RoomSession, msg: ChatMessage) => void
  ) {
    this.tabId = config.tabId;
    this.convId = config.convId;
    this.roomMode = config.roomMode;
    this.roomSecret = config.roomSecret || '';
    this.publicJoinToken = config.publicJoinToken || null;
    this.publicRoomId = config.publicRoomId || null;
    this.isInitialCreator = config.isInitialCreator ?? (!config.convId || config.convId.length === 0);
    this.channelTitle = config.channelTitle || getOrInitChannelTitle(this.convId);

    this.onStateChangeCb = onStateChange;
    this.onNewMessageCb = onNewMessage;

    if (this.roomMode === 'private' && !this.roomSecret) {
      this.isSecretMissing = true;
    }
  }

  public get inviteUrl(): string {
    if (typeof window === 'undefined') return '';
    if (this.roomMode === 'public') {
      return `${window.location.origin}${window.location.pathname}?id=${encodeURIComponent(this.convId)}&public=1&join=${encodeURIComponent(this.publicJoinToken || '')}`;
    }
    return this.roomSecret
      ? `${window.location.origin}${window.location.pathname}?id=${encodeURIComponent(this.convId)}#secret=${encodeURIComponent(this.roomSecret)}`
      : `${window.location.origin}${window.location.pathname}?id=${encodeURIComponent(this.convId)}`;
  }

  private notifyChange() {
    if (this.isDestroyed) return;
    this.onStateChangeCb?.(this);
  }

  public setOnQuickMessage(cb: (payload: QuickMessagePayload) => void) {
    this.onQuickMessageCb = cb;
  }

  public async init(profile: UserProfile, privateKey: CryptoKey, signingPrivateKey: CryptoKey) {
    if (this.isDestroyed || this.isInitialized) return;
    this.isInitialized = true;
    this.profile = profile;
    this.privateKey = privateKey;
    this.signingPrivateKey = signingPrivateKey;

    // Load saved channel title & metadata
    const savedTitle = typeof localStorage !== 'undefined' ? localStorage.getItem(`aircomic_channel_title_${this.convId}`) : null;
    if (savedTitle && savedTitle.trim()) {
      this.channelTitle = savedTitle.trim();
    }

    const savedMeta = await dbService.getConversationMetadata(this.convId);
    if (savedMeta?.roomSecret && !this.roomSecret && this.roomMode === 'private') {
      this.roomSecret = savedMeta.roomSecret;
      this.isSecretMissing = false;
    }

    // Initialize root key or public transport key
    if (this.roomMode === 'public') {
      const publicId = await derivePublicRoomId(this.convId, this.publicJoinToken || '');
      this.publicRoomId = publicId;
      const transportKey = await derivePublicTransportKey(this.convId, this.publicJoinToken || '');
      this.rootKey = transportKey;

      const pubKeyRec: KeyRecord = {
        keyId: 'public-v2',
        epoch: 0,
        createdAt: Date.now(),
        key: transportKey,
        isRoot: true,
        members: [],
      };
      this.keysMap.set('public-v2', pubKeyRec);
      this.activeKeyId = 'public-v2';
      this.activeEpoch = 0;
      this.isApproved = true;
      this.rootFingerprint = publicId.slice(0, 8);
    } else {
      if (this.roomSecret) {
        this.isSecretMissing = false;
        const derivedKey = await deriveRootKeyV2(this.roomSecret, this.convId);
        this.rootKey = derivedKey;
        const rawBuf = await crypto.subtle.exportKey('raw', derivedKey);
        const hashBuf = await crypto.subtle.digest('SHA-256', rawBuf);
        this.rootFingerprint = Array.from(new Uint8Array(hashBuf))
          .slice(0, 4)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(':')
          .toUpperCase();

        const rootRec: KeyRecord = {
          keyId: 'root-v2',
          epoch: 0,
          createdAt: Date.now(),
          key: derivedKey,
          isRoot: true,
          members: this.isInitialCreator ? [profile.participantId] : [],
        };
        this.keysMap.set('root-v2', rootRec);

        if (this.isInitialCreator) {
          this.isApproved = true;
          this.approvedMembers.add(profile.participantId);
        } else {
          this.isApproved = false;
        }
      } else {
        this.isSecretMissing = true;
        this.isApproved = false;
      }
    }

    // Add self to participants
    this.participantsMap.set(profile.participantId, {
      participantId: profile.participantId,
      publicKey: normalizePublicKey(profile.publicKeyBase64),
      signingPublicKey: normalizePublicKey(profile.signingPublicKeyBase64),
      screenName: profile.screenName,
      avatarName: profile.avatarName || 'Armando',
      contactInfo: profile.contactInfo,
      lastSeen: Date.now(),
      isSelf: true,
      status: 'online',
      isApproved: this.isApproved,
    });

    // Load past messages
    const history = await dbService.getMessages(this.convId);
    this.messages = history;
    history.forEach((m) => this.processedPacketIds.add(m.id));

    // Keep the newest stored envelopes around so we can re-serve history to peers.
    history.slice(-MAX_CACHED_ENVELOPES).forEach((m) => {
      if (m.envelope) this.envelopeCache.set(m.id, m.envelope);
    });

    // Connect signaling & WebRTC
    await this.connectTrystero();
    this.startPresenceTimer();
    if (this.roomMode === 'private' && !this.isApproved && !this.isSecretMissing) {
      this.startJoinRetryTimer();
    }
    this.notifyChange();
  }

  /** Pre-authorises a participant we invited ourselves, so their join request is granted on arrival. */
  public setAutoApprove(participantId: string) {
    if (!participantId) return;
    this.autoApproveIds.add(participantId);
    this.declinedRequesters.delete(participantId);
  }

  /** Withdraws a pre-authorisation, e.g. when the invitation is cancelled or declined. */
  public clearAutoApprove(participantId: string) {
    this.autoApproveIds.delete(participantId);
  }

  public updateProfile(updated: UserProfile) {
    this.profile = updated;
    const existing = this.participantsMap.get(updated.participantId);
    if (existing) {
      this.participantsMap.set(updated.participantId, {
        ...existing,
        screenName: updated.screenName,
        avatarName: updated.avatarName || 'Armando',
        contactInfo: updated.contactInfo,
        publicKey: normalizePublicKey(updated.publicKeyBase64),
        signingPublicKey: normalizePublicKey(updated.signingPublicKeyBase64),
      });
    }
    this.broadcastHello();
    this.notifyChange();
  }

  private async buildHello(): Promise<IdentityHelloPacket | null> {
    if (!this.profile || !this.signingPrivateKey || !this.trysteroService) return null;
    try {
      const hello = await createSignedHello(
        this.convId,
        this.trysteroService.selfPeerId,
        this.profile.participantId,
        this.profile.screenName,
        this.profile.publicKeyBase64,
        this.profile.signingPublicKeyBase64,
        this.signingPrivateKey,
        this.roomMode === 'public' ? undefined : this.profile.contactInfo,
        this.profile.avatarName || 'Armando',
        this.roomMode
      );
      // Keep our own announcement in the roster so peers relaying for us stay current.
      this.knownHellos.set(hello.participantId, hello);
      this.helloSeenAt.set(hello.participantId, Date.now());
      this.rememberHelloNonce(hello.nonce);
      return hello;
    } catch (err) {
      console.warn('Failed to build signed hello:', err);
      return null;
    }
  }

  public async broadcastHello(): Promise<void> {
    const hello = await this.buildHello();
    if (!hello || !this.trysteroService) return;
    this.lastHelloBroadcastAt = Date.now();
    this.trysteroService.sendHello(hello);
  }

  private async sendHelloTo(peerId: string): Promise<void> {
    const hello = await this.buildHello();
    if (!hello || !this.trysteroService) return;
    this.trysteroService.sendHello(hello, peerId);
  }

  private async connectTrystero() {
    if (!this.profile) return;
    if (this.roomMode === 'private' && !this.roomSecret) {
      this.connectionStatus = 'error';
      return;
    }

    const signalingRoomId = this.convId;

    const signalingPassword = this.roomMode === 'public'
      ? await derivePublicSignalingPassword(this.convId, this.publicJoinToken || '')
      : await deriveTrysteroPassword(this.roomSecret, this.convId);

    if (this.trysteroService) {
      try {
        this.trysteroService.disconnect();
      } catch {}
      this.trysteroService = null;
    }

    // Transport peer ids do not survive a reconnect.
    this.directPeerIds.clear();
    this.sentHelloPeers.clear();
    this.peerIdToParticipantId.clear();

    this.trysteroService = new TrysteroService(signalingRoomId, signalingPassword, SIGNALING_RELAY_URLS);

    this.trysteroService.setOnPeerJoin((peerId) => this.handlePeerJoin(peerId));
    this.trysteroService.setOnPeerLeave((peerId) => this.handlePeerLeave(peerId));
    this.trysteroService.setOnHello((packet, peerId) => this.handleIncomingHello(packet, peerId));
    this.trysteroService.setOnControl((envelope, peerId) => this.handleIncomingControl(envelope, peerId));
    this.trysteroService.setOnChat((envelope, peerId) => this.handleIncomingChat(envelope, peerId));
    this.trysteroService.setOnStateSummary((packet, peerId) => this.handleStateSummary(packet, peerId));
    this.trysteroService.setOnStateRequest((packet, peerId) => this.handleStateRequest(packet, peerId));
    this.trysteroService.setOnStateChunk((packet, peerId) => this.handleStateChunk(packet, peerId));
    this.trysteroService.setOnQuickMessage((payload, peerId) => this.handleIncomingQuickMessage(payload, peerId));

    this.trysteroService.setOnRelayStatusChange((statuses) => {
      this.relayStatuses = statuses;
      const anyConnected = statuses.some((s) => s.status === 'connected');
      const allDisconnectedOrError =
        statuses.length > 0 &&
        statuses.every((s) => s.status === 'disconnected' || s.status === 'error');

      if (anyConnected) {
        this.connectionStatus = 'connected';
      } else if (allDisconnectedOrError) {
        this.connectionStatus = 'disconnected';
      } else {
        this.connectionStatus = 'connecting';
      }
      this.notifyChange();
    });

    this.connectionStatus = 'connecting';
    this.trysteroService.connect();
    this.relayStatuses = this.trysteroService.getRelayStatuses();
  }

  private async handlePeerJoin(peerId: string) {
    if (!this.profile || !this.signingPrivateKey || !this.trysteroService) return;
    this.directPeerIds.add(peerId);
    this.connectedPeersCount = this.trysteroService.getConnectedPeers().length;
    this.relayStatuses = this.trysteroService.getRelayStatuses();

    if (!this.sentHelloPeers.has(peerId)) {
      this.sentHelloPeers.add(peerId);
      await this.sendHelloTo(peerId);
    }

    // Hand the newcomer the roster and our history summary straight away, so they
    // see everyone already in the room instead of only the peers they reach directly.
    await this.sendRosterTo(this.freshHellos(), [peerId]);
    await this.sendStateSummaryTo(peerId);

    if (!this.isApproved && this.roomMode === 'private') {
      await this.sendJoinRequest(peerId);
    }
    this.notifyChange();
  }

  private handlePeerLeave(peerId: string) {
    if (!this.trysteroService) return;
    this.directPeerIds.delete(peerId);
    this.connectedPeersCount = this.trysteroService.getConnectedPeers().length;
    this.relayStatuses = this.trysteroService.getRelayStatuses();
    this.sentHelloPeers.delete(peerId);

    const partId = this.peerIdToParticipantId.get(peerId);
    this.peerIdToParticipantId.delete(peerId);
    if (partId) {
      const existing = this.participantsMap.get(partId);
      if (existing) {
        this.participantsMap.set(partId, { ...existing, status: 'offline' });
      }
      // Drop the cached announcement: if they are still in the room behind another
      // peer, the next relayed hello counts as fresh news and brings them back.
      this.knownHellos.delete(partId);
      this.helloSeenAt.delete(partId);
    }
    this.notifyChange();
  }

  // --------------------------------------------------------------------------
  // Roster gossip
  // --------------------------------------------------------------------------

  private rememberHelloNonce(nonce: string) {
    if (this.seenHelloNonces.has(nonce)) return;
    this.seenHelloNonces.add(nonce);
    this.seenHelloNonceOrder.push(nonce);
    if (this.seenHelloNonceOrder.length > MAX_SEEN_HELLO_NONCES) {
      const evicted = this.seenHelloNonceOrder.splice(0, this.seenHelloNonceOrder.length - MAX_SEEN_HELLO_NONCES);
      evicted.forEach((n) => this.seenHelloNonces.delete(n));
    }
  }

  /**
   * Validates and records a hello that arrived either directly or via a relaying
   * peer. Returns 'new' only for announcements we have not seen before, which is
   * what bounds the gossip flood (every hello carries a random nonce).
   */
  private async ingestHello(hello: IdentityHelloPacket, viaPeerId: string): Promise<'new' | 'stale' | 'invalid'> {
    if (!hello || hello.convId !== this.convId || !hello.nonce) return 'invalid';
    if (this.seenHelloNonces.has(hello.nonce)) return 'stale';
    if (!(await verifyHelloSignature(hello))) return 'invalid';

    this.rememberHelloNonce(hello.nonce);

    const existing = this.knownHellos.get(hello.participantId);
    if (!existing || hello.timestamp >= existing.timestamp) {
      this.knownHellos.set(hello.participantId, hello);
    }
    this.helloSeenAt.set(hello.participantId, Date.now());

    if (hello.participantId === this.profile?.participantId) return 'stale';

    // hello.peerId is signed by the sender, so a matching transport peer id proves
    // this arrived over a direct link rather than through a relay.
    if (hello.peerId === viaPeerId) {
      this.peerIdToParticipantId.set(viaPeerId, hello.participantId);
    }

    const previous = this.participantsMap.get(hello.participantId);
    const isApprovedParticipant =
      this.roomMode === 'public' || this.approvedMembers.has(hello.participantId) || previous?.isApproved === true;

    this.participantsMap.set(hello.participantId, {
      participantId: hello.participantId,
      peerId: hello.peerId,
      publicKey: normalizePublicKey(hello.publicKey),
      signingPublicKey: normalizePublicKey(hello.signingPublicKey),
      screenName: hello.screenName,
      avatarName: hello.avatarName || 'Armando',
      contactInfo: hello.contactInfo ?? previous?.contactInfo,
      lastSeen: Date.now(),
      isSelf: false,
      status: 'online',
      isApproved: isApprovedParticipant,
    });

    const deferred = this.deferredSummaries.get(hello.participantId);
    if (deferred) {
      this.deferredSummaries.delete(hello.participantId);
      this.handleStateSummary(deferred.packet, deferred.peerId);
    }

    return 'new';
  }

  /** Announcements we have seen recently enough to be worth passing on. */
  private freshHellos(): IdentityHelloPacket[] {
    const now = Date.now();
    const result: IdentityHelloPacket[] = [];
    for (const [participantId, hello] of this.knownHellos.entries()) {
      const seenAt = this.helloSeenAt.get(participantId) ?? 0;
      if (now - seenAt <= PARTICIPANT_STALE_MS) result.push(hello);
    }
    return result.slice(0, MAX_ROSTER_HELLOS);
  }

  private async sendRosterTo(hellos: IdentityHelloPacket[], targets?: string[], exclude: string[] = []) {
    if (hellos.length === 0) return;
    const packet: RosterGossipPacket = {
      type: 'roster',
      protocol: 'airthread/2',
      convId: this.convId,
      hellos: hellos.slice(0, MAX_ROSTER_HELLOS),
      timestamp: Date.now(),
    };
    await this.sendControlPacket(packet, targets, exclude);
  }

  private async handleIncomingHello(hello: IdentityHelloPacket, rawPeerId: string) {
    const result = await this.ingestHello(hello, rawPeerId);
    if (result === 'invalid') return;

    const isDirect = hello.peerId === rawPeerId;

    if (isDirect && !this.sentHelloPeers.has(rawPeerId)) {
      this.sentHelloPeers.add(rawPeerId);
      await this.sendHelloTo(rawPeerId);
    }

    if (result === 'new') {
      // Pass it on to everyone else we can reach; peers that already saw this
      // nonce drop it, so the flood terminates.
      await this.sendRosterTo([hello], undefined, [rawPeerId, hello.peerId]);
    }

    if (isDirect) {
      await this.syncChannelTitleTo(rawPeerId);
      await this.sendStateSummaryTo(rawPeerId);
      if (!this.isApproved && this.roomMode === 'private') {
        await this.sendJoinRequest(rawPeerId);
      }
    }

    if (result === 'new') this.notifyChange();
  }

  private async handleRosterPacket(packet: RosterGossipPacket, viaPeerId: string) {
    if (packet.convId !== this.convId || !Array.isArray(packet.hellos)) return;

    const learned: IdentityHelloPacket[] = [];
    for (const hello of packet.hellos.slice(0, MAX_ROSTER_HELLOS)) {
      if ((await this.ingestHello(hello, viaPeerId)) === 'new') learned.push(hello);
    }

    if (learned.length > 0) {
      await this.sendRosterTo(learned, undefined, [viaPeerId]);
      this.notifyChange();
    }
  }

  /** Mirrors our channel title to a peer that just introduced itself. */
  private async syncChannelTitleTo(peerId: string) {
    if (!this.isApproved || !this.profile || !this.channelTitle) return;
    const titlePacket: ChannelTitlePacket = {
      type: 'channel_title',
      protocol: 'airthread/2',
      convId: this.convId,
      title: this.channelTitle,
      setterId: this.profile.participantId,
      setterScreenName: this.profile.screenName,
      timestamp: Date.now(),
    };
    await this.sendControlPacket(titlePacket, [peerId]);
  }

  // --------------------------------------------------------------------------
  // Gossip plumbing
  // --------------------------------------------------------------------------

  /** Bounded dedup ledger. Returns false when this packet has already been handled. */
  private markProcessed(packetId: string): boolean {
    if (!packetId || this.processedPacketIds.has(packetId)) return false;
    this.processedPacketIds.add(packetId);
    this.processedPacketOrder.push(packetId);
    if (this.processedPacketOrder.length > MAX_TRACKED_PACKET_IDS) {
      const evicted = this.processedPacketOrder.splice(0, this.processedPacketOrder.length - MAX_TRACKED_PACKET_IDS);
      evicted.forEach((id) => this.processedPacketIds.delete(id));
    }
    return true;
  }

  private rememberEnvelope(envelope: EncryptedNetworkEnvelope) {
    if (this.envelopeCache.has(envelope.packetId)) return;
    this.envelopeCache.set(envelope.packetId, envelope);
    while (this.envelopeCache.size > MAX_CACHED_ENVELOPES) {
      const oldest = this.envelopeCache.keys().next();
      if (oldest.done) break;
      this.envelopeCache.delete(oldest.value);
    }
  }

  private get controlKey(): CryptoKey | null {
    return this.roomMode === 'public' ? this.keysMap.get('public-v2')?.key ?? null : this.rootKey;
  }

  private get controlKeyId(): string {
    return this.roomMode === 'public' ? 'public-v2' : 'root-v2';
  }

  /**
   * Encrypts and dispatches a control packet. With no explicit targets this is a
   * room-wide broadcast; `exclude` skips individual peers when relaying.
   */
  private async sendControlPacket(
    packet: { timestamp?: number },
    targets?: string[],
    exclude: string[] = [],
    packetId?: string
  ): Promise<boolean> {
    const key = this.controlKey;
    if (!key || !this.profile || !this.trysteroService) return false;

    try {
      const envelope = await createEncryptedEnvelope(
        key,
        this.convId,
        packetId || crypto.randomUUID(),
        this.controlKeyId,
        this.profile.participantId,
        JSON.stringify(packet),
        packet.timestamp || Date.now()
      );
      // Claim our own packet id so a relayed copy coming back is ignored.
      this.markProcessed(envelope.packetId);

      if (!targets && exclude.length === 0) {
        this.trysteroService.sendControl(envelope);
        return true;
      }

      const peerIds = targets ?? this.trysteroService.getConnectedPeers();
      for (const peerId of peerIds) {
        if (exclude.includes(peerId)) continue;
        this.trysteroService.sendControl(envelope, peerId);
      }
      return true;
    } catch (err) {
      console.warn('Failed to send control packet:', err);
      return false;
    }
  }

  /**
   * Re-sends a packet we just accepted to every other peer we can reach. Recipients
   * dedupe on packet id, so the room stays consistent even when the WebRTC mesh is
   * only partially connected — which is the normal case behind symmetric NATs.
   */
  private forwardEnvelope(kind: 'chat' | 'control', envelope: EncryptedNetworkEnvelope, exceptPeerId?: string) {
    if (!this.trysteroService) return;
    for (const peerId of this.trysteroService.getConnectedPeers()) {
      if (peerId === exceptPeerId) continue;
      if (kind === 'chat') this.trysteroService.sendChat(envelope, peerId);
      else this.trysteroService.sendControl(envelope, peerId);
    }
  }

  /** Inserts in timestamp order so back-filled history lands in the right place. */
  private insertMessage(msg: ChatMessage, isBackfill: boolean) {
    if (this.messages.some((m) => m.id === msg.id)) return;

    let index = this.messages.length;
    while (index > 0 && this.messages[index - 1].timestamp > msg.timestamp) index--;
    this.messages.splice(index, 0, msg);

    dbService.saveMessage(msg).catch((err) => console.warn('Failed to persist message:', err));
    if (isBackfill) return;
    this.onNewMessageCb?.(this, msg);
    this.notifyChange();
  }

  // --------------------------------------------------------------------------
  // Presence maintenance
  // --------------------------------------------------------------------------

  private startPresenceTimer() {
    this.stopPresenceTimer();
    this.presenceTimer = setInterval(() => {
      if (this.isDestroyed) return;
      if (Date.now() - this.lastHelloBroadcastAt >= HELLO_REANNOUNCE_MS) {
        this.broadcastHello();
      }
      this.pruneStaleParticipants();
    }, PRESENCE_SWEEP_MS);
  }

  private stopPresenceTimer() {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  private pruneStaleParticipants() {
    const now = Date.now();
    let changed = false;

    for (const [participantId, participant] of this.participantsMap.entries()) {
      if (participant.isSelf) continue;
      if (participant.peerId && this.directPeerIds.has(participant.peerId)) continue;

      const lastProof = this.helloSeenAt.get(participantId) ?? participant.lastSeen;
      if (now - lastProof > PARTICIPANT_EVICT_MS && !this.approvedMembers.has(participantId)) {
        this.participantsMap.delete(participantId);
        this.knownHellos.delete(participantId);
        this.helloSeenAt.delete(participantId);
        changed = true;
      } else if (now - lastProof > PARTICIPANT_STALE_MS && participant.status !== 'offline') {
        this.participantsMap.set(participantId, { ...participant, status: 'offline' });
        changed = true;
      }
    }

    if (changed) this.notifyChange();
  }

  private startJoinRetryTimer() {
    if (this.joinRetryTimer || this.roomMode !== 'private') return;
    this.joinRetryTimer = setInterval(() => {
      if (this.isDestroyed || this.isApproved || this.joinRequestAttempts >= JOIN_REQUEST_MAX_ATTEMPTS) {
        this.stopJoinRetryTimer();
        return;
      }
      this.sendJoinRequest();
    }, JOIN_REQUEST_RETRY_MS);
  }

  private stopJoinRetryTimer() {
    if (this.joinRetryTimer) {
      clearInterval(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }
  }

  private async handleIncomingChat(
    envelope: EncryptedNetworkEnvelope,
    rawPeerId: string,
    isBackfill: boolean = false
  ) {
    if (envelope.convId !== this.convId) return;
    if (!this.markProcessed(envelope.packetId)) return;

    if (this.roomMode === 'public') {
      try {
        const keyRec = this.keysMap.get('public-v2');
        if (!keyRec) return;

        const plaintext = await decryptEnvelope(keyRec.key, envelope);
        const payload: PlaintextMessagePayload = JSON.parse(plaintext);
        if (payload.protocol !== 'airthread/2' || payload.convId !== this.convId) return;

        const isSigValid = await verifyPublicMessageSignature(payload);
        if (!isSigValid) {
          console.warn('Invalid public message signature from:', payload.senderId);
          return;
        }

        const isSelf = payload.senderId === this.profile?.participantId;
        const chatMsg: ChatMessage = {
          id: payload.msgId,
          convId: this.convId,
          senderId: payload.senderId,
          sender: payload.sender,
          timestamp: payload.timestamp,
          text: payload.text,
          keyId: 'public-v2',
          keyEpoch: 0,
          isSelf,
          decrypted: true,
          emotion: payload.emotion,
          emotionIntensity: payload.emotionIntensity,
          balloonMode: payload.balloonMode,
          envelope,
        };

        this.rememberEnvelope(envelope);
        this.insertMessage(chatMsg, isBackfill);
        if (!isBackfill) this.forwardEnvelope('chat', envelope, rawPeerId);
      } catch (err) {
        console.warn('Failed to parse public chat message:', err);
      }
      return;
    }

    // Private Room message decryption
    const keyRec = this.keysMap.get(envelope.keyId) || this.keysMap.get('root-v2');
    if (!keyRec) {
      console.warn(`Cannot decrypt message: missing key ${envelope.keyId}`);
      return;
    }

    try {
      const plaintext = await decryptEnvelope(keyRec.key, envelope);
      const payload: PlaintextMessagePayload = JSON.parse(plaintext);
      if (payload.protocol !== 'airthread/2' || payload.convId !== this.convId) return;

      const isSelf = payload.senderId === this.profile?.participantId;
      const chatMsg: ChatMessage = {
        id: payload.msgId,
        convId: this.convId,
        senderId: payload.senderId,
        sender: payload.sender,
        timestamp: payload.timestamp,
        text: payload.text,
        keyId: envelope.keyId,
        keyEpoch: keyRec.epoch,
        isSelf,
        decrypted: true,
        emotion: payload.emotion,
        emotionIntensity: payload.emotionIntensity,
        balloonMode: payload.balloonMode,
        envelope,
      };

      this.rememberEnvelope(envelope);
      this.insertMessage(chatMsg, isBackfill);
      if (!isBackfill) this.forwardEnvelope('chat', envelope, rawPeerId);
    } catch (err) {
      console.warn('Decryption failed for chat message:', err);
    }
  }

  private async handleIncomingControl(envelope: EncryptedNetworkEnvelope, rawPeerId: string) {
    if (envelope.convId !== this.convId) return;
    if (!this.markProcessed(envelope.packetId)) return;

    const keyRec = this.roomMode === 'public'
      ? this.keysMap.get('public-v2')
      : this.keysMap.get(envelope.keyId) || this.keysMap.get('root-v2');

    if (!keyRec) return;

    let packet: any;
    try {
      packet = JSON.parse(await decryptEnvelope(keyRec.key, envelope));
    } catch (err) {
      console.warn('Failed to decrypt control packet:', err);
      return;
    }

    // Roster gossip is regenerated locally rather than relayed verbatim; everything
    // else is passed along so members behind a partial mesh still converge. Only
    // packets that verified are relayed, so bad input is never amplified.
    let shouldForward = false;

    try {
      switch (packet.type) {
        case 'channel_title':
          shouldForward = this.applyChannelTitle(packet as ChannelTitlePacket);
          break;
        case 'join_request':
          shouldForward = await this.handleJoinRequestPacket(packet as JoinRequestPacket);
          break;
        case 'join_decision':
          shouldForward = await this.handleJoinDecisionPacket(packet as JoinDecisionPacket);
          break;
        case 'key':
          shouldForward = await this.handleRekeyPacket(packet as RekeyPacket);
          break;
        case 'roster':
          await this.handleRosterPacket(packet as RosterGossipPacket, rawPeerId);
          break;
        default:
          break;
      }
    } catch (err) {
      console.warn('Failed to handle control packet:', err);
      return;
    }

    if (shouldForward) this.forwardEnvelope('control', envelope, rawPeerId);
  }

  private applyChannelTitle(titlePacket: ChannelTitlePacket): boolean {
    if (titlePacket.convId !== this.convId || !titlePacket.title?.trim()) return false;
    const clean = titlePacket.title.trim();
    // Already applied: accept it but stop the relay here to avoid ping-ponging.
    if (clean === this.channelTitle) return false;

    this.channelTitle = clean;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`aircomic_channel_title_${this.convId}`, clean);
    }
    this.notifyChange();
    return true;
  }

  private async handleJoinRequestPacket(req: JoinRequestPacket): Promise<boolean> {
    if (req.convId !== this.convId) return false;
    if (!(await verifyJoinRequestSignature(req))) return false;

    const senderId = req.sender.participantId;
    // Still worth relaying: another member may not have a direct link to them.
    if (senderId === this.profile?.participantId) return false;
    if (this.approvedMembers.has(senderId)) return true;
    // Only members of the room get to see (and act on) entry requests.
    if (!this.isApproved) return true;

    const pending: PendingJoinRequest = {
      requestId: req.requestId,
      sender: req.sender,
      timestamp: req.timestamp,
      verified: true,
    };

    // Someone we invited ourselves: admit them without prompting.
    if (this.autoApproveIds.has(senderId)) {
      this.autoApproveIds.delete(senderId);
      this.pendingRequestsMap.set(senderId, pending);
      this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
      await this.approveJoinRequest(req.requestId);
      return true;
    }

    if (!this.declinedRequesters.has(senderId)) {
      this.pendingRequestsMap.set(senderId, pending);
      this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
      this.notifyChange();
    }
    return true;
  }

  /** Another member admitted this person, so take the prompt off our screen too. */
  private async handleJoinDecisionPacket(packet: JoinDecisionPacket): Promise<boolean> {
    if (packet.convId !== this.convId) return false;
    if (packet.decision !== 'approved') return false;
    if (!(await verifyJoinDecisionSignature(packet))) return false;
    if (this.roomMode === 'private' && !this.approvedMembers.has(packet.deciderId)) return false;
    if (packet.targetParticipantId === this.profile?.participantId) return true;

    this.approvedMembers.add(packet.targetParticipantId);
    this.declinedRequesters.delete(packet.targetParticipantId);

    const participant = this.participantsMap.get(packet.targetParticipantId);
    if (participant) {
      this.participantsMap.set(packet.targetParticipantId, { ...participant, isApproved: true });
    }

    if (this.pendingRequestsMap.delete(packet.targetParticipantId)) {
      this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
    }
    this.notifyChange();
    return true;
  }

  private async handleRekeyPacket(rekey: RekeyPacket): Promise<boolean> {
    if (rekey.convId !== this.convId || !this.privateKey) return false;
    if (!(await verifyRekeyPacketSignature(rekey))) return false;

    const myParticipantId = this.profile?.participantId;
    if (!myParticipantId) return false;

    dbService.saveRekeyPacket(rekey).catch(() => {});

    // Relay it regardless: members we can reach may not reach the signer directly.
    const myEncryptedKey = rekey.keys ? rekey.keys[myParticipantId] : null;
    if (!myEncryptedKey) return true;

    const decryptedKey = await decryptRekeyPacket(rekey, myParticipantId, this.privateKey);
    if (!decryptedKey) return true;

    const newKeyRec: KeyRecord = {
      keyId: rekey.keyId,
      epoch: rekey.epoch,
      createdAt: rekey.timestamp,
      key: decryptedKey.key,
      signerId: rekey.signerId,
      members: rekey.members || [],
    };
    this.keysMap.set(rekey.keyId, newKeyRec);

    // Gossip can deliver epochs out of order; never step backwards onto an older key.
    if (rekey.epoch >= this.activeEpoch) {
      this.activeKeyId = rekey.keyId;
      this.activeEpoch = rekey.epoch;
    }

    this.isApproved = true;
    this.stopJoinRetryTimer();

    (rekey.members || []).forEach((memberId) => {
      this.approvedMembers.add(memberId);
      this.declinedRequesters.delete(memberId);
      this.pendingRequestsMap.delete(memberId);
      const p = this.participantsMap.get(memberId);
      if (p) this.participantsMap.set(memberId, { ...p, isApproved: true });
    });

    const self = this.participantsMap.get(myParticipantId);
    if (self) this.participantsMap.set(myParticipantId, { ...self, isApproved: true });

    this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
    this.notifyChange();
    return true;
  }

  // --------------------------------------------------------------------------
  // History synchronisation
  // --------------------------------------------------------------------------

  private async sendStateSummaryTo(peerId: string) {
    if (!this.profile || !this.signingPrivateKey || !this.trysteroService) return;
    if (this.roomMode === 'private' && !this.isApproved) return;

    try {
      const recentMessageIds = this.messages.slice(-MAX_SYNC_MESSAGE_IDS).map((m) => m.id);
      const newest = this.messages.length ? this.messages[this.messages.length - 1].timestamp : 0;

      const summary = await createSignedStateSummary(
        this.convId,
        this.profile.participantId,
        this.activeEpoch,
        this.activeKeyId,
        '',
        [],
        newest,
        this.messages.length,
        this.signingPrivateKey,
        recentMessageIds
      );

      this.trysteroService.sendStateSummary(summary, peerId);
    } catch (err) {
      console.warn('Failed to send state summary:', err);
    }
  }

  private async handleStateSummary(packet: StateSummaryPacket, peerId: string) {
    if (packet.convId !== this.convId || !this.profile || !this.trysteroService) return;

    const sender = this.participantsMap.get(packet.participantId);
    if (!sender?.signingPublicKey) {
      // Their hello has not landed yet; replay this once we can verify it.
      this.deferredSummaries.set(packet.participantId, { packet, peerId });
      return;
    }
    if (!(await verifyStateSummarySignature(packet, sender.signingPublicKey))) return;

    const wantedMessageIds = (packet.recentMessageIds || [])
      .filter((id) => !this.processedPacketIds.has(id))
      .slice(0, MAX_SYNC_MESSAGE_IDS);

    if (wantedMessageIds.length === 0) return;

    const request: StateRequestPacket = {
      type: 'state_request',
      protocol: 'airthread/2',
      convId: this.convId,
      requesterId: this.profile.participantId,
      wantedControlPacketIds: [],
      wantedMessageIds,
      timestamp: Date.now(),
    };
    this.trysteroService.sendStateRequest(request, peerId);
  }

  private async handleStateRequest(packet: StateRequestPacket, peerId: string) {
    if (packet.convId !== this.convId || !this.profile || !this.trysteroService) return;
    if (this.roomMode === 'private' && !this.approvedMembers.has(packet.requesterId)) return;

    const wanted = packet.wantedMessageIds || [];
    if (wanted.length === 0) return;

    const available: EncryptedNetworkEnvelope[] = [];
    for (const id of wanted) {
      const envelope = this.envelopeCache.get(id) || this.messages.find((m) => m.id === id)?.envelope;
      if (envelope) available.push(envelope);
    }
    if (available.length === 0) return;

    for (let i = 0; i < available.length && i < MAX_CHUNK_ENVELOPES * MAX_CHUNKS_PER_REQUEST; i += MAX_CHUNK_ENVELOPES) {
      const chunk: StateChunkPacket = {
        type: 'state_chunk',
        protocol: 'airthread/2',
        convId: this.convId,
        responderId: this.profile.participantId,
        controlPackets: [],
        messageEnvelopes: available.slice(i, i + MAX_CHUNK_ENVELOPES),
        timestamp: Date.now(),
      };
      this.trysteroService.sendStateChunk(chunk, peerId);
    }
  }

  private async handleStateChunk(packet: StateChunkPacket, peerId: string) {
    if (packet.convId !== this.convId) return;
    for (const envelope of packet.messageEnvelopes || []) {
      await this.handleIncomingChat(envelope, peerId, true);
    }
    this.notifyChange();
  }

  // --------------------------------------------------------------------------
  // Membership
  // --------------------------------------------------------------------------

  public async sendJoinRequest(targetPeerId?: string): Promise<boolean> {
    if (!this.profile || !this.signingPrivateKey || !this.rootKey || !this.trysteroService) return false;
    if (this.isApproved || this.roomMode !== 'private') return false;

    try {
      this.joinRequestAttempts += 1;
      const req = await createSignedJoinRequest(
        this.convId,
        this.profile.participantId,
        this.profile.screenName,
        this.profile.publicKeyBase64,
        this.profile.signingPublicKeyBase64,
        this.signingPrivateKey,
        this.profile.contactInfo
      );

      return await this.sendControlPacket(
        req,
        targetPeerId ? [targetPeerId] : undefined,
        [],
        req.requestId
      );
    } catch (err) {
      console.warn('Failed to send join request:', err);
      return false;
    }
  }

  public async approveJoinRequest(requestId: string): Promise<boolean> {
    const req = this.pendingJoinRequests.find((r) => r.requestId === requestId);
    if (!req || !this.profile || !this.signingPrivateKey) return false;

    const targetId = req.sender.participantId;
    this.pendingRequestsMap.delete(targetId);
    this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
    this.approvedMembers.add(targetId);
    this.declinedRequesters.delete(targetId);

    // Take key material straight from the signed request: the rekey below only
    // carries an epoch key for participants present in the map.
    const existing = this.participantsMap.get(targetId);
    this.participantsMap.set(targetId, {
      participantId: targetId,
      peerId: existing?.peerId,
      publicKey: normalizePublicKey(req.sender.publicKey),
      signingPublicKey: normalizePublicKey(req.sender.signingPublicKey),
      screenName: req.sender.screenName,
      avatarName: existing?.avatarName || 'Armando',
      contactInfo: req.sender.contactInfo ?? existing?.contactInfo,
      lastSeen: Date.now(),
      isSelf: false,
      status: existing?.status || 'online',
      isApproved: true,
    });

    const ok = await this.rekeyConversation();
    // Clear the prompt on every other member's screen, including those that could
    // not decrypt the rekey packet themselves.
    await this.broadcastJoinDecision(req.requestId, targetId, 'approved');
    return ok;
  }

  public declineJoinRequest(requestId: string): void {
    const req = this.pendingJoinRequests.find((r) => r.requestId === requestId);
    if (req) {
      // Local only: another member may still want to admit them.
      this.declinedRequesters.add(req.sender.participantId);
      this.pendingRequestsMap.delete(req.sender.participantId);
    }
    this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
    this.notifyChange();
  }

  private async broadcastJoinDecision(
    requestId: string,
    targetParticipantId: string,
    decision: 'approved' | 'declined'
  ) {
    if (!this.profile || !this.signingPrivateKey) return;
    try {
      const packet = await createSignedJoinDecision(
        this.convId,
        requestId,
        targetParticipantId,
        decision,
        this.profile.participantId,
        this.profile.screenName,
        this.profile.signingPublicKeyBase64,
        this.signingPrivateKey
      );
      await this.sendControlPacket(packet);
    } catch (err) {
      console.warn('Failed to broadcast join decision:', err);
    }
  }

  public async removeParticipant(participantId: string, _screenName?: string): Promise<boolean> {
    this.approvedMembers.delete(participantId);
    this.participantsMap.delete(participantId);
    this.knownHellos.delete(participantId);
    this.helloSeenAt.delete(participantId);
    this.autoApproveIds.delete(participantId);
    this.notifyChange();
    return this.rekeyConversation();
  }

  public async rekeyConversation(): Promise<boolean> {
    if (this.roomMode === 'public') return true;
    if (!this.profile || !this.signingPrivateKey || !this.trysteroService) return false;

    this.isRekeying = true;
    this.notifyChange();

    try {
      const newEpoch = this.activeEpoch + 1;
      const newKeyId = `epoch-${newEpoch}-${crypto.randomUUID().slice(0, 8)}`;
      const { key: newRawKey, rawBase64Url } = await generateNewConversationKey();

      const memberIds: string[] = [];
      const participantsPubMap = new Map<string, { publicKey: string }>();

      for (const [partId, part] of this.participantsMap.entries()) {
        if (part.isApproved || this.approvedMembers.has(partId) || partId === this.profile.participantId) {
          memberIds.push(partId);
          participantsPubMap.set(partId, { publicKey: part.publicKey });
        }
      }

      // Export raw key buffer for asymmetric encryption
      const rawKeyBuffer = await crypto.subtle.exportKey('raw', newRawKey);

      const rekeyPacket = await createSignedRekeyPacket(
        rawKeyBuffer,
        crypto.randomUUID(),
        newKeyId,
        newEpoch,
        this.activeKeyId,
        memberIds,
        participantsPubMap,
        this.profile.participantId,
        this.profile.publicKeyBase64,
        this.profile.signingPublicKeyBase64,
        this.signingPrivateKey,
        this.profile.screenName,
        this.convId,
        'rekey'
      );

      const rootKeyToUse = this.rootKey;
      const rootKeyId = 'root-v2';
      if (!rootKeyToUse) throw new Error('No root key for rekeying');

      const envelope = await createEncryptedEnvelope(
        rootKeyToUse,
        this.convId,
        rekeyPacket.packetId,
        rootKeyId,
        this.profile.participantId,
        JSON.stringify(rekeyPacket),
        rekeyPacket.timestamp
      );

      const newKeyRec: KeyRecord = {
        keyId: newKeyId,
        epoch: newEpoch,
        createdAt: rekeyPacket.timestamp,
        key: newRawKey,
        rawBase64Url,
        signerId: this.profile.participantId,
        members: memberIds,
      };

      this.keysMap.set(newKeyId, newKeyRec);
      this.activeKeyId = newKeyId;
      this.activeEpoch = newEpoch;
      this.isApproved = true;
      this.stopJoinRetryTimer();

      this.trysteroService.sendControl(envelope);
      return true;
    } catch (err) {
      console.error('Rekey failed:', err);
      return false;
    } finally {
      this.isRekeying = false;
      this.notifyChange();
    }
  }

  public async sendMessage(
    text: string,
    options?: { emotion?: number; emotionIntensity?: number; balloonMode?: 'say' | 'whisper' | 'think' | 'action' }
  ): Promise<boolean> {
    if (!text.trim() || !this.profile || !this.trysteroService) return false;

    if (this.roomMode === 'public') {
      if (!this.signingPrivateKey || !this.rootKey) return false;
      try {
        const msgId = crypto.randomUUID();
        const payload = await createSignedPublicMessagePayload(
          this.convId,
          this.publicRoomId || '',
          msgId,
          this.profile.participantId,
          this.profile.screenName,
          this.profile.avatarName || 'Armando',
          this.profile.signingPublicKeyBase64,
          this.signingPrivateKey,
          text.trim(),
          options?.emotion || 0,
          options?.emotionIntensity || 0.5,
          options?.balloonMode || 'say'
        );

        const envelope = await createEncryptedEnvelope(
          this.rootKey,
          this.convId,
          msgId,
          'public-v2',
          this.profile.participantId,
          JSON.stringify(payload),
          payload.timestamp
        );

        this.markProcessed(payload.msgId);
        this.rememberEnvelope(envelope);
        const chatMsg: ChatMessage = {
          id: payload.msgId,
          convId: this.convId,
          senderId: this.profile.participantId,
          sender: payload.sender,
          timestamp: payload.timestamp,
          text: payload.text,
          keyId: 'public-v2',
          keyEpoch: 0,
          isSelf: true,
          decrypted: true,
          emotion: options?.emotion,
          emotionIntensity: options?.emotionIntensity,
          balloonMode: options?.balloonMode,
          envelope,
        };

        this.insertMessage(chatMsg, false);
        this.trysteroService.sendChat(envelope);
        return true;
      } catch (err) {
        console.error('Failed to send public message:', err);
        return false;
      }
    }

    // Private room message
    const keyRec = this.keysMap.get(this.activeKeyId) || this.keysMap.get('root-v2');
    if (!keyRec) {
      console.error('No encryption key for message');
      return false;
    }

    const msgId = crypto.randomUUID();
    const payload: PlaintextMessagePayload = {
      type: 'message',
      protocol: 'airthread/2',
      msgId,
      convId: this.convId,
      senderId: this.profile.participantId,
      sender: {
        screenName: this.profile.screenName,
        avatarName: this.profile.avatarName || 'Armando',
        signingPublicKey: normalizePublicKey(this.profile.signingPublicKeyBase64),
        contactInfo: this.profile.contactInfo,
      },
      timestamp: Date.now(),
      text: text.trim(),
      keyId: keyRec.keyId,
      emotion: options?.emotion,
      emotionIntensity: options?.emotionIntensity,
      balloonMode: options?.balloonMode,
    };

    try {
      const envelope = await createEncryptedEnvelope(
        keyRec.key,
        this.convId,
        msgId,
        keyRec.keyId,
        this.profile.participantId,
        JSON.stringify(payload),
        payload.timestamp
      );

      this.markProcessed(msgId);
      this.rememberEnvelope(envelope);
      const chatMsg: ChatMessage = {
        id: msgId,
        convId: this.convId,
        senderId: this.profile.participantId,
        sender: payload.sender,
        timestamp: payload.timestamp,
        text: payload.text,
        keyId: keyRec.keyId,
        keyEpoch: keyRec.epoch,
        isSelf: true,
        decrypted: true,
        emotion: options?.emotion,
        emotionIntensity: options?.emotionIntensity,
        balloonMode: options?.balloonMode,
        envelope,
      };

      this.insertMessage(chatMsg, false);
      this.trysteroService.sendChat(envelope);
      return true;
    } catch (err) {
      console.error('Failed to send encrypted message:', err);
      return false;
    }
  }

  private handleIncomingQuickMessage(payload: QuickMessagePayload, _viaPeerId: string) {
    if (this.isDestroyed || !this.profile) return;
    if (payload.recipientParticipantId === this.profile.participantId) {
      this.onQuickMessageCb?.(payload);
    }
  }

  public sendQuickMessage(payload: QuickMessagePayload, targetPeerIdOrParticipantId?: string): boolean {
    if (!this.trysteroService) return false;
    let targetPeerId: string | undefined = targetPeerIdOrParticipantId;
    if (targetPeerIdOrParticipantId) {
      for (const [pId, partId] of this.peerIdToParticipantId.entries()) {
        if (partId === targetPeerIdOrParticipantId) {
          targetPeerId = pId;
          break;
        }
      }
    }
    this.trysteroService.sendQuickMessage(payload, targetPeerId);
    return true;
  }

  public async updateChannelTitle(newTitle: string): Promise<boolean> {
    const cleanTitle = newTitle.trim() || getRandomChannelTitle();
    this.channelTitle = cleanTitle;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`aircomic_channel_title_${this.convId}`, cleanTitle);
    }
    this.notifyChange();

    if (!this.profile || !this.trysteroService) return true;

    const titlePacket: ChannelTitlePacket = {
      type: 'channel_title',
      protocol: 'airthread/2',
      convId: this.convId,
      title: cleanTitle,
      setterId: this.profile.participantId,
      setterScreenName: this.profile.screenName,
      timestamp: Date.now(),
    };

    return this.sendControlPacket(titlePacket);
  }

  public async clearHistory(): Promise<void> {
    await dbService.clearMessages(this.convId);
    this.messages = [];
    this.processedPacketIds.clear();
    this.processedPacketOrder = [];
    this.envelopeCache.clear();
    this.notifyChange();
  }

  public async provideRoomSecret(input: string): Promise<void> {
    let secret = input.trim();
    if (secret.includes('#secret=')) {
      const match = secret.match(/secret=([A-Za-z0-9_-]+)/);
      if (match && match[1]) secret = match[1];
    } else if (secret.includes('secret=')) {
      const match = secret.match(/secret=([A-Za-z0-9_-]+)/);
      if (match && match[1]) secret = match[1];
    }

    if (secret && this.profile && this.privateKey && this.signingPrivateKey) {
      this.roomSecret = secret;
      this.isSecretMissing = false;
      this.isInitialized = false;
      await dbService.saveConversationMetadata(this.convId, secret, this.activeEpoch, this.activeKeyId);
      this.stopPresenceTimer();
      this.stopJoinRetryTimer();
      this.joinRequestAttempts = 0;
      if (this.trysteroService) {
        this.trysteroService.disconnect();
      }
      await this.init(this.profile, this.privateKey, this.signingPrivateKey);
    }
  }

  public refreshRelayStatuses(): RelaySocketStatus[] {
    if (this.trysteroService) {
      this.relayStatuses = this.trysteroService.getRelayStatuses();
      const anyConnected = this.relayStatuses.some((s) => s.status === 'connected');
      const allDisconnectedOrError =
        this.relayStatuses.length > 0 &&
        this.relayStatuses.every((s) => s.status === 'disconnected' || s.status === 'error');

      if (anyConnected) {
        this.connectionStatus = 'connected';
      } else if (allDisconnectedOrError) {
        this.connectionStatus = 'disconnected';
      } else {
        this.connectionStatus = 'connecting';
      }
      this.notifyChange();
    }
    return this.relayStatuses;
  }

  public async reconnectSignaling(): Promise<void> {
    await this.connectTrystero();
    this.notifyChange();
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.stopPresenceTimer();
    this.stopJoinRetryTimer();
    if (this.trysteroService) {
      try {
        this.trysteroService.disconnect();
      } catch (err) {
        console.warn('Error during room session teardown:', err);
      }
      this.trysteroService = null;
    }
    this.participantsMap.clear();
    this.pendingRequestsMap.clear();
    this.sentHelloPeers.clear();
    this.knownHellos.clear();
    this.helloSeenAt.clear();
    this.seenHelloNonces.clear();
    this.seenHelloNonceOrder = [];
    this.directPeerIds.clear();
    this.envelopeCache.clear();
    this.deferredSummaries.clear();
  }
}
