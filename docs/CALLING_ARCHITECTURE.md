# Senora Real-Time Voice & Video Calling Architecture

## 1. Overview & Topologies

NexaChat implements real-time audio and video communications through WebRTC standards with authenticated signaling mediated by the NexaChat WebSocket gateway.

### 1.1 One-to-One Calls (Peer-to-Peer WebRTC)
- **Topology**: Full peer-to-peer (P2P) direct media connection between caller and callee devices.
- **Media Security**: DTLS 1.2/1.3 and SRTP (AES-128-GCM / AES-256-GCM) end-to-end between browsers. The server routes signaling only and never touches media packets.
- **NAT Traversal**: Configured with standard public STUN servers (`stun:stun.l.google.com:19302`) and optional self-hosted TURN credentials.

### 1.2 Group Voice Chat (Track B — Implemented in Phase 9)
- **Status**: **IMPLEMENTED AND VERIFIED**
- **Architecture**: Persistent, joinable audio rooms attached to group conversations.
- **Backend Room Lifecycle**:
  - `voice_chat_rooms` table tracks active rooms, creator, title, timestamps, and termination markers.
  - `voice_chat_participants` table maintains joined participants, mute status, speaking activity, and departure timestamps.
  - Endpoints: `POST /conversations/{id}/voice-chat` (start/join), `GET /conversations/{id}/voice-chat` (status), `POST /conversations/{id}/voice-chat/state` (mute/speaking update), `POST /conversations/{id}/voice-chat/leave`, `DELETE /conversations/{id}/voice-chat` (end room).
- **Client Real-Time Audio & Web Audio API**:
  - Client requests microphone access via `navigator.mediaDevices.getUserMedia({ audio: true })`.
  - Web Audio `AudioContext` and `AnalyserNode` compute actual microphone volume levels in real time to display dynamic green speaking waveforms.
  - Multi-peer WebSocket signaling (`voice_chat.signal`) synchronizes join/leave events, state changes, and bilaterally routes WebRTC offers/answers/ICE candidates among room participants.
- **Production SFU Scale-Out (LiveKit / Janus)**:
  - For larger rooms (>8 participants), the backend issues short-lived scoped JWT room tokens (`/api/v1/conversations/{id}/voice-chat/token`) to connect to an external SFU daemon, keeping API secrets exclusively on the server.

---

## 2. Signaling Protocol Specification

Call signaling messages are routed over the authenticated WebSocket connection using the envelope structure:
```json
{
  "v": 1,
  "type": "call.signal",
  "payload": {
    "call_id": "call_123456",
    "conversation_id": "cnv_abc",
    "caller_id": "usr_alice",
    "receiver_id": "usr_bob",
    "call_type": "audio",
    "signal_type": "invite",
    "data": {}
  }
}
```

### Signal Types & State Machine:
1. `invite`: Caller initiates a call. Server verifies caller and receiver share `conversation_id`, logs `call_logs` with status `initiating`, and sends `call.incoming` event to receiver.
2. `ringing`: Receiver device alerts user and sends `ringing` status back to caller.
3. `accept`: Receiver accepts call. Caller creates WebRTC Offer.
4. `sdp_offer`: Caller sends Session Description Protocol offer; server forwards to receiver.
5. `sdp_answer`: Receiver sets remote description and sends SDP answer back to caller.
6. `ice_candidate`: Candidates exchanged bilaterally until connection state reaches `connected`.
7. `hangup` / `reject`: Either party terminates call. Media streams are stopped, peer connection is closed, and call log duration is finalized.

---

## 3. Security Boundaries & Authorization Rules

1. **Conversation Membership Validation**: Before forwarding any signaling event, the backend validates that both the caller and receiver are active members of the associated conversation. Non-members cannot initiate or intercept call signals.
2. **Device Media Permissions**: Camera and microphone access is explicitly checked via `navigator.mediaDevices.getUserMedia`. Denied permissions transition the call to `failed` with clear user feedback.
3. **Resource Teardown**: On hangup, rejection, or connection drop, all audio and video tracks (`MediaStreamTrack.stop()`) are stopped, and `RTCPeerConnection.close()` is invoked to prevent background microphone or camera access.
