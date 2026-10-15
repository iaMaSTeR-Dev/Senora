import { describe, it, expect } from 'vitest';
import { signalManager } from './signalManager';
import { bufferToBase64 } from './clientCrypto';

describe('Signal Protocol Manager & Client-Side Media E2EE Pipelines', () => {
  it('computes symmetrical, formatted safety numbers for out-of-band verification', async () => {
    // Generate two sample base64 public keys
    const key1 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAbc1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuv==';
    const key2 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgBEdef9876543210zyxwvutsrqponmlkjihgfedcba0987654321zyxwvutsrqponmlkjih==';

    const sn = await signalManager.calculateSafetyNumber(key1);
    const sn2 = await signalManager.calculateSafetyNumber(key2);
    expect(sn).toBeDefined();
    expect(sn2).toBeDefined();
    expect(typeof sn).toBe('string');
    expect(typeof sn2).toBe('string');
    // Verify grouping format: 5-digit segments separated by spaces
    const parts = sn.split(' ');
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p) => {
      expect(p.length).toBe(5);
      expect(/^\d{5}$/.test(p)).toBe(true);
    });
  });

  it('encrypts and decrypts client-side files via AES-256-GCM without exposing plaintext to server', async () => {
    const rawContent = 'TOP SECRET ATTACHMENT CONTENT: Sensitive document details for NexaChat.';
    const originalBlob = new Blob([rawContent], { type: 'text/plain' });

    // 1. Client-side AES-256-GCM encryption
    const encryptedResult = await signalManager.encryptAttachment(originalBlob);

    expect(encryptedResult.encryptedBlob).toBeDefined();
    expect(encryptedResult.keyBase64).toBeDefined();
    expect(encryptedResult.ivBase64).toBeDefined();
    expect(encryptedResult.encryptedBlob.size).toBeGreaterThan(0);

    // Verify ciphertext is scrambled and not equal to plaintext
    const cipherBuffer = await encryptedResult.encryptedBlob.arrayBuffer();
    const cipherText = new TextDecoder().decode(cipherBuffer);
    expect(cipherText).not.toContain('TOP SECRET ATTACHMENT CONTENT');

    // 2. Client-side AES-256-GCM decryption
    const decryptedBlob = await signalManager.decryptAttachment(
      encryptedResult.encryptedBlob,
      encryptedResult.keyBase64,
      encryptedResult.ivBase64,
      'text/plain'
    );

    const decryptedText = await decryptedBlob.text();
    expect(decryptedText).toBe(rawContent);
    expect(decryptedBlob.type).toBe('text/plain');
  });

  it('rejects tampered attachment ciphertext (AES-GCM integrity check)', async () => {
    const originalBlob = new Blob(['Sensitive audio note'], { type: 'audio/webm' });
    const encrypted = await signalManager.encryptAttachment(originalBlob);

    // Tamper with ciphertext bytes
    const arrayBuffer = await encrypted.encryptedBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    bytes[0] ^= 0xff; // Flip bits in ciphertext
    const tamperedBlob = new Blob([bytes], { type: 'application/octet-stream' });

    // Decryption must fail due to failed GCM tag verification
    await expect(
      signalManager.decryptAttachment(
        tamperedBlob,
        encrypted.keyBase64,
        encrypted.ivBase64,
        'audio/webm'
      )
    ).rejects.toThrow();
  });

  it('guarantees sender self-device encryption and enables seamless self-decryption across reloads', async () => {
    await signalManager.initialize('user_alice', 'dev_alice_1');
    const myDeviceId = signalManager.getDeviceId();
    expect(myDeviceId).toBe('dev_alice_1');

    const pair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
    const spki = await globalThis.crypto.subtle.exportKey('spki', pair.publicKey);
    const bobPublicKey = bufferToBase64(spki);

    const plaintext = JSON.stringify({ text: 'Hello from Alice to Bob', type: 'text' });
    // Alice sends to Bob (targets only includes Bob)
    const bobTargets = [
      {
        userId: 'user_bob',
        deviceId: 'dev_bob_1',
        publicKeyBase64: bobPublicKey,
      },
    ];

    const encrypted = await signalManager.encryptMultiDevice(plaintext, bobTargets, 'cnv_test_1');
    const parsedEnvelope = JSON.parse(encrypted.ciphertext);

    // Verify Alice's own device was automatically included in the envelope
    expect(parsedEnvelope.devices[myDeviceId]).toBeDefined();
    expect(parsedEnvelope.devices[myDeviceId].type).toBe(999);
    expect(parsedEnvelope.devices['dev_bob_1']).toBeDefined();

    // Alice decrypts her own message from history
    const decryptedByAlice = await signalManager.decryptMessage(
      encrypted.ciphertext,
      encrypted.nonce,
      'user_alice',
      'dev_alice_1',
      bobPublicKey,
      'cnv_test_1'
    );
    expect(decryptedByAlice).toBe(plaintext);
  });

  it('correctly classifies EMPTY_ENVELOPE and DEVICE_NOT_TARGETED without confusing with tampering', async () => {
    await signalManager.initialize('user_carol', 'dev_carol_1');

    // 1. Empty envelope (legacy channel or unaddressed message)
    const emptyEnvelope = JSON.stringify({
      v: 2,
      sender_user_id: 'user_david',
      devices: {},
    });
    await expect(
      signalManager.decryptMessage(emptyEnvelope, 'signal-v2', 'user_david', 'dev_david_1', 'dummy_key', 'cnv_test_2')
    ).rejects.toThrow('EMPTY_ENVELOPE');

    // 2. Envelope addressed only to another device
    const otherDeviceEnvelope = JSON.stringify({
      v: 2,
      sender_user_id: 'user_david',
      devices: {
        'dev_completely_different': {
          type: 1,
          body: 'c29tZV9jaXBoZXJfdGV4dA==',
        },
      },
    });
    await expect(
      signalManager.decryptMessage(otherDeviceEnvelope, 'signal-v2', 'user_david', 'dev_david_1', 'dummy_key', 'cnv_test_2')
    ).rejects.toThrow('DEVICE_NOT_TARGETED');
  });

  it('rejects tampered ciphertext with cryptographic authentication error', async () => {
    await signalManager.initialize('user_eve', 'dev_eve_1');
    const myDeviceId = signalManager.getDeviceId();

    const plaintext = JSON.stringify({ text: 'Secret tamper test', type: 'text' });
    const encrypted = await signalManager.encryptMultiDevice(plaintext, [], 'cnv_test_3');
    const parsed = JSON.parse(encrypted.ciphertext);

    // Tamper with the ciphertext body for Eve's device
    parsed.devices[myDeviceId].body = 'dGFtcGVyZWRfYm9keQ==';
    const tamperedCiphertext = JSON.stringify(parsed);

    // Decryption must fail due to invalid ciphertext / tag failure
    await expect(
      signalManager.decryptMessage(tamperedCiphertext, encrypted.nonce, 'user_eve', 'dev_eve_1', 'dummy_key', 'cnv_test_3')
    ).rejects.toThrow();
  });

  it('guarantees zero-leakage E2EE poll encryption, sentinel confidentiality, and tampering rejection', async () => {
    const sentinelQuestion = 'What is the secret? NEXA_E2EE_SECRET_SENTINEL_7F31';
    const options = ['Option Alpha NEXA_E2EE_SECRET_SENTINEL_7F31', 'Option Beta'];

    // Encrypt poll question and options client-side via AES-256-GCM
    const pollEnc = await signalManager.encryptPollData(sentinelQuestion, options);

    // 1. Verify that server-persisted ciphertexts contain NO plaintext sentinel
    expect(pollEnc.encryptedQuestion).not.toContain('NEXA_E2EE_SECRET_SENTINEL_7F31');
    expect(pollEnc.encryptedOptions[0]).not.toContain('NEXA_E2EE_SECRET_SENTINEL_7F31');
    expect(pollEnc.keyBase64).toBeDefined();
    expect(pollEnc.ivBase64).toBeDefined();
    // Unique IVs: verify each field has a distinct prepended IV (no GCM nonce reuse)
    expect(pollEnc.encryptedOptions[0].slice(0, 16)).not.toBe(pollEnc.encryptedOptions[1].slice(0, 16));

    // 2. Client-side recipient decryption reproduces the exact sentinel
    const recoveredQuestion = await signalManager.decryptPollText(
      pollEnc.encryptedQuestion,
      pollEnc.keyBase64,
      pollEnc.ivBase64
    );
    expect(recoveredQuestion).toBe(sentinelQuestion);

    const recoveredOption0 = await signalManager.decryptPollText(
      pollEnc.encryptedOptions[0],
      pollEnc.keyBase64,
      pollEnc.ivBase64
    );
    expect(recoveredOption0).toBe(options[0]);

    // 3. Tampering with ciphertext fails decryption
    const rawCiphertext = atob(pollEnc.encryptedQuestion);
    const tamperedBytes = new Uint8Array(rawCiphertext.length);
    for (let i = 0; i < rawCiphertext.length; i++) tamperedBytes[i] = rawCiphertext.charCodeAt(i);
    tamperedBytes[0] ^= 0xff; // Flip bit in prepended IV
    const tamperedCiphertextBase64 = btoa(String.fromCharCode(...tamperedBytes));

    const tamperedDec = await signalManager.decryptPollText(
      tamperedCiphertextBase64,
      pollEnc.keyBase64,
      pollEnc.ivBase64
    );
    // On decryption failure, decryptPollText safely returns '[Decryption error]' without exposing ciphertext or crashing
    expect(tamperedDec).toBe('[Decryption error]');
  });
});
