# DEPLOYMENT & OPERATIONS GUIDE — Senora

This guide covers deployment options, environment variables, reverse-proxy configurations, STUN/TURN calling infrastructure, backup procedures, and troubleshooting for self-hosted Senora instances.

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
| `DB_DRIVER` | No | `sqlite` | Database engine: `sqlite` or `postgres`. |
| `DB_DSN` | Yes | `file:senora.db?cache=shared` | Database connection string. For PostgreSQL: `postgres://user:pass@host:5432/dbname?sslmode=disable`. |
| `ALLOWED_ORIGINS` | No | `*` | Comma-separated list of allowed origins for CORS and CSWSH WebSocket validation (e.g., `https://chat.example.com`). |
| `MAX_UPLOAD_BYTES` | No | `104857600` | Maximum file upload size limit (defaults to 100MB). |
| `STUN_SERVERS` | No | `stun:stun.l.google.com:19302` | Comma-separated STUN server URLs for WebRTC peer-to-peer media negotiation. |
| `TURN_URL` | No | `""` | TURN server URL for symmetric NAT traversal (e.g. `turn:turn.example.com:3478`). |
| `TURN_USERNAME` | No | `""` | Short-lived TURN authentication username. |
| `TURN_CREDENTIAL` | No | `""` | Short-lived TURN authentication password. |
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
    client_max_body_size 105M;

    # REST API endpoints
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket Gateway with upgrade headers
    location /api/v1/ws {
        proxy_pass http://127.0.0.1:8080/api/v1/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
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

For reliable 1-to-1 audio and video calls across cellular networks or strict enterprise firewalls, deploy a Coturn TURN server:

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
realm=chat.example.com
use-auth-secret
static-auth-secret=REPLACE_WITH_STRONG_RANDOM_SECRET
cert=/etc/letsencrypt/live/chat.example.com/cert.pem
pkey=/etc/letsencrypt/live/chat.example.com/privkey.pem
no-tcp-relay
```

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
    "timestamp": "2026-10-11T11:00:00Z",
    "database": "connected"
  }
  ```
- **Process Memory & Concurrency**:
  Go server maintains bounded goroutine lifecycles for client connections (`readPump` and `writePump` terminate deterministically on network disconnect or context cancellation).

---

## 7. Phase 9 Database Migrations

For Phase 9 features (Conversation Security Modes, Voice Chat rooms, User-Created Stickers, Deletions, and Clears), apply the additive migration:

```bash
# SQLite Deployment:
# The server automatically applies migrations or alterations on startup, or manually:
sqlite3 senora.db < database/migrations/000002_phase9.sql

# PostgreSQL Deployment:
psql -U senora -d senora_db -f database/migrations/000002_phase9.sql
```

The migration is non-destructive:
1. Adds `security_mode VARCHAR(32) NOT NULL DEFAULT 'normal'` to `conversations`.
2. Adds `creator_id` and `share_code` to `sticker_packs`.
3. Creates `voice_chat_rooms` and `voice_chat_participants`.
4. Creates `user_message_deletions` for per-user "Delete for Me" state.
5. Creates `user_conversation_clears` for per-user "Delete Chat for Me" state.

---

## 8. Self-Hosted Typography & Zero External Font CDN

Senora frontend strictly avoids external third-party CDN font dependencies (such as Google Fonts or unpkg) to prevent tracking, latency, and air-gapped deployment failures.

- **Vazirmatn (Arabic/Persian)**: Included via `@fontsource/vazirmatn` (OFL-1.1 license), bundling WOFF2 and WOFF weights 400, 500, 600, and 700 directly into the frontend assets directory (`dist/assets/`).
- **Inter (Latin)**: Included via `@fontsource/inter` (OFL-1.1 license) weights 400, 500, 600, and 700.
- **Production Build**: When running `npm run build`, all fonts are hashed and compiled into `dist/assets/`. Nginx or static file servers should serve them with long-lived caching headers (`Cache-Control: public, max-age=31536000, immutable`).

---

## 9. Group Voice Chat Architecture & Signaling

- **Signaling Transport**: Uses Senora's existing authenticated WebSocket gateway (`/api/v1/ws`) with `voice_chat.signal` event routing.
- **Mesh vs. SFU**:
  - Small group sessions (≤ 6 concurrent speakers) can operate over the built-in authenticated WebSocket signaling mesh.
  - For large auditoriums or high-scale group voice sessions (> 10 participants), configure an external Selective Forwarding Unit (SFU) such as LiveKit or Janus. Token generation endpoints are designed to scope credentials to the authenticated user and conversation ID without exposing administrative secrets to browser clients.

