/**
 * Application types.
 *
 * The protocol types live in src/services/v3/types.ts and the persisted record
 * shapes in src/services/v3/db.ts; this module re-exports what the UI needs so
 * components keep importing from one place.
 */

export type {
  AccelerationStatus,
  BalloonMode,
  ChatMessage,
  ContactCapabilityPacket,
  ContactInfo,
  FriendPresence,
  HistoryPolicy,
  IdentityHelloPacket,
  KeyRecord,
  MessagePayload,
  MetadataPolicy,
  NostrStatus,
  Participant,
  PendingJoinRequest,
  PresencePacket,
  PresenceStatus,
  PublicRoomDescriptorPacket,
  PublicRoomPresenceRecord,
  PublicRoomTombstonePacket,
  QuickMessagePayload,
  RoomEnvelope,
  RoomInvitePayload,
  RoomInviteResponsePayload,
  RoomMetadataPacket,
  RoomMode,
  RoomPresencePacket,
  SealedEnvelope,
  SendState,
} from '../services/v3/types';

export type {
  ConversationRecord,
  FavoriteRoomRecord,
  Friend,
  OutboxRecord,
  OutboxState,
  PendingInviteRecord,
  RoomPreapprovalRecord,
  SettingsRecord,
  StoredEpochKey,
  UserProfile,
} from '../services/v3/db';

export type { RelayHealth } from '../services/nostr/relayPool';

import type { RoomMode } from '../services/v3/types';

/** An open room tab. Local UI state; never on the wire. */
export interface RoomTab {
  tabId: string;
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string;
  publicRoomId?: string;
  publicJoinToken?: string;
  isInitialCreator?: boolean;
  channelTitle: string;
  channelDescription?: string;
  unreadCount: number;
}
