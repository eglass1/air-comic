/**
 * Contact presence, sealed inbox, invitations and quick messages.
 * Implementation plan [X-10], [X-11], [N-01]..[N-05].
 *
 * Three v2 defects are closed here:
 *   [O-06] SealedEnvelope was unsigned and QuickMessagePayload had no signature
 *          at all, so quick-message sender identity was spoofable by anyone who
 *          knew the recipient's public key. Both are signed now.
 *   [O-11] presence tags were SHA-256 of a publicly known participantId, so
 *          anyone who had ever seen a user could track them. Presence is now
 *          published to a random capability tag shared only with accepted
 *          contacts, and rotated on revocation.
 *
 * This service is a client of the shared RelayPool; it no longer opens its own
 * sockets [T-01][L-14].
 */

import {
  arrayBufferToBase64Url,
  base64UrlToArrayBuffer,
  decryptAsymmetric,
  encryptAsymmetric,
  getParticipantId,
  importPublicKey,
  importRawAesKey,
  importSigningPrivateKeyFromJwk,
  normalizePublicKey,
  canonicalStringify,
  signData,
  verifySignature,
} from '../crypto';
import { relayPool } from '../nostr/relayPool';
import { buildNostrEvent, replaceableTags } from '../nostr/nostrEvent';
import { dTagFilters } from '../nostr/subscriptions';
import {
  DOMAIN_SEALED_ENVELOPE,
  EXT_PRESENCE,
  INVITE_SEC,
  MAX_ENVELOPE_BYTES,
  PROTOCOL,
  QUICK_MESSAGE_SEC,
  SEAL_AAD_PREFIX,
  T_INBOX,
  T_USER_PRESENCE,
  USER_PRESENCE_FRESH_MS,
  USER_PRESENCE_REFRESH_MS,
  USER_PRESENCE_SEC,
  USER_PRESENCE_SWEEP_MS,
} from './constants';
import { db as defaultDb, type DatabaseService, type Friend, type UserProfile } from './db';
import {
  deriveInboxTag,
  derivePresenceCapabilityTag,
  deriveQuickMessageTag,
  deriveResponseTag,
  deriveScopedNostrSecretKey,
  generateCapability,
  inboxNostrScope,
} from './keys';
import {
  buildContactCapability,
  buildPresence,
  verifyContactCapability,
  verifyInviteResponse,
  verifyPresence,
  verifyQuickMessage,
  verifyRoomInvite,
} from './packets';
import { safeParse } from './validate';
import type {
  ContactCapabilityPacket,
  FriendPresence,
  PresenceStatus,
  QuickMessagePayload,
  RoomInvitePayload,
  RoomInviteResponsePayload,
  SealedEnvelope,
} from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ----------------------------------------------------------------------------
// Signed sealed envelope  [X-10][N-02]
// ----------------------------------------------------------------------------

function sealAad(recipient: string, sender: string, timestamp: number): string {
  return `${SEAL_AAD_PREFIX}${recipient}:${sender}:${timestamp}`;
}

export async function sealForParticipant(params: {
  recipientParticipantId: string;
  recipientPublicKey: string;
  senderParticipantId: string;
  senderSigningPublicKey: string;
  signingPrivateKey: CryptoKey;
  payload: unknown;
}): Promise<SealedEnvelope> {
  const recipientKey = await importPublicKey(params.recipientPublicKey);
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = await crypto.subtle.exportKey('raw', aesKey);
  const timestamp = Date.now();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(
        sealAad(params.recipientParticipantId, params.senderParticipantId, timestamp)
      ),
    },
    aesKey,
    encoder.encode(JSON.stringify(params.payload))
  );

  const unsigned: Omit<SealedEnvelope, 'signature'> = {
    type: 'sealed',
    protocol: PROTOCOL,
    extension: EXT_PRESENCE,
    recipientParticipantId: params.recipientParticipantId,
    senderParticipantId: params.senderParticipantId,
    senderSigningPublicKey: normalizePublicKey(params.senderSigningPublicKey),
    encryptedKey: await encryptAsymmetric(recipientKey, raw),
    iv: arrayBufferToBase64Url(iv),
    data: arrayBufferToBase64Url(ciphertext),
    timestamp,
  };

  const signature = await signData(
    params.signingPrivateKey,
    DOMAIN_SEALED_ENVELOPE + canonicalStringify(unsigned)
  );
  return { ...unsigned, signature };
}

/**
 * Verifies the envelope's own signature and identity binding BEFORE attempting
 * RSA decryption [N-02]. In v2 the seal proved only that the writer knew the
 * recipient's public key, which is public.
 */
export async function openSealedEnvelope(
  envelope: SealedEnvelope,
  recipientPrivateKey: CryptoKey
): Promise<unknown | null> {
  try {
    if (envelope?.type !== 'sealed' || !envelope.signature) return null;
    if ((await getParticipantId(envelope.senderSigningPublicKey)) !== envelope.senderParticipantId) {
      return null;
    }
    const { signature, ...unsigned } = envelope;
    const valid = await verifySignature(
      envelope.senderSigningPublicKey,
      DOMAIN_SEALED_ENVELOPE + canonicalStringify(unsigned),
      signature
    );
    if (!valid) return null;

    const raw = await decryptAsymmetric(recipientPrivateKey, envelope.encryptedKey);
    const aesKey = await importRawAesKey(raw);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(base64UrlToArrayBuffer(envelope.iv)),
        additionalData: encoder.encode(
          sealAad(
            envelope.recipientParticipantId,
            envelope.senderParticipantId,
            envelope.timestamp
          )
        ),
      },
      aesKey,
      base64UrlToArrayBuffer(envelope.data)
    );
    return safeParse(decoder.decode(plaintext), MAX_ENVELOPE_BYTES);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Service
// ----------------------------------------------------------------------------

export interface PresenceCallbacks {
  onPresenceChange?: (presence: FriendPresence) => void;
  onInvite?: (invite: RoomInvitePayload) => void;
  onInviteResponse?: (response: RoomInviteResponsePayload) => void;
  onQuickMessage?: (message: QuickMessagePayload) => void;
  onCapabilityReceived?: (packet: ContactCapabilityPacket) => void;
}

export class PresenceService {
  private profile: UserProfile | null = null;
  private privateKey: CryptoKey | null = null;
  private signingPrivateKey: CryptoKey | null = null;
  private nostrSecretKey: Uint8Array | null = null;

  private capability = '';
  private generation = 0;
  private myTags: { inbox: string; response: string; quickMsg: string; presence: string } | null =
    null;

  private watched = new Map<string, string>(); // capability tag -> participantId
  private presenceByParticipant = new Map<string, FriendPresence>();
  private handledInviteIds = new Set<string>();
  private handledQuickMsgIds = new Set<string>();

  private inboxSub: { close(): void } | null = null;
  private presenceSub: { close(): void; update(f: unknown[]): void } | null = null;
  private republishTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private callbacks: PresenceCallbacks = {};
  private started = false;

  constructor(private db: DatabaseService = defaultDb) {}

  setCallbacks(callbacks: PresenceCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  getPresence(participantId: string): FriendPresence | null {
    return this.presenceByParticipant.get(participantId) ?? null;
  }

  isOnline(participantId: string): boolean {
    const presence = this.presenceByParticipant.get(participantId);
    if (!presence || presence.status === 'offline') return false;
    return Date.now() - presence.lastSeen <= USER_PRESENCE_FRESH_MS;
  }

  /** Our current capability, for issuing to a newly accepted contact. */
  get currentCapability(): { capability: string; generation: number } {
    return { capability: this.capability, generation: this.generation };
  }

  async start(profile: UserProfile): Promise<void> {
    this.profile = profile;
    this.privateKey = await crypto.subtle.importKey(
      'jwk',
      profile.privateKeyJwk,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['decrypt', 'unwrapKey']
    );
    this.signingPrivateKey = await importSigningPrivateKeyFromJwk(profile.signingPrivateKeyJwk);
    this.nostrSecretKey = await deriveScopedNostrSecretKey(
      profile.signingPrivateKeyJwk,
      inboxNostrScope(profile.participantId)
    );

    const stored = await this.db.getPresenceCapability();
    if (stored) {
      this.capability = stored.capability;
      this.generation = stored.generation;
    } else {
      this.capability = generateCapability();
      this.generation = 1;
      await this.db.savePresenceCapability({
        capability: this.capability,
        generation: this.generation,
        updatedAt: Date.now(),
      });
    }

    this.myTags = {
      inbox: await deriveInboxTag(profile.participantId),
      response: await deriveResponseTag(profile.participantId),
      quickMsg: await deriveQuickMessageTag(profile.participantId),
      presence: await derivePresenceCapabilityTag(this.capability),
    };

    this.subscribeInbox();
    await this.publishPresence('online');

    if (!this.started) {
      this.started = true;
      this.republishTimer = setInterval(
        () => void this.publishPresence('online'),
        USER_PRESENCE_REFRESH_MS
      );
      this.sweepTimer = setInterval(() => this.sweep(), USER_PRESENCE_SWEEP_MS);
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', () => void this.publishPresence('offline'));
      }
    }
  }

  // --- Presence -------------------------------------------------------------

  async publishPresence(status: PresenceStatus): Promise<void> {
    if (!this.profile || !this.signingPrivateKey || !this.nostrSecretKey || !this.myTags) return;

    const packet = await buildPresence({
      participantId: this.profile.participantId,
      screenName: this.profile.screenName,
      avatarName: this.profile.avatarName,
      publicKey: this.profile.publicKeyBase64,
      signingPublicKey: this.profile.signingPublicKeyBase64,
      status,
      signingPrivateKey: this.signingPrivateKey,
    });

    const event = await buildNostrEvent({
      secretKey: this.nostrSecretKey,
      tags: replaceableTags({
        d: this.myTags.presence,
        topic: T_USER_PRESENCE,
        expirationSec: USER_PRESENCE_SEC,
      }),
      content: JSON.stringify(packet),
    });
    await relayPool.publish(event);
  }

  /**
   * Watches only contacts who have issued us a capability. Someone who has not
   * is "presence not shared", which is a different thing from offline [N-01].
   */
  async watchContacts(friends: Friend[]): Promise<void> {
    const next = new Map<string, string>();
    for (const friend of friends) {
      if (!friend.theirPresenceCapability) continue;
      next.set(await derivePresenceCapabilityTag(friend.theirPresenceCapability), friend.participantId);
    }
    this.watched = next;

    for (const id of Array.from(this.presenceByParticipant.keys())) {
      if (!Array.from(next.values()).includes(id)) this.presenceByParticipant.delete(id);
    }

    const filters = dTagFilters(Array.from(next.keys()), next.size * 2);
    if (this.presenceSub) {
      this.presenceSub.update(filters);
    } else if (filters.length > 0) {
      this.presenceSub = relayPool.subscribe({
        id: 'presence-watch',
        filters,
        onEvent: (event) => void this.handlePresenceEvent(event),
      });
    }
  }

  private async handlePresenceEvent(event: { content: string; tags: string[][] }): Promise<void> {
    const packet = safeParse(event.content, 8192) as
      | (Record<string, unknown> & { type?: string })
      | null;
    if (packet?.type !== 'presence') return;

    const presence = packet as unknown as import('./types').PresencePacket;
    if (!(await verifyPresence(presence))) return;

    // The capability tag must be one we are watching, and must map to the
    // participant the packet claims to be from.
    const tag = event.tags.find((t) => t[0] === 'd')?.[1];
    if (!tag || this.watched.get(tag) !== presence.participantId) return;

    const previous = this.presenceByParticipant.get(presence.participantId);
    if (previous && previous.lastSeen > presence.timestamp) return;

    const fresh = Date.now() - presence.timestamp <= USER_PRESENCE_FRESH_MS;
    const next: FriendPresence = {
      participantId: presence.participantId,
      screenName: presence.screenName,
      avatarName: presence.avatarName,
      status: presence.status === 'offline' || !fresh ? 'offline' : presence.status,
      lastSeen: presence.timestamp,
    };
    this.presenceByParticipant.set(presence.participantId, next);
    if (!previous || previous.status !== next.status) this.callbacks.onPresenceChange?.(next);
  }

  private sweep() {
    const now = Date.now();
    for (const [id, presence] of this.presenceByParticipant) {
      if (presence.status !== 'offline' && now - presence.lastSeen > USER_PRESENCE_FRESH_MS) {
        const next: FriendPresence = { ...presence, status: 'offline' };
        this.presenceByParticipant.set(id, next);
        this.callbacks.onPresenceChange?.(next);
      }
    }
  }

  // --- Capability issue and rotation  [X-11] --------------------------------

  /** Gives one contact our current capability, sealed to them. */
  async issueCapability(friend: Friend): Promise<boolean> {
    if (!this.profile || !this.signingPrivateKey || !friend.publicKey) return false;
    const packet = await buildContactCapability({
      issuerId: this.profile.participantId,
      issuerSigningPublicKey: this.profile.signingPublicKeyBase64,
      issuerScreenName: this.profile.screenName,
      capability: this.capability,
      generation: this.generation,
      signingPrivateKey: this.signingPrivateKey,
    });
    return this.sendSealed(friend.participantId, friend.publicKey, packet, INVITE_SEC, 'inbox');
  }

  /**
   * Revoking a contact rotates our capability and re-issues it to everyone who
   * remains authorised. The revoked contact is simply not sent the new one and
   * their subscription goes quiet when the old event expires [N-01].
   */
  async rotateCapability(remaining: Friend[]): Promise<void> {
    if (!this.profile) return;
    this.capability = generateCapability();
    this.generation += 1;
    await this.db.savePresenceCapability({
      capability: this.capability,
      generation: this.generation,
      updatedAt: Date.now(),
    });
    if (this.myTags) {
      this.myTags.presence = await derivePresenceCapabilityTag(this.capability);
    }
    await this.publishPresence('online');
    for (const friend of remaining) await this.issueCapability(friend);
  }

  // --- Sealed inbox ---------------------------------------------------------

  private async sendSealed(
    recipientParticipantId: string,
    recipientPublicKey: string,
    payload: unknown,
    expirationSec: number,
    box: 'inbox' | 'response' | 'quick'
  ): Promise<boolean> {
    if (!this.profile || !this.signingPrivateKey || !this.nostrSecretKey) return false;

    const sealed = await sealForParticipant({
      recipientParticipantId,
      recipientPublicKey,
      senderParticipantId: this.profile.participantId,
      senderSigningPublicKey: this.profile.signingPublicKeyBase64,
      signingPrivateKey: this.signingPrivateKey,
      payload,
    });

    const base = await deriveInboxTag(recipientParticipantId);
    const d = box === 'inbox' ? base : box === 'response' ? base + '~r' : base + '~qm';

    const event = await buildNostrEvent({
      secretKey: this.nostrSecretKey,
      tags: replaceableTags({ d, topic: T_INBOX, expirationSec }),
      content: JSON.stringify(sealed),
    });
    const result = await relayPool.publish(event);
    return result.quorumMet;
  }

  async sendInviteBundle(
    recipientParticipantId: string,
    recipientPublicKey: string,
    invites: RoomInvitePayload[]
  ): Promise<boolean> {
    return this.sendSealed(
      recipientParticipantId,
      recipientPublicKey,
      { type: 'invite_bundle', invites },
      INVITE_SEC,
      'inbox'
    );
  }

  async clearInviteBundle(recipientParticipantId: string, recipientPublicKey: string) {
    await this.sendInviteBundle(recipientParticipantId, recipientPublicKey, []);
  }

  async sendInviteResponse(
    inviterParticipantId: string,
    inviterPublicKey: string,
    response: RoomInviteResponsePayload
  ): Promise<boolean> {
    return this.sendSealed(
      inviterParticipantId,
      inviterPublicKey,
      { type: 'invite_response_bundle', responses: [response] },
      INVITE_SEC,
      'response'
    );
  }

  async sendQuickMessage(
    recipientParticipantId: string,
    recipientPublicKey: string,
    message: QuickMessagePayload
  ): Promise<boolean> {
    return this.sendSealed(
      recipientParticipantId,
      recipientPublicKey,
      message,
      QUICK_MESSAGE_SEC,
      'quick'
    );
  }

  markInviteHandled(inviteId: string) {
    this.handledInviteIds.add(inviteId);
  }

  private subscribeInbox() {
    if (!this.myTags) return;
    this.inboxSub?.close();
    this.inboxSub = relayPool.subscribe({
      id: 'inbox',
      filters: dTagFilters(
        [this.myTags.inbox, this.myTags.response, this.myTags.quickMsg],
        50
      ),
      onEvent: (event) => void this.handleInboxEvent(event),
    });
  }

  private async handleInboxEvent(event: { content: string }): Promise<void> {
    if (!this.privateKey || !this.profile) return;

    const sealed = safeParse(event.content, MAX_ENVELOPE_BYTES) as SealedEnvelope | null;
    if (sealed?.type !== 'sealed') return;
    if (sealed.recipientParticipantId !== this.profile.participantId) return;

    const body = (await openSealedEnvelope(sealed, this.privateKey)) as
      | (Record<string, unknown> & { type?: string })
      | null;
    if (!body?.type) return;

    if (body.type === 'invite_bundle' && Array.isArray(body.invites)) {
      for (const invite of body.invites as RoomInvitePayload[]) {
        if (invite?.type !== 'room_invite') continue;
        if (invite.recipientParticipantId !== this.profile.participantId) continue;
        // The signed envelope and the signed invitation must name one identity.
        if (invite.inviter?.participantId !== sealed.senderParticipantId) continue;
        if (this.handledInviteIds.has(invite.inviteId)) continue;
        if (!(await verifyRoomInvite(invite))) continue;
        this.callbacks.onInvite?.(invite);
      }
      return;
    }

    if (body.type === 'invite_response_bundle' && Array.isArray(body.responses)) {
      for (const response of body.responses as RoomInviteResponsePayload[]) {
        if (response?.type !== 'room_invite_response') continue;
        if (response.responderParticipantId !== sealed.senderParticipantId) continue;
        if (!(await verifyInviteResponse(response))) continue;
        this.callbacks.onInviteResponse?.(response);
      }
      return;
    }

    if (body.type === 'quick_message') {
      const message = body as unknown as QuickMessagePayload;
      if (message.recipientParticipantId !== this.profile.participantId) return;
      if (message.senderParticipantId !== sealed.senderParticipantId) return;
      // Signed in v3, so the sender cannot be spoofed [O-06][N-03].
      if (!(await verifyQuickMessage(message))) return;
      if (this.handledQuickMsgIds.has(message.id)) return;
      this.handledQuickMsgIds.add(message.id);
      this.callbacks.onQuickMessage?.(message);
      return;
    }

    if (body.type === 'contact_capability') {
      const packet = body as unknown as ContactCapabilityPacket;
      if (packet.issuerId !== sealed.senderParticipantId) return;
      if (!(await verifyContactCapability(packet))) return;
      this.callbacks.onCapabilityReceived?.(packet);
    }
  }

  async stop(): Promise<void> {
    await this.publishPresence('offline').catch(() => {});
    if (this.republishTimer) clearInterval(this.republishTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.republishTimer = null;
    this.sweepTimer = null;
    this.inboxSub?.close();
    this.presenceSub?.close();
    this.presenceByParticipant.clear();
    this.started = false;
  }
}

export const presenceService = new PresenceService();
