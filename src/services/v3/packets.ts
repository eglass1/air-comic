/**
 * airthread/3 inner packet builders and verifiers -- implementation plan [X-05].
 *
 * Uniform rule: every signed packet carries the signer's ECDSA SPKI key, and
 * every verifier re-derives the claimed participantId from that key before
 * checking the signature. v2 applied this to some packets only.
 */

import {
  arrayBufferToBase64Url,
  canonicalStringify,
  decryptAsymmetric,
  encryptAsymmetric,
  getParticipantId,
  importPublicKey,
  importRawAesKey,
  normalizePublicKey,
  signData,
  verifySignature,
} from '../crypto';
import {
  DOMAIN_CAPABILITY_ROTATION,
  DOMAIN_CONTACT_CAPABILITY,
  DOMAIN_GENESIS,
  DOMAIN_HELLO,
  DOMAIN_INVITE_RESPONSE,
  DOMAIN_JOIN_DECISION,
  DOMAIN_JOIN_REQUEST,
  DOMAIN_METADATA,
  DOMAIN_PRESENCE,
  DOMAIN_PRIVATE_MESSAGE,
  DOMAIN_PUBLIC_MESSAGE,
  DOMAIN_PUBLIC_ROOM_DESCRIPTOR,
  DOMAIN_PUBLIC_ROOM_TOMBSTONE,
  DOMAIN_QUICK_MESSAGE,
  DOMAIN_RECOVERY_REQUEST,
  DOMAIN_REKEY,
  DOMAIN_ROOM_INVITE,
  EXT_PRESENCE,
  EXT_PUBLIC_ROOMS,
  MAX_PRIVATE_MEMBERS_HARD,
  PROTOCOL,
  PUBLIC_DESCRIPTOR_SEC,
} from './constants';
import type {
  CapabilityRotationPacket,
  ContactCapabilityPacket,
  ContactInfo,
  HistoryPolicy,
  IdentityHelloPacket,
  JoinDecisionPacket,
  JoinRequestPacket,
  MessagePayload,
  MetadataPolicy,
  PresencePacket,
  PresenceStatus,
  PublicRoomDescriptorPacket,
  PublicRoomTombstonePacket,
  QuickMessagePayload,
  RecoveryRequestPacket,
  RekeyAction,
  RekeyPacket,
  RoomGenesisPacket,
  RoomInvitePayload,
  RoomInviteResponsePayload,
  RoomMetadataPacket,
  RoomMode,
} from './types';

// ----------------------------------------------------------------------------
// Generic sign / verify
// ----------------------------------------------------------------------------

type Signed = { signature: string };

async function sign<T extends Signed>(
  domain: string,
  unsigned: Omit<T, 'signature'>,
  signingPrivateKey: CryptoKey
): Promise<T> {
  const signature = await signData(signingPrivateKey, domain + canonicalStringify(unsigned));
  return { ...unsigned, signature } as T;
}

/**
 * Verifies a signature and the signer-id-to-key binding in one step. Returns
 * false rather than throwing, so receive paths can drop bad input cheaply.
 */
async function verify<T extends Signed>(
  domain: string,
  packet: T,
  signingPublicKey: string | undefined,
  claimedId: string | undefined
): Promise<boolean> {
  if (!packet?.signature || !signingPublicKey || !claimedId) return false;
  try {
    if ((await getParticipantId(signingPublicKey)) !== claimedId) return false;
    const { signature, ...unsigned } = packet as Signed & Record<string, unknown>;
    return await verifySignature(signingPublicKey, domain + canonicalStringify(unsigned), signature);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Chat messages  [PR-02] -- private messages are signed in v3, closing [O-02]
// ----------------------------------------------------------------------------

export interface BuildMessageParams {
  convId: string;
  roomMode: RoomMode;
  publicRoomId?: string;
  senderId: string;
  senderSigningPublicKey: string;
  signingPrivateKey: CryptoKey;
  screenName: string;
  avatarName?: string;
  contactInfo?: ContactInfo;
  text: string;
  emotion?: number;
  emotionIntensity?: number;
  balloonMode?: MessagePayload['balloonMode'];
  msgId?: string;
  timestamp?: number;
}

export async function buildMessagePayload(p: BuildMessageParams): Promise<MessagePayload> {
  const domain = p.roomMode === 'public' ? DOMAIN_PUBLIC_MESSAGE : DOMAIN_PRIVATE_MESSAGE;
  const unsigned: Omit<MessagePayload, 'signature'> = {
    type: 'message',
    protocol: PROTOCOL,
    roomMode: p.roomMode,
    msgId: p.msgId ?? crypto.randomUUID(),
    convId: p.convId,
    publicRoomId: p.publicRoomId,
    senderId: p.senderId,
    senderSigningPublicKey: normalizePublicKey(p.senderSigningPublicKey),
    sender: {
      screenName: p.screenName,
      avatarName: p.avatarName,
      contactInfo: p.roomMode === 'public' ? undefined : p.contactInfo,
    },
    timestamp: p.timestamp ?? Date.now(),
    text: p.text,
    emotion: p.emotion,
    emotionIntensity: p.emotionIntensity,
    balloonMode: p.balloonMode,
  };
  return sign<MessagePayload>(domain, unsigned, p.signingPrivateKey);
}

export async function verifyMessagePayload(payload: MessagePayload): Promise<boolean> {
  const domain = payload?.roomMode === 'public' ? DOMAIN_PUBLIC_MESSAGE : DOMAIN_PRIVATE_MESSAGE;
  return verify(domain, payload, payload?.senderSigningPublicKey, payload?.senderId);
}

// ----------------------------------------------------------------------------
// Genesis  [L-04][X-07]
// ----------------------------------------------------------------------------

export async function buildGenesis(p: {
  convId: string;
  creatorId: string;
  creatorSigningPublicKey: string;
  creatorScreenName: string;
  signingPrivateKey: CryptoKey;
  metadataPolicy?: MetadataPolicy;
  historyPolicy?: HistoryPolicy;
}): Promise<RoomGenesisPacket> {
  const unsigned: Omit<RoomGenesisPacket, 'signature'> = {
    type: 'room_genesis',
    protocol: PROTOCOL,
    convId: p.convId,
    packetId: crypto.randomUUID(),
    creatorId: p.creatorId,
    creatorSigningPublicKey: normalizePublicKey(p.creatorSigningPublicKey),
    creatorScreenName: p.creatorScreenName,
    createdAt: Date.now(),
    metadataPolicy: p.metadataPolicy ?? 'members',
    historyPolicy: p.historyPolicy ?? 'from_admission',
  };
  return sign<RoomGenesisPacket>(DOMAIN_GENESIS, unsigned, p.signingPrivateKey);
}

export async function verifyGenesis(packet: RoomGenesisPacket): Promise<boolean> {
  return verify(DOMAIN_GENESIS, packet, packet?.creatorSigningPublicKey, packet?.creatorId);
}

// ----------------------------------------------------------------------------
// Rekey  [X-07]
// ----------------------------------------------------------------------------

export async function buildRekey(p: {
  convId: string;
  keyId: string;
  epoch: number;
  parentPacketId: string;
  parentKeyId: string;
  action: RekeyAction;
  targetParticipantId?: string;
  targetScreenName?: string;
  members: string[];
  publicKeys: Map<string, string>;
  rawEpochKey: ArrayBuffer;
  signerId: string;
  signerSigningPublicKey: string;
  signerScreenName: string;
  signingPrivateKey: CryptoKey;
  packetId?: string;
}): Promise<RekeyPacket> {
  const members = Array.from(new Set(p.members)).sort();
  if (members.length > MAX_PRIVATE_MEMBERS_HARD) {
    throw new Error(`Membership exceeds the structural bound of ${MAX_PRIVATE_MEMBERS_HARD}`);
  }

  const keys: Record<string, string> = {};
  for (const pid of members) {
    const pub = p.publicKeys.get(pid);
    if (!pub) throw new Error(`No public key for member ${pid}; cannot wrap epoch key`);
    keys[pid] = await encryptAsymmetric(await importPublicKey(pub), p.rawEpochKey);
  }

  const unsigned: Omit<RekeyPacket, 'signature'> = {
    type: 'key',
    protocol: PROTOCOL,
    convId: p.convId,
    packetId: p.packetId ?? crypto.randomUUID(),
    keyId: p.keyId,
    epoch: p.epoch,
    parentPacketId: p.parentPacketId,
    parentKeyId: p.parentKeyId,
    action: p.action,
    targetParticipantId: p.targetParticipantId,
    targetScreenName: p.targetScreenName,
    signerId: p.signerId,
    signerSigningPublicKey: normalizePublicKey(p.signerSigningPublicKey),
    signerScreenName: p.signerScreenName,
    timestamp: Date.now(),
    members,
    keys,
  };
  return sign<RekeyPacket>(DOMAIN_REKEY, unsigned, p.signingPrivateKey);
}

export async function verifyRekey(packet: RekeyPacket): Promise<boolean> {
  return verify(DOMAIN_REKEY, packet, packet?.signerSigningPublicKey, packet?.signerId);
}

export async function openRekeySlot(
  packet: RekeyPacket,
  myParticipantId: string,
  myPrivateKey: CryptoKey
): Promise<{ key: CryptoKey; rawBase64Url: string } | null> {
  const slot = packet.keys?.[myParticipantId];
  if (!slot) return null;
  try {
    const raw = await decryptAsymmetric(myPrivateKey, slot);
    return { key: await importRawAesKey(raw), rawBase64Url: arrayBufferToBase64Url(raw) };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Capability rotation  [X-08][PR-07]
// ----------------------------------------------------------------------------

export interface RotationSecrets {
  roomSecret: string;
  epochKey: string;
}

export async function buildCapabilityRotation(p: {
  convId: string;
  generation: number;
  newEpoch: number;
  newKeyId: string;
  parentPacketId: string;
  parentKeyId: string;
  removedParticipantId: string;
  members: string[];
  publicKeys: Map<string, string>;
  secrets: RotationSecrets;
  signerId: string;
  signerSigningPublicKey: string;
  signingPrivateKey: CryptoKey;
}): Promise<CapabilityRotationPacket> {
  const members = Array.from(new Set(p.members)).sort();
  const body = new TextEncoder().encode(JSON.stringify(p.secrets));

  const wrapped: Record<string, string> = {};
  for (const pid of members) {
    const pub = p.publicKeys.get(pid);
    if (!pub) throw new Error(`No public key for member ${pid}; cannot wrap rotation`);
    // RSA-OAEP 2048 with SHA-256 carries at most 190 bytes; the rotation body is
    // a 44-char secret plus a 44-char key plus JSON punctuation, well inside it.
    wrapped[pid] = await encryptAsymmetric(await importPublicKey(pub), body.buffer as ArrayBuffer);
  }

  const unsigned: Omit<CapabilityRotationPacket, 'signature'> = {
    type: 'capability_rotation',
    protocol: PROTOCOL,
    convId: p.convId,
    packetId: crypto.randomUUID(),
    generation: p.generation,
    newEpoch: p.newEpoch,
    newKeyId: p.newKeyId,
    parentPacketId: p.parentPacketId,
    parentKeyId: p.parentKeyId,
    removedParticipantId: p.removedParticipantId,
    members,
    wrapped,
    signerId: p.signerId,
    signerSigningPublicKey: normalizePublicKey(p.signerSigningPublicKey),
    timestamp: Date.now(),
  };
  return sign<CapabilityRotationPacket>(
    DOMAIN_CAPABILITY_ROTATION,
    unsigned,
    p.signingPrivateKey
  );
}

export async function verifyCapabilityRotation(
  packet: CapabilityRotationPacket
): Promise<boolean> {
  return verify(
    DOMAIN_CAPABILITY_ROTATION,
    packet,
    packet?.signerSigningPublicKey,
    packet?.signerId
  );
}

export async function openRotationSlot(
  packet: CapabilityRotationPacket,
  myParticipantId: string,
  myPrivateKey: CryptoKey
): Promise<RotationSecrets | null> {
  const slot = packet.wrapped?.[myParticipantId];
  if (!slot) return null;
  try {
    const raw = await decryptAsymmetric(myPrivateKey, slot);
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    if (typeof parsed?.roomSecret !== 'string' || typeof parsed?.epochKey !== 'string') return null;
    return { roomSecret: parsed.roomSecret, epochKey: parsed.epochKey };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Membership control
// ----------------------------------------------------------------------------

export async function buildJoinRequest(p: {
  convId: string;
  participantId: string;
  screenName: string;
  avatarName?: string;
  publicKey: string;
  signingPublicKey: string;
  contactInfo?: ContactInfo;
  signingPrivateKey: CryptoKey;
}): Promise<JoinRequestPacket> {
  const unsigned: Omit<JoinRequestPacket, 'signature'> = {
    type: 'join_request',
    protocol: PROTOCOL,
    requestId: crypto.randomUUID(),
    convId: p.convId,
    sender: {
      participantId: p.participantId,
      screenName: p.screenName,
      avatarName: p.avatarName,
      publicKey: normalizePublicKey(p.publicKey),
      signingPublicKey: normalizePublicKey(p.signingPublicKey),
      contactInfo: p.contactInfo,
    },
    timestamp: Date.now(),
  };
  return sign<JoinRequestPacket>(DOMAIN_JOIN_REQUEST, unsigned, p.signingPrivateKey);
}

export async function verifyJoinRequest(packet: JoinRequestPacket): Promise<boolean> {
  return verify(
    DOMAIN_JOIN_REQUEST,
    packet,
    packet?.sender?.signingPublicKey,
    packet?.sender?.participantId
  );
}

export async function buildJoinDecision(p: {
  convId: string;
  requestId: string;
  targetParticipantId: string;
  decision: 'approved' | 'declined';
  deciderId: string;
  deciderScreenName: string;
  deciderSigningPublicKey: string;
  signingPrivateKey: CryptoKey;
}): Promise<JoinDecisionPacket> {
  const unsigned: Omit<JoinDecisionPacket, 'signature'> = {
    type: 'join_decision',
    protocol: PROTOCOL,
    convId: p.convId,
    requestId: p.requestId,
    targetParticipantId: p.targetParticipantId,
    decision: p.decision,
    deciderId: p.deciderId,
    deciderScreenName: p.deciderScreenName,
    deciderSigningPublicKey: normalizePublicKey(p.deciderSigningPublicKey),
    timestamp: Date.now(),
  };
  return sign<JoinDecisionPacket>(DOMAIN_JOIN_DECISION, unsigned, p.signingPrivateKey);
}

export async function verifyJoinDecision(packet: JoinDecisionPacket): Promise<boolean> {
  return verify(DOMAIN_JOIN_DECISION, packet, packet?.deciderSigningPublicKey, packet?.deciderId);
}

// ----------------------------------------------------------------------------
// Metadata  [M-01] -- replaces v2's unsigned ChannelTitlePacket [O-18]
// ----------------------------------------------------------------------------

export async function buildRoomMetadata(p: {
  convId: string;
  publicRoomId?: string;
  title?: string;
  description?: string;
  setterId: string;
  setterSigningPublicKey: string;
  signingPrivateKey: CryptoKey;
}): Promise<RoomMetadataPacket> {
  const unsigned: Omit<RoomMetadataPacket, 'signature'> = {
    type: 'room_metadata',
    protocol: PROTOCOL,
    convId: p.convId,
    publicRoomId: p.publicRoomId,
    title: p.title,
    description: p.description,
    setterId: p.setterId,
    setterSigningPublicKey: normalizePublicKey(p.setterSigningPublicKey),
    timestamp: Date.now(),
  };
  return sign<RoomMetadataPacket>(DOMAIN_METADATA, unsigned, p.signingPrivateKey);
}

export async function verifyRoomMetadata(packet: RoomMetadataPacket): Promise<boolean> {
  return verify(DOMAIN_METADATA, packet, packet?.setterSigningPublicKey, packet?.setterId);
}

// ----------------------------------------------------------------------------
// WebRTC hello  [W-06]
// ----------------------------------------------------------------------------

export async function buildHello(p: {
  convId: string;
  peerId: string;
  participantId: string;
  screenName: string;
  avatarName?: string;
  publicKey: string;
  signingPublicKey: string;
  contactInfo?: ContactInfo;
  capabilities?: string[];
  signingPrivateKey: CryptoKey;
}): Promise<IdentityHelloPacket> {
  const unsigned: Omit<IdentityHelloPacket, 'signature'> = {
    type: 'hello',
    protocol: PROTOCOL,
    convId: p.convId,
    peerId: p.peerId,
    participantId: p.participantId,
    screenName: p.screenName,
    avatarName: p.avatarName,
    publicKey: normalizePublicKey(p.publicKey),
    signingPublicKey: normalizePublicKey(p.signingPublicKey),
    contactInfo: p.contactInfo,
    capabilities: p.capabilities ?? [],
    nonce: arrayBufferToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    timestamp: Date.now(),
  };
  return sign<IdentityHelloPacket>(DOMAIN_HELLO, unsigned, p.signingPrivateKey);
}

export async function verifyHello(packet: IdentityHelloPacket): Promise<boolean> {
  return verify(DOMAIN_HELLO, packet, packet?.signingPublicKey, packet?.participantId);
}

// ----------------------------------------------------------------------------
// Recovery  [H-02]
// ----------------------------------------------------------------------------

export async function buildRecoveryRequest(p: {
  convId: string;
  wantedPacketIds: string[];
  requesterId: string;
  requesterSigningPublicKey: string;
  signingPrivateKey: CryptoKey;
}): Promise<RecoveryRequestPacket> {
  const unsigned: Omit<RecoveryRequestPacket, 'signature'> = {
    type: 'recovery_request',
    protocol: PROTOCOL,
    convId: p.convId,
    wantedPacketIds: p.wantedPacketIds,
    requesterId: p.requesterId,
    requesterSigningPublicKey: normalizePublicKey(p.requesterSigningPublicKey),
    timestamp: Date.now(),
  };
  return sign<RecoveryRequestPacket>(DOMAIN_RECOVERY_REQUEST, unsigned, p.signingPrivateKey);
}

export async function verifyRecoveryRequest(packet: RecoveryRequestPacket): Promise<boolean> {
  return verify(
    DOMAIN_RECOVERY_REQUEST,
    packet,
    packet?.requesterSigningPublicKey,
    packet?.requesterId
  );
}

// ----------------------------------------------------------------------------
// Presence and contact capabilities  [X-11]
// ----------------------------------------------------------------------------

export async function buildPresence(p: {
  participantId: string;
  screenName: string;
  avatarName?: string;
  publicKey: string;
  signingPublicKey: string;
  status: PresenceStatus;
  signingPrivateKey: CryptoKey;
  timestamp?: number;
}): Promise<PresencePacket> {
  const unsigned: Omit<PresencePacket, 'signature'> = {
    type: 'presence',
    protocol: PROTOCOL,
    extension: EXT_PRESENCE,
    participantId: p.participantId,
    screenName: p.screenName,
    avatarName: p.avatarName,
    publicKey: normalizePublicKey(p.publicKey),
    signingPublicKey: normalizePublicKey(p.signingPublicKey),
    status: p.status,
    timestamp: p.timestamp ?? Date.now(),
  };
  return sign<PresencePacket>(DOMAIN_PRESENCE, unsigned, p.signingPrivateKey);
}

export async function verifyPresence(packet: PresencePacket): Promise<boolean> {
  return verify(DOMAIN_PRESENCE, packet, packet?.signingPublicKey, packet?.participantId);
}

export async function buildContactCapability(p: {
  issuerId: string;
  issuerSigningPublicKey: string;
  issuerScreenName: string;
  capability: string;
  generation: number;
  signingPrivateKey: CryptoKey;
}): Promise<ContactCapabilityPacket> {
  const unsigned: Omit<ContactCapabilityPacket, 'signature'> = {
    type: 'contact_capability',
    protocol: PROTOCOL,
    extension: EXT_PRESENCE,
    issuerId: p.issuerId,
    issuerSigningPublicKey: normalizePublicKey(p.issuerSigningPublicKey),
    issuerScreenName: p.issuerScreenName,
    capability: p.capability,
    generation: p.generation,
    timestamp: Date.now(),
  };
  return sign<ContactCapabilityPacket>(
    DOMAIN_CONTACT_CAPABILITY,
    unsigned,
    p.signingPrivateKey
  );
}

export async function verifyContactCapability(
  packet: ContactCapabilityPacket
): Promise<boolean> {
  return verify(DOMAIN_CONTACT_CAPABILITY, packet, packet?.issuerSigningPublicKey, packet?.issuerId);
}

// ----------------------------------------------------------------------------
// Invitations and quick messages
// ----------------------------------------------------------------------------

export async function buildRoomInvite(p: {
  inviteId: string;
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string;
  publicJoinToken?: string;
  capabilityGeneration: number;
  channelTitle: string;
  recipientParticipantId: string;
  inviter: RoomInvitePayload['inviter'];
  signingPrivateKey: CryptoKey;
}): Promise<RoomInvitePayload> {
  const unsigned: Omit<RoomInvitePayload, 'signature'> = {
    type: 'room_invite',
    protocol: PROTOCOL,
    extension: EXT_PRESENCE,
    inviteId: p.inviteId,
    convId: p.convId,
    roomMode: p.roomMode,
    roomSecret: p.roomSecret,
    publicJoinToken: p.publicJoinToken,
    capabilityGeneration: p.capabilityGeneration,
    channelTitle: p.channelTitle,
    recipientParticipantId: p.recipientParticipantId,
    inviter: {
      ...p.inviter,
      publicKey: normalizePublicKey(p.inviter.publicKey),
      signingPublicKey: normalizePublicKey(p.inviter.signingPublicKey),
    },
    timestamp: Date.now(),
  };
  return sign<RoomInvitePayload>(DOMAIN_ROOM_INVITE, unsigned, p.signingPrivateKey);
}

export async function verifyRoomInvite(packet: RoomInvitePayload): Promise<boolean> {
  return verify(
    DOMAIN_ROOM_INVITE,
    packet,
    packet?.inviter?.signingPublicKey,
    packet?.inviter?.participantId
  );
}

export async function buildInviteResponse(p: {
  inviteId: string;
  convId: string;
  decision: 'accepted' | 'declined';
  responderParticipantId: string;
  responderScreenName: string;
  responderSigningPublicKey: string;
  signingPrivateKey: CryptoKey;
}): Promise<RoomInviteResponsePayload> {
  const unsigned: Omit<RoomInviteResponsePayload, 'signature'> = {
    type: 'room_invite_response',
    protocol: PROTOCOL,
    extension: EXT_PRESENCE,
    inviteId: p.inviteId,
    convId: p.convId,
    decision: p.decision,
    responderParticipantId: p.responderParticipantId,
    responderScreenName: p.responderScreenName,
    responderSigningPublicKey: normalizePublicKey(p.responderSigningPublicKey),
    timestamp: Date.now(),
  };
  return sign<RoomInviteResponsePayload>(
    DOMAIN_INVITE_RESPONSE,
    unsigned,
    p.signingPrivateKey
  );
}

export async function verifyInviteResponse(
  packet: RoomInviteResponsePayload
): Promise<boolean> {
  return verify(
    DOMAIN_INVITE_RESPONSE,
    packet,
    packet?.responderSigningPublicKey,
    packet?.responderParticipantId
  );
}

/** Signed in v3, closing the v2 spoofing gap [O-06][N-03]. */
export async function buildQuickMessage(p: {
  senderParticipantId: string;
  senderScreenName: string;
  senderAvatarName: string;
  senderPublicKey: string;
  senderSigningPublicKey: string;
  recipientParticipantId: string;
  text: string;
  emotion: number;
  intensity: number;
  signingPrivateKey: CryptoKey;
}): Promise<QuickMessagePayload> {
  const unsigned: Omit<QuickMessagePayload, 'signature'> = {
    type: 'quick_message',
    protocol: PROTOCOL,
    extension: EXT_PRESENCE,
    id: crypto.randomUUID(),
    senderParticipantId: p.senderParticipantId,
    senderScreenName: p.senderScreenName,
    senderAvatarName: p.senderAvatarName,
    senderPublicKey: normalizePublicKey(p.senderPublicKey),
    senderSigningPublicKey: normalizePublicKey(p.senderSigningPublicKey),
    recipientParticipantId: p.recipientParticipantId,
    text: p.text,
    emotion: p.emotion,
    intensity: p.intensity,
    timestamp: Date.now(),
  };
  return sign<QuickMessagePayload>(DOMAIN_QUICK_MESSAGE, unsigned, p.signingPrivateKey);
}

export async function verifyQuickMessage(packet: QuickMessagePayload): Promise<boolean> {
  return verify(
    DOMAIN_QUICK_MESSAGE,
    packet,
    packet?.senderSigningPublicKey,
    packet?.senderParticipantId
  );
}

// ----------------------------------------------------------------------------
// Public room directory
// ----------------------------------------------------------------------------

export async function buildPublicRoomDescriptor(p: {
  publicRoomId: string;
  convId: string;
  publicJoinToken: string;
  name: string;
  description: string;
  creatorId: string;
  creatorScreenName: string;
  creatorSigningPublicKey: string;
  signingPrivateKey: CryptoKey;
  relayUrls?: string[];
  language?: string;
  tags?: string[];
  historyPolicy?: 'peer_sync' | 'none';
  createdAt?: number;
  lifetimeSec?: number;
}): Promise<PublicRoomDescriptorPacket> {
  const now = Date.now();
  const unsigned: Omit<PublicRoomDescriptorPacket, 'signature'> = {
    type: 'public_room_descriptor',
    protocol: PROTOCOL,
    extension: EXT_PUBLIC_ROOMS,
    descriptorVersion: 3,
    publicRoomId: p.publicRoomId,
    convId: p.convId,
    publicJoinToken: p.publicJoinToken,
    name: p.name.trim().slice(0, 80),
    description: p.description.trim().slice(0, 500),
    creatorId: p.creatorId,
    creatorScreenName: p.creatorScreenName,
    creatorSigningPublicKey: normalizePublicKey(p.creatorSigningPublicKey),
    createdAt: p.createdAt ?? now,
    updatedAt: now,
    expiresAt: now + (p.lifetimeSec ?? PUBLIC_DESCRIPTOR_SEC) * 1000,
    relayUrls: p.relayUrls ?? [],
    language: p.language ?? 'en',
    tags: p.tags?.map((t) => t.trim().slice(0, 32)).slice(0, 10) ?? [],
    historyPolicy: p.historyPolicy ?? 'peer_sync',
    contentPolicy: 'public',
  };
  return sign<PublicRoomDescriptorPacket>(
    DOMAIN_PUBLIC_ROOM_DESCRIPTOR,
    unsigned,
    p.signingPrivateKey
  );
}

export async function verifyPublicRoomDescriptor(
  packet: PublicRoomDescriptorPacket,
  expectedRoomId: string
): Promise<boolean> {
  if (packet?.contentPolicy !== 'public') return false;
  if (packet?.publicRoomId !== expectedRoomId) return false;
  return verify(
    DOMAIN_PUBLIC_ROOM_DESCRIPTOR,
    packet,
    packet?.creatorSigningPublicKey,
    packet?.creatorId
  );
}

export async function buildPublicRoomTombstone(p: {
  publicRoomId: string;
  convId: string;
  creatorId: string;
  creatorSigningPublicKey: string;
  signingPrivateKey: CryptoKey;
  reason?: string;
}): Promise<PublicRoomTombstonePacket> {
  const unsigned: Omit<PublicRoomTombstonePacket, 'signature'> = {
    type: 'public_room_tombstone',
    protocol: PROTOCOL,
    extension: EXT_PUBLIC_ROOMS,
    publicRoomId: p.publicRoomId,
    convId: p.convId,
    creatorId: p.creatorId,
    creatorSigningPublicKey: normalizePublicKey(p.creatorSigningPublicKey),
    closedAt: Date.now(),
    reason: p.reason ?? 'Room closed by creator',
  };
  return sign<PublicRoomTombstonePacket>(
    DOMAIN_PUBLIC_ROOM_TOMBSTONE,
    unsigned,
    p.signingPrivateKey
  );
}

export async function verifyPublicRoomTombstone(
  packet: PublicRoomTombstonePacket
): Promise<boolean> {
  return verify(
    DOMAIN_PUBLIC_ROOM_TOMBSTONE,
    packet,
    packet?.creatorSigningPublicKey,
    packet?.creatorId
  );
}
