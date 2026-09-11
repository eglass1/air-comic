/**
 * @vitest-environment jsdom
 *
 * Tests for Cloud Backup & Restore:
 * - PBKDF2 + AES-GCM symmetric encryption with MAC & SHA-256 checksum
 * - Wrong password rejection
 * - Ciphertext corruption rejection
 * - Nostr key derivation and publish/fetch roundtrip via FakeRelay
 * - URL generation and parsing
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { installFakeWebSocket, registerRelay, closeAllSockets } from '../../test/fakeRelay';
import { relayPool } from '../nostr/relayPool';
import {
  encryptCloudBackup,
  decryptCloudBackup,
  deriveCloudNostrKey,
  publishCloudBackupToRelays,
  fetchCloudBackupFromRelays,
  buildCloudRestoreUrl,
  parseCloudRestoreKeyFromUrl,
  clearCloudRestoreKeyFromUrl,
} from '../cloudBackup';

installFakeWebSocket();

const TEST_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

beforeAll(() => {
  TEST_RELAYS.forEach(registerRelay);
  relayPool.configure(TEST_RELAYS);
});

afterAll(() => {
  closeAllSockets();
});

describe('cloudBackup service', () => {
  const sampleProfileJson = JSON.stringify({
    version: 3,
    exportedAt: 1700000000000,
    participantId: 'test-participant-id',
    screenName: 'TestHero',
    info: 'Comic creator',
    profile: {
      signingPublicKeyBase64: 'fake-spki-signing-key',
      screenName: 'TestHero',
    },
    friends: [],
    favoriteRooms: [],
    currentRooms: [],
  });

  it('encrypts and decrypts with the correct password', async () => {
    const password = 'CorrectHorseBatteryStaple123!';
    const envelope = await encryptCloudBackup(sampleProfileJson, password);

    expect(envelope.version).toBe(1);
    expect(envelope.alg).toBe('AES-GCM-256');
    expect(envelope.kdf).toBe('PBKDF2');
    expect(envelope.salt).toBeTruthy();
    expect(envelope.iv).toBeTruthy();
    expect(envelope.ciphertext).toBeTruthy();
    expect(envelope.checksum).toBeTruthy();

    // Decrypt
    const decrypted = await decryptCloudBackup(envelope, password);
    expect(decrypted).toBe(sampleProfileJson);
  });

  it('rejects decryption when given an incorrect password', async () => {
    const password = 'CorrectPassword123';
    const wrongPassword = 'WrongPassword456';
    const envelope = await encryptCloudBackup(sampleProfileJson, password);

    await expect(decryptCloudBackup(envelope, wrongPassword)).rejects.toThrow(
      /Decryption failed|incorrect password/i
    );
  });

  it('rejects decryption when ciphertext is tampered/corrupted', async () => {
    const password = 'StrongPassword';
    const envelope = await encryptCloudBackup(sampleProfileJson, password);

    // Tamper with one character of the base64url ciphertext
    const corruptedCiphertext =
      envelope.ciphertext.slice(0, -4) +
      (envelope.ciphertext.slice(-4, -3) === 'A' ? 'B' : 'A') +
      envelope.ciphertext.slice(-3);

    const corruptedEnvelope = { ...envelope, ciphertext: corruptedCiphertext };

    await expect(decryptCloudBackup(corruptedEnvelope, password)).rejects.toThrow(
      /Decryption failed|corrupted/i
    );
  });

  it('rejects decryption when checksum does not match', async () => {
    const password = 'StrongPassword';
    const envelope = await encryptCloudBackup(sampleProfileJson, password);

    // Provide a modified checksum
    const badEnvelope = { ...envelope, checksum: 'corrupted-checksum' };

    await expect(decryptCloudBackup(badEnvelope, password)).rejects.toThrow(
      /Integrity check failed|corrupted/i
    );
  });

  it('deterministically derives secp256k1 key from uuid', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const key1 = await deriveCloudNostrKey(uuid);
    const key2 = await deriveCloudNostrKey(uuid);

    expect(key1.pubkey).toBe(key2.pubkey);
    expect(key1.secretKey).toEqual(key2.secretKey);

    const otherKey = await deriveCloudNostrKey('12345678-1234-1234-1234-123456789abc');
    expect(otherKey.pubkey).not.toBe(key1.pubkey);
  });

  it('publishes to Nostr relays and retrieves back by UUID', async () => {
    const uuid = 'cloud-test-' + Math.random().toString(36).slice(2, 10);
    const password = 'NostrPassword99';
    const envelope = await encryptCloudBackup(sampleProfileJson, password);

    const pubResult = await publishCloudBackupToRelays(uuid, envelope, TEST_RELAYS);
    expect(pubResult.success).toBe(true);

    const fetchedEnvelope = await fetchCloudBackupFromRelays(uuid, 3000);
    expect(fetchedEnvelope.ciphertext).toBe(envelope.ciphertext);
    expect(fetchedEnvelope.checksum).toBe(envelope.checksum);

    const decrypted = await decryptCloudBackup(fetchedEnvelope, password);
    expect(decrypted).toBe(sampleProfileJson);
  });

  it('builds, parses and clears the restore URL properly', () => {
    const uuid = 'abc-123-uuid-xyz';
    const url = buildCloudRestoreUrl(uuid);
    expect(url).toContain(`restore=${uuid}`);

    // Test parse from search params
    window.history.replaceState(null, '', `/?restore=${uuid}`);
    expect(parseCloudRestoreKeyFromUrl()).toBe(uuid);

    // Test clear URL
    clearCloudRestoreKeyFromUrl();
    expect(parseCloudRestoreKeyFromUrl()).toBeNull();
    expect(window.location.search).not.toContain('restore=');
  });
});
