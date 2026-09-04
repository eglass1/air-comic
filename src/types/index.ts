export interface ContactInfo {
  info?: string;
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
}

export interface UserProfile {
  id: string; // 'current_user'
  participantId: string; // Base64URL SHA-256 of ECDSA signing public key
  screenName: string;
  avatarName?: string; // e.g. "Armando", "Susan", "Tux"
  backdropName?: string; // e.g. "room.bgb", "clouds.bgb"
  publicKeyBase64: string; // RSA-OAEP encryption key (SPKI Base64)
  publicKeyPem: string;
  privateKeyJwk: JsonWebKey;
  privateKeyPem: string;
  signingPublicKeyBase64: string; // ECDSA signing key (SPKI Base64)
  signingPublicKeyPem: string;
  signingPrivateKeyJwk: JsonWebKey;
  signingPrivateKeyPem: string;
  contactInfo: ContactInfo;
  createdAt: number;
  updatedAt: number;
}

export interface Friend {
  id: string; // unique ID
  participantId: string; // Base64URL SHA-256 of signing key
  screenName: string;
  avatarName?: string;
  publicKey: string; // RSA-OAEP SPKI Base64
  signingPublicKey: string; // ECDSA SPKI Base64
  contactInfo?: ContactInfo;
  notes?: string;
  lastSeen?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Participant {
  participantId: string; // Canonical identity
  peerId?: string; // Trystero ephemeral peer ID
  publicKey: string; // RSA-OAEP SPKI Base64
  signingPublicKey: string; // ECDSA SPKI Base64
  screenName: string;
  avatarName?: string;
  contactInfo?: ContactInfo;
  lastSeen: number;
  isSelf: boolean;
  status: 'online' | 'idle' | 'offline';
  isApproved: boolean; // true if in current active epoch key
}

export type RoomMode = 'private' | 'public';

export interface IdentityHelloPacket {
  type: 'hello';
  protocol: 'airthread/2';
  convId: string;
  peerId: string;
  participantId: string;
  screenName: string;
  avatarName?: string;
  publicKey: string; // RSA-OAEP
  signingPublicKey: string; // ECDSA
  contactInfo?: ContactInfo;
  nonce: string; // Base64URL random 128-bit
  timestamp: number;
  roomMode?: RoomMode;
  signature: string; // ECDSA signature
}

export interface JoinRequestPacket {
  type: 'join_request';
  protocol: 'airthread/2';
  requestId: string;
  convId: string;
  sender: {
    participantId: string;
    screenName: string;
    avatarName?: string;
    publicKey: string; // RSA-OAEP
    signingPublicKey: string; // ECDSA
    contactInfo?: ContactInfo;
  };
  timestamp: number;
  signature: string; // ECDSA signature
}

export interface RekeyPacket {
  type: 'key';
  protocol: 'airthread/2';
  convId: string;
  packetId: string;
  keyId: string;
  epoch: number;
  parentKeyId: string;
  signerId: string; // participantId
  signerPublicKey: string; // RSA-OAEP
  signerSigningPublicKey: string; // ECDSA
  signerScreenName: string;
  timestamp: number;
  action?: 'claim' | 'add' | 'remove' | 'rekey';
  targetParticipantId?: string;
  targetScreenName?: string;
  members: string[]; // List of participantIds in this epoch
  keys: Record<string, string>; // participantId -> Base64URL(RSA_encrypted(AES_epoch_key))
  signature: string; // ECDSA signature
}

export interface ChannelTitlePacket {
  type: 'channel_title';
  protocol: 'airthread/2';
  convId: string;
  title: string;
  setterId: string; // participantId
  setterScreenName: string;
  timestamp: number;
}

// ----------------------------------------------------------------------------
// PUBLIC ROOMS ADDENDUM (airthread/2-public-rooms)
// ----------------------------------------------------------------------------

export interface PublicRoomDescriptorPacket {
  type: 'public_room_descriptor';
  protocol: 'airthread/2';
  extension: 'airthread/2-public-rooms';
  descriptorVersion: 1;
  publicRoomId: string; // Base64URL SHA-256("airthread-public-room-v2:" + convId + ":" + publicJoinToken)
  convId: string;
  publicJoinToken: string; // Random 128-bit Base64URL token
  name: string;
  description: string;
  creatorId: string; // participantId
  creatorScreenName: string;
  creatorSigningPublicKey: string; // ECDSA SPKI Base64
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  relayUrls: string[];
  language?: string;
  tags?: string[];
  historyPolicy: 'peer_sync' | 'none';
  contentPolicy: 'public';
  signature: string; // ECDSA signature
}

export interface PublicRoomTombstonePacket {
  type: 'public_room_tombstone';
  protocol: 'airthread/2';
  extension: 'airthread/2-public-rooms';
  publicRoomId: string;
  convId: string;
  creatorId: string;
  creatorSigningPublicKey: string;
  closedAt: number;
  reason?: string;
  signature: string;
}

export interface PublicRoomMetadataPacket {
  type: 'public_room_metadata';
  protocol: 'airthread/2';
  extension: 'airthread/2-public-rooms';
  publicRoomId: string;
  convId: string;
  name: string;
  description?: string;
  setterId: string;
  setterSigningPublicKey: string;
  timestamp: number;
  signature: string;
}

export interface PlaintextMessagePayload {
  type: 'message';
  protocol: 'airthread/2';
  extension?: 'airthread/2-public-rooms';
  roomMode?: RoomMode;
  publicRoomId?: string;
  msgId: string;
  convId: string;
  senderId: string; // participantId
  sender: {
    screenName: string;
    avatarName?: string;
    signingPublicKey: string;
    contactInfo?: ContactInfo;
  };
  timestamp: number;
  text: string;
  keyId: string;
  emotion?: number;
  emotionIntensity?: number;
  balloonMode?: 'say' | 'whisper' | 'think' | 'action';
  signature?: string; // Required for public rooms
}

export interface EncryptedNetworkEnvelope {
  protocol: 'airthread/2';
  type: 'encrypted';
  convId: string;
  packetId: string;
  keyId: string; // "root-v2", "public-v2", or "epoch-N-..."
  iv: string; // Base64URL 12 bytes
  data: string; // Base64URL ciphertext
  senderId: string; // participantId
  timestamp: number;
}

export interface StateSummaryPacket {
  type: 'state_summary';
  protocol: 'airthread/2';
  extension?: 'airthread/2-public-rooms';
  roomMode?: RoomMode;
  publicRoomId?: string;
  convId: string;
  participantId: string;
  activeEpoch: number;
  activeKeyId: string;
  membershipHeadPacketId: string;
  controlPacketIds: string[];
  newestMessageTimestamp: number;
  messageCount: number;
  recentMessageIds?: string[]; // ids of the most recent messages we hold
  timestamp: number;
  signature: string;
}

export interface StateRequestPacket {
  type: 'state_request';
  protocol: 'airthread/2';
  extension?: 'airthread/2-public-rooms';
  roomMode?: RoomMode;
  publicRoomId?: string;
  convId: string;
  requesterId: string;
  wantedControlPacketIds: string[];
  wantedMessageIds?: string[];
  sinceTimestamp?: number;
  timestamp: number;
}

export interface StateChunkPacket {
  type: 'state_chunk';
  protocol: 'airthread/2';
  convId: string;
  responderId: string;
  controlPackets: RekeyPacket[];
  messageEnvelopes: EncryptedNetworkEnvelope[];
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  convId: string;
  senderId: string;
  sender: {
    screenName: string;
    avatarName?: string;
    publicKey?: string;
    signingPublicKey?: string;
    contactInfo?: ContactInfo;
  };
  timestamp: number;
  text: string;
  keyId: string;
  keyEpoch?: number;
  isSelf: boolean;
  isSystem?: boolean;
  systemType?: 'join' | 'leave' | 'rekey' | 'claim' | 'request' | 'approved' | 'removed' | 'info' | 'error';
  decrypted: boolean;
  emotion?: number;
  emotionIntensity?: number;
  balloonMode?: 'say' | 'whisper' | 'think' | 'action';
  /** Original wire envelope, retained so this message can be re-served to peers syncing history. */
  envelope?: EncryptedNetworkEnvelope;
}

export interface KeyRecord {
  keyId: string;
  epoch: number;
  createdAt: number;
  key: CryptoKey;
  rawBase64Url?: string;
  isRoot?: boolean;
  parentKeyId?: string;
  signerId?: string;
  signerScreenName?: string;
  members: string[]; // participantIds
}

/**
 * An epoch key held on disk so a reload does not drop the room back to the root
 * key. The message log is already stored as plaintext, so keeping these costs no
 * secrecy at rest that the history has not already given up.
 */
export interface StoredConversationKey {
  /** `${convId}::${keyId}` */
  id: string;
  convId: string;
  keyId: string;
  epoch: number;
  parentKeyId?: string;
  rawBase64Url: string;
  signerId?: string;
  members: string[];
  savedAt: number;
}

export interface PendingJoinRequest {
  requestId: string;
  sender: {
    participantId: string;
    screenName: string;
    publicKey: string;
    signingPublicKey: string;
    contactInfo?: ContactInfo;
  };
  timestamp: number;
  verified: boolean;
}

export interface RelaySocketStatus {
  url: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
}

export interface RoomTab {
  tabId: string;
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string;
  publicRoomId?: string;
  publicJoinToken?: string;
  isInitialCreator?: boolean;
  channelTitle: string;
  unreadCount: number;
}


// ----------------------------------------------------------------------------
// GOSSIP / ROSTER PROPAGATION
// ----------------------------------------------------------------------------

/**
 * Carries verbatim (still signed) hello packets learned from other peers so that
 * participants who cannot establish a direct WebRTC link still see each other.
 */
export interface RosterGossipPacket {
  type: 'roster';
  protocol: 'airthread/2';
  convId: string;
  hellos: IdentityHelloPacket[];
  timestamp: number;
}

/**
 * Announces that some approved member has resolved a pending join request, so
 * every other member can dismiss the prompt from their screen.
 */
export interface JoinDecisionPacket {
  type: 'join_decision';
  protocol: 'airthread/2';
  convId: string;
  requestId: string;
  targetParticipantId: string;
  decision: 'approved' | 'declined';
  deciderId: string; // participantId
  deciderScreenName: string;
  deciderSigningPublicKey: string; // ECDSA SPKI Base64
  timestamp: number;
  signature: string;
}

// ----------------------------------------------------------------------------
// PRESENCE & DIRECT INVITES (airthread/2-presence)
// ----------------------------------------------------------------------------

export type PresenceStatus = 'online' | 'away' | 'offline';

export interface PresencePacket {
  type: 'presence';
  protocol: 'airthread/2';
  extension: 'airthread/2-presence';
  participantId: string;
  screenName: string;
  avatarName?: string;
  publicKey: string; // RSA-OAEP SPKI Base64
  signingPublicKey: string; // ECDSA SPKI Base64
  status: PresenceStatus;
  timestamp: number;
  signature: string;
}

export interface FriendPresence {
  participantId: string;
  screenName: string;
  avatarName?: string;
  status: PresenceStatus;
  lastSeen: number;
}

/** Hybrid RSA-OAEP + AES-GCM sealed payload, addressed to a single participant. */
export interface SealedEnvelope {
  type: 'sealed';
  protocol: 'airthread/2';
  extension: 'airthread/2-presence';
  recipientParticipantId: string;
  senderParticipantId: string;
  encryptedKey: string; // Base64URL RSA-OAEP(raw AES-256 key)
  iv: string; // Base64URL 12 bytes
  data: string; // Base64URL ciphertext
  timestamp: number;
}

export interface RoomInvitePayload {
  type: 'room_invite';
  protocol: 'airthread/2';
  extension: 'airthread/2-presence';
  inviteId: string;
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string; // private rooms
  publicJoinToken?: string; // public rooms
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
  signature: string;
}

export interface RoomInviteResponsePayload {
  type: 'room_invite_response';
  protocol: 'airthread/2';
  extension: 'airthread/2-presence';
  inviteId: string;
  convId: string;
  decision: 'accepted' | 'declined';
  responderParticipantId: string;
  responderScreenName: string;
  responderSigningPublicKey: string;
  timestamp: number;
  signature: string;
}

/** Outgoing invite parked in IndexedDB until the recipient is seen online. */
export interface PendingInviteRecord {
  inviteId: string;
  recipientParticipantId: string;
  recipientScreenName: string;
  recipientPublicKey: string; // RSA-OAEP SPKI Base64
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string;
  publicJoinToken?: string;
  channelTitle: string;
  status: 'queued' | 'sent' | 'accepted' | 'declined';
  createdAt: number;
  updatedAt: number;
  lastAttemptAt?: number;
}

/**
 * A person we asked into a specific room, kept so their entry request is still
 * granted without prompting after a reload. Distinct from PendingInviteRecord,
 * which is a delivery queue and is cleared the moment they answer — the
 * pre-authorisation has to outlive the answer, because the join handshake only
 * starts once they accept.
 */
export interface RoomPreapprovalRecord {
  /** `${convId}::${participantId}` */
  id: string;
  convId: string;
  participantId: string;
  screenName?: string;
  createdAt: number;
}

export interface QuickMessagePayload {
  type: 'quick_message';
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
}

/**
 * A quick message the user has already dealt with. Relays hold a quick message
 * after it is delivered, so this is what stops an acknowledged one from popping
 * up again the next time the app reconnects.
 */
export interface QuickMessageAckRecord {
  id: string;
  senderParticipantId?: string;
  ackedAt: number;
}
