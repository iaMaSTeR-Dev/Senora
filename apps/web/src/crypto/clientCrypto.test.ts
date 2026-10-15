import { describe, it, expect } from 'vitest';
import {
  ClientCryptoEngine,
  bufferToBase64,
  base64ToBuffer,
  computeSafetyNumber,
  buildCanonicalAAD,
  verifyDeviceKeyList,
} from './clientCrypto';

describe('ClientCryptoEngine E2EE Unit & Adversarial Tests', () => {
  it('performs full ECDH key exchange, encryption, and decryption between two distinct engines', async () => {
    const alice = new ClientCryptoEngine();
    const bob = new ClientCryptoEngine();

    const aliceKeys = await alice.getOrCreateDeviceKeyPair();
    const bobKeys = await bob.getOrCreateDeviceKeyPair();

    expect(aliceKeys.publicKeyBase64).toBeDefined();
    expect(bobKeys.publicKeyBase64).toBeDefined();
    expect(aliceKeys.publicKeyBase64).not.toBe(bobKeys.publicKeyBase64);

    const secretMessage = 'Secret E2EE conversation between Alice and Bob';

    // Alice encrypts for Bob
    const encrypted = await alice.encrypt(secretMessage, bobKeys.publicKeyBase64);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.nonce).toBeDefined();
    expect(encrypted.ciphertext).not.toBe(secretMessage);

    // Bob decrypts from Alice
    const decrypted = await bob.decrypt(encrypted.ciphertext, encrypted.nonce, aliceKeys.publicKeyBase64);
    expect(decrypted).toBe(secretMessage);
  });

  it('binds Authenticated Associated Data (AAD) and rejects ciphertext replayed into a different conversation', async () => {
    const alice = new ClientCryptoEngine();
    const bob = new ClientCryptoEngine();

    const aliceKeys = await alice.getOrCreateDeviceKeyPair();
    const bobKeys = await bob.getOrCreateDeviceKeyPair();

    const convA = 'conversation-alpha-001';
    const convB = 'conversation-bravo-002';
    const secret = 'Private financial transfer instruction';

    // Alice encrypts with convA bound as AAD
    const encrypted = await alice.encrypt(secret, bobKeys.publicKeyBase64, convA);

    // Bob decrypts with matching convA: SUCCESS
    const decrypted = await bob.decrypt(encrypted.ciphertext, encrypted.nonce, aliceKeys.publicKeyBase64, convA);
    expect(decrypted).toBe(secret);

    // Attacker tries to inject or replay ciphertext into convB: REJECTED by AES-GCM
    await expect(
      bob.decrypt(encrypted.ciphertext, encrypted.nonce, aliceKeys.publicKeyBase64, convB)
    ).rejects.toThrow();

    // Attacker strips AAD: REJECTED by AES-GCM
    await expect(
      bob.decrypt(encrypted.ciphertext, encrypted.nonce, aliceKeys.publicKeyBase64)
    ).rejects.toThrow();
  });

  it('computes deterministic, symmetrical safety numbers for identity verification', async () => {
    const alice = new ClientCryptoEngine();
    const bob = new ClientCryptoEngine();
    const eve = new ClientCryptoEngine();

    const aliceKeys = await alice.getOrCreateDeviceKeyPair();
    const bobKeys = await bob.getOrCreateDeviceKeyPair();
    const eveKeys = await eve.getOrCreateDeviceKeyPair();

    // Symmetrical: Alice and Bob see the exact same safety number
    const safetyNumberAliceView = await computeSafetyNumber(aliceKeys.publicKeyBase64, bobKeys.publicKeyBase64);
    const safetyNumberBobView = await computeSafetyNumber(bobKeys.publicKeyBase64, aliceKeys.publicKeyBase64);

    expect(safetyNumberAliceView).toBe(safetyNumberBobView);
    expect(safetyNumberAliceView).toMatch(/^\d{5} \d{5} \d{5} \d{5} \d{5} \d{5}$/);

    // Distinct: An adversary (Eve) substituted key produces a completely different safety number
    const safetyNumberWithEve = await computeSafetyNumber(aliceKeys.publicKeyBase64, eveKeys.publicKeyBase64);
    expect(safetyNumberWithEve).not.toBe(safetyNumberAliceView);
  });

  it('generates unique nonces for identical plaintexts to prevent IV reuse', async () => {
    const alice = new ClientCryptoEngine();
    const bob = new ClientCryptoEngine();
    const bobKeys = await bob.getOrCreateDeviceKeyPair();

    const payload = 'Repeat message payload';
    const enc1 = await alice.encrypt(payload, bobKeys.publicKeyBase64);
    const enc2 = await alice.encrypt(payload, bobKeys.publicKeyBase64);

    expect(enc1.nonce).not.toBe(enc2.nonce);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it('negative test: rejects tampered ciphertext (AES-GCM authentication tag failure)', async () => {
    const alice = new ClientCryptoEngine();
    const bob = new ClientCryptoEngine();

    const aliceKeys = await alice.getOrCreateDeviceKeyPair();
    const bobKeys = await bob.getOrCreateDeviceKeyPair();

    const secretMessage = 'Confidential financial transaction';
    const encrypted = await alice.encrypt(secretMessage, bobKeys.publicKeyBase64);

    // Attacker modifies a byte in the base64 ciphertext
    const rawCiphertext = base64ToBuffer(encrypted.ciphertext);
    rawCiphertext[0] ^= 0xff; // Flip bits
    const tamperedCiphertext = bufferToBase64(rawCiphertext.buffer as ArrayBuffer);

    // Decryption must throw an error due to tag mismatch
    await expect(
      bob.decrypt(tamperedCiphertext, encrypted.nonce, aliceKeys.publicKeyBase64)
    ).rejects.toThrow();
  });

  it('negative test: rejects tampered nonce (IV manipulation)', async () => {
    const alice = new ClientCryptoEngine();
    const bob = new ClientCryptoEngine();

    const aliceKeys = await alice.getOrCreateDeviceKeyPair();
    const bobKeys = await bob.getOrCreateDeviceKeyPair();

    const secretMessage = 'Top secret command';
    const encrypted = await alice.encrypt(secretMessage, bobKeys.publicKeyBase64);

    // Attacker modifies nonce
    const rawNonce = base64ToBuffer(encrypted.nonce);
    rawNonce[1] ^= 0xaa;
    const tamperedNonce = bufferToBase64(rawNonce.buffer as ArrayBuffer);

    await expect(
      bob.decrypt(encrypted.ciphertext, tamperedNonce, aliceKeys.publicKeyBase64)
    ).rejects.toThrow();
  });

  it('negative test: rejects decryption with wrong peer key (unauthorized third-party)', async () => {
    const alice = new ClientCryptoEngine();
    const bob = new ClientCryptoEngine();
    const eve = new ClientCryptoEngine();

    const aliceKeys = await alice.getOrCreateDeviceKeyPair();
    const bobKeys = await bob.getOrCreateDeviceKeyPair();
    await eve.getOrCreateDeviceKeyPair();

    // Alice encrypts for Bob
    const encrypted = await alice.encrypt('Classified payload', bobKeys.publicKeyBase64);

    // Eve attempts to decrypt with Alice's public key (Eve's shared key is different)
    await expect(
      eve.decrypt(encrypted.ciphertext, encrypted.nonce, aliceKeys.publicKeyBase64)
    ).rejects.toThrow();
  });

  it('negative test: rejects malformed public key on import', async () => {
    const alice = new ClientCryptoEngine();
    await expect(
      alice.importPeerPublicKey('not-a-valid-spki-key-base64')
    ).rejects.toThrow();
  });

  it('resets in-memory key cache cleanly without cross-session contamination', async () => {
    const engine = new ClientCryptoEngine();
    const keyPair1 = await engine.getOrCreateDeviceKeyPair();
    expect(keyPair1.publicKeyBase64).toBeDefined();

    // Reset cache
    engine.resetCache();

    // In a test environment without IndexedDB, resetCache() clears memory, allowing fresh key generation
    const keyPair2 = await engine.getOrCreateDeviceKeyPair();
    expect(keyPair2.publicKeyBase64).toBeDefined();
  });

  it('negative test: rejects tampered Authenticated Associated Data (AAD)', async () => {
    const alice = new ClientCryptoEngine();
    const bob = new ClientCryptoEngine();

    const aliceKeys = await alice.getOrCreateDeviceKeyPair();
    const bobKeys = await bob.getOrCreateDeviceKeyPair();

    const text = 'Confidential bank transfer authorization';
    const originalAAD = 'conv_secure_100';
    const encrypted = await alice.encrypt(text, bobKeys.publicKeyBase64, originalAAD);

    // Decrypt with altered AAD (e.g. injected into a different conversation)
    await expect(
      bob.decrypt(encrypted.ciphertext, encrypted.nonce, aliceKeys.publicKeyBase64, 'conv_malicious_999')
    ).rejects.toThrow();
  });

  it('enforces canonical domain-separated AAD and supports fallback decryption of legacy raw AAD', async () => {
    const alice = new ClientCryptoEngine();
    const bob = new ClientCryptoEngine();

    const aliceKeys = await alice.getOrCreateDeviceKeyPair();
    const bobKeys = await bob.getOrCreateDeviceKeyPair();

    const convId = 'conv_migration_test_42';
    const message = 'Message tested across canonical and legacy AAD boundaries';

    // 1. Encrypt with canonical AAD (default when string is passed)
    const canonicalEncrypted = await alice.encrypt(message, bobKeys.publicKeyBase64, convId);
    // Bob decrypts with convId (transparently uses canonical AAD): SUCCESS
    const decrypted1 = await bob.decrypt(canonicalEncrypted.ciphertext, canonicalEncrypted.nonce, aliceKeys.publicKeyBase64, convId);
    expect(decrypted1).toBe(message);

    // 2. Encrypt with explicit legacy raw AAD bytes (simulating Phase 2 ciphertext)
    const rawLegacyAAD = new TextEncoder().encode(convId);
    const legacyEncrypted = await alice.encrypt(message, bobKeys.publicKeyBase64, rawLegacyAAD);
    // Bob decrypts with convId string: should fallback to raw string AAD and succeed!
    const decrypted2 = await bob.decrypt(legacyEncrypted.ciphertext, legacyEncrypted.nonce, aliceKeys.publicKeyBase64, convId);
    expect(decrypted2).toBe(message);
  });

  it('verifies buildCanonicalAAD constructs collision-resistant framing', () => {
    const aad1 = buildCanonicalAAD('123', 1);
    const aad2 = buildCanonicalAAD('123', 2);
    const aad3 = buildCanonicalAAD('1234', 1);

    const str1 = new TextDecoder().decode(aad1);
    const str2 = new TextDecoder().decode(aad2);
    const str3 = new TextDecoder().decode(aad3);

    expect(str1).toBe('nexachat:v1:conv:123');
    expect(str2).toBe('nexachat:v2:conv:123');
    expect(str3).toBe('nexachat:v1:conv:1234');
    expect(str1).not.toBe(str2);
    expect(str1).not.toBe(str3);
  });

  describe('Multi-Device E2EE Fan-Out and Consistency', () => {
    it('executes 4-device pairwise fan-out encryption and verifies all authorized devices decrypt independently', async () => {
      // Setup 4 distinct client engines representing:
      // Alice Device 1 (laptop - sender)
      // Alice Device 2 (phone - recipient of own history)
      // Bob Device 1 (desktop - primary recipient)
      // Bob Device 2 (tablet - secondary recipient)
      // Eve Device 1 (attacker - unauthorized)
      const aliceD1 = new ClientCryptoEngine();
      const aliceD2 = new ClientCryptoEngine();
      const bobD1 = new ClientCryptoEngine();
      const bobD2 = new ClientCryptoEngine();
      const eveD1 = new ClientCryptoEngine();

      const kAliceD1 = await aliceD1.getOrCreateDeviceKeyPair();
      const kAliceD2 = await aliceD2.getOrCreateDeviceKeyPair();
      const kBobD1 = await bobD1.getOrCreateDeviceKeyPair();
      const kBobD2 = await bobD2.getOrCreateDeviceKeyPair();
      await eveD1.getOrCreateDeviceKeyPair();

      const targets = [
        { deviceId: 'dev_alice_2', publicKeyBase64: kAliceD2.publicKeyBase64 },
        { deviceId: 'dev_bob_1', publicKeyBase64: kBobD1.publicKeyBase64 },
        { deviceId: 'dev_bob_2', publicKeyBase64: kBobD2.publicKeyBase64 },
      ];

      const secretText = 'Cross-device E2EE broadcast to all authorized recipient endpoints';
      const convId = 'conv_multidevice_42';

      // Alice D1 encrypts for all targets
      const encrypted = await aliceD1.encryptMultiDevice(
        secretText,
        targets,
        'dev_alice_1',
        convId
      );

      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.nonce).toBe('multidevice');
      expect(encrypted.envelope.v).toBe(1);
      expect(encrypted.envelope.sender_device_id).toBe('dev_alice_1');
      expect(Object.keys(encrypted.envelope.devices)).toHaveLength(3);

      // 1. Bob D1 decrypts using his device ID: SUCCESS
      const decBobD1 = await bobD1.decryptMultiDevice(
        encrypted.ciphertext,
        encrypted.nonce,
        kAliceD1.publicKeyBase64,
        'dev_bob_1',
        convId
      );
      expect(decBobD1).toBe(secretText);

      // 2. Bob D2 decrypts using his device ID: SUCCESS
      const decBobD2 = await bobD2.decryptMultiDevice(
        encrypted.ciphertext,
        encrypted.nonce,
        kAliceD1.publicKeyBase64,
        'dev_bob_2',
        convId
      );
      expect(decBobD2).toBe(secretText);

      // 3. Alice D2 (sender's other device) decrypts to sync sent history: SUCCESS
      const decAliceD2 = await aliceD2.decryptMultiDevice(
        encrypted.ciphertext,
        encrypted.nonce,
        kAliceD1.publicKeyBase64,
        'dev_alice_2',
        convId
      );
      expect(decAliceD2).toBe(secretText);

      // 4. Eve D1 (unauthorized device) has no entry in the envelope: REJECTED
      await expect(
        eveD1.decryptMultiDevice(
          encrypted.ciphertext,
          encrypted.nonce,
          kAliceD1.publicKeyBase64,
          'dev_eve_1',
          convId
        )
      ).rejects.toThrow(/Multi-device envelope has no ciphertext for device dev_eve_1/);

      // 5. Eve D1 attempts to decrypt Bob's entry using Eve's private key: TAG MISMATCH
      await expect(
        eveD1.decrypt(
          encrypted.envelope.devices['dev_bob_1'].ciphertext,
          encrypted.envelope.devices['dev_bob_1'].nonce,
          kAliceD1.publicKeyBase64,
          convId
        )
      ).rejects.toThrow();
    });

    it('gracefully falls back to legacy single-device decryption when given legacy ciphertext', async () => {
      const alice = new ClientCryptoEngine();
      const bob = new ClientCryptoEngine();

      const kAlice = await alice.getOrCreateDeviceKeyPair();
      const kBob = await bob.getOrCreateDeviceKeyPair();

      const legacyMessage = 'Legacy encrypted message from earlier version';
      const convId = 'conv_legacy_fallback';

      // Alice uses single-device encrypt
      const legacyEnc = await alice.encrypt(legacyMessage, kBob.publicKeyBase64, convId);

      // Bob uses decryptMultiDevice: transparently falls back to single-device decrypt
      const dec = await bob.decryptMultiDevice(
        legacyEnc.ciphertext,
        legacyEnc.nonce,
        kAlice.publicKeyBase64,
        'dev_bob_1',
        convId
      );
      expect(dec).toBe(legacyMessage);
    });

    it('detects server-side device key substitution (MITM attack detection)', () => {
      const known = {
        'dev_bob_1': 'valid_public_key_abc123',
        'dev_bob_2': 'valid_public_key_xyz789',
      };

      // 1. Normal state: consistent
      const res1 = verifyDeviceKeyList(known, [
        { device_id: 'dev_bob_1', identity_public_key: 'valid_public_key_abc123' },
        { device_id: 'dev_bob_2', identity_public_key: 'valid_public_key_xyz789' },
      ]);
      expect(res1.isConsistent).toBe(true);
      expect(res1.hasSubstitutions).toBe(false);
      expect(res1.newDevices).toHaveLength(0);
      expect(res1.removedDevices).toHaveLength(0);

      // 2. Newly added device (e.g. Bob logged in on dev_bob_3)
      const res2 = verifyDeviceKeyList(known, [
        { device_id: 'dev_bob_1', identity_public_key: 'valid_public_key_abc123' },
        { device_id: 'dev_bob_2', identity_public_key: 'valid_public_key_xyz789' },
        { device_id: 'dev_bob_3', identity_public_key: 'new_device_key_456' },
      ]);
      expect(res2.isConsistent).toBe(true);
      expect(res2.newDevices).toEqual(['dev_bob_3']);

      // 3. Removed device (e.g. dev_bob_2 was revoked)
      const res3 = verifyDeviceKeyList(known, [
        { device_id: 'dev_bob_1', identity_public_key: 'valid_public_key_abc123' },
      ]);
      expect(res3.removedDevices).toEqual(['dev_bob_2']);

      // 4. Key Substitution attack (malicious server changed dev_bob_1's key)
      const res4 = verifyDeviceKeyList(known, [
        { device_id: 'dev_bob_1', identity_public_key: 'MALICIOUS_SUBSTITUTED_KEY' },
        { device_id: 'dev_bob_2', identity_public_key: 'valid_public_key_xyz789' },
      ]);
      expect(res4.isConsistent).toBe(false);
      expect(res4.hasSubstitutions).toBe(true);
      expect(res4.substitutedDevices).toHaveLength(1);
      expect(res4.substitutedDevices[0].deviceId).toBe('dev_bob_1');
    });
  });
});


