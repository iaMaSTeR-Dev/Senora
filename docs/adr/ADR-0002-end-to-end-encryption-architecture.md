# ADR-0002: End-to-End Encryption (E2EE) Architecture

## Status
Accepted

## Context
E2EE is a fundamental release blocker. Unencrypted message content must never reach or be stored on the server. The solution must run natively in modern web browsers without requiring unreviewed proprietary native binaries.

## Decision
1. **Cryptographic Primitives**:
   - Asymmetric: NIST P-256 (`secp256r1`) Elliptic Curve Diffie-Hellman (ECDH) via standard browser `window.crypto.subtle`.
   - Key Derivation: HKDF-SHA256 deriving symmetric encryption keys from ECDH shared secrets.
   - Symmetric: AES-256-GCM with fresh 96-bit (12-byte) initialization vectors (IVs) and 128-bit authentication tags.
2. **Key Storage**:
   - Device identity private keys are kept in non-extractable client IndexedDB storage.
   - Public keys and one-time pre-keys are published to `/api/v1/crypto/keys`.
3. **Server Role**:
   - The server acts as a blind mailbox and synchronization engine. It stores solely ciphertext blobs, IVs, sender/recipient device IDs, and event timestamps.

## Consequences
- Complete zero-knowledge payload privacy on the backend.
- Full hardware-accelerated encryption in the browser with zero external heavy wasm dependencies.
- Tamper detection is mathematically guaranteed by AES-GCM's authentication tag.
