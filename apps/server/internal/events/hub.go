package events

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"senora/server/internal/models"
	"senora/server/internal/storage"
)

func isTrustedProxyRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	rawRemote := strings.TrimSpace(r.RemoteAddr)
	if host, _, err := net.SplitHostPort(rawRemote); err == nil {
		rawRemote = host
	}
	rawRemote = strings.TrimPrefix(strings.TrimSuffix(rawRemote, "]"), "[")
	parsed := net.ParseIP(rawRemote)
	if parsed == nil {
		return false
	}
	if v4 := parsed.To4(); v4 != nil {
		parsed = v4
	}

	if trusted := strings.TrimSpace(os.Getenv("TRUSTED_PROXIES")); trusted != "" {
		for _, tp := range strings.Split(trusted, ",") {
			tp = strings.TrimSpace(tp)
			if tp == "" {
				continue
			}
			if _, cidr, err := net.ParseCIDR(tp); err == nil {
				if cidr.Contains(parsed) {
					return true
				}
			} else if cand := net.ParseIP(tp); cand != nil && cand.Equal(parsed) {
				return true
			}
		}
		return false
	}

	if strings.EqualFold(strings.TrimSpace(os.Getenv("TRUST_PROXY")), "true") {
		return parsed.IsLoopback()
	}
	return false
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  64 * 1024,
	WriteBufferSize: 64 * 1024,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			// Documented Native Client Policy:
			// Non-browser clients (native desktop/mobile, CLI, automated workers)
			// do not send the browser-enforced 'Origin' header. Handshake authentication
			// is enforced via the mandatory session token query parameter.
			return true
		}

		u, err := url.Parse(origin)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return false
		}

		// Scheme must be strictly http or https (blocks javascript:, data:, file:, etc.)
		if u.Scheme != "http" && u.Scheme != "https" {
			return false
		}

		originHost := u.Hostname()
		originPort := u.Port()
		if originPort == "" {
			if u.Scheme == "https" {
				originPort = "443"
			} else {
				originPort = "80"
			}
		}

		effectiveHTTPS := r.TLS != nil
		if !effectiveHTTPS && isTrustedProxyRequest(r) {
			if strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
				effectiveHTTPS = true
			}
		}

		// Extract request host and port; use X-Forwarded-Proto only from trusted proxies
		reqHost := r.Host
		reqPort := ""
		if h, p, err := net.SplitHostPort(r.Host); err == nil {
			reqHost = h
			reqPort = p
		} else {
			if effectiveHTTPS {
				reqPort = "443"
			} else {
				reqPort = "80"
			}
		}

		// Check explicit allowed origins from environment (comma-separated exact origins)
		if allowed := os.Getenv("ALLOWED_ORIGINS"); allowed != "" {
			for _, ao := range strings.Split(allowed, ",") {
				ao = strings.TrimSpace(ao)
				if ao == "" {
					continue
				}
				if strings.EqualFold(origin, ao) || strings.EqualFold(u.Host, ao) {
					return true
				}
			}
		}

		// Strict localhost / loopback matching (exact equality only)
		if originHost == "localhost" || originHost == "127.0.0.1" || originHost == "::1" {
			return true
		}

		// Same-origin matching: scheme, host, and port must match
		if strings.EqualFold(originHost, reqHost) && originPort == reqPort {
			if effectiveHTTPS && u.Scheme != "https" {
				return false
			}
			return true
		}

		return false
	},
}

type ClientEnvelope struct {
	V       int             `json:"v"`
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Cursor  int64           `json:"cursor,omitempty"`
	Replay  bool            `json:"replay"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type SyncRequestPayload struct {
	LastEventID int64 `json:"last_event_id"`
}

type ClientConnection struct {
	hub      *Hub
	conn     *websocket.Conn
	userID   string
	deviceID string
	send     chan []byte
}

type Hub struct {
	store       storage.Store
	mu          sync.RWMutex
	userClients map[string]map[*ClientConnection]bool // userID -> set of connections
	broadcast   chan *models.EventOutbox
	register    chan *ClientConnection
	unregister  chan *ClientConnection
}

func NewHub(store storage.Store) *Hub {
	return &Hub{
		store:       store,
		userClients: make(map[string]map[*ClientConnection]bool),
		broadcast:   make(chan *models.EventOutbox, 256),
		register:    make(chan *ClientConnection),
		unregister:  make(chan *ClientConnection),
	}
}

func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return

		case client := <-h.register:
			h.mu.Lock()
			prevCount := len(h.userClients[client.userID])
			if _, ok := h.userClients[client.userID]; !ok {
				h.userClients[client.userID] = make(map[*ClientConnection]bool)
			}
			h.userClients[client.userID][client] = true
			isFirstConnection := prevCount == 0
			h.mu.Unlock()

			if client.deviceID != "" {
				_ = h.store.UpdateDeviceLastSeen(context.Background(), client.deviceID)
			}
			if isFirstConnection {
				go h.BroadcastUserPresence(client.userID, true, time.Time{})
			}

		case client := <-h.unregister:
			h.mu.Lock()
			var isLastConnection bool
			if clients, ok := h.userClients[client.userID]; ok {
				delete(clients, client)
				close(client.send)
				if len(clients) == 0 {
					delete(h.userClients, client.userID)
					isLastConnection = true
				}
			}
			h.mu.Unlock()

			if client.deviceID != "" {
				_ = h.store.UpdateDeviceLastSeen(context.Background(), client.deviceID)
			}
			if isLastConnection {
				now := time.Now().UTC()
				go h.BroadcastUserPresence(client.userID, false, now)
			}

		case event := <-h.broadcast:
			h.mu.RLock()
			clients := h.userClients[event.RecipientUserID]
			env := ClientEnvelope{
				V:       1,
				Type:    event.EventType,
				ID:      uuid.New().String(),
				Cursor:  event.ID,
				Payload: json.RawMessage(storage.RedactLegacyWhisperEvent(ctx, h.store, event.Payload, event.RecipientUserID)),
			}
			data, err := json.Marshal(env)
			if err == nil {
				for client := range clients {
					select {
					case client.send <- data:
					default:
						// Buffer full; client lagging
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

// PublishEvent routes an outbox event to connected clients.
func (h *Hub) PublishEvent(event *models.EventOutbox) {
	select {
	case h.broadcast <- event:
	default:
		log.Printf("Warning: broadcast channel full, dropping event %d", event.ID)
	}
}

// DisconnectDevice closes active WebSocket connections for a specific user device.
// Other devices belonging to the same user remain connected.
func (h *Hub) DisconnectDevice(userID, deviceID string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if clients, ok := h.userClients[userID]; ok {
		for client := range clients {
			if client.deviceID == deviceID {
				client.conn.Close()
			}
		}
	}
}

// DisconnectUser immediately closes active WebSocket connections for a user across all devices.
func (h *Hub) DisconnectUser(userID string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if clients, ok := h.userClients[userID]; ok {
		for client := range clients {
			client.conn.Close()
		}
	}
}

// IsUserOnline returns true if the user currently has at least one active WebSocket connection.
func (h *Hub) OnlineUserCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.userClients)
}

func (h *Hub) IsUserOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	clients, ok := h.userClients[userID]
	return ok && len(clients) > 0
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request, userID, deviceID string) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade websocket: %v", err)
		return
	}

	client := &ClientConnection{
		hub:      h,
		conn:     conn,
		userID:   userID,
		deviceID: deviceID,
		send:     make(chan []byte, 128),
	}

	h.register <- client

	go client.writePump()
	go client.readPump()
}

// SendToUser routes a client envelope directly to all active connections of a specific user.
func (h *Hub) SendToUser(userID string, env ClientEnvelope) {
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	h.mu.RLock()
	clients := h.userClients[userID]
	for client := range clients {
		select {
		case client.send <- data:
		default:
		}
	}
	h.mu.RUnlock()
}

func (h *Hub) BroadcastToConversation(convID string, env ClientEnvelope) {
	members, err := h.store.GetConversationMembers(context.Background(), convID)
	if err != nil {
		return
	}
	for _, m := range members {
		h.SendToUser(m, env)
	}
}

// BroadcastUserPresence notifies all users sharing conversations with userID about the presence change.
func (h *Hub) BroadcastUserPresence(userID string, isOnline bool, lastSeenAt time.Time) {
	// Authoritative concurrency guard: ensure user's actual live state matches
	// the intended transition. If the user rapidly disconnected & reconnected,
	// do not let a delayed goroutine broadcast a stale state.
	if h.IsUserOnline(userID) != isOnline {
		return
	}

	convs, err := h.store.ListConversationsForUser(context.Background(), userID)
	if err != nil {
		return
	}

	payloadMap := map[string]interface{}{
		"user_id":   userID,
		"is_online": isOnline,
	}
	if !lastSeenAt.IsZero() {
		payloadMap["last_seen_at"] = lastSeenAt.Format(time.RFC3339Nano)
	}
	payloadBytes, _ := json.Marshal(payloadMap)

	env := ClientEnvelope{
		V:       1,
		Type:    "presence.update",
		ID:      uuid.New().String(),
		Payload: payloadBytes,
	}

	notified := make(map[string]bool)
	for _, conv := range convs {
		members, err := h.store.GetConversationMembers(context.Background(), conv.ID)
		if err != nil {
			continue
		}
		for _, memberID := range members {
			if memberID != userID && !notified[memberID] && storage.CanViewUserField(context.Background(), h.store, userID, memberID, "lastSeenVisibility") {
				notified[memberID] = true
				h.SendToUser(memberID, env)
			}
		}
	}
}

type TypingPayload struct {
	ConversationID string `json:"conversation_id"`
	IsTyping       bool   `json:"is_typing"`
}

type TypingBroadcastPayload struct {
	ConversationID string `json:"conversation_id"`
	UserID         string `json:"user_id"`
	IsTyping       bool   `json:"is_typing"`
}

type CallSignalStatusPayload struct {
	CallID         string `json:"call_id"`
	ConversationID string `json:"conversation_id"`
	TargetUserID   string `json:"target_user_id"`
	Status         string `json:"status"`
}

type VoiceChatSignalPayload struct {
	RoomID         string      `json:"room_id"`
	ConversationID string      `json:"conversation_id"`
	SenderUserID   string      `json:"sender_user_id"`
	TargetUserID   string      `json:"target_user_id,omitempty"`
	SignalType     string      `json:"signal_type"`
	Data           interface{} `json:"data,omitempty"`
}

var allowedCallSignalTypes = map[string]bool{
	"invite":                 true,
	"ringing":                true,
	"accept":                 true,
	"reject":                 true,
	"hangup":                 true,
	"cancel":                 true,
	"sdp_offer":              true,
	"sdp_answer":             true,
	"ice_candidate":          true,
	"screen_share_start":     true,
	"screen_share_stop":      true,
	"screen_quality_change":  true,
	"screen_quality_request": true,
	"video_state":            true,
	"ice_restart":            true,
}

var allowedVoiceChatSignalTypes = map[string]bool{
	"peer_joined":   true,
	"peer_left":     true,
	"sdp_offer":     true,
	"sdp_answer":    true,
	"ice_candidate": true,
}

func (h *Hub) sendCallSignalStatus(userID, callID, conversationID, targetUserID, status string) {
	payloadBytes, err := json.Marshal(CallSignalStatusPayload{
		CallID:         callID,
		ConversationID: conversationID,
		TargetUserID:   targetUserID,
		Status:         status,
	})
	if err != nil {
		return
	}
	h.SendToUser(userID, ClientEnvelope{
		V:       1,
		Type:    "call.signal_status",
		ID:      uuid.New().String(),
		Payload: payloadBytes,
	})
}

func (c *ClientConnection) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(256 * 1024)
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		var env ClientEnvelope
		if err := json.Unmarshal(message, &env); err != nil {
			continue
		}

		switch env.Type {
		case "ping":
			c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			pongEnv := ClientEnvelope{V: 1, Type: "pong", ID: env.ID}
			if resp, err := json.Marshal(pongEnv); err == nil {
				select {
				case c.send <- resp:
				default:
				}
			}

		case "sync.request":
			var syncReq SyncRequestPayload
			if err := json.Unmarshal(env.Payload, &syncReq); err == nil {
				// Bound the replay to the snapshot at handshake time. Later events
				// arrive through live publication or the next reconnect.
				head, err := c.hub.store.GetOutboxHead(context.Background(), c.userID)
				if err != nil {
					continue
				}
				for syncReq.LastEventID < head {
					events, err := c.hub.store.GetOutboxEventsAfter(context.Background(), c.userID, syncReq.LastEventID, 100)
					if err != nil {
						break
					}
					if len(events) == 0 {
						break
					}
					for _, ev := range events {
						if ev.ID > head {
							break
						}
						replayEnv := ClientEnvelope{
							V:       1,
							Type:    ev.EventType,
							ID:      uuid.New().String(),
							Cursor:  ev.ID,
							Replay:  true,
							Payload: json.RawMessage(storage.RedactLegacyWhisperEvent(context.Background(), c.hub.store, ev.Payload, c.userID)),
						}
						if resp, err := json.Marshal(replayEnv); err == nil {
							select {
							case c.send <- resp:
							case <-time.After(10 * time.Second):
								return
							}
						}
					}
					syncReq.LastEventID = events[len(events)-1].ID
					if len(events) < 100 {
						break
					}
				}
			}

		case "call.signal":
			var signalReq models.CallSignalPayload
			if err := json.Unmarshal(env.Payload, &signalReq); err == nil {
				if signalReq.ConversationID == "" || signalReq.CallID == "" {
					continue
				}
				if !allowedCallSignalTypes[signalReq.SignalType] {
					log.Printf("Security: rejected disallowed call signal type %q from user %s", signalReq.SignalType, c.userID)
					continue
				}

				// Security check: authenticated sender must be a member of the conversation
				isMember, err := c.hub.store.IsMember(context.Background(), signalReq.ConversationID, c.userID)
				if err != nil || !isMember {
					log.Printf("Security: user %s attempted call signal in unjoined conversation %s", c.userID, signalReq.ConversationID)
					continue
				}

				var targetUserID string

				if signalReq.SignalType == "invite" {
					// On call initiation, sender is strictly the caller (prevent spoofing)
					signalReq.CallerID = c.userID
					targetUserID = signalReq.ReceiverID
					if targetUserID == "" || targetUserID == c.userID {
						log.Printf("Invalid call invite: target is empty or self")
						continue
					}

					// Enrich caller profile in Data if caller user details exist
					callerUser, err := c.hub.store.GetUserByID(context.Background(), c.userID)
					if err == nil && callerUser != nil {
						dataMap, ok := signalReq.Data.(map[string]interface{})
						if !ok || dataMap == nil {
							dataMap = make(map[string]interface{})
						}
						callerName := callerUser.DisplayName
						if callerName == "" {
							callerName = callerUser.Username
						}
						dataMap["caller_name"] = callerName
						dataMap["caller_avatar_url"] = callerUser.AvatarURL
						signalReq.Data = dataMap
					}
				} else {
					// For subsequent signals (ringing, accept, reject, hangup, cancel, sdp_offer, sdp_answer, ice_candidate, etc.)
					if signalReq.ReceiverID == "" && signalReq.CallerID != "" {
						signalReq.ReceiverID = c.userID
						targetUserID = signalReq.CallerID
					} else if signalReq.CallerID == "" && signalReq.ReceiverID != "" {
						signalReq.CallerID = c.userID
						targetUserID = signalReq.ReceiverID
					} else {
						// Both are set: sender must be either caller or receiver
						if signalReq.CallerID != c.userID && signalReq.ReceiverID != c.userID {
							log.Printf("Security: user %s attempted to forge call signal for %s -> %s", c.userID, signalReq.CallerID, signalReq.ReceiverID)
							continue
						}
						if c.userID == signalReq.CallerID {
							targetUserID = signalReq.ReceiverID
						} else {
							targetUserID = signalReq.CallerID
						}
					}
				}

				if targetUserID == "" || targetUserID == c.userID {
					log.Printf("Invalid call signal: target user %q is invalid", targetUserID)
					continue
				}

				// Target must also be a member of the conversation
				targetIsMember, err := c.hub.store.IsMember(context.Background(), signalReq.ConversationID, targetUserID)
				if err != nil || !targetIsMember {
					log.Printf("Security: target user %s is not a member of conversation %s", targetUserID, signalReq.ConversationID)
					continue
				}

				// Bidirectional block enforcement
				blockedAB, _ := c.hub.store.IsUserBlocked(context.Background(), c.userID, targetUserID)
				blockedBA, _ := c.hub.store.IsUserBlocked(context.Background(), targetUserID, c.userID)
				if blockedAB || blockedBA {
					if signalReq.SignalType == "invite" {
						c.hub.sendCallSignalStatus(c.userID, signalReq.CallID, signalReq.ConversationID, targetUserID, "blocked")
					}
					continue
				}

				sanitizedPayload, err := json.Marshal(signalReq)
				if err != nil {
					continue
				}

				if signalReq.SignalType == "invite" && !c.hub.IsUserOnline(targetUserID) {
					c.hub.sendCallSignalStatus(c.userID, signalReq.CallID, signalReq.ConversationID, targetUserID, "target_offline")
				}

				c.hub.SendToUser(targetUserID, ClientEnvelope{
					V:       1,
					Type:    "call.signal",
					ID:      uuid.New().String(),
					Payload: sanitizedPayload,
				})
			}

		case "voice_chat.signal":
			var vcSignal VoiceChatSignalPayload
			if err := json.Unmarshal(env.Payload, &vcSignal); err == nil {
				if vcSignal.ConversationID == "" || vcSignal.RoomID == "" {
					continue
				}
				if !allowedVoiceChatSignalTypes[vcSignal.SignalType] {
					log.Printf("Security: rejected disallowed voice_chat signal type %q from user %s", vcSignal.SignalType, c.userID)
					continue
				}

				isMember, err := c.hub.store.IsMember(context.Background(), vcSignal.ConversationID, c.userID)
				if err != nil || !isMember {
					continue
				}

				room, err := c.hub.store.GetActiveVoiceChatRoom(context.Background(), vcSignal.ConversationID)
				if err != nil || room == nil || !room.IsActive || room.ID != vcSignal.RoomID {
					continue
				}

				parts, err := c.hub.store.GetVoiceChatParticipants(context.Background(), vcSignal.RoomID)
				if err != nil {
					continue
				}
				senderInRoom := false
				for _, p := range parts {
					if p.UserID == c.userID {
						senderInRoom = true
						break
					}
				}
				if !senderInRoom && vcSignal.SignalType != "peer_left" {
					log.Printf("Security: user %s sent voice_chat.signal without being an active participant in room %s", c.userID, vcSignal.RoomID)
					continue
				}

				// Stamp server-authenticated sender identity to prevent spoofing
				vcSignal.SenderUserID = c.userID
				sanitizedPayload, err := json.Marshal(vcSignal)
				if err != nil {
					continue
				}

				if vcSignal.TargetUserID != "" {
					if vcSignal.TargetUserID == c.userID {
						continue
					}
					targetIsMember, err := c.hub.store.IsMember(context.Background(), vcSignal.ConversationID, vcSignal.TargetUserID)
					if err != nil || !targetIsMember {
						continue
					}
					c.hub.SendToUser(vcSignal.TargetUserID, ClientEnvelope{
						V:       1,
						Type:    "voice_chat.signal",
						ID:      uuid.New().String(),
						Payload: sanitizedPayload,
					})
				} else {
					for _, p := range parts {
						if p.UserID != c.userID {
							c.hub.SendToUser(p.UserID, ClientEnvelope{
								V:       1,
								Type:    "voice_chat.signal",
								ID:      uuid.New().String(),
								Payload: sanitizedPayload,
							})
						}
					}
				}
			}

		case "typing":
			var typingReq TypingPayload
			if err := json.Unmarshal(env.Payload, &typingReq); err == nil {
				if typingReq.ConversationID != "" {
					isMember, err := c.hub.store.IsMember(context.Background(), typingReq.ConversationID, c.userID)
					if err == nil && isMember {
						members, err := c.hub.store.GetConversationMembers(context.Background(), typingReq.ConversationID)
						if err == nil {
							bcastPayload, _ := json.Marshal(TypingBroadcastPayload{
								ConversationID: typingReq.ConversationID,
								UserID:         c.userID,
								IsTyping:       typingReq.IsTyping,
							})
							for _, memberID := range members {
								if memberID != c.userID {
									c.hub.SendToUser(memberID, ClientEnvelope{
										V:       1,
										Type:    "typing",
										ID:      uuid.New().String(),
										Payload: bcastPayload,
									})
								}
							}
						}
					}
				}
			}
		}
	}
}

func (c *ClientConnection) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)
			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
