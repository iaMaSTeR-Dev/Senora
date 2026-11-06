# ARCHITECTURE BLUEPRINT — Senora

## 1. System Overview

Senora is designed as a secure, high-throughput, self-hosted messaging platform with a modular monolith backend and a modern single-page client application.

```text
+---------------------------------------------------------------------------------+
|                                 CLIENT TIER                                     |
|  +---------------------------------------------------------------------------+  |
|  |                         React 19 + TypeScript SPA                         |  |
|  |  +---------------------+  +--------------------+  +--------------------+  |  |
|  |  |  Presentation Layer |  |   Zustand Store    |  |  TanStack Query    |  |  |
|  |  |  (Telegram UX)      |  |   (Session/UI)     |  |  (Server State)    |  |  |
|  |  +----------+----------+  +---------+----------+  +---------+----------+  |  |
|  |             |                       |                       |             |  |
|  |  +----------v-----------------------v-----------------------v----------+  |  |
|  |  |            Client Cryptography Engine (Web Crypto API)              |  |  |
|  |  |       ECDH P-256 Key Exchange / AES-256-GCM Payload Encryption       |  |  |
|  |  +----------------------------------+----------------------------------+  |  |
|  |                                     |                                     |  |
|  |  +----------------------------------v----------------------------------+  |  |
|  |  |           Protocol Transport (REST Fetcher & WS Manager)            |  |  |
|  |  +----------------------------------+----------------------------------+  |  |
|  +-------------------------------------|-------------------------------------+  |
+----------------------------------------|----------------------------------------+
                                         | HTTPS / WSS
+----------------------------------------|----------------------------------------+
|                                        v                                        |
|                          REVERSE PROXY (Caddy / Nginx)                          |
|                          TLS Termination & Static Cache                         |
|                                        |                                        |
+----------------------------------------|----------------------------------------+
                                         | HTTP / WS (Internal)
+----------------------------------------|----------------------------------------+
|                                 SERVER TIER                                     |
|  +-------------------------------------v-------------------------------------+  |
|  |                       Go Modular Monolith (Server)                        |  |
|  |                                                                           |  |
|  |  +------------------+  +-------------------+  +------------------------+  |  |
|  |  |   Auth Module    |  |  Identity Module  |  |   Conversations Mod    |  |  |
|  |  | (Argon2id, Sess) |  | (Users & Devices) |  | (Direct & Group chats) |  |  |
|  |  +--------+---------+  +---------+---------+  +-----------+------------+  |  |
|  |           |                      |                        |               |  |
|  |  +--------v---------+  +---------v---------+  +-----------v------------+  |  |
|  |  | Messages Module  |  |   Events & WS     |  |   Crypto Keys Mod      |  |  |
|  |  | (Idempotent msg) |  | (Outbox & Replay) |  |  (Public Key Registry) |  |  |
|  |  +--------+---------+  +---------+---------+  +-----------+------------+  |  |
|  |           |                      |                        |               |  |
|  |  +--------v----------------------v------------------------v------------+  |  |
|  |  |                 Data Access Layer (Repository Store)                |  |  |
|  |  +-------------------------------+-------------------------------------+  |  |
|  +----------------------------------|----------------------------------------+  |
+-------------------------------------|-------------------------------------------+
                                      | SQL
+-------------------------------------v-------------------------------------------+
|                               DATA TIER                                         |
|  +---------------------------------------------------------------------------+  |
|  |                   PostgreSQL 16 (Relational Database)                     |  |
|  |   Tables: users, sessions, devices, conversations, memberships,           |  |
|  |           messages, event_outbox, key_packages                            |  |
|  +---------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------+
```

---

## 2. Core Backend Modules & Boundaries

1. **Authentication (`internal/auth`)**:
   - Manages user credentials with Argon2id password hashing.
   - Issues 256-bit cryptographically secure session tokens stored securely.
   - Provides middleware for authentication context extraction and CSRF validation.

2. **Identity & Devices (`internal/identity`)**:
   - Handles user profiles, usernames, and display names.
   - Tracks client devices (device ID, User-Agent, push token if any, status).
   - Manages device revocation.

3. **Conversations (`internal/conversations`)**:
   - Manages conversation entities (direct 1-on-1 and groups).
   - Enforces membership authorization: only active members can list or fetch conversation metadata.

4. **Messages (`internal/messages`)**:
   - Ingests incoming messages with client idempotency tokens (`idempotency_key`).
   - Persists ciphertext envelopes atomically with outbox events.
   - Enforces pagination via cursor-based query filters (`before_id`, `limit`).

5. **Events & Realtime (`internal/events`)**:
   - Implements the **Transactional Outbox Pattern**: every message mutation inserts a row into `event_outbox`.
   - Manages WebSocket client connections (`/api/v1/ws`).
   - Broadcasts events strictly to authorized conversation participants.
   - Supports catch-up synchronization using `last_event_id` cursor.

6. **Crypto Keys Registry (`internal/crypto`)**:
   - Stores device identity public keys and one-time pre-key bundles.
   - Serves public key packages to conversation initiators.
   - Server has zero knowledge of private keys.

---

## 3. Transactional Outbox & Event Delivery Guarantees

To ensure message reliability without distributed locks:
1. When a client submits a message via `POST /api/v1/conversations/{id}/messages`:
   - An ACID database transaction begins.
   - The message record is inserted.
   - An event record is inserted into `event_outbox` with a monotonically increasing integer `id`, topic, event type, and payload.
   - Transaction commits.
2. The event dispatcher immediately publishes the committed event to connected in-memory subscriber channels for the conversation participants.
3. If a client was disconnected:
   - Upon reconnecting, the client issues a `sync.request` with its `last_event_id`.
   - The server queries `event_outbox WHERE id > last_event_id AND recipient_user_id = ? ORDER BY id ASC LIMIT 100` and streams missed events.
   - Once caught up, real-time live events continue seamlessly.

---

## 4. Frontend Architecture

- **State Management**:
  - `TanStack Query`: Server state (conversations list, user directory, messages cache).
  - `Zustand`: Client UI state (active conversation, theme, drafts, active device identity).
- **Presentation**:
  - Telegram-inspired component hierarchy:
    - `Sidebar`: Filter search, tabbed folders (All, Direct, Groups), active chat indicator, unread badges.
    - `ChatView`: Chat header (status, online/offline, encryption lock), virtualized message list, typing indicators.
    - `Composer`: Textarea with auto-resize, emoji picker trigger, attachment button, send action with optimistic UI update.
- **Crypto Engine**:
  - Decoupled `CryptoEngine` interface with Web Crypto implementation (`SubtleCrypto`).
  - IndexedDB for local private key storage (never exported or transmitted).
