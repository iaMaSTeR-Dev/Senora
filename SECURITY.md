# Security Policy & Standards — Senora

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

Security is a core design pillar of **Senora**. If you discover a potential vulnerability, please report it responsibly:

1. **GitHub Security Advisory**: Open a private draft security advisory directly through the repository's **Security** tab using GitHub's **Report a vulnerability** feature.
2. **Do Not File Public Issues**: Please avoid creating public GitHub issues, discussions, or pull requests for uncoordinated security vulnerabilities.
3. **Include Reproduction Steps**: Provide a detailed description, affected component (e.g. Server REST handler, WebSocket Hub, Signal Double Ratchet crypto, IndexedDB storage), reproduction steps, and potential impact.

The maintainers will review the report, verify the issue, coordinate a fix, and release a security advisory upon resolution.

---

## Technical Security Standards & Practices

### 1. Password Storage & Authentication
- **Hashing Algorithm**: Argon2id (`golang.org/x/crypto/argon2`).
- **Parameters**:
  - Memory: 64 MB (65,536 KiB)
  - Iterations: 3 passes
  - Parallelism: 2 threads
  - Salt: 16 bytes of cryptographically secure random bytes from `crypto/rand`
- **Session Tokens**: 32 bytes (256 bits) of entropy, base64url encoded. Stored hashed or indexed in session store with explicit expiration timestamps.

---

### 2. Cryptographic Standards (Client E2EE)
- **Key Agreement**: ECDH over NIST P-256 (`secp256r1`) via Web Crypto API.
- **Key Derivation**: HKDF-SHA256 (`HKDF-Expand` and `HKDF-Extract`) with conversation-specific context strings (`"Senora-E2EE-v1"`).
- **Symmetric Encryption**: AES-256-GCM with:
  - 256-bit derived key
  - 96-bit (12 bytes) fresh random initialization vector (IV) per message
  - 128-bit authentication tag
- **Storage of Private Keys**: Kept exclusively in client-side non-extractable IndexedDB via `SubtleCrypto`. Never transmitted over network or serialized to localStorage.

---

### 3. Server Authorization Invariants
1. **Strict Context Enforcement**: Handlers extract `UserID` directly from verified session claims and never trust a `user_id` or `sender_id` provided in the HTTP request body.
2. **Conversation Access Control**: Every fetch, post, or update to a conversation verifies membership via database constraints before proceeding.
3. **Auditability**: Administrative and security events (login failures, device revocation, password changes) generate structured audit logs.

---

### 4. Input Validation & Content Security
- **Payload Size Limits**: JSON requests maximum 1MB; WebSocket frames maximum 64KB per text envelope.
- **Content Security Policy (CSP)**: Restricts script execution to same origin (`'self'`), disallowing `unsafe-inline` and `unsafe-eval`.
- **Cross-Site Request Forgery (CSRF)**: Custom header validation (`X-Requested-With` or `X-Senora-Client: true`) for API endpoints.

