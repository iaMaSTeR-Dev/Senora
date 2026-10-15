# SECURITY POLICY & PRACTICES — Senora

## 1. Password Storage & Authentication

- **Hashing Algorithm**: Argon2id (`golang.org/x/crypto/argon2`).
- **Parameters**:
  - Memory: 64 MB (65,536 KiB)
  - Iterations: 3 passes
  - Parallelism: 2 threads
  - Salt: 16 bytes of cryptographically secure random bytes from `crypto/rand`
- **Session Tokens**: 32 bytes (256 bits) of entropy, base64url encoded. Stored hashed or indexed in session store with explicit expiration timestamps.

---

## 2. Cryptographic Standards (Client E2EE)

- **Key Agreement**: ECDH over NIST P-256 (`secp256r1`) via Web Crypto API.
- **Key Derivation**: HKDF-SHA256 (`HKDF-Expand` and `HKDF-Extract`) with conversation-specific context strings (`"NexaChat-E2EE-v1"`).
- **Symmetric Encryption**: AES-256-GCM with:
  - 256-bit derived key
  - 96-bit (12 bytes) fresh random initialization vector (IV) per message
  - 128-bit authentication tag
- **Storage of Private Keys**: Kept exclusively in client-side non-extractable IndexedDB via `SubtleCrypto`. Never transmitted over network or serialized to localStorage.

---

## 3. Server Authorization Invariants

1. **Strict Context Enforcement**:
   - Handlers extract `UserID` directly from verified session claims.
   - Handlers never trust a `user_id` or `sender_id` provided in the HTTP request body.
2. **Conversation Access Control**:
   - Every fetch, post, or update to a conversation verifies `EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2)`.
3. **Auditability**:
   - Administrative and security events (login failures, device revocation, password changes) generate structured audit logs.

---

## 4. Input Validation & Content Security

- **Payload Size Limits**:
  - JSON requests: Maximum 1MB.
  - WebSocket frames: Maximum 64KB per text envelope.
- **Content Security Policy (CSP)**:
  - Restricts script execution to same origin (`'self'`).
  - Disallows `unsafe-inline` and `unsafe-eval`.
- **Cross-Site Request Forgery (CSRF)**:
  - Custom header validation (`X-Requested-With` or `X-NexaChat-Client: true`) for API endpoints.
