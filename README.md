<div align="center">

<img src="assets/hero.svg" alt="Senora — private self-hosted messaging platform" width="100%"/>

**A high-performance, self-hosted messaging platform with Signal Protocol end-to-end encryption, real-time sync, and WebRTC calls.**

[Experience](#experience) · [Architecture](#architecture) · [Security & Cryptography](#security--cryptography) · [Quick Start](#quick-start) · [Configuration](#configuration) · [Production Deployment](#production-deployment)

<br/>

[![Go](https://img.shields.io/badge/Go-1.23%2B-00ADD8?style=flat-square&logo=go&logoColor=white)](https://golang.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-GPL--3.0--only-9B7BC8?style=flat-square)](LICENSE)

</div>

---

## A communication space you control

**Senora** is a high-performance, self-hosted messaging platform engineered from the ground up around three core principles:

- **Cryptographic Privacy by Design:** Signal Protocol Double Ratchet sessions, X3DH prekeys, and AES-256-GCM client-side encryption. In E2EE mode, the server persists zero plaintext.
- **A Complete Telegram-Class Experience:** Direct chats, groups, channels, saved messages, voice waveforms, round video notes, stickers, reactions, polls, 24-hour stories, synchronized watch parties, and WebRTC calling.
- **Infrastructure You Own:** A modular-monolith Go backend, React 19 single-page application, and zero-dependency embedded SQLite or clustered PostgreSQL storage options.

Senora delivers the responsiveness, fluid micro-interactions, and feature density of leading messaging applications to a private server you control.

---

## Experience

### 💬 Messaging & Telegram-Class UX

- **Conversations & Categories:** Categorized tabs for All, Direct Chats, Groups, Channels, Saved Messages, and Archived Chats.
- **Rich-Text Formatting:** Floating formatting toolbar and keyboard shortcuts supporting Bold, Italic, Underline, Strikethrough, Monospace, Spoilers, Clickable Markdown Links, and Syntax-Highlighted Code Blocks with one-click copying.
- **Interactive Message Actions:** Viewport-bounded context menu with quick emoji reactions, threaded replies, multi-destination forwarding (with optional sender attribution privacy), pinning, inline editing, and granular deletions ("Delete for Me" vs "Delete for Everyone").
- **Voice & Video Notes:** Live AudioContext waveform voice note recorder with seekable playback, and circular video notes with genuine circular SVG progress indicators.
- **Client-Side Media Gallery:** Client-encrypted media previews with blurred placeholders, progressive download indicators, full-screen lightbox viewing with zoom/pan, and full-resolution downloads.
- **Interactive Polls & Quizzes:** Real-time anonymous voting, multi-choice selection, percentage visualization, and instant quiz explanations.
- **24-Hour Stories:** Stories bar with full-screen viewer, pause/resume, and auto-advancement.
- **Channel Broadcasts:** Public channel posts with unique viewer IP/account deduplication and authentic formatted view counts (e.g., `42`, `1.5K`, `2.4M`).
- **Disappearing Messages:** Configurable TTL (Off, 1 hour, 1 day, 1 week) with automated physical database purging.
- **Message Read Receipts:** Accurate per-message read tracking with reader inspection (`Read by` modal) and double blue checkmark transitions.
- **Secret Whisper Messages:** Recipient-locked private messages within group conversations.
- **Custom Sticker Studio:** Searchable emoji picker, animated WebP/SVG stickers, and user-created sticker packs with instant share links.

### 📞 WebRTC Audio & Video Calling

- **1-to-1 Calling:** Peer-to-peer WebRTC voice and video calls with authenticated WebSocket signaling.
- **Screen Sharing:** High-framerate display capture via `getDisplayMedia` with dynamic track adaptation, Theater Mode, Aspect Fit/Fill toggles, and full-screen view.
- **Synthesized Audio Engine:** Integrated Web Audio tone generator providing ITU-T standard 440+480Hz ringback tones and melodious incoming ringtones without external audio files.
- **Group Voice Chat:** Multi-participant voice chat room with live AudioContext frequency analyzer waveform visualization.
- **Dynamic ICE & Recovery:** Automatic STUN/TURN server resolution with connection recovery.

### 🤖 Automation, Downloader & Media Ecosystem

- **SenoraMasterBot:** In-chat server management for the instance owner, providing automated user registration approvals, server health diagnostics, IP blacklisting, database backup generation, and maintenance controls.
  > **Privacy Boundary:** The Master Bot and server administration have **zero access** to inspect, eavesdrop on, or read users' private chats and attachments. User privacy is strictly safeguarded.
- **Media Downloader Engine:** Built-in `/dl` service supporting direct streaming downloads, S3/local disk failover, and configurable proxy routing.
- **Interactive Mini-Games:** Seamless multiplayer games directly in conversations including Tic-Tac-Toe, Rock-Paper-Scissors, and animated dice.
- **Watch Party & Standalone Media Player:** In-chat synchronized media viewing (سینما پارتی همزمان) with drift correction and public streaming links featuring RFC 7233 byte-range HTTP streaming.
- **IP Ban & Abuse Prevention:** Automatic abuse tracking, brute-force mitigation, and CIDR subnet IP blacklisting.

### 🎨 Client Experience

- **React 19 + TypeScript SPA:** Ultra-responsive client built with Vite and Tailwind CSS.
- **Theme Coherence:** Telegram-inspired dark and light visual themes with glassmorphism touches.
- **Bidirectional Typography:** Full LTR and RTL layout support with self-hosted Vazirmatn typography for Persian and Arabic text alongside Inter.
- **Passcode Lock Gate:** Client-side PBKDF2-HMAC-SHA256 (100k iterations) passcode lock with auto-lock timers and attempt rate limiting.

---

## Architecture

Senora uses a clean, decoupled architecture. The browser client manages the cryptographic session state; the Go backend coordinates authenticated API requests, transactional outbox message delivery, presence, and WebRTC signaling.

```mermaid
flowchart TB
    subgraph CLIENT["CLIENT · React 19 / TypeScript"]
      UI[Messaging & Telegram UX]
      STATE[Zustand + TanStack Query]
      CRYPTO[Web Crypto · Signal Double Ratchet]
      TRANSPORT[REST Fetcher + WebSocket Manager]
      UI --> STATE
      STATE --> CRYPTO
      STATE --> TRANSPORT
    end
    subgraph EDGE["EDGE"]
      PROXY[Caddy / Nginx · TLS Termination]
    end
    subgraph SERVER["SERVER · Go Modular Monolith"]
      API[REST API Router]
      WS[WebSocket Hub & Signaling]
      OUTBOX[Transactional Outbox Dispatcher]
      BOT[SenoraMasterBot Service]
      STORE[Dual-Dialect SQLStore]
      API --> STORE
      WS --> OUTBOX
      OUTBOX --> STORE
      BOT --> STORE
    end
    subgraph DB["DATABASE"]
      SQLITE[(SQLite 3 · Pure Go Embedded)]
      PG[(PostgreSQL 16 · Clustered)]
    end
    TRANSPORT <-->|HTTPS / WSS| PROXY
    PROXY <--> API
    PROXY <--> WS
    STORE --> SQLITE
    STORE --> PG
```

### Technology Stack

| Layer | Technology |
|---|---|
| **Backend** | Go 1.23+ (Modular Monolith) |
| **Web Client** | React 19, TypeScript 5, Tailwind CSS, Vite |
| **Client State** | Zustand, TanStack Query |
| **Real-Time Transport** | WebSocket (`gorilla/websocket`) with transactional outbox fan-out |
| **Voice & Video** | WebRTC (`RTCPeerConnection`), Web Audio API |
| **Cryptography** | Signal Protocol (Double Ratchet, X3DH), Web Crypto API, AES-256-GCM, Argon2id |
| **Database** | Embedded pure-Go SQLite (`modernc.org/sqlite`) or PostgreSQL 16 |
| **Object Storage** | ArvanCloud S3 / MinIO / AWS S3 with automatic local disk failover |
| **Reverse Proxy** | Caddy (automated TLS) or Nginx |

---

## Security & Cryptography

Security-sensitive behavior depends on correct implementation, deployment hygiene, and client integrity. Review [`SECURITY.md`](SECURITY.md) before exposing an instance to the public internet.

### 1. Password Hashing & Authentication
- **Argon2id:** Passwords are saved using Argon2id with memory cost ≥ 64 MiB, 3 iterations, 2 threads, and a 16-byte cryptographically secure random salt (`crypto/rand`).
- **Session Tokens:** 256-bit cryptographically secure random tokens transmitted via `SameSite=Lax` / `SameSite=Strict`, `HttpOnly` cookies or Bearer authentication headers.

### 2. Client-Side End-to-End Encryption (E2EE)
- **Signal Protocol & Web Crypto:** Employs X3DH (Extended Triple Diffie-Hellman) prekey bundles and Double Ratchet session evolution for forward secrecy and post-compromise security.
- **Payload Cipher:** AES-256-GCM with 96-bit unique IVs and 128-bit authentication tags.
- **Key Boundaries:** Private keys and ratchet states remain exclusively stored in client-side non-extractable IndexedDB via `SubtleCrypto`. Private keys never leave the browser.
- **Associated Data (AAD):** Encrypted payloads bind conversation ID, message ID, and sender ID into AES-GCM Associated Data to prevent cipher replay across conversations.
- **Zero Plaintext on Server:** The server stores ciphertexts and cryptographic metadata only. Plaintext content is never processed or persisted by the server in E2EE mode.

### 3. Server Authorization & Transport Defenses
- **Strict Membership Authorization:** Every API endpoint and WebSocket upgrade enforces server-side membership validation.
- **Cross-Site WebSocket Hijacking (CSWSH) Defense:** WebSocket handshakes validate the `Origin` header against explicit allowed domains.
- **Reverse Proxy Trust:** Right-to-left trust-chain parsing with strict CIDR validation (`TRUSTED_PROXIES`) ensures client IP headers cannot be spoofed to bypass rate limits.
- **Request Bounding:** Bounded HTTP request sizes via `http.MaxBytesReader` prevent memory exhaustion attacks.

---

## Quick Start

### Prerequisites

- **Go**: Version 1.23 or newer (tested with Go 1.23 and 1.26).
- **Node.js**: Version 20 or newer (tested with Node.js v24.16.0 / npm 12.0.2).
- **Operating System**: Windows, Linux, or macOS.
- **Database** *(optional)*: PostgreSQL 16 (if not specified, Senora defaults to an embedded pure-Go SQLite database).

### 1. Clone the repository

```bash
git clone https://github.com/iaMaSTeR-Dev/Senora.git
cd Senora
```

### 2. Start the backend

```bash
cd apps/server
go run ./cmd/server
```

*The server will initialize `senora.db` (SQLite) automatically, run migrations, and listen on `http://localhost:8080`.*

### 3. Start the frontend

In a second terminal:

```bash
cd apps/web
npm install
npm run dev
```

*Open [http://localhost:5173](http://localhost:5173) in your browser.*

---

## Configuration

Configure the backend using environment variables or a `.env` file:

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | Integer | `8080` | Port for the HTTP and WebSocket server |
| `DATABASE_URL` | String | `""` (SQLite `senora.db`) | Database connection string. Use `postgres://user:pass@host:5432/dbname?sslmode=disable` for PostgreSQL |
| `SESSION_SECRET` | String | *Auto-generated in dev* | 256-bit secret key used to sign and encrypt session tokens. Minimum 32 characters in production |
| `ENVIRONMENT` | String | `development` | Set to `production` for strict secret enforcement and fail-closed validation |
| `ALLOWED_ORIGINS`| String | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated list of allowed origins for CORS and WebSocket handshakes |
| `TRUST_PROXY` | Boolean | `false` | Enable when running behind Caddy, Nginx, or a cloud reverse proxy |
| `TRUSTED_PROXIES`| String | `127.0.0.1,::1` | Comma-separated list of trusted upstream proxy IP addresses or CIDR blocks |
| `UPLOAD_DIR` | String | `uploads` | Directory for storing encrypted media attachments and user avatars |

---

## Development & Testing

### Backend test suite

```bash
cd apps/server
go test -v -count=1 ./...
```

### Frontend test suite

```bash
cd apps/web
npm test -- --run
```

### TypeScript check

```bash
cd apps/web
npx tsc --noEmit
```

### Production frontend build

```bash
cd apps/web
npm run build
```

---

## Production Deployment

### Option A: Docker Compose with Caddy (Recommended)

1. Review `deployments/compose/.env.example` and copy to `.env`:
   ```bash
   cp deployments/compose/.env.example deployments/compose/.env
   ```
2. Set your production domain and secrets in `deployments/compose/.env`.
3. Start the stack with automated TLS:
   ```bash
   docker compose -f deployments/compose/docker-compose.yml up -d
   ```

### Option B: Standalone Linux Binary

Compile the optimized standalone Linux binary:

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
│   │   │   ├── auth/       # Argon2id password hashing & session management
│   │   │   ├── config/     # Environment parsing & validation
│   │   │   ├── conversations/ # Conversation management & roles
│   │   │   ├── crypto/     # Prekey registry & cryptographic verification
│   │   │   ├── downloader/ # Asynchronous media downloader & proxy manager
│   │   │   ├── events/     # Real-time WebSocket hub & presence tracking
│   │   │   ├── filestore/  # S3 Object Storage with automatic local failover
│   │   │   ├── identity/   # User identity & profile management
│   │   │   ├── masterbot/  # Administrative bot service & interactive commands
│   │   │   ├── messages/   # Message service, validation & outbox events
│   │   │   ├── models/     # Domain data models & structures
│   │   │   └── storage/    # Dual-dialect SQL store (SQLite / PostgreSQL)
│   │   └── go.mod          # Go module definitions
│   └── web/                # React 19 + TypeScript frontend SPA
│       ├── src/
│       │   ├── app/        # App entry, i18n translations & global types
│       │   ├── crypto/     # Signal Protocol & client-side Web Crypto engine
│       │   ├── features/   # Messaging, calling, stickers, settings & presence
│       │   └── protocol/   # HTTP API fetcher & WebSocket client
│       ├── package.json    # Frontend dependencies and scripts
│       └── vite.config.ts  # Vite build configuration
├── assets/                 # Brand assets & hero visuals
├── database/
│   └── migrations/         # Dual-dialect SQL migration scripts (000001 - 000009)
├── deployments/
│   ├── compose/            # Docker Compose & .env.example
│   └── docker/             # Dockerfiles (server, web), Caddyfile, Nginx config
├── docs/                   # Architectural blueprints, threat model, protocol specs
├── packages/
│   └── protocol/           # OpenAPI 3.1 specification (openapi.yaml)
├── .github/workflows/      # GitHub Actions CI workflow (ci.yml)
├── CONTRIBUTING.md         # Contribution guidelines
├── Makefile                # Multi-target build and test orchestration
├── README.md               # Public project documentation
└── SECURITY.md             # Security policy and disclosure process
```

---

## Troubleshooting

| Symptom | Diagnosis / Resolution |
|---|---|
| **Camera or microphone unavailable** | Ensure the site is served over HTTPS or `localhost`. Browsers restrict WebRTC media devices on insecure HTTP origins. |
| **WebSocket connection fails** | Confirm the client browser origin is included in `ALLOWED_ORIGINS`. In development, `http://localhost:5173` is allowed by default. |
| **Database busy or locking errors** | On SQLite edge nodes, ensure WAL mode is active (default in Senora). For high-concurrency enterprise workloads, connect to PostgreSQL 16. |

---

## Security Reporting

Please read [`SECURITY.md`](SECURITY.md) for our responsible disclosure process. Avoid publishing exploitable vulnerability details in public issues.

---

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md), open an issue for substantial architectural changes, and submit focused pull requests.

---

## License

Copyright © 2026 iaMaSTeR.

Senora is licensed under the **GNU General Public License v3.0 only** (`GPL-3.0-only`). See [`LICENSE`](LICENSE) for details.

---

## Acknowledgments

- [Signal Protocol](https://signal.org/docs/) — protocol design and cryptographic documentation
- [Vazirmatn](https://github.com/rastikerdar/vazirmatn) — Persian typeface
- [Inter](https://rsms.me/inter/) — interface typeface
- [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) — pure-Go SQLite implementation

---

<div align="center">

**senora** · Your server. Your conversations. Your keys.

Maintained by [iaMaSTeR-Dev](https://github.com/iaMaSTeR-Dev)

</div>
