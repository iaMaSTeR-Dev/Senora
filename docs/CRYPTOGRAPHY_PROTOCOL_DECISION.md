# ARCHITECTURAL DECISION RECORD: CRYPTOGRAPHIC PROTOCOL EVOLUTION

**Status**: IMPLEMENTED & TESTED (Phase 4 Multi-Device Fan-Out Live, Signal Double Ratchet & X3DH Verified)
**Date**: 2026-10-11
**Authors**: Principal Software Architect, Senior Cryptography Integration Engineer, Application Security Architect
**Audience**: NexaChat Core Engineering & Independent Security Reviewers

---

## 1. Context & Existing Cryptographic Primitives

The baseline implementation of NexaChat provided initial browser-side End-to-End Encryption (E2EE) built on Web Crypto API (`window.crypto.subtle`):
- **Asymmetric Key Agreement**: Static-static ECDH over NIST P-256 (`secp256r1`).
- **Symmetric Encryption**: AES-256-GCM with fresh 96-bit CSPRNG IVs.
- **Context Binding**: Canonical Authenticated Associated Data (AAD) binding `conversation_id` (`nexachat:v1:conv:<id>`).
- **Identity Key Storage**: Non-extractable `CryptoKey` objects stored via Structured Cloning in browser IndexedDB (`nexachat_crypto_store`).
- **Identity Verification**: Symmetrical 30-digit Safety Numbers (`SHA-256(min(A,B) || ":" || max(A,B))`) formatted into 6 blocks of 5 digits.

---

## 2. Phase 4 Standardized Protocol Selection & Empirical Verification

In Phase 4, we evaluated and integrated `@privacyresearch/libsignal-protocol-typescript` (v0.0.16) to provide a standardized, battle-tested cryptographic ratcheting engine providing genuine **Forward Secrecy (FS)** and **Post-Compromise Security (PCS)**.

### Empirical Test Vectors & Verification Suite (`apps/web/src/crypto/signalProtocol.test.ts`)
Seven rigorous cryptographic unit and adversarial tests were implemented and verified with Vitest:
1. **Authenticated Session Establishment (X3DH)**: Verified identity key pair generation, registration IDs, pre-keys, and signed pre-keys. Alice establishes an initial session with Bob via `SessionBuilder.processPreKey` without interactive negotiation.
2. **Encryption & Decryption Roundtrip**: Alice encrypts an initial message (`PreKeyWhisperMessage`, type 3); Bob decrypts via `SessionCipher.decryptPreKeyWhisperMessage`.
3. **Consecutive Ratchet Steps (Double Ratchet)**: Bob's reply advances the Diffie-Hellman ratchet step, emitting a standard `WhisperMessage` (type 1) and establishing new root and chain keys. Alice and Bob execute multiple consecutive bidirectional ratchet steps.
4. **Protocol Replay Rejection**: Replaying an already-decrypted ciphertext to `SessionCipher` is rejected with an error; old message keys cannot be reused once consumed.
5. **Tamper Rejection**: Any bit modification to the encrypted message body fails protobuf parsing or HMAC authentication tag verification.
6. **Untrusted Identity Key Detection**: When `isTrustedIdentity` detects an unpinned or substituted peer identity key, session initiation aborts immediately with an error.
7. **Session Persistence & Restoration**: Exporting session state from store instance 1 and importing it into store instance 2 (simulating browser reload / tab resume) succeeds seamlessly across subsequent ratchet messages.
8. **Out-of-Order Message Handling**: When Alice sends messages M1, M2, M3 in sequence and Bob receives M3 before M1 and M2, Bob buffers skipped message keys, decrypts M3 immediately, and subsequently decrypts delayed messages M1 and M2.

---

## 3. Multi-Device Pairwise Fan-Out Architecture (Phase 4 Live Implementation)

To resolve the single-device limitation without exposing plaintext to the server, Phase 4 implemented **Pairwise Fan-Out Encryption** across all enrolled devices.

### Multi-Device Envelope Specification
```typescript
export interface DeviceCiphertext {
  ciphertext: string;
  nonce: string;
}

export interface MultiDeviceEnvelope {
  v: number;                         // 1
  sender_device_id: string;          // Originating device ID
  sender_public_key?: string;        // SPKI Base64 public key of originating device
  devices: Record<string, DeviceCiphertext>; // Map: target_device_id -> encrypted payload
}
```

### Properties Verified in Automated Scenarios:
1. **Multi-Recipient Delivery**: When Alice sends from Device A1, the payload is pairwise encrypted for:
   - Bob Device 1 (`dev_bob_1`)
   - Bob Device 2 (`dev_bob_2`)
   - Alice Device 2 (`dev_alice_2` — so Alice's sent history syncs across her own devices)
2. **Zero Plaintext on Server**: The server persists only the JSON envelope inside `ciphertext`. No plaintext ever reaches server memory or database logs.
3. **Session & Device Isolation**: Logging out from Device A1 revokes only Device A1's session; Device A2 remains authorized and functioning.
4. **Unauthorized Access Rejection**: An unauthorized third party (Eve) lacks a key in `envelope.devices` and cannot decrypt the message.
5. **Backward Compatibility**: If an incoming message is legacy single-device ciphertext, `decryptMultiDevice` automatically falls back to single-device decryption.
6. **Device-List Consistency (`verifyDeviceKeyList`)**: The client compares current server-returned devices against cached known devices, flagging newly added devices, removed devices, and detecting server-side key substitutions.

---

## 4. Architectural Summary

| Protocol Capability | Status | Implementation Mechanism |
|---|---|---|
| **Pairwise Multi-Device E2EE** | **LIVE & VERIFIED** | Web Crypto AES-256-GCM + Fan-Out Envelope (`clientCrypto.ts`) |
| **Backward Compatible Decryption** | **LIVE & VERIFIED** | Transparent fallback in `decryptMultiDevice` |
| **Device Consistency & MITM Alert** | **LIVE & VERIFIED** | `verifyDeviceKeyList` + Security Warning Banner |
| **Double Ratchet & X3DH Engine** | **VERIFIED (LIB CANDIDATE)** | `@privacyresearch/libsignal-protocol-typescript` (`signalProtocol.test.ts`) |
| **Symmetrical Safety Numbers** | **LIVE & VERIFIED** | 30-digit SHA-256 fingerprint (`computeSafetyNumber`) |
| **Group Chat Messaging (MLS)** | **DEFERRED (ROADMAP)** | RFC 9420 TreeKEM planned for Phase 5 |
