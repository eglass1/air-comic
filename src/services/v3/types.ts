/**
 * airthread/3 wire types -- implementation plan [X-05].
 *
 * Every inner packet carries the signer's ECDSA public key and a signature, and
 * every verifier re-derives the claimed participantId from that key. v2 applied
 * that rule to some packets only.
 */

import type { PROTOCOL, EXT_TRANSPORT, EXT_PUBLIC_ROOMS, EXT_PRESENCE } from './constants';

export type Protocol = typeof PROTOCOL;
export type TransportExt = typeof EXT_TRANSPORT;
export type PublicRoomsExt = typeof EXT_PUBLIC_ROOMS;
export type PresenceExt = typeof EXT_PRESENCE;

export type RoomMode = 'private' | 'public';
export type PacketClass = 'chat' | 'control' | 'metadata' | 'system';
export type BalloonMode = 'say' | 'whisper' | 'think' | 'action';
export type PresenceStatus = 'online' | 'away' | 'offline';
export type MetadataPolicy = 'members' | 'creator';
export type HistoryPolicy = 'from_admission' | 'share_history';
export type RekeyAction = 'genesis_epoch' | 'add' | 'remove' | 'rekey' | 'reshare';

export interface ContactInfo {
  info?: string;
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
}

// ============================================================================
// TRANSPORT ENVELOPE  [X-03]
// ============================================================================

export interface RoomEnvelope {
  protocol: Protocol;
  extension: TransportExt;
  type: 'room_envelope';
  convId: string;
  packetId: string;
  roomMode: RoomMode;
  packetClass: PacketClass;
  keyId: string;
  senderId: string;
  senderSigningPublicKey: string;
  timestamp: number;
  /** Base64URL 12 bytes for private rooms; '' for public rooms [L-11]. */
  iv: string;
  /** Base64URL ciphertext, or Base64URL(UTF8(canonical payload)) when public. */
  data: string;
  signature: string;
}

// ============================================================================
// INNER PACKETS
// ============================================================================

export interface MessagePayload {
  type: 'message';
  protocol: Protocol;
  roomMode: RoomMode;
  msgId: string;
  convId: string;
  publicRoomId?: string;
  senderId: string;
  senderSigningPublicKey: string;
  sender: {
    screenName: string;
    avatarName?: string;
    contactInfo?: ContactInfo;
  };
  timestamp: number;
  text: string;
  emotion?: number;
  emotionIntensity?: number;
  balloonMode?: BalloonMode;
  requiredExtensions?: string[];
  /** Always present in v3 -- private messages are signed too [PR-02][O-02]. */
  signature: string;
}

/** Chain root. New in v3; the v2 protocol had none [L-04]. */
export interface RoomGenesisPacket {
  type: 'room_genesis';
  protocol: Protocol;
  convId: string;
  packetId: string;
  creatorId: string;
  creatorSigningPublicKey: string;
  creatorScreenName: string;
  createdAt: number;
  metadataPolicy: MetadataPolicy;
  historyPolicy: HistoryPolicy;
  requiredExtensions?: string[];
  signature: string;
}

export interface RekeyPacket {
  type: 'key';
  protocol: Protocol;
  convId: string;
  packetId: string;
  keyId: string;
  epoch: number;
  parentPacketId: string;
  parentKeyId: string;
  action: RekeyAction;
  targetParticipantId?: string;
  targetScreenName?: string;
  targetAvatarName?: string;
  signerId: string;
  signerSigningPublicKey: string;
  signerScreenName: string;
  /** Carried beside the screen name so an admitted member can be drawn as
   *  themselves rather than as the default character [PR-04]. */
  signerAvatarName?: string;
  timestamp: number;
  /** Sorted, deduplicated participantIds. */
  members: string[];
  /** participantId -> Base64URL(RSA-OAEP(raw 32-byte epoch key)). */
  keys: Record<string, string>;
  requiredExtensions?: string[];
  signature: string;
}

/** Strong removal: rotates the room secret as well as the epoch key [X-08][PR-07]. */
export interface CapabilityRotationPacket {
  type: 'capability_rotation';
  protocol: Protocol;
  convId: string;
  packetId: string;
  generation: number;
  newEpoch: number;
  newKeyId: string;
  parentPacketId: string;
  parentKeyId: string;
  removedParticipantId: string;
  members: string[];
  /** participantId -> Base64URL(RSA-OAEP(JSON{roomSecret, epochKey})). */
  wrapped: Record<string, string>;
  signerId: string;
  signerSigningPublicKey: string;
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

export interface JoinRequestPacket {
  type: 'join_request';
  protocol: Protocol;
  requestId: string;
  convId: string;
  sender: {
    participantId: string;
    screenName: string;
    avatarName?: string;
    publicKey: string;
    signingPublicKey: string;
    contactInfo?: ContactInfo;
  };
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

export interface JoinDecisionPacket {
  type: 'join_decision';
  protocol: Protocol;
  convId: string;
  requestId: string;
  targetParticipantId: string;
  decision: 'approved' | 'declined';
  deciderId: string;
  deciderScreenName: string;
  deciderSigningPublicKey: string;
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

/** Replaces v2's unsigned ChannelTitlePacket and the unused metadata packet [M-01][O-18]. */
export interface RoomMetadataPacket {
  type: 'room_metadata';
  protocol: Protocol;
  convId: string;
  publicRoomId?: string;
  title?: string;
  description?: string;
  setterId: string;
  setterSigningPublicKey: string;
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

/** WebRTC only in v3 -- there is no roster gossip [H-03][W-06]. */
export interface IdentityHelloPacket {
  type: 'hello';
  protocol: Protocol;
  convId: string;
  peerId: string;
  participantId: string;
  screenName: string;
  avatarName?: string;
  publicKey: string;
  signingPublicKey: string;
  contactInfo?: ContactInfo;
  capabilities: string[];
  nonce: string;
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

/** Signed targeted recovery, replacing v2's unsigned StateRequestPacket [H-02][O-07]. */
export interface RecoveryRequestPacket {
  type: 'recovery_request';
  protocol: Protocol;
  convId: string;
  wantedPacketIds: string[];
  requesterId: string;
  requesterSigningPublicKey: string;
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

// ============================================================================
// PRESENCE, INBOX, INVITATIONS
// ============================================================================

/** Now signed, closing v2 [O-06] [N-02]. */
export interface SealedEnvelope {
  type: 'sealed';
  protocol: Protocol;
  extension: PresenceExt;
  recipientParticipantId: string;
  senderParticipantId: string;
  senderSigningPublicKey: string;
  encryptedKey: string;
  iv: string;
  data: string;
  timestamp: number;
  signature: string;
}

export interface PresencePacket {
  type: 'presence';
  protocol: Protocol;
  extension: PresenceExt;
  participantId: string;
  screenName: string;
  avatarName?: string;
  publicKey: string;
  signingPublicKey: string;
  status: PresenceStatus;
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

/** Distributes the issuer's presence capability to an authorised contact [X-11]. */
export interface ContactCapabilityPacket {
  type: 'contact_capability';
  protocol: Protocol;
  extension: PresenceExt;
  issuerId: string;
  issuerSigningPublicKey: string;
  issuerScreenName: string;
  capability: string;
  generation: number;
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

export interface RoomInvitePayload {
  type: 'room_invite';
  protocol: Protocol;
  extension: PresenceExt;
  inviteId: string;
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string;
  publicJoinToken?: string;
  /** Rejected once the room rotates past this generation [X-08][N-04]. */
  capabilityGeneration: number;
  channelTitle: string;
  recipientParticipantId: string;
  inviter: {
    participantId: string;
    screenName: string;
    avatarName?: string;
    publicKey: string;
    signingPublicKey: string;
    contactInfo?: ContactInfo;
  };
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

export interface RoomInviteResponsePayload {
  type: 'room_invite_response';
  protocol: Protocol;
  extension: PresenceExt;
  inviteId: string;
  convId: string;
  decision: 'accepted' | 'declined';
  responderParticipantId: string;
  responderScreenName: string;
  responderSigningPublicKey: string;
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

/** Now signed, closing v2 [O-06] [N-03]. */
export interface QuickMessagePayload {
  type: 'quick_message';
  protocol: Protocol;
  extension: PresenceExt;
  id: string;
  senderParticipantId: string;
  senderScreenName: string;
  senderAvatarName: string;
  senderPublicKey: string;
  senderSigningPublicKey: string;
  recipientParticipantId: string;
  text: string;
  emotion: number;
  intensity: number;
  timestamp: number;
  requiredExtensions?: string[];
  signature: string;
}

// ============================================================================
// PUBLIC ROOMS
// ============================================================================

export interface PublicRoomDescriptorPacket {
  type: 'public_room_descriptor';
  protocol: Protocol;
  extension: PublicRoomsExt;
  descriptorVersion: 3;
  publicRoomId: string;
  convId: string;
  publicJoinToken: string;
  name: string;
  description: string;
  creatorId: string;
  creatorScreenName: string;
  creatorSigningPublicKey: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  relayUrls: string[];
  language?: string;
  tags?: string[];
  historyPolicy: 'peer_sync' | 'none';
  contentPolicy: 'public';
  requiredExtensions?: string[];
  signature: string;
}

export interface PublicRoomTombstonePacket {
  type: 'public_room_tombstone';
  protocol: Protocol;
  extension: PublicRoomsExt;
  publicRoomId: string;
  convId: string;
  creatorId: string;
  creatorSigningPublicKey: string;
  closedAt: number;
  reason?: string;
  requiredExtensions?: string[];
  signature: string;
}

/**
 * Approximate occupancy beacon [X-12][PU-04].
 *
 * Deliberately carries no inner application signature: presenceId IS the
 * room-scoped Nostr public key and the event's own Schnorr signature is the
 * authentication. An ECDSA identity signature here would defeat the point [L-09].
 */
export interface PublicRoomPresenceRecord {
  type: 'public_room_presence';
  protocol: Protocol;
  extension: PublicRoomsExt;
  publicRoomId: string;
  presenceId: string;
  observedAt: number;
  expiresAt: number;
}

// ============================================================================
// LOCAL-ONLY MODELS
// ============================================================================

export type SendState = 'pending' | 'relayed' | 'failed';

export interface ChatMessage {
  id: string;
  convId: string;
  senderId: string;
  sender: {
    screenName: string;
    avatarName?: string;
    signingPublicKey?: string;
    contactInfo?: ContactInfo;
  };
  timestamp: number;
  text: string;
  keyId: string;
  keyEpoch?: number;
  isSelf: boolean;
  isSystem?: boolean;
  systemType?: 'join' | 'leave' | 'rekey' | 'request' | 'approved' | 'removed' | 'info' | 'error';
  emotion?: number;
  emotionIntensity?: number;
  balloonMode?: BalloonMode;
  /** Local delivery state; only relay quorum sets 'relayed' [L-12][D-05]. */
  sendState: SendState;
  contentHash?: string;
}

export interface Participant {
  participantId: string;
  peerId?: string;
  publicKey: string;
  signingPublicKey: string;
  screenName: string;
  avatarName?: string;
  contactInfo?: ContactInfo;
  lastSeen: number;
  isSelf: boolean;
  status: 'online' | 'idle' | 'offline';
  isApproved: boolean;
}

export interface KeyRecord {
  keyId: string;
  epoch: number;
  createdAt: number;
  key: CryptoKey;
  rawBase64Url?: string;
  parentKeyId?: string;
  signerId?: string;
  members: string[];
}

export interface PendingJoinRequest {
  requestId: string;
  sender: JoinRequestPacket['sender'];
  timestamp: number;
  verified: boolean;
}

export interface FriendPresence {
  participantId: string;
  screenName: string;
  avatarName?: string;
  status: PresenceStatus;
  lastSeen: number;
}

export type AccelerationStatus = 'active' | 'partial' | 'unavailable' | 'disabled';
export type NostrStatus = 'connected' | 'reconnecting' | 'offline';
