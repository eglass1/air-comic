/**
 * Cryptographic primitives.
 *
 * Protocol packet builders, verifiers and key derivations live in
 * src/services/v3/. This module holds only the primitives they are built from:
 * encodings, canonical JSON, identity keypairs, signatures, and the symmetric
 * and asymmetric operations.
 */

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

