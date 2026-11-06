<div align="center">

<img src="assets/hero.svg" alt="Senora — private self-hosted messaging platform" width="100%"/>

**A self-hosted messaging platform with end-to-end encryption, real-time sync and WebRTC calls.**

[Experience](#experience) · [Architecture](#architecture) · [Security](#security--cryptography) · [Quick start](#quick-start) · [Deploy](#production-deployment)

<br/>

![Go](https://img.shields.io/badge/Go-1.23%2B-00ADD8?style=flat-square&logo=go&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-GPL--3.0--only-9B7BC8?style=flat-square)

</div>

---

## A communication space you control

**Senora** is a high-performance, self-hosted messaging platform built around three principles:

- **Private conversations:** Signal Protocol concepts, X3DH prekeys, Double Ratchet sessions and client-side encryption.
- **A complete messaging experience:** direct chats, groups, channels, media, stories, reactions, polls and rich message interactions.
- **Infrastructure you own:** a Go backend, React client and SQLite/PostgreSQL storage options.

Senora is designed to bring a polished, Telegram-class experience to a server you control.

## Experience

### Messaging

- Direct conversations, groups, channels, saved messages and archived chats
- Rich text: bold, italic, underline, strikethrough, monospace, spoilers, links and code blocks
- Replies, reactions, forwarding, pinning, editing and message deletion controls
- Voice messages with waveform visualization and seekable playback
- Video notes, media gallery, progressive previews and full-resolution downloads
- Polls, quizzes, anonymous voting and result visualization
- 24-hour stories and channel broadcasts
- Configurable disappearing messages and read receipts

### Calls and live communication

- One-to-one audio and video calls over WebRTC
- Authenticated WebSocket signaling
- Screen sharing through browser media capture
- Group voice chat with live audio visualization
- Real-time presence and event synchronization

### Client experience

- React 19 + TypeScript single-page application
- Dark and light themes
- LTR and RTL layout support
- Self-hosted Vazirmatn typography
- Responsive interface and interactive message controls

## Architecture

Senora uses a modular-monolith Go backend and a browser client. The client handles the cryptographic session state; the server coordinates authenticated API requests, message delivery, presence and signaling.

```mermaid
flowchart TB
    subgraph CLIENT["CLIENT · React 19 / TypeScript"]
      UI[Messaging interface]
      STATE[Zustand + TanStack Query]
      CRYPTO[Web Crypto · Signal session]
      TRANSPORT[REST + WebSocket client]
      UI --> STATE
      STATE --> CRYPTO
      STATE --> TRANSPORT
    end
    subgraph EDGE["EDGE"]
      PROXY[Caddy / Nginx · TLS]
    end
    subgraph SERVER["SERVER · Go modular monolith"]
      API[REST API]
      WS[WebSocket hub]
      OUTBOX[Transactional outbox]
      STORE[SQL storage layer]
      API --> STORE
      WS --> OUTBOX
      OUTBOX --> STORE
    end
    subgraph DB["DATABASE"]
      SQLITE[(SQLite · standalone)]
      PG[(PostgreSQL 16 · clustered)]
    end
    TRANSPORT <-->|HTTPS / WSS| PROXY
    PROXY <--> API
    PROXY <--> WS
    STORE --> SQLITE
    STORE --> PG
```

### Technology

| Layer | Technology |
|---|---|
| Backend | Go |
| Web client | React 19, TypeScript, Tailwind CSS |
| Client state | Zustand, TanStack Query |
| Real-time | WebSocket |
| Calling | WebRTC |
| Cryptography | Signal Protocol flow, Web Crypto APIs, AES-256-GCM |
| Database | Embedded SQLite or PostgreSQL 16 |
| Reverse proxy | Caddy or Nginx |

## Security & cryptography

Security-sensitive behavior depends on correct implementation, deployment and client integrity. Review [`SECURITY.md`](SECURITY.md) before exposing an instance publicly.

### Authentication and sessions

- Password hashing with Argon2id (documented parameters: memory cost at least 64 MiB, three iterations, two threads and a 16-byte random salt).
- Cryptographically random 256-bit session tokens.
- Secure cookie attributes including `HttpOnly` and `SameSite`, or supported Bearer authentication.

### End-to-end encryption

In E2EE mode, the design uses:

- X3DH prekey bundles to establish sessions
- Double Ratchet session evolution
- AES-256-GCM message payload encryption
- 96-bit unique IVs and 128-bit authentication tags
- Associated data binding conversation, message and sender identifiers
- Client-side private-key and ratchet-state storage using IndexedDB / Web Crypto

Private keys are intended to remain on the client device. The server stores ciphertext and associated cryptographic metadata rather than message plaintext in E2EE mode.

### Server-side defenses

- Membership authorization on API routes and WebSocket upgrades
- WebSocket `Origin` validation against configured allowed origins
- Explicit trusted-proxy CIDR handling
- Bounded HTTP request bodies

> Cryptographic labels do not replace an independent security audit. Do not treat a self-hosted deployment as audited or production-secure solely because these mechanisms are present.

## Quick start

### Requirements

- Go 1.23 or newer
- Node.js 20 or newer
- npm
- Windows, Linux or macOS
- PostgreSQL 16 only if you choose PostgreSQL; SQLite is the default

### 1. Clone

```bash
git clone https://github.com/iaMaSTeR-Dev/Senora.git
cd Senora
```

### 2. Start the backend

```bash
cd apps/server
go run ./cmd/server
```

The development configuration initializes the SQLite database (`senora.db`), applies migrations and listens on `http://localhost:8080`.

### 3. Start the frontend

In a second terminal:

```bash
cd apps/web
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Configuration

The backend reads environment variables or a `.env` file.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP and WebSocket server port |
| `DATABASE_URL` | Empty (SQLite `senora.db`) | SQL database connection string |
| `SESSION_SECRET` | Auto-generated in development | Session signing/encryption secret; use at least 32 characters in production |
| `ENVIRONMENT` | `development` | Set to `production` for strict secret enforcement |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Allowed CORS and WebSocket origins |
| `TRUST_PROXY` | `false` | Enable behind a trusted reverse proxy |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Trusted proxy IPs or CIDR blocks |
| `UPLOAD_DIR` | `uploads` | Encrypted media and avatar storage directory |

For PostgreSQL, use a connection string such as:

```dotenv
DATABASE_URL=postgres://user:pass@host:5432/dbname?sslmode=disable
```

Use a strong, unique `SESSION_SECRET` in production. Do not commit `.env` files or production credentials.

## Development & testing

### Backend tests

```bash
cd apps/server
go test -v -count=1 ./...
```

### Frontend tests

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

## Production deployment

### Docker Compose with Caddy

1. Review `deployments/compose/.env.example`.
2. Copy it to the deployment environment and set production secrets.
3. Start the stack:

```bash
cp deployments/compose/.env.example deployments/compose/.env
docker compose -f deployments/compose/docker-compose.yml up -d
```

The Compose deployment includes the reverse-proxy path for TLS. Review the Compose file and Caddy configuration for your domain and environment before exposing the service.

### Standalone Linux server binary

```bash
cd apps/server
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o senora-server ./cmd/server
```

## Project layout

```text
Senora/
├── apps/
│   ├── server/
│   │   ├── cmd/server/       # Server entry point
│   │   └── internal/
│   │       ├── api/          # REST router, middleware and handlers
│   │       ├── auth/         # Password hashing and sessions
│   │       ├── config/       # Environment parsing and validation
│   │       ├── events/       # WebSocket hub and presence
│   │       ├── messages/     # Message services and logic
│   │       ├── models/       # Domain models
│   │       └── storage/      # SQLite / PostgreSQL store
│   └── web/
│       └── src/
│           ├── app/          # App entry, i18n and global types
│           ├── crypto/       # Client-side cryptographic engine
│           ├── features/     # Messaging, calls, settings and presence
│           └── protocol/     # HTTP and WebSocket clients
├── database/migrations/      # SQL migrations
├── deployments/
│   ├── compose/              # Docker Compose and env example
│   └── docker/               # Dockerfiles and proxy configs
├── packages/protocol/        # OpenAPI 3.1 specification
├── CONTRIBUTING.md
├── Makefile
├── SECURITY.md
└── README.md
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Camera or microphone unavailable | Use HTTPS or `localhost`; browsers restrict media APIs on insecure origins |
| WebSocket connection fails | Confirm the browser origin is included in `ALLOWED_ORIGINS` |
| SQLite busy/constraint errors | Check write concurrency and WAL behavior; consider PostgreSQL for higher concurrency |

## Security reporting

Please read [`SECURITY.md`](SECURITY.md) for the responsible disclosure process. Avoid publishing exploitable vulnerability details in public issues.

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md), open an issue for substantial changes and submit focused pull requests.

## License

Copyright © 2026 iaMaSTeR.

Senora is licensed under **GNU GPL v3.0 only** (`GPL-3.0-only`). See [`LICENSE`](LICENSE).

## Acknowledgements

- [Signal Protocol](https://signal.org/docs/) — protocol design and documentation
- [Vazirmatn](https://github.com/rastikerdar/vazirmatn) — Persian typeface
- [Inter](https://rsms.me/inter/) — interface typeface
- [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) — pure-Go SQLite implementation

---

<div align="center">

**senora** · Your server. Your conversations. Your keys.

Maintained by [iaMaSTeR-Dev](https://github.com/iaMaSTeR-Dev)

</div>
