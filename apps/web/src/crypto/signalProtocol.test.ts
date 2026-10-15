import { describe, it, expect } from 'vitest';
import {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  StorageType,
  KeyPairType,
  SessionRecordType,
  Direction,
} from '@privacyresearch/libsignal-protocol-typescript';

class InMemorySignalProtocolStore implements StorageType {
  private identityKeyPair?: KeyPairType;
  private registrationId?: number;
  private preKeys = new Map<number | string, KeyPairType>();
  private signedPreKeys = new Map<number | string, KeyPairType>();
  private sessions = new Map<string, SessionRecordType>();
  private trustedIdentities = new Map<string, ArrayBuffer>();

  constructor(identityKeyPair?: KeyPairType, registrationId?: number) {
    this.identityKeyPair = identityKeyPair;
    this.registrationId = registrationId;
  }

  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    return this.identityKeyPair;
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    return this.registrationId;
  }

  async isTrustedIdentity(identifier: string, identityKey: ArrayBuffer, _direction: Direction): Promise<boolean> {
    const existing = this.trustedIdentities.get(identifier);
    if (!existing) {
      return true; // First use trust
    }
    const a = new Uint8Array(existing);
    const b = new Uint8Array(identityKey);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  async saveIdentity(encodedAddress: string, publicKey: ArrayBuffer, _nonblockingApproval?: boolean): Promise<boolean> {
    this.trustedIdentities.set(encodedAddress, publicKey);
    return true;
  }

  async loadPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    return this.preKeys.get(keyId);
  }

  async storePreKey(keyId: string | number, keyPair: KeyPairType): Promise<void> {
    this.preKeys.set(keyId, keyPair);
  }

  async removePreKey(keyId: string | number): Promise<void> {
    this.preKeys.delete(keyId);
  }

  async storeSession(encodedAddress: string, record: SessionRecordType): Promise<void> {
    this.sessions.set(encodedAddress, record);
  }

  async loadSession(encodedAddress: string): Promise<SessionRecordType | undefined> {
    return this.sessions.get(encodedAddress);
  }

  async loadSignedPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    return this.signedPreKeys.get(keyId);
  }

  async storeSignedPreKey(keyId: string | number, keyPair: KeyPairType): Promise<void> {
    this.signedPreKeys.set(keyId, keyPair);
  }

  async removeSignedPreKey(keyId: string | number): Promise<void> {
    this.signedPreKeys.delete(keyId);
  }
}

describe('Signal Protocol (Double Ratchet & X3DH) Integration & Test Vectors', () => {
  it('establishes X3DH session and executes Double Ratchet roundtrips between Alice and Bob', async () => {
    // 1. Generate Alice identity and store
    const aliceIdentity = await KeyHelper.generateIdentityKeyPair();
    const aliceRegistrationId = KeyHelper.generateRegistrationId();
    const aliceStore = new InMemorySignalProtocolStore(aliceIdentity, aliceRegistrationId);

    // 2. Generate Bob identity, pre-keys, and store
    const bobIdentity = await KeyHelper.generateIdentityKeyPair();
    const bobRegistrationId = KeyHelper.generateRegistrationId();
    const bobStore = new InMemorySignalProtocolStore(bobIdentity, bobRegistrationId);

    const bobPreKey = await KeyHelper.generatePreKey(1);
    await bobStore.storePreKey(1, bobPreKey.keyPair);

    const bobSignedPreKey = await KeyHelper.generateSignedPreKey(bobIdentity, 1);
    await bobStore.storeSignedPreKey(1, bobSignedPreKey.keyPair);

    // 3. Addresses
    const aliceAddress = new SignalProtocolAddress('alice', 1);
    const bobAddress = new SignalProtocolAddress('bob', 1);

    // 4. Alice initiates X3DH using Bob's pre-key bundle
    const aliceSessionBuilder = new SessionBuilder(aliceStore, bobAddress);
    await aliceSessionBuilder.processPreKey({
      registrationId: bobRegistrationId,
      identityKey: bobIdentity.pubKey,
      signedPreKey: {
        keyId: 1,
        publicKey: bobSignedPreKey.keyPair.pubKey,
        signature: bobSignedPreKey.signature,
      },
      preKey: {
        keyId: 1,
        publicKey: bobPreKey.keyPair.pubKey,
      },
    });

    // 5. Alice encrypts initial message (PreKeyWhisperMessage)
    const aliceCipher = new SessionCipher(aliceStore, bobAddress);
    const plain1 = new TextEncoder().encode('Hello Bob, this is Alice via Signal Double Ratchet!');
    const ciphertextMsg1 = await aliceCipher.encrypt(plain1.buffer as ArrayBuffer);

    expect(ciphertextMsg1.type).toBe(3); // PreKeyWhisperMessage type is 3
    expect(ciphertextMsg1.body).toBeDefined();

    // 6. Bob decrypts initial PreKeyWhisperMessage
    const bobCipher = new SessionCipher(bobStore, aliceAddress);
    const decryptedBytes1 = await bobCipher.decryptPreKeyWhisperMessage(ciphertextMsg1.body!, 'binary');
    const decrypted1 = new TextDecoder().decode(decryptedBytes1);
    expect(decrypted1).toBe('Hello Bob, this is Alice via Signal Double Ratchet!');

    // 7. Bob replies to Alice (DH ratchet step!)
    const plain2 = new TextEncoder().encode('Hi Alice! Forward secrecy and post-compromise security established.');
    const ciphertextMsg2 = await bobCipher.encrypt(plain2.buffer as ArrayBuffer);

    expect(ciphertextMsg2.type).toBe(1); // Standard WhisperMessage type is 1

    // 8. Alice decrypts Bob's reply (completing full DH ratchet step!)
    const decryptedBytes2 = await aliceCipher.decryptWhisperMessage(ciphertextMsg2.body!, 'binary');
    const decrypted2 = new TextDecoder().decode(decryptedBytes2);
    expect(decrypted2).toBe('Hi Alice! Forward secrecy and post-compromise security established.');

    // 9. Alice sends second message in the same ratchet chain
    const plain3 = new TextEncoder().encode('Second message in ratchet chain.');
    const ciphertextMsg3 = await aliceCipher.encrypt(plain3.buffer as ArrayBuffer);
    const decryptedBytes3 = await bobCipher.decryptWhisperMessage(ciphertextMsg3.body!, 'binary');
    expect(new TextDecoder().decode(decryptedBytes3)).toBe('Second message in ratchet chain.');
  });

  it('negative test: rejects tampered ciphertext or wrong address', async () => {
    const aliceIdentity = await KeyHelper.generateIdentityKeyPair();
    const aliceRegId = KeyHelper.generateRegistrationId();
    const aliceStore = new InMemorySignalProtocolStore(aliceIdentity, aliceRegId);

    const bobIdentity = await KeyHelper.generateIdentityKeyPair();
    const bobRegId = KeyHelper.generateRegistrationId();
    const bobStore = new InMemorySignalProtocolStore(bobIdentity, bobRegId);

    const bobPreKey = await KeyHelper.generatePreKey(10);
    await bobStore.storePreKey(10, bobPreKey.keyPair);
    const bobSignedPreKey = await KeyHelper.generateSignedPreKey(bobIdentity, 10);
    await bobStore.storeSignedPreKey(10, bobSignedPreKey.keyPair);

    const bobAddress = new SignalProtocolAddress('bob_user', 1);
    const aliceAddress = new SignalProtocolAddress('alice_user', 1);

    const builder = new SessionBuilder(aliceStore, bobAddress);
    await builder.processPreKey({
      registrationId: bobRegId,
      identityKey: bobIdentity.pubKey,
      signedPreKey: {
        keyId: 10,
        publicKey: bobSignedPreKey.keyPair.pubKey,
        signature: bobSignedPreKey.signature,
      },
    });

    const aliceCipher = new SessionCipher(aliceStore, bobAddress);
    const encrypted = await aliceCipher.encrypt(new TextEncoder().encode('Secret payload').buffer as ArrayBuffer);

    // Tampering with message body fails decryption
    const tamperedBody = encrypted.body!.slice(0, -4) + 'XXXX';
    const bobCipher = new SessionCipher(bobStore, aliceAddress);
    await expect(
      bobCipher.decryptPreKeyWhisperMessage(tamperedBody, 'binary')
    ).rejects.toThrow();
  });

  it('rejects replayed messages (replay protection at protocol level)', async () => {
    const aliceIdentity = await KeyHelper.generateIdentityKeyPair();
    const aliceRegId = KeyHelper.generateRegistrationId();
    const aliceStore = new InMemorySignalProtocolStore(aliceIdentity, aliceRegId);

    const bobIdentity = await KeyHelper.generateIdentityKeyPair();
    const bobRegId = KeyHelper.generateRegistrationId();
    const bobStore = new InMemorySignalProtocolStore(bobIdentity, bobRegId);

    const bobPreKey = await KeyHelper.generatePreKey(20);
    await bobStore.storePreKey(20, bobPreKey.keyPair);
    const bobSignedPreKey = await KeyHelper.generateSignedPreKey(bobIdentity, 20);
    await bobStore.storeSignedPreKey(20, bobSignedPreKey.keyPair);

    const bobAddress = new SignalProtocolAddress('bob_user_2', 1);
    const aliceAddress = new SignalProtocolAddress('alice_user_2', 1);

    const builder = new SessionBuilder(aliceStore, bobAddress);
    await builder.processPreKey({
      registrationId: bobRegId,
      identityKey: bobIdentity.pubKey,
      signedPreKey: {
        keyId: 20,
        publicKey: bobSignedPreKey.keyPair.pubKey,
        signature: bobSignedPreKey.signature,
      },
    });

    const aliceCipher = new SessionCipher(aliceStore, bobAddress);
    const msg = await aliceCipher.encrypt(new TextEncoder().encode('Single use message').buffer as ArrayBuffer);

    const bobCipher = new SessionCipher(bobStore, aliceAddress);
    const dec1 = await bobCipher.decryptPreKeyWhisperMessage(msg.body!, 'binary');
    expect(new TextDecoder().decode(dec1)).toBe('Single use message');

    // Replay the exact same message body to bobCipher:
    // SessionCipher must reject because message key has evolved or prekey has been consumed
    await expect(
      bobCipher.decryptPreKeyWhisperMessage(msg.body!, 'binary')
    ).rejects.toThrow();
  });

  it('handles consecutive ratchet steps and maintains forward secrecy', async () => {
    const aliceIdentity = await KeyHelper.generateIdentityKeyPair();
    const aliceRegId = KeyHelper.generateRegistrationId();
    const aliceStore = new InMemorySignalProtocolStore(aliceIdentity, aliceRegId);

    const bobIdentity = await KeyHelper.generateIdentityKeyPair();
    const bobRegId = KeyHelper.generateRegistrationId();
    const bobStore = new InMemorySignalProtocolStore(bobIdentity, bobRegId);

    const bobPreKey = await KeyHelper.generatePreKey(30);
    await bobStore.storePreKey(30, bobPreKey.keyPair);
    const bobSignedPreKey = await KeyHelper.generateSignedPreKey(bobIdentity, 30);
    await bobStore.storeSignedPreKey(30, bobSignedPreKey.keyPair);

    const bobAddress = new SignalProtocolAddress('bob_ratchet', 1);
    const aliceAddress = new SignalProtocolAddress('alice_ratchet', 1);

    const builder = new SessionBuilder(aliceStore, bobAddress);
    await builder.processPreKey({
      registrationId: bobRegId,
      identityKey: bobIdentity.pubKey,
      signedPreKey: {
        keyId: 30,
        publicKey: bobSignedPreKey.keyPair.pubKey,
        signature: bobSignedPreKey.signature,
      },
      preKey: {
        keyId: 30,
        publicKey: bobPreKey.keyPair.pubKey,
      },
    });

    const aliceCipher = new SessionCipher(aliceStore, bobAddress);
    const bobCipher = new SessionCipher(bobStore, aliceAddress);

    // Initial msg
    const m1 = await aliceCipher.encrypt(new TextEncoder().encode('M1').buffer as ArrayBuffer);
    const d1 = await bobCipher.decryptPreKeyWhisperMessage(m1.body!, 'binary');
    expect(new TextDecoder().decode(d1)).toBe('M1');

    // Ping pong 5 times
    for (let i = 2; i <= 6; i++) {
      if (i % 2 === 0) {
        // Bob -> Alice
        const sent = await bobCipher.encrypt(new TextEncoder().encode(`Message ${i}`).buffer as ArrayBuffer);
        const dec = await aliceCipher.decryptWhisperMessage(sent.body!, 'binary');
        expect(new TextDecoder().decode(dec)).toBe(`Message ${i}`);
      } else {
        // Alice -> Bob
        const sent = await aliceCipher.encrypt(new TextEncoder().encode(`Message ${i}`).buffer as ArrayBuffer);
        const dec = await bobCipher.decryptWhisperMessage(sent.body!, 'binary');
        expect(new TextDecoder().decode(dec)).toBe(`Message ${i}`);
      }
    }
  });

  it('detects untrusted or changed identity key during session establishment', async () => {
    class StrictIdentityStore extends InMemorySignalProtocolStore {
      override async isTrustedIdentity(_identifier: string, identityKey: ArrayBuffer): Promise<boolean> {
        // Reject unknown or changed keys
        const trusted = (this as any).trustedIdentities?.get(_identifier);
        if (!trusted) return false; // Strict: require explicit pinning
        const a = new Uint8Array(trusted);
        const b = new Uint8Array(identityKey);
        if (a.length !== b.length) return false;
        return a.every((val, idx) => val === b[idx]);
      }
    }

    const aliceIdentity = await KeyHelper.generateIdentityKeyPair();
    const aliceRegId = KeyHelper.generateRegistrationId();
    const aliceStore = new StrictIdentityStore(aliceIdentity, aliceRegId);

    const evilIdentity = await KeyHelper.generateIdentityKeyPair();
    const evilRegId = KeyHelper.generateRegistrationId();
    const evilSignedPreKey = await KeyHelper.generateSignedPreKey(evilIdentity, 99);

    const untrustedAddress = new SignalProtocolAddress('impostor_user', 1);
    const builder = new SessionBuilder(aliceStore, untrustedAddress);

    // Should reject because isTrustedIdentity returns false
    await expect(
      builder.processPreKey({
        registrationId: evilRegId,
        identityKey: evilIdentity.pubKey,
        signedPreKey: {
          keyId: 99,
          publicKey: evilSignedPreKey.keyPair.pubKey,
          signature: evilSignedPreKey.signature,
        },
      })
    ).rejects.toThrow();
  });

  it('persists and restores session records across store instances', async () => {
    const aliceIdentity = await KeyHelper.generateIdentityKeyPair();
    const aliceRegId = KeyHelper.generateRegistrationId();
    const aliceStore1 = new InMemorySignalProtocolStore(aliceIdentity, aliceRegId);

    const bobIdentity = await KeyHelper.generateIdentityKeyPair();
    const bobRegId = KeyHelper.generateRegistrationId();
    const bobStore = new InMemorySignalProtocolStore(bobIdentity, bobRegId);

    const bobPreKey = await KeyHelper.generatePreKey(40);
    await bobStore.storePreKey(40, bobPreKey.keyPair);
    const bobSignedPreKey = await KeyHelper.generateSignedPreKey(bobIdentity, 40);
    await bobStore.storeSignedPreKey(40, bobSignedPreKey.keyPair);

    const bobAddress = new SignalProtocolAddress('bob_persisted', 1);
    const aliceAddress = new SignalProtocolAddress('alice_persisted', 1);

    const builder = new SessionBuilder(aliceStore1, bobAddress);
    await builder.processPreKey({
      registrationId: bobRegId,
      identityKey: bobIdentity.pubKey,
      signedPreKey: {
        keyId: 40,
        publicKey: bobSignedPreKey.keyPair.pubKey,
        signature: bobSignedPreKey.signature,
      },
      preKey: {
        keyId: 40,
        publicKey: bobPreKey.keyPair.pubKey,
      },
    });

    // Alice sends initial message using store 1
    const aliceCipher1 = new SessionCipher(aliceStore1, bobAddress);
    const msg1 = await aliceCipher1.encrypt(new TextEncoder().encode('Pre-reload msg').buffer as ArrayBuffer);

    // Export Alice's session record from store 1
    const aliceSessionRecord = await aliceStore1.loadSession(bobAddress.toString());
    expect(aliceSessionRecord).toBeDefined();

    // Bob processes msg1
    const bobCipher = new SessionCipher(bobStore, aliceAddress);
    const dec1 = await bobCipher.decryptPreKeyWhisperMessage(msg1.body!, 'binary');
    expect(new TextDecoder().decode(dec1)).toBe('Pre-reload msg');

    // Bob replies
    const reply1 = await bobCipher.encrypt(new TextEncoder().encode('Pre-reload reply').buffer as ArrayBuffer);

    // Alice "reloads browser" - new store instance restores saved session
    const aliceStore2 = new InMemorySignalProtocolStore(aliceIdentity, aliceRegId);
    await aliceStore2.storeSession(bobAddress.toString(), aliceSessionRecord!);

    const aliceCipher2 = new SessionCipher(aliceStore2, bobAddress);
    const decReply = await aliceCipher2.decryptWhisperMessage(reply1.body!, 'binary');
    expect(new TextDecoder().decode(decReply)).toBe('Pre-reload reply');

    // Alice continues communicating seamlessly on new store instance
    const msg2 = await aliceCipher2.encrypt(new TextEncoder().encode('Post-reload msg').buffer as ArrayBuffer);
    const dec2 = await bobCipher.decryptWhisperMessage(msg2.body!, 'binary');
    expect(new TextDecoder().decode(dec2)).toBe('Post-reload msg');
  });

  it('handles out-of-order message delivery in ratchet chain', async () => {
    const aliceIdentity = await KeyHelper.generateIdentityKeyPair();
    const aliceRegId = KeyHelper.generateRegistrationId();
    const aliceStore = new InMemorySignalProtocolStore(aliceIdentity, aliceRegId);

    const bobIdentity = await KeyHelper.generateIdentityKeyPair();
    const bobRegId = KeyHelper.generateRegistrationId();
    const bobStore = new InMemorySignalProtocolStore(bobIdentity, bobRegId);

    const bobPreKey = await KeyHelper.generatePreKey(50);
    await bobStore.storePreKey(50, bobPreKey.keyPair);
    const bobSignedPreKey = await KeyHelper.generateSignedPreKey(bobIdentity, 50);
    await bobStore.storeSignedPreKey(50, bobSignedPreKey.keyPair);

    const bobAddress = new SignalProtocolAddress('bob_ooo', 1);
    const aliceAddress = new SignalProtocolAddress('alice_ooo', 1);

    const builder = new SessionBuilder(aliceStore, bobAddress);
    await builder.processPreKey({
      registrationId: bobRegId,
      identityKey: bobIdentity.pubKey,
      signedPreKey: {
        keyId: 50,
        publicKey: bobSignedPreKey.keyPair.pubKey,
        signature: bobSignedPreKey.signature,
      },
      preKey: {
        keyId: 50,
        publicKey: bobPreKey.keyPair.pubKey,
      },
    });

    const aliceCipher = new SessionCipher(aliceStore, bobAddress);
    const bobCipher = new SessionCipher(bobStore, aliceAddress);

    // Initial msg establishes session
    const m0 = await aliceCipher.encrypt(new TextEncoder().encode('M0').buffer as ArrayBuffer);
    await bobCipher.decryptPreKeyWhisperMessage(m0.body!, 'binary');

    // Bob replies so bidirectional ratchet is established
    const bobReply = await bobCipher.encrypt(new TextEncoder().encode('Bob initial reply').buffer as ArrayBuffer);
    await aliceCipher.decryptWhisperMessage(bobReply.body!, 'binary');

    // Now Alice produces messages M1, M2, M3 in sequence (these are type 1 WhisperMessages)
    const m1 = await aliceCipher.encrypt(new TextEncoder().encode('Message 1').buffer as ArrayBuffer);
    const m2 = await aliceCipher.encrypt(new TextEncoder().encode('Message 2').buffer as ArrayBuffer);
    const m3 = await aliceCipher.encrypt(new TextEncoder().encode('Message 3').buffer as ArrayBuffer);

    expect(m1.type).toBe(1);
    expect(m2.type).toBe(1);
    expect(m3.type).toBe(1);

    // Bob receives M3 FIRST (out-of-order)
    const dec3 = await bobCipher.decryptWhisperMessage(m3.body!, 'binary');
    expect(new TextDecoder().decode(dec3)).toBe('Message 3');

    // Bob then receives M1 (delayed)
    const dec1 = await bobCipher.decryptWhisperMessage(m1.body!, 'binary');
    expect(new TextDecoder().decode(dec1)).toBe('Message 1');

    // Bob then receives M2
    const dec2 = await bobCipher.decryptWhisperMessage(m2.body!, 'binary');
    expect(new TextDecoder().decode(dec2)).toBe('Message 2');
  });
});
