import type { UserProfile, Friend, ChatMessage, RekeyPacket, PendingInviteRecord } from '../types';
import { generateUserKeyPair, getParticipantId } from './crypto';

const DB_NAME = 'AirComicDB_v2';
const DB_VERSION = 2;

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

        // Cached keys store
        if (!db.objectStoreNames.contains('keys')) {
          const keyStore = db.createObjectStore('keys', { keyPath: 'keyId' });
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
    convId: string,
    keyId: string,
    epoch: number,
    rawBase64Url: string,
    signerId?: string,
    members: string[] = []
  ): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite');
      const store = transaction.objectStore('keys');
      const request = store.put({
        keyId,
        convId,
        epoch,
        rawBase64Url,
        signerId,
        members,
        savedAt: Date.now(),
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getConversationKeys(convId: string): Promise<Array<{ keyId: string; epoch: number; rawBase64Url: string; signerId?: string; members?: string[] }>> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('keys', 'readonly');
      const store = transaction.objectStore('keys');
      const index = store.index('convId');
      const request = index.getAll(convId);
      request.onsuccess = () => resolve(request.result || []);
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
