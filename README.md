# Senora

> **Senora** is a high-performance, self-hosted, Telegram-class messaging platform engineered with Signal Protocol Double Ratchet end-to-end encryption (E2EE), WebRTC calling, and real-time synchronization.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Security & Cryptography](#security--cryptography)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Development & Testing](#development--testing)
- [Production Deployment](#production-deployment)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Security Reporting](#security-reporting)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Overview

**Senora** is built from the ground up as a modern, self-contained communication platform. It delivers the responsiveness, fluid micro-interactions, and feature density of leading messaging applications (such as Telegram) while maintaining strict cryptographic privacy guarantees:

- **Zero Plaintext on Server for E2EE**: In E2EE mode, the server only receives and persists AES-256-GCM ciphertexts, nonces, and cryptographic metadata. Private keys never leave the client's device.
- **Dual-Dialect Database Support**: Operates out of the box with an embedded pure-Go SQLite engine (`modernc.org/sqlite`) for zero-dependency edge deployments, or with PostgreSQL 16 for high-concurrency enterprise clustering.
- **Modular Monolith Backend**: Written in idiomatic Go with transactional outbox event delivery, sub-millisecond WebSocket fan-out, and memory-safe architecture.
- **Modern Responsive Client**: Single-page application built with React 19, TypeScript, and Tailwind CSS, featuring dark/light themes, bidirectional layout (LTR and RTL), and self-hosted Vazirmatn typography.

---

## Key Features

### 💬 Messaging & Telegram-Class UX
- **Rich Text Formatting**: Markdown shortcuts and floating toolbar for Bold, Italic, Underline, Strikethrough, Monospace, Spoilers, Clickable Links, and Syntax-Highlighted Code Blocks with one-click copying.
- **Conversations & Categories**: Categorized tabs for All, Direct Chats, Groups, Channels, Saved Messages, and Archived Chats.
- **Interactive Message Actions**: Context menu with quick emoji reactions, threaded replies, multi-destination forwarding (with optional sender attribution privacy), pinning, inline editing, and deletion ("Delete for Me" vs "Delete for Everyone").
- **Voice & Video Notes**: Live AudioContext waveform voice note recorder with seekable playback, and circular video notes with genuine circular SVG progress indicators.
- **Client-Side Media Gallery**: Client-encrypted media previews with blurred placeholders, progressive download indicators, lightbox viewing, zoom/pan, and full-resolution downloads.
- **Interactive Polls & Quizzes**: Real-time anonymous voting, multi-choice selection, percentage bars, and instant quiz explanations.
- **24-Hour Stories**: Telegram-style stories bar with fullscreen viewer, pause/resume, and auto-advancement.
- **Channel Broadcasts**: Public channel posts with unique viewer IP/account tracking and formatted view counts (e.g., 42, 1.5K, 2.4M).
- **Disappearing Messages**: Configurable TTL (Off, 1 hour, 1 day, 1 week) with automated physical database purging.
- **Message Read Receipts**: Accurate per-message read tracking with dedicated reader inspection (`Read by` modal) and double blue checkmark transitions.

### 📞 WebRTC Audio & Video Calling
- **1-to-1 Calling**: Peer-to-peer WebRTC voice and video calls with authenticated WebSocket signaling.
- **Screen Sharing**: Live display capture via `getDisplayMedia` with dynamic track swapping.
- **Synthesized Audio Engine**: Integrated Web Audio tone generator providing ITU-T standard 440+480Hz ringback tones and melodious incoming ringtones without external audio files.
- **Group Voice Chat**: Multi-participant voice chat room with live AudioContext frequency analyzer waveform visualization.

---

## Architecture

Senora follows a clean, decoupled architecture:

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
|  |  |       Signal Protocol Cryptographic Engine (Web Crypto APIs)        |  |  |
|  |  |     X3DH Prekeys / Double Ratchet Session / AES-256-GCM Encryption    |  |  |
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
|  |  | REST API Router  |  | Transactional     |  | WebSocket Hub          |  |  |
|  |  | (Auth, Messages, |  | Outbox Dispatcher |  | (Presence, Live Events,|  |  |
|  |  | Calls, Channels) |  | (Event Sourcing)  |  | WebRTC Signaling)      |  |  |
|  |  +--------+---------+  +---------+---------+  +-----------+------------+  |  |
|  |           |                      |                        |               |  |
|  |  +--------v----------------------v------------------------v------------+  |  |
|  |  |              Storage Layer (Dual-Dialect SQLStore)                  |  |  |
|  |  +-------------------------------+-------------------------------------+  |  |
|  +----------------------------------|----------------------------------------+  |
+-------------------------------------|-------------------------------------------+
                                      |
                     +----------------+----------------+
                     |                                 |
                     v                                 v
        [ SQLite 3 (Pure Go) ]              [ PostgreSQL 16 ]
       (Default / Standalone)             (Enterprise Cluster)
```

---

## Security & Cryptography

### 1. Password Hashing & Authentication
- **Argon2id**: Passwords are saved using Argon2id with memory cost ≥ 64MB, 3 iterations, 2 threads, and a 16-byte cryptographically secure random salt (`crypto/rand`).
- **Session Tokens**: 256-bit cryptographically secure random tokens transmitted via `SameSite=Lax` / `SameSite=Strict`, `HttpOnly` cookies or Bearer authentication headers.

### 2. Client-Side End-to-End Encryption (E2EE)
- **Signal Protocol & Web Crypto**: Employs X3DH (Extended Triple Diffie-Hellman) prekey bundles and Double Ratchet session evolution for forward secrecy and post-compromise security.
- **Payload Cipher**: AES-256-GCM with 96-bit unique IVs and 128-bit authentication tags.
- **Key Boundaries**: Private keys and ratchet states remain exclusively stored in client-side non-extractable IndexedDB via `SubtleCrypto`. Private keys never leave the browser.
- **Associated Data (AAD)**: Encrypted payloads bind conversation ID, message ID, and sender ID into AES-GCM Associated Data to prevent cipher replay across conversations.

### 3. Server Authorization & Transport Defenses
- **Session Validation**: Every API endpoint and WebSocket upgrade enforces server-side membership authorization.
- **Cross-Site WebSocket Hijacking (CSWSH) Defense**: WebSocket handshakes validate the `Origin` header against explicit allowed domains.
- **Reverse Proxy Trust**: Right-to-left trust-chain parsing with strict CIDR validation (`TRUSTED_PROXIES`) ensures client IP headers cannot be spoofed to bypass rate limits.
- **Request Bounding**: Bounded HTTP request sizes via `http.MaxBytesReader` prevent memory exhaustion attacks.

---

## Prerequisites

- **Go**: Version 1.23 or newer (tested with Go 1.23 and 1.26).
- **Node.js**: Version 20 or newer (tested with Node.js v24.16.0 / npm 12.0.2).
- **Operating System**: Windows, Linux, or macOS.
- **Database** *(optional)*: PostgreSQL 16 (if not specified, Senora defaults to an embedded pure-Go SQLite database).

---

## Quick Start

### 1. Clone Repository
```bash
git clone https://github.com/<your-username>/Senora.git
cd Senora
```

### 2. Start Backend Server
```bash
cd apps/server
go run ./cmd/server
```
*The server will initialize `senora.db` (SQLite) automatically, verify all database migrations, and listen on `http://localhost:8080`.*

### 3. Start Frontend Client
In a separate terminal:
```bash
cd apps/web
npm install
npm run dev
```
*Open `http://localhost:5173` in your browser.*

---

## Configuration

Configure the backend using environment variables or a `.env` file:

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | Integer | `8080` | Port for the HTTP and WebSocket server. |
| `DATABASE_URL` | String | `""` (SQLite `senora.db`) | Database connection string. Use `postgres://user:pass@host:5432/dbname?sslmode=disable` for PostgreSQL. |
| `SESSION_SECRET` | String | *Auto-generated in dev* | 256-bit secret key used to sign and encrypt session tokens. Minimum 32 characters in production. |
| `ENVIRONMENT` | String | `development` | Set to `production` for strict secret enforcement and fail-closed validation. |
| `ALLOWED_ORIGINS`| String | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated list of allowed origins for CORS and WebSocket handshake. |
| `TRUST_PROXY` | Boolean | `false` | Enable when running behind Caddy, Nginx, or a cloud load balancer. |
| `TRUSTED_PROXIES`| String | `127.0.0.1,::1` | Comma-separated list of trusted upstream proxy IP addresses or CIDR blocks. |
| `UPLOAD_DIR` | String | `uploads` | Directory for storing encrypted media attachments and user avatars. |

---

## Development & Testing

### Running Tests

#### Backend Test Suite
```bash
cd apps/server
go test -v -count=1 ./...
```

#### Frontend Test Suite
```bash
cd apps/web
npm test -- --run
```

#### TypeScript Typecheck
```bash
cd apps/web
npx tsc --noEmit
```

#### Production Build
```bash
cd apps/web
npm run build
```

---

## Production Deployment

### Option A: Docker Compose with Caddy (Recommended)

1. Review and update `deployments/compose/.env.example`, then copy to `.env`:
   ```bash
   cp deployments/compose/.env.example deployments/compose/.env
   ```
2. Start the full stack with automated TLS:
   ```bash
   docker compose -f deployments/compose/docker-compose.yml up -d
   ```

### Option B: Standalone Linux Binary

Compile the standalone Linux binary:
```bash
cd apps/server
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o senora-server ./cmd/server
```

---

## Project Structure

```text
Senora/
├── apps/
│   ├── server/             # Go modular monolith backend
│   │   ├── cmd/server/     # Server entry point (main.go)
│   │   ├── internal/
│   │   │   ├── api/        # REST router, middleware, handlers & tests
│   │   │   ├── auth/       # Argon2id hashing & session management
│   │   │   ├── config/     # Environment parsing & validation
│   │   │   ├── events/     # Real-time WebSocket hub & presence tracking
│   │   │   ├── messages/   # Message service & business logic
│   │   │   ├── models/     # Domain data models & structures
│   │   │   └── storage/    # Dual-dialect SQL store (SQLite / PostgreSQL)
│   │   └── go.mod          # Go module definitions
│   └── web/                # React 19 + TypeScript frontend SPA
│       ├── src/
│       │   ├── app/        # App entry, i18n translations & global types
│       │   ├── crypto/     # Signal Protocol & client-side Web Crypto engine
│       │   ├── features/   # Modals, calling, messages, settings & presence
│       │   └── protocol/   # HTTP API fetcher & WebSocket client
│       ├── package.json    # Frontend dependencies and scripts
│       └── vite.config.ts  # Vite build configuration
├── database/
│   └── migrations/         # Dual-dialect SQL migration scripts (000001 - 000005)
├── deployments/
│   ├── compose/            # Docker Compose & .env.example
│   └── docker/             # Dockerfiles (server, web), Caddyfile, Nginx config
├── docs/                   # Architectural blueprints, threat model, protocol specs
├── packages/
│   └── protocol/           # OpenAPI 3.1 specification (openapi.yaml)
├── scripts/                # Local development & test PowerShell scripts
├── .github/workflows/      # GitHub Actions CI workflow (ci.yml)
├── .dockerignore           # Container build exclusions
├── .gitignore              # Repository file exclusions
├── CONTRIBUTING.md         # Contribution guidelines
├── Makefile                # Multi-target build and test orchestration
├── README.md               # Public project documentation
└── SECURITY.md             # Security policy and disclosure process
```

---

## Troubleshooting

- **Microphone / Camera blocked in calls**: Ensure the site is served over HTTPS (or `localhost`). WebRTC media devices are blocked by browser security policies on unencrypted HTTP.
- **WebSocket connection failed**: Verify that your browser URL matches one of the domains in `ALLOWED_ORIGINS`. In development, `http://localhost:5173` is allowed by default.
- **Database unique constraint or busy error**: On SQLite edge nodes with high write concurrency, ensure WAL mode is active (default in Senora). For larger multi-tenant workloads, connect to PostgreSQL 16.

---

## Security Reporting

Please see [SECURITY.md](SECURITY.md) for details on responsible disclosure and how to submit a vulnerability report.

---

## License

License terms for Senora are currently being finalized. Please consult repository maintainers before public commercial distribution or derivative packaging.

---

## Acknowledgments

- **Signal Protocol**: Developed by Privacy Research and the Signal Foundation.
- **Vazirmatn Font**: Designed by Saber Rastikerdar for beautiful Persian typography.
- **Inter Font**: Designed by Rasmus Andersson for clean interface typography.
- **modernc.org/sqlite**: Pure-Go SQLite engine enabling zero-CGO compilation.
