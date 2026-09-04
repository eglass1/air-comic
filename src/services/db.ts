import type {
  UserProfile,
  Friend,
  ChatMessage,
  RekeyPacket,
  PendingInviteRecord,
  QuickMessageAckRecord,
  RoomPreapprovalRecord,
  StoredConversationKey,
} from '../types';
import { generateUserKeyPair, getParticipantId } from './crypto';

const DB_NAME = 'AirComicDB_v2';
const DB_VERSION = 5;

/**
 * How long an acknowledged quick message stays on the suppression list. The
 * relays only hold a quick message for an hour, so a week is comfortably longer
 * than anything that could still be replayed at us.
 */
const QUICK_MESSAGE_ACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an invitation keeps pre-authorising its recipient. Matches the TTL on
 * the published invite itself, so the pre-approval stops being honoured at the
 * same moment the invitation it came from would have expired.
 */
const PREAPPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Epoch keys kept per conversation. Only the newest matter for live traffic; the
 * rest are held so history synced from a peer under an older epoch still opens.
 */
const MAX_STORED_CONVERSATION_KEYS = 50;

export class DatabaseService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;

        // Profile store
        if (!db.objectStoreNames.contains('profile')) {
          db.createObjectStore('profile', { keyPath: 'id' });
        }

        // Friends directory store
        if (!db.objectStoreNames.contains('friends')) {
          const friendStore = db.createObjectStore('friends', { keyPath: 'id' });
          friendStore.createIndex('participantId', 'participantId', { unique: false });
          friendStore.createIndex('screenName', 'screenName', { unique: false });
        }

        // Messages store
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('convId', 'convId', { unique: false });
          msgStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Cached epoch keys, keyed by conversation as well as key id. Earlier
        // versions keyed on keyId alone but nothing ever wrote to the store, so
        // there is no data to migrate and it can simply be rebuilt.
        if (oldVersion < 5 && db.objectStoreNames.contains('keys')) {
          db.deleteObjectStore('keys');
        }
        if (!db.objectStoreNames.contains('keys')) {
          const keyStore = db.createObjectStore('keys', { keyPath: 'id' });
          keyStore.createIndex('convId', 'convId', { unique: false });
        }

        // Signed rekey packets store (for history & membership synchronization)
        if (!db.objectStoreNames.contains('rekeys')) {
          const rekeyStore = db.createObjectStore('rekeys', { keyPath: 'packetId' });
          rekeyStore.createIndex('convId', 'convId', { unique: false });
          rekeyStore.createIndex('epoch', 'epoch', { unique: false });
        }

        // Conversations metadata store
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'convId' });
        }

        // Quick messages the user has already dismissed or replied to. Relays
        // keep a quick message around after delivery, so without this the same
        // one pops up again on every reconnect.
        if (!db.objectStoreNames.contains('quickMessageAcks')) {
          const ackStore = db.createObjectStore('quickMessageAcks', { keyPath: 'id' });
          ackStore.createIndex('ackedAt', 'ackedAt', { unique: false });
        }

        // People we invited into a room, kept past the invitation itself so their
        // entry request is still granted without prompting after a reload.
        if (!db.objectStoreNames.contains('preapprovals')) {
          const preapprovalStore = db.createObjectStore('preapprovals', { keyPath: 'id' });
          preapprovalStore.createIndex('convId', 'convId', { unique: false });
          preapprovalStore.createIndex('participantId', 'participantId', { unique: false });
        }

        // Outgoing room invites, parked until the recipient is seen online
        if (!db.objectStoreNames.contains('invites')) {
          const inviteStore = db.createObjectStore('invites', { keyPath: 'inviteId' });
          inviteStore.createIndex('recipientParticipantId', 'recipientParticipantId', { unique: false });
          inviteStore.createIndex('status', 'status', { unique: false });
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        console.error('IndexedDB open error:', request.error);
        reject(request.error);
      };
    });

    return this.dbPromise;
  }

  // --- Profile Operations ---

  async getProfile(): Promise<UserProfile | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('profile', 'readonly');
      const store = transaction.objectStore('profile');
      const request = store.get('current_user');

      request.onsuccess = () => {
        resolve(request.result || null);
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('profile', 'readwrite');
      const store = transaction.objectStore('profile');
      const request = store.put({ ...profile, id: 'current_user', updatedAt: Date.now() });

      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async getOrInitProfile(): Promise<UserProfile> {
    const existing = await this.getProfile();
    if (existing && existing.participantId && existing.signingPublicKeyBase64) {
      if (!existing.avatarName) {
        existing.avatarName = 'Armando';
        existing.backdropName = 'room.bgb';
        await this.saveProfile(existing);
      }
      return existing;
    }

    // Generate fresh identity
    const generated = await generateUserKeyPair();
    const now = Date.now();
    const newProfile: UserProfile = {
      id: 'current_user',
      participantId: generated.participantId,
      screenName: existing?.screenName || 'AirComic User',
      avatarName: existing?.avatarName || 'Armando',
      backdropName: existing?.backdropName || 'room.bgb',
      publicKeyBase64: existing?.publicKeyBase64 || generated.publicKeyBase64,
      publicKeyPem: existing?.publicKeyPem || generated.publicKeyPem,
      privateKeyJwk: existing?.privateKeyJwk || generated.privateKeyJwk,
      privateKeyPem: existing?.privateKeyPem || generated.privateKeyPem,
      signingPublicKeyBase64: generated.signingPublicKeyBase64,
      signingPublicKeyPem: generated.signingPublicKeyPem,
      signingPrivateKeyJwk: generated.signingPrivateKeyJwk,
      signingPrivateKeyPem: generated.signingPrivateKeyPem,
      contactInfo: existing?.contactInfo || {
        info: '',
      },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    await this.saveProfile(newProfile);
    return newProfile;
  }

  // --- Friends Operations ---

  async getFriends(): Promise<Friend[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('friends', 'readonly');
      const store = transaction.objectStore('friends');
      const request = store.getAll();

      request.onsuccess = () => {
        const friends: Friend[] = request.result || [];
        friends.sort((a, b) => a.screenName.localeCompare(b.screenName));
        resolve(friends);
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async saveFriend(friend: Friend): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('friends', 'readwrite');
      const store = transaction.objectStore('friends');
      const request = store.put({
        ...friend,
        updatedAt: Date.now(),
      });

      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async deleteFriend(id: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('friends', 'readwrite');
      const store = transaction.objectStore('friends');
      const request = store.delete(id);

      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  // --- Messages Operations ---

  async getMessages(convId: string): Promise<ChatMessage[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('messages', 'readonly');
      const store = transaction.objectStore('messages');
      const index = store.index('convId');
      const request = index.getAll(convId);

      request.onsuccess = () => {
        const msgs: ChatMessage[] = request.result || [];
        msgs.sort((a, b) => a.timestamp - b.timestamp);
        resolve(msgs);
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async saveMessage(msg: ChatMessage): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('messages', 'readwrite');
      const store = transaction.objectStore('messages');
      const request = store.put(msg);

      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async clearMessages(convId: string): Promise<void> {
    const db = await this.getDB();
    const msgs = await this.getMessages(convId);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('messages', 'readwrite');
      const store = transaction.objectStore('messages');
      for (const m of msgs) {
        store.delete(m.id);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // --- Signed Rekey Chain Storage ---

  async saveRekeyPacket(packet: RekeyPacket): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('rekeys', 'readwrite');
      const store = transaction.objectStore('rekeys');
      const request = store.put(packet);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getRekeyPackets(convId: string): Promise<RekeyPacket[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('rekeys', 'readonly');
      const store = transaction.objectStore('rekeys');
      const index = store.index('convId');
      const request = index.getAll(convId);
      request.onsuccess = () => {
        const packets: RekeyPacket[] = request.result || [];
        packets.sort((a, b) => a.epoch - b.epoch);
        resolve(packets);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // --- Stored Conversation Keys ---

  async saveConversationKey(
    key: Omit<StoredConversationKey, 'id' | 'savedAt'>
  ): Promise<void> {
    if (!key.convId || !key.keyId || !key.rawBase64Url) return;
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite');
      const store = transaction.objectStore('keys');
      const record: StoredConversationKey = {
        ...key,
        id: `${key.convId}::${key.keyId}`,
        members: key.members || [],
        savedAt: Date.now(),
      };
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Stored epoch keys for a conversation, oldest first. Anything past the newest
   * MAX_STORED_CONVERSATION_KEYS is dropped on the way past, so a long-lived room
   * that rekeys on every membership change does not accumulate forever.
   */
  async getConversationKeys(convId: string): Promise<StoredConversationKey[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite');
      const store = transaction.objectStore('keys');
      const index = store.index('convId');
      const request = index.getAll(convId);

      request.onsuccess = () => {
        const records: StoredConversationKey[] = (request.result || []).filter((r) => r?.keyId);
        records.sort((a, b) => a.epoch - b.epoch);

        const excess = records.length - MAX_STORED_CONVERSATION_KEYS;
        if (excess > 0) {
          for (const stale of records.splice(0, excess)) store.delete(stale.id);
        }
        resolve(records);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // --- Conversation Metadata ---

  async saveConversationMetadata(convId: string, roomSecret: string, activeEpoch: number, activeKeyId: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('conversations', 'readwrite');
      const store = transaction.objectStore('conversations');
      const request = store.put({
        convId,
        roomSecret,
        activeEpoch,
        activeKeyId,
        updatedAt: Date.now(),
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // --- Acknowledged Quick Messages ---

  /**
   * Ids of quick messages the user has already dismissed or replied to. Expired
   * entries are swept on the way past so the list cannot grow without bound.
   */
  async getAcknowledgedQuickMessageIds(): Promise<string[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('quickMessageAcks', 'readwrite');
      const store = transaction.objectStore('quickMessageAcks');
      const request = store.getAll();

      request.onsuccess = () => {
        const records: QuickMessageAckRecord[] = request.result || [];
        const cutoff = Date.now() - QUICK_MESSAGE_ACK_TTL_MS;
        const live: string[] = [];
        for (const record of records) {
          if (!record?.id) continue;
          if (record.ackedAt < cutoff) store.delete(record.id);
          else live.push(record.id);
        }
        resolve(live);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async acknowledgeQuickMessage(id: string, senderParticipantId?: string): Promise<void> {
    if (!id) return;
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('quickMessageAcks', 'readwrite');
      const store = transaction.objectStore('quickMessageAcks');
      const record: QuickMessageAckRecord = { id, senderParticipantId, ackedAt: Date.now() };
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // --- Room Pre-approvals ---

  private static preapprovalId(convId: string, participantId: string): string {
    return `${convId}::${participantId}`;
  }

  /** Live pre-approvals, sweeping out any that have aged past the TTL. */
  async getPreapprovals(): Promise<RoomPreapprovalRecord[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('preapprovals', 'readwrite');
      const store = transaction.objectStore('preapprovals');
      const request = store.getAll();

      request.onsuccess = () => {
        const records: RoomPreapprovalRecord[] = request.result || [];
        const cutoff = Date.now() - PREAPPROVAL_TTL_MS;
        const live: RoomPreapprovalRecord[] = [];
        for (const record of records) {
          if (!record?.id) continue;
          if (record.createdAt < cutoff) store.delete(record.id);
          else live.push(record);
        }
        resolve(live);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async savePreapproval(convId: string, participantId: string, screenName?: string): Promise<void> {
    if (!convId || !participantId) return;
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('preapprovals', 'readwrite');
      const store = transaction.objectStore('preapprovals');
      const record: RoomPreapprovalRecord = {
        id: DatabaseService.preapprovalId(convId, participantId),
        convId,
        participantId,
        screenName,
        createdAt: Date.now(),
      };
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deletePreapproval(convId: string, participantId: string): Promise<void> {
    if (!convId || !participantId) return;
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('preapprovals', 'readwrite');
      const store = transaction.objectStore('preapprovals');
      const request = store.delete(DatabaseService.preapprovalId(convId, participantId));
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // --- Pending Outgoing Invites ---

  async getPendingInvites(): Promise<PendingInviteRecord[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('invites', 'readonly');
      const store = transaction.objectStore('invites');
      const request = store.getAll();
      request.onsuccess = () => {
        const invites: PendingInviteRecord[] = request.result || [];
        invites.sort((a, b) => a.createdAt - b.createdAt);
        resolve(invites);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async savePendingInvite(invite: PendingInviteRecord): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('invites', 'readwrite');
      const store = transaction.objectStore('invites');
      const request = store.put({ ...invite, updatedAt: Date.now() });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deletePendingInvite(inviteId: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('invites', 'readwrite');
      const store = transaction.objectStore('invites');
      const request = store.delete(inviteId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getConversationMetadata(convId: string): Promise<{ convId: string; roomSecret: string; activeEpoch: number; activeKeyId: string } | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('conversations', 'readonly');
      const store = transaction.objectStore('conversations');
      const request = store.get(convId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
}

export const dbService = new DatabaseService();
