/**
 * Cloud Backup & Restore service.
 *
 * Implements symmetric password-derived encryption (PBKDF2 + AES-GCM with GMAC
 * authentication and SHA-256 checksum verification), posting to Nostr relays as
 * a temporary "silent" replaceable event under a UUID key, and restoring from
 * a generated URL on any device.
 */

import { schnorr } from '@noble/secp256k1';
import {
  arrayBufferToBase64Url,
  base64UrlToArrayBuffer,
} from './crypto';
import { buildNostrEvent, toHex, NostrFilter } from './nostr/nostrEvent';
import { relayPool } from './nostr/relayPool';

export interface CloudBackupEnvelope {
  version: 1;
  alg: 'AES-GCM-256';
  kdf: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  salt: string; // base64url
  iv: string; // base64url
  ciphertext: string; // base64url (contains AES-GCM ciphertext + 16-byte authentication tag)
  checksum: string; // base64url SHA-256 digest of original plaintext for corruption verification
}

/**
 * Derives a 256-bit AES-GCM key from a user password and salt using PBKDF2 with SHA-256.
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations = 100000
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a profile export JSON string using a password.
 * Computes a SHA-256 checksum and uses AES-256-GCM (which provides GMAC authentication).
 */
export async function encryptCloudBackup(
  jsonStr: string,
  password: string
): Promise<CloudBackupEnvelope> {
  if (!password || !password.trim()) {
    throw new Error('Password is required for cloud export');
  }

  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPassword(password, salt, 100000);

  const plaintextBytes = enc.encode(jsonStr);

  // Compute SHA-256 checksum of plaintext
  const checksumBuf = await crypto.subtle.digest('SHA-256', plaintextBytes);
  const checksum = arrayBufferToBase64Url(checksumBuf);

  // AES-GCM authenticated encryption (GMAC tag automatically appended)
  const ciphertextBuf = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: enc.encode('aircomic-cloud-backup-v1'),
    },
    key,
    plaintextBytes
  );

  return {
    version: 1,
    alg: 'AES-GCM-256',
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations: 100000,
    salt: arrayBufferToBase64Url(salt),
    iv: arrayBufferToBase64Url(iv),
    ciphertext: arrayBufferToBase64Url(ciphertextBuf),
    checksum,
  };
}

/**
 * Decrypts a cloud backup envelope using the password.
 * Verifies the AES-GCM GMAC authentication tag and the SHA-256 checksum.
 * Throws if the password is wrong, tag mismatch, or corrupted data.
 */
export async function decryptCloudBackup(
  envelopeOrStr: CloudBackupEnvelope | string,
  password: string
): Promise<string> {
  if (!password) {
    throw new Error('Password is required to decrypt cloud backup');
  }

  let envelope: CloudBackupEnvelope;
  if (typeof envelopeOrStr === 'string') {
    try {
      envelope = JSON.parse(envelopeOrStr);
    } catch {
      throw new Error('Invalid backup format: not valid JSON');
    }
  } else {
    envelope = envelopeOrStr;
  }

  if (
    !envelope ||
    envelope.version !== 1 ||
    !envelope.salt ||
    !envelope.iv ||
    !envelope.ciphertext
  ) {
    throw new Error('Invalid cloud backup envelope format');
  }

  const saltBuf = base64UrlToArrayBuffer(envelope.salt);
  const ivBuf = base64UrlToArrayBuffer(envelope.iv);
  const ciphertextBuf = base64UrlToArrayBuffer(envelope.ciphertext);

  const key = await deriveKeyFromPassword(
    password,
    new Uint8Array(saltBuf),
    envelope.iterations || 100000
  );

  let decryptedBuf: ArrayBuffer;
  try {
    decryptedBuf = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(ivBuf),
        additionalData: new TextEncoder().encode('aircomic-cloud-backup-v1'),
      },
      key,
      ciphertextBuf
    );
  } catch {
    throw new Error('Decryption failed: incorrect password or corrupted data');
  }

  const plaintext = new TextDecoder().decode(decryptedBuf);

  // Secondary verification: SHA-256 checksum match
  if (envelope.checksum) {
    const checksumBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext));
    const computedChecksum = arrayBufferToBase64Url(checksumBuf);
    if (computedChecksum !== envelope.checksum) {
      throw new Error('Integrity check failed: corrupted backup data');
    }
  }

  // Verify structure is valid JSON containing profile information
  try {
    const parsed = JSON.parse(plaintext);
    const profile = parsed.profile || parsed;
    if (!profile || (!profile.signingPublicKeyBase64 && !parsed.signingPublicKeyBase64 && !parsed.participantId)) {
      throw new Error('Decrypted data is not a valid AirComic profile backup');
    }
  } catch (err: any) {
    throw new Error(err.message || 'Decrypted data is corrupted');
  }

  return plaintext;
}

/**
 * Deterministically derives a scoped secp256k1 keypair from the backup UUID.
 * This allows both the publisher and receiver to identify and query the event
 * on Nostr relays without exposing user identity keys.
 */
export async function deriveCloudNostrKey(uuid: string): Promise<{ secretKey: Uint8Array; pubkey: string }> {
  const clean = uuid.trim().toLowerCase();
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`aircomic-cloud-backup-secp:${clean}`)
  );
  const secretKey = new Uint8Array(hash);
  if (secretKey.every((b) => b === 0)) {
    secretKey[31] = 1;
  }
  const pubkey = toHex(schnorr.getPublicKey(secretKey));
  return { secretKey, pubkey };
}

/**
 * Posts the encrypted cloud backup to Nostr relays as a "silent" replaceable event.
 * Uses kind 30078, indexed with a 'd' tag matching the UUID and an expiration of 2 days.
 */
export async function publishCloudBackupToRelays(
  uuid: string,
  envelope: CloudBackupEnvelope,
  customRelayUrls?: string[]
): Promise<{ success: boolean; acceptedRelays: string[]; error?: string }> {
  try {
    const cleanUuid = uuid.trim();
    const { secretKey } = await deriveCloudNostrKey(cleanUuid);

    const expirationSec = 2 * 24 * 3600; // 48 hours
    const nowSec = Math.floor(Date.now() / 1000);
    const tags: string[][] = [
      ['d', cleanUuid],
      ['t', 'aircomic-cloud-backup'],
      ['expiration', String(nowSec + expirationSec)],
    ];

    const event = await buildNostrEvent({
      secretKey,
      kind: 30078,
      tags,
      content: JSON.stringify(envelope),
      createdAt: nowSec,
    });

    const res = await relayPool.publish(event, {
      quorum: 1,
      timeoutMs: 6000,
      relays: customRelayUrls,
    });

    if (res.accepted.length > 0 || res.quorumMet) {
      return { success: true, acceptedRelays: res.accepted };
    }

    const reasons = res.rejected.map((r) => `${r.url}: ${r.reason}`).join('; ');
    return {
      success: false,
      acceptedRelays: [],
      error: reasons || 'No relays acknowledged receipt of backup event',
    };
  } catch (err: any) {
    return {
      success: false,
      acceptedRelays: [],
      error: err?.message || 'Failed to publish to Nostr relays',
    };
  }
}

/**
 * Fetches an encrypted cloud backup from Nostr relays by UUID key.
 */
export async function fetchCloudBackupFromRelays(
  uuid: string,
  timeoutMs = 7000
): Promise<CloudBackupEnvelope> {
  const cleanUuid = uuid.trim();
  const { pubkey } = await deriveCloudNostrKey(cleanUuid);

  const filters: NostrFilter[] = [
    {
      kinds: [30078],
      authors: [pubkey],
      '#d': [cleanUuid],
    },
    {
      kinds: [30078],
      '#d': [cleanUuid],
    },
    {
      '#d': [cleanUuid],
    },
  ];

  const events = await relayPool.query(filters, { timeoutMs });

  const matching = events.filter((e) =>
    e.tags?.some((t) => t[0] === 'd' && t[1] === cleanUuid)
  );

  if (matching.length === 0) {
    throw new Error('Backup not found on Nostr relays or has expired');
  }

  // Pick newest event
  matching.sort((a, b) => b.created_at - a.created_at);
  const newest = matching[0];

  try {
    const envelope = JSON.parse(newest.content) as CloudBackupEnvelope;
    if (!envelope.ciphertext || !envelope.iv || !envelope.salt) {
      throw new Error('Invalid envelope structure in Nostr event');
    }
    return envelope;
  } catch (err: any) {
    throw new Error(`Failed to parse cloud backup: ${err?.message || 'Invalid format'}`);
  }
}

/**
 * Generates a full restore URL containing the UUID key.
 */
export function buildCloudRestoreUrl(uuid: string): string {
  if (typeof window === 'undefined') return `?restore=${encodeURIComponent(uuid)}`;
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?restore=${encodeURIComponent(uuid)}`;
}

/**
 * Extracts a restore UUID from the current window location (search query or hash).
 */
export function parseCloudRestoreKeyFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const searchParams = new URLSearchParams(window.location.search);
  const searchRestore = searchParams.get('restore') || searchParams.get('cloud-restore');
  if (searchRestore?.trim()) return searchRestore.trim();

  const hashMatch = window.location.hash.match(/(?:restore|cloud-restore)=([A-Za-z0-9_-]+)/);
  if (hashMatch?.[1]) return hashMatch[1].trim();

  return null;
}

/**
 * Strips the restore query/hash parameter from the browser URL without reloading.
 */
export function clearCloudRestoreKeyFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('restore');
    url.searchParams.delete('cloud-restore');
    if (url.hash.includes('restore')) {
      url.hash = '';
    }
    window.history.replaceState({}, document.title, url.toString());
  } catch {
    /* ignore in environments without valid URL origin */
  }
}
