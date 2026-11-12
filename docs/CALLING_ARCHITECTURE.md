# SENORA Real-Time Voice & Video Calling Architecture

## 1. Overview & Topologies

SENORA implements real-time audio, video, screen sharing, and group voice communications using WebRTC (DTLS-SRTP) with authenticated WebSocket signaling routed through the SENORA Go hub (`apps/server/internal/events/hub.go`).

### 1.1 One-to-One Calls (Peer-to-Peer WebRTC)
- **Topology**: Direct P2P (or TURN-relayed under symmetric NAT/firewalls) between caller and callee.
- **Media Security**: DTLS 1.2/1.3 and SRTP end-to-end between peer browsers. The Go backend forwards signaling payloads only and never terminates or stores media streams.
- **Dynamic ICE Provisioning (`GET /api/v1/webrtc/ice-servers`)**:
  - `STUN_SERVERS`: Comma-separated STUN URLs (default: Google, Cloudflare, Mozilla, and Nextcloud STUN servers; set `STUN_SERVERS=none` in isolated LAN/air-gapped environments).
  - `TURN_URL` / `TURN_SERVER_URL`: Comma-separated TURN/TURNS URLs (e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp`).
  - **Ephemeral Coturn HMAC Credentials**: When `TURN_AUTH_SECRET` is configured, `handleGetIceServers` generates per-user time-limited (`<expiry>:<user_id>`) HMAC-SHA1 credentials (default TTL `TURN_AUTH_TTL_SECONDS=86400`) without exposing shared static secrets. When `TURN_AUTH_SECRET` is unset, `TURN_USERNAME` / `TURN_CREDENTIAL` are used if present.
  - `ICE_SERVERS`: Optional raw JSON array of additional `RTCIceServer` entries.
- **SDP & Media Optimization**:
  - Client configures Opus (`minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000` or `256000` during screen share) and preserves RFC 4566 m-section line order.
  - Screen sharing (`getDisplayMedia`) swaps or upgrades the video transceiver via `replaceTrack` / renegotiation, supports adaptive/manual quality presets (`auto`, `1080p`, `720p`, `480p`), and mixes system/tab audio with microphone audio via Web Audio (`AudioContext.createMediaStreamDestination`) when shared audio tracks are captured.

### 1.2 Group Voice Chat (P2P Full-Mesh WebRTC)
- **Architecture**: Persistent, joinable audio rooms scoped to group conversations (`voice_chat_rooms`, `voice_chat_participants`).
- **REST Endpoints**:
  - `POST /api/v1/conversations/{id}/voice-chat` — Create or join active room (broadcasts `voice_chat.participant_joined`).
  - `GET /api/v1/conversations/{id}/voice-chat` — Fetch active room and participant list.
  - `POST /api/v1/conversations/{id}/voice-chat/state` — Sync mute (`is_muted`) and speaking (`is_speaking`) state (`voice_chat.participant_updated`).
  - `POST /api/v1/conversations/{id}/voice-chat/leave` — Leave room (`voice_chat.participant_left`).
  - `DELETE /api/v1/conversations/{id}/voice-chat` — End room for all participants (creator/owner/admin only; broadcasts authoritative `voice_chat.ended`).
- **Client Multi-Peer Mesh (`apps/web/src/features/calls/groupVoiceChatManager.ts`)**:
  - Maintains per-peer `RTCPeerConnection` links across active participants (`MAX_MESH_PEERS = 8`), using deterministic lexical offerer election (`currentUserId > remoteUserId`) and Perfect Negotiation rollback.
  - Renders per-peer `<audio autoplay playsInline data-vc-peer>` elements in DOM, applies preferred output sink (`setSinkId`), surfaces an explicit autoplay-unlock banner on `NotAllowedError`, and monitors real local/remote frequency levels via Web Audio `AnalyserNode`.
  - **Scaling Boundary**: The built-in P2P mesh warns above 8 concurrent peers (`meshWarning`). Large broadcasts/rooms (>8 active speakers) require integrating an external SFU (e.g., LiveKit or Janus); no external SFU token endpoint is shipped in the current codebase.

---

## 2. Signaling Protocol & State Machine

All WebRTC signaling messages travel over the authenticated WebSocket gateway (`/api/v1/ws`, 256 KB per-frame read limit):
```json
{
  "v": 1,
  "type": "call.signal",
  "payload": {
    "call_id": "call_1760000000_abcde",
    "conversation_id": "cnv_abc",
    "caller_id": "usr_alice",
    "receiver_id": "usr_bob",
    "call_type": "video",
    "signal_type": "invite",
    "data": { ... }
  }
}
```

### 2.1 1-on-1 Call Signal Types (`allowedCallSignalTypes`)
1. `invite`: Caller acquires mic (and optional camera) and initiates call (`outgoing_calling`). Server stamps `caller_id = c.userID`, enriches `caller_name`/`caller_avatar_url`, checks conversation membership & blocks, and forwards to receiver. If receiver has no active WS socket, server immediately sends `call.signal_status` (`status: "target_offline"`) to caller while still waiting up to timeout.
2. `ringing`: Callee acknowledges incoming invite (`incoming_ringing` -> caller transitions to `outgoing_ringing`). If callee is already in an active call, callee auto-responds `reject` (`reason: "busy"`).
3. `accept`: Callee acquires media, creates `RTCPeerConnection`, and notifies caller (`connecting` on both sides, 25s connection watchdog). Caller initiates primary `sdp_offer`.
4. `sdp_offer` / `sdp_answer`: Bilateral SDP negotiation following Perfect Negotiation (lexical `currentUserId < peerId` politeness, `makingOffer` glare detection, `setLocalDescription({ type: 'rollback' })`, plus pre-answer `pendingRemoteOffers` buffering on callee).
5. `ice_candidate`: Buffered in `iceCandidateQueue` whenever received before `remoteDescription` and drained immediately after `setRemoteDescription`.
6. Mid-call controls: `video_state` (toggling camera on/off including audio->video transceiver upgrade + renegotiation), `screen_share_start`, `screen_share_stop`, `screen_quality_change`, `screen_quality_request`, `ice_restart`.
7. **ICE Recovery & Termination**:
   - `disconnected` starts a 3.5s grace timer before attempting up to 2 `iceRestart: true` renegotiations; `wsManager.onConnectionChange` also triggers ICE restart on WebSocket reconnect when ICE is `disconnected`/`failed`.
   - Ringing times out after 35s (`timeout`/`missed`); connecting times out after 25s (`failed` with stage attribution `permissions`, `signaling`, `sdp`, `ice`, `turn_or_nat`, `playback`, or `blocked`).
   - `cancel` (pre-answer), `reject`, `hangup`, `pagehide`, and user logout tear down all local `MediaStreamTrack`s, Web Audio contexts, and `RTCPeerConnection` instances.

### 2.2 Group Voice Chat Signaling (`voice_chat.signal`)
- Server validates conversation membership, active room existence (`room.IsActive && room.ID == vcSignal.RoomID`), and active participation in the room (except `peer_left`).
- Server overwrites `SenderUserID = c.userID` and restricts `SignalType` to `peer_joined`, `peer_left`, `sdp_offer`, `sdp_answer`, `ice_candidate`. Forged `room_ended` frames are dropped.

---

## 3. Security Boundaries, E2EE & Call History

1. **Membership & Identity Enforcement**: Both sender and target user must belong to `conversation_id`. Caller/sender IDs cannot be spoofed across WebSocket frames.
2. **Bidirectional Block Check**: `hub.go` enforces `IsUserBlocked` in both directions and sends `call.signal_status: "blocked"` to the caller on blocked invites.
3. **Call Logs & Zero-Plaintext E2EE Invariant (`POST /api/v1/calls/logs`)**:
   - Upserts into `call_logs` idempotently by `call_id` (`ON CONFLICT (id) DO UPDATE`) so dual submissions from caller and callee produce one record.
   - In standard chats (`security_mode != "e2ee_active"`), writes at most one in-chat `call_event` system bubble deduplicated per `(conversation_id, "call_event_" + call_id)`.
   - In **`e2ee_active`** chats, server strictly records structured `call_logs` metadata only and writes **zero** plaintext `call_event` messages.
4. **Reverse-Proxy WSS Origin Security**: WebSocket `CheckOrigin` honors `ALLOWED_ORIGINS` and verifies HTTPS origins behind TLS-terminating Nginx/Caddy proxies via `X-Forwarded-Proto` **only** when `r.RemoteAddr` matches a trusted proxy (`TRUSTED_PROXIES` or `TRUST_PROXY=true` loopback).
