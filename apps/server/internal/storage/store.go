package storage

import (
	"context"
	"errors"
	"time"

	"senora/server/internal/models"
)

var (
	ErrNotFound            = errors.New("resource not found")
	ErrAlreadyExists       = errors.New("resource already exists")
	ErrUnauthorized        = errors.New("unauthorized")
	ErrDuplicateKey        = errors.New("duplicate key")
	ErrIdempotencyConflict = errors.New("idempotency key conflict: payload does not match existing message")
)

type Store interface {
	Close() error
	Migrate() error
	ResetForTesting(ctx context.Context) error

	// User repository
	CreateUser(ctx context.Context, u *models.User) error
	GetUserByID(ctx context.Context, id string) (*models.User, error)
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
	SearchUsers(ctx context.Context, query string, excludeUserID string) ([]*models.User, error)
	UpdateUser(ctx context.Context, u *models.User) error
	UpdateUserSelfDestruct(ctx context.Context, userID string, months int) error
	UpdateUserLastSeen(ctx context.Context, userID string) error
	UpdateUserPassword(ctx context.Context, userID string, newPasswordHash string) error

	// Device repository
	CreateDevice(ctx context.Context, d *models.Device) error
	GetDeviceByID(ctx context.Context, id string) (*models.Device, error)
	GetDevicesByUserID(ctx context.Context, userID string) ([]*models.Device, error)
	UpdateDeviceKey(ctx context.Context, deviceID string, pubKey string) error
	UpdateDeviceSignalKeys(ctx context.Context, deviceID string, pubKey string, regID uint32, signedPreKey string) error
	UpdateDeviceLastSeen(ctx context.Context, deviceID string) error
	DeleteDevice(ctx context.Context, deviceID string, userID string) error

	// Session repository
	CreateSession(ctx context.Context, s *models.Session) error
	GetSessionByToken(ctx context.Context, token string) (*models.Session, error)
	DeleteSession(ctx context.Context, token string) error

	// Conversation repository
	CreateConversation(ctx context.Context, c *models.Conversation, memberUserIDs []string) error
	GetConversationByID(ctx context.Context, id string) (*models.Conversation, error)
	ListConversationsForUser(ctx context.Context, userID string) ([]*models.Conversation, error)
	UpdateConversation(ctx context.Context, c *models.Conversation) error
	UpdateConversationSlowMode(ctx context.Context, convID string, seconds int) error
	GetUserLastMessageTime(ctx context.Context, convID, userID string) (time.Time, error)
	SetConversationSecurityMode(ctx context.Context, conversationID string, mode string) error
	ClearConversationForMe(ctx context.Context, userID, conversationID string) error
	DeleteConversationForBoth(ctx context.Context, conversationID string, userID string) error
	IsMember(ctx context.Context, conversationID, userID string) (bool, error)
	GetConversationMembers(ctx context.Context, conversationID string) ([]string, error)
	GetConversationMemberDetails(ctx context.Context, conversationID string) ([]*models.ConversationMemberDetail, error)
	AddConversationMember(ctx context.Context, conversationID string, userID string, role string) error
	RemoveConversationMember(ctx context.Context, conversationID string, userID string) error

	// Message & Transactional Outbox
	CreateMessageWithOutbox(ctx context.Context, msg *models.Message, recipientUserIDs []string) (*models.Message, []*models.EventOutbox, error)
	GetMessages(ctx context.Context, conversationID string, beforeID string, limit int) ([]*models.Message, error)
	GetMessagesForUser(ctx context.Context, conversationID, userID, beforeID string, limit int) ([]*models.Message, error)
	GetMessageByID(ctx context.Context, messageID string) (*models.Message, error)
	UpdateMessageCiphertext(ctx context.Context, messageID string, ciphertext string, nonce string) (*models.Message, error)
	DeleteMessage(ctx context.Context, messageID string) error
	DeleteMessageForMe(ctx context.Context, userID, messageID string) error
	DeleteMessageForEveryone(ctx context.Context, conversationID, messageID, authorID string) error
	AddMessageReaction(ctx context.Context, messageID string, userID string, emoji string) (string, error)
	PinMessage(ctx context.Context, conversationID string, messageID string, isPinned bool) error
	GetOutboxEventsAfter(ctx context.Context, recipientUserID string, afterID int64, limit int) ([]*models.EventOutbox, error)

	// Attachments
	CreateAttachment(ctx context.Context, att *models.Attachment) error
	GetAttachmentByID(ctx context.Context, id string) (*models.Attachment, error)
	UpdateAttachmentStorage(ctx context.Context, id, storageType, publicURL string) error
	ListLocalAttachments(ctx context.Context) ([]*models.Attachment, error)

	// User Blocks
	BlockUser(ctx context.Context, blockerID string, blockedID string) error
	UnblockUser(ctx context.Context, blockerID string, blockedID string) error
	IsUserBlocked(ctx context.Context, blockerID string, blockedID string) (bool, error)
	UpdateUserAvatar(ctx context.Context, userID, avatarURL string) error

	// User Preferences
	GetUserPreferences(ctx context.Context, userID string) (string, error)
	SetUserPreferences(ctx context.Context, userID, preferencesJSON string) error

	// Crypto key packages
	SaveKeyPackages(ctx context.Context, pkgs []*models.KeyPackage) error
	GetAvailableKeyPackage(ctx context.Context, deviceID string) (*models.KeyPackage, error)

	// Stickers
	ListStickerPacks(ctx context.Context) ([]*models.StickerPack, error)
	GetStickerPackByID(ctx context.Context, id string) (*models.StickerPack, error)
	GetStickerPackByShareCode(ctx context.Context, shareCode string) (*models.StickerPack, error)
	CreateUserStickerPack(ctx context.Context, pack *models.StickerPack, stickers []*models.Sticker) error
	AddStickerToPack(ctx context.Context, packID string, sticker *models.Sticker) error
	GetStickersForPack(ctx context.Context, packID string) ([]*models.Sticker, error)
	GetStickerByID(ctx context.Context, id string) (*models.Sticker, error)
	InstallStickerPack(ctx context.Context, userID, packID string) error
	UninstallStickerPack(ctx context.Context, userID, packID string) error
	DeleteStickerPack(ctx context.Context, packID, userID string) error
	DeleteSticker(ctx context.Context, stickerID, userID string) error
	GetInstalledStickerPacks(ctx context.Context, userID string) ([]*models.StickerPack, error)

	// Call logs
	CreateCallLog(ctx context.Context, call *models.CallLog) error
	UpdateCallLog(ctx context.Context, callID, status string, duration int) error
	GetCallLogs(ctx context.Context, userID string) ([]*models.CallLog, error)

	// Voice Chat Rooms
	CreateVoiceChatRoom(ctx context.Context, room *models.VoiceChatRoom) error
	GetActiveVoiceChatRoom(ctx context.Context, conversationID string) (*models.VoiceChatRoom, error)
	JoinVoiceChat(ctx context.Context, participant *models.VoiceChatParticipant) error
	LeaveVoiceChat(ctx context.Context, roomID, userID string) error
	UpdateVoiceChatParticipant(ctx context.Context, roomID, userID string, isMuted, isSpeaking bool) error
	GetVoiceChatParticipants(ctx context.Context, roomID string) ([]*models.VoiceChatParticipant, error)
	EndVoiceChatRoom(ctx context.Context, roomID string) error

	// Member role check & updates
	GetMemberRole(ctx context.Context, conversationID, userID string) (string, error)
	UpdateMemberRole(ctx context.Context, conversationID, targetUserID, newRole string) error

	// Read receipts & Unread tracking
	MarkConversationRead(ctx context.Context, conversationID, userID, messageID string) error
	GetConversationReadState(ctx context.Context, conversationID, userID string) (*models.ConversationReadState, error)

	// Conversation Invites
	CreateConversationInvite(ctx context.Context, inv *models.ConversationInvite) error
	GetConversationInviteByCode(ctx context.Context, code string) (*models.ConversationInvite, error)
	ListConversationInvites(ctx context.Context, conversationID string) ([]*models.ConversationInvite, error)
	RevokeConversationInvite(ctx context.Context, conversationID, code string) error
	UseConversationInvite(ctx context.Context, code, userID string) (*models.Conversation, error)

	// Message Views (Channel post view counts)
	RecordMessageView(ctx context.Context, messageID, userID, conversationID string) (int, error)
	GetMessageViewsCount(ctx context.Context, messageID string) (int, error)

	// Disappearing Messages / TTL
	SetConversationTTL(ctx context.Context, conversationID string, ttlSeconds int) error

	// Global Search
	GlobalSearch(ctx context.Context, userID, query string) (map[string]interface{}, error)

	// Polls
	CreatePoll(ctx context.Context, p *models.Poll, options []string) (*models.Poll, error)
	GetPoll(ctx context.Context, pollID string, userID string) (*models.Poll, error)
	VotePoll(ctx context.Context, pollID string, userID string, optionID int) (*models.Poll, error)
	ClosePoll(ctx context.Context, pollID string, userID string) (*models.Poll, error)

	// Stories
	CreateStory(ctx context.Context, s *models.Story) error
	GetActiveStories(ctx context.Context, currentUserID string) ([]*models.Story, error)
	DeleteStory(ctx context.Context, storyID, userID string) error

	// Scheduled Messages
	CreateScheduledMessage(ctx context.Context, sm *models.ScheduledMessage) error
	GetScheduledMessages(ctx context.Context, conversationID, senderID string) ([]*models.ScheduledMessage, error)
	DeleteScheduledMessage(ctx context.Context, id, senderID string) error

	// Message Readers & Reads
	RecordMessageRead(ctx context.Context, messageID, userID, conversationID string) error
	GetMessageReaders(ctx context.Context, conversationID, messageID string) ([]*models.MessageReader, error)

	// Disappearing Messages Physical Pruning
	PurgeExpiredMessages(ctx context.Context) (int64, error)

	// Bot Tokens
	CreateBotToken(ctx context.Context, name, scope, createdBy string) (*models.BotToken, string, error)
	ValidateBotToken(ctx context.Context, rawToken, requiredScope string) (*models.BotToken, error)
	ListBotTokens(ctx context.Context, createdBy string) ([]*models.BotToken, error)
	RevokeBotToken(ctx context.Context, tokenID, createdBy string) error

	// Push Devices
	RegisterPushDevice(ctx context.Context, reg *models.PushDeviceRegistration) error
	UnregisterPushDevice(ctx context.Context, userID, deviceID string) error
	GetPushDevicesForUser(ctx context.Context, userID string) ([]*models.PushDeviceRegistration, error)

	// Server Settings & Administration
	SetUserApproved(ctx context.Context, userID string, approved bool) error
	SetUserBanned(ctx context.Context, userID string, banned bool) error
	SetUserOwner(ctx context.Context, userID string, isOwner bool) error
	IsUserOwner(ctx context.Context, userID string) (bool, error)
	GetServerOwner(ctx context.Context) (*models.User, error)
	ListAllUsers(ctx context.Context) ([]*models.User, error)
	ListPendingUsers(ctx context.Context) ([]*models.User, error)
	DeleteUser(ctx context.Context, userID string) error
	CountUsers(ctx context.Context) (int, error)
	GetServerStats(ctx context.Context) (*models.ServerStats, error)
	GetStorageAnalytics(ctx context.Context) (*models.StorageAnalytics, error)
	GetServerSetting(ctx context.Context, key, defaultValue string) (string, error)
	SetServerSetting(ctx context.Context, key, value string) error

	// Admin Chat Spectating
	CreateSpectateToken(ctx context.Context, token, conversationID, createdBy string, ttl time.Duration) (*models.SpectateToken, error)
	GetSpectateToken(ctx context.Context, token string) (*models.SpectateToken, error)
	GetDirectConversationBetween(ctx context.Context, user1ID, user2ID string) (*models.Conversation, error)
	ListAllConversations(ctx context.Context, limit int) ([]*models.Conversation, error)

	// IP Blacklist & Ban Management
	BanIP(ctx context.Context, ip, reason, bannedBy string) error
	UnbanIP(ctx context.Context, ip string) error
	IsIPBanned(ctx context.Context, ip string) (bool, error)
	ListBannedIPs(ctx context.Context) ([]*models.BannedIP, error)

	// Database Backup
	BackupDatabase(ctx context.Context, destPath string) error

	// Forum Topics & Supergroups
	ToggleConversationForum(ctx context.Context, convID string, isForum bool) error
	CreateForumTopic(ctx context.Context, topic *models.ForumTopic) error
	GetForumTopics(ctx context.Context, convID string) ([]*models.ForumTopic, error)
	GetMessagesByTopic(ctx context.Context, convID, topicID, beforeID string, limit int) ([]*models.Message, error)

	// Multiple Conversation Pins
	AddConversationPin(ctx context.Context, pin *models.ConversationPin) error
	RemoveConversationPin(ctx context.Context, convID, msgID string) error
	GetConversationPins(ctx context.Context, convID string) ([]*models.ConversationPin, error)

	// Media Shares & Public Streaming
	CreateMediaShare(ctx context.Context, share *models.MediaShare) error
	GetMediaShareByID(ctx context.Context, id string) (*models.MediaShare, error)
	IncrementMediaShareViews(ctx context.Context, id string) error
	IncrementMediaShareDownloads(ctx context.Context, id string) error
	DeleteMediaShare(ctx context.Context, id string) error
}



