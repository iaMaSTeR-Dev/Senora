import {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  SignedPreKeyPairType,
} from '@privacyresearch/libsignal-protocol-typescript';
import { SignalIndexedDBStore } from './signalStore';
import { cryptoEngine, bufferToBase64, base64ToBuffer, computeSafetyNumber } from './clientCrypto';
import { api } from '../protocol/api';
import { serverManager } from '../protocol/serverManager';
import { archiveEncrypt, archiveDecrypt } from './localArchive';

export interface DeviceKeyBundleResponse {
  device_id: string;
  identity_public_key: string;
  registration_id?: number;
  signed_pre_key?: string;
  one_time_pre_key?: string;
}

export interface UserKeysResponse {
  user_id: string;
  devices: DeviceKeyBundleResponse[];
}

export interface SignalDeviceCiphertext {
  type: number;
  body: string;
  registrationId?: number;
  nonce?: string;
  archiveId?: string;
}

export interface SignalMultiDeviceEnvelope {
  v: 2;
  type: 'signal_multidevice';
  sender_user_id: string;
  sender_device_id: string;
  sender_public_key?: string;
  devices: Record<string, SignalDeviceCiphertext>;
}

// Convert string device ID to safe integer for SignalProtocolAddress
function parseDeviceId(deviceIdStr: string): number {
  let hash = 0;
  for (let i = 0; i < deviceIdStr.length; i++) {
    hash = (hash * 31 + deviceIdStr.charCodeAt(i)) >>> 0;
  }
  return (hash % 2147483647) + 1;
}

export class SignalProtocolManager {
  private store: SignalIndexedDBStore | null = null;
  private userId: string = '';
  private deviceId: string = '';
  private initialized: boolean = false;
  private serverId = '';
  private decrypting = new Map<string, Promise<{ conversationId: string; text: string }>>();
  private initPromise: Promise<void> | null = null;

  async initialize(userId: string, deviceId: string, apiToken?: string): Promise<void> {
    const serverId = serverManager.getActiveServer().id;
    if (this.initialized && this.userId === userId && this.deviceId === deviceId && this.serverId === serverId) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return this.initialize(userId, deviceId, apiToken);
    }

    this.initPromise = (async () => {
      this.initialized = false;
      this.serverId = serverId;
      this.userId = userId;
      this.deviceId = deviceId;
      this.store = new SignalIndexedDBStore(userId);
      await this.store.ready();

      // Check if identity key exists
      let identityKey = await this.store.getIdentityKeyPair();
      let registrationId = await this.store.getLocalRegistrationId();


      if (!identityKey || !registrationId) {
        identityKey = await KeyHelper.generateIdentityKeyPair();
        registrationId = KeyHelper.generateRegistrationId();
        await this.store.setIdentityKeyPair(identityKey);
        await this.store.setLocalRegistrationId(registrationId);
      }

      let signed = await this.store.getMetadata<SignedPreKeyPairType>('publishedSignedPreKey');
      if (!signed) {
        const keyId = Date.now() % 2147483647;
        signed = await KeyHelper.generateSignedPreKey(identityKey, keyId);
        await this.store.storeSignedPreKey(signed.keyId, signed.keyPair);
        await this.store.setMetadata('publishedSignedPreKey', signed);
      }
      const preKeyStrings: string[] = [];
      let nextId = (await this.store.getMetadata<number>('nextPreKeyId')) || 26;
      for (let n = 0; n < 25; n++, nextId++) {
        const key = await KeyHelper.generatePreKey(nextId);
        await this.store.storePreKey(nextId, key.keyPair);
        preKeyStrings.push(JSON.stringify({ keyId: nextId, publicKey: bufferToBase64(key.keyPair.pubKey) }));
      }
      await this.store.setMetadata('nextPreKeyId', nextId);
      let expectedLegacyKey: string | undefined;
      if (apiToken) {
        const devices = await api.listDevices(apiToken);
        expectedLegacyKey = devices.find(d => d.id === deviceId)?.identity_public_key || undefined;
      }
      const myKeyPair = await cryptoEngine.getOrCreateDeviceKeyPair(userId, deviceId, expectedLegacyKey);
      if (apiToken) {
        await api.registerSignalKeys({
          device_id: deviceId,
          identity_public_key: myKeyPair.publicKeyBase64,
          registration_id: registrationId,
          signed_pre_key: JSON.stringify({
            keyId: signed.keyId,
            publicKey: bufferToBase64(signed.keyPair.pubKey),
            signature: bufferToBase64(signed.signature),
            identityKey: bufferToBase64(identityKey.pubKey),
          }),
          pre_keys: preKeyStrings,
        }, apiToken);
      }

      this.initialized = true;
    })();

    try { await this.initPromise; } finally { this.initPromise = null; }
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getUserId(): string {
    return this.userId;
  }

  getStore(): SignalIndexedDBStore {
    if (!this.store) {
      throw new Error('Signal store not initialized. Call initialize() first.');
    }
    return this.store;
  }

  // Encrypt to multiple recipient devices and sender's other companion devices
  async encryptMultiDevice(
    plaintext: string,
    targets: Array<{ userId: string; deviceId: string; publicKeyBase64?: string }>,
    conversationId: string,
    apiToken?: string
  ): Promise<{ ciphertext: string; nonce: string; isSignal: boolean }> {
    const myKeyPair = await cryptoEngine.getOrCreateDeviceKeyPair(this.userId, this.deviceId);

    if (!this.initialized || !this.store) throw new Error('ENCRYPTION_NOT_READY: Initialize this device before sending.');

    const encoder = new TextEncoder();
    const plaintextBuffer = encoder.encode(JSON.stringify({ domain: 'senora.signal', conversation_id: conversationId, sender_user_id: this.userId, text: plaintext })).buffer;
    const devicesMap: Record<string, SignalDeviceCiphertext> = {};

    for (const target of targets) {
      if (target.deviceId === this.deviceId) {
        devicesMap[target.deviceId] = await archiveEncrypt(this.store, plaintext, conversationId);
        continue;
      }

      const address = new SignalProtocolAddress(target.userId, parseDeviceId(target.deviceId));
      const sessionCipher = new SessionCipher(this.store, address);
      const hasSession = (await this.store.loadSession(address.toString())) !== undefined;

      if (!hasSession && apiToken) {
        // Fetch pre-key bundle for recipient
        try {
          {
            const data: UserKeysResponse = await api.getUserKeys(target.userId, apiToken);
            const devBundle = data.devices.find((d) => d.device_id === target.deviceId);
            if (devBundle && devBundle.identity_public_key) {
              const sessionBuilder = new SessionBuilder(this.store, address);

              let preKeyPart = undefined;
              if (devBundle.one_time_pre_key) {
                try {
                  const pkObj = JSON.parse(devBundle.one_time_pre_key);
                  preKeyPart = {
                    keyId: pkObj.keyId,
                    publicKey: base64ToBuffer(pkObj.publicKey).buffer as ArrayBuffer,
                  };
                } catch {}
              }

              let spkPart = undefined;
              if (devBundle.signed_pre_key) {
                try {
                  const spkObj = JSON.parse(devBundle.signed_pre_key);
                  spkPart = {
                    keyId: spkObj.keyId || 1,
                    publicKey: base64ToBuffer(spkObj.publicKey).buffer as ArrayBuffer,
                    signature: base64ToBuffer(spkObj.signature).buffer as ArrayBuffer,
                  };
                } catch {}
              }

              if (spkPart) {
                await sessionBuilder.processPreKey({
                  registrationId: devBundle.registration_id || 1,
                  identityKey: base64ToBuffer(JSON.parse(devBundle.signed_pre_key!).identityKey || devBundle.identity_public_key).buffer as ArrayBuffer,
                  signedPreKey: spkPart,
                  preKey: preKeyPart,
                });
              }
            }
          }
        } catch (e) {
          console.warn('[SignalManager] Failed to fetch prekey bundle for', target.userId, e);
        }
      }

      // Check session again
      if ((await this.store.loadSession(address.toString())) !== undefined) {
        const ciphertextObj = await sessionCipher.encrypt(plaintextBuffer);
        devicesMap[target.deviceId] = {
          type: ciphertextObj.type,
          body: ciphertextObj.body || '',
          registrationId: ciphertextObj.registrationId,
        };
      } else {
        throw new Error('SIGNAL_SESSION_UNAVAILABLE: The recipient must update and initialize their device.');
      }
    }

    // Ensure sender's own device is always included in the envelope with self-device encryption
    // so the sender can decrypt its own sent message across reloads and multi-device views
    if (!devicesMap[this.deviceId]) {
      devicesMap[this.deviceId] = await archiveEncrypt(this.store, plaintext, conversationId);
    }

    const envelope: SignalMultiDeviceEnvelope = {
      v: 2,
      type: 'signal_multidevice',
      sender_user_id: this.userId,
      sender_device_id: this.deviceId,
      sender_public_key: myKeyPair.publicKeyBase64,
      devices: devicesMap,
    };

    return {
      ciphertext: JSON.stringify(envelope),
      nonce: 'signal-v2',
      isSignal: true,
    };
  }

  // Decrypt multi-device message (v2 Signal, v1 legacy envelope, or direct ciphertext)
  async decryptMessage(
    rawCiphertext: string,
    rawNonce: string,
    senderUserId: string,
    senderDeviceId: string,
    peerPublicKeyBase64: string,
    conversationId?: string
  ): Promise<string> {
    if (typeof rawCiphertext === 'string' && rawCiphertext.trim().startsWith('{')) {
      let parsed: any;
      try {
        parsed = JSON.parse(rawCiphertext);
      } catch {
        // Not valid JSON, fall through
      }

      if (parsed) {
        // Version 2: Real Signal Protocol multi-device envelope
        if (parsed.v === 2 && parsed.devices && typeof parsed.devices === 'object') {
          if (parsed.sender_user_id && parsed.sender_user_id !== senderUserId) throw new Error('SENDER_MISMATCH');
          const deviceIds = Object.keys(parsed.devices);
          if (deviceIds.length === 0) {
            throw new Error('EMPTY_ENVELOPE: Multi-device envelope has no recipient entries');
          }

          // Resolve device ciphertext: check exact deviceId
          let deviceCipher: SignalDeviceCiphertext | undefined = parsed.devices[this.deviceId];

          // If self-sent, sender may have recorded under sender_device_id or primary device
          if (!deviceCipher && (parsed.sender_user_id === this.userId || senderUserId === this.userId)) {
            if (parsed.sender_device_id && parsed.devices[parsed.sender_device_id]) {
              deviceCipher = parsed.devices[parsed.sender_device_id];
            } else if (deviceIds.length > 0) {
              deviceCipher = parsed.devices[deviceIds[0]];
            }
          }

          // Legacy single-device fallback when this device uses a default placeholder ID
          if (!deviceCipher && (this.deviceId === 'dev_current' || this.deviceId === 'legacy') && deviceIds.length === 1) {
            deviceCipher = parsed.devices[deviceIds[0]];
          }

          if (!deviceCipher) {
            throw new Error(`DEVICE_NOT_TARGETED: Message was not encrypted for this device (${this.deviceId})`);
          }

          if (deviceCipher.type === 998) {
            return archiveDecrypt(this.getStore(), deviceCipher, conversationId || '');
          }
          if (deviceCipher.type === 999) {
            // Pairwise fallback or self-device encryption
            let keyToUse = peerPublicKeyBase64;
            // If the message was sent by THIS user, decrypt using our own public key
            if (parsed.sender_user_id === this.userId || parsed.sender_device_id === this.deviceId || senderUserId === this.userId) {
              const myKeyPair = await cryptoEngine.getOrCreateDeviceKeyPair(this.userId, this.deviceId);
              keyToUse = myKeyPair.publicKeyBase64;
            } else if (parsed.sender_public_key) {
              keyToUse = parsed.sender_public_key;
            }
            const nonceToUse = deviceCipher.nonce || (rawNonce !== 'signal-v2' && rawNonce !== 'multidevice' ? rawNonce : '');
            return await cryptoEngine.decrypt(deviceCipher.body, nonceToUse, keyToUse, conversationId);
          }

          if (this.store) {
            const protocolStore = this.store;
            const effectiveSenderId = parsed.sender_user_id || senderUserId;
            const effectiveSenderDeviceId = parsed.sender_device_id || senderDeviceId;
            const address = new SignalProtocolAddress(effectiveSenderId, parseDeviceId(effectiveSenderDeviceId));
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${effectiveSenderId}:${effectiveSenderDeviceId}:${deviceCipher.body}`));
            const cacheKey = `signalHistory:${bufferToBase64(digest)}`;
            const jobKey = `${this.serverId}:${this.userId}:${this.deviceId}:${cacheKey}`;
            let job = this.decrypting.get(jobKey);
            if (!job) {
              const entry = deviceCipher;
              job = (async () => {
                const cached = await protocolStore.getMetadata<SignalDeviceCiphertext & { conversationId: string }>(cacheKey);
                if (cached) return { conversationId: cached.conversationId, text: await archiveDecrypt(protocolStore, cached, cached.conversationId) };
                const cipher = new SessionCipher(protocolStore, address);
                const buffer = entry.type === 3
                  ? await cipher.decryptPreKeyWhisperMessage(entry.body, 'binary')
                  : await cipher.decryptWhisperMessage(entry.body, 'binary');
                const context = JSON.parse(new TextDecoder().decode(buffer));
                if (context.domain !== 'senora.signal' || typeof context.conversation_id !== 'string' || context.sender_user_id !== senderUserId || typeof context.text !== 'string') throw new Error('CONVERSATION_MISMATCH');
                const saved = await archiveEncrypt(protocolStore, context.text, context.conversation_id);
                await protocolStore.setMetadata(cacheKey, { ...saved, conversationId: context.conversation_id });
                return { conversationId: context.conversation_id as string, text: context.text as string };
              })();
              this.decrypting.set(jobKey, job);
            }
            try {
              const decrypted = await job;
              if (decrypted.conversationId !== conversationId) throw new Error('CONVERSATION_MISMATCH');
              return decrypted.text;
            } finally {
              if (this.decrypting.get(jobKey) === job) this.decrypting.delete(jobKey);
            }
          }
        }

        // Version 1: Legacy multi-device envelope
        if (parsed.v === 1) {
          return await cryptoEngine.decryptMultiDevice(
            rawCiphertext,
            rawNonce,
            peerPublicKeyBase64,
            this.deviceId,
            conversationId
          );
        }
      }
    }

    // Direct legacy decryption fallback
    return await cryptoEngine.decryptMultiDevice(
      rawCiphertext,
      rawNonce,
      peerPublicKeyBase64,
      this.deviceId,
      conversationId
    );
  }

  // Calculate 12-digit safety number between two identities
  async calculateSafetyNumber(theirIdentityKeyBase64: string): Promise<string> {
    const peer = base64ToBuffer(theirIdentityKeyBase64);
    const signalKey = await this.store?.getIdentityKeyPair();
    const ours = peer.byteLength === 33 && signalKey
      ? bufferToBase64(signalKey.pubKey)
      : (await cryptoEngine.getOrCreateDeviceKeyPair(this.userId || undefined, this.deviceId || undefined)).publicKeyBase64;
    return computeSafetyNumber(ours, theirIdentityKeyBase64);
  }

  // --- End-to-End Encrypted Attachments ---

  // Encrypt file client-side using random AES-256-GCM symmetric key
  async encryptAttachment(file: File | Blob): Promise<{
    encryptedBlob: Blob;
    keyBase64: string;
    ivBase64: string;
    filename: string;
  }> {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const fileBuffer = await file.arrayBuffer();

    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      fileBuffer
    );

    const exportedKey = await crypto.subtle.exportKey('raw', key);

    return {
      encryptedBlob: new Blob([encryptedBuffer], { type: 'application/octet-stream' }),
      keyBase64: bufferToBase64(exportedKey),
      ivBase64: bufferToBase64(iv.buffer as ArrayBuffer),
      filename: (file as File).name || 'attachment.enc',
    };
  }

  // Decrypt downloaded attachment client-side
  async decryptAttachment(
    encryptedBlob: Blob,
    keyBase64: string,
    ivBase64: string,
    originalMimeType: string
  ): Promise<Blob> {
    const rawKey = base64ToBuffer(keyBase64);
    const iv = base64ToBuffer(ivBase64);

    const key = await crypto.subtle.importKey(
      'raw',
      rawKey.buffer as ArrayBuffer,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const encryptedBuffer = await encryptedBlob.arrayBuffer();
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
      key,
      encryptedBuffer
    );

    return new Blob([decryptedBuffer], { type: originalMimeType || 'application/octet-stream' });
  }

  // --- End-to-End Encrypted Polls ---

  // Encrypt poll question and options client-side via AES-256-GCM before server submission
  async encryptPollData(
    question: string,
    options: string[],
    explanation?: string
  ): Promise<{
    encryptedQuestion: string;
    encryptedOptions: string[];
    encryptedExplanation?: string;
    keyBase64: string;
    ivBase64: string;
  }> {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const enc = new TextEncoder();

    // Encrypt each field with its own distinct, cryptographically secure 12-byte IV
    const encryptField = async (text: string): Promise<string> => {
      const fieldIv = crypto.getRandomValues(new Uint8Array(12));
      const encBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: fieldIv },
        key,
        enc.encode(text)
      );
      const combined = new Uint8Array(12 + encBuf.byteLength);
      combined.set(fieldIv, 0);
      combined.set(new Uint8Array(encBuf), 12);
      return bufferToBase64(combined.buffer);
    };

    const encQuestion = await encryptField(question);
    const encOptions: string[] = [];
    for (const opt of options) {
      encOptions.push(await encryptField(opt));
    }

    const exportedKey = await crypto.subtle.exportKey('raw', key);
    const legacyIv = crypto.getRandomValues(new Uint8Array(12));
    return {
      encryptedQuestion: encQuestion,
      encryptedOptions: encOptions,
      encryptedExplanation: explanation ? await encryptField(explanation) : undefined,
      keyBase64: bufferToBase64(exportedKey),
      ivBase64: bufferToBase64(legacyIv.buffer as ArrayBuffer),
    };
  }

  // Decrypt poll question or option text client-side
  async decryptPollText(
    ciphertextBase64: string,
    keyBase64: string,
    ivBase64?: string
  ): Promise<string> {
    try {
      const rawKey = base64ToBuffer(keyBase64);
      const data = base64ToBuffer(ciphertextBase64);

      const key = await crypto.subtle.importKey(
        'raw',
        rawKey.buffer as ArrayBuffer,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );

      // 1. Attempt decryption using prepended 12-byte IV (data >= 12 bytes IV + 16 bytes tag = 28 bytes)
      if (data.byteLength >= 28) {
        try {
          const fieldIv = data.slice(0, 12);
          const cipherBuf = data.slice(12);
          const decBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fieldIv.buffer as ArrayBuffer },
            key,
            cipherBuf.buffer as ArrayBuffer
          );
          return new TextDecoder().decode(decBuf);
        } catch {
          // If prepended extraction fails, fall through to separate ivBase64
        }
      }

      // 2. Legacy fallback to separate ivBase64
      if (ivBase64) {
        const iv = base64ToBuffer(ivBase64);
        const decBuf = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
          key,
          data.buffer as ArrayBuffer
        );
        return new TextDecoder().decode(decBuf);
      }

      return '[Decryption error]';
    } catch {
      return '[Decryption error]';
    }
  }
}

export const signalManager = new SignalProtocolManager();
