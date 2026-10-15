# PROTOCOL SPECIFICATION — Senora v1

## 1. REST API Contracts (`/api/v1`)

All requests accept and return `application/json` (unless binary upload). Standard error format:
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or expired session token",
    "request_id": "req-12345"
  }
}
```

### Core Authentication & Sessions
- `POST /api/v1/auth/register`: Register account, returns session token and device ID.
- `POST /api/v1/auth/login`: Authenticate with Argon2id hash verification.
- `GET /api/v1/auth/me`: Get current authenticated user profile.
- `POST /api/v1/auth/logout`: Revoke active session token and close active device WebSocket connections.

### Conversations & Messages
- `GET /api/v1/conversations`: Returns conversations for current user.
- `POST /api/v1/conversations`: Create direct, group, or broadcast channel. Defaults to `security_mode = "normal"`.
- `POST /api/v1/conversations/{id}/security-mode`: Transition conversation security mode (`normal` -> `e2ee_active`).
- `DELETE /api/v1/conversations/{id}?scope=me|both`:
  - `scope=me`: Clears conversation history for the requesting user while preserving peer copy.
  - `scope=both`: Purges shared conversation history for both participants (authorized for direct chats or group admins).
- `GET /api/v1/conversations/{id}/messages?limit=50`: Paginated message history, filtering out messages deleted for the requesting user or cleared prior to user's clear timestamp.
- `POST /api/v1/conversations/{id}/messages`: Submit message envelope. Supports server-readable Normal Chat payloads (`nonce = "normal"`) and E2EE Signal envelopes.
- `PUT /api/v1/conversations/{id}/messages/{msgId}`: Edit message ciphertext.
- `DELETE /api/v1/conversations/{id}/messages/{msgId}?scope=me|everyone`:
  - `scope=me`: Hides message from requesting user's view via persistent record in `user_message_deletions`.
  - `scope=everyone`: Soft-deletes message tombstone for all participants.
- `POST /api/v1/conversations/{id}/messages/{msgId}/reactions`: Toggle emoji reaction.
- `POST /api/v1/conversations/{id}/pin`: Pin or unpin message in conversation banner.

### Group Voice Chat (Track B)
- `POST /api/v1/conversations/{id}/voice-chat`: Start or join group voice chat room.
- `GET /api/v1/conversations/{id}/voice-chat`: Get active room details and current participants.
- `POST /api/v1/conversations/{id}/voice-chat/leave`: Leave active voice chat room.
- `POST /api/v1/conversations/{id}/voice-chat/state`: Update microphone state (`is_muted`, `is_speaking`).
- `DELETE /api/v1/conversations/{id}/voice-chat`: End voice chat room for all participants (host / admin).

### Profile Avatars (Track C)
- `POST /api/v1/users/avatar`: Upload, validate, crop, and store user avatar image.
- `DELETE /api/v1/users/avatar`: Remove current profile avatar and restore default placeholder.
- `GET /api/v1/attachments/avatar/{filename}`: Serve authenticated profile avatar.

### Stickers, Custom Packs & Animated Media (Track E & F)
- `GET /api/v1/stickers/packs`: List all available sticker packs in the catalog.
- `POST /api/v1/stickers/packs`: Create and publish a custom user sticker pack with share code.
- `GET /api/v1/stickers/packs/{id}`: Get sticker pack details and stickers.
- `GET /api/v1/stickers/share/{code}`: Resolve a shared sticker pack by share code.
- `POST /api/v1/stickers/installed/{id}`: Install sticker pack for current user.
- `DELETE /api/v1/stickers/installed/{id}`: Uninstall sticker pack for current user.
- `GET /api/v1/stickers/installed`: Get installed sticker packs for current user.
- `GET /api/v1/media/gifs?q=query`: Search animated GIFs via curated provider catalog.

### WebRTC Call History
- `GET /api/v1/calls/logs`: Get recent 1-to-1 audio and video call history for current user.
- `POST /api/v1/calls/logs`: Record completed, missed, or rejected call entry.

---

## 2. WebSocket Gateway Protocol (`/api/v1/ws`)

### Connection Handshake
- Client connects to `wss://host/api/v1/ws?token=sess_tok_...`
- Origin header validated against `ALLOWED_ORIGINS` to protect against CSWSH.
- Server verifies token, extracts `user_id` and `device_id`, registers connection into active session registry.

### Envelope Structure
Every frame over WebSocket uses a structured JSON envelope:
```json
{
  "v": 1,
  "type": "event_or_request_name",
  "id": "env_uuid",
  "cursor": 42,
  "payload": {}
}
```

### Event Types

#### 1. Liveness & Heartbeat
- `ping`: Sent by client every 25 seconds.
- `pong`: Responded by server.

#### 2. Event Sync & Cursor Catch-Up
- `sync.request`: Sent on reconnect with `last_event_id` cursor to replay missed outbox events.

#### 3. Ephemeral Typing Indicator
- Type: `typing`
- Client payload:
  ```json
  {
    "conversation_id": "conv_123",
    "is_typing": true
  }
  ```
- Broadcast payload (to conversation members):
  ```json
  {
    "conversation_id": "conv_123",
    "user_id": "usr_456",
    "is_typing": true
  }
  ```

#### 4. WebRTC 1-to-1 Call Signaling
- Type: `call.signal`
- Payload:
  ```json
  {
    "call_id": "call_179170...",
    "conversation_id": "conv_123",
    "caller_id": "usr_alice",
    "receiver_id": "usr_bob",
    "call_type": "audio",
    "signal_type": "invite",
    "data": { "peer_name": "Alice" }
  }
  ```
- Allowed `signal_type` values:
  - `invite`: Outgoing call invitation.
  - `ringing`: Callee phone ringing acknowledgment.
  - `accept`: Callee answered call.
  - `reject`: Callee declined call.
  - `hangup`: Either party terminated call.
  - `sdp_offer`: WebRTC SDP offer negotiation.
  - `sdp_answer`: WebRTC SDP answer negotiation.
  - `ice_candidate`: WebRTC ICE candidate exchange.
- Authorization: Server validates sender is a member of `conversation_id` and is either `caller_id` or `receiver_id`.

#### 5. Group Voice Chat Signaling (Track B)
- Type: `voice_chat.signal`
- Payload:
  ```json
  {
    "conversation_id": "conv_group_123",
    "room_id": "vc_room_456",
    "sender_id": "usr_alice",
    "target_user_id": "usr_bob",
    "signal_type": "peer_joined",
    "data": {}
  }
  ```
- Allowed `signal_type` values:
  - `peer_joined`: Participant joined the audio room.
  - `peer_left`: Participant left the audio room.
  - `state_change`: Microphone or speaking indicator updated.
  - `room_ended`: Voice room terminated by creator or admin.
  - `sdp_offer` / `sdp_answer` / `ice_candidate`: Peer-to-peer audio mesh negotiation.
- Authorization: Sender must be an active member of `conversation_id`. Cross-conversation signal leakage is strictly rejected.

#### 6. Deletion & Mode Outbox Events (Tracks A, G, H, I)
- `message.deleted_for_me`: Dispatched to caller devices when a message is hidden for oneself.
- `message.deleted`: Dispatched to all conversation participants when message is soft-deleted for everyone.
- `conversation.cleared`: Dispatched to caller devices when chat is cleared for me.
- `conversation.deleted`: Dispatched to conversation participants when chat is deleted for both.
- `conversation.security_mode`: Dispatched to conversation members when security mode changes (`normal` -> `e2ee_active`).

---

## 3. End-to-End Encryption (E2EE) Envelopes

### Signal Protocol Multi-Device Fan-Out Envelope
For direct private messaging, text and attachment metadata are encrypted with the Double Ratchet / X3DH for each recipient device:
```json
{
  "v": 1,
  "sender_device_id": "dev_alice_01",
  "sender_public_key": "base64_identity_key",
  "devices": {
    "dev_bob_01": {
      "ciphertext": "base64_signal_ciphertext",
      "nonce": "signal_type"
    },
    "dev_alice_02": {
      "ciphertext": "base64_signal_ciphertext",
      "nonce": "signal_type"
    }
  }
}
```

### Rich Message Payload Inside E2EE Envelope
The decrypted plaintext of private messages contains a structured JSON payload:
```json
{
  "type": "attachment",
  "text": "Optional caption or file name",
  "attachment": {
    "id": "att_12345",
    "filename": "photo.jpg",
    "contentType": "image/jpeg",
    "sizeBytes": 2048500,
    "keyBase64": "base64_aes256_symmetric_key",
    "ivBase64": "base64_96bit_nonce",
    "isPhoto": true,
    "isVideo": false,
    "isVoice": false,
    "isRoundVideo": false,
    "isSticker": false,
    "caption": "Sunset at the beach"
  }
}
```
For stickers:
```json
{
  "type": "sticker",
  "text": "🚀",
  "attachment": {
    "isSticker": true,
    "stickerPackId": "pack_nexa_classic",
    "stickerId": "stk_nexa_rocket",
    "stickerUrl": "data:image/svg+xml;utf8,..."
  }
}
```
For round video notes:
```json
{
  "type": "video_note",
  "text": "Video Note",
  "attachment": {
    "id": "att_67890",
    "filename": "video_note_123.webm",
    "contentType": "video/webm",
    "sizeBytes": 1048576,
    "keyBase64": "...",
    "ivBase64": "...",
    "isRoundVideo": true
  }
}
```
