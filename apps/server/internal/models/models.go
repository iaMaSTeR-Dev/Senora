package models

import (
	"time"
)

type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	DisplayName  string    `json:"display_name"`
	Bio          string    `json:"bio,omitempty"`
	AvatarURL    string    `json:"avatar_url,omitempty"`
	PasswordHash string    `json:"-"`
	IsApproved   bool      `json:"is_approved"`
	IsOwner      bool      `json:"is_owner"`
	IsBanned       bool      `json:"is_banned"`
	RegistrationIP string    `json:"registration_ip,omitempty"`
	SelfDestructMonths int   `json:"self_destruct_months"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type Device struct {
	ID                string    `json:"id"`
	UserID            string    `json:"user_id"`
	DeviceName        string    `json:"device_name"`
	IdentityPublicKey string    `json:"identity_public_key,omitempty"`
	RegistrationID    uint32    `json:"registration_id,omitempty"`
	SignedPreKey      string    `json:"signed_pre_key,omitempty"`
	CreatedAt         time.Time `json:"created_at"`
	LastSeenAt        time.Time `json:"last_seen_at"`
}

type Session struct {
	ID        string    `json:"id"`
	Token     string    `json:"token"`
	UserID    string    `json:"user_id"`
	DeviceID  string    `json:"device_id,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

type Conversation struct {
	ID              string    `json:"id"`
	Type            string    `json:"type"` // "direct", "group", "channel", or "saved"
	Title           string    `json:"title,omitempty"`
	Username        string    `json:"username,omitempty"`
	Description     string    `json:"description,omitempty"`
	AvatarURL       string    `json:"avatar_url,omitempty"`
	PinnedMessageID string    `json:"pinned_message_id,omitempty"`
	SecurityMode    string    `json:"security_mode"` // "normal", "e2ee_initializing", "e2ee_active", "e2ee_failed"
	UnreadCount     int       `json:"unread_count"`
	DisappearingTTL int       `json:"disappearing_ttl"` // TTL in seconds (0 = disabled)
	SlowModeSeconds int       `json:"slow_mode_seconds"` // 0 = disabled, 10, 30, 60, 300
	IsForum         bool      `json:"is_forum"`          // Topic-based Supergroup Forum
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
	Participants    []*User   `json:"participants,omitempty"`
	LastMessage     *Message  `json:"last_message,omitempty"`
}

type ConversationMember struct {
	ConversationID string    `json:"conversation_id"`
	UserID         string    `json:"user_id"`
	Role           string    `json:"role"` // "owner", "admin", "member"
	JoinedAt       time.Time `json:"joined_at"`
}

type ConversationMemberDetail struct {
	UserID      string    `json:"user_id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	Role        string    `json:"role"`
	JoinedAt    time.Time `json:"joined_at"`
}

type ConversationReadState struct {
	ConversationID    string    `json:"conversation_id"`
	UserID            string    `json:"user_id"`
	LastReadMessageID string    `json:"last_read_message_id"`
	LastReadAt        time.Time `json:"last_read_at"`
}

type ConversationInvite struct {
	ID             string     `json:"id"`
	ConversationID string     `json:"conversation_id"`
	CreatorID      string     `json:"creator_id"`
	InviteCode     string     `json:"invite_code"`
	MaxUses        int        `json:"max_uses"`
	UsesCount      int        `json:"uses_count"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
	IsRevoked      bool       `json:"is_revoked"`
	CreatedAt      time.Time  `json:"created_at"`
}

type MessageView struct {
	MessageID      string    `json:"message_id"`
	UserID         string    `json:"user_id"`
	ConversationID string    `json:"conversation_id"`
	ViewedAt       time.Time `json:"viewed_at"`
}

type MessageRead struct {
	MessageID      string    `json:"message_id"`
	UserID         string    `json:"user_id"`
	ConversationID string    `json:"conversation_id"`
	ReadAt         time.Time `json:"read_at"`
}

type MessageReader struct {
	ID          string    `json:"id"`
	UserID      string    `json:"user_id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	ReadAt      time.Time `json:"read_at"`
}

type Message struct {
	ID                 string     `json:"id"`
	ConversationID     string     `json:"conversation_id"`
	SenderID           string     `json:"sender_id"`
	SenderUsername     string     `json:"sender_username,omitempty"`
	Ciphertext         string     `json:"ciphertext"`
	Nonce              string     `json:"nonce"`
	EphemeralPublicKey string     `json:"ephemeral_public_key,omitempty"`
	IdempotencyKey     string     `json:"idempotency_key,omitempty"`
	EditedAt           *time.Time `json:"edited_at,omitempty"`
	IsDeleted          bool       `json:"is_deleted,omitempty"`
	IsPinned           bool       `json:"is_pinned,omitempty"`
	TopicID            string     `json:"topic_id,omitempty"`
	ReplyToID          string     `json:"reply_to_id,omitempty"`
	Reactions          string     `json:"reactions,omitempty"` // JSON string map of emoji -> []userIds
	IsRead             bool       `json:"is_read"`
	ReadCount          int        `json:"read_count"`
	ViewsCount         int        `json:"views_count"`
	ExpiresAt          *time.Time `json:"expires_at,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
}

type BotToken struct {
	ID        string    `json:"id"`
	BotID     string    `json:"bot_id"`
	TokenHash string    `json:"-"`
	Name      string    `json:"name"`
	Scope     string    `json:"scope"`
	CreatedBy string    `json:"created_by"`
	IsRevoked bool      `json:"is_revoked"`
	CreatedAt time.Time `json:"created_at"`
}

type Attachment struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	UploaderID     string    `json:"uploader_id"`
	Filename       string    `json:"filename"`
	SizeBytes      int64     `json:"size_bytes"`
	ContentType    string    `json:"content_type"`
	IsEncrypted    bool      `json:"is_encrypted"`
	IsViewOnce     bool      `json:"is_view_once"`
	StorageType    string    `json:"storage_type,omitempty"`
	PublicURL      string    `json:"public_url,omitempty"`
	StoragePath    string    `json:"storage_path"`
	CreatedAt      time.Time `json:"created_at"`
}

type ForumTopic struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	Title          string    `json:"title"`
	Icon           string    `json:"icon"`
	Color          string    `json:"color"`
	CreatedBy      string    `json:"created_by"`
	CreatedAt      time.Time `json:"created_at"`
}

type ConversationPin struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	MessageID      string    `json:"message_id"`
	PinnedBy       string    `json:"pinned_by"`
	CreatedAt      time.Time `json:"created_at"`
}

type UserBlock struct {
	BlockerID string    `json:"blocker_id"`
	BlockedID string    `json:"blocked_id"`
	CreatedAt time.Time `json:"created_at"`
}

type EventOutbox struct {
	ID              int64     `json:"id"`
	EventType       string    `json:"event_type"`
	ConversationID  string    `json:"conversation_id,omitempty"`
	RecipientUserID string    `json:"recipient_user_id"`
	Payload         string    `json:"payload"`
	CreatedAt       time.Time `json:"created_at"`
}

type KeyPackage struct {
	ID            string    `json:"id"`
	DeviceID      string    `json:"device_id"`
	OneTimePreKey string    `json:"one_time_pre_key"`
	Used          bool      `json:"used"`
	CreatedAt     time.Time `json:"created_at"`
}

type StickerPack struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Title        string     `json:"title"`
	ThumbnailURL string     `json:"thumbnail_url"`
	Author       string     `json:"author"`
	CreatorID    string     `json:"creator_id,omitempty"`
	ShareCode    string     `json:"share_code,omitempty"`
	StickerCount int        `json:"sticker_count"`
	IsBuiltin    bool       `json:"is_builtin"`
	CreatedAt    time.Time  `json:"created_at"`
	Stickers     []*Sticker `json:"stickers,omitempty"`
}

type Sticker struct {
	ID       string `json:"id"`
	PackID   string `json:"pack_id"`
	Emoji    string `json:"emoji"`
	AssetURL string `json:"asset_url"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

type CallLog struct {
	ID              string     `json:"id"`
	ConversationID  string     `json:"conversation_id"`
	CallerID        string     `json:"caller_id"`
	CallerName      string     `json:"caller_name,omitempty"`
	ReceiverID      string     `json:"receiver_id"`
	ReceiverName    string     `json:"receiver_name,omitempty"`
	CallType        string     `json:"call_type"` // "audio" | "video"
	Status          string     `json:"status"`    // "completed" | "missed" | "rejected" | "failed"
	DurationSeconds int        `json:"duration_seconds"`
	CreatedAt       time.Time  `json:"created_at"`
	EndedAt         *time.Time `json:"ended_at,omitempty"`
}

type CallSignalPayload struct {
	CallID         string      `json:"call_id"`
	ConversationID string      `json:"conversation_id"`
	CallerID       string      `json:"caller_id"`
	ReceiverID     string      `json:"receiver_id"`
	CallType       string      `json:"call_type"`   // "audio" | "video"
	SignalType     string      `json:"signal_type"` // "invite" | "ringing" | "accept" | "reject" | "hangup" | "sdp_offer" | "sdp_answer" | "ice_candidate"
	Data           interface{} `json:"data,omitempty"`
}

type VoiceChatRoom struct {
	ID               string     `json:"id"`
	ConversationID   string     `json:"conversation_id"`
	Title            string     `json:"title"`
	IsActive         bool       `json:"is_active"`
	CreatedBy        string     `json:"created_by"`
	CreatedAt        time.Time  `json:"created_at"`
	EndedAt          *time.Time `json:"ended_at,omitempty"`
	ParticipantCount int        `json:"participant_count"`
}

type VoiceChatParticipant struct {
	RoomID      string    `json:"room_id"`
	UserID      string    `json:"user_id"`
	Username    string    `json:"username,omitempty"`
	DisplayName string    `json:"display_name,omitempty"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	IsMuted     bool      `json:"is_muted"`
	IsSpeaking  bool      `json:"is_speaking"`
	JoinedAt    time.Time `json:"joined_at"`
}

type UserMessageDeletion struct {
	UserID    string    `json:"user_id"`
	MessageID string    `json:"message_id"`
	CreatedAt time.Time `json:"created_at"`
}

type UserConversationClear struct {
	UserID         string    `json:"user_id"`
	ConversationID string    `json:"conversation_id"`
	ClearedAt      time.Time `json:"cleared_at"`
}

type Poll struct {
	ID             string        `json:"id"`
	ConversationID string        `json:"conversation_id"`
	CreatorID      string        `json:"creator_id"`
	Question       string        `json:"question"`
	IsAnonymous    bool          `json:"is_anonymous"`
	AllowsMultiple bool          `json:"allows_multiple"`
	IsQuiz         bool          `json:"is_quiz"`
	CorrectOption  int           `json:"correct_option,omitempty"`
	Explanation    string        `json:"explanation,omitempty"`
	IsClosed       bool          `json:"is_closed"`
	CreatedAt      time.Time     `json:"created_at"`
	Options        []*PollOption `json:"options,omitempty"`
	TotalVotes     int           `json:"total_votes"`
	MyVotes        []int         `json:"my_votes,omitempty"`
}

type PollOption struct {
	ID        int    `json:"id"`
	PollID    string `json:"poll_id"`
	Text      string `json:"text"`
	VoteCount int    `json:"vote_count"`
}

type PollVote struct {
	PollID    string    `json:"poll_id"`
	OptionID  int       `json:"option_id"`
	UserID    string    `json:"user_id"`
	CreatedAt time.Time `json:"created_at"`
}

type Story struct {
	ID          string    `json:"id"`
	UserID      string    `json:"user_id"`
	Username    string    `json:"username,omitempty"`
	DisplayName string    `json:"display_name,omitempty"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	MediaURL    string    `json:"media_url"`
	MediaType   string    `json:"media_type"` // "photo" | "video"
	Caption     string    `json:"caption,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   time.Time `json:"expires_at"`
}

type ScheduledMessage struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	SenderID       string    `json:"sender_id"`
	Ciphertext     string    `json:"ciphertext"`
	Nonce          string    `json:"nonce"`
	ScheduledFor   time.Time `json:"scheduled_for"`
	IsSent         bool      `json:"is_sent"`
	CreatedAt      time.Time `json:"created_at"`
}

type ServerDiscovery struct {
	ServerID        string             `json:"server_id"`
	Name            string             `json:"name"`
	Version         string             `json:"version"`
	APIVersion      string             `json:"api_version"`
	ProtocolVersion string             `json:"protocol_version"`
	Health          string             `json:"health"`
	Maintenance     bool               `json:"maintenance"`
	Capabilities    ServerCapabilities `json:"capabilities"`
}

type ServerCapabilities struct {
	AuthMethods       []string `json:"auth_methods"`
	EncryptionModes   []string `json:"encryption_modes"`
	Calling           []string `json:"calling"`
	MaxUploadBytes    int64    `json:"max_upload_bytes"`
	PushNotifications []string `json:"push_notifications"`
	Features          []string `json:"features"`
}

type PushDeviceRegistration struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	DeviceID  string    `json:"device_id"`
	Platform  string    `json:"platform"` // "web" | "android" | "windows" | "linux" | "ios"
	Endpoint  string    `json:"endpoint"`
	P256DH    string    `json:"p256dh,omitempty"`
	Auth      string    `json:"auth,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type ServerSetting struct {
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	UpdatedAt time.Time `json:"updated_at"`
}

type ServerStats struct {
	TotalUsers         int       `json:"total_users"`
	PendingUsers       int       `json:"pending_users"`
	BannedUsers        int       `json:"banned_users"`
	ActiveSessions     int       `json:"active_sessions"`
	OnlineUsers        int       `json:"online_users"`
	TotalConversations int       `json:"total_conversations"`
	TotalMessages      int       `json:"total_messages"`
	TotalAttachments   int       `json:"total_attachments"`
	TotalStorageBytes  int64     `json:"total_storage_bytes"`
	UptimeSeconds      int64     `json:"uptime_seconds"`
	GoVersion          string    `json:"go_version"`
	MemoryAllocMB      float64   `json:"memory_alloc_mb"`
	MemorySysMB        float64   `json:"memory_sys_mb"`
	NumGoroutines      int       `json:"num_goroutines"`
	ServerStartedAt    time.Time `json:"server_started_at"`
	ApprovalRequired   bool      `json:"approval_required"`
	MaintenanceMode    bool      `json:"maintenance_mode"`
}

type BannedIP struct {
	IP        string    `json:"ip"`
	Reason    string    `json:"reason,omitempty"`
	BannedBy  string    `json:"banned_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type StorageAnalytics struct {
	TotalAttachments int64 `json:"total_attachments"`
	TotalBytes       int64 `json:"total_bytes"`
	ImageCount       int64 `json:"image_count"`
	ImageBytes       int64 `json:"image_bytes"`
	VideoCount       int64 `json:"video_count"`
	VideoBytes       int64 `json:"video_bytes"`
	AudioCount       int64 `json:"audio_count"`
	AudioBytes       int64 `json:"audio_bytes"`
	DocumentCount    int64 `json:"document_count"`
	DocumentBytes    int64 `json:"document_bytes"`
	S3Count          int64 `json:"s3_count"`
	S3Bytes          int64 `json:"s3_bytes"`
	LocalCount       int64 `json:"local_count"`
	LocalBytes       int64 `json:"local_bytes"`
}

type MediaShare struct {
	ID            string     `json:"id"`
	MessageID     string     `json:"message_id,omitempty"`
	FilePath      string     `json:"-"`
	FileName      string     `json:"file_name"`
	FileSize      int64      `json:"file_size"`
	MimeType      string     `json:"mime_type"`
	CreatorID     string     `json:"creator_id"`
	CreatorName   string     `json:"creator_name,omitempty"`
	HasPassword   bool       `json:"has_password"`
	PasswordHash  string     `json:"-"`
	ExpiresAt     *time.Time `json:"expires_at,omitempty"`
	MaxDownloads  int        `json:"max_downloads"`
	DownloadCount int        `json:"download_count"`
	ViewsCount    int        `json:"views_count"`
	CreatedAt     time.Time  `json:"created_at"`
	ShareURL      string     `json:"share_url"`
	StreamURL     string     `json:"stream_url"`
	WatchURL      string     `json:"watch_url"`
}

type WatchPartySession struct {
	ConversationID string    `json:"conversation_id"`
	MediaURL       string    `json:"media_url"`
	MediaTitle     string    `json:"media_title"`
	LeaderID       string    `json:"leader_id"`
	LeaderName     string    `json:"leader_name"`
	State          string    `json:"state"` // "playing", "paused", "buffering"
	CurrentTime    float64   `json:"current_time"` // in seconds
	PlaybackRate   float64   `json:"playback_rate"`
	LastSyncedAt   time.Time `json:"last_synced_at"`
}


