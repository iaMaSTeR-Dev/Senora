package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
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
	urlpath "path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"senora/server/internal/auth"
	"senora/server/internal/conversations"
	"senora/server/internal/crypto"
	"senora/server/internal/diskguard"
	"senora/server/internal/downloader"
	"senora/server/internal/events"
	"senora/server/internal/filestore"
	"senora/server/internal/identity"
	"senora/server/internal/masterbot"
	"senora/server/internal/mediaindex"
	"senora/server/internal/messages"
	"senora/server/internal/models"
	"senora/server/internal/netguard"
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
	masterBot      *masterbot.Service
	downloader     *downloader.Service
	fileStore      *filestore.StorageManager
	seekIndexes    *mediaindex.Cache
	frontendDir    string
	authLimiter    *RateLimiter
	apiLimiter     *RateLimiter
	accountLimiter *RateLimiter
	autoBanTracker *AutoBanTracker
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
	fileStore := filestore.NewStorageManager(filestore.DefaultArvanConfig())
	fileStore.StartBackgroundProbe(context.Background(), 30*time.Second)

	masterBotService := masterbot.NewService(store, convService, hub)
	masterBotService.SetFileStore(fileStore)

	downloaderService := downloader.NewService(store, fileStore, msgService, convService, hub)

	r := &Router{
		mux:            http.NewServeMux(),
		store:          store,
		identity:       idService,
		sessions:       sessService,
		convs:          convService,
		msgs:           msgService,
		crypto:         cryptoService,
		hub:            hub,
		masterBot:      masterBotService,
		downloader:     downloaderService,
		fileStore:      fileStore,
		seekIndexes:    mediaindex.NewCache(),
		authLimiter:    NewRateLimiter(10, time.Minute),
		apiLimiter:     NewRateLimiter(600, time.Minute),
		accountLimiter: NewRateLimiter(5, time.Minute),
		autoBanTracker: NewAutoBanTracker(5, time.Minute),
	}

	// Initialize master bot and owner in background, and start pulse ticker
	go func() {
		_, _ = r.masterBot.EnsureBotAndOwner(context.Background())
		r.masterBot.StartScheduledPulse(context.Background())
	}()

	r.routes()
	r.botRoutes()
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

func (r *Router) FileStore() *filestore.StorageManager {
	return r.fileStore
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// Normalize trailing slashes to prevent route matching bypasses
	if req.URL.Path != "/" && strings.HasSuffix(req.URL.Path, "/") {
		req.URL.Path = strings.TrimSuffix(req.URL.Path, "/")
	}

	// CORS configuration: check Origin against ALLOWED_ORIGINS if configured
	origin := req.Header.Get("Origin")
	allowOrigin := "*"
	if os.Getenv("ALLOWED_ORIGINS") != "" {
		allowOrigin = ""
	}
	if allowed := os.Getenv("ALLOWED_ORIGINS"); allowed != "" && origin != "" {
		for _, ao := range strings.Split(allowed, ",") {
			ao = strings.TrimSpace(ao)
			if strings.EqualFold(origin, ao) {
				allowOrigin = origin
				break
			}
		}
	}

	if allowOrigin != "" {
		w.Header().Set("Access-Control-Allow-Origin", allowOrigin)
	}
	w.Header().Add("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")

	if req.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if req.URL.Path != "/api/v1/health" && req.URL.Path != "/api/v1/auth/login" && req.URL.Path != "/api/v1/discovery" && (strings.HasPrefix(req.URL.Path, "/api/") || strings.HasPrefix(req.URL.Path, "/s/") || strings.HasPrefix(req.URL.Path, "/watch/")) {
		if maintenance, err := r.store.GetServerSetting(req.Context(), "maintenance_mode", "false"); err != nil {
			r.writeError(w, 503, "UNAVAILABLE", "Service is unavailable")
			return
		} else if maintenance == "true" {
			viewer := r.optionalViewer(req)
			owner, err := r.store.IsUserOwner(req.Context(), viewer)
			if err != nil || !owner {
				r.writeError(w, 503, "MAINTENANCE", "Service is under maintenance")
				return
			}
		}
	}
	r.mux.ServeHTTP(w, req)
}

func (r *Router) routes() {
	authRateMiddleware := r.authLimiter.Middleware(r)
	apiRateMiddleware := r.apiLimiter.Middleware(r)

	// Health check (unlimited)
	r.mux.HandleFunc("GET /api/v1/health", r.handleHealth)
	r.mux.HandleFunc("GET /api/v1/discovery", r.handleDiscovery)

	// Auth endpoints (public, brute-force rate limited)
	r.mux.Handle("POST /api/v1/auth/register", authRateMiddleware(http.HandlerFunc(r.handleRegister)))
	r.mux.Handle("POST /api/v1/auth/login", authRateMiddleware(http.HandlerFunc(r.handleLogin)))

	// Authenticated routes (rate limited)
	r.mux.Handle("GET /api/v1/auth/me", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleMe))))
	r.mux.Handle("POST /api/v1/auth/logout", r.authMiddleware(http.HandlerFunc(r.handleLogout)))
	r.mux.Handle("GET /api/v1/users", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSearchUsers))))
	r.mux.Handle("GET /api/v1/users/by-username/{username}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetUserByUsername))))
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
	r.mux.Handle("GET /api/v1/attachments/{id}", apiRateMiddleware(http.HandlerFunc(r.handleDownloadAttachment)))
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
	r.mux.Handle("POST /api/v1/stickers/packs/{id}/stickers", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAddStickerToPack))))
	r.mux.Handle("GET /api/v1/stickers/asset/{id}", http.HandlerFunc(r.handleServeStickerAsset))
	r.mux.Handle("POST /api/v1/stickers/upload-asset", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUploadStickerAsset))))
	r.mux.Handle("DELETE /api/v1/stickers/packs/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDeleteStickerPack))))
	r.mux.Handle("DELETE /api/v1/stickers/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDeleteSticker))))

	// Animated Media & GIFs
	r.mux.Handle("GET /api/v1/media/gifs", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSearchGIFs))))

	// Rich Link Previews
	r.mux.Handle("GET /api/v1/links/preview", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleLinkPreview))))

	// Group Slow Mode & Self-Destruct
	r.mux.Handle("POST /api/v1/conversations/{id}/slow-mode", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSetSlowMode))))
	r.mux.Handle("PUT /api/v1/users/self-destruct", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSetSelfDestruct))))

	// ArvanCloud S3 & Storage Status
	r.mux.Handle("GET /api/v1/storage/status", apiRateMiddleware(http.HandlerFunc(r.handleStorageStatus)))

	// Supergroup Forum Topics
	r.mux.Handle("POST /api/v1/conversations/{id}/forum/toggle", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleToggleConversationForum))))
	r.mux.Handle("GET /api/v1/conversations/{id}/topics", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetForumTopics))))
	r.mux.Handle("POST /api/v1/conversations/{id}/topics", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateForumTopic))))

	// Multiple Conversation Pins
	r.mux.Handle("GET /api/v1/conversations/{id}/pins", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetConversationPins))))
	r.mux.Handle("POST /api/v1/conversations/{id}/pins", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAddConversationPin))))
	r.mux.Handle("DELETE /api/v1/conversations/{id}/pins/{msgId}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRemoveConversationPin))))

	// Calls routes
	r.mux.Handle("GET /api/v1/calls/logs", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetCallLogs))))
	r.mux.Handle("POST /api/v1/calls/logs", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateCallLog))))

	// Polls routes
	r.mux.Handle("POST /api/v1/conversations/{id}/polls", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreatePoll))))
	r.mux.Handle("GET /api/v1/conversations/{id}/polls/{pollId}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetPoll))))
	r.mux.Handle("POST /api/v1/conversations/{id}/polls/{pollId}/vote", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleVotePoll))))
	r.mux.Handle("POST /api/v1/conversations/{id}/polls/{pollId}/close", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleClosePoll))))

	// Stories routes
	r.mux.Handle("POST /api/v1/stories", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateStory))))
	r.mux.Handle("GET /api/v1/stories", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetActiveStories))))
	r.mux.Handle("DELETE /api/v1/stories/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDeleteStory))))

	// Scheduled Messages routes
	r.mux.Handle("POST /api/v1/conversations/{id}/scheduled", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateScheduledMessage))))
	r.mux.Handle("GET /api/v1/conversations/{id}/scheduled", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetScheduledMessages))))
	r.mux.Handle("DELETE /api/v1/conversations/{id}/scheduled/{msgId}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDeleteScheduledMessage))))

	// Conversation Role route
	r.mux.Handle("GET /api/v1/conversations/{id}/role", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetMyConversationRole))))

	// Bot API routes
	r.mux.Handle("POST /api/v1/bot/sendMessage", apiRateMiddleware(http.HandlerFunc(r.handleBotSendMessage)))
	r.mux.Handle("POST /api/v1/bot/setWebhook", apiRateMiddleware(http.HandlerFunc(r.handleSetBotWebhook)))
	r.mux.Handle("POST /api/v1/bots/tokens", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateBotToken))))
	r.mux.Handle("GET /api/v1/bots/tokens", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleListBotTokens))))
	r.mux.Handle("DELETE /api/v1/bots/tokens/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRevokeBotToken))))

	// Read state & Receipts
	r.mux.Handle("POST /api/v1/conversations/{id}/read", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleMarkConversationRead))))
	r.mux.Handle("GET /api/v1/conversations/{id}/messages/{msgId}/readers", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetMessageReaders))))
	r.mux.Handle("POST /api/v1/conversations/{id}/messages/{msgId}/read", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRecordMessageRead))))
	r.mux.Handle("POST /api/v1/messages/purge-expired", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handlePurgeExpiredMessages))))

	// Administration & Member Roles
	r.mux.Handle("PUT /api/v1/conversations/{id}/members/{userId}/role", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUpdateMemberRole))))

	// Conversation Invites
	r.mux.Handle("POST /api/v1/conversations/{id}/invites", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateConversationInvite))))
	r.mux.Handle("GET /api/v1/conversations/{id}/invites", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleListConversationInvites))))
	r.mux.Handle("DELETE /api/v1/conversations/{id}/invites/{code}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRevokeConversationInvite))))
	r.mux.Handle("GET /api/v1/invites/{code}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetInvitePreview))))
	r.mux.Handle("POST /api/v1/invites/{code}/join", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleJoinInvite))))

	// Channel Message Views
	r.mux.Handle("POST /api/v1/conversations/{id}/messages/{msgId}/view", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRecordMessageView))))

	// Disappearing Messages (TTL)
	r.mux.Handle("PUT /api/v1/conversations/{id}/ttl", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleSetConversationTTL))))

	// Global Search & Exact ID Resolution
	r.mux.Handle("GET /api/v1/search", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGlobalSearch))))
	r.mux.Handle("GET /api/v1/resolve/{identifier}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleResolveIdentifier))))
	r.mux.Handle("POST /api/v1/conversations/{id}/join", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleJoinConversation))))

	// User Presence & Last Seen
	r.mux.Handle("GET /api/v1/presence/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetUserPresence))))
	r.mux.Handle("POST /api/v1/presence/batch", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetBatchPresence))))

	// WebRTC Dynamic ICE Servers (STUN/TURN)
	r.mux.Handle("GET /api/v1/webrtc/ice-servers", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetIceServers))))

	// Push Notifications Device Registration
	r.mux.Handle("POST /api/v1/notifications/devices", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleRegisterPushDevice))))
	r.mux.Handle("DELETE /api/v1/notifications/devices/{deviceId}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleUnregisterPushDevice))))

	// Master Bot & Server Administration
	r.mux.Handle("GET /api/v1/admin/status", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminStatus))))
	r.mux.Handle("GET /api/v1/admin/stats", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminStats))))
	r.mux.Handle("GET /api/v1/admin/users", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminListUsers))))
	r.mux.Handle("GET /api/v1/admin/registrations", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminListRegistrations))))
	r.mux.Handle("POST /api/v1/admin/users/{id}/approve", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminApproveUser))))
	r.mux.Handle("POST /api/v1/admin/users/{id}/reject", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminRejectUser))))
	r.mux.Handle("POST /api/v1/admin/users/{id}/ban", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminBanUser))))
	r.mux.Handle("POST /api/v1/admin/users/{id}/unban", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminUnbanUser))))
	r.mux.Handle("DELETE /api/v1/admin/users/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminDeleteUser))))
	r.mux.Handle("GET /api/v1/admin/conversations", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminListConversations))))
	r.mux.Handle("POST /api/v1/admin/bot/action", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminBotAction))))
	r.mux.Handle("POST /api/v1/admin/broadcast", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminBroadcast))))
	r.mux.Handle("PUT /api/v1/admin/settings", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminUpdateSettings))))
	r.mux.Handle("GET /api/v1/admin/bot/conversation", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetMasterBotConversation))))
	r.mux.Handle("GET /api/v1/admin/banned-ips", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminListBannedIPs))))
	r.mux.Handle("POST /api/v1/admin/banned-ips", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminBanIP))))
	r.mux.Handle("DELETE /api/v1/admin/banned-ips/{ip}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminUnbanIP))))
	r.mux.Handle("GET /api/v1/admin/backup/download", r.authMiddleware(http.HandlerFunc(r.handleAdminDownloadBackup)))
	r.mux.Handle("POST /api/v1/admin/storage/migrate", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleAdminMigrateStorage))))

	// Media Shares & Standalone Streaming Player
	r.mux.Handle("POST /api/v1/media/share", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleCreateMediaShare))))
	r.mux.Handle("GET /api/v1/media/share/{id}", apiRateMiddleware(http.HandlerFunc(r.handleGetMediaShare)))
	r.mux.Handle("DELETE /api/v1/media/share/{id}", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleDeleteMediaShare))))
	r.mux.Handle("GET /s/{id}", http.HandlerFunc(r.handlePublicStreamDownload))
	r.mux.Handle("GET /watch/{id}", http.HandlerFunc(r.handlePublicWatchPlayer))
	r.mux.Handle("GET /api/v1/s/{id}", http.HandlerFunc(r.handlePublicStreamDownload))
	r.mux.Handle("GET /api/v1/watch/{id}", http.HandlerFunc(r.handlePublicWatchPlayer))
	r.mux.Handle("GET /api/v1/media/stream/{id}", http.HandlerFunc(r.handlePublicStreamDownload))
	r.mux.Handle("GET /api/v1/media/watch/{id}", http.HandlerFunc(r.handlePublicWatchPlayer))

	// In-Chat Synchronized Watch Party
	r.mux.Handle("GET /api/v1/conversations/{id}/watch-party", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleGetWatchParty))))
	r.mux.Handle("POST /api/v1/conversations/{id}/watch-party/action", r.authMiddleware(apiRateMiddleware(http.HandlerFunc(r.handleWatchPartyAction))))

	// WebSocket gateway
	r.mux.HandleFunc("GET /api/v1/ws", r.handleWebSocket)

	// Static frontend serving if dist directory exists
	distDirs := []string{"./dist", "../web/dist", "../../apps/web/dist", "./apps/web/dist", "apps/web/dist"}
	var staticDir string
	for _, dir := range distDirs {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			staticDir = dir
			break
		}
	}
	// Linux upgrades publish the web bundle directly in WorkingDirectory.
	// Recognize that layout without exposing the database, .env or uploads.
	if staticDir == "" {
		if info, err := os.Stat("manifest.json"); err == nil && info.Size() < 64<<10 {
			var manifest struct {
				Name string `json:"name"`
			}
			data, _ := os.ReadFile("manifest.json")
			if json.Unmarshal(data, &manifest) == nil && manifest.Name == "SENORA" {
				if index, err := os.Stat("index.html"); err == nil && !index.IsDir() {
					staticDir = "."
				}
			}
		}
	}
	if staticDir != "" {
		r.frontendDir = staticDir
		fs := http.FileServer(http.Dir(staticDir))
		r.mux.HandleFunc("GET /", func(w http.ResponseWriter, req *http.Request) {
			cleanPath := urlpath.Clean(req.URL.Path)
			if strings.Contains(cleanPath, "\\") || strings.HasPrefix(cleanPath, "/api/") {
				http.NotFound(w, req)
				return
			}
			publicAsset := strings.HasPrefix(cleanPath, "/assets/") || strings.HasPrefix(cleanPath, "/icons/") || cleanPath == "/index.html" || cleanPath == "/manifest.json" || cleanPath == "/favicon.svg" || cleanPath == "/sw.js"
			if publicAsset {
				filePath := filepath.Join(staticDir, cleanPath)
				if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
					fs.ServeHTTP(w, req)
					return
				}
				http.NotFound(w, req)
				return
			}
			if filepath.Ext(cleanPath) != "" {
				http.NotFound(w, req)
				return
			}
			http.ServeFile(w, req, filepath.Join(staticDir, "index.html"))
		})
	}
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
		if active, err := r.store.GetServerSetting(ctx, "maintenance_mode", "false"); err != nil {
			r.writeError(w, http.StatusServiceUnavailable, "UNAVAILABLE", "Service configuration unavailable")
			return
		} else if active == "true" && !user.IsOwner {
			r.writeError(w, http.StatusServiceUnavailable, "MAINTENANCE", "Service is under maintenance")
			return
		}
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
	if _, err := r.store.GetServerSetting(req.Context(), "maintenance_mode", "false"); err != nil {
		r.writeError(w, 503, "UNAVAILABLE", "Database is unavailable")
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":    "ok",
		"version":   "1.0.0",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func (r *Router) handleDiscovery(w http.ResponseWriter, req *http.Request) {
	r.writeJSON(w, http.StatusOK, models.ServerDiscovery{
		ServerID:        "senora-primary-v1",
		Name:            "SENORA Secure Messaging",
		Version:         "1.0.0",
		APIVersion:      "v1",
		ProtocolVersion: "1.0.0",
		Health:          "healthy",
		Maintenance:     false,
		Capabilities: models.ServerCapabilities{
			AuthMethods:       []string{"password"},
			EncryptionModes:   []string{"e2ee_v1_signal", "standard"},
			Calling:           []string{"webrtc_p2p", "voice_chat_mesh"},
			MaxUploadBytes:    104857600, // 100MB
			PushNotifications: []string{"webpush", "fcm_relay"},
			Features: []string{
				"multi_server",
				"groups",
				"channels",
				"stories",
				"polls",
				"stickers",
				"scheduled_messages",
				"disappearing_messages",
				"read_receipts",
			},
		},
	})
}

type registerPushDeviceReq struct {
	DeviceID string `json:"device_id"`
	Platform string `json:"platform"`
	Endpoint string `json:"endpoint"`
	P256DH   string `json:"p256dh,omitempty"`
	Auth     string `json:"auth,omitempty"`
}

func (r *Router) handleRegisterPushDevice(w http.ResponseWriter, req *http.Request) {
	u := getUserFromContext(req.Context())
	if u == nil {
		r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "User context missing")
		return
	}

	req.Body = http.MaxBytesReader(w, req.Body, 64*1024)
	var body registerPushDeviceReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	body.DeviceID = strings.TrimSpace(body.DeviceID)
	body.Platform = strings.ToLower(strings.TrimSpace(body.Platform))
	body.Endpoint = strings.TrimSpace(body.Endpoint)

	if body.DeviceID == "" || body.Endpoint == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "device_id and endpoint are required")
		return
	}

	validPlatforms := map[string]bool{
		"web": true, "android": true, "windows": true, "linux": true, "ios": true,
	}
	if !validPlatforms[body.Platform] {
		body.Platform = "web"
	}

	reg := &models.PushDeviceRegistration{
		ID:       uuid.New().String(),
		UserID:   u.ID,
		DeviceID: body.DeviceID,
		Platform: body.Platform,
		Endpoint: body.Endpoint,
		P256DH:   strings.TrimSpace(body.P256DH),
		Auth:     strings.TrimSpace(body.Auth),
	}

	if err := r.store.RegisterPushDevice(req.Context(), reg); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to register push device")
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": "registered",
		"device": reg,
	})
}

func (r *Router) handleUnregisterPushDevice(w http.ResponseWriter, req *http.Request) {
	u := getUserFromContext(req.Context())
	if u == nil {
		r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "User context missing")
		return
	}

	deviceID := req.PathValue("deviceId")
	if deviceID == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Missing deviceId parameter")
		return
	}

	if err := r.store.UnregisterPushDevice(req.Context(), u.ID, deviceID); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to unregister push device")
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": "unregistered",
	})
}

type registerReq struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
	DeviceName  string `json:"device_name"`
}

func (r *Router) handleRegister(w http.ResponseWriter, req *http.Request) {
	clientIP := GetClientIP(req)
	if isBanned, _ := r.store.IsIPBanned(req.Context(), clientIP); isBanned {
		r.writeError(w, http.StatusForbidden, "IP_BANNED", "آدرس آی‌پی شما به دلیل ارسال درخواست‌های غیرمجاز یا اسپم مسدود شده است.")
		return
	}

	req.Body = http.MaxBytesReader(w, req.Body, 1024*1024)
	var body registerReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body or payload exceeds size limit")
		return
	}

	result, err := r.identity.Register(req.Context(), identity.RegisterParams{
		Username:       body.Username,
		DisplayName:    body.DisplayName,
		Password:       body.Password,
		DeviceName:     body.DeviceName,
		RegistrationIP: clientIP,
	})
	if err != nil {
		r.checkAutoBan(req.Context(), clientIP, "ارسال مکرر درخواست‌های نامعتبر ثبت‌نام")
		r.writeError(w, http.StatusBadRequest, "REGISTRATION_FAILED", err.Error())
		return
	}

	fingerprint := GenerateDeviceFingerprint(req, clientIP)

	if result.IsPendingApproval {
		// Alert the Server Owner via Master Bot conversation
		go func() {
			_ = r.masterBot.NotifyNewRegistration(context.Background(), result.User, body.DeviceName, clientIP, fingerprint)
		}()

		r.writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":    "PENDING_APPROVAL",
			"message":   "حساب کاربری شما با موفقیت ثبت شد و در انتظار تایید مدیر سرور می‌باشد.",
			"user":      result.User,
			"user_id":   result.User.ID,
			"device_id": result.Device.ID,
		})
		return
	}

	tokenStr := ""
	if result.Session != nil {
		tokenStr = result.Session.Token
	}

	r.writeJSON(w, http.StatusCreated, map[string]interface{}{
		"user":      result.User,
		"token":     tokenStr,
		"device_id": result.Device.ID,
	})
}

type loginReq struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	DeviceName string `json:"device_name"`
}

func (r *Router) handleLogin(w http.ResponseWriter, req *http.Request) {
	clientIP := GetClientIP(req)
	if isBanned, _ := r.store.IsIPBanned(req.Context(), clientIP); isBanned {
		r.writeError(w, http.StatusForbidden, "IP_BANNED", "آدرس آی‌پی شما مسدود شده است.")
		return
	}

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
		if errors.Is(err, identity.ErrPendingApproval) {
			r.writeError(w, http.StatusForbidden, "ACCOUNT_PENDING_APPROVAL", "حساب کاربری شما هنوز توسط مدیر سرور تایید نشده است. لطفاً منتظر بمانید.")
			return
		}
		if errors.Is(err, identity.ErrUserBanned) {
			r.writeError(w, http.StatusForbidden, "ACCOUNT_BANNED", "حساب کاربری شما توسط مدیر سرور مسدود شده است.")
			return
		}
		r.checkAutoBan(req.Context(), clientIP, "تلاش‌های مکرر ناموفق ورود به حساب (Brute-force)")
		r.writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "Invalid username or password")
		return
	}

	// Login succeeded: reset failure count
	r.autoBanTracker.ResetIP(clientIP)

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"user":      result.User,
		"token":     result.Session.Token,
		"device_id": result.Device.ID,
	})
}

func (r *Router) handleLogout(w http.ResponseWriter, req *http.Request) {
	sess := getSessionFromContext(req.Context())
	if sess != nil {
		var err error
		if req.URL.Query().Get("all_devices") == "true" {
			err = r.store.DeleteUserSessions(req.Context(), sess.UserID)
		} else {
			err = r.sessions.RevokeSession(req.Context(), sess.Token)
		}
		if err != nil {
			r.writeError(w, 500, "INTERNAL_ERROR", "Failed to revoke sessions")
			return
		}
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
	if b, ok := req.Context().Value(botContextKey).(*models.ManagedBot); ok {
		for _, c := range convs {
			if !r.store.BotCanReadMessage(req.Context(), b, c.LastMessage) {
				c.LastMessage = nil
			}
		}
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
	if b, ok := req.Context().Value(botContextKey).(*models.ManagedBot); ok && !r.store.BotCanReadMessage(req.Context(), b, conv.LastMessage) {
		conv.LastMessage = nil
	}
	r.writeJSON(w, http.StatusOK, conv)
}

type createConvReq struct {
	Type              string   `json:"type"`
	Title             string   `json:"title"`
	Description       string   `json:"description"`
	Username          string   `json:"username,omitempty"`
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
		if targetPeerID == masterbot.BotUserID {
			isOwner, _ := r.store.IsUserOwner(req.Context(), user.ID)
			if !isOwner {
				r.writeError(w, http.StatusForbidden, "FORBIDDEN", "ربات مدیریت سرور صرفاً برای مالک سرور در دسترس است.")
				return
			}
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
		for _, mID := range body.MemberIDs {
			if mID == masterbot.BotUserID {
				r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "امکان افزودن ربات مدیریت به گروه‌ها وجود ندارد.")
				return
			}
		}
		conv, err := r.convs.CreateGroupConversation(req.Context(), user.ID, body.Title, body.MemberIDs)
		if err != nil {
			r.writeError(w, http.StatusBadRequest, "CONVERSATION_CREATE_FAILED", err.Error())
			return
		}
		if body.Username != "" {
			conv.Username = strings.TrimPrefix(strings.TrimSpace(body.Username), "@")
			_ = r.store.UpdateConversation(req.Context(), conv)
		}
		r.writeJSON(w, http.StatusCreated, conv)
		return
	}

	if body.Type == "channel" {
		conv, err := r.convs.CreateChannelConversation(req.Context(), user.ID, body.Title, body.Description, body.Username)
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
	if bot, ok := req.Context().Value(botContextKey).(*models.ManagedBot); ok {
		filtered := []*models.Message{}
		for _, m := range msgs {
			if r.store.BotCanReadMessage(req.Context(), bot, m) {
				filtered = append(filtered, m)
			}
		}
		msgs = filtered
	}
	if msgs == nil {
		msgs = []*models.Message{}
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"messages": msgs})
}

type submitMsgReq struct {
	IdempotencyKey     string   `json:"idempotency_key"`
	Ciphertext         string   `json:"ciphertext"`
	Nonce              string   `json:"nonce"`
	EphemeralPublicKey string   `json:"ephemeral_public_key"`
	ReplyToID          string   `json:"reply_to_id"`
	TopicID            string   `json:"topic_id,omitempty"`
	AttachmentIDs      []string `json:"attachment_ids,omitempty"`
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

	// Channel write authorization check & Group Slow Mode check
	conv, err := r.store.GetConversationByID(req.Context(), convID)
	if err == nil && conv != nil {
		if conv.Type == "channel" {
			role, roleErr := r.store.GetMemberRole(req.Context(), convID, user.ID)
			if roleErr != nil || (role != "owner" && role != "admin") {
				r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only channel admins can post messages to channels")
				return
			}
		} else if conv.Type == "group" && conv.SlowModeSeconds > 0 {
			role, _ := r.store.GetMemberRole(req.Context(), convID, user.ID)
			if role != "owner" && role != "admin" {
				lastTime, lErr := r.store.GetUserLastMessageTime(req.Context(), convID, user.ID)
				if lErr == nil && !lastTime.IsZero() {
					elapsed := time.Since(lastTime)
					limit := time.Duration(conv.SlowModeSeconds) * time.Second
					if elapsed < limit {
						remain := int((limit - elapsed).Seconds()) + 1
						r.writeError(w, http.StatusTooManyRequests, "SLOW_MODE", fmt.Sprintf("حالت آهسته فعال است. لطفاً %d ثانیه دیگر صبر کنید.", remain))
						return
					}
				}
			}
		}

		// Group & Channel Anti-Spam & Link Filtering
		antiSpamEnabled, _ := r.store.GetServerSetting(req.Context(), "antispam_enabled", "false")
		if antiSpamEnabled == "true" && (conv.Type == "group" || conv.Type == "channel") {
			role, _ := r.store.GetMemberRole(req.Context(), convID, user.ID)
			if role != "owner" && role != "admin" {
				lowerCipher := strings.ToLower(body.Ciphertext)
				if strings.Contains(lowerCipher, "http://") || strings.Contains(lowerCipher, "https://") || strings.Contains(lowerCipher, "t.me/") || strings.Contains(lowerCipher, "telegram.me/") {
					r.writeError(w, http.StatusForbidden, "LINK_SPAM_BLOCKED", "ارسال لینک در این گروه توسط سیستم آنتی‌اسپم مسدود شده است.")
					return
				}
			}
		}
	}
	_ = r.store.UpdateUserLastSeen(req.Context(), user.ID)

	msg, err := r.msgs.SubmitMessage(req.Context(), messages.SubmitMessageParams{
		ConversationID:     convID,
		SenderID:           user.ID,
		Ciphertext:         body.Ciphertext,
		Nonce:              body.Nonce,
		EphemeralPublicKey: body.EphemeralPublicKey,
		IdempotencyKey:     body.IdempotencyKey,
		ReplyToID:          body.ReplyToID,
		TopicID:            body.TopicID,
		AttachmentIDs:      body.AttachmentIDs,
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

	isBotMember, _ := r.store.IsMember(req.Context(), convID, masterbot.BotUserID)
	isFatherMember, _ := r.store.IsMember(req.Context(), convID, models.BotFatherID)
	if isFatherMember && user.ID != models.BotFatherID && msg.Nonce == "normal" {
		claimed, claimErr := r.store.ClaimBotFatherMessage(req.Context(), msg.ID)
		if claimErr != nil {
			r.writeError(w, 500, "STORAGE_ERROR", "BotFather command could not be recorded")
			return
		}
		if claimed {
			if err := r.handleBotFatherMessage(req.Context(), user.ID, convID, body.Ciphertext); err != nil {
				log.Printf("BotFather response failed: %v", err)
			}
		}
		r.writeJSON(w, http.StatusCreated, msg)
		return
	}

	// Proxy test command interception (/proxy [proxy] or /testproxy [proxy])
	if r.downloader != nil && r.downloader.IsProxyTestCommand(body.Ciphertext) {
		go func(cID, sID, cipher, rID string) {
			r.downloader.HandleProxyTest(context.Background(), cID, sID, cipher, rID)
		}(convID, user.ID, body.Ciphertext, msg.ID)
	} else if r.downloader != nil && r.downloader.IsSyncS3Command(body.Ciphertext) {
		// Arvan S3 sync & migration command (/sync_s3 or /migrate_s3)
		go func(cID, sID, cipher, rID string) {
			r.downloader.HandleSyncS3(context.Background(), cID, sID, cipher, rID)
		}(convID, user.ID, body.Ciphertext, msg.ID)
	} else if r.downloader != nil && r.downloader.IsDownloadCommand(body.Ciphertext) {
		// Video downloader command interception (/dl [link] [proxy] [quality])
		go func(cID, sID, cipher, rID string) {
			r.downloader.HandleDownload(context.Background(), cID, sID, cipher, rID)
		}(convID, user.ID, body.Ciphertext, msg.ID)
	} else if isBotMember && user.ID != masterbot.BotUserID {
		// If message is submitted to a conversation involving Master Bot, trigger bot logic
		go func() {
			_, _ = r.masterBot.HandleOwnerMessage(context.Background(), user.ID, convID, body.Ciphertext)
		}()
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

	var body struct {
		AttachmentIDs []string `json:"attachment_ids"`
	}
	if req.ContentLength > 0 {
		req.Body = http.MaxBytesReader(w, req.Body, 4096)
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			r.writeError(w, 400, "BAD_REQUEST", "Invalid attachment references")
			return
		}
	}
	if len(body.AttachmentIDs) > 16 {
		r.writeError(w, 400, "BAD_REQUEST", "Too many attachment references")
		return
	}
	if err := r.msgs.DeleteMessageForEveryone(req.Context(), convID, msgID, user.ID, body.AttachmentIDs...); err != nil {
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
	Title           string `json:"title"`
	Description     string `json:"description"`
	AvatarURL       string `json:"avatar_url"`
	SlowModeSeconds *int   `json:"slow_mode_seconds"`
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
	if body.SlowModeSeconds != nil && *body.SlowModeSeconds >= 0 {
		if err := r.store.UpdateConversationSlowMode(req.Context(), convID, *body.SlowModeSeconds); err != nil {
			r.writeError(w, 500, "INTERNAL_ERROR", "Failed to update slow mode")
			return
		}
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

type setSlowModeReq struct {
	SlowModeSeconds int `json:"slow_mode_seconds"`
}

func (r *Router) handleSetSlowMode(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	role, err := r.store.GetMemberRole(req.Context(), convID, user.ID)
	if err != nil || (role != "owner" && role != "admin") {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only group admins can configure slow mode")
		return
	}
	var body setSlowModeReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}
	if body.SlowModeSeconds < 0 {
		body.SlowModeSeconds = 0
	}
	if err := r.store.UpdateConversationSlowMode(req.Context(), convID, body.SlowModeSeconds); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"status": "updated", "slow_mode_seconds": body.SlowModeSeconds})
}

type setSelfDestructReq struct {
	Months int `json:"months"`
}

func (r *Router) handleSetSelfDestruct(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	var body setSelfDestructReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}
	if body.Months < 0 || body.Months > 24 {
		r.writeError(w, 400, "BAD_REQUEST", "Invalid expiry period")
		return
	}
	if err := r.store.UpdateUserSelfDestruct(req.Context(), user.ID, body.Months); err != nil {
		r.writeError(w, http.StatusBadRequest, "INVALID_EXPIRY", err.Error())
		return
	}
	user.SelfDestructMonths = body.Months
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"status": "updated", "self_destruct_months": body.Months, "self_destruct_enabled": body.Months > 0})
}

type updateProfileReq struct {
	DisplayName        string `json:"display_name"`
	Bio                string `json:"bio"`
	AvatarURL          string `json:"avatar_url"`
	SelfDestructMonths int    `json:"self_destruct_months"`
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
	if body.SelfDestructMonths > 0 {
		user.SelfDestructMonths = body.SelfDestructMonths
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

func getMaxUploadBytes() int64 {
	val := strings.TrimSpace(os.Getenv("MAX_UPLOAD_BYTES"))
	if val == "" {
		return 500 * 1024 * 1024 // Default: 500MB (instead of 25MB)
	}
	if val == "0" || val == "-1" || strings.EqualFold(val, "unlimited") || strings.EqualFold(val, "none") {
		return 0 // Unlimited (no body size limit imposed by Go server)
	}
	parsed, err := strconv.ParseInt(val, 10, 64)
	if err != nil || parsed < 0 {
		return 500 * 1024 * 1024
	}
	return parsed
}

func (r *Router) handleUploadAttachment(w http.ResponseWriter, req *http.Request) {
	maxBytes := getMaxUploadBytes()
	// Multipart parsing can spill to the OS temp volume before the managed copy.
	reserve := int64(256 << 20)
	if n, err := strconv.ParseInt(os.Getenv("SENORA_DISK_RESERVE_BYTES"), 10, 64); err == nil && n > 0 {
		reserve = n
	}
	if err := os.MkdirAll(r.fileStore.GetUploadsDir(), 0755); err != nil {
		r.writeError(w, 507, "STORAGE_FULL", "Storage unavailable")
		return
	}
	for _, path := range []string{os.TempDir(), r.fileStore.GetUploadsDir()} {
		free, err := diskguard.FreeBytes(path)
		if err != nil || free <= uint64(reserve) {
			r.writeError(w, 507, "STORAGE_FULL", "Insufficient free disk space")
			return
		}
		room := (int64(free) - reserve) / 2
		if maxBytes == 0 || room < maxBytes {
			maxBytes = room
		}
	}
	req.Body = uploadBody{ReadCloser: req.Body, controller: http.NewResponseController(w)}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(35 * time.Minute))

	if maxBytes > 0 {
		req.Body = http.MaxBytesReader(w, req.Body, maxBytes)
	}
	user := getUserFromContext(req.Context())

	defer func() {
		if req.MultipartForm != nil {
			_ = req.MultipartForm.RemoveAll()
		}
	}()
	if err := req.ParseMultipartForm(32 * 1024 * 1024); err != nil {
		msg := "Failed to parse multipart form"
		if maxBytes > 0 {
			msg = fmt.Sprintf("File exceeds upload limit of %d MB", maxBytes/(1024*1024))
		}
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", msg)
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
	if _, ok := req.Context().Value(botContextKey).(*models.ManagedBot); ok {
		if conv == nil || conv.SecurityMode != "normal" {
			r.writeError(w, 403, "FORBIDDEN", "Bots require normal conversations")
			return
		}
		req.MultipartForm.Value["is_encrypted"] = []string{"false"}
		req.Form.Set("is_encrypted", "false")
	}
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

	filename := header.Filename
	if filename == "" {
		filename = "attachment"
	}
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	attID := "att_" + uuid.New().String()
	ext := filepath.Ext(header.Filename)

	savedFile, sErr := r.fileStore.SaveFile(req.Context(), "attachments", attID+ext, contentType, file, header.Size)
	if sErr != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to save attachment file")
		return
	}

	isViewOnce := req.FormValue("is_view_once") == "true"

	att := &models.Attachment{
		ID:             attID,
		ConversationID: convID,
		UploaderID:     user.ID,
		Filename:       filename,
		ContentType:    contentType,
		SizeBytes:      savedFile.SizeBytes,
		StoragePath:    savedFile.StoragePath,
		IsEncrypted:    req.FormValue("is_encrypted") != "false",
		IsViewOnce:     isViewOnce,
		StorageType:    savedFile.StorageType,
		PublicURL:      savedFile.PublicURL,
	}

	if err := r.store.CreateAttachment(req.Context(), att); err != nil {
		if savedFile.StorageType == "local" || savedFile.StorageType == "local_fallback" {
			_ = os.Remove(savedFile.StoragePath)
		}
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusCreated, att)
}

func (r *Router) handleDownloadAttachment(w http.ResponseWriter, req *http.Request) {
	w = streamWriter(w)
	attID := req.PathValue("id")

	att, err := r.store.GetAttachmentByID(req.Context(), attID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Attachment not found")
		return
	}

	authorized := false
	viewerID := ""
	if user := getUserFromContext(req.Context()); user != nil {
		viewerID = user.ID
		authorized = r.convs.ValidateMembership(req.Context(), att.ConversationID, user.ID) == nil
	}

	if !authorized {
		authHeader := req.Header.Get("Authorization")
		token := ""
		if strings.HasPrefix(authHeader, "Bearer ") {
			token = strings.TrimPrefix(authHeader, "Bearer ")
		} else if cookie, err := req.Cookie("senora_session"); err == nil {
			token = cookie.Value
		} else {
			token = req.URL.Query().Get("auth")
			if token == "" {
				token = req.URL.Query().Get("session_token")
			}
			if token == "" {
				token = req.URL.Query().Get("token")
			}
		}

		if token != "" {
			sess, user, err := r.sessions.ValidateSession(req.Context(), token)
			if err == nil && sess != nil && user != nil {
				viewerID = user.ID
				// Member of conversation
				if err := r.convs.ValidateMembership(req.Context(), att.ConversationID, user.ID); err == nil {
					authorized = true
				} else if shared, err := r.store.CanReadAttachmentReference(req.Context(), att.ID, user.ID); err == nil && shared {
					authorized = true
				}
			}
		}
	}

	if !authorized {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not authorized to access attachments in this conversation")
		return
	}

	if err := r.store.AuthorizeAttachmentDownload(req.Context(), att.ID, viewerID, false); err != nil {
		r.writeError(w, http.StatusGone, "ATTACHMENT_UNAVAILABLE", "Attachment was deleted or already viewed")
		return
	}
	if wantsMediaIndex(req) {
		r.serveMediaIndex(w, req, att)
		return
	}
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
	if !att.IsEncrypted {
		contentType = mediaContentType(contentType, cleanFilename)
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	if !att.IsEncrypted && !att.IsViewOnce {
		req = mediaRangeRequest(req, att.SizeBytes, contentType)
	}
	disposition := "inline"
	if req.URL.Query().Get("download") == "true" || !safeInlineType(contentType) {
		disposition = "attachment"
	}

	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Range, Content-Type, Authorization")
	if req.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`%s; filename="%s"; filename*=UTF-8''%s`, disposition, asciiFallback, escapedFilename))

	var file *os.File
	var openErr error
	if att.StoragePath != "" && !filestore.IsS3URL(att.StoragePath) {
		file, openErr = os.Open(att.StoragePath)
	}
	if file == nil {
		attBase := filepath.Base(att.StoragePath)
		candidatePaths := []string{
			att.StoragePath,
			filepath.Join(getUploadsDir(), "attachments", attBase),
			filepath.Join(getUploadsDir(), attBase),
			filepath.Join("uploads", "attachments", attBase),
			filepath.Join("uploads", attBase),
			filepath.Join("./uploads", "attachments", attBase),
			filepath.Join("./uploads", attBase),
			filepath.Join("/var/www/senora/uploads", "attachments", attBase),
			filepath.Join("/var/www/senora/uploads", attBase),
		}
		for _, p := range candidatePaths {
			if p == "" {
				continue
			}
			file, openErr = os.Open(p)
			if openErr == nil {
				break
			}
		}
	}

	if file != nil {
		defer file.Close()
		if err := r.store.AuthorizeAttachmentDownload(req.Context(), att.ID, viewerID, req.Method != http.MethodHead); err != nil {
			r.writeError(w, http.StatusGone, "ATTACHMENT_UNAVAILABLE", "Attachment was deleted or already viewed")
			return
		}
		stat, _ := file.Stat()
		modTime := time.Now()
		if stat != nil {
			modTime = stat.ModTime()
		}
		// http.ServeContent automatically handles Range headers, 206 Partial Content, Content-Range, and Seeking
		http.ServeContent(w, req, cleanFilename, modTime, file)
		return
	}

	// If local file is missing but stored on S3, stream from S3 directly to client with Range forwarding and SigV4 authentication
	if (att.StorageType == "arvan_s3" || filestore.IsS3URL(att.PublicURL) || filestore.IsS3URL(att.StoragePath)) && r.fileStore != nil {
		targetURL := att.PublicURL
		if targetURL == "" || !filestore.IsS3URL(targetURL) {
			targetURL = att.StoragePath
		}
		if filestore.IsS3URL(targetURL) {
			s3Resp, s3Err := r.fileStore.StreamS3ObjectMethod(req.Context(), req.Method, targetURL, req.Header.Get("Range"))
			if s3Err == nil && (s3Resp.StatusCode == http.StatusOK || s3Resp.StatusCode == http.StatusPartialContent) {
				defer s3Resp.Body.Close()
				if err := r.store.AuthorizeAttachmentDownload(req.Context(), att.ID, viewerID, req.Method != http.MethodHead); err != nil {
					r.writeError(w, http.StatusGone, "ATTACHMENT_UNAVAILABLE", "Attachment was deleted or already viewed")
					return
				}
				writeMediaUpstream(w, req, s3Resp)
				return
			}
			if s3Err == nil && s3Resp != nil && s3Resp.StatusCode == 416 {
				writeMediaUpstream(w, req, s3Resp)
				return
			}
			if s3Resp != nil {
				s3Resp.Body.Close()
			}
		}
	}

	r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Attachment file on storage is missing")
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
	clientIP := GetClientIP(req)
	if isBanned, _ := r.store.IsIPBanned(req.Context(), clientIP); isBanned {
		http.Error(w, "Forbidden: IP address is banned", http.StatusForbidden)
		return
	}

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

func normalizeStickerAssetURLs(stickers []*models.Sticker) {
	for _, st := range stickers {
		if strings.HasPrefix(st.AssetURL, "data:") {
			st.AssetURL = "/api/v1/stickers/asset/" + st.ID
		}
	}
}

func (r *Router) handleGetStickerPack(w http.ResponseWriter, req *http.Request) {
	packID := req.PathValue("id")
	pack, err := r.store.GetStickerPackByID(req.Context(), packID)
	if err != nil || pack == nil {
		// 1. Try finding by Sticker ID (if client clicked directly on a sticker)
		if stk, sErr := r.store.GetStickerByID(req.Context(), packID); sErr == nil && stk != nil && stk.PackID != "" {
			packID = stk.PackID
			pack, err = r.store.GetStickerPackByID(req.Context(), packID)
		}
		// 2. Try finding by Share Code
		if (err != nil || pack == nil) && len(packID) > 0 {
			if scPack, scErr := r.store.GetStickerPackByShareCode(req.Context(), packID); scErr == nil && scPack != nil {
				pack = scPack
				packID = scPack.ID
				err = nil
			}
		}
	}
	if err != nil || pack == nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Sticker pack not found")
		return
	}
	stickers, err := r.store.GetStickersForPack(req.Context(), packID)
	if err == nil {
		normalizeStickerAssetURLs(stickers)
		pack.Stickers = stickers
	}
	r.writeJSON(w, http.StatusOK, pack)
}

func (r *Router) handleInstallStickerPack(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	packID := req.PathValue("id")
	if stk, sErr := r.store.GetStickerByID(req.Context(), packID); sErr == nil && stk != nil && stk.PackID != "" {
		packID = stk.PackID
	}
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
	for _, p := range packs {
		normalizeStickerAssetURLs(p.Stickers)
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"packs": packs})
}

func cleanStickerFile(assetURL string) {
	if !strings.HasPrefix(assetURL, "/api/v1/stickers/asset/") {
		return
	}
	filename := strings.TrimPrefix(assetURL, "/api/v1/stickers/asset/")
	if strings.Contains(filename, "..") || strings.Contains(filename, "/") || strings.Contains(filename, "\\") {
		return
	}
	uploadsDir := filepath.Join(getUploadsDir(), "stickers")
	_ = os.Remove(filepath.Join(uploadsDir, filename))
}

func (r *Router) handleDeleteStickerPack(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	packID := req.PathValue("id")

	pack, err := r.store.GetStickerPackByID(req.Context(), packID)
	if err != nil || pack == nil {
		r.writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
		return
	}

	isOwner, _ := r.store.IsUserOwner(req.Context(), user.ID)
	isCreator := pack.CreatorID == user.ID || (pack.CreatorID == "" && !pack.IsBuiltin)

	if pack.IsBuiltin || (!isCreator && !isOwner) {
		if err := r.store.UninstallStickerPack(req.Context(), user.ID, packID); err != nil {
			r.writeError(w, http.StatusBadRequest, "UNINSTALL_FAILED", err.Error())
			return
		}
		r.writeJSON(w, http.StatusOK, map[string]string{"status": "uninstalled"})
		return
	}

	for _, s := range pack.Stickers {
		cleanStickerFile(s.AssetURL)
	}
	cleanStickerFile(pack.ThumbnailURL)

	if err := r.store.DeleteStickerPack(req.Context(), packID, user.ID); err != nil {
		r.writeError(w, http.StatusBadRequest, "DELETE_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (r *Router) handleDeleteSticker(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	stickerID := req.PathValue("id")
	if stk, err := r.store.GetStickerByID(req.Context(), stickerID); err == nil && stk != nil {
		cleanStickerFile(stk.AssetURL)
	}
	if err := r.store.DeleteSticker(req.Context(), stickerID, user.ID); err != nil {
		r.writeError(w, http.StatusBadRequest, "DELETE_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
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

	// Record call outcome as an in-chat system message
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
		"avatar_url":   r.visibleAvatarURL(req, targetUser),
		"created_at":   targetUser.CreatedAt,
	}
	r.writeJSON(w, http.StatusOK, publicProfile)
}

func (r *Router) handleGetUserByUsername(w http.ResponseWriter, req *http.Request) {
	username := strings.TrimPrefix(strings.TrimSpace(req.PathValue("username")), "@")
	if strings.EqualFold(username, models.BotFatherUsername) {
		_ = r.ensureBotFather(req.Context())
	}
	if username == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Username is required")
		return
	}
	targetUser, err := r.store.GetUserByUsername(req.Context(), username)
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
		"avatar_url":   r.visibleAvatarURL(req, targetUser),
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
// Conversation Deletion, Security Mode, Voice Chat, Avatars, Stickers, GIFs
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
	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".png"
	}
	filename := fmt.Sprintf("avatar_%s_%d%s", user.ID, time.Now().UnixNano(), ext)

	savedFile, sErr := r.fileStore.SaveFile(req.Context(), "avatars", filename, detectedType, file, header.Size)
	if sErr != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to store avatar")
		return
	}

	avatarURL := savedFile.PublicURL
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
		"pinned_convs":           true,
		"pinnedIds":              true,
		"archived_convs":         true,
		"archivedIds":            true,
		"muted_convs":            true,
		"mutedIds":               true,
		"custom_folders":         true,
	}

	existingJSON, _ := r.store.GetUserPreferences(req.Context(), user.ID)
	merged := make(map[string]interface{})
	if existingJSON != "" && existingJSON != "{}" {
		_ = json.Unmarshal([]byte(existingJSON), &merged)
	}
	for k, v := range raw {
		if allowedKeys[k] {
			merged[k] = v
		}
	}

	sanitizedBytes, err := json.Marshal(merged)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to serialize preferences")
		return
	}

	if err := r.store.SetUserPreferences(req.Context(), user.ID, string(sanitizedBytes)); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to save user preferences")
		return
	}

	// Broadcast user preferences update to all active devices of this user
	r.hub.PublishEvent(&models.EventOutbox{
		EventType:       "user.preferences_updated",
		RecipientUserID: user.ID,
		Payload:         string(sanitizedBytes),
		CreatedAt:       time.Now().UTC(),
	})

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
	target, err := r.store.GetAvatarOwner(req.Context(), filename)
	if err != nil {
		r.writeError(w, 404, "NOT_FOUND", "Avatar not found")
		return
	}
	if !storage.CanViewUserField(req.Context(), r.store, target, r.optionalViewer(req), "profilePhotoVisibility") {
		r.writeError(w, 403, "FORBIDDEN", "Avatar is private")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	candidatePaths := []string{
		filepath.Join(getUploadsDir(), "avatars", filename),
		filepath.Join("/var/www/senora/uploads", "avatars", filename),
		filepath.Join("uploads", "avatars", filename),
		filepath.Join("/uploads", "avatars", filename),
	}
	var file *os.File

	for _, p := range candidatePaths {
		file, err = os.Open(p)
		if err == nil {
			break
		}
	}
	if err != nil || file == nil {
		if r.fileStore != nil {
			response, streamErr := r.fileStore.StreamAvatarObject(req.Context(), filename)
			if response != nil {
				defer response.Body.Close()
				if streamErr == nil && response.StatusCode == http.StatusOK {
					contentType := response.Header.Get("Content-Type")
					if !safeInlineType(contentType) {
						w.Header().Set("Content-Disposition", "attachment")
					}
					w.Header().Set("Content-Type", contentType)
					io.Copy(w, response.Body)
					return
				}
			}
		}
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

	io.Copy(w, file)
}

func saveStickerDataURL(dataURL string, idPrefix string) (string, error) {
	if !strings.HasPrefix(dataURL, "data:") {
		return "", fmt.Errorf("not a data url")
	}
	parts := strings.SplitN(dataURL, ",", 2)
	if len(parts) != 2 {
		return "", fmt.Errorf("invalid data url")
	}
	header := parts[0]
	encoded := parts[1]

	ext := ".webp"
	isSVG := false
	if strings.Contains(header, "image/png") {
		ext = ".png"
	} else if strings.Contains(header, "video/webm") {
		ext = ".webm"
	} else if strings.Contains(header, "image/gif") {
		ext = ".gif"
	} else if strings.Contains(header, "image/svg+xml") {
		ext = ".svg"
		isSVG = true
	} else if strings.Contains(header, "image/jpeg") || strings.Contains(header, "image/jpg") {
		ext = ".jpg"
	}

	var decoded []byte
	var err error
	if isSVG && !strings.Contains(header, "base64") {
		// Plain SVG data URL (e.g. data:image/svg+xml;utf8,<svg...> or %3Csvg...)
		if unescaped, unerr := url.QueryUnescape(encoded); unerr == nil {
			decoded = []byte(unescaped)
		} else {
			decoded = []byte(encoded)
		}
	} else {
		cleanB64 := strings.TrimSpace(encoded)
		decoded, err = base64.StdEncoding.DecodeString(cleanB64)
		if err != nil {
			decoded, err = base64.URLEncoding.DecodeString(cleanB64)
			if err != nil {
				decoded, err = base64.RawStdEncoding.DecodeString(cleanB64)
				if err != nil {
					decoded, err = base64.RawURLEncoding.DecodeString(cleanB64)
					if err != nil {
						if isSVG {
							if unescaped, unerr := url.QueryUnescape(cleanB64); unerr == nil {
								decoded = []byte(unescaped)
							} else {
								decoded = []byte(cleanB64)
							}
						} else {
							return "", err
						}
					}
				}
			}
		}
	}

	uploadsDir := filepath.Join(getUploadsDir(), "stickers")
	_ = os.MkdirAll(uploadsDir, 0755)

	filename := idPrefix + ext
	filePath := filepath.Join(uploadsDir, filename)
	if err := os.WriteFile(filePath, decoded, 0644); err != nil {
		return "", err
	}

	return "/api/v1/stickers/asset/" + filename, nil
}

func (r *Router) handleServeStickerAsset(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	id := req.PathValue("id")
	if strings.Contains(id, "..") || strings.Contains(id, "/") || strings.Contains(id, "\\") {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid sticker asset filename")
		return
	}

	uploadsDir := filepath.Join(getUploadsDir(), "stickers")
	candidatePaths := []string{
		filepath.Join(uploadsDir, id),
		filepath.Join("/var/www/senora/uploads/stickers", id),
		filepath.Join("uploads", "stickers", id),
		filepath.Join("/uploads", "stickers", id),
		filepath.Join(uploadsDir, id+".webp"),
		filepath.Join(uploadsDir, id+".webm"),
		filepath.Join(uploadsDir, id+".png"),
		filepath.Join(uploadsDir, id+".gif"),
		filepath.Join(uploadsDir, id+".svg"),
		filepath.Join(uploadsDir, id+".jpg"),
	}

	var foundPath string
	for _, p := range candidatePaths {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			foundPath = p
			break
		}
	}

	// If not on disk, check database
	if foundPath == "" {
		cleanID := strings.TrimSuffix(id, filepath.Ext(id))
		st, err := r.store.GetStickerByID(req.Context(), cleanID)
		if err == nil && st != nil {
			if strings.HasPrefix(st.AssetURL, "data:") {
				if savedURL, err := saveStickerDataURL(st.AssetURL, cleanID); err == nil {
					savedFile := strings.TrimPrefix(savedURL, "/api/v1/stickers/asset/")
					foundPath = filepath.Join(uploadsDir, savedFile)
				}
			} else if strings.HasPrefix(st.AssetURL, "/") || strings.HasPrefix(st.AssetURL, "http") {
				http.Redirect(w, req, st.AssetURL, http.StatusFound)
				return
			}
		}
	}

	if foundPath == "" {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Sticker asset not found")
		return
	}

	file, err := os.Open(foundPath)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Sticker asset missing")
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(foundPath))
	contentType := "image/webp"
	switch ext {
	case ".webm":
		contentType = "video/webm"
	case ".gif":
		contentType = "image/gif"
	case ".svg":
		contentType = "image/svg+xml"
	case ".png":
		contentType = "image/png"
	case ".jpg", ".jpeg":
		contentType = "image/jpeg"
	}

	fi, _ := file.Stat()
	var modTime time.Time
	if fi != nil {
		modTime = fi.ModTime()
	} else {
		modTime = time.Now()
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, req, filepath.Base(foundPath), modTime, file)
}

type uploadStickerAssetReq struct {
	DataURL string `json:"data_url"`
}

func (r *Router) handleUploadStickerAsset(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 15*1024*1024)

	contentType := req.Header.Get("Content-Type")
	if strings.Contains(contentType, "application/json") {
		var body uploadStickerAssetReq
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
			return
		}
		if body.DataURL == "" {
			r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "data_url is required")
			return
		}
		assetID := "stk_asset_" + uuid.New().String()
		url, err := saveStickerDataURL(body.DataURL, assetID)
		if err != nil {
			r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Failed to decode sticker data: "+err.Error())
			return
		}
		r.writeJSON(w, http.StatusCreated, map[string]string{"url": url, "id": assetID})
		return
	}

	if err := req.ParseMultipartForm(15 * 1024 * 1024); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Failed to parse multipart form")
		return
	}

	file, header, err := req.FormFile("file")
	if err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "file field is required")
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext == "" {
		ext = ".webp"
	}
	assetID := "stk_asset_" + uuid.New().String()
	filename := assetID + ext

	savedFile, sErr := r.fileStore.SaveFile(req.Context(), "stickers", filename, "image/webp", file, header.Size)
	if sErr != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to write sticker asset")
		return
	}

	url := savedFile.PublicURL
	r.writeJSON(w, http.StatusCreated, map[string]string{"url": url, "id": assetID})
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
	req.Body = http.MaxBytesReader(w, req.Body, 32*1024*1024)
	user := getUserFromContext(req.Context())
	var body createStickerPackReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}
	if body.Title == "" {
		body.Title = "Custom Stickers"
	}
	cleanSlug := strings.ToLower(regexp.MustCompile(`[^a-zA-Z0-9_]`).ReplaceAllString(body.Name, "_"))
	cleanSlug = strings.Trim(cleanSlug, "_")
	if cleanSlug == "" {
		cleanSlug = "pack"
	}
	body.Name = fmt.Sprintf("%s_%s", cleanSlug, strings.ReplaceAll(uuid.New().String()[:8], "-", ""))

	if len(body.Stickers) == 0 {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "At least one sticker is required")
		return
	}

	packID := "pack_usr_" + uuid.New().String()
	thumb := body.Stickers[0].AssetURL
	if strings.HasPrefix(thumb, "data:") {
		if savedThumb, err := saveStickerDataURL(thumb, packID+"_thumb"); err == nil {
			thumb = savedThumb
		}
	}
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
		stkID := fmt.Sprintf("%s_stk_%d", packID, i+1)
		assetURL := s.AssetURL
		if strings.HasPrefix(assetURL, "data:") {
			if savedURL, err := saveStickerDataURL(assetURL, stkID); err == nil {
				assetURL = savedURL
			}
		}
		stickers = append(stickers, &models.Sticker{
			ID:       stkID,
			PackID:   packID,
			Emoji:    em,
			AssetURL: assetURL,
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

type LinkPreviewResp struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	SiteName    string `json:"site_name,omitempty"`
}

func (r *Router) handleLinkPreview(w http.ResponseWriter, req *http.Request) {
	rawURL := req.URL.Query().Get("url")
	if rawURL == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "url parameter is required")
		return
	}

	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid URL scheme")
		return
	}

	hostname := parsed.Hostname()
	if err := netguard.ValidateURL(req.Context(), rawURL); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Private network destinations are not allowed")
		return
	}
	client := netguard.Client(4 * time.Second)

	httpReq, err := http.NewRequestWithContext(req.Context(), "GET", rawURL, nil)
	if err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Failed to build request")
		return
	}
	httpReq.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	httpReq.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

	resp, err := client.Do(httpReq)
	if err != nil {
		r.writeError(w, http.StatusBadGateway, "FETCH_FAILED", "Failed to fetch URL")
		return
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	htmlContent := string(bodyBytes)

	preview := LinkPreviewResp{
		URL: rawURL,
	}

	// Extract og:site_name
	if m := regexp.MustCompile(`(?i)<meta\s+[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']`).FindStringSubmatch(htmlContent); len(m) > 1 {
		preview.SiteName = m[1]
	} else if m2 := regexp.MustCompile(`(?i)<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']`).FindStringSubmatch(htmlContent); len(m2) > 1 {
		preview.SiteName = m2[1]
	} else {
		preview.SiteName = hostname
	}

	// Extract og:title or <title>
	if m := regexp.MustCompile(`(?i)<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']`).FindStringSubmatch(htmlContent); len(m) > 1 {
		preview.Title = m[1]
	} else if m2 := regexp.MustCompile(`(?i)<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']`).FindStringSubmatch(htmlContent); len(m2) > 1 {
		preview.Title = m2[1]
	} else if t := regexp.MustCompile(`(?i)<title[^>]*>([^<]+)</title>`).FindStringSubmatch(htmlContent); len(t) > 1 {
		preview.Title = strings.TrimSpace(t[1])
	}

	// Extract og:description or meta description
	if m := regexp.MustCompile(`(?i)<meta\s+[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']`).FindStringSubmatch(htmlContent); len(m) > 1 {
		preview.Description = m[1]
	} else if m2 := regexp.MustCompile(`(?i)<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']`).FindStringSubmatch(htmlContent); len(m2) > 1 {
		preview.Description = m2[1]
	} else if d := regexp.MustCompile(`(?i)<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["']`).FindStringSubmatch(htmlContent); len(d) > 1 {
		preview.Description = d[1]
	}

	// Extract og:image
	if m := regexp.MustCompile(`(?i)<meta\s+[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']`).FindStringSubmatch(htmlContent); len(m) > 1 {
		imgURL := m[1]
		if strings.HasPrefix(imgURL, "//") {
			imgURL = parsed.Scheme + ":" + imgURL
		} else if strings.HasPrefix(imgURL, "/") {
			imgURL = parsed.Scheme + "://" + parsed.Host + imgURL
		}
		preview.Image = imgURL
	} else if m2 := regexp.MustCompile(`(?i)<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']`).FindStringSubmatch(htmlContent); len(m2) > 1 {
		imgURL := m2[1]
		if strings.HasPrefix(imgURL, "//") {
			imgURL = parsed.Scheme + ":" + imgURL
		} else if strings.HasPrefix(imgURL, "/") {
			imgURL = parsed.Scheme + "://" + parsed.Host + imgURL
		}
		preview.Image = imgURL
	}

	r.writeJSON(w, http.StatusOK, preview)
}

type addStickerReq struct {
	Emoji    string `json:"emoji"`
	AssetURL string `json:"asset_url"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

func (r *Router) handleAddStickerToPack(w http.ResponseWriter, req *http.Request) {
	req.Body = http.MaxBytesReader(w, req.Body, 32*1024*1024)
	user := getUserFromContext(req.Context())
	packID := req.PathValue("id")
	if packID == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Missing pack ID")
		return
	}

	pack, err := r.store.GetStickerPackByID(req.Context(), packID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Sticker pack not found")
		return
	}
	if pack.CreatorID != "" && pack.CreatorID != user.ID {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "You do not have permission to modify this sticker pack")
		return
	}

	var body addStickerReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}
	if body.AssetURL == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Asset URL is required")
		return
	}
	if body.Emoji == "" {
		body.Emoji = "✨"
	}
	if body.Width <= 0 {
		body.Width = 256
	}
	if body.Height <= 0 {
		body.Height = 256
	}

	stkID := fmt.Sprintf("%s_stk_%d", packID, time.Now().UnixNano())
	assetURL := body.AssetURL
	if strings.HasPrefix(assetURL, "data:") {
		if savedURL, err := saveStickerDataURL(assetURL, stkID); err == nil {
			assetURL = savedURL
		}
	}

	st := &models.Sticker{
		ID:       stkID,
		PackID:   packID,
		Emoji:    body.Emoji,
		AssetURL: assetURL,
		Width:    body.Width,
		Height:   body.Height,
	}

	if err := r.store.AddStickerToPack(req.Context(), packID, st); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusCreated, st)
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
// Polls, Stories, Scheduled Messages, Roles, Bot API
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

	if !r.authorizePublication(w, req, convID, user.ID) {
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

	payload, _ := json.Marshal(pollForViewer(createdPoll, ""))
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

	if !r.authorizePoll(w, req, convID, pollID, user.ID) {
		return
	}
	poll, err := r.store.GetPoll(req.Context(), pollID, user.ID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Poll not found")
		return
	}

	if bot, ok := req.Context().Value(botContextKey).(*models.ManagedBot); ok && bot.PrivacyMode && poll.CreatorID != bot.UserID {
		conv, err := r.store.GetConversationByID(req.Context(), convID)
		if err != nil || conv.Type != "direct" {
			r.writeError(w, 403, "FORBIDDEN", "Disable group privacy to read other members polls")
			return
		}
	}
	r.writeJSON(w, http.StatusOK, pollForViewer(poll, user.ID))
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

	if !r.authorizePoll(w, req, convID, pollID, user.ID) {
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

	payload, _ := json.Marshal(pollForViewer(poll, ""))
	r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
		V:       1,
		Type:    "poll.voted",
		Payload: payload,
	})

	r.writeJSON(w, http.StatusOK, pollForViewer(poll, user.ID))
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

	if !r.authorizePoll(w, req, convID, pollID, user.ID) {
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

	if !r.authorizePublication(w, req, convID, user.ID) {
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

	conv, err := r.store.GetConversationByID(req.Context(), convID)
	if err != nil {
		r.writeError(w, 404, "NOT_FOUND", "Conversation not found")
		return
	}
	if conv.SecurityMode == "e2ee_active" {
		if nonce == "normal" || messages.ValidateEncryptedEnvelope(body.Ciphertext, user.ID) != nil {
			r.writeError(w, 400, "ENCRYPTION_REQUIRED", "Encrypted envelope required")
			return
		}
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
	if strings.HasPrefix(botToken(req), "snb_") {
		r.botAuth(r.botSendMessage).ServeHTTP(w, req)
		return
	}
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
		if expectedToken == "" || botToken != expectedToken {
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
	conv, err := r.store.GetConversationByID(req.Context(), body.ConversationID)
	if err != nil {
		r.writeError(w, 404, "NOT_FOUND", "Conversation not found")
		return
	}
	if conv.SecurityMode == "e2ee_active" {
		r.writeError(w, 400, "ENCRYPTION_REQUIRED", "Plaintext bot messages cannot be sent to encrypted conversations")
		return
	}
	if tokenModel != nil {
		if !r.authorizePublication(w, req, body.ConversationID, tokenModel.CreatedBy) {
			return
		}
	}
	if _, err := r.store.GetUserByID(req.Context(), senderID); errors.Is(err, storage.ErrNotFound) {
		botUser := &models.User{ID: senderID, Username: senderID, DisplayName: "SENORA Bot", PasswordHash: "!", IsApproved: true}
		if err := r.store.CreateUser(req.Context(), botUser); err != nil && !errors.Is(err, storage.ErrAlreadyExists) {
			r.writeError(w, 500, "INTERNAL_ERROR", "Failed to initialize bot identity")
			return
		}
	} else if err != nil {
		r.writeError(w, 500, "INTERNAL_ERROR", "Failed to resolve bot identity")
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
// Handlers for Read Receipts, Invites, Roles, Views, TTL, Search, Presence & ICE
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
		// Fallback: Check if code is a conversation ID (e.g. cnv_...) or channel handle
		conv, cErr := r.store.GetConversationByID(req.Context(), code)
		if cErr == nil && conv != nil {
			r.writeJSON(w, http.StatusOK, map[string]interface{}{
				"invite_code":       code,
				"conversation_id":   conv.ID,
				"title":             conv.Title,
				"type":              conv.Type,
				"avatar_url":        conv.AvatarURL,
				"description":       conv.Description,
				"participant_count": len(conv.Participants),
				"expires_at":        nil,
			})
			return
		}
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Invalid or expired invite")
		return
	}

	if inv.IsRevoked {
		r.writeError(w, http.StatusBadRequest, "REVOKED", "Invite link has been revoked")
		return
	}
	if inv.ExpiresAt != nil && !inv.ExpiresAt.IsZero() && inv.ExpiresAt.Year() > 1970 && inv.ExpiresAt.Before(time.Now().UTC()) {
		r.writeError(w, http.StatusBadRequest, "EXPIRED", "Invite link has expired")
		return
	}
	if inv.MaxUses > 0 && inv.UsesCount >= inv.MaxUses {
		r.writeError(w, http.StatusBadRequest, "MAX_USES", "Invite link has reached its maximum usage limit")
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
		// Fallback: If code is a conversation ID (e.g. cnv_...) and user is joining a group/channel
		if directConv, cErr := r.store.GetConversationByID(req.Context(), code); cErr == nil && directConv != nil {
			if directConv.Type == "channel" || directConv.Type == "group" {
				if addErr := r.store.AddConversationMember(req.Context(), directConv.ID, user.ID, "member"); addErr != nil {
					r.writeError(w, http.StatusInternalServerError, "JOIN_FAILED", addErr.Error())
					return
				}
				joinedConv, _ := r.store.GetConversationByID(req.Context(), directConv.ID)
				if joinedConv == nil {
					joinedConv = directConv
				}
				r.writeJSON(w, http.StatusOK, joinedConv)
				return
			}
		}

		r.writeError(w, http.StatusBadRequest, "JOIN_FAILED", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, conv)
}

func (r *Router) handleRecordMessageView(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	msgID := req.PathValue("msgId")

	if !r.authorizeMessage(w, req, convID, msgID, user.ID) {
		return
	}
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

func (r *Router) handleResolveIdentifier(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	raw := req.PathValue("identifier")
	clean := strings.TrimPrefix(strings.TrimSpace(raw), "@")
	if clean == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Identifier cannot be empty")
		return
	}

	// 1. Check if user exists with exact username or ID
	targetUser, err := r.store.GetUserByUsername(req.Context(), clean)
	if err == nil && targetUser != nil {
		r.writeJSON(w, http.StatusOK, map[string]interface{}{
			"type": "user",
			"user": targetUser,
		})
		return
	}
	targetUser, err = r.store.GetUserByID(req.Context(), clean)
	if err == nil && targetUser != nil {
		r.writeJSON(w, http.StatusOK, map[string]interface{}{
			"type": "user",
			"user": targetUser,
		})
		return
	}

	// 2. Check if conversation (channel or group) exists with exact username, ID, or title
	res, err := r.store.GlobalSearch(req.Context(), user.ID, clean)
	if err == nil {
		if channels, ok := res["channels"].([]map[string]interface{}); ok && len(channels) > 0 {
			ch := channels[0]
			convID, _ := ch["id"].(string)
			conv, cErr := r.store.GetConversationByID(req.Context(), convID)
			if cErr == nil && conv != nil {
				r.writeJSON(w, http.StatusOK, map[string]interface{}{
					"type":         conv.Type,
					"conversation": conv,
				})
				return
			}
		}
	}

	// 3. Fallback: Check if invite code matches
	inv, iErr := r.store.GetConversationInviteByCode(req.Context(), clean)
	if iErr == nil && inv != nil {
		conv, cErr := r.store.GetConversationByID(req.Context(), inv.ConversationID)
		if cErr == nil && conv != nil {
			r.writeJSON(w, http.StatusOK, map[string]interface{}{
				"type":         conv.Type,
				"conversation": conv,
				"invite_code":  inv.InviteCode,
			})
			return
		}
	}

	r.writeError(w, http.StatusNotFound, "NOT_FOUND", "No user, channel, or group found with this ID")
}

func (r *Router) handleJoinConversation(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")

	conv, err := r.store.GetConversationByID(req.Context(), convID)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Conversation not found")
		return
	}

	// Add member if not already joined
	isMember, _ := r.store.IsMember(req.Context(), convID, user.ID)
	if !isMember {
		if conv.Username == "" || (conv.Type != "group" && conv.Type != "channel") {
			r.writeError(w, http.StatusForbidden, "INVITE_REQUIRED", "A valid invitation is required")
			return
		}
		if err := r.store.AddConversationMember(req.Context(), convID, user.ID, "member"); err != nil {
			r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to join conversation")
			return
		}
	}

	updatedConv, err := r.convs.GetConversation(req.Context(), convID, user.ID)
	if err != nil {
		updatedConv = conv
	}
	r.writeJSON(w, http.StatusOK, updatedConv)
}

func (r *Router) handleGetUserPresence(w http.ResponseWriter, req *http.Request) {
	r.writeJSON(w, http.StatusOK, r.presenceFor(req, req.PathValue("id")))
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
	if len(body.UserIDs) > 500 {
		r.writeError(w, 400, "BAD_REQUEST", "Too many user IDs")
		return
	}
	for _, target := range body.UserIDs {
		if target != "" {
			res = append(res, r.presenceFor(req, target))
		}
	}
	r.writeJSON(w, http.StatusOK, res)
}

func (r *Router) handleGetIceServers(w http.ResponseWriter, req *http.Request) {
	stunServers := os.Getenv("STUN_SERVERS")
	if stunServers == "" {
		stunServers = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun.cloudflare.com:3478,stun:stun.services.mozilla.com:3478,stun:stun.nextcloud.com:443"
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
// Webhook SSRF Defenses, Bot Tokens & Readers
// ---------------------------------------------------------------------

// ValidateWebhookURL blocks loopback, private IPv4/IPv6,
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

// ---------------------------------------------------------------------
// Server Administration & Master Bot Handlers
// ---------------------------------------------------------------------

func (r *Router) checkOwner(w http.ResponseWriter, req *http.Request, user *models.User) bool {
	if user == nil {
		r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required")
		return false
	}
	isOwner, err := r.store.IsUserOwner(req.Context(), user.ID)
	if err != nil || !isOwner {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "This action requires Server Owner privileges")
		return false
	}
	return true
}

func (r *Router) handleAdminStatus(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	isOwner, _ := r.store.IsUserOwner(req.Context(), user.ID)
	apprStr, _ := r.store.GetServerSetting(req.Context(), "registration_approval", "true")
	maintStr, _ := r.store.GetServerSetting(req.Context(), "maintenance_mode", "false")

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"is_owner":            isOwner,
		"master_bot_user_id":  masterbot.BotUserID,
		"master_bot_username": masterbot.BotUsername,
		"approval_required":   apprStr == "true",
		"maintenance_mode":    maintStr == "true",
	})
}

func (r *Router) handleAdminStats(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	stats, err := r.store.GetServerStats(req.Context())
	if stats != nil {
		stats.OnlineUsers = r.hub.OnlineUserCount()
	}
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": "ok",
		"stats":  stats,
	})
}

func (r *Router) handleAdminListUsers(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	users, err := r.store.ListAllUsers(req.Context())
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

func (r *Router) handleAdminListRegistrations(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	pending, err := r.store.ListPendingUsers(req.Context())
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"users":         pending,
		"pending_users": pending,
	})
}

func (r *Router) handleAdminApproveUser(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	targetID := req.PathValue("id")
	targetUser, err := r.store.GetUserByID(req.Context(), targetID)
	if err != nil || targetUser == nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return
	}

	if err := r.store.SetUserApproved(req.Context(), targetID, true); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	// Publish approval event to WebSocket
	ev := &models.EventOutbox{
		EventType:       "user.approved",
		RecipientUserID: targetID,
		Payload:         fmt.Sprintf(`{"user_id":"%s","username":"%s","is_approved":true}`, targetID, targetUser.Username),
		CreatedAt:       time.Now().UTC(),
	}
	r.hub.PublishEvent(ev)

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "approved",
		"user_id": targetID,
	})
}

func (r *Router) handleAdminRejectUser(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	targetID := req.PathValue("id")
	targetUser, err := r.store.GetUserByID(req.Context(), targetID)
	if err != nil || targetUser == nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return
	}

	if targetUser.IsOwner {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Cannot reject or delete the server owner")
		return
	}

	if err := r.store.DeleteUser(req.Context(), targetID); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "rejected",
		"user_id": targetID,
	})
}

func (r *Router) handleAdminBanUser(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	targetID := req.PathValue("id")
	targetUser, err := r.store.GetUserByID(req.Context(), targetID)
	if err != nil || targetUser == nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return
	}

	if targetUser.IsOwner {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Cannot ban the server owner")
		return
	}

	if err := r.store.SetUserBanned(req.Context(), targetID, true); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	// Disconnect user's active WebSocket sessions
	r.hub.DisconnectUser(targetID)

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "banned",
		"user_id": targetID,
	})
}

func (r *Router) handleAdminUnbanUser(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	targetID := req.PathValue("id")
	if err := r.store.SetUserBanned(req.Context(), targetID, false); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "unbanned",
		"user_id": targetID,
	})
}

func (r *Router) handleAdminDeleteUser(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	targetID := req.PathValue("id")
	targetUser, err := r.store.GetUserByID(req.Context(), targetID)
	if err != nil || targetUser == nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return
	}

	if targetUser.IsOwner {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Cannot delete the server owner")
		return
	}

	if err := r.store.DeleteUser(req.Context(), targetID); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.hub.DisconnectUser(targetID)

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "deleted",
		"user_id": targetID,
	})
}

func (r *Router) handleAdminListConversations(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	convs, err := r.store.ListAllConversations(req.Context(), 50)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"conversations": convs})
}

type adminBotActionReq struct {
	Command string `json:"command"`
}

func (r *Router) handleAdminBotAction(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	var body adminBotActionReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	botConv, err := r.masterBot.EnsureBotConversation(req.Context(), user.ID)
	if err != nil || botConv == nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to resolve master bot conversation")
		return
	}

	reply, err := r.masterBot.HandleOwnerMessage(req.Context(), user.ID, botConv.ID, body.Command)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": "ok",
		"reply":  reply,
	})
}

func (r *Router) handleGetMasterBotConversation(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	conv, err := r.masterBot.EnsureBotConversation(req.Context(), user.ID)
	if err != nil || conv == nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to retrieve master bot conversation")
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"conversation": conv,
	})
}

type adminBroadcastReq struct {
	Message string `json:"message"`
}

func (r *Router) handleAdminBroadcast(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	var body adminBroadcastReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	botConv, _ := r.masterBot.EnsureBotConversation(req.Context(), user.ID)
	convID := ""
	if botConv != nil {
		convID = botConv.ID
	}

	reply, err := r.masterBot.HandleOwnerMessage(req.Context(), user.ID, convID, "/broadcast "+body.Message)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": "ok",
		"reply":  reply,
	})
}

type adminUpdateSettingsReq struct {
	RegistrationApproval *bool `json:"registration_approval"`
	MaintenanceMode      *bool `json:"maintenance_mode"`
}

func (r *Router) handleAdminUpdateSettings(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	var body adminUpdateSettingsReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}

	if body.RegistrationApproval != nil {
		val := "false"
		if *body.RegistrationApproval {
			val = "true"
		}
		_ = r.store.SetServerSetting(req.Context(), "registration_approval", val)
	}

	if body.MaintenanceMode != nil {
		val := "false"
		if *body.MaintenanceMode {
			val = "true"
		}
		_ = r.store.SetServerSetting(req.Context(), "maintenance_mode", val)
	}

	apprStr, _ := r.store.GetServerSetting(req.Context(), "registration_approval", "true")
	maintStr, _ := r.store.GetServerSetting(req.Context(), "maintenance_mode", "false")

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":                "ok",
		"registration_approval": apprStr == "true",
		"maintenance_mode":      maintStr == "true",
	})
}

type adminBanIPReq struct {
	IP     string `json:"ip"`
	Reason string `json:"reason"`
}

func (r *Router) handleAdminListBannedIPs(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	list, err := r.store.ListBannedIPs(req.Context())
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"banned_ips": list})
}

func (r *Router) handleAdminBanIP(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	var body adminBanIPReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Malformed JSON body")
		return
	}
	targetIP := strings.TrimSpace(body.IP)
	if targetIP == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "IP address is required")
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		reason = "Blocked by administrator"
	}

	if err := r.store.BanIP(req.Context(), targetIP, reason, user.Username); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "ok",
		"message": fmt.Sprintf("IP %s has been banned", targetIP),
	})
}

func (r *Router) handleAdminUnbanIP(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	targetIP := strings.TrimSpace(req.PathValue("ip"))
	if targetIP == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "IP address is required")
		return
	}

	if err := r.store.UnbanIP(req.Context(), targetIP); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "ok",
		"message": fmt.Sprintf("IP %s has been unbanned", targetIP),
	})
}

// checkAutoBan records a security failure for clientIP and triggers an automatic ban if threshold is exceeded.
func (r *Router) checkAutoBan(ctx context.Context, clientIP, reason string) {
	enabledStr, _ := r.store.GetServerSetting(ctx, "autoban_enabled", "true")
	if enabledStr == "false" {
		return
	}

	threshStr, _ := r.store.GetServerSetting(ctx, "autoban_threshold", "5")
	var thresh int
	if _, err := fmt.Sscanf(threshStr, "%d", &thresh); err == nil && thresh > 0 {
		r.autoBanTracker.SetThreshold(thresh)
	}

	if r.autoBanTracker.RecordFailure(clientIP) {
		banReason := fmt.Sprintf("مسدودسازی خودکار به دلیل %s (Auto-Ban)", reason)
		_ = r.store.BanIP(ctx, clientIP, banReason, "AutoBanTracker")
		go func() {
			_ = r.masterBot.NotifyAutoBan(context.Background(), clientIP, reason, r.autoBanTracker.GetThreshold())
		}()
	}
}

// handleAdminDownloadBackup allows the Server Owner to safely download database snapshots.
func (r *Router) handleAdminDownloadBackup(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if !r.checkOwner(w, req, user) {
		return
	}

	file := req.URL.Query().Get("file")
	file = filepath.Base(file)
	if !storage.IsBackupFilename(file) {
		r.writeError(w, http.StatusBadRequest, "INVALID_FILENAME", "Invalid or malformed backup filename")
		return
	}

	filePath, err := storage.ResolveBackup(file)
	if err != nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Backup file not found")
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", file))
	http.ServeFile(w, req, filePath)
}

// ---------------------------------------------------------------------
// Storage & ArvanCloud S3 Status Handlers
// ---------------------------------------------------------------------

func (r *Router) handleStorageStatus(w http.ResponseWriter, req *http.Request) {
	status := r.fileStore.GetStatus()
	r.writeJSON(w, http.StatusOK, status)
}

func (r *Router) handleAdminMigrateStorage(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if user == nil {
		r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required")
		return
	}
	isOwner, err := r.store.IsUserOwner(req.Context(), user.ID)
	if err != nil || !isOwner {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only server owner can trigger storage migration")
		return
	}

	report, err := r.fileStore.MigrateLocalFilesToS3(req.Context(), r.store)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "MIGRATION_FAILED", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, report)
}

// ---------------------------------------------------------------------
// Supergroup Forum Topics Handlers
// ---------------------------------------------------------------------

func (r *Router) handleToggleConversationForum(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	role, err := r.store.GetMemberRole(req.Context(), convID, user.ID)
	if err != nil || (role != "owner" && role != "admin") {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only group admins can change forum mode")
		return
	}
	var body struct {
		IsForum bool `json:"is_forum"`
	}
	_ = json.NewDecoder(req.Body).Decode(&body)
	if err := r.store.ToggleConversationForum(req.Context(), convID, body.IsForum); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]bool{"is_forum": body.IsForum})
}

func (r *Router) handleGetForumTopics(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	if err := r.convs.ValidateMembership(req.Context(), convID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}
	topics, err := r.store.GetForumTopics(req.Context(), convID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	if topics == nil {
		topics = []*models.ForumTopic{}
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"topics": topics})
}

func (r *Router) handleCreateForumTopic(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	if err := r.convs.ValidateMembership(req.Context(), convID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}
	var body struct {
		Title string `json:"title"`
		Icon  string `json:"icon"`
		Color string `json:"color"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil || strings.TrimSpace(body.Title) == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Title is required")
		return
	}
	topic := &models.ForumTopic{
		ConversationID: convID,
		Title:          strings.TrimSpace(body.Title),
		Icon:           body.Icon,
		Color:          body.Color,
		CreatedBy:      user.ID,
	}
	if err := r.store.CreateForumTopic(req.Context(), topic); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusCreated, topic)
}

// ---------------------------------------------------------------------
// Multiple Conversation Pins Handlers
// ---------------------------------------------------------------------

func (r *Router) handleGetConversationPins(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	if err := r.convs.ValidateMembership(req.Context(), convID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}
	pins, err := r.store.GetConversationPins(req.Context(), convID)
	if err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	if pins == nil {
		pins = []*models.ConversationPin{}
	}
	r.writeJSON(w, http.StatusOK, map[string]interface{}{"pins": pins})
}

func (r *Router) handleAddConversationPin(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	if err := r.convs.ValidateMembership(req.Context(), convID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}
	var body struct {
		MessageID string `json:"message_id"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil || body.MessageID == "" {
		r.writeError(w, http.StatusBadRequest, "BAD_REQUEST", "message_id is required")
		return
	}
	pin := &models.ConversationPin{
		ConversationID: convID,
		MessageID:      body.MessageID,
		PinnedBy:       user.ID,
	}
	if err := r.store.AddConversationPin(req.Context(), pin); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusCreated, pin)
}

func (r *Router) handleRemoveConversationPin(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	convID := req.PathValue("id")
	msgID := req.PathValue("msgId")
	if err := r.convs.ValidateMembership(req.Context(), convID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a member of this conversation")
		return
	}
	if err := r.store.RemoveConversationPin(req.Context(), convID, msgID); err != nil {
		r.writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	r.writeJSON(w, http.StatusOK, map[string]bool{"unpinned": true})
}
