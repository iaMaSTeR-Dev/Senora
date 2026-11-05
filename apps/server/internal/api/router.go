package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"senora/server/internal/auth"
	"senora/server/internal/conversations"
	"senora/server/internal/crypto"
	"senora/server/internal/events"
	"senora/server/internal/identity"
	"senora/server/internal/messages"
	"senora/server/internal/models"
	"senora/server/internal/storage"
)

type contextKey string

const (
	userContextKey    contextKey = "user"
	sessionContextKey contextKey = "session"
)

type Router struct {
	mux            *http.ServeMux
	store          storage.Store
	identity       *identity.Service
	sessions       *auth.SessionService
	convs          *conversations.Service
	msgs           *messages.Service
	crypto         *crypto.Service
	hub            *events.Hub
	authLimiter    *RateLimiter
	apiLimiter     *RateLimiter
	accountLimiter *RateLimiter
}

func NewRouter(
	store storage.Store,
	idService *identity.Service,
	sessService *auth.SessionService,
	convService *conversations.Service,
	msgService *messages.Service,
	cryptoService *crypto.Service,
	hub *events.Hub,
) *Router {
	r := &Router{
		mux:            http.NewServeMux(),
		store:          store,
		identity:       idService,
		sessions:       sessService,
		convs:          convService,
		msgs:           msgService,
		crypto:         cryptoService,
		hub:            hub,
		authLimiter:    NewRateLimiter(10, time.Minute),
		apiLimiter:     NewRateLimiter(120, time.Minute),
		accountLimiter: NewRateLimiter(5, time.Minute),
	}

	r.routes()
	return r
}

func (r *Router) GetAuthLimiter() *RateLimiter {
	return r.authLimiter
}

func (r *Router) GetAPILimiter() *RateLimiter {
	return r.apiLimiter
}

func (r *Router) GetAccountLimiter() *RateLimiter {
	return r.accountLimiter
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// Normalize trailing slashes to prevent route matching bypasses
	if req.URL.Path != "/" && strings.HasSuffix(req.URL.Path, "/") {
		req.URL.Path = strings.TrimSuffix(req.URL.Path, "/")
	}

	// CORS configuration: check Origin against ALLOWED_ORIGINS if configured
	origin := req.Header.Get("Origin")
	allowOrigin := "*"
	if allowed := os.Getenv("ALLOWED_ORIGINS"); allowed != "" && origin != "" {
		for _, ao := range strings.Split(allowed, ",") {
			ao = strings.TrimSpace(ao)
			if strings.EqualFold(origin, ao) {
				allowOrigin = origin
				break
			}
		}
	}

	w.Header().Set("Access-Control-Allow-Origin", allowOrigin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")

	if req.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	r.mux.ServeHTTP(w, req)
}

func (r *Router) routes() {
	authRateMiddleware := r.authLimiter.Middleware(r)
	apiRateMiddleware := r.apiLimiter.Middleware(r)

	// Health check (unlimited)
	r.mux.HandleFunc("GET /api/v1/health", r.handleHealth)

	// Auth endpoints (public, brute-force rate limited)
	r.mux.Handle("POST /api/v1/auth/register", authRateMiddleware(http.HandlerFunc(r.handleRegister)))
	r.mux.Handle("POST /api/v1/auth/login", authRateMiddleware(http.HandlerFunc(r.handleLogin)))

	// Authenticated routes (rate limited)
	r.mux.Handle("GET /api/v1/auth/me", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleMe))))
	r.mux.Handle("POST /api/v1/auth/logout", r.authMiddleware(http.HandlerFunc(r.handleLogout)))
	r.mux.Handle("GET /api/v1/users", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSearchUsers))))
	r.mux.Handle("GET /api/v1/users/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetUserProfile))))
	r.mux.Handle("GET /api/v1/conversations", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleListConversations))))
	r.mux.Handle("GET /api/v1/conversations/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetConversation))))
	r.mux.Handle("POST /api/v1/conversations", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateConversation))))
	r.mux.Handle("PUT /api/v1/conversations/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUpdateConversation))))
	r.mux.Handle("DELETE /api/v1/conversations/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDeleteConversation))))
	r.mux.Handle("POST /api/v1/conversations/{id}/security-mode", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSetConversationSecurityMode))))
	r.mux.Handle("GET /api/v1/conversations/{id}/members", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetConversationMembers))))
	r.mux.Handle("POST /api/v1/conversations/{id}/members", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAddConversationMember))))
	r.mux.Handle("DELETE /api/v1/conversations/{id}/members/{userId}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRemoveConversationMember))))
	r.mux.Handle("POST /api/v1/conversations/{id}/pin", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handlePinMessage))))

	// Voice Chat routes
	r.mux.Handle("POST /api/v1/conversations/{id}/voice-chat", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleStartOrJoinVoiceChat))))
	r.mux.Handle("GET /api/v1/conversations/{id}/voice-chat", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetActiveVoiceChat))))
	r.mux.Handle("POST /api/v1/conversations/{id}/voice-chat/leave", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleLeaveVoiceChat))))
	r.mux.Handle("POST /api/v1/conversations/{id}/voice-chat/state", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUpdateVoiceChatState))))
	r.mux.Handle("DELETE /api/v1/conversations/{id}/voice-chat", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleEndVoiceChat))))

	// Messages routes & actions
	r.mux.Handle("GET /api/v1/conversations/{id}/messages", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetMessages))))
	r.mux.Handle("POST /api/v1/conversations/{id}/messages", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSubmitMessage))))
	r.mux.Handle("PUT /api/v1/conversations/{id}/messages/{msgId}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleEditMessage))))
	r.mux.Handle("DELETE /api/v1/conversations/{id}/messages/{msgId}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDeleteMessage))))
	r.mux.Handle("POST /api/v1/conversations/{id}/messages/{msgId}/reactions", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleMessageReaction))))

	// User profiles & devices & blocks & avatars & preferences
	r.mux.Handle("PUT /api/v1/users/profile", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUpdateProfile))))
	r.mux.Handle("GET /api/v1/users/preferences", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetUserPreferences))))
	r.mux.Handle("PUT /api/v1/users/preferences", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSetUserPreferences))))
	r.mux.Handle("POST /api/v1/users/avatar", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUploadAvatar))))
	r.mux.Handle("DELETE /api/v1/users/avatar", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDeleteAvatar))))
	r.mux.Handle("GET /api/v1/users/devices", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleListDevices))))
	r.mux.Handle("DELETE /api/v1/users/devices/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRevokeDevice))))
	r.mux.Handle("POST /api/v1/users/block/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleBlockUser))))
	r.mux.Handle("DELETE /api/v1/users/block/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUnblockUser))))
	r.mux.Handle("GET /api/v1/users/block/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCheckBlock))))

	// Attachments pipeline
	r.mux.Handle("POST /api/v1/attachments", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUploadAttachment))))
	r.mux.Handle("GET /api/v1/attachments/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDownloadAttachment))))
	r.mux.Handle("GET /api/v1/attachments/avatar/{filename}", http.HandlerFunc(r.handleServeAvatar))

	// Crypto key management
	r.mux.Handle("POST /api/v1/crypto/keys", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRegisterKeys))))
	r.mux.Handle("GET /api/v1/crypto/keys/{userId}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetUserKeys))))

	// Stickers routes
	r.mux.Handle("GET /api/v1/stickers/packs", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleListStickerPacks))))
	r.mux.Handle("POST /api/v1/stickers/packs", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateStickerPack))))
	r.mux.Handle("GET /api/v1/stickers/packs/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetStickerPack))))
	r.mux.Handle("GET /api/v1/stickers/share/{code}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetSharedStickerPack))))
	r.mux.Handle("POST /api/v1/stickers/installed/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleInstallStickerPack))))
	r.mux.Handle("DELETE /api/v1/stickers/installed/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUninstallStickerPack))))
	r.mux.Handle("GET /api/v1/stickers/installed", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetInstalledStickers))))

	// Animated Media & GIFs
	r.mux.Handle("GET /api/v1/media/gifs", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSearchGIFs))))

	// Calls routes
	r.mux.Handle("GET /api/v1/calls/logs", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetCallLogs))))
	r.mux.Handle("POST /api/v1/calls/logs", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateCallLog))))

	// Polls routes (Phase 12)
	r.mux.Handle("POST /api/v1/conversations/{id}/polls", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreatePoll))))
	r.mux.Handle("GET /api/v1/conversations/{id}/polls/{pollId}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetPoll))))
	r.mux.Handle("POST /api/v1/conversations/{id}/polls/{pollId}/vote", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleVotePoll))))
	r.mux.Handle("POST /api/v1/conversations/{id}/polls/{pollId}/close", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleClosePoll))))

	// Stories routes (Phase 15)
	r.mux.Handle("POST /api/v1/stories", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateStory))))
	r.mux.Handle("GET /api/v1/stories", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetActiveStories))))
	r.mux.Handle("DELETE /api/v1/stories/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDeleteStory))))

	// Scheduled Messages routes (Phase 15)
	r.mux.Handle("POST /api/v1/conversations/{id}/scheduled", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateScheduledMessage))))
	r.mux.Handle("GET /api/v1/conversations/{id}/scheduled", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetScheduledMessages))))
	r.mux.Handle("DELETE /api/v1/conversations/{id}/scheduled/{msgId}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDeleteScheduledMessage))))

	// Conversation Role route (Phase 12/13)
	r.mux.Handle("GET /api/v1/conversations/{id}/role", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetMyConversationRole))))

	// Bot API foundation route (Phase 15)
	r.mux.Handle("POST /api/v1/bot/sendMessage", apiRateMiddleware(http.HandlerFunc(r.handleBotSendMessage)))
	r.mux.Handle("POST /api/v1/bot/setWebhook", apiRateMiddleware(http.HandlerFunc(r.handleSetBotWebhook)))
	r.mux.Handle("POST /api/v1/bots/tokens", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateBotToken))))
	r.mux.Handle("GET /api/v1/bots/tokens", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleListBotTokens))))
	r.mux.Handle("DELETE /api/v1/bots/tokens/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRevokeBotToken))))

	// Phase 16: Read state & Receipts
	r.mux.Handle("POST /api/v1/conversations/{id}/read", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleMarkConversationRead))))
	r.mux.Handle("GET /api/v1/conversations/{id}/messages/{msgId}/readers", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetMessageReaders))))
	r.mux.Handle("POST /api/v1/conversations/{id}/messages/{msgId}/read", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRecordMessageRead))))
	r.mux.Handle("POST /api/v1/messages/purge-expired", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handlePurgeExpiredMessages))))

	// Phase 16: Administration & Member Roles
	r.mux.Handle("PUT /api/v1/conversations/{id}/members/{userId}/role", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUpdateMemberRole))))

	// Phase 16: Authentic Conversation Invites
	r.mux.Handle("POST /api/v1/conversations/{id}/invites", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateConversationInvite))))
	r.mux.Handle("GET /api/v1/conversations/{id}/invites", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleListConversationInvites))))
	r.mux.Handle("DELETE /api/v1/conversations/{id}/invites/{code}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRevokeConversationInvite))))
	r.mux.Handle("GET /api/v1/invites/{code}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetInvitePreview))))
	r.mux.Handle("POST /api/v1/invites/{code}/join", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleJoinInvite))))

	// Phase 16: Channel Message Views
	r.mux.Handle("POST /api/v1/conversations/{id}/messages/{msgId}/view", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRecordMessageView))))

	// Phase 16: Disappearing Messages (TTL)
	r.mux.Handle("PUT /api/v1/conversations/{id}/ttl", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSetConversationTTL))))

	// Phase 16: Global Search
	r.mux.Handle("GET /api/v1/search", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGlobalSearch))))

	// Phase 16: User Presence & Last Seen
	r.mux.Handle("GET /api/v1/presence/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetUserPresence))))
	r.mux.Handle("POST /api/v1/presence/batch", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetBatchPresence))))

	// Phase 16: WebRTC Dynamic ICE Servers (STUN/TURN)
	r.mux.Handle("GET /api/v1/webrtc/ice-servers", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetIceServers))))

	// WebSocket gateway
	r.mux.HandleFunc("GET /api/v1/ws", r.handleWebSocket)
}

// ---------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------

func (r *Router) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		authHeader := req.Header.Get("Authorization")
		token := ""
		if strings.HasPrefix(authHeader, "Bearer ") {
			token = strings.TrimPrefix(authHeader, "Bearer ")
		} else {
			token = req.URL.Query().Get("token")
		}

		if token == "" {
			r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing authorization token")
			return
		}

		sess, user, err := r.sessions.ValidateSession(req.Context(), token)
		if err != nil {
			r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid or expired session")
			return
		}

		ctx := context.WithValue(req.Context(), userContextKey, user)
		ctx = context.WithValue(ctx, sessionContextKey, sess)
		next.ServeHTTP(w, req.WithContext(ctx))
	})
}

func getUserFromContext(ctx context.Context) *models.User {
	if u, ok := ctx.Value(userContextKey).(*models.User); ok {
		return u
	}
	return nil
}

func getSessionFromContext(ctx context.Context) *models.Session {
	if s, ok := ctx.Value(sessionContextKey).(*models.Session); ok {
		return s
	}
	return nil
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

func (r *Router) handleHealth(w http.ResponseWriter, req *http.Request) {
	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":    "ok",
		"version":   "1.0.0",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

type registerReq struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
	DeviceName  string `json:"device_name"`
}

func (r *Router) handleRegister(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 1024*1024)
	var body registerReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body or payload exceeds size limit")
		return
	}

	result, err := r.identity.Register(req.Context(), identity.RegisterParams{
		Username:    body.Username,
		DisplayName: body.DisplayName,
		Password:    body.Password,
		DeviceName:  body.DeviceName,
	})
	if err != nil {
		r.writeError(w, http.StatusBadRequest, "REGISTRATION_FAILED", err.Error())
		return
	}

	r.writeJSON(w, http.StatusCreated, map[string]interface{}{
		"user":      result.User,
		"token":     result.Session.Token,
		"device_id": result.Device.ID,
	})
}

type loginReq struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	DeviceName string `json:"device_name"`
}

func (r *Router) handleLogin(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 1024*1024)
	var body loginReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body or payload exceeds size limit")
		return
	}

	// Rate limit per normalized username to prevent distributed credential stuffing
	normAccount := strings.ToLower(strings.TrimSpace(body.Username))
	if normAccount != "" {
		if allowed, retryAfter := r.accountLimiter.Allow(normAccount); !allowed {
			retrySeconds := int(retryAfter.Seconds())
			if retrySeconds < 1 {
				retrySeconds = 1
			}
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retrySeconds))
			r.writeError(w, http.StatusTooManyRequests, "ACCOUNT_RATE_LIMIT_EXCEEDED", "Too many attempts for this account; please retry later")
			return
		}
	}

	result, err := r.identity.Login(req.Context(), body.Username, body.Password, body.DeviceName)
	if err != nil {
		r.writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "Invalid username or password")
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"user":      result.User,
		"token":     result.Session.Token,
		"device_id": result.Device.ID,
	})
}

func (r *Router) handleLogout(w http.ResponseWriter, req *http.Request) {
	sess := getSessionFromContext(req.Context())
	if sess != nil {
		_ = r.sessions.RevokeSession(req.Context(), sess.Token)
		// If explicitly requested, disconnect all devices; otherwise disconnect this session's device only
		if req.URL.Query().Get("all_devices") == "true" {
			r.hub.DisconnectUser(sess.UserID)
		} else {
			r.hub.DisconnectDevice(sess.UserID, sess.DeviceID)
		}
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "logged_out"})
}

func (r *Router) handleMe(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	r.writeJSON(w, http.StatusOK, user)
}

func (r *Router) handleSearchUsers(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	query := req.URL.Query().Get("query")
	if len(query) > 100 {
		query = query[:100]
	}
	users, err := r.identity.SearchUsers(req.Context(), query, user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to search users")
		return
	}
	if users == nil {
		users = []*models.User{}
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

func (r *Router) handleListConversations(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convs, err := r.convs.ListConversations(req.Context(), user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to list conversations")
		return
	}
	if convs == nil {
		convs = []*models.Conversation{}
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"conversations": convs})
}

func (r *Router) handleGetConversation(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	conv, err := r.store.GetConversationByID(req.Context(), convID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Conversation not found")
		return
	}
	// For channels, any user can view metadata; for group/direct, user must be member
	if conv.Type != "channel" {
		isMember, _ := r.store.IsMember(req.Context(), convID, user.ID)
		if !isMember {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
			return
		}
	}
	r.writeJSON(w, http.StatusOK, conv)
}

type createConvReq struct {
	Type              string   `json:"type"`
	Title             string   `json:"title"`
	Description       string   `json:"description"`
	ParticipantUserID string   `json:"participant_user_id"`
	PeerID            string   `json:"peer_id"`
	MemberIDs         []string `json:"member_ids"`
}

func (r *Router) handleCreateConversation(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 1024*1024)
	user := getUserFromContext(req.Context())
	var body createConvReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body or payload exceeds size limit")
		return
	}

	if len(body.Title) > 100 {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Title cannot exceed 100 characters")
		return
	}
	if len(body.MemberIDs) > 500 {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Group conversation cannot exceed 500 members")
		return
	}

	if body.Type == "saved" {
		conv, err := r.convs.CreateDirectConversation(req.Context(), user.ID, user.ID)
		if err != nil {
			r.writeError(w, http.StatusBadRequest, "CONVERSATION_CREATE_FAILED", err.Error())
			return
		}
		r.writeJSON(w, http.StatusCreated, conv)
		return
	}

	if body.Type == "direct" {
		targetPeerID := body.ParticipantUserID
		if targetPeerID == "" {
			targetPeerID = body.PeerID
		}
		conv, err := r.convs.CreateDirectConversation(req.Context(), user.ID, targetPeerID)
		if err != nil {
			r.writeError(w, http.StatusBadRequest, "CONVERSATION_CREATE_FAILED", err.Error())
			return
		}
		r.writeJSON(w, http.StatusCreated, conv)
		return
	}

	if body.Type == "group" {
		conv, err := r.convs.CreateGroupConversation(req.Context(), user.ID, body.Title, body.MemberIDs)
		if err != nil {
			r.writeError(w, http.StatusBadRequest, "CONVERSATION_CREATE_FAILED", err.Error())
			return
		}
		r.writeJSON(w, http.StatusCreated, conv)
		return
	}

	if body.Type == "channel" {
		conv, err := r.convs.CreateChannelConversation(req.Context(), user.ID, body.Title, body.Description)
		if err != nil {
			r.writeError(w, http.StatusBadRequest, "CONVERSATION_CREATE_FAILED", err.Error())
			return
		}
		r.writeJSON(w, http.StatusCreated, conv)
		return
	}

	r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid conversation type (must be direct, group, or channel)")
}

func (r *Router) handleGetMessages(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	beforeID := req.URL.Query().Get("before_id")
	limitStr := req.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil {
			if l > 100 {
				limit = 100
			} else if l > 0 {
				limit = l
			}
		}
	}

	msgs, err := r.msgs.GetMessages(req.Context(), convID, user.ID, beforeID, limit)
	if err != nil {
		if err == conversations.ErrForbidden {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
			return
		}
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to retrieve messages")
		return
	}
	if msgs == nil {
		msgs = []*models.Message{}
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"messages": msgs})
}

type submitMsgReq struct {
	IdempotencyKey     string `json:"idempotency_key"`
	Ciphertext         string `json:"ciphertext"`
	Nonce              string `json:"nonce"`
	EphemeralPublicKey string `json:"ephemeral_public_key"`
	ReplyToID          string `json:"reply_to_id"`
}

func (r *Router) handleSubmitMessage(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 1024*1024)
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	var body submitMsgReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body or payload exceeds size limit")
		return
	}

	if body.IdempotencyKey == "" {
		body.IdempotencyKey = uuid.New().String()
	}

	// Channel write authorization check: only owner or admin can post
	conv, err := r.store.GetConversationByID(req.Context(), convID)
	if err == nil && conv != nil && conv.Type == "channel" {
		role, roleErr := r.store.GetMemberRole(req.Context(), convID, user.ID)
		if roleErr != nil || (role != "owner" && role != "admin") {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only channel admins can post messages to channels")
			return
		}
	}

	msg, err := r.msgs.SubmitMessage(req.Context(), messages.SubmitMessageParams{
		ConversationID:     convID,
		SenderID:           user.ID,
		Ciphertext:         body.Ciphertext,
		Nonce:              body.Nonce,
		EphemeralPublicKey: body.EphemeralPublicKey,
		IdempotencyKey:     body.IdempotencyKey,
		ReplyToID:          body.ReplyToID,
	})
	if err != nil {
		if err == conversations.ErrForbidden {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
			return
		}
		if errors.Is(err, storage.ErrIdempotencyConflict) {
			r.writeError(w, http.StatusConflict, "IDEMPOTENCY_CONFLICT", "Idempotency key already used with different payload")
			return
		}
		r.writeError(w, http.StatusBadRequest, "SUBMIT_FAILED", err.Error())
		return
	}

	r.writeJSON(w, http.StatusCreated, msg)
}

type editMsgReq struct {
	Ciphertext string `json:"ciphertext"`
}

func (r *Router) handleEditMessage(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 1024*1024)
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	msgID := req.PathValue("msgId")

	var body editMsgReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if err := r.msgs.EditMessage(req.Context(), convID, msgID, user.ID, body.Ciphertext); err != nil {
		if errors.Is(err, storage.ErrUnauthorized) {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not authorized to edit this message")
			return
		}
		r.writeError(w, http.StatusBadRequest, "EDIT_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "edited"})
}

func (r *Router) handleDeleteMessage(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	msgID := req.PathValue("msgId")
	scope := req.URL.Query().Get("scope")

	if scope == "me" {
		if err := r.msgs.DeleteMessageForMe(req.Context(), convID, msgID, user.ID); err != nil {
			if errors.Is(err, conversations.ErrForbidden) || errors.Is(err, storage.ErrUnauthorized) {
				r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not authorized to delete this message")
				return
			}
			r.writeError(w, http.StatusBadRequest, "DELETE_FAILED", err.Error())
			return
		}
		r.writeJSON(w, http.StatusOK, map[string]string{"status": "deleted_for_me"})
		return
	}

	if err := r.msgs.DeleteMessageForEveryone(req.Context(), convID, msgID, user.ID); err != nil {
		if errors.Is(err, conversations.ErrForbidden) || errors.Is(err, storage.ErrUnauthorized) {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not authorized to delete this message for everyone")
			return
		}
		r.writeError(w, http.StatusBadRequest, "DELETE_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "deleted_for_everyone"})
}

type reactMsgReq struct {
	Emoji string `json:"emoji"`
}

func (r *Router) handleMessageReaction(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	msgID := req.PathValue("msgId")

	var body reactMsgReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	reactionsJSON, err := r.msgs.AddReaction(req.Context(), convID, msgID, user.ID, body.Emoji)
	if err != nil {
		r.writeError(w, http.StatusBadRequest, "REACTION_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ok", "reactions": reactionsJSON})
}

type pinMsgReq struct {
	MessageID string `json:"message_id"`
	IsPinned  bool   `json:"is_pinned"`
}

func (r *Router) handlePinMessage(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	var body pinMsgReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if err := r.msgs.PinMessage(req.Context(), convID, body.MessageID, user.ID, body.IsPinned); err != nil {
		r.writeError(w, http.StatusBadRequest, "PIN_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "pinned"})
}

type addMemberReq struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
}

func (r *Router) handleAddConversationMember(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	var body addMemberReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if err := r.convs.AddMember(req.Context(), convID, user.ID, body.UserID, body.Role); err != nil {
		r.writeError(w, http.StatusBadRequest, "ADD_MEMBER_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "member_added"})
}

func (r *Router) handleRemoveConversationMember(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	targetUserID := req.PathValue("userId")

	if err := r.convs.RemoveMember(req.Context(), convID, user.ID, targetUserID); err != nil {
		r.writeError(w, http.StatusBadRequest, "REMOVE_MEMBER_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "member_removed"})
}

func (r *Router) handleGetConversationMembers(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	members, err := r.convs.GetConversationMemberDetails(req.Context(), convID, user.ID)
	if err != nil {
		if errors.Is(err, conversations.ErrForbidden) {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not authorized to view members of this conversation")
			return
		}
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"members": members,
		"count":   len(members),
	})
}

type updateConvReq struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	AvatarURL   string `json:"avatar_url"`
}

func (r *Router) handleUpdateConversation(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	var body updateConvReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if err := r.convs.UpdateDetails(req.Context(), convID, user.ID, body.Title, body.Description, body.AvatarURL); err != nil {
		r.writeError(w, http.StatusBadRequest, "UPDATE_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

type updateProfileReq struct {
	DisplayName string `json:"display_name"`
	Bio         string `json:"bio"`
	AvatarURL   string `json:"avatar_url"`
}

func (r *Router) handleUpdateProfile(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	user := getUserFromContext(req.Context())

	var body updateProfileReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if body.DisplayName != "" {
		user.DisplayName = body.DisplayName
	}
	user.Bio = body.Bio
	if body.AvatarURL != "" {
		user.AvatarURL = body.AvatarURL
	}

	if err := r.store.UpdateUser(req.Context(), user); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, user)
}

func (r *Router) handleListDevices(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	devs, err := r.store.GetDevicesByUserID(req.Context(), user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, devs)
}

func (r *Router) handleRevokeDevice(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	deviceID := req.PathValue("id")

	dev, err := r.store.GetDeviceByID(req.Context(), deviceID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Device not found")
		return
	}
	if dev.UserID != user.ID {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Cannot revoke a device belonging to another user")
		return
	}

	if err := r.store.DeleteDevice(req.Context(), deviceID, user.ID); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	// Immediately close active WebSocket connections for the revoked device
	r.hub.DisconnectDevice(user.ID, deviceID)

	r.writeJSON(w, http.StatusOK, map[string]string{"status": "device_revoked"})
}

func (r *Router) handleBlockUser(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	targetID := req.PathValue("id")
	if err := r.store.BlockUser(req.Context(), user.ID, targetID); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "blocked"})
}

func (r *Router) handleUnblockUser(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	targetID := req.PathValue("id")
	if err := r.store.UnblockUser(req.Context(), user.ID, targetID); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "unblocked"})
}

func (r *Router) handleCheckBlock(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	targetID := req.PathValue("id")
	blocked, err := r.store.IsUserBlocked(req.Context(), user.ID, targetID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]bool{"blocked": blocked})
}

func (r *Router) handleUploadAttachment(w http.ResponseWriter, req *http.Request) {
	// 25MB limit for attachments
	req.Body = http.MaxBytesReader(w, req.Body, 25*1024*1024)
	user := getUserFromContext(req.Context())

	if err := req.ParseMultipartForm(25 * 1024 * 1024); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Failed to parse multipart form or file exceeds 25MB limit")
		return
	}

	convID := req.FormValue("conversation_id")
	if convID == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "conversation_id is required")
		return
	}

	if err := r.convs.ValidateMembership(req.Context(), convID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	conv, _ := r.store.GetConversationByID(req.Context(), convID)
	if conv != nil && conv.SecurityMode == "e2ee_active" && req.FormValue("is_encrypted") == "false" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Cannot upload unencrypted attachment to an e2ee_active conversation")
		return
	}

	file, header, err := req.FormFile("file")
	if err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "file field is required")
		return
	}
	defer file.Close()

	uploadsDir := getUploadsDir()
	_ = os.MkdirAll(uploadsDir, 0755)

	attID := "att_" + uuid.New().String()
	storagePath := filepath.Join(uploadsDir, attID)
	dst, err := os.Create(storagePath)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to save attachment file")
		return
	}
	defer dst.Close()

	written, err := io.Copy(dst, file)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to write attachment data")
		return
	}

	filename := header.Filename
	if filename == "" {
		filename = "attachment"
	}
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	att := &models.Attachment{
		ID:             attID,
		ConversationID: convID,
		UploaderID:     user.ID,
		Filename:       filename,
		ContentType:    contentType,
		SizeBytes:      written,
		StoragePath:    storagePath,
		IsEncrypted:    req.FormValue("is_encrypted") != "false",
	}

	if err := r.store.CreateAttachment(req.Context(), att); err != nil {
		_ = os.Remove(storagePath)
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusCreated, att)
}

func (r *Router) handleDownloadAttachment(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	attID := req.PathValue("id")

	att, err := r.store.GetAttachmentByID(req.Context(), attID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Attachment not found")
		return
	}

	if err := r.convs.ValidateMembership(req.Context(), att.ConversationID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not authorized to access attachments in this conversation")
		return
	}

	file, err := os.Open(att.StoragePath)
	if err != nil {
		attBase := filepath.Base(att.StoragePath)
		candidatePaths := []string{
			filepath.Join(getUploadsDir(), attBase),
			filepath.Join("/var/www/senora/uploads", attBase),
			filepath.Join("uploads", attBase),
			filepath.Join("/uploads", attBase),
		}
		for _, p := range candidatePaths {
			file, err = os.Open(p)
			if err == nil {
				break
			}
		}
		if err != nil || file == nil {
			r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Attachment file on storage is missing")
			return
		}
	}
	defer file.Close()

	cleanFilename := filepath.Base(att.Filename)
	if cleanFilename == "" || cleanFilename == "." {
		cleanFilename = "attachment"
	}

	// RFC 5987 / RFC 6266 filename header with UTF-8 encoding support for Persian, spaces and Unicode
	escapedFilename := url.PathEscape(cleanFilename)
	asciiFallback := strings.Map(func(r rune) rune {
		if r > 127 || r == '"' || r == '\\' || r == '/' {
			return '_'
		}
		return r
	}, cleanFilename)
	if asciiFallback == "" {
		asciiFallback = "attachment"
	}

	contentType := att.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(att.SizeBytes, 10))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, asciiFallback, escapedFilename))
	io.Copy(w, file)
}

type registerKeysReq struct {
	DeviceID          string   `json:"device_id"`
	IdentityPublicKey string   `json:"identity_public_key"`
	RegistrationID    uint32   `json:"registration_id"`
	SignedPreKey      string   `json:"signed_pre_key"`
	PreKeys           []string `json:"pre_keys"`
}

func (r *Router) handleRegisterKeys(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 1024*1024)
	user := getUserFromContext(req.Context())
	var body registerKeysReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body or payload exceeds size limit")
		return
	}

	sess := getSessionFromContext(req.Context())
	deviceID := body.DeviceID
	if deviceID == "" && sess != nil {
		deviceID = sess.DeviceID
	}
	if sess != nil && deviceID != sess.DeviceID {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Cannot register keys for a different device session")
		return
	}

	err := r.crypto.RegisterKeys(req.Context(), crypto.RegisterKeysParams{
		UserID:            user.ID,
		DeviceID:          deviceID,
		IdentityPublicKey: body.IdentityPublicKey,
		RegistrationID:    body.RegistrationID,
		SignedPreKey:      body.SignedPreKey,
		PreKeys:           body.PreKeys,
	})
	if err != nil {
		if errors.Is(err, storage.ErrUnauthorized) {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Unauthorized device access")
			return
		}
		r.writeError(w, http.StatusBadRequest, "KEY_REGISTRATION_FAILED", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]string{"status": "registered"})
}

func (r *Router) handleGetUserKeys(w http.ResponseWriter, req *http.Request) {
	targetUserID := req.PathValue("userId")
	pkg, err := r.crypto.GetUserKeyPackages(req.Context(), targetUserID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Keys not found for user")
		return
	}
	r.writeJSON(w, http.StatusOK, pkg)
}

func (r *Router) handleWebSocket(w http.ResponseWriter, req *http.Request) {
	token := req.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "Unauthorized: missing token", http.StatusUnauthorized)
		return
	}

	sess, user, err := r.sessions.ValidateSession(req.Context(), token)
	if err != nil {
		http.Error(w, "Unauthorized: invalid session", http.StatusUnauthorized)
		return
	}

	r.hub.HandleWebSocket(w, req, user.ID, sess.DeviceID)
}

// ---------------------------------------------------------------------
// Stickers handlers
// ---------------------------------------------------------------------

func (r *Router) handleListStickerPacks(w http.ResponseWriter, req *http.Request) {
	packs, err := r.store.ListStickerPacks(req.Context())
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to list sticker packs")
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"packs": packs})
}

func (r *Router) handleGetStickerPack(w http.ResponseWriter, req *http.Request) {
	packID := req.PathValue("id")
	pack, err := r.store.GetStickerPackByID(req.Context(), packID)
	if err != nil || pack == nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Sticker pack not found")
		return
	}
	stickers, err := r.store.GetStickersForPack(req.Context(), packID)
	if err == nil {
		pack.Stickers = stickers
	}
	r.writeJSON(w, http.StatusOK, pack)
}

func (r *Router) handleInstallStickerPack(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	packID := req.PathValue("id")
	if err := r.store.InstallStickerPack(req.Context(), user.ID, packID); err != nil {
		r.writeError(w, http.StatusBadRequest, "INSTALL_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "installed"})
}

func (r *Router) handleUninstallStickerPack(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	packID := req.PathValue("id")
	if err := r.store.UninstallStickerPack(req.Context(), user.ID, packID); err != nil {
		r.writeError(w, http.StatusBadRequest, "UNINSTALL_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "uninstalled"})
}

func (r *Router) handleGetInstalledStickers(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	packs, err := r.store.GetInstalledStickerPacks(req.Context(), user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to get installed stickers")
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"packs": packs})
}

// ---------------------------------------------------------------------
// Calls handlers
// ---------------------------------------------------------------------

func (r *Router) handleGetCallLogs(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	logs, err := r.store.GetCallLogs(req.Context(), user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to retrieve call logs")
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"calls": logs})
}

type createCallLogReq struct {
	ID              string `json:"id"`
	ConversationID  string `json:"conversation_id"`
	ReceiverID      string `json:"receiver_id"`
	CallType        string `json:"call_type"`
	Status          string `json:"status"`
	DurationSeconds int    `json:"duration_seconds"`
}

func (r *Router) handleCreateCallLog(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	user := getUserFromContext(req.Context())
	var body createCallLogReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	callID := body.ID
	if callID == "" {
		callID = "call_" + uuid.New().String()
	}

	// Validate conversation membership if conversation ID is provided
	if body.ConversationID != "" {
		if err := r.convs.ValidateMembership(req.Context(), body.ConversationID, user.ID); err != nil {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
			return
		}
	}

	now := time.Now().UTC()
	call := &models.CallLog{
		ID:              callID,
		ConversationID:  body.ConversationID,
		CallerID:        user.ID,
		ReceiverID:      body.ReceiverID,
		CallType:        body.CallType,
		Status:          body.Status,
		DurationSeconds: body.DurationSeconds,
		CreatedAt:       now,
	}
	if body.DurationSeconds > 0 {
		ended := now.Add(time.Duration(body.DurationSeconds) * time.Second)
		call.EndedAt = &ended
	}

	if err := r.store.CreateCallLog(req.Context(), call); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to record call log")
		return
	}

	// Telegram-style in-chat system message for call outcome (Requirement 14)
	if body.ConversationID != "" {
		callEventPayload := map[string]interface{}{
			"type":             "call_event",
			"call_id":          callID,
			"call_type":        body.CallType,
			"outcome":          body.Status,
			"duration_seconds": body.DurationSeconds,
			"caller_id":        user.ID,
			"caller_name":      user.DisplayName,
			"receiver_id":      body.ReceiverID,
		}
		payloadJSON, _ := json.Marshal(callEventPayload)
		idempotencyKey := "call_event_" + callID
		_, _ = r.msgs.SubmitMessage(req.Context(), messages.SubmitMessageParams{
			ConversationID: body.ConversationID,
			SenderID:       user.ID,
			Ciphertext:     string(payloadJSON),
			Nonce:          "system",
			IdempotencyKey: idempotencyKey,
		})
	}

	r.writeJSON(w, http.StatusCreated, call)
}

func (r *Router) handleGetUserProfile(w http.ResponseWriter, req *http.Request) {
	targetID := req.PathValue("id")
	if targetID == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "User ID is required")
		return
	}
	targetUser, err := r.store.GetUserByID(req.Context(), targetID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			r.writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
			return
		}
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to retrieve user profile")
		return
	}
	publicProfile := map[string]interface{}{
		"id":           targetUser.ID,
		"username":     targetUser.Username,
		"display_name": targetUser.DisplayName,
		"bio":          targetUser.Bio,
		"avatar_url":   targetUser.AvatarURL,
		"created_at":   targetUser.CreatedAt,
	}
	r.writeJSON(w, http.StatusOK, publicProfile)
}

// ---------------------------------------------------------------------
// Helper methods
// ---------------------------------------------------------------------

func (r *Router) writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("Failed to encode JSON response: %v", err)
	}
}

func (r *Router) writeError(w http.ResponseWriter, status int, code, message string) {
	r.writeJSON(w, status, map[string]interface{}{
		"error": map[string]string{
			"code":       code,
			"message":    message,
			"request_id": uuid.New().String(),
		},
	})
}

// ---------------------------------------------------------------------
// Phase 9 Handlers: Conversation Deletion, Security Mode, Voice Chat, Avatars, Stickers, GIFs
// ---------------------------------------------------------------------

func (r *Router) handleDeleteConversation(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	scope := req.URL.Query().Get("scope")

	if scope == "me" {
		if err := r.convs.ClearForMe(req.Context(), convID, user.ID); err != nil {
			r.writeError(w, http.StatusBadRequest, "CLEAR_FAILED", err.Error())
			return
		}
		r.hub.SendToUser(user.ID, events.ClientEnvelope{
			V:       1,
			Type:    "conversation.cleared",
			Payload: json.RawMessage(fmt.Sprintf(`{"conversation_id":"%s"}`, convID)),
		})
		r.writeJSON(w, http.StatusOK, map[string]string{"status": "cleared_for_me"})
		return
	}

	// Delete for both (participant in direct chat or admin in group)
	if err := r.convs.DeleteForBoth(req.Context(), convID, user.ID); err != nil {
		if errors.Is(err, storage.ErrUnauthorized) {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not authorized to delete conversation for both")
			return
		}
		r.writeError(w, http.StatusBadRequest, "DELETE_FAILED", err.Error())
		return
	}
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "conversation.deleted",
		Payload: json.RawMessage(fmt.Sprintf(`{"conversation_id":"%s"}`, convID)),
	})
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "deleted_for_both"})
}

type setSecurityModeReq struct {
	SecurityMode string `json:"security_mode"`
}

func (r *Router) handleSetConversationSecurityMode(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	var body setSecurityModeReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if err := r.convs.SetSecurityMode(req.Context(), convID, user.ID, body.SecurityMode); err != nil {
		r.writeError(w, http.StatusBadRequest, "SECURITY_MODE_FAILED", err.Error())
		return
	}

	payloadStr := fmt.Sprintf(`{"conversation_id":"%s","security_mode":"%s","updated_by":"%s"}`, convID, body.SecurityMode, user.ID)
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "conversation.security_mode_changed",
		Payload: json.RawMessage(payloadStr),
	})

	r.writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "security_mode": body.SecurityMode})
}

func (r *Router) handleUploadAvatar(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 10*1024*1024) // 10MB
	if err := req.ParseMultipartForm(10 * 1024 * 1024); err != nil {
		r.writeError(w, http.StatusBadRequest, "PAYLOAD_TOO_LARGE", "Avatar exceeds maximum allowed size (10MB)")
		return
	}

	file, header, err := req.FormFile("avatar")
	if err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Missing 'avatar' form field")
		return
	}
	defer file.Close()

	buff := make([]byte, 512)
	n, _ := file.Read(buff)
	file.Seek(0, io.SeekStart)
	detectedType := http.DetectContentType(buff[:n])
	if !strings.HasPrefix(detectedType, "image/") {
		r.writeError(w, http.StatusBadRequest, "INVALID_FILE_TYPE", "Only image files (JPEG, PNG, WebP, GIF) are accepted for avatars")
		return
	}

	user := getUserFromContext(req.Context())
	uploadsDir := filepath.Join(getUploadsDir(), "avatars")
	_ = os.MkdirAll(uploadsDir, 0755)

	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".png"
	}
	filename := fmt.Sprintf("avatar_%s_%d%s", user.ID, time.Now().UnixNano(), ext)
	filePath := filepath.Join(uploadsDir, filename)

	out, err := os.Create(filePath)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to store avatar")
		return
	}
	defer out.Close()

	if _, err := io.Copy(out, file); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to write avatar")
		return
	}

	avatarURL := "/api/v1/attachments/avatar/" + filename
	if err := r.store.UpdateUserAvatar(req.Context(), user.ID, avatarURL); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	user.AvatarURL = avatarURL
	r.writeJSON(w, http.StatusOK, user)
}

func (r *Router) handleDeleteAvatar(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if err := r.store.UpdateUserAvatar(req.Context(), user.ID, ""); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	user.AvatarURL = ""
	r.writeJSON(w, http.StatusOK, user)
}

func (r *Router) handleGetUserPreferences(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	prefs, err := r.store.GetUserPreferences(req.Context(), user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to retrieve user preferences")
		return
	}
	if prefs == "" {
		prefs = "{}"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(prefs))
}

func (r *Router) handleSetUserPreferences(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 16*1024) // 16KB max
	user := getUserFromContext(req.Context())
	var raw map[string]interface{}
	if err := json.NewDecoder(req.Body).Decode(&raw); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON payload or exceeds 16KB limit")
		return
	}

	// Whitelist allowed preference keys to prevent mass-assignment
	allowedKeys := map[string]bool{
		"theme":                  true,
		"accentColor":            true,
		"fontSize":               true,
		"chatWallpaper":          true,
		"reducedMotion":          true,
		"desktopNotifications":   true,
		"notificationSound":      true,
		"messagePreview":         true,
		"muteAll":                true,
		"lastSeenVisibility":     true,
		"profilePhotoVisibility": true,
		"autoDownloadPhotos":     true,
		"autoDownloadVideos":     true,
		"autoDownloadFiles":      true,
		"lowDataMode":            true,
		"language":               true,
		"fontFamily":             true,
		"timeFormat":             true,
		"sendOnEnter":            true,
		"autoplayGifs":           true,
		"autoplayStickers":       true,
		"linkPreviews":           true,
		"bubbleStyle":            true,
		"highContrast":           true,
		"visibleFocus":           true,
		"largeTouchTargets":      true,
	}

	sanitized := make(map[string]interface{})
	for k, v := range raw {
		if allowedKeys[k] {
			sanitized[k] = v
		}
	}

	sanitizedBytes, err := json.Marshal(sanitized)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to serialize preferences")
		return
	}

	if err := r.store.SetUserPreferences(req.Context(), user.ID, string(sanitizedBytes)); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to save user preferences")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(sanitizedBytes)
}

func getUploadsDir() string {
	if custom := os.Getenv("UPLOAD_DIR"); custom != "" {
		return custom
	}
	if info, err := os.Stat("/var/www/senora/uploads"); err == nil && info.IsDir() {
		return "/var/www/senora/uploads"
	}
	return "uploads"
}

func (r *Router) handleServeAvatar(w http.ResponseWriter, req *http.Request) {
	filename := req.PathValue("filename")
	if strings.Contains(filename, "..") || strings.Contains(filename, "/") || strings.Contains(filename, "\\") {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid avatar filename")
		return
	}
	candidatePaths := []string{
		filepath.Join(getUploadsDir(), "avatars", filename),
		filepath.Join("/var/www/senora/uploads", "avatars", filename),
		filepath.Join("uploads", "avatars", filename),
		filepath.Join("/uploads", "avatars", filename),
	}
	var file *os.File
	var err error
	for _, p := range candidatePaths {
		file, err = os.Open(p)
		if err == nil {
			break
		}
	}
	if err != nil || file == nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Avatar file not found")
		return
	}
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(filename))
	contentType := "image/png"
	switch ext {
	case ".jpg", ".jpeg":
		contentType = "image/jpeg"
	case ".webp":
		contentType = "image/webp"
	case ".gif":
		contentType = "image/gif"
	case ".svg":
		contentType = "image/svg+xml"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	io.Copy(w, file)
}

func (r *Router) handleStartOrJoinVoiceChat(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	if err := r.convs.ValidateMembership(req.Context(), convID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	conv, _ := r.convs.GetConversation(req.Context(), convID, user.ID)
	roomTitle := "Voice Chat"
	if conv != nil && conv.Title != "" {
		roomTitle = conv.Title + " Voice Chat"
	}

	room := &models.VoiceChatRoom{
		ConversationID: convID,
		Title:          roomTitle,
		CreatedBy:      user.ID,
	}
	if err := r.store.CreateVoiceChatRoom(req.Context(), room); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	participant := &models.VoiceChatParticipant{
		RoomID:      room.ID,
		UserID:      user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		AvatarURL:   user.AvatarURL,
		IsMuted:     true,
		IsSpeaking:  false,
	}
	if err := r.store.JoinVoiceChat(req.Context(), participant); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	participants, _ := r.store.GetVoiceChatParticipants(req.Context(), room.ID)
	room.ParticipantCount = len(participants)

	payload, _ := json.Marshal(map[string]interface{}{
		"room_id":         room.ID,
		"conversation_id": convID,
		"participant":     participant,
		"count":           room.ParticipantCount,
	})
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "voice_chat.participant_joined",
		Payload: payload,
	})

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"room":         room,
		"participants": participants,
	})
}

func (r *Router) handleGetActiveVoiceChat(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	if err := r.convs.ValidateMembership(req.Context(), convID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	room, err := r.store.GetActiveVoiceChatRoom(req.Context(), convID)
	if err != nil {
		r.writeJSON(w, http.StatusOK, map[string]interface{}{"room": nil, "participants": []*models.VoiceChatParticipant{}})
		return
	}
	participants, _ := r.store.GetVoiceChatParticipants(req.Context(), room.ID)
	room.ParticipantCount = len(participants)
	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"room":         room,
		"participants": participants,
	})
}

func (r *Router) handleLeaveVoiceChat(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	room, err := r.store.GetActiveVoiceChatRoom(req.Context(), convID)
	if err != nil {
		r.writeJSON(w, http.StatusOK, map[string]string{"status": "left"})
		return
	}

	_ = r.store.LeaveVoiceChat(req.Context(), room.ID, user.ID)
	participants, _ := r.store.GetVoiceChatParticipants(req.Context(), room.ID)

	payload, _ := json.Marshal(map[string]interface{}{
		"room_id":         room.ID,
		"conversation_id": convID,
		"user_id":         user.ID,
		"count":           len(participants),
	})
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "voice_chat.participant_left",
		Payload: payload,
	})

	r.writeJSON(w, http.StatusOK, map[string]string{"status": "left"})
}

type vcStateReq struct {
	IsMuted    bool `json:"is_muted"`
	IsSpeaking bool `json:"is_speaking"`
}

func (r *Router) handleUpdateVoiceChatState(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	room, err := r.store.GetActiveVoiceChatRoom(req.Context(), convID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "No active voice chat room")
		return
	}

	var body vcStateReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	_ = r.store.UpdateVoiceChatParticipant(req.Context(), room.ID, user.ID, body.IsMuted, body.IsSpeaking)

	payload, _ := json.Marshal(map[string]interface{}{
		"room_id":         room.ID,
		"conversation_id": convID,
		"user_id":         user.ID,
		"is_muted":        body.IsMuted,
		"is_speaking":     body.IsSpeaking,
	})
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "voice_chat.participant_updated",
		Payload: payload,
	})
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (r *Router) handleEndVoiceChat(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	room, err := r.store.GetActiveVoiceChatRoom(req.Context(), convID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "No active voice chat room")
		return
	}

	role, _ := r.store.GetMemberRole(req.Context(), convID, user.ID)
	if room.CreatedBy != user.ID && role != "owner" && role != "admin" {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not authorized to end voice chat")
		return
	}

	if err := r.store.EndVoiceChatRoom(req.Context(), room.ID); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	payload, _ := json.Marshal(map[string]interface{}{
		"room_id":         room.ID,
		"conversation_id": convID,
	})
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "voice_chat.ended",
		Payload: payload,
	})
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "ended"})
}

type createStickerPackReq struct {
	Title    string `json:"title"`
	Name     string `json:"name"`
	Stickers []struct {
		Emoji    string `json:"emoji"`
		AssetURL string `json:"asset_url"`
	} `json:"stickers"`
}

func (r *Router) handleCreateStickerPack(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 10*1024*1024)
	user := getUserFromContext(req.Context())
	var body createStickerPackReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}
	if body.Title == "" {
		body.Title = "Custom Stickers"
	}
	if body.Name == "" {
		body.Name = "custom_" + uuid.New().String()[:8]
	}
	if len(body.Stickers) == 0 {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "At least one sticker is required")
		return
	}

	packID := "pack_usr_" + uuid.New().String()
	thumb := body.Stickers[0].AssetURL
	shareCode := "stk_" + strings.ReplaceAll(uuid.New().String()[:8], "-", "")

	pack := &models.StickerPack{
		ID:           packID,
		Name:         body.Name,
		Title:        body.Title,
		ThumbnailURL: thumb,
		Author:       user.DisplayName,
		CreatorID:    user.ID,
		ShareCode:    shareCode,
		StickerCount: len(body.Stickers),
		IsBuiltin:    false,
	}

	var stickers []*models.Sticker
	for i, s := range body.Stickers {
		em := s.Emoji
		if em == "" {
			em = "✨"
		}
		stickers = append(stickers, &models.Sticker{
			ID:       fmt.Sprintf("%s_stk_%d", packID, i+1),
			PackID:   packID,
			Emoji:    em,
			AssetURL: s.AssetURL,
			Width:    256,
			Height:   256,
		})
	}

	if err := r.store.CreateUserStickerPack(req.Context(), pack, stickers); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	pack.Stickers = stickers
	r.writeJSON(w, http.StatusCreated, pack)
}

func (r *Router) handleGetSharedStickerPack(w http.ResponseWriter, req *http.Request) {
	code := req.PathValue("code")
	pack, err := r.store.GetStickerPackByShareCode(req.Context(), code)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Sticker pack not found")
		return
	}
	r.writeJSON(w, http.StatusOK, pack)
}

type GIFItem struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	URL        string `json:"url"`
	PreviewURL string `json:"preview_url"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Tags       string `json:"tags"`
}

func getCuratedGIFs(query string) []GIFItem {
	allGIFs := []GIFItem{
		{
			ID:         "gif_party_popper",
			Title:      "Party Celebration",
			URL:        "https://media.giphy.com/media/26tOZ42Mg6pbTUPHW/giphy.gif",
			PreviewURL: "https://media.giphy.com/media/26tOZ42Mg6pbTUPHW/giphy.gif",
			Width:      480,
			Height:     360,
			Tags:       "party celebrate celebration happy yay confetti hooray",
		},
		{
			ID:         "gif_thumbs_up",
			Title:      "Thumbs Up",
			URL:        "https://media.giphy.com/media/111ebonMs90YLu/giphy.gif",
			PreviewURL: "https://media.giphy.com/media/111ebonMs90YLu/giphy.gif",
			Width:      480,
			Height:     270,
			Tags:       "thumbs up ok yes approve great good job agree",
		},
		{
			ID:         "gif_applause",
			Title:      "Applause",
			URL:        "https://media.giphy.com/media/nbvFVPiEiJH6JOGIok/giphy.gif",
			PreviewURL: "https://media.giphy.com/media/nbvFVPiEiJH6JOGIok/giphy.gif",
			Width:      480,
			Height:     360,
			Tags:       "applause clap claps bravo congratulations wow",
		},
		{
			ID:         "gif_laughing",
			Title:      "Laughing",
			URL:        "https://media.giphy.com/media/10JhviFuU2gWD6/giphy.gif",
			PreviewURL: "https://media.giphy.com/media/10JhviFuU2gWD6/giphy.gif",
			Width:      480,
			Height:     270,
			Tags:       "laugh lol haha funny rofl giggle haha",
		},
		{
			ID:         "gif_mind_blown",
			Title:      "Mind Blown",
			URL:        "https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif",
			PreviewURL: "https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif",
			Width:      480,
			Height:     270,
			Tags:       "mind blown boom shock surprised wow explosion",
		},
		{
			ID:         "gif_fire",
			Title:      "Fire",
			URL:        "https://media.giphy.com/media/l41JGlWa1xOjJSsV2/giphy.gif",
			PreviewURL: "https://media.giphy.com/media/l41JGlWa1xOjJSsV2/giphy.gif",
			Width:      480,
			Height:     360,
			Tags:       "fire hot lit flame awesome amazing epic",
		},
		{
			ID:         "gif_heart_love",
			Title:      "Love & Heart",
			URL:        "https://media.giphy.com/media/26FLdm964upUX41NL/giphy.gif",
			PreviewURL: "https://media.giphy.com/media/26FLdm964upUX41NL/giphy.gif",
			Width:      480,
			Height:     360,
			Tags:       "love heart kiss sweet romance care thank you",
		},
		{
			ID:         "gif_cat_vibing",
			Title:      "Cat Dancing",
			URL:        "https://media.giphy.com/media/jpbnoe3UIa8TU8LM13/giphy.gif",
			PreviewURL: "https://media.giphy.com/media/jpbnoe3UIa8TU8LM13/giphy.gif",
			Width:      480,
			Height:     480,
			Tags:       "cat dance music vibe jam vibing animal cute",
		},
		{
			ID:         "gif_thinking",
			Title:      "Thinking",
			URL:        "https://media.giphy.com/media/3o7bu3XilJ5BOiSGic/giphy.gif",
			PreviewURL: "https://media.giphy.com/media/3o7bu3XilJ5BOiSGic/giphy.gif",
			Width:      480,
			Height:     270,
			Tags:       "thinking think hmm ponder wonder question",
		},
		{
			ID:         "gif_bye_wave",
			Title:      "Goodbye Wave",
			URL:        "https://media.giphy.com/media/m9eG1qVjvNINHgvPxF/giphy.gif",
			PreviewURL: "https://media.giphy.com/media/m9eG1qVjvNINHgvPxF/giphy.gif",
			Width:      480,
			Height:     270,
			Tags:       "bye goodbye wave hello hi see you greeting",
		},
	}

	if query == "" {
		return allGIFs
	}

	var results []GIFItem
	for _, item := range allGIFs {
		if strings.Contains(strings.ToLower(item.Title), query) || strings.Contains(strings.ToLower(item.Tags), query) {
			results = append(results, item)
		}
	}
	if len(results) == 0 {
		return allGIFs
	}
	return results
}

func (r *Router) handleSearchGIFs(w http.ResponseWriter, req *http.Request) {
	query := strings.ToLower(strings.TrimSpace(req.URL.Query().Get("query")))
	gifs := getCuratedGIFs(query)
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"gifs": gifs})
}

// ---------------------------------------------------------------------
// Phase 10-15: Polls, Stories, Scheduled Messages, Roles, Bot API
// ---------------------------------------------------------------------

type createPollReq struct {
	Question       string   `json:"question"`
	Options        []string `json:"options"`
	IsAnonymous    bool     `json:"is_anonymous"`
	AllowsMultiple bool     `json:"allows_multiple"`
	IsQuiz         bool     `json:"is_quiz"`
	CorrectOption  int      `json:"correct_option"`
	Explanation    string   `json:"explanation,omitempty"`
}

func (r *Router) handleCreatePoll(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	isMember, err := r.store.IsMember(req.Context(), convID, user.ID)
	if err != nil || !isMember {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	var body createPollReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if strings.TrimSpace(body.Question) == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Poll question is required")
		return
	}
	if len(body.Options) < 2 {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Poll must have at least 2 options")
		return
	}
	if len(body.Options) > 10 {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Poll supports at most 10 options")
		return
	}

	pollID := "poll_" + uuid.New().String()
	poll := &models.Poll{
		ID:             pollID,
		ConversationID: convID,
		CreatorID:      user.ID,
		Question:       strings.TrimSpace(body.Question),
		IsAnonymous:    body.IsAnonymous,
		AllowsMultiple: body.AllowsMultiple,
		IsQuiz:         body.IsQuiz,
		CorrectOption:  body.CorrectOption,
		Explanation:    body.Explanation,
		CreatedAt:      time.Now(),
	}

	createdPoll, err := r.store.CreatePoll(req.Context(), poll, body.Options)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	payload, _ := json.Marshal(createdPoll)
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "poll.created",
		Payload: payload,
	})

	r.writeJSON(w, http.StatusCreated, createdPoll)
}

func (r *Router) handleGetPoll(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	pollID := req.PathValue("pollId")

	isMember, err := r.store.IsMember(req.Context(), convID, user.ID)
	if err != nil || !isMember {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	poll, err := r.store.GetPoll(req.Context(), pollID, user.ID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Poll not found")
		return
	}

	r.writeJSON(w, http.StatusOK, poll)
}

type votePollReq struct {
	OptionID int `json:"option_id"`
}

func (r *Router) handleVotePoll(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	pollID := req.PathValue("pollId")

	isMember, err := r.store.IsMember(req.Context(), convID, user.ID)
	if err != nil || !isMember {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	var body votePollReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	poll, err := r.store.VotePoll(req.Context(), pollID, user.ID, body.OptionID)
	if err != nil {
		r.writeError(w, http.StatusBadRequest, "VOTE_FAILED", err.Error())
		return
	}

	payload, _ := json.Marshal(poll)
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "poll.voted",
		Payload: payload,
	})

	r.writeJSON(w, http.StatusOK, poll)
}

func (r *Router) handleClosePoll(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	pollID := req.PathValue("pollId")

	isMember, err := r.store.IsMember(req.Context(), convID, user.ID)
	if err != nil || !isMember {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	poll, err := r.store.ClosePoll(req.Context(), pollID, user.ID)
	if err != nil {
		if errors.Is(err, storage.ErrUnauthorized) {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only poll creator or conversation admin can close the poll")
			return
		}
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	payload, _ := json.Marshal(map[string]interface{}{
		"poll_id":         pollID,
		"conversation_id": convID,
		"is_closed":       true,
	})
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "poll.closed",
		Payload: payload,
	})

	r.writeJSON(w, http.StatusOK, poll)
}

type createStoryReq struct {
	MediaURL  string `json:"media_url"`
	MediaType string `json:"media_type"`
	Caption   string `json:"caption"`
	Privacy   string `json:"privacy"`
}

func (r *Router) handleCreateStory(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 1024*1024)
	user := getUserFromContext(req.Context())

	var body createStoryReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if strings.TrimSpace(body.MediaURL) == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Media URL is required for stories")
		return
	}

	mType := body.MediaType
	if mType != "photo" && mType != "video" {
		mType = "photo"
	}

	story := &models.Story{
		ID:          "story_" + uuid.New().String(),
		UserID:      user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		AvatarURL:   user.AvatarURL,
		MediaURL:    body.MediaURL,
		MediaType:   mType,
		Caption:     body.Caption,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(24 * time.Hour),
	}

	if err := r.store.CreateStory(req.Context(), story); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusCreated, story)
}

func (r *Router) handleGetActiveStories(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	stories, err := r.store.GetActiveStories(req.Context(), user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	if stories == nil {
		stories = []*models.Story{}
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"stories": stories})
}

func (r *Router) handleDeleteStory(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	storyID := req.PathValue("id")

	if err := r.store.DeleteStory(req.Context(), storyID, user.ID); err != nil {
		r.writeError(w, http.StatusBadRequest, "DELETE_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type createScheduledReq struct {
	Ciphertext   string    `json:"ciphertext"`
	Nonce        string    `json:"nonce"`
	ScheduledFor time.Time `json:"scheduled_for"`
}

func (r *Router) handleCreateScheduledMessage(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 1024*1024)
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	isMember, err := r.store.IsMember(req.Context(), convID, user.ID)
	if err != nil || !isMember {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	var body createScheduledReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if body.Ciphertext == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Ciphertext cannot be empty")
		return
	}
	if body.ScheduledFor.Before(time.Now()) {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Scheduled time must be in the future")
		return
	}

	nonce := body.Nonce
	if strings.TrimSpace(nonce) == "" {
		nonce = "normal"
	}

	msg := &models.ScheduledMessage{
		ID:             "sch_" + uuid.New().String(),
		ConversationID: convID,
		SenderID:       user.ID,
		Ciphertext:     body.Ciphertext,
		Nonce:          nonce,
		ScheduledFor:   body.ScheduledFor,
		CreatedAt:      time.Now(),
	}

	if err := r.store.CreateScheduledMessage(req.Context(), msg); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusCreated, msg)
}

func (r *Router) handleGetScheduledMessages(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	isMember, err := r.store.IsMember(req.Context(), convID, user.ID)
	if err != nil || !isMember {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	msgs, err := r.store.GetScheduledMessages(req.Context(), convID, user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	if msgs == nil {
		msgs = []*models.ScheduledMessage{}
	}
	r.writeJSON(w, http.StatusOK, msgs)
}

func (r *Router) handleDeleteScheduledMessage(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	msgID := req.PathValue("msgId")

	if err := r.store.DeleteScheduledMessage(req.Context(), msgID, user.ID); err != nil {
		r.writeError(w, http.StatusBadRequest, "DELETE_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (r *Router) handleGetMyConversationRole(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	role, err := r.store.GetMemberRole(req.Context(), convID, user.ID)
	if err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"role": role})
}

type botSendMsgReq struct {
	ConversationID string `json:"conversation_id"`
	Text           string `json:"text"`
	ParseMode      string `json:"parse_mode,omitempty"`
}

func (r *Router) handleBotSendMessage(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	botToken := req.Header.Get("X-Bot-Token")
	if botToken == "" {
		authHeader := req.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bot ") {
			botToken = strings.TrimPrefix(authHeader, "Bot ")
		}
	}

	if botToken == "" {
		r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing bot token in X-Bot-Token or Authorization: Bot <token>")
		return
	}

	// 1. Validate against stored bot tokens in database with required scope messages:send
	tokenModel, err := r.store.ValidateBotToken(req.Context(), botToken, "messages:send")
	senderID := "bot_system"
	if err == nil && tokenModel != nil {
		senderID = "bot_" + tokenModel.ID
	} else {
		// 2. Fallback to env or default dev token for backwards compatibility
		expectedToken := os.Getenv("BOT_API_TOKEN")
		if expectedToken == "" {
			expectedToken = "senora_bot_dev_token"
		}
		if botToken != expectedToken {
			r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid or revoked bot token")
			return
		}
	}

	var body botSendMsgReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if strings.TrimSpace(body.ConversationID) == "" || strings.TrimSpace(body.Text) == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "conversation_id and text are required")
		return
	}

	members, err := r.store.GetConversationMembers(req.Context(), body.ConversationID)
	if err != nil || len(members) == 0 {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Conversation not found")
		return
	}

	msg := &models.Message{
		ID:             "msg_bot_" + uuid.New().String(),
		ConversationID: body.ConversationID,
		SenderID:       senderID,
		Ciphertext:     body.Text,
		Nonce:          "normal",
		CreatedAt:      time.Now(),
	}

	savedMsg, _, err := r.store.CreateMessageWithOutbox(req.Context(), msg, members)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	payload, _ := json.Marshal(savedMsg)
	r.hub.BroadcastToConversation(body.ConversationID, events.ClientEnvelope{
		V:       1,
		Type:    "message.created",
		Payload: payload,
	})

	r.writeJSON(w, http.StatusCreated, savedMsg)
}

// ---------------------------------------------------------------------
// Phase 16: Handlers for Read Receipts, Invites, Roles, Views, TTL, Search, Presence & ICE
// ---------------------------------------------------------------------

type markReadReq struct {
	MessageID string `json:"message_id,omitempty"`
}

func (r *Router) handleMarkConversationRead(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	isMember, err := r.store.IsMember(req.Context(), convID, user.ID)
	if err != nil || !isMember {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	var body markReadReq
	_ = json.NewDecoder(req.Body).Decode(&body)

	if err := r.store.MarkConversationRead(req.Context(), convID, user.ID, body.MessageID); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	// Broadcast read receipt to all conversation participants via WebSocket
	payload, _ := json.Marshal(map[string]interface{}{
		"conversation_id": convID,
		"user_id":         user.ID,
		"message_id":      body.MessageID,
		"read_at":         time.Now().UTC().Format(time.RFC3339Nano),
	})
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "conversation.read",
		Payload: payload,
	})

	r.writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (r *Router) handleRecordMessageRead(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	msgID := req.PathValue("msgId")

	isMember, err := r.store.IsMember(req.Context(), convID, user.ID)
	if err != nil || !isMember {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	msg, err := r.store.GetMessageByID(req.Context(), msgID)
	if err != nil || msg.ConversationID != convID {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Message not found in this conversation")
		return
	}

	// Never mark own message as read by author
	if msg.SenderID == user.ID {
		r.writeJSON(w, http.StatusOK, map[string]string{"status": "own_message"})
		return
	}

	if err := r.store.RecordMessageRead(req.Context(), msgID, user.ID, convID); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	_ = r.store.MarkConversationRead(req.Context(), convID, user.ID, msgID)

	payload, _ := json.Marshal(map[string]interface{}{
		"conversation_id": convID,
		"user_id":         user.ID,
		"reader_id":       user.ID,
		"message_id":      msgID,
		"read_at":         time.Now().UTC().Format(time.RFC3339Nano),
	})
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "message.read",
		Payload: payload,
	})
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "conversation.read",
		Payload: payload,
	})

	r.writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type updateRoleReq struct {
	Role string `json:"role"`
}

func (r *Router) handleUpdateMemberRole(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	targetUserID := req.PathValue("userId")

	// Caller must be owner to update administrative roles
	callerRole, err := r.store.GetMemberRole(req.Context(), convID, user.ID)
	if err != nil || callerRole != "owner" {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only the conversation owner can update member roles")
		return
	}

	targetRole, err := r.store.GetMemberRole(req.Context(), convID, targetUserID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Target user is not a member of this conversation")
		return
	}
	if targetRole == "owner" {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Cannot alter the role of the conversation owner")
		return
	}

	var body updateRoleReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil || (body.Role != "admin" && body.Role != "member") {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Role must be 'admin' or 'member'")
		return
	}

	if err := r.store.UpdateMemberRole(req.Context(), convID, targetUserID, body.Role); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "role": body.Role})
}

type createInviteReq struct {
	MaxUses        int `json:"max_uses,omitempty"`
	ExpiresInHours int `json:"expires_in_hours,omitempty"`
}

func (r *Router) handleCreateConversationInvite(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	callerRole, err := r.store.GetMemberRole(req.Context(), convID, user.ID)
	if err != nil || (callerRole != "owner" && callerRole != "admin") {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only admins or owners can create invites")
		return
	}

	var body createInviteReq
	_ = json.NewDecoder(req.Body).Decode(&body)

	b := make([]byte, 16)
	_, _ = rand.Read(b)
	code := "inv_" + hex.EncodeToString(b)
	var expiresAt *time.Time
	if body.ExpiresInHours > 0 {
		exp := time.Now().UTC().Add(time.Duration(body.ExpiresInHours) * time.Hour)
		expiresAt = &exp
	}

	inv := &models.ConversationInvite{
		ID:             "ci_" + uuid.New().String(),
		ConversationID: convID,
		CreatorID:      user.ID,
		InviteCode:     code,
		MaxUses:        body.MaxUses,
		ExpiresAt:      expiresAt,
		CreatedAt:      time.Now().UTC(),
	}

	if err := r.store.CreateConversationInvite(req.Context(), inv); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusCreated, inv)
}

func (r *Router) handleListConversationInvites(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	callerRole, err := r.store.GetMemberRole(req.Context(), convID, user.ID)
	if err != nil || (callerRole != "owner" && callerRole != "admin") {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only admins or owners can view invites")
		return
	}

	invites, err := r.store.ListConversationInvites(req.Context(), convID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	if invites == nil {
		invites = []*models.ConversationInvite{}
	}
	r.writeJSON(w, http.StatusOK, invites)
}

func (r *Router) handleRevokeConversationInvite(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	code := req.PathValue("code")

	callerRole, err := r.store.GetMemberRole(req.Context(), convID, user.ID)
	if err != nil || (callerRole != "owner" && callerRole != "admin") {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only admins or owners can revoke invites")
		return
	}

	if err := r.store.RevokeConversationInvite(req.Context(), convID, code); err != nil {
		r.writeError(w, http.StatusBadRequest, "REVOKE_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

func (r *Router) handleGetInvitePreview(w http.ResponseWriter, req *http.Request) {
	code := req.PathValue("code")
	inv, err := r.store.GetConversationInviteByCode(req.Context(), code)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Invalid or expired invite")
		return
	}

	conv, err := r.store.GetConversationByID(req.Context(), inv.ConversationID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Conversation not found")
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"invite_code":       code,
		"conversation_id":   conv.ID,
		"title":             conv.Title,
		"type":              conv.Type,
		"avatar_url":        conv.AvatarURL,
		"description":       conv.Description,
		"participant_count": len(conv.Participants),
		"expires_at":        inv.ExpiresAt,
	})
}

func (r *Router) handleJoinInvite(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	code := req.PathValue("code")

	conv, err := r.store.UseConversationInvite(req.Context(), code, user.ID)
	if err != nil {
		r.writeError(w, http.StatusBadRequest, "JOIN_FAILED", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, conv)
}

func (r *Router) handleRecordMessageView(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	msgID := req.PathValue("msgId")

	count, err := r.store.RecordMessageView(req.Context(), msgID, user.ID, convID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]int{"views_count": count})
}

type setTTLReq struct {
	TTL int `json:"ttl"`
}

func (r *Router) handleSetConversationTTL(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	callerRole, err := r.store.GetMemberRole(req.Context(), convID, user.ID)
	if err != nil || (callerRole != "owner" && callerRole != "admin") {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only admins or owners can set disappearing messages timer")
		return
	}

	var body setTTLReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if err := r.store.SetConversationTTL(req.Context(), convID, body.TTL); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ok", "ttl": body.TTL})
}

func (r *Router) handleGlobalSearch(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	q := strings.TrimSpace(req.URL.Query().Get("q"))
	if q == "" {
		r.writeJSON(w, http.StatusOK, map[string]interface{}{
			"channels":      []interface{}{},
			"users":         []interface{}{},
			"conversations": []interface{}{},
		})
		return
	}

	res, err := r.store.GlobalSearch(req.Context(), user.ID, q)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, res)
}

func (r *Router) handleGetUserPresence(w http.ResponseWriter, req *http.Request) {
	targetID := req.PathValue("id")
	isOnline := r.hub.IsUserOnline(targetID)

	devices, err := r.store.GetDevicesByUserID(req.Context(), targetID)
	var lastSeen time.Time
	if err == nil {
		for _, d := range devices {
			if d.LastSeenAt.After(lastSeen) {
				lastSeen = d.LastSeenAt
			}
		}
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"user_id":      targetID,
		"is_online":    isOnline,
		"last_seen_at": lastSeen,
	})
}

type batchPresenceReq struct {
	UserIDs []string `json:"user_ids"`
}

func (r *Router) handleGetBatchPresence(w http.ResponseWriter, req *http.Request) {
	var body batchPresenceReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	res := make([]map[string]interface{}, 0, len(body.UserIDs))
	for _, targetID := range body.UserIDs {
		if targetID == "" {
			continue
		}
		isOnline := r.hub.IsUserOnline(targetID)
		devices, err := r.store.GetDevicesByUserID(req.Context(), targetID)
		var lastSeen time.Time
		if err == nil {
			for _, d := range devices {
				if d.LastSeenAt.After(lastSeen) {
					lastSeen = d.LastSeenAt
				}
			}
		}
		res = append(res, map[string]interface{}{
			"user_id":      targetID,
			"is_online":    isOnline,
			"last_seen_at": lastSeen,
		})
	}

	r.writeJSON(w, http.StatusOK, res)
}

func (r *Router) handleGetIceServers(w http.ResponseWriter, req *http.Request) {
	stunServers := os.Getenv("STUN_SERVERS")
	if stunServers == "" {
		stunServers = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
	}
	stunList := strings.Split(stunServers, ",")
	var cleanStuns []string
	for _, s := range stunList {
		if s = strings.TrimSpace(s); s != "" {
			cleanStuns = append(cleanStuns, s)
		}
	}

	iceServers := []map[string]interface{}{
		{
			"urls": cleanStuns,
		},
	}

	turnURL := os.Getenv("TURN_SERVER_URL")
	turnUser := os.Getenv("TURN_USERNAME")
	turnPass := os.Getenv("TURN_CREDENTIAL")
	if turnURL != "" {
		iceServers = append(iceServers, map[string]interface{}{
			"urls":       turnURL,
			"username":   turnUser,
			"credential": turnPass,
		})
	}

	r.writeJSON(w, http.StatusOK, iceServers)
}

// ---------------------------------------------------------------------
// Phase 16 Remediation: Webhook SSRF Defenses, Bot Tokens & Readers
// ---------------------------------------------------------------------

// ValidateWebhookURL performs comprehensive SSRF defenses against loopback, private IPv4/IPv6,
// link-local addresses, cloud metadata endpoints, and DNS rebinding.
func ValidateWebhookURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return errors.New("invalid webhook url format")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return errors.New("webhook url must use http or https scheme")
	}
	hostname := u.Hostname()
	if hostname == "" {
		return errors.New("missing hostname in webhook url")
	}

	lowerHost := strings.ToLower(hostname)
	if lowerHost == "localhost" || strings.HasSuffix(lowerHost, ".localhost") || strings.HasSuffix(lowerHost, ".local") || strings.HasSuffix(lowerHost, ".internal") {
		return errors.New("webhook destination cannot be localhost or internal domain")
	}

	// Direct IP check (e.g. 127.0.0.1, 10.0.0.1, 192.168.1.1, 169.254.169.254, ::1)
	if ip := net.ParseIP(hostname); ip != nil {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() || ip.String() == "169.254.169.254" {
			return errors.New("webhook destination resolves to private, loopback, or link-local address")
		}
		return nil
	}

	// DNS lookup resolution check
	ips, err := net.LookupIP(hostname)
	if err != nil {
		return fmt.Errorf("failed to resolve webhook host: %w", err)
	}
	if len(ips) == 0 {
		return errors.New("no ip addresses found for webhook host")
	}

	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() || ip.String() == "169.254.169.254" {
			return errors.New("webhook destination resolves to private, loopback, or link-local address")
		}
	}

	return nil
}

type setWebhookReq struct {
	URL         string `json:"url"`
	SecretToken string `json:"secret_token,omitempty"`
}

func (r *Router) handleSetBotWebhook(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	botToken := req.Header.Get("X-Bot-Token")
	if botToken == "" {
		authHeader := req.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bot ") {
			botToken = strings.TrimPrefix(authHeader, "Bot ")
		}
	}

	if botToken == "" {
		r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing bot token in X-Bot-Token or Authorization: Bot <token>")
		return
	}

	// Validate bot token
	_, err := r.store.ValidateBotToken(req.Context(), botToken, "")
	if err != nil {
		expectedToken := os.Getenv("BOT_API_TOKEN")
		if expectedToken == "" {
			expectedToken = "senora_bot_dev_token"
		}
		if botToken != expectedToken {
			r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid or revoked bot token")
			return
		}
	}

	var body setWebhookReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if strings.TrimSpace(body.URL) == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "url is required")
		return
	}

	if err := ValidateWebhookURL(body.URL); err != nil {
		r.writeError(w, http.StatusBadRequest, "SSRF_DEFENSE_TRIGGERED", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":          true,
		"webhook_url": body.URL,
	})
}

type createBotTokenReq struct {
	Name  string `json:"name"`
	Scope string `json:"scope"`
}

func (r *Router) handleCreateBotToken(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	var body createBotTokenReq
	_ = json.NewDecoder(req.Body).Decode(&body)

	tokenModel, rawToken, err := r.store.CreateBotToken(req.Context(), body.Name, body.Scope, user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusCreated, map[string]interface{}{
		"token":      rawToken,
		"id":         tokenModel.ID,
		"bot_id":     tokenModel.BotID,
		"name":       tokenModel.Name,
		"scope":      tokenModel.Scope,
		"created_at": tokenModel.CreatedAt,
	})
}

func (r *Router) handleListBotTokens(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	tokens, err := r.store.ListBotTokens(req.Context(), user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, tokens)
}

func (r *Router) handleRevokeBotToken(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	tokenID := req.PathValue("id")
	if tokenID == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Token ID is required")
		return
	}

	if err := r.store.RevokeBotToken(req.Context(), tokenID, user.ID); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Bot token not found or already revoked")
			return
		}
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

func (r *Router) handleGetMessageReaders(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	msgID := req.PathValue("msgId")

	isMember, err := r.store.IsMember(req.Context(), convID, user.ID)
	if err != nil || !isMember {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}

	msg, err := r.store.GetMessageByID(req.Context(), msgID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Message not found")
		return
	}
	if msg.ConversationID != convID {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Message does not belong to conversation")
		return
	}

	conv, err := r.convs.GetConversation(req.Context(), convID, user.ID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to retrieve conversation metadata")
		return
	}

	// In groups and channels, only administrators/owners or the message author can view reader list
	if conv.Type == "group" || conv.Type == "channel" {
		callerRole, _ := r.store.GetMemberRole(req.Context(), convID, user.ID)
		isAuthor := msg.SenderID == user.ID
		isAdmin := callerRole == "owner" || callerRole == "admin"
		if !isAdmin && !isAuthor {
			r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only administrators or the message author can inspect read receipts")
			return
		}
	}

	readers, err := r.store.GetMessageReaders(req.Context(), convID, msgID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, readers)
}

func (r *Router) handlePurgeExpiredMessages(w http.ResponseWriter, req *http.Request) {
	count, err := r.store.PurgeExpiredMessages(req.Context())
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":           true,
		"purged_count": count,
	})
}

