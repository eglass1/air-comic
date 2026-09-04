import type {
  RekeyPacket,
  JoinRequestPacket,
  IdentityHelloPacket,
  StateSummaryPacket,
  ContactInfo,
  PublicRoomDescriptorPacket,
  PublicRoomTombstonePacket,
  PublicRoomMetadataPacket,
  PlaintextMessagePayload,
  RoomMode,
  JoinDecisionPacket,
  PresencePacket,
  PresenceStatus,
  RoomInvitePayload,
  RoomInviteResponsePayload,
  SealedEnvelope,
} from '../types';

// ============================================================================
// BASE64 & BASE64URL CONVERSIONS
// ============================================================================

export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = base64.replace(/[\r\n\s]/g, '');
  const binaryString = globalThis.atob(clean);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export function arrayBufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  return arrayBufferToBase64(buffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlToArrayBuffer(base64Url: string): ArrayBuffer {
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return base64ToArrayBuffer(base64);
}

export function stringToBase64Url(str: string): string {
  const encoded = new TextEncoder().encode(str);
  return arrayBufferToBase64Url(encoded);
}

export function base64UrlToString(base64Url: string): string {
  const buf = base64UrlToArrayBuffer(base64Url);
  return new TextDecoder().decode(buf);
}

export function chunkString(str: string, length: number): string {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += length) {
    chunks.push(str.substring(i, i + length));
  }
  return chunks.join('\n');
}

export function spkiToPem(base64Spki: string, type: 'PUBLIC KEY' | 'SIGNING PUBLIC KEY' = 'PUBLIC KEY'): string {
  const clean = base64Spki.replace(/[\r\n\s]/g, '');
  return `-----BEGIN ${type}-----\n${chunkString(clean, 64)}\n-----END ${type}-----`;
}

export function pkcs8ToPem(base64Pkcs8: string, type: 'PRIVATE KEY' | 'SIGNING PRIVATE KEY' = 'PRIVATE KEY'): string {
  const clean = base64Pkcs8.replace(/[\r\n\s]/g, '');
  return `-----BEGIN ${type}-----\n${chunkString(clean, 64)}\n-----END ${type}-----`;
}

export function pemToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/[\r\n\s]/g, '');
}

export function normalizePublicKey(pubKey: string): string {
  if (pubKey.includes('-----BEGIN')) {
    return pemToBase64(pubKey);
  }
  return pubKey.replace(/[\r\n\s]/g, '');
}

// ============================================================================
// DETERMINISTIC CANONICAL JSON SERIALIZATION
// ============================================================================

export function canonicalStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

// ============================================================================
// PARTICIPANT IDENTITY DERIVATION
// ============================================================================

/**
 * participantId = base64url(SHA-256(normalized ECDSA signing public key))
 */
export async function getParticipantId(signingPublicKeyBase64: string): Promise<string> {
  const clean = normalizePublicKey(signingPublicKeyBase64);
  const buffer = base64ToArrayBuffer(clean);
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return arrayBufferToBase64Url(hash);
}

export async function getPublicKeyFingerprint(pubKeyBase64: string): Promise<string> {
  try {
    const buffer = base64ToArrayBuffer(normalizePublicKey(pubKeyBase64));
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hash));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
  } catch (err) {
    console.error('Error generating fingerprint:', err);
    return 'UNKNOWN';
  }
}

// ============================================================================
// KEYPAIR GENERATION & IMPORT/EXPORT
// ============================================================================

export interface GeneratedUserIdentity {
  participantId: string;

  // Encryption (RSA-OAEP 2048)
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBase64: string;
  publicKeyPem: string;
  privateKeyJwk: JsonWebKey;
  privateKeyPem: string;

  // Signing (ECDSA P-256)
  signingPublicKey: CryptoKey;
  signingPrivateKey: CryptoKey;
  signingPublicKeyBase64: string;
  signingPublicKeyPem: string;
  signingPrivateKeyJwk: JsonWebKey;
  signingPrivateKeyPem: string;
}

export async function generateUserKeyPair(): Promise<GeneratedUserIdentity> {
  // 1. RSA-OAEP Keypair for asymmetric encryption
  const encKeyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );

  const encSpkiBuffer = await crypto.subtle.exportKey('spki', encKeyPair.publicKey);
  const publicKeyBase64 = arrayBufferToBase64(encSpkiBuffer);
  const publicKeyPem = spkiToPem(publicKeyBase64, 'PUBLIC KEY');

  const encPkcs8Buffer = await crypto.subtle.exportKey('pkcs8', encKeyPair.privateKey);
  const privateKeyBase64 = arrayBufferToBase64(encPkcs8Buffer);
  const privateKeyPem = pkcs8ToPem(privateKeyBase64, 'PRIVATE KEY');
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', encKeyPair.privateKey);

  // 2. ECDSA Keypair for digital signatures
  const signKeyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify']
  );

  const signSpkiBuffer = await crypto.subtle.exportKey('spki', signKeyPair.publicKey);
  const signingPublicKeyBase64 = arrayBufferToBase64(signSpkiBuffer);
  const signingPublicKeyPem = spkiToPem(signingPublicKeyBase64, 'SIGNING PUBLIC KEY');

  const signPkcs8Buffer = await crypto.subtle.exportKey('pkcs8', signKeyPair.privateKey);
  const signingPrivateKeyBase64 = arrayBufferToBase64(signPkcs8Buffer);
  const signingPrivateKeyPem = pkcs8ToPem(signingPrivateKeyBase64, 'SIGNING PRIVATE KEY');
  const signingPrivateKeyJwk = await crypto.subtle.exportKey('jwk', signKeyPair.privateKey);

  const participantId = await getParticipantId(signingPublicKeyBase64);

  return {
    participantId,
    publicKey: encKeyPair.publicKey,
    privateKey: encKeyPair.privateKey,
    publicKeyBase64,
    publicKeyPem,
    privateKeyJwk,
    privateKeyPem,

    signingPublicKey: signKeyPair.publicKey,
    signingPrivateKey: signKeyPair.privateKey,
    signingPublicKeyBase64,
    signingPublicKeyPem,
    signingPrivateKeyJwk,
    signingPrivateKeyPem,
  };
}

export async function importPublicKey(base64OrPem: string): Promise<CryptoKey> {
  const base64 = normalizePublicKey(base64OrPem);
  const buffer = base64ToArrayBuffer(base64);
  return await crypto.subtle.importKey(
    'spki',
    buffer,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'wrapKey']
  );
}

export async function importPrivateKeyFromJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256',
    },
    true,
    ['decrypt', 'unwrapKey']
  );
}

export async function importSigningPublicKey(base64OrPem: string): Promise<CryptoKey> {
  const base64 = normalizePublicKey(base64OrPem);
  const buffer = base64ToArrayBuffer(base64);
  return await crypto.subtle.importKey(
    'spki',
    buffer,
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['verify']
  );
}

export async function importSigningPrivateKeyFromJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign']
  );
}

// ============================================================================
// DIGITAL SIGNATURES
// ============================================================================

export async function signData(signingPrivateKey: CryptoKey, data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const signatureBuffer = await crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    signingPrivateKey,
    encoded
  );
  return arrayBufferToBase64Url(signatureBuffer);
}

export async function verifySignature(
  signingPublicKey: CryptoKey | string,
  data: string,
  signatureBase64Url: string
): Promise<boolean> {
  try {
    const key = typeof signingPublicKey === 'string'
      ? await importSigningPublicKey(signingPublicKey)
      : signingPublicKey;

    const encoded = new TextEncoder().encode(data);
    const sigBuffer = base64UrlToArrayBuffer(signatureBase64Url);

    return await crypto.subtle.verify(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' },
      },
      key,
      sigBuffer,
      encoded
    );
  } catch (err) {
    console.error('Signature verification failed:', err);
    return false;
  }
}

// ============================================================================
// ROOT KEY & SIGNALING PASSWORD DERIVATION (HKDF-SHA-256)
// ============================================================================

export function generateRandomRoomSecret(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(16)); // 128 bits
  return arrayBufferToBase64Url(randomBytes);
}

/**
 * Derives Root Control Key (root-v2) via HKDF-SHA-256:
 * IKM: roomSecret
 * Salt: SHA-256("airthread:" + conversationId)
 * Info: UTF-8 "airthread-root-key-v2"
 * Output: 256-bit AES-GCM Key
 */
export async function deriveRootKeyV2(roomSecret: string, conversationId: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const ikm = encoder.encode(roomSecret.trim());
  const saltInput = encoder.encode(`airthread:${conversationId.trim().toLowerCase()}`);
  const salt = await crypto.subtle.digest('SHA-256', saltInput);
  const info = encoder.encode('airthread-root-key-v2');

  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    ikm,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt),
      info,
    },
    hkdfKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Derives Trystero Signaling Password via HKDF-SHA-256:
 * IKM: roomSecret
 * Salt: SHA-256("airthread-signaling:" + conversationId)
 * Info: UTF-8 "airthread-trystero-password-v2"
 * Output: Base64URL string (32 bytes)
 */
export async function deriveTrysteroPassword(roomSecret: string, conversationId: string): Promise<string> {
  const encoder = new TextEncoder();
  const ikm = encoder.encode(roomSecret.trim());
  const saltInput = encoder.encode(`airthread-signaling:${conversationId.trim().toLowerCase()}`);
  const salt = await crypto.subtle.digest('SHA-256', saltInput);
  const info = encoder.encode('airthread-trystero-password-v2');

  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    ikm,
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt),
      info,
    },
    hkdfKey,
    256
  );

  return arrayBufferToBase64Url(derivedBits);
}

// ============================================================================
// SYMMETRIC & ASYMMETRIC ENCRYPTION
// ============================================================================

export async function generateNewConversationKey(): Promise<{
  key: CryptoKey;
  rawBuffer: ArrayBuffer;
  rawBase64Url: string;
}> {
  const key = await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );

  const rawBuffer = await crypto.subtle.exportKey('raw', key);
  const rawBase64Url = arrayBufferToBase64Url(rawBuffer);

  return { key, rawBuffer, rawBase64Url };
}

export async function importRawAesKey(rawBufferOrBase64Url: ArrayBuffer | string): Promise<CryptoKey> {
  const buffer = typeof rawBufferOrBase64Url === 'string'
    ? base64UrlToArrayBuffer(rawBufferOrBase64Url)
    : rawBufferOrBase64Url;

  return await crypto.subtle.importKey(
    'raw',
    buffer,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function encryptSymmetric(
  key: CryptoKey,
  plaintext: string,
  additionalData?: string
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv,
  };
  if (additionalData) {
    params.additionalData = new TextEncoder().encode(additionalData);
  }

  const ciphertextBuffer = await crypto.subtle.encrypt(params, key, encoded);

  return {
    ciphertext: arrayBufferToBase64Url(ciphertextBuffer),
    iv: arrayBufferToBase64Url(iv),
  };
}

export async function decryptSymmetric(
  key: CryptoKey,
  ciphertextBase64Url: string,
  ivBase64Url: string,
  additionalData?: string
): Promise<string> {
  const ivBuffer = base64UrlToArrayBuffer(ivBase64Url);
  const ciphertextBuffer = base64UrlToArrayBuffer(ciphertextBase64Url);

  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: new Uint8Array(ivBuffer),
  };
  if (additionalData) {
    params.additionalData = new TextEncoder().encode(additionalData);
  }

  const decryptedBuffer = await crypto.subtle.decrypt(params, key, ciphertextBuffer);
  return new TextDecoder().decode(decryptedBuffer);
}

export async function createEncryptedEnvelope(
  key: CryptoKey,
  convId: string,
  packetId: string,
  keyId: string,
  senderId: string,
  payloadStr: string,
  timestamp: number = Date.now()
): Promise<{
  protocol: 'airthread/2';
  type: 'encrypted';
  convId: string;
  packetId: string;
  keyId: string;
  iv: string;
  data: string;
  senderId: string;
  timestamp: number;
}> {
  const aad = `airthread/2:${convId}:${packetId}:${keyId}:${senderId}:${timestamp}`;
  const { ciphertext, iv } = await encryptSymmetric(key, payloadStr, aad);
  return {
    protocol: 'airthread/2',
    type: 'encrypted',
    convId,
    packetId,
    keyId,
    iv,
    data: ciphertext,
    senderId,
    timestamp,
  };
}

export async function decryptEnvelope(
  key: CryptoKey,
  envelope: {
    convId: string;
    packetId: string;
    keyId: string;
    senderId: string;
    timestamp: number;
    data: string;
    iv: string;
  }
): Promise<string> {
  const aad = `airthread/2:${envelope.convId}:${envelope.packetId}:${envelope.keyId}:${envelope.senderId}:${envelope.timestamp}`;
  return await decryptSymmetric(key, envelope.data, envelope.iv, aad);
}

export async function encryptAsymmetric(
  publicKey: CryptoKey,
  rawKeyBuffer: ArrayBuffer
): Promise<string> {
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    rawKeyBuffer
  );
  return arrayBufferToBase64Url(encryptedBuffer);
}

export async function decryptAsymmetric(
  privateKey: CryptoKey,
  encryptedBase64Url: string
): Promise<ArrayBuffer> {
  const encryptedBuffer = base64UrlToArrayBuffer(encryptedBase64Url);
  return await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    encryptedBuffer
  );
}

// ============================================================================
// PROTOCOL V2 SIGNED PACKET BUILDERS & VERIFIERS
// ============================================================================

// 1. Hello Packet
export async function createSignedHello(
  convId: string,
  peerId: string,
  participantId: string,
  screenName: string,
  publicKeyBase64: string,
  signingPublicKeyBase64: string,
  signingPrivateKey: CryptoKey,
  contactInfo?: ContactInfo,
  avatarName?: string,
  roomMode?: RoomMode
): Promise<IdentityHelloPacket> {
  const nonce = arrayBufferToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const timestamp = Date.now();
  const normPub = normalizePublicKey(publicKeyBase64);
  const normSignPub = normalizePublicKey(signingPublicKeyBase64);

  const unsigned: Omit<IdentityHelloPacket, 'signature'> = {
    type: 'hello',
    protocol: 'airthread/2',
    convId,
    peerId,
    participantId,
    screenName,
    avatarName,
    publicKey: normPub,
    signingPublicKey: normSignPub,
    contactInfo,
    nonce,
    timestamp,
    ...(roomMode ? { roomMode } : {}),
  };

  const stringToSign = 'AIRTHREAD_HELLO_V2:' + canonicalStringify(unsigned);
  const signature = await signData(signingPrivateKey, stringToSign);

  return { ...unsigned, signature };
}

export async function verifyHelloSignature(packet: IdentityHelloPacket): Promise<boolean> {
  if (!packet.signature || !packet.signingPublicKey) return false;
  const derivedPid = await getParticipantId(packet.signingPublicKey);
  if (derivedPid !== packet.participantId) {
    console.error('Participant ID does not match signing public key hash in Hello');
    return false;
  }
  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_HELLO_V2:' + canonicalStringify(unsigned);
  return await verifySignature(packet.signingPublicKey, stringToSign, signature);
}

// 2. Join Request Packet
export async function createSignedJoinRequest(
  convId: string,
  participantId: string,
  screenName: string,
  publicKeyBase64: string,
  signingPublicKeyBase64: string,
  signingPrivateKey: CryptoKey,
  contactInfo?: ContactInfo
): Promise<JoinRequestPacket> {
  const requestId = crypto.randomUUID();
  const timestamp = Date.now();
  const normPub = normalizePublicKey(publicKeyBase64);
  const normSignPub = normalizePublicKey(signingPublicKeyBase64);

  const unsigned: Omit<JoinRequestPacket, 'signature'> = {
    type: 'join_request',
    protocol: 'airthread/2',
    requestId,
    convId,
    sender: {
      participantId,
      screenName,
      publicKey: normPub,
      signingPublicKey: normSignPub,
      contactInfo,
    },
    timestamp,
  };

  const stringToSign = 'AIRTHREAD_JOIN_REQUEST_V2:' + canonicalStringify(unsigned);
  const signature = await signData(signingPrivateKey, stringToSign);

  return { ...unsigned, signature };
}

export async function verifyJoinRequestSignature(packet: JoinRequestPacket): Promise<boolean> {
  if (!packet.signature || !packet.sender.signingPublicKey) return false;
  const derivedPid = await getParticipantId(packet.sender.signingPublicKey);
  if (derivedPid !== packet.sender.participantId) {
    console.error('Participant ID does not match signing public key hash in Join Request');
    return false;
  }
  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_JOIN_REQUEST_V2:' + canonicalStringify(unsigned);
  return await verifySignature(packet.sender.signingPublicKey, stringToSign, signature);
}

// 3. Rekey Packet
export async function createSignedRekeyPacket(
  rawNewKeyBuffer: ArrayBuffer,
  packetId: string,
  keyId: string,
  epoch: number,
  parentKeyId: string,
  members: string[], // participantIds
  participantsMap: Map<string, { publicKey: string }>, // participantId -> public key
  signerId: string,
  signerPublicKeyBase64: string,
  signerSigningPublicKeyBase64: string,
  signerSigningPrivateKey: CryptoKey,
  signerScreenName: string,
  convId: string,
  action?: 'claim' | 'add' | 'remove' | 'rekey',
  targetParticipantId?: string,
  targetScreenName?: string
): Promise<RekeyPacket> {
  const keysMap: Record<string, string> = {};

  for (const pid of members) {
    const pInfo = participantsMap.get(pid);
    if (pInfo) {
      try {
        const pubKey = await importPublicKey(pInfo.publicKey);
        const encryptedValue = await encryptAsymmetric(pubKey, rawNewKeyBuffer);
        keysMap[pid] = encryptedValue;
      } catch (err) {
        console.error('Failed to encrypt key for participant:', pid, err);
      }
    }
  }

  const unsigned: Omit<RekeyPacket, 'signature'> = {
    type: 'key',
    protocol: 'airthread/2',
    convId,
    packetId,
    keyId,
    epoch,
    parentKeyId,
    signerId,
    signerPublicKey: normalizePublicKey(signerPublicKeyBase64),
    signerSigningPublicKey: normalizePublicKey(signerSigningPublicKeyBase64),
    signerScreenName,
    timestamp: Date.now(),
    action,
    targetParticipantId,
    targetScreenName,
    members: Array.from(new Set(members)).sort(),
    keys: keysMap,
  };

  const stringToSign = 'AIRTHREAD_REKEY_V2:' + canonicalStringify(unsigned);
  const signature = await signData(signerSigningPrivateKey, stringToSign);

  return { ...unsigned, signature };
}

export async function verifyRekeyPacketSignature(packet: RekeyPacket): Promise<boolean> {
  if (!packet.signature || !packet.signerSigningPublicKey) return false;
  const derivedPid = await getParticipantId(packet.signerSigningPublicKey);
  if (derivedPid !== packet.signerId) {
    console.error('Signer ID does not match signing public key hash in Rekey');
    return false;
  }
  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_REKEY_V2:' + canonicalStringify(unsigned);
  return await verifySignature(packet.signerSigningPublicKey, stringToSign, signature);
}

export async function decryptRekeyPacket(
  packet: RekeyPacket,
  myParticipantId: string,
  myPrivateKey: CryptoKey
): Promise<{ key: CryptoKey; rawBase64Url: string; keyId: string; epoch: number } | null> {
  const encryptedForMe = packet.keys[myParticipantId];
  if (!encryptedForMe) {
    return null;
  }

  try {
    const rawKeyBuffer = await decryptAsymmetric(myPrivateKey, encryptedForMe);
    const key = await importRawAesKey(rawKeyBuffer);
    const rawBase64Url = arrayBufferToBase64Url(rawKeyBuffer);
    return {
      key,
      rawBase64Url,
      keyId: packet.keyId,
      epoch: packet.epoch,
    };
  } catch (err) {
    console.error('Failed to decrypt rekey packet with private key:', err);
    return null;
  }
}

// 4. State Summary Packet
export async function createSignedStateSummary(
  convId: string,
  participantId: string,
  activeEpoch: number,
  activeKeyId: string,
  membershipHeadPacketId: string,
  controlPacketIds: string[],
  newestMessageTimestamp: number,
  messageCount: number,
  signingPrivateKey: CryptoKey,
  recentMessageIds?: string[]
): Promise<StateSummaryPacket> {
  const unsigned: Omit<StateSummaryPacket, 'signature'> = {
    type: 'state_summary',
    protocol: 'airthread/2',
    convId,
    participantId,
    activeEpoch,
    activeKeyId,
    membershipHeadPacketId,
    controlPacketIds,
    newestMessageTimestamp,
    messageCount,
    ...(recentMessageIds ? { recentMessageIds } : {}),
    timestamp: Date.now(),
  };

  const stringToSign = 'AIRTHREAD_STATE_SUMMARY_V2:' + canonicalStringify(unsigned);
  const signature = await signData(signingPrivateKey, stringToSign);

  return { ...unsigned, signature };
}

export async function verifyStateSummarySignature(
  packet: StateSummaryPacket,
  signingPublicKey: string
): Promise<boolean> {
  if (!packet.signature) return false;
  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_STATE_SUMMARY_V2:' + canonicalStringify(unsigned);
  return await verifySignature(signingPublicKey, stringToSign, signature);
}

// ============================================================================
// PUBLIC ROOMS ADDENDUM (airthread/2-public-rooms)
// ============================================================================

/**
 * Derives stable publicRoomId:
 * Base64URL(SHA-256("airthread-public-room-v2:" + convId.toLowerCase() + ":" + publicJoinToken))
 */
export async function derivePublicRoomId(convId: string, publicJoinToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const input = encoder.encode(`airthread-public-room-v2:${convId.trim().toLowerCase()}:${publicJoinToken.trim()}`);
  const hash = await crypto.subtle.digest('SHA-256', input);
  return arrayBufferToBase64Url(hash);
}

/**
 * Derives Public Signaling Password via HKDF-SHA-256:
 * IKM: publicJoinToken
 * Salt: SHA-256("airthread-public-signaling:" + convId)
 * Info: UTF-8 "airthread-public-trystero-password-v2"
 * Output: Base64URL string (32 bytes)
 */
export async function derivePublicSignalingPassword(convId: string, publicJoinToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const ikm = encoder.encode(publicJoinToken.trim());
  const saltInput = encoder.encode(`airthread-public-signaling:${convId.trim().toLowerCase()}`);
  const salt = await crypto.subtle.digest('SHA-256', saltInput);
  const info = encoder.encode('airthread-public-trystero-password-v2');

  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    ikm,
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt),
      info,
    },
    hkdfKey,
    256
  );

  return arrayBufferToBase64Url(derivedBits);
}

/**
 * Derives Public Transport Key (public-v2) via HKDF-SHA-256:
 * IKM: publicJoinToken
 * Salt: SHA-256("airthread-public-content:" + convId)
 * Info: UTF-8 "airthread-public-transport-key-v2"
 * Output: 256-bit AES-GCM Key
 */
export async function derivePublicTransportKey(convId: string, publicJoinToken: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const ikm = encoder.encode(publicJoinToken.trim());
  const saltInput = encoder.encode(`airthread-public-content:${convId.trim().toLowerCase()}`);
  const salt = await crypto.subtle.digest('SHA-256', saltInput);
  const info = encoder.encode('airthread-public-transport-key-v2');

  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    ikm,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt),
      info,
    },
    hkdfKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

// 1. Public Room Descriptor
export async function createSignedPublicRoomDescriptor(
  convId: string,
  publicJoinToken: string,
  name: string,
  description: string,
  creatorId: string,
  creatorScreenName: string,
  creatorSigningPublicKeyBase64: string,
  creatorSigningPrivateKey: CryptoKey,
  options?: {
    relayUrls?: string[];
    language?: string;
    tags?: string[];
    historyPolicy?: 'peer_sync' | 'none';
    lifetimeMinutes?: number;
  }
): Promise<PublicRoomDescriptorPacket> {
  const publicRoomId = await derivePublicRoomId(convId, publicJoinToken);
  const now = Date.now();
  const lifetimeMs = (options?.lifetimeMinutes || 30) * 60 * 1000;
  const normSignPub = normalizePublicKey(creatorSigningPublicKeyBase64);

  const unsigned: Omit<PublicRoomDescriptorPacket, 'signature'> = {
    type: 'public_room_descriptor',
    protocol: 'airthread/2',
    extension: 'airthread/2-public-rooms',
    descriptorVersion: 1,
    publicRoomId,
    convId,
    publicJoinToken,
    name: name.trim().slice(0, 80),
    description: description.trim().slice(0, 500),
    creatorId,
    creatorScreenName,
    creatorSigningPublicKey: normSignPub,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + lifetimeMs,
    relayUrls: options?.relayUrls || [],
    language: options?.language || 'en',
    tags: options?.tags?.map(t => t.trim().slice(0, 32)).slice(0, 10) || [],
    historyPolicy: options?.historyPolicy || 'peer_sync',
    contentPolicy: 'public',
  };

  const stringToSign = 'AIRTHREAD_PUBLIC_ROOM_DESCRIPTOR_V2:' + canonicalStringify(unsigned);
  const signature = await signData(creatorSigningPrivateKey, stringToSign);

  return { ...unsigned, signature };
}

export async function verifyPublicRoomDescriptorSignature(packet: PublicRoomDescriptorPacket): Promise<boolean> {
  if (!packet.signature || !packet.creatorSigningPublicKey) return false;
  const derivedPid = await getParticipantId(packet.creatorSigningPublicKey);
  if (derivedPid !== packet.creatorId) {
    console.error('Creator ID does not match signing public key hash in descriptor');
    return false;
  }
  const derivedRoomId = await derivePublicRoomId(packet.convId, packet.publicJoinToken);
  if (derivedRoomId !== packet.publicRoomId) {
    console.error('Public Room ID does not match derivation in descriptor');
    return false;
  }
  if (packet.contentPolicy !== 'public') return false;

  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_PUBLIC_ROOM_DESCRIPTOR_V2:' + canonicalStringify(unsigned);
  return await verifySignature(packet.creatorSigningPublicKey, stringToSign, signature);
}

// 2. Public Room Tombstone
export async function createSignedPublicRoomTombstone(
  publicRoomId: string,
  convId: string,
  creatorId: string,
  creatorSigningPublicKeyBase64: string,
  creatorSigningPrivateKey: CryptoKey,
  reason: string = 'Room closed by creator'
): Promise<PublicRoomTombstonePacket> {
  const unsigned: Omit<PublicRoomTombstonePacket, 'signature'> = {
    type: 'public_room_tombstone',
    protocol: 'airthread/2',
    extension: 'airthread/2-public-rooms',
    publicRoomId,
    convId,
    creatorId,
    creatorSigningPublicKey: normalizePublicKey(creatorSigningPublicKeyBase64),
    closedAt: Date.now(),
    reason,
  };

  const stringToSign = 'AIRTHREAD_PUBLIC_ROOM_TOMBSTONE_V2:' + canonicalStringify(unsigned);
  const signature = await signData(creatorSigningPrivateKey, stringToSign);

  return { ...unsigned, signature };
}

export async function verifyPublicRoomTombstoneSignature(packet: PublicRoomTombstonePacket): Promise<boolean> {
  if (!packet.signature || !packet.creatorSigningPublicKey) return false;
  const derivedPid = await getParticipantId(packet.creatorSigningPublicKey);
  if (derivedPid !== packet.creatorId) return false;

  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_PUBLIC_ROOM_TOMBSTONE_V2:' + canonicalStringify(unsigned);
  return await verifySignature(packet.creatorSigningPublicKey, stringToSign, signature);
}

// 3. Public Room Metadata
export async function createSignedPublicRoomMetadata(
  publicRoomId: string,
  convId: string,
  name: string,
  description: string | undefined,
  setterId: string,
  setterSigningPublicKeyBase64: string,
  setterSigningPrivateKey: CryptoKey
): Promise<PublicRoomMetadataPacket> {
  const unsigned: Omit<PublicRoomMetadataPacket, 'signature'> = {
    type: 'public_room_metadata',
    protocol: 'airthread/2',
    extension: 'airthread/2-public-rooms',
    publicRoomId,
    convId,
    name: name.trim().slice(0, 80),
    description: description?.trim().slice(0, 500),
    setterId,
    setterSigningPublicKey: normalizePublicKey(setterSigningPublicKeyBase64),
    timestamp: Date.now(),
  };

  const stringToSign = 'AIRTHREAD_PUBLIC_ROOM_METADATA_V2:' + canonicalStringify(unsigned);
  const signature = await signData(setterSigningPrivateKey, stringToSign);

  return { ...unsigned, signature };
}

export async function verifyPublicRoomMetadataSignature(packet: PublicRoomMetadataPacket): Promise<boolean> {
  if (!packet.signature || !packet.setterSigningPublicKey) return false;
  const derivedPid = await getParticipantId(packet.setterSigningPublicKey);
  if (derivedPid !== packet.setterId) return false;

  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_PUBLIC_ROOM_METADATA_V2:' + canonicalStringify(unsigned);
  return await verifySignature(packet.setterSigningPublicKey, stringToSign, signature);
}

// 4. Signed Public Message Payload
export async function createSignedPublicMessagePayload(
  convId: string,
  publicRoomId: string,
  msgId: string,
  senderId: string,
  screenName: string,
  avatarName: string | undefined,
  signingPublicKeyBase64: string,
  signingPrivateKey: CryptoKey,
  text: string,
  emotion: number = 0,
  emotionIntensity: number = 0.5,
  balloonMode: 'say' | 'whisper' | 'think' | 'action' = 'say'
): Promise<PlaintextMessagePayload> {
  const timestamp = Date.now();
  const unsigned: Omit<PlaintextMessagePayload, 'signature'> = {
    type: 'message',
    protocol: 'airthread/2',
    extension: 'airthread/2-public-rooms',
    roomMode: 'public',
    msgId,
    convId,
    publicRoomId,
    senderId,
    sender: {
      screenName,
      avatarName,
      signingPublicKey: normalizePublicKey(signingPublicKeyBase64),
    },
    timestamp,
    text,
    keyId: 'public-v2',
    emotion,
    emotionIntensity,
    balloonMode,
  };

  const stringToSign = 'AIRTHREAD_PUBLIC_MESSAGE_V2:' + canonicalStringify(unsigned);
  const signature = await signData(signingPrivateKey, stringToSign);

  return { ...unsigned, signature };
}

export async function verifyPublicMessageSignature(payload: PlaintextMessagePayload): Promise<boolean> {
  if (!payload.signature || !payload.sender?.signingPublicKey) return false;
  const derivedPid = await getParticipantId(payload.sender.signingPublicKey);
  if (derivedPid !== payload.senderId) {
    console.error('Sender ID does not match signing public key hash in public message');
    return false;
  }
  const { signature, ...unsigned } = payload;
  const stringToSign = 'AIRTHREAD_PUBLIC_MESSAGE_V2:' + canonicalStringify(unsigned);
  return await verifySignature(payload.sender.signingPublicKey, stringToSign, signature);
}

// ============================================================================
// JOIN DECISION PACKETS (multi-member notification dismissal)
// ============================================================================

export async function createSignedJoinDecision(
  convId: string,
  requestId: string,
  targetParticipantId: string,
  decision: 'approved' | 'declined',
  deciderId: string,
  deciderScreenName: string,
  deciderSigningPublicKeyBase64: string,
  signingPrivateKey: CryptoKey
): Promise<JoinDecisionPacket> {
  const unsigned: Omit<JoinDecisionPacket, 'signature'> = {
    type: 'join_decision',
    protocol: 'airthread/2',
    convId,
    requestId,
    targetParticipantId,
    decision,
    deciderId,
    deciderScreenName,
    deciderSigningPublicKey: normalizePublicKey(deciderSigningPublicKeyBase64),
    timestamp: Date.now(),
  };

  const stringToSign = 'AIRTHREAD_JOIN_DECISION_V2:' + canonicalStringify(unsigned);
  const signature = await signData(signingPrivateKey, stringToSign);
  return { ...unsigned, signature };
}

export async function verifyJoinDecisionSignature(packet: JoinDecisionPacket): Promise<boolean> {
  if (!packet.signature || !packet.deciderSigningPublicKey) return false;
  const derivedPid = await getParticipantId(packet.deciderSigningPublicKey);
  if (derivedPid !== packet.deciderId) {
    console.error('Decider ID does not match signing public key hash in Join Decision');
    return false;
  }
  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_JOIN_DECISION_V2:' + canonicalStringify(unsigned);
  return await verifySignature(packet.deciderSigningPublicKey, stringToSign, signature);
}

// ============================================================================
// PRESENCE & DIRECT INVITE ADDRESSING (airthread/2-presence)
// ============================================================================

/**
 * Relay-side routing tag for a participant's presence announcements. Derived by
 * hashing the participantId so the raw identity is not published as a plain index.
 */
export async function derivePresenceTag(participantId: string): Promise<string> {
  const buf = new TextEncoder().encode('airthread-presence-v1:' + participantId);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return arrayBufferToBase64Url(hash);
}

/** Relay-side routing tag for a participant's direct-invite inbox. */
export async function deriveInboxTag(participantId: string): Promise<string> {
  const buf = new TextEncoder().encode('airthread-inbox-v1:' + participantId);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return arrayBufferToBase64Url(hash);
}

export async function createSignedPresence(
  participantId: string,
  screenName: string,
  publicKeyBase64: string,
  signingPublicKeyBase64: string,
  signingPrivateKey: CryptoKey,
  status: PresenceStatus,
  avatarName?: string,
  timestamp: number = Date.now()
): Promise<PresencePacket> {
  const unsigned: Omit<PresencePacket, 'signature'> = {
    type: 'presence',
    protocol: 'airthread/2',
    extension: 'airthread/2-presence',
    participantId,
    screenName,
    avatarName,
    publicKey: normalizePublicKey(publicKeyBase64),
    signingPublicKey: normalizePublicKey(signingPublicKeyBase64),
    status,
    timestamp,
  };

  const stringToSign = 'AIRTHREAD_PRESENCE_V2:' + canonicalStringify(unsigned);
  const signature = await signData(signingPrivateKey, stringToSign);
  return { ...unsigned, signature };
}

export async function verifyPresenceSignature(packet: PresencePacket): Promise<boolean> {
  if (!packet.signature || !packet.signingPublicKey) return false;
  const derivedPid = await getParticipantId(packet.signingPublicKey);
  if (derivedPid !== packet.participantId) return false;
  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_PRESENCE_V2:' + canonicalStringify(unsigned);
  return await verifySignature(packet.signingPublicKey, stringToSign, signature);
}

export async function createSignedRoomInvite(
  inviteId: string,
  convId: string,
  roomMode: RoomMode,
  channelTitle: string,
  recipientParticipantId: string,
  inviter: {
    participantId: string;
    screenName: string;
    avatarName?: string;
    publicKey: string;
    signingPublicKey: string;
    contactInfo?: ContactInfo;
  },
  signingPrivateKey: CryptoKey,
  options?: { roomSecret?: string; publicJoinToken?: string }
): Promise<RoomInvitePayload> {
  const unsigned: Omit<RoomInvitePayload, 'signature'> = {
    type: 'room_invite',
    protocol: 'airthread/2',
    extension: 'airthread/2-presence',
    inviteId,
    convId,
    roomMode,
    roomSecret: options?.roomSecret,
    publicJoinToken: options?.publicJoinToken,
    channelTitle,
    recipientParticipantId,
    inviter: {
      ...inviter,
      publicKey: normalizePublicKey(inviter.publicKey),
      signingPublicKey: normalizePublicKey(inviter.signingPublicKey),
    },
    timestamp: Date.now(),
  };

  const stringToSign = 'AIRTHREAD_ROOM_INVITE_V2:' + canonicalStringify(unsigned);
  const signature = await signData(signingPrivateKey, stringToSign);
  return { ...unsigned, signature };
}

export async function verifyRoomInviteSignature(packet: RoomInvitePayload): Promise<boolean> {
  if (!packet.signature || !packet.inviter?.signingPublicKey) return false;
  const derivedPid = await getParticipantId(packet.inviter.signingPublicKey);
  if (derivedPid !== packet.inviter.participantId) return false;
  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_ROOM_INVITE_V2:' + canonicalStringify(unsigned);
  return await verifySignature(packet.inviter.signingPublicKey, stringToSign, signature);
}

export async function createSignedInviteResponse(
  inviteId: string,
  convId: string,
  decision: 'accepted' | 'declined',
  responderParticipantId: string,
  responderScreenName: string,
  responderSigningPublicKeyBase64: string,
  signingPrivateKey: CryptoKey
): Promise<RoomInviteResponsePayload> {
  const unsigned: Omit<RoomInviteResponsePayload, 'signature'> = {
    type: 'room_invite_response',
    protocol: 'airthread/2',
    extension: 'airthread/2-presence',
    inviteId,
    convId,
    decision,
    responderParticipantId,
    responderScreenName,
    responderSigningPublicKey: normalizePublicKey(responderSigningPublicKeyBase64),
    timestamp: Date.now(),
  };

  const stringToSign = 'AIRTHREAD_INVITE_RESPONSE_V2:' + canonicalStringify(unsigned);
  const signature = await signData(signingPrivateKey, stringToSign);
  return { ...unsigned, signature };
}

export async function verifyInviteResponseSignature(packet: RoomInviteResponsePayload): Promise<boolean> {
  if (!packet.signature || !packet.responderSigningPublicKey) return false;
  const derivedPid = await getParticipantId(packet.responderSigningPublicKey);
  if (derivedPid !== packet.responderParticipantId) return false;
  const { signature, ...unsigned } = packet;
  const stringToSign = 'AIRTHREAD_INVITE_RESPONSE_V2:' + canonicalStringify(unsigned);
  return await verifySignature(packet.responderSigningPublicKey, stringToSign, signature);
}

/**
 * Seals an arbitrary payload for one recipient: a fresh AES-256-GCM key encrypts
 * the body, and RSA-OAEP encrypts that key to the recipient's public key.
 */
export async function sealForParticipant(
  recipientParticipantId: string,
  recipientPublicKeyBase64: string,
  senderParticipantId: string,
  payloadStr: string
): Promise<SealedEnvelope> {
  const recipientKey = await importPublicKey(recipientPublicKeyBase64);
  const { key, rawBuffer } = await generateNewConversationKey();
  const timestamp = Date.now();
  const aad = `airthread/2-presence:${recipientParticipantId}:${senderParticipantId}:${timestamp}`;
  const { ciphertext, iv } = await encryptSymmetric(key, payloadStr, aad);

  return {
    type: 'sealed',
    protocol: 'airthread/2',
    extension: 'airthread/2-presence',
    recipientParticipantId,
    senderParticipantId,
    encryptedKey: await encryptAsymmetric(recipientKey, rawBuffer),
    iv,
    data: ciphertext,
    timestamp,
  };
}

export async function openSealedEnvelope(
  envelope: SealedEnvelope,
  recipientPrivateKey: CryptoKey
): Promise<string> {
  const rawKey = await decryptAsymmetric(recipientPrivateKey, envelope.encryptedKey);
  const key = await importRawAesKey(rawKey);
  const aad = `airthread/2-presence:${envelope.recipientParticipantId}:${envelope.senderParticipantId}:${envelope.timestamp}`;
  return await decryptSymmetric(key, envelope.data, envelope.iv, aad);
}

/**
 * Derives a stable secp256k1 secret key from the user's ECDSA signing key so that
 * presence announcements land on the same Nostr pubkey across sessions and can be
 * published as replaceable events instead of accumulating duplicates.
 */
export async function deriveNostrSecretKey(signingPrivateKeyJwk: JsonWebKey): Promise<Uint8Array> {
  const seedMaterial = new TextEncoder().encode(
    'airthread-nostr-identity-v1:' + (signingPrivateKeyJwk.d || '') + ':' + (signingPrivateKeyJwk.x || '')
  );

  let digest = new Uint8Array(await crypto.subtle.digest('SHA-256', seedMaterial));
  // secp256k1 group order; reject-and-rehash keeps the scalar in range.
  const order = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  for (let i = 0; i < 32; i++) {
    const asInt = BigInt('0x' + Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join(''));
    if (asInt > 0n && asInt < order) return digest;
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digest));
  }
  throw new Error('Failed to derive a valid Nostr secret key');
}
