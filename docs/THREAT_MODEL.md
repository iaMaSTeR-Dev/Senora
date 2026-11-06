# COMPREHENSIVE THREAT MODEL — SENORA

**Status**: ACTIVE  
**Last Updated**: 2026-10-11  
**Target Architecture**: Senora Monolith, Web Crypto E2EE Client, SQLite / PostgreSQL 16  
**Audience**: Security Auditors, Cryptographers, and Core Engineering  

---

## 1. System Overview & Trust Boundaries

```text
+-------------------------------------------------------------------------------+
| CLIENT TIER: Web Browser Environment (User Device)                           |
|                                                                               |
|  +--------------------+    +--------------------+    +--------------------+   |
|  | React SPA & UI     |--->| Web Crypto Subtle  |--->| IndexedDB Storage  |   |
|  | Plaintext in React |    | NIST P-256 / AES   |    | Non-extractable    |   |
|  | Component State    |    | GCM / HKDF         |    | CryptoKey Objects  |   |
|  +--------------------+    +--------------------+    +--------------------+   |
+-------------------------------------------------------------------------------+
                                  |
               [TRUST BOUNDARY 1: TLS 1.3 / WSS Transport]
                                  |
                                  v
+-------------------------------------------------------------------------------+
| EDGE & NETWORK TIER: Reverse Proxy (Caddy / Nginx)                            |
|                                                                               |
|  - TLS Termination & HTTPS enforcement                                        |
|  - Static Asset Delivery with Content Security Policy (CSP)                   |
|  - HTTP / WebSocket Request Routing                                          |
+-------------------------------------------------------------------------------+
                                  |
            [TRUST BOUNDARY 2: Reverse Proxy Internal Network]
                                  |
                                  v
+-------------------------------------------------------------------------------+
| APPLICATION SERVER TIER: Go Modular Monolith (UNTRUSTED FOR E2EE CONTENT)    |
|                                                                               |
|  - Authentication & Session Verification (Argon2id, 256-bit Tokens)           |
|  - Rate Limiting Middleware (IP and User sliding window)                      |
|  - BOLA Authorization Checks (Conversation Membership)                       |
|  - Transactional Outbox & Event Streaming Engine                              |
|  - Public Key Package Registry (Only handles public key material)             |
+-------------------------------------------------------------------------------+
                                  |
              [TRUST BOUNDARY 3: Database Connection / Wire]
                                  |
                                  v
+-------------------------------------------------------------------------------+
| STORAGE TIER: PostgreSQL 16 / SQLite Database (UNTRUSTED FOR E2EE CONTENT)    |
|                                                                               |
|  - User Credentials (Argon2id hashes)                                         |
|  - Session Tokens (Cryptographically random tokens)                           |
|  - Conversation Membership Mappings                                           |
|  - Ciphertext Envelopes & Nonces (ZERO Plaintext Messages)                     |
|  - Outbox Events for Cursor Sync                                              |
+-------------------------------------------------------------------------------+
```

---

## 2. Protected Assets

| Asset ID | Asset Description | Security Objective | Primary Defense |
|---|---|---|---|
| **A-1** | Message Plaintext Content | **Confidentiality** | Client-side AES-256-GCM encryption before network transmission; server persists only ciphertexts and nonces. |
| **A-2** | Device Private Keys | **Confidentiality & Integrity** | Generated in client browser; stored as non-extractable `CryptoKey` in IndexedDB. Never transmitted over network or logged. |
| **A-3** | User Passwords | **Confidentiality** | Client-to-server TLS; hashed on server using Argon2id ($m=64\text{MB}, t=3, p=1$). |
| **A-4** | Session Authentication Tokens | **Confidentiality & Integrity** | 256-bit CSPRNG tokens; validated on every request; server-side revocable via `POST /api/v1/auth/logout`. |
| **A-5** | Conversation Membership & Graph | **Integrity & Authorization** | Strict server-side authorization (BOLA defense). Non-members cannot view messages, join conversations, or receive real-time events. |
| **A-6** | Message Ordering & Authenticity | **Integrity & Authenticity** | AES-256-GCM authentication tags with Authenticated Associated Data (AAD); monotonic outbox IDs. |

---

## 3. Threat Actors & Attacker Capabilities

### T-1: Passive Network Eavesdropper
* **Capabilities**: Observes network traffic between client browser and server (ISP, coffee shop Wi-Fi).
* **Mitigation**: TLS 1.3 transport encryption. Even in the event of TLS compromise, message contents remain encrypted via Web Crypto AES-256-GCM.

### T-2: Compromised Infrastructure / Malicious Database Administrator
* **Capabilities**: Root access to PostgreSQL database and server host. Can read all database rows, query logs, and file system.
* **Mitigation**: **Zero Plaintext Invariant**. Database contains only base64 ciphertexts, nonces, and Argon2id password hashes. Private keys never touch server storage.

### T-3: Active Malicious Server (Man-in-the-Middle on Keys)
* **Capabilities**: Rogue server attempts to replace Bob's public key with Mallory's public key when Alice queries `/api/v1/crypto/keys/{bobId}`.
* **Mitigation**: **Symmetric Safety Numbers**. Both users independently compute and display a 30-digit SHA-256 fingerprint of their combined identity keys. If the server substitutes a key, the safety numbers will not match, alerting the users during out-of-band verification. An in-app alert flags key changes.

### T-4: Malicious Authenticated Tenant (Broken Object-Level Authorization - BOLA)
* **Capabilities**: Registered user calling REST API endpoints attempting to view messages from conversations they are not invited to.
* **Mitigation**: Backend `IsMember` checks enforced on every database query. Foreign conversation access returns HTTP 403 Forbidden.

### T-5: Cross-Site WebSocket Hijacker (CSWSH)
* **Capabilities**: Attacker lures an authenticated user to visit `https://evil-site.com`, which attempts to establish a WebSocket connection to the user's Senora instance.
* **Mitigation**: Strict RFC 3986 URL origin validation in `upgrader.CheckOrigin`. Exact hostname matching blocks untrusted external domains and prefix bypasses (e.g. `localhost.attacker.com`).

### T-6: Denial of Service / Resource Exhaustion Attacker
* **Capabilities**: Sends gigabyte-sized JSON payloads or millions of login requests to exhaust memory/CPU.
* **Mitigation**: `http.MaxBytesReader` limits JSON bodies to 1 MB. Sliding-window `RateLimiter` restricts authentication attempts to 10 req/min per IP and general API to 120 req/min.

---

## 4. Specific Attack Surface Analysis

### 4.1 Browser Sandbox & Client-Side Risks
* **Cross-Site Scripting (XSS)**: If an attacker achieves arbitrary JavaScript execution in the Senora browser origin, non-extractable `CryptoKey` objects cannot be read directly via `exportKey()`, but the malicious script could still invoke `subtle.decrypt()` or read plaintexts in React component memory.
  - *Defense*: Strict Content Security Policy (`CSP`), zero `dangerouslySetInnerHTML`, sanitized inputs, and no third-party CDN scripts.
* **Device Loss / Physical Theft**: If an adversary acquires an unlocked device, they can read local IndexedDB records.
  - *Defense*: Users can remotely revoke sessions from another device; full-disk encryption recommended on user endpoints.

### 4.2 Server-Visible Metadata
The following metadata is unavoidably visible to the server operator:
- Sender User ID and Device ID
- Recipient User ID / Conversation ID
- Message Timestamp (server creation time)
- Ciphertext byte length (approximate plaintext length, mitigated by optional padding)
- User IP address and user-agent string

### 4.3 Forward Secrecy & Post-Compromise Security
- **Current Live Web Crypto Baseline**: Static-static ECDH P-256 + AES-256-GCM. Does NOT provide per-message forward secrecy. Device private key compromise compromises past traffic.
- **Verified Protocol Ratchet Engine**: `@privacyresearch/libsignal-protocol-typescript` integration suite (`apps/web/src/crypto/signalProtocol.test.ts`) verifies X3DH authenticated session setup, per-message KDF ratchets (FS), per-reply DH ratchets (PCS), and out-of-order replay rejection across 7 automated test vectors.

### 4.4 Multi-Device Trust Model & Device-List Consistency
- **Pairwise Fan-Out**: Senders encrypt individually for each authorized device of all participants plus the sender's own companion devices.
- **Server Blindness**: The server receives only the multi-device ciphertext envelope (`MultiDeviceEnvelope`). It possesses zero private keys and cannot decrypt any device entry.
- **Device Substitution Detection**: Clients maintain locally cached maps of known device identity keys. The `verifyDeviceKeyList` algorithm flags unexpected key changes or additions, triggering an explicit security alert banner.
- **Device Revocation**: When a device session is logged out or revoked, the server removes its device record from the active key bundle. Subsequent fan-out messages stop encrypting for that device ID.

### 4.5 Taxonomy of Replay & Deduplication Defenses
Senora strictly distinguishes between five distinct layers of replay defense:
1. **HTTP Request Idempotency**: Client-supplied `idempotency_key` ensures retried network requests return the originally created message object without duplicate database inserts.
2. **Database Duplicate Prevention**: Scoped composite unique index `UNIQUE(conversation_id, sender_id, idempotency_key)` prevents one user from discovering or collision-hijacking another user's idempotency key.
3. **Transport Delivery Ordering**: The transactional outbox assigns monotonic integer sequence IDs (`outbox.id`), ensuring clients receive real-time and backfilled messages strictly in monotonic causal order.
4. **Cryptographic Context Replay Defense**: Canonical Authenticated Associated Data (`senora:v1:conv:<id>`) is bound directly into the AES-256-GCM authentication tag. Replaying a ciphertext into a different conversation fails tag verification immediately.
5. **Protocol Ratchet Replay Defense**: In the Signal Protocol engine, each message key is deleted immediately upon consumption. Replaying an already-decrypted ciphertext throws an error.

---

## 5. Explicitly Excluded Threats

1. **Hardware / OS Compromise of Endpoint**: If an attacker installs a kernel-level keylogger or malware on the user's laptop/phone, cryptographic client protections cannot protect plaintext displayed on screen.
2. **Subpoena of Server-Visible Metadata**: The server cannot protect metadata it must process for routing (e.g. participant IDs, IP addresses, message size).
3. **User Failure to Compare Safety Numbers**: If users ignore "Key Changed!" warnings and fail to verify safety numbers out-of-band, active server MITM key substitution cannot be mathematically prevented by symmetric ECDH alone.
