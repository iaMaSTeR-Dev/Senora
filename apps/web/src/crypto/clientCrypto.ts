// Client-Side Cryptographic Engine for Senora E2EE
// Uses Web Crypto API (SubtleCrypto) with NIST P-256 (ECDH) & AES-256-GCM
import { getLegacyNamespacePrefix } from '../protocol/storageMigration';

export interface ClientKeyPair {
  publicKeyBase64: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

const getCrypto = (): Crypto => {
  if (typeof window !== 'undefined' && window.crypto) return window.crypto;
  return globalThis.crypto;
};

// Convert ArrayBuffer to base64
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return typeof window !== 'undefined' ? window.btoa(binary) : globalThis.btoa(binary);
}

// Convert base64 to Uint8Array
export function base64ToBuffer(base64: string): Uint8Array {
  const binary = typeof window !== 'undefined' ? window.atob(base64) : globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const DB_NAME = 'senora_crypto_store';
const DB_VERSION = 1;
const STORE_NAME = 'device_keys';
const KEY_NAME = 'identity_keypair';

async function openKeyDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return null;
  }
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function loadPersistedKeyPair(userId?: string, deviceId?: string): Promise<ClientKeyPair | null> {
  const db = await openKeyDatabase();
  if (!db) return null;
  const keyId = (userId && deviceId) ? `${userId}:${deviceId}` : (userId ? `user:${userId}` : KEY_NAME);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(keyId);
      req.onsuccess = () => {
        if (req.result && req.result.publicKey && req.result.privateKey && req.result.publicKeyBase64) {
          resolve({
            publicKey: req.result.publicKey,
            privateKey: req.result.privateKey,
            publicKeyBase64: req.result.publicKeyBase64,
          });
        } else if (keyId !== KEY_NAME) {
          // Fallback to legacy un-scoped key name if user-scoped key not yet stored
          const legacyReq = store.get(KEY_NAME);
          legacyReq.onsuccess = () => {
            if (legacyReq.result && legacyReq.result.publicKey && legacyReq.result.privateKey && legacyReq.result.publicKeyBase64) {
              resolve({
                publicKey: legacyReq.result.publicKey,
                privateKey: legacyReq.result.privateKey,
                publicKeyBase64: legacyReq.result.publicKeyBase64,
              });
            } else {
              resolve(null);
            }
          };
          legacyReq.onerror = () => resolve(null);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function savePersistedKeyPair(keyPair: ClientKeyPair, userId?: string, deviceId?: string): Promise<void> {
  const db = await openKeyDatabase();
  if (!db) return;
  const keyId = (userId && deviceId) ? `${userId}:${deviceId}` : (userId ? `user:${userId}` : KEY_NAME);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({
        id: keyId,
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        publicKeyBase64: keyPair.publicKeyBase64,
        createdAt: Date.now(),
      });
      // Also maintain legacy KEY_NAME for backward compatibility
      if (keyId !== KEY_NAME) {
        store.put({
          id: KEY_NAME,
          publicKey: keyPair.publicKey,
          privateKey: keyPair.privateKey,
          publicKeyBase64: keyPair.publicKeyBase64,
          createdAt: Date.now(),
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Compute deterministic, human-verifiable safety number (fingerprint)
// for two participants' public keys. Symmetrical for both users.
export async function computeSafetyNumber(keyA: string, keyB: string): Promise<string> {
  const sorted = [keyA, keyB].sort().join(':');
  const hashBuffer = await getCrypto().subtle.digest('SHA-256', new TextEncoder().encode(sorted));
  const bytes = new Uint8Array(hashBuffer);
  const chunks: string[] = [];
  for (let i = 0; i < 6; i++) {
    const val = ((bytes[i * 2] << 8) | bytes[i * 2 + 1]) % 100000;
    chunks.push(val.toString().padStart(5, '0'));
  }
  return chunks.join(' ');
}

// Canonical AAD construction: binds protocol version and conversation ID with unambiguous domain separation.
export function buildCanonicalAAD(conversationId: string, version: number = 1): Uint8Array {
  return new TextEncoder().encode(`senora:v${version}:conv:${conversationId}`);
}

export class ClientCryptoEngine {
  private keyPair: ClientKeyPair | null = null;
  private sharedKeysCache = new Map<string, CryptoKey>();

  // Reset in-memory cache (useful for testing)
  resetCache(): void {
    this.keyPair = null;
    this.sharedKeysCache.clear();
  }

  // Generate or retrieve current device identity key pair (with user/device-scoped IndexedDB persistence)
  async getOrCreateDeviceKeyPair(userId?: string, deviceId?: string): Promise<ClientKeyPair> {
    if (this.keyPair) {
      return this.keyPair;
    }

    // Attempt retrieval from IndexedDB
    const persisted = await loadPersistedKeyPair(userId, deviceId);
    if (persisted) {
      this.keyPair = persisted;
      return this.keyPair;
    }

    const crypto = getCrypto();
    // Generate fresh P-256 ECDH key pair
    const pair = await crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true, // extractable public key
      ['deriveKey', 'deriveBits']
    );

    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const publicKeyBase64 = bufferToBase64(spki);

    this.keyPair = {
      publicKeyBase64,
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
    };

    // Save to IndexedDB asynchronously
    await savePersistedKeyPair(this.keyPair, userId, deviceId);

    return this.keyPair;
  }

  // Import a peer's public key from SPKI base64
  async importPeerPublicKey(base64Spki: string): Promise<CryptoKey> {
    if (!base64Spki || typeof base64Spki !== 'string' || base64Spki.trim().length === 0) {
      throw new Error('INVALID_PEER_PUBLIC_KEY: Peer public key is empty or undefined');
    }
    const raw = base64ToBuffer(base64Spki.trim());
    return getCrypto().subtle.importKey(
      'spki',
      raw.buffer as ArrayBuffer,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      []
    );
  }

  // Derive AES-256-GCM symmetric key from our private key and peer's public key
  async deriveSharedSymmetricKey(peerPublicKeyBase64: string): Promise<CryptoKey> {
    if (this.sharedKeysCache.has(peerPublicKeyBase64)) {
      return this.sharedKeysCache.get(peerPublicKeyBase64)!;
    }

    const myKeyPair = await this.getOrCreateDeviceKeyPair();
    const peerPubKey = await this.importPeerPublicKey(peerPublicKeyBase64);

    const derivedKey = await getCrypto().subtle.deriveKey(
      {
        name: 'ECDH',
        public: peerPubKey,
      },
      myKeyPair.privateKey,
      {
        name: 'AES-GCM',
        length: 256,
      },
      false,
      ['encrypt', 'decrypt']
    );

    this.sharedKeysCache.set(peerPublicKeyBase64, derivedKey);
    return derivedKey;
  }

  // Encrypt plaintext with peer's public key and optional Authenticated Associated Data (AAD)
  async encrypt(
    plaintext: string, 
    peerPublicKeyBase64: string, 
    associatedData?: string | Uint8Array
  ): Promise<{ ciphertext: string; nonce: string }> {
    const key = await this.deriveSharedSymmetricKey(peerPublicKeyBase64);
    
    // Generate fresh 96-bit (12-byte) initialization vector
    const iv = getCrypto().getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const encryptParams: AesGcmParams = {
      name: 'AES-GCM',
      iv,
    };

    if (associatedData) {
      if (typeof associatedData === 'string') {
        encryptParams.additionalData = buildCanonicalAAD(associatedData) as unknown as BufferSource;
      } else {
        encryptParams.additionalData = associatedData as unknown as BufferSource;
      }
    }

    const ciphertextBuffer = await getCrypto().subtle.encrypt(
      encryptParams,
      key,
      encoded
    );

    return {
      ciphertext: bufferToBase64(ciphertextBuffer),
      nonce: bufferToBase64(iv.buffer),
    };
  }

  // Decrypt ciphertext with peer's public key and optional Authenticated Associated Data (AAD)
  async decrypt(
    ciphertextBase64: string, 
    nonceBase64: string, 
    peerPublicKeyBase64: string, 
    associatedData?: string | Uint8Array
  ): Promise<string> {
    const key = await this.deriveSharedSymmetricKey(peerPublicKeyBase64);
    const ciphertext = base64ToBuffer(ciphertextBase64);
    const iv = base64ToBuffer(nonceBase64);

    const decryptWithAAD = async (aadBytes?: BufferSource): Promise<string> => {
      const decryptParams: AesGcmParams = {
        name: 'AES-GCM',
        iv: iv.buffer as ArrayBuffer,
      };
      if (aadBytes) {
        decryptParams.additionalData = aadBytes;
      }
      const decryptedBuffer = await getCrypto().subtle.decrypt(
        decryptParams,
        key,
        ciphertext.buffer as ArrayBuffer
      );
      return new TextDecoder().decode(decryptedBuffer);
    };

    if (!associatedData) {
      return decryptWithAAD();
    }

    if (typeof associatedData === 'string') {
      // 1. Try canonical domain-separated AAD first (modern protocol)
      try {
        return await decryptWithAAD(buildCanonicalAAD(associatedData) as unknown as BufferSource);
      } catch (err1) {
        // 2. Fall back to legacy namespace AAD for existing stored messages
        try {
          const legacyAAD = new TextEncoder().encode(`${getLegacyNamespacePrefix()}:v1:conv:${associatedData}`);
          return await decryptWithAAD(legacyAAD as unknown as BufferSource);
        } catch {}
        // 3. Fall back to raw string AAD for early phase messages
        try {
          return await decryptWithAAD(new TextEncoder().encode(associatedData));
        } catch (err2) {
          // 3. Fall back to unauthenticated associated data for legacy pre-AAD stored messages
          try {
            return await decryptWithAAD(undefined);
          } catch {
            // Rethrow the primary canonical failure if all AAD permutations fail
            throw err1;
          }
        }
      }
    }

    return decryptWithAAD(associatedData as unknown as BufferSource);
  }

  // Encrypt a message for multiple recipient devices and sender's other devices
  async encryptMultiDevice(
    plaintext: string,
    targetDevices: MultiDeviceTarget[],
    myDeviceId: string,
    conversationId?: string
  ): Promise<{ ciphertext: string; nonce: string; envelope: MultiDeviceEnvelope }> {
    if (!targetDevices || targetDevices.length === 0) {
      throw new Error('Cannot encrypt: no target devices provided');
    }

    const myKeyPair = await this.getOrCreateDeviceKeyPair();
    const devicesRecord: Record<string, DeviceCiphertext> = {};

    for (const target of targetDevices) {
      if (!target.publicKeyBase64) {
        throw new Error(`Cannot encrypt: target device ${target.deviceId} missing public key`);
      }
      const enc = await this.encrypt(plaintext, target.publicKeyBase64, conversationId);
      devicesRecord[target.deviceId] = {
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
      };
    }

    const envelope: MultiDeviceEnvelope = {
      v: 1,
      sender_device_id: myDeviceId,
      sender_public_key: myKeyPair.publicKeyBase64,
      devices: devicesRecord,
    };

    return {
      ciphertext: JSON.stringify(envelope),
      nonce: 'multidevice',
      envelope,
    };
  }

  // Decrypt a message that may be either a multi-device JSON envelope or legacy ciphertext
  async decryptMultiDevice(
    rawCiphertext: string,
    rawNonce: string,
    peerPublicKeyBase64: string,
    myDeviceId?: string,
    conversationId?: string
  ): Promise<string> {
    // 1. Check if rawCiphertext is a multi-device JSON envelope
    if (typeof rawCiphertext === 'string' && rawCiphertext.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(rawCiphertext);
        if (parsed && (parsed.v === 1 || parsed.v === 2) && parsed.devices && typeof parsed.devices === 'object') {
          // Determine device entry to decrypt
          let targetCiphertext: string | undefined;
          let targetNonce: string | undefined;

          if (myDeviceId && parsed.devices[myDeviceId]) {
            const dev = parsed.devices[myDeviceId];
            targetCiphertext = dev.ciphertext || dev.body;
            targetNonce = dev.nonce;
          } else {
            // If myDeviceId not matched, check if there is a single device entry
            const deviceIds = Object.keys(parsed.devices);
            if (deviceIds.length === 1) {
              const dev = parsed.devices[deviceIds[0]];
              targetCiphertext = dev.ciphertext || dev.body;
              targetNonce = dev.nonce;
            }
          }

          if (!targetCiphertext) {
            throw new Error(`Multi-device envelope has no ciphertext for device ${myDeviceId || 'unknown'}`);
          }

          const nonceToUse = targetNonce || (rawNonce !== 'multidevice' && rawNonce !== 'signal-v2' ? rawNonce : '');
          // Use sender's public key from envelope if present, else fallback to peerPublicKeyBase64
          const senderKey = parsed.sender_public_key || peerPublicKeyBase64;
          return await this.decrypt(targetCiphertext, nonceToUse, senderKey, conversationId);
        }
      } catch (err: any) {
        if (err.message && err.message.includes('Multi-device envelope has no ciphertext')) {
          throw err;
        }
        // If JSON parse fails or envelope structure invalid, fall through to legacy decrypt
      }
    }

    // 2. Fall back to standard legacy single-device decryption
    return await this.decrypt(rawCiphertext, rawNonce, peerPublicKeyBase64, conversationId);
  }
}

export interface MultiDeviceTarget {
  deviceId: string;
  publicKeyBase64: string;
}

export interface DeviceCiphertext {
  ciphertext: string;
  nonce: string;
}

export interface MultiDeviceEnvelope {
  v: number;
  sender_device_id: string;
  sender_public_key?: string;
  devices: Record<string, DeviceCiphertext>;
}

export interface DeviceConsistencyCheckResult {
  isConsistent: boolean;
  hasSubstitutions: boolean;
  newDevices: string[];
  removedDevices: string[];
  substitutedDevices: { deviceId: string; previousKey: string; currentKey: string }[];
}

export function verifyDeviceKeyList(
  knownDevices: Record<string, string>, // deviceId -> publicKeyBase64
  currentDevices: Array<{ device_id: string; identity_public_key: string }>
): DeviceConsistencyCheckResult {
  const currentMap = new Map(currentDevices.map((d) => [d.device_id, d.identity_public_key]));
  const newDevices: string[] = [];
  const removedDevices: string[] = [];
  const substitutedDevices: { deviceId: string; previousKey: string; currentKey: string }[] = [];

  for (const [id, currentKey] of currentMap.entries()) {
    if (!knownDevices[id]) {
      newDevices.push(id);
    } else if (knownDevices[id] !== currentKey) {
      substitutedDevices.push({
        deviceId: id,
        previousKey: knownDevices[id],
        currentKey,
      });
    }
  }

  for (const knownId of Object.keys(knownDevices)) {
    if (!currentMap.has(knownId)) {
      removedDevices.push(knownId);
    }
  }

  return {
    isConsistent: substitutedDevices.length === 0,
    hasSubstitutions: substitutedDevices.length > 0,
    newDevices,
    removedDevices,
    substitutedDevices,
  };
}

export const cryptoEngine = new ClientCryptoEngine();

