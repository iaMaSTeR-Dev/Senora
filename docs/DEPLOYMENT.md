# DEPLOYMENT & OPERATIONS GUIDE — SENORA

This guide covers deployment options, environment variables, reverse-proxy configurations, STUN/TURN calling infrastructure, backup procedures, and troubleshooting for self-hosted SENORA instances.

---

## 1. Deployment Topologies

### Option A: Lightweight Standalone Deployment (SQLite)
Suitable for small teams, edge nodes, or air-gapped internal servers with zero external database dependencies.
- **Backend**: Runs as a single compiled Go binary.
- **Database**: SQLite in WAL mode (`file:senora.db?_journal_mode=WAL&_busy_timeout=5000`).
- **Frontend**: Pre-built static assets served by Nginx or Caddy.

### Option B: High-Concurrence Production Stack (PostgreSQL + Docker Compose)
Suitable for multi-user organizations requiring automated failover and regular streaming backups.
```text
[ Client (Browser / Mobile) ]
       |
       | HTTPS (443) / WSS
       v
[ Reverse Proxy (Nginx / Caddy) ]
       |
       +---> /api/v1/ws --------> [ senora-server:8080 ] (WebSocket Hub)
       +---> /api/v1/* ---------> [ senora-server:8080 ] (REST API)
       +---> /* ----------------> [ senora-web:80 ] (Vite Static SPA)
                                          |
                                          v
                                 [ postgresql:5432 ] (PostgreSQL 16)
```

---

## 2. Environment Variables Specification

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `8080` | HTTP and WebSocket listening port for the Go server. |
| `ENVIRONMENT` | Yes in production | `development` | Use `production` for the deployed service. |
| `DATABASE_URL` | Yes in production | `file:senora.db?cache=shared` in development | PostgreSQL connection URI. Production rejects SQLite and insecure default passwords. Preserve the existing database URL during an upgrade; `DB_DRIVER` and `DB_DSN` are not runtime configuration inputs. |
| `SESSION_SECRET` | Yes in production | none | At least 32 decoded random bytes, hex or base64; preserve the current secret during an upgrade. |
| `SENORA_BACKUP_DIR` | No | `/var/lib/senora/backups` on Linux | Private directory outside the served web root, owned by the service user with mode 0700. PostgreSQL backup requires a compatible `pg_dump` executable. |
| `ALLOWED_ORIGINS` | Yes in production | localhost development origins | Comma-separated exact origins allowed for CORS and CSWSH WebSocket `CheckOrigin` validation (e.g., `https://chat.example.com`). Recommended in production behind TLS proxies. |
| `TRUST_PROXY` | No | `false` | Trust `X-Forwarded-For` and `X-Forwarded-Proto` from local loopback proxies (`127.0.0.1` / `::1`), enabling same-origin `wss://` checks behind Nginx/Caddy. |
| `TRUSTED_PROXIES` | No | `""` | Comma-separated proxy IPs/CIDRs (e.g., Docker bridge `172.16.0.0/12`). When set, only matching peers are trusted for forwarded IP/proto headers. |
| `MAX_UPLOAD_BYTES` | No | `524288000` | Upload limit (500 MiB); `0` or `unlimited` removes the request limit, but disk safeguards still apply. |
| `STUN_SERVERS` | No | `stun:stun.l.google.com:19302,...` | Comma-separated STUN URLs returned by `GET /api/v1/webrtc/ice-servers` (defaults to 5 public STUN servers; set `none` for isolated LANs). |
| `ICE_SERVERS` | No | `""` | Optional raw JSON array of additional `RTCIceServer` objects appended to the ICE list. |
| `TURN_URL` / `TURN_SERVER_URL` | No | `""` | Comma-separated TURN/TURNS URLs for NAT/firewall relay (e.g., `turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp`). |
| `TURN_AUTH_SECRET` | No | `""` | Coturn `static-auth-secret` for generating per-user ephemeral HMAC-SHA1 TURN credentials (`use-auth-secret`). Preferred over static credentials. |
| `TURN_AUTH_TTL_SECONDS` | No | `86400` | Lifetime in seconds of generated ephemeral TURN credentials. |
| `TURN_USERNAME` | No | `""` | Static TURN username fallback (used only when `TURN_AUTH_SECRET` is empty). |
| `TURN_CREDENTIAL` | No | `""` | Static TURN password fallback (used only when `TURN_AUTH_SECRET` is empty). |
| `AVATAR_STORAGE_DIR` | No | `./uploads/avatars` | Directory path for persisting uploaded user profile avatars. Automatically created if missing. |
| `GIF_PROVIDER_URL` | No | `""` | Optional external GIF provider endpoint (defaults to internal curated animated GIF catalog). |

---

## 3. Production Nginx Configuration

Below is a production-hardened Nginx configuration template supporting strict WebSocket upgrades, SPA client-side routing, and security headers:

```nginx
server {
    listen 80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security Headers
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;

    # Maximum upload body size (matches backend MAX_UPLOAD_BYTES)
    client_max_body_size 500M;

    # REST API endpoints
    location ^~ /backups/ { return 404; }

    location /api/ {
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket Gateway with upgrade headers & forwarded proto/host for WSS Origin validation
    location /api/v1/ws {
        proxy_pass http://127.0.0.1:8080/api/v1/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Frontend Single-Page Application (Vite Build)
    location / {
        root /var/www/senora/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
}
```

---

## 4. WebRTC Calling & Coturn Setup

Browser-to-browser WebRTC often connects directly on a local LAN or cone NAT, **but fails at ICE checking / media flow across symmetric NAT, cellular CGNAT, or strict enterprise firewalls without a reachable TURN relay**. Deploy Coturn on a host with a public IPv4 address:

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
min-port=49152
max-port=65535
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=REPLACE_WITH_STRONG_RANDOM_SECRET
realm=chat.example.com
server-name=turn.example.com
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
no-multicast-peers
no-loopback-peers
```

**Matching SENORA Server Environment**:
```env
STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478
TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp
TURN_AUTH_SECRET=REPLACE_WITH_STRONG_RANDOM_SECRET
TURN_AUTH_TTL_SECONDS=86400
ALLOWED_ORIGINS=https://chat.example.com
TRUST_PROXY=true
```

**Required Firewall Ports**:
- `3478/udp` and `3478/tcp` (STUN / TURN UDP & TCP)
- `5349/tcp` (TURNS TLS over TCP for networks blocking UDP)
- `49152-65535/udp` (Coturn dynamic media relay port range)

Also verify TLS reverse proxies forward `Host` and `X-Forwarded-Proto` (or configure `ALLOWED_ORIGINS`) so `/api/v1/ws` `wss://` upgrades succeed without HTTP 403.

---

## 5. Backup and Disaster Recovery

### SQLite Standalone Backup
```bash
# Safe backup without stopping the server (using sqlite3 online backup API)
sqlite3 senora.db ".backup 'backup_$(date +%Y%m%d_%H%M%S).db'"
```

### PostgreSQL Streaming Backup
```bash
docker exec -t senora-postgres pg_dump -U senora -d senora_db | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz
```

### PostgreSQL Restore
```bash
gunzip -c backup_YYYYMMDD_HHMMSS.sql.gz | docker exec -i senora-postgres psql -U senora -d senora_db
```

---

## 6. Health Checks & Monitoring

- **Liveness Endpoint**: `GET /api/v1/health`  
  Returns:
  ```json
  {
    "status": "ok",
    "timestamp": "2026-01-01T00:00:00Z",
    "database": "connected"
  }
  ```
- **Process Memory & Concurrency**:
  Go server maintains bounded goroutine lifecycles for client connections (`readPump` and `writePump` terminate deterministically on network disconnect or context cancellation).

---

## 7. Additive Schema Migrations

The Go server automatically applies schema migrations on startup. For manual inspection or PostgreSQL pre-provisioning, migrations are in `database/migrations/` (including `000002_security_and_media.sql` for Conversation Security Modes, Voice Chat rooms, User-Created Stickers, Deletions, and Clears):

```bash
# SQLite Deployment (manual):
sqlite3 senora.db < database/migrations/000002_security_and_media.sql

# PostgreSQL Deployment (manual):
psql -U senora -d senora_db -f database/migrations/000002_security_and_media.sql
```

`000002_security_and_media.sql` is additive and non-destructive:
1. Adds `security_mode VARCHAR(32) NOT NULL DEFAULT 'normal'` to `conversations`.
2. Adds `creator_id` and `share_code` to `sticker_packs`.
3. Creates `voice_chat_rooms` and `voice_chat_participants`.
4. Creates `user_message_deletions` for per-user "Delete for Me" state.
5. Creates `user_conversation_clears` for per-user "Delete Chat for Me" state.

---

## 8. Self-Hosted Typography & Zero External Font CDN

SENORA frontend strictly avoids external third-party CDN font dependencies (such as Google Fonts or unpkg) to prevent tracking, latency, and air-gapped deployment failures.

- **Vazirmatn (Arabic/Persian)**: Included via `@fontsource/vazirmatn` (OFL-1.1 license), bundling WOFF2 and WOFF weights 400, 500, 600, and 700 directly into the frontend assets directory (`dist/assets/`).
- **Inter (Latin)**: Included via `@fontsource/inter` (OFL-1.1 license) weights 400, 500, 600, and 700.
- **Production Build**: When running `npm run build`, all fonts are hashed and compiled into `dist/assets/`. Nginx or static file servers should serve them with long-lived caching headers (`Cache-Control: public, max-age=31536000, immutable`).

---

## 9. Group Voice Chat Architecture & Signaling

- **Signaling Transport**: Uses SENORA's authenticated WebSocket gateway (`/api/v1/ws`) with server-authenticated `voice_chat.signal` event routing plus REST room lifecycle endpoints (`/api/v1/conversations/{id}/voice-chat`).
- **Mesh vs. SFU**:
  - Small group sessions (up to `MAX_MESH_PEERS = 8` concurrent peers) operate over the built-in WebRTC full mesh with Perfect Negotiation and per-peer `<audio>` playback.
  - Above 8 peers, clients display an architectural SFU notice; larger auditoriums (> 8 concurrent speakers) require integrating an external Selective Forwarding Unit (SFU) such as LiveKit or Janus (no external SFU token generator is implemented in the server today).


## Bot API and seekable streaming

See [BOT_API.md](BOT_API.md) and [STREAMING.md](STREAMING.md). Preserve persistent upload and
backup volumes when updating Compose; never use `docker compose down -v` to upgrade.
