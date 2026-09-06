/**
 * IndexedDB persistence for airthread/3 -- implementation plan [S-01], with the
 * clean-cutover ruling [C-01]/[C-02]: a brand new database, no migration
 * branches, and the v2 database deleted once this one opens successfully.
 */

import { generateUserKeyPair, getParticipantId } from '../crypto';
import {
  DEDUP_CHAT_RETENTION_MS,
  INVITE_SEC,
  QUICK_MESSAGE_SEC,
} from './constants';
import type { StoredChain } from './epochChain';
import type { ProcessedPacket } from './dedup';
import type { NostrEvent } from '../nostr/nostrEvent';
import type {
  ChatMessage,
  ContactInfo,
  HistoryPolicy,
  MetadataPolicy,
  RoomMode,
} from './types';

const DB_NAME = 'AirComicDB_v3';
const DB_VERSION = 1;
const LEGACY_DB_NAME = 'AirComicDB_v2';

const PREAPPROVAL_TTL_MS = 7 * 24 * 3600 * 1000;
const QUICK_ACK_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_STORED_KEYS_PER_CONV = 50;

// ----------------------------------------------------------------------------
// Record shapes
// ----------------------------------------------------------------------------

export interface UserProfile {
  id: 'current_user';
  participantId: string;
  screenName: string;
  avatarName?: string;
  backdropName?: string;
  publicKeyBase64: string;
  publicKeyPem: string;
  privateKeyJwk: JsonWebKey;
  privateKeyPem: string;
  signingPublicKeyBase64: string;
  signingPublicKeyPem: string;
  signingPrivateKeyJwk: JsonWebKey;
  signingPrivateKeyPem: string;
  contactInfo: ContactInfo;
  createdAt: number;
  updatedAt: number;
}

export interface Friend {
  id: string;
  participantId: string;
  screenName: string;
  avatarName?: string;
  publicKey: string;
  signingPublicKey: string;
  contactInfo?: ContactInfo;
  notes?: string;
  lastSeen?: number;
  /** The capability this contact issued to us, letting us watch them [X-11]. */
  theirPresenceCapability?: string;
  theirCapabilityGeneration?: number;
  /** Whether we have issued them our current capability. */
  sharedOurCapabilityGeneration?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRecord {
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string;
  publicJoinToken?: string;
  publicRoomId?: string;
  routingTag: string;
  /** Bumped by every capability rotation [X-08]. */
  capabilityGeneration: number;
  /** Routes kept under observation only to collect a rotation packet [PR-07]. */
  previousRoutingTags: Array<{ routingTag: string; roomSecret: string; until: number }>;
  activeEpoch: number;
  activeKeyId: string;
  isCreator: boolean;
  channelTitle: string;
  historyPolicy: HistoryPolicy;
  metadataPolicy: MetadataPolicy;
  genesisPacketId?: string;
  updatedAt: number;
}

export interface StoredEpochKey {
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

export type OutboxState = 'pending' | 'relayed' | 'failed';

export interface OutboxRecord {
  packetId: string;
  convId?: string;
  signedEvent: NostrEvent;
  targetRelays: string[];
  acknowledgedRelays: string[];
  rejectedRelays: string[];
  attempts: number;
  nextAttemptAt: number;
  expiresAt: number | null;
  state: OutboxState;
  lastError?: string;
  createdAt: number;
}

export interface RelayCursor {
  /** `${relayUrl}::${routingTag}` */
  id: string;
  relayUrl: string;
  routingTag: string;
  lastCommittedTimestamp: number;
  lastEventId?: string;
}

export interface PresenceCapabilityRecord {
  id: 'self';
  capability: string;
  generation: number;
  updatedAt: number;
}

export interface SettingsRecord {
  id: 'app';
  relayUrls: string[];
  webrtcEnabled: boolean;
  /** Only 'convenience' today; locked-vault mode is future work [U-04][S-02]. */
  storageMode: 'convenience' | 'vault';
  updatedAt: number;
}

export interface PendingInviteRecord {
  inviteId: string;
  recipientParticipantId: string;
  recipientScreenName: string;
  recipientPublicKey: string;
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string;
  publicJoinToken?: string;
  capabilityGeneration: number;
  channelTitle: string;
  status: 'queued' | 'sent' | 'accepted' | 'declined';
  createdAt: number;
  updatedAt: number;
  lastAttemptAt?: number;
}

export interface RoomPreapprovalRecord {
  id: string;
  convId: string;
  participantId: string;
  screenName?: string;
  createdAt: number;
}

export interface FavoriteRoomRecord {
  id: string;
  convId: string;
  roomMode: RoomMode;
  roomSecret?: string;
  publicJoinToken?: string;
  capabilityGeneration?: number;
  name: string;
  description?: string;
  members: Array<{ participantId: string; screenName: string; avatarName?: string }>;
  membersUpdatedAt?: number;
  savedAt: number;
}

export interface QuickMessageAckRecord {
  id: string;
  senderParticipantId?: string;
  ackedAt: number;
}

// ----------------------------------------------------------------------------
// Service
// ----------------------------------------------------------------------------

export class DatabaseService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /** The name is injectable so tests can run several isolated profiles. */
  constructor(private readonly name: string = DB_NAME) {}

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        db.createObjectStore('profile', { keyPath: 'id' });

        const friends = db.createObjectStore('friends', { keyPath: 'id' });
        friends.createIndex('participantId', 'participantId', { unique: false });

        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('convId', 'convId', { unique: false });
        messages.createIndex('timestamp', 'timestamp', { unique: false });

        const keys = db.createObjectStore('keys', { keyPath: 'id' });
        keys.createIndex('convId', 'convId', { unique: false });

        db.createObjectStore('conversations', { keyPath: 'convId' });

        // Validated membership chain per room, so a reload does not have to
        // rebuild it from relays [L-05][G-03].
        db.createObjectStore('membershipHeads', { keyPath: 'convId' });

        // Time-aware dedup, replacing v2's FIFO ledger [X-06][O-10].
        const processed = db.createObjectStore('processedPackets', { keyPath: 'id' });
        processed.createIndex('convId', 'convId', { unique: false });
        processed.createIndex('firstSeenAt', 'firstSeenAt', { unique: false });

        // Durable publish queue: persist before publish [D-01][A-05].
        const outbox = db.createObjectStore('nostrOutbox', { keyPath: 'packetId' });
        outbox.createIndex('state', 'state', { unique: false });
        outbox.createIndex('nextAttemptAt', 'nextAttemptAt', { unique: false });

        const cursors = db.createObjectStore('relayCursors', { keyPath: 'id' });
        cursors.createIndex('routingTag', 'routingTag', { unique: false });

        db.createObjectStore('presenceCapability', { keyPath: 'id' });
        db.createObjectStore('settings', { keyPath: 'id' });

        const favorites = db.createObjectStore('favorites', { keyPath: 'id' });
        favorites.createIndex('savedAt', 'savedAt', { unique: false });

        const invites = db.createObjectStore('invites', { keyPath: 'inviteId' });
        invites.createIndex('recipientParticipantId', 'recipientParticipantId', { unique: false });

        const preapprovals = db.createObjectStore('preapprovals', { keyPath: 'id' });
        preapprovals.createIndex('convId', 'convId', { unique: false });

        const acks = db.createObjectStore('quickMessageAcks', { keyPath: 'id' });
        acks.createIndex('ackedAt', 'ackedAt', { unique: false });
      };

      request.onsuccess = () => {
        // Only once the new database is definitely usable [C-02].
        try {
          indexedDB.deleteDatabase(LEGACY_DB_NAME);
        } catch {
          /* a leftover v2 database is harmless if it cannot be removed */
        }
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  private async tx<T>(
    store: string,
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = run(transaction.objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async all<T>(store: string, index?: string, query?: IDBValidKey | IDBKeyRange) {
    const db = await this.getDB();
    return new Promise<T[]>((resolve, reject) => {
      const transaction = db.transaction(store, 'readonly');
      const source: IDBObjectStore | IDBIndex = index
        ? transaction.objectStore(store).index(index)
        : transaction.objectStore(store);
      const request = source.getAll(query);
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  }

  // --- Profile -------------------------------------------------------------

  async getProfile(): Promise<UserProfile | undefined> {
    return this.tx<UserProfile | undefined>('profile', 'readonly', (s) => s.get('current_user'));
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    await this.tx('profile', 'readwrite', (s) => s.put({ ...profile, updatedAt: Date.now() }));
  }

  /** Creates the identity on first run. A clean cutover always starts here. */
  async getOrCreateProfile(defaultScreenName = 'Anonymous'): Promise<UserProfile> {
    const existing = await this.getProfile();
    if (existing) return existing;

    const identity = await generateUserKeyPair();
    const profile: UserProfile = {
      id: 'current_user',
      participantId: identity.participantId,
      screenName: defaultScreenName,
      avatarName: 'Armando',
      publicKeyBase64: identity.publicKeyBase64,
      publicKeyPem: identity.publicKeyPem,
      privateKeyJwk: identity.privateKeyJwk,
      privateKeyPem: identity.privateKeyPem,
      signingPublicKeyBase64: identity.signingPublicKeyBase64,
      signingPublicKeyPem: identity.signingPublicKeyPem,
      signingPrivateKeyJwk: identity.signingPrivateKeyJwk,
      signingPrivateKeyPem: identity.signingPrivateKeyPem,
      contactInfo: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.saveProfile(profile);
    return profile;
  }

  async replaceIdentity(profile: UserProfile): Promise<UserProfile> {
    const identity = await generateUserKeyPair();
    const next: UserProfile = {
      ...profile,
      participantId: identity.participantId,
      publicKeyBase64: identity.publicKeyBase64,
      publicKeyPem: identity.publicKeyPem,
      privateKeyJwk: identity.privateKeyJwk,
      privateKeyPem: identity.privateKeyPem,
      signingPublicKeyBase64: identity.signingPublicKeyBase64,
      signingPublicKeyPem: identity.signingPublicKeyPem,
      signingPrivateKeyJwk: identity.signingPrivateKeyJwk,
      signingPrivateKeyPem: identity.signingPrivateKeyPem,
      updatedAt: Date.now(),
    };
    await this.saveProfile(next);
    return next;
  }

  // --- Friends -------------------------------------------------------------

  async getFriends(): Promise<Friend[]> {
    return this.all<Friend>('friends');
  }

  async saveFriend(friend: Friend): Promise<void> {
    await this.tx('friends', 'readwrite', (s) => s.put({ ...friend, updatedAt: Date.now() }));
  }

  async deleteFriend(id: string): Promise<void> {
    await this.tx('friends', 'readwrite', (s) => s.delete(id));
  }

  // --- Messages ------------------------------------------------------------

  async getMessages(convId: string): Promise<ChatMessage[]> {
    const rows = await this.all<ChatMessage>('messages', 'convId', convId);
    return rows.sort((a, b) => a.timestamp - b.timestamp);
  }

  async saveMessage(message: ChatMessage): Promise<void> {
    await this.tx('messages', 'readwrite', (s) => s.put(message));
  }

  async clearMessages(convId: string): Promise<void> {
    const db = await this.getDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('messages', 'readwrite');
      const index = transaction.objectStore('messages').index('convId');
      const cursorReq = index.openCursor(IDBKeyRange.only(convId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // --- Conversations -------------------------------------------------------

  async getConversation(convId: string): Promise<ConversationRecord | undefined> {
    return this.tx<ConversationRecord | undefined>('conversations', 'readonly', (s) =>
      s.get(convId)
    );
  }

  async getConversations(): Promise<ConversationRecord[]> {
    return this.all<ConversationRecord>('conversations');
  }

  async saveConversation(record: ConversationRecord): Promise<void> {
    await this.tx('conversations', 'readwrite', (s) =>
      s.put({ ...record, updatedAt: Date.now() })
    );
  }

  // --- Epoch keys ----------------------------------------------------------

  async getEpochKeys(convId: string): Promise<StoredEpochKey[]> {
    const rows = await this.all<StoredEpochKey>('keys', 'convId', convId);
    return rows.sort((a, b) => a.epoch - b.epoch);
  }

  async saveEpochKey(record: Omit<StoredEpochKey, 'id' | 'savedAt'>): Promise<void> {
    await this.tx('keys', 'readwrite', (s) =>
      s.put({ ...record, id: `${record.convId}::${record.keyId}`, savedAt: Date.now() })
    );
    const rows = await this.getEpochKeys(record.convId);
    if (rows.length > MAX_STORED_KEYS_PER_CONV) {
      const excess = rows.slice(0, rows.length - MAX_STORED_KEYS_PER_CONV);
      for (const row of excess) {
        await this.tx('keys', 'readwrite', (s) => s.delete(row.id));
      }
    }
  }

  // --- Membership chain ----------------------------------------------------

  async getChain(convId: string): Promise<StoredChain | undefined> {
    return this.tx<StoredChain | undefined>('membershipHeads', 'readonly', (s) => s.get(convId));
  }

  async saveChain(chain: StoredChain): Promise<void> {
    await this.tx('membershipHeads', 'readwrite', (s) => s.put(chain));
  }

  // --- Dedup ---------------------------------------------------------------

  async getProcessed(id: string): Promise<ProcessedPacket | undefined> {
    return this.tx<ProcessedPacket | undefined>('processedPackets', 'readonly', (s) => s.get(id));
  }

  async putProcessed(record: ProcessedPacket): Promise<void> {
    await this.tx('processedPackets', 'readwrite', (s) => s.put(record));
  }

  /** Chat records age out; control records live for the life of the room [X-06]. */
  async sweepProcessed(): Promise<void> {
    const cutoff = Date.now() - DEDUP_CHAT_RETENTION_MS;
    const rows = await this.all<ProcessedPacket>('processedPackets');
    for (const row of rows) {
      if (row.retentionClass === 'chat' && row.firstSeenAt < cutoff) {
        await this.tx('processedPackets', 'readwrite', (s) => s.delete(row.id));
      }
    }
  }

  // --- Outbox --------------------------------------------------------------

  async getOutbox(): Promise<OutboxRecord[]> {
    return this.all<OutboxRecord>('nostrOutbox');
  }

  async getPendingOutbox(): Promise<OutboxRecord[]> {
    const rows = await this.all<OutboxRecord>('nostrOutbox', 'state', 'pending');
    return rows.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  }

  async saveOutbox(record: OutboxRecord): Promise<void> {
    await this.tx('nostrOutbox', 'readwrite', (s) => s.put(record));
  }

  async deleteOutbox(packetId: string): Promise<void> {
    await this.tx('nostrOutbox', 'readwrite', (s) => s.delete(packetId));
  }

  // --- Relay cursors -------------------------------------------------------

  async getCursor(relayUrl: string, routingTag: string): Promise<RelayCursor | undefined> {
    return this.tx<RelayCursor | undefined>('relayCursors', 'readonly', (s) =>
      s.get(`${relayUrl}::${routingTag}`)
    );
  }

  async getCursorsForTag(routingTag: string): Promise<RelayCursor[]> {
    return this.all<RelayCursor>('relayCursors', 'routingTag', routingTag);
  }

  async saveCursor(cursor: Omit<RelayCursor, 'id'>): Promise<void> {
    await this.tx('relayCursors', 'readwrite', (s) =>
      s.put({ ...cursor, id: `${cursor.relayUrl}::${cursor.routingTag}` })
    );
  }

  // --- Presence capability -------------------------------------------------

  async getPresenceCapability(): Promise<PresenceCapabilityRecord | undefined> {
    return this.tx<PresenceCapabilityRecord | undefined>('presenceCapability', 'readonly', (s) =>
      s.get('self')
    );
  }

  async savePresenceCapability(record: Omit<PresenceCapabilityRecord, 'id'>): Promise<void> {
    await this.tx('presenceCapability', 'readwrite', (s) => s.put({ ...record, id: 'self' }));
  }

  // --- Settings ------------------------------------------------------------

  async getSettings(): Promise<SettingsRecord | undefined> {
    return this.tx<SettingsRecord | undefined>('settings', 'readonly', (s) => s.get('app'));
  }

  async saveSettings(record: Omit<SettingsRecord, 'id' | 'updatedAt'>): Promise<void> {
    await this.tx('settings', 'readwrite', (s) =>
      s.put({ ...record, id: 'app', updatedAt: Date.now() })
    );
  }

  // --- Invitations and pre-approvals ---------------------------------------

  async getPendingInvites(): Promise<PendingInviteRecord[]> {
    return this.all<PendingInviteRecord>('invites');
  }

  async savePendingInvite(record: PendingInviteRecord): Promise<void> {
    await this.tx('invites', 'readwrite', (s) => s.put({ ...record, updatedAt: Date.now() }));
  }

  async deletePendingInvite(inviteId: string): Promise<void> {
    await this.tx('invites', 'readwrite', (s) => s.delete(inviteId));
  }

  async getPreapprovals(): Promise<RoomPreapprovalRecord[]> {
    const rows = await this.all<RoomPreapprovalRecord>('preapprovals');
    const cutoff = Date.now() - PREAPPROVAL_TTL_MS;
    const live = rows.filter((r) => r.createdAt >= cutoff);
    for (const stale of rows.filter((r) => r.createdAt < cutoff)) {
      await this.tx('preapprovals', 'readwrite', (s) => s.delete(stale.id));
    }
    return live;
  }

  async savePreapproval(convId: string, participantId: string, screenName?: string): Promise<void> {
    await this.tx('preapprovals', 'readwrite', (s) =>
      s.put({ id: `${convId}::${participantId}`, convId, participantId, screenName, createdAt: Date.now() })
    );
  }

  async deletePreapproval(convId: string, participantId: string): Promise<void> {
    await this.tx('preapprovals', 'readwrite', (s) => s.delete(`${convId}::${participantId}`));
  }

  // --- Favourites ----------------------------------------------------------

  async getFavorites(): Promise<FavoriteRoomRecord[]> {
    const rows = await this.all<FavoriteRoomRecord>('favorites');
    return rows.sort((a, b) => b.savedAt - a.savedAt);
  }

  async saveFavorite(record: FavoriteRoomRecord): Promise<void> {
    await this.tx('favorites', 'readwrite', (s) => s.put(record));
  }

  async deleteFavorite(id: string): Promise<void> {
    await this.tx('favorites', 'readwrite', (s) => s.delete(id));
  }

  // --- Quick message acknowledgements --------------------------------------

  async getQuickMessageAcks(): Promise<string[]> {
    const rows = await this.all<QuickMessageAckRecord>('quickMessageAcks');
    const cutoff = Date.now() - QUICK_ACK_TTL_MS;
    const live = rows.filter((r) => r.ackedAt >= cutoff);
    for (const stale of rows.filter((r) => r.ackedAt < cutoff)) {
      await this.tx('quickMessageAcks', 'readwrite', (s) => s.delete(stale.id));
    }
    return live.map((r) => r.id);
  }

  async ackQuickMessage(id: string, senderParticipantId?: string): Promise<void> {
    await this.tx('quickMessageAcks', 'readwrite', (s) =>
      s.put({ id, senderParticipantId, ackedAt: Date.now() })
    );
  }
}

export const db = new DatabaseService();
export { getParticipantId, INVITE_SEC, QUICK_MESSAGE_SEC };
