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
  createEncryptedEnvelope,
  decryptEnvelope,
  normalizePublicKey,
  getPublicKeyFingerprint,
} from './crypto';
import { getOrInitChannelTitle, getRandomChannelTitle } from '../utils/channelNameGenerator';
import { dbService } from './db';
import { TrysteroService } from './trystero';

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

  private approvedMembers: Set<string> = new Set();
  private processedPacketIds: Set<string> = new Set();
  private pendingRequestsMap: Map<string, PendingJoinRequest> = new Map();
  private peerIdToParticipantId: Map<string, string> = new Map();
  private sentHelloPeers: Set<string> = new Set();
  private lastJoinRequestTime: number = 0;

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

    // Connect signaling & WebRTC
    await this.connectTrystero();
    this.notifyChange();
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

  public async broadcastHello(): Promise<void> {
    if (!this.profile || !this.signingPrivateKey || !this.trysteroService) return;
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
      this.trysteroService.sendHello(hello);
    } catch (err) {
      console.warn('Failed to broadcast updated hello:', err);
    }
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

    this.trysteroService = new TrysteroService(signalingRoomId, signalingPassword);

    this.trysteroService.setOnPeerJoin((peerId) => this.handlePeerJoin(peerId));
    this.trysteroService.setOnPeerLeave((peerId) => this.handlePeerLeave(peerId));
    this.trysteroService.setOnHello((packet, peerId) => this.handleIncomingHello(packet, peerId));
    this.trysteroService.setOnControl((envelope, peerId) => this.handleIncomingControl(envelope, peerId));
    this.trysteroService.setOnChat((envelope, peerId) => this.handleIncomingChat(envelope, peerId));

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
    this.connectedPeersCount = this.trysteroService.getConnectedPeers().length;
    this.relayStatuses = this.trysteroService.getRelayStatuses();

    if (!this.sentHelloPeers.has(peerId)) {
      this.sentHelloPeers.add(peerId);
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
        this.trysteroService.sendHello(hello, peerId);
      } catch (err) {
        console.warn('Failed to send signed hello on peer join:', err);
      }
    }

    if (!this.isApproved && this.roomMode === 'private') {
      const now = Date.now();
      if (now - this.lastJoinRequestTime > 4000) {
        this.lastJoinRequestTime = now;
        this.sendJoinRequest();
      }
    }
    this.notifyChange();
  }

  private handlePeerLeave(peerId: string) {
    if (!this.trysteroService) return;
    this.connectedPeersCount = this.trysteroService.getConnectedPeers().length;
    this.relayStatuses = this.trysteroService.getRelayStatuses();
    this.sentHelloPeers.delete(peerId);

    const partId = this.peerIdToParticipantId.get(peerId);
    if (partId) {
      const existing = this.participantsMap.get(partId);
      if (existing) {
        this.participantsMap.set(partId, { ...existing, status: 'offline' });
      }
    }
    this.notifyChange();
  }

  private async handleIncomingHello(hello: IdentityHelloPacket, rawPeerId: string) {
    if (hello.convId !== this.convId) return;
    const valid = await verifyHelloSignature(hello);
    if (!valid) return;

    this.peerIdToParticipantId.set(rawPeerId, hello.participantId);
    const isApprovedParticipant = this.roomMode === 'public' || this.approvedMembers.has(hello.participantId);

    this.participantsMap.set(hello.participantId, {
      participantId: hello.participantId,
      peerId: rawPeerId,
      publicKey: normalizePublicKey(hello.publicKey),
      signingPublicKey: normalizePublicKey(hello.signingPublicKey),
      screenName: hello.screenName,
      avatarName: hello.avatarName || 'Armando',
      contactInfo: hello.contactInfo,
      lastSeen: Date.now(),
      isSelf: hello.participantId === this.profile?.participantId,
      status: 'online',
      isApproved: isApprovedParticipant,
    });

    if (!this.sentHelloPeers.has(rawPeerId) && this.profile && this.signingPrivateKey && this.trysteroService) {
      this.sentHelloPeers.add(rawPeerId);
      createSignedHello(
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
      ).then((h) => this.trysteroService?.sendHello(h, rawPeerId)).catch(() => {});
    }

    // If we are approved / owner, synchronize channel title to newly joined peer
    if (this.isApproved && this.profile && this.trysteroService) {
      const titleKey = this.roomMode === 'public'
        ? this.keysMap.get('public-v2')?.key
        : this.rootKey;
      const titleKeyId = this.roomMode === 'public' ? 'public-v2' : 'root-v2';

      if (titleKey && this.channelTitle) {
        const titlePacket: ChannelTitlePacket = {
          type: 'channel_title',
          protocol: 'airthread/2',
          convId: this.convId,
          title: this.channelTitle,
          setterId: this.profile.participantId,
          setterScreenName: this.profile.screenName,
          timestamp: Date.now(),
        };
        createEncryptedEnvelope(
          titleKey,
          this.convId,
          crypto.randomUUID(),
          titleKeyId,
          this.profile.participantId,
          JSON.stringify(titlePacket),
          titlePacket.timestamp
        ).then((env) => {
          this.trysteroService?.sendControl(env, rawPeerId);
        }).catch((err) => {
          console.warn('Failed to sync channel title on peer hello:', err);
        });
      }
    }

    // If we are not approved in a private room, send join request
    if (!this.isApproved && this.roomMode === 'private') {
      this.sendJoinRequest();
    }

    this.notifyChange();
  }

  private async handleIncomingChat(envelope: EncryptedNetworkEnvelope, rawPeerId: string) {
    if (this.processedPacketIds.has(envelope.packetId)) return;
    this.processedPacketIds.add(envelope.packetId);

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
        };

        this.messages.push(chatMsg);
        await dbService.saveMessage(chatMsg);
        this.onNewMessageCb?.(this, chatMsg);
        this.notifyChange();
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
      };

      this.messages.push(chatMsg);
      await dbService.saveMessage(chatMsg);
      this.onNewMessageCb?.(this, chatMsg);
      this.notifyChange();
    } catch (err) {
      console.warn('Decryption failed for chat message:', err);
    }
  }

  private async handleIncomingControl(envelope: EncryptedNetworkEnvelope, rawPeerId: string) {
    if (this.processedPacketIds.has(envelope.packetId)) return;
    this.processedPacketIds.add(envelope.packetId);

    const keyRec = this.roomMode === 'public'
      ? this.keysMap.get('public-v2')
      : this.keysMap.get(envelope.keyId) || this.keysMap.get('root-v2');

    if (!keyRec) return;

    try {
      const plaintext = await decryptEnvelope(keyRec.key, envelope);
      const packet = JSON.parse(plaintext);

      if (packet.type === 'channel_title') {
        const titlePacket = packet as ChannelTitlePacket;
        if (titlePacket.convId === this.convId && titlePacket.title?.trim()) {
          const clean = titlePacket.title.trim();
          this.channelTitle = clean;
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(`aircomic_channel_title_${this.convId}`, clean);
          }
          this.notifyChange();
        }
      } else if (packet.type === 'join_request') {
        const req: JoinRequestPacket = packet as JoinRequestPacket;
        if (req.convId !== this.convId) return;

        const valid = await verifyJoinRequestSignature(req);
        if (!valid) return;

        const reqSenderId = req.sender.participantId;
        if (reqSenderId === this.profile?.participantId) return;
        if (this.approvedMembers.has(reqSenderId)) return;

        this.pendingRequestsMap.set(reqSenderId, {
          requestId: req.requestId,
          sender: req.sender,
          timestamp: req.timestamp,
          verified: true,
        });
        this.pendingJoinRequests = Array.from(this.pendingRequestsMap.values());
        this.notifyChange();
      } else if (packet.type === 'key') {
        const rekey = packet as RekeyPacket;
        if (rekey.convId !== this.convId || !this.privateKey) return;
        const valid = await verifyRekeyPacketSignature(rekey);
        if (!valid) return;

        const myParticipantId = this.profile?.participantId;
        if (!myParticipantId) return;

        const myEncryptedKey = rekey.keys ? rekey.keys[myParticipantId] : null;
        if (myEncryptedKey) {
          const decryptedKey = await decryptRekeyPacket(rekey, myParticipantId, this.privateKey);
          if (decryptedKey) {
            const newKeyRec: KeyRecord = {
              keyId: rekey.keyId,
              epoch: rekey.epoch,
              createdAt: rekey.timestamp,
              key: decryptedKey.key,
              signerId: rekey.signerId,
              members: rekey.members || [],
            };
            this.keysMap.set(rekey.keyId, newKeyRec);
            this.activeKeyId = rekey.keyId;
            this.activeEpoch = rekey.epoch;
            this.isApproved = true;

            (rekey.members || []).forEach((memberId) => {
              this.approvedMembers.add(memberId);
              const p = this.participantsMap.get(memberId);
              if (p) this.participantsMap.set(memberId, { ...p, isApproved: true });
            });

            this.pendingJoinRequests = [];
            this.pendingRequestsMap.clear();
            this.notifyChange();
          }
        }
      }
    } catch (err) {
      console.warn('Failed to handle control packet:', err);
    }
  }

  public async sendJoinRequest(): Promise<boolean> {
    if (!this.profile || !this.signingPrivateKey || !this.rootKey || !this.trysteroService) return false;
    try {
      const req = await createSignedJoinRequest(
        this.convId,
        this.profile.participantId,
        this.profile.screenName,
        this.profile.publicKeyBase64,
        this.profile.signingPublicKeyBase64,
        this.signingPrivateKey,
        this.profile.contactInfo
      );

      const envelope = await createEncryptedEnvelope(
        this.rootKey,
        this.convId,
        req.requestId,
        'root-v2',
        this.profile.participantId,
        JSON.stringify(req),
        req.timestamp
      );

      this.trysteroService.sendControl(envelope);
      return true;
    } catch (err) {
      console.warn('Failed to send join request:', err);
      return false;
    }
  }

  public async approveJoinRequest(requestId: string): Promise<boolean> {
    const req = this.pendingJoinRequests.find((r) => r.requestId === requestId);
    if (!req || !this.profile || !this.signingPrivateKey) return false;

    this.pendingJoinRequests = this.pendingJoinRequests.filter((r) => r.requestId !== requestId);
    this.pendingRequestsMap.delete(req.sender.participantId);
    this.approvedMembers.add(req.sender.participantId);

    const existingPart = this.participantsMap.get(req.sender.participantId);
    if (existingPart) {
      this.participantsMap.set(req.sender.participantId, { ...existingPart, isApproved: true });
    }

    return this.rekeyConversation();
  }

  public declineJoinRequest(requestId: string): void {
    const req = this.pendingJoinRequests.find((r) => r.requestId === requestId);
    if (req) {
      this.pendingRequestsMap.delete(req.sender.participantId);
    }
    this.pendingJoinRequests = this.pendingJoinRequests.filter((r) => r.requestId !== requestId);
    this.notifyChange();
  }

  public async removeParticipant(participantId: string, _screenName?: string): Promise<boolean> {
    this.approvedMembers.delete(participantId);
    this.participantsMap.delete(participantId);
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

        this.processedPacketIds.add(payload.msgId);
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
        };

        this.messages.push(chatMsg);
        await dbService.saveMessage(chatMsg);
        this.trysteroService.sendChat(envelope);
        this.notifyChange();
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

      this.processedPacketIds.add(msgId);
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
      };

      this.messages.push(chatMsg);
      await dbService.saveMessage(chatMsg);
      this.trysteroService.sendChat(envelope);
      this.notifyChange();
      return true;
    } catch (err) {
      console.error('Failed to send encrypted message:', err);
      return false;
    }
  }

  public async updateChannelTitle(newTitle: string): Promise<boolean> {
    const cleanTitle = newTitle.trim() || getRandomChannelTitle();
    this.channelTitle = cleanTitle;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`aircomic_channel_title_${this.convId}`, cleanTitle);
    }
    this.notifyChange();

    if (!this.profile || !this.trysteroService) return true;

    const titleKey = this.roomMode === 'public'
      ? this.keysMap.get('public-v2')?.key
      : this.rootKey;

    if (!titleKey) return true;

    const titlePacket: ChannelTitlePacket = {
      type: 'channel_title',
      protocol: 'airthread/2',
      convId: this.convId,
      title: cleanTitle,
      setterId: this.profile.participantId,
      setterScreenName: this.profile.screenName,
      timestamp: Date.now(),
    };

    try {
      const envelope = await createEncryptedEnvelope(
        titleKey,
        this.convId,
        crypto.randomUUID(),
        this.roomMode === 'public' ? 'public-v2' : 'root-v2',
        this.profile.participantId,
        JSON.stringify(titlePacket),
        titlePacket.timestamp
      );
      this.trysteroService.sendControl(envelope);
      return true;
    } catch (err) {
      console.warn('Failed to send channel title control envelope:', err);
      return false;
    }
  }

  public async clearHistory(): Promise<void> {
    await dbService.clearMessages(this.convId);
    this.messages = [];
    this.processedPacketIds.clear();
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
  }
}
