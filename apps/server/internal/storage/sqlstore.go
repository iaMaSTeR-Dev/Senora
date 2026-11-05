package storage

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
	_ "modernc.org/sqlite"

	"senora/server/internal/models"
)

type SQLStore struct {
	db         *sql.DB
	driverName string
}

func NewSQLStore(driverName, dataSourceName string) (*SQLStore, error) {
	db, err := sql.Open(driverName, dataSourceName)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Optimize connection pool
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)

	s := &SQLStore{
		db:         db,
		driverName: driverName,
	}

	if err := s.Migrate(); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	return s, nil
}

func (s *SQLStore) Close() error {
	return s.db.Close()
}

func (s *SQLStore) Migrate() error {
	var schema string
	if s.driverName == "postgres" {
		schema = `
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(32) UNIQUE NOT NULL,
    display_name VARCHAR(64) NOT NULL,
    password_hash TEXT NOT NULL,
    bio TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS devices (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name VARCHAR(128) NOT NULL,
    identity_public_key TEXT,
    registration_id INTEGER DEFAULT 0,
    signed_pre_key TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY,
    token VARCHAR(128) UNIQUE NOT NULL,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(64) REFERENCES devices(id) ON DELETE SET NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS conversations (
    id VARCHAR(64) PRIMARY KEY,
    type VARCHAR(16) NOT NULL,
    title VARCHAR(128),
    description TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    pinned_message_id VARCHAR(64) DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(16) DEFAULT 'member',
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(64) PRIMARY KEY,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id VARCHAR(64) NOT NULL REFERENCES users(id),
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ephemeral_public_key TEXT,
    idempotency_key VARCHAR(64),
    reply_to_id VARCHAR(64) DEFAULT '',
    edited_at TIMESTAMP WITH TIME ZONE,
    is_deleted BOOLEAN DEFAULT FALSE,
    is_pinned BOOLEAN DEFAULT FALSE,
    reactions TEXT DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_messages_conv_sender_idempotency UNIQUE (conversation_id, sender_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    conversation_id VARCHAR(64) REFERENCES conversations(id) ON DELETE CASCADE,
    recipient_user_id VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_outbox_recipient_id ON event_outbox(recipient_user_id, id ASC);

CREATE TABLE IF NOT EXISTS key_packages (
    id VARCHAR(64) PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    one_time_pre_key TEXT NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_key_packages_device ON key_packages(device_id, used);

CREATE TABLE IF NOT EXISTS attachments (
    id VARCHAR(64) PRIMARY KEY,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    uploader_id VARCHAR(64) NOT NULL REFERENCES users(id),
    filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(128) NOT NULL,
    size_bytes BIGINT NOT NULL,
    storage_path TEXT NOT NULL,
    is_encrypted BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments(conversation_id);

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);

CREATE TABLE IF NOT EXISTS sticker_packs (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(64) UNIQUE NOT NULL,
    title VARCHAR(128) NOT NULL,
    thumbnail_url TEXT NOT NULL,
    author VARCHAR(64) NOT NULL,
    sticker_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sticker_packs_name ON sticker_packs(name);

CREATE TABLE IF NOT EXISTS stickers (
    id VARCHAR(64) PRIMARY KEY,
    pack_id VARCHAR(64) NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    emoji VARCHAR(16) NOT NULL,
    asset_url TEXT NOT NULL,
    width INTEGER DEFAULT 256,
    height INTEGER DEFAULT 256
);
CREATE INDEX IF NOT EXISTS idx_stickers_pack ON stickers(pack_id);

CREATE TABLE IF NOT EXISTS user_installed_stickers (
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id VARCHAR(64) NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    installed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, pack_id)
);
CREATE INDEX IF NOT EXISTS idx_user_installed_stickers_user ON user_installed_stickers(user_id);

CREATE TABLE IF NOT EXISTS call_logs (
    id VARCHAR(64) PRIMARY KEY,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    caller_id VARCHAR(64) NOT NULL REFERENCES users(id),
    receiver_id VARCHAR(64) NOT NULL REFERENCES users(id),
    call_type VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    duration_seconds INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_call_logs_conv ON call_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_receiver ON call_logs(receiver_id);

CREATE TABLE IF NOT EXISTS user_message_deletions (
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id VARCHAR(64) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_user_msg_del_user ON user_message_deletions(user_id);

CREATE TABLE IF NOT EXISTS user_conversation_clears (
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    cleared_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_user_conv_clears_user ON user_conversation_clears(user_id);

CREATE TABLE IF NOT EXISTS voice_chat_rooms (
    id VARCHAR(64) PRIMARY KEY,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    title VARCHAR(128) DEFAULT '',
    is_active BOOLEAN DEFAULT TRUE,
    created_by VARCHAR(64) NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_vc_rooms_conv_active ON voice_chat_rooms(conversation_id, is_active);

CREATE TABLE IF NOT EXISTS voice_chat_participants (
    room_id VARCHAR(64) NOT NULL REFERENCES voice_chat_rooms(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_muted BOOLEAN DEFAULT TRUE,
    is_speaking BOOLEAN DEFAULT FALSE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    left_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_vc_participants_room ON voice_chat_participants(room_id, left_at);

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id VARCHAR(64) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferences TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS polls (
    id VARCHAR(64) PRIMARY KEY,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    creator_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    is_anonymous BOOLEAN DEFAULT TRUE,
    allows_multiple BOOLEAN DEFAULT FALSE,
    is_quiz BOOLEAN DEFAULT FALSE,
    correct_option INTEGER DEFAULT 0,
    explanation TEXT DEFAULT '',
    is_closed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_polls_conv ON polls(conversation_id);

CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER NOT NULL,
    poll_id VARCHAR(64) NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    vote_count INTEGER DEFAULT 0,
    PRIMARY KEY (poll_id, id)
);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id VARCHAR(64) NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (poll_id, option_id, user_id)
);

CREATE TABLE IF NOT EXISTS stories (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_url TEXT NOT NULL,
    media_type VARCHAR(16) DEFAULT 'photo',
    caption TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);

CREATE TABLE IF NOT EXISTS scheduled_messages (
    id VARCHAR(64) PRIMARY KEY,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    scheduled_for TIMESTAMP WITH TIME ZONE NOT NULL,
    is_sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scheduled_msgs_conv ON scheduled_messages(conversation_id, sender_id);

CREATE TABLE IF NOT EXISTS conversation_read_state (
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id VARCHAR(64) NOT NULL,
    last_read_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_read_state_user ON conversation_read_state(user_id);

CREATE TABLE IF NOT EXISTS conversation_invites (
    id VARCHAR(64) PRIMARY KEY,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    creator_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_code VARCHAR(64) UNIQUE NOT NULL,
    max_uses INTEGER DEFAULT 0,
    uses_count INTEGER DEFAULT 0,
    expires_at TIMESTAMP WITH TIME ZONE,
    is_revoked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conv_invites_code ON conversation_invites(invite_code);
CREATE INDEX IF NOT EXISTS idx_conv_invites_conv ON conversation_invites(conversation_id);

CREATE TABLE IF NOT EXISTS message_views (
    message_id VARCHAR(64) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    viewed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_views_msg ON message_views(message_id);

CREATE TABLE IF NOT EXISTS message_reads (
    message_id VARCHAR(64) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    read_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_reads_msg ON message_reads(message_id);
CREATE INDEX IF NOT EXISTS idx_msg_reads_conv_user ON message_reads(conversation_id, user_id);

CREATE TABLE IF NOT EXISTS bot_tokens (
    id VARCHAR(64) PRIMARY KEY,
    bot_id VARCHAR(64) NOT NULL,
    token_hash VARCHAR(128) UNIQUE NOT NULL,
    name VARCHAR(64) NOT NULL,
    permissions TEXT DEFAULT '*',
    webhook_url TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_bot_tokens_hash ON bot_tokens(token_hash);
`
	} else {
		// SQLite compatible schema
		schema = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    bio TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    identity_public_key TEXT,
    registration_id INTEGER DEFAULT 0,
    signed_pre_key TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT,
    description TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    pinned_message_id TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ephemeral_public_key TEXT,
    idempotency_key TEXT,
    reply_to_id TEXT DEFAULT '',
    edited_at DATETIME,
    is_deleted INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0,
    reactions TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (conversation_id, sender_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    recipient_user_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_outbox_recipient_id ON event_outbox(recipient_user_id, id ASC);

CREATE TABLE IF NOT EXISTS key_packages (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    one_time_pre_key TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_key_packages_device ON key_packages(device_id, used);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    uploader_id TEXT NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    is_encrypted INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments(conversation_id);

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);

CREATE TABLE IF NOT EXISTS sticker_packs (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    thumbnail_url TEXT NOT NULL,
    author TEXT NOT NULL,
    sticker_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sticker_packs_name ON sticker_packs(name);

CREATE TABLE IF NOT EXISTS stickers (
    id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    asset_url TEXT NOT NULL,
    width INTEGER DEFAULT 256,
    height INTEGER DEFAULT 256
);
CREATE INDEX IF NOT EXISTS idx_stickers_pack ON stickers(pack_id);

CREATE TABLE IF NOT EXISTS user_installed_stickers (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id TEXT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, pack_id)
);
CREATE INDEX IF NOT EXISTS idx_user_installed_stickers_user ON user_installed_stickers(user_id);

CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    caller_id TEXT NOT NULL REFERENCES users(id),
    receiver_id TEXT NOT NULL REFERENCES users(id),
    call_type TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_seconds INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_call_logs_conv ON call_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_receiver ON call_logs(receiver_id);

CREATE TABLE IF NOT EXISTS user_message_deletions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_user_msg_del_user ON user_message_deletions(user_id);

CREATE TABLE IF NOT EXISTS user_conversation_clears (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    cleared_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_user_conv_clears_user ON user_conversation_clears(user_id);

CREATE TABLE IF NOT EXISTS voice_chat_rooms (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    title TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_vc_rooms_conv_active ON voice_chat_rooms(conversation_id, is_active);

CREATE TABLE IF NOT EXISTS voice_chat_participants (
    room_id TEXT NOT NULL REFERENCES voice_chat_rooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_muted INTEGER DEFAULT 1,
    is_speaking INTEGER DEFAULT 0,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME,
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_vc_participants_room ON voice_chat_participants(room_id, left_at);

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferences TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    is_anonymous INTEGER DEFAULT 1,
    allows_multiple INTEGER DEFAULT 0,
    is_quiz INTEGER DEFAULT 0,
    correct_option INTEGER DEFAULT 0,
    explanation TEXT DEFAULT '',
    is_closed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_polls_conv ON polls(conversation_id);

CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER NOT NULL,
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    vote_count INTEGER DEFAULT 0,
    PRIMARY KEY (poll_id, id)
);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (poll_id, option_id, user_id)
);

CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_url TEXT NOT NULL,
    media_type TEXT DEFAULT 'photo',
    caption TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);

CREATE TABLE IF NOT EXISTS scheduled_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    scheduled_for DATETIME NOT NULL,
    is_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scheduled_msgs_conv ON scheduled_messages(conversation_id, sender_id);

CREATE TABLE IF NOT EXISTS conversation_read_state (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id TEXT NOT NULL,
    last_read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_read_state_user ON conversation_read_state(user_id);

CREATE TABLE IF NOT EXISTS conversation_invites (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_code TEXT UNIQUE NOT NULL,
    max_uses INTEGER DEFAULT 0,
    uses_count INTEGER DEFAULT 0,
    expires_at DATETIME,
    is_revoked INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conv_invites_code ON conversation_invites(invite_code);
CREATE INDEX IF NOT EXISTS idx_conv_invites_conv ON conversation_invites(conversation_id);

CREATE TABLE IF NOT EXISTS message_views (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_views_msg ON message_views(message_id);

CREATE TABLE IF NOT EXISTS message_reads (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_reads_msg ON message_reads(message_id);
CREATE INDEX IF NOT EXISTS idx_msg_reads_conv_user ON message_reads(conversation_id, user_id);

CREATE TABLE IF NOT EXISTS bot_tokens (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    permissions TEXT DEFAULT '*',
    webhook_url TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_bot_tokens_hash ON bot_tokens(token_hash);
`
	}

	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	// Additive migrations for existing databases
	alterCols := []string{
		"ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''",
		"ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT ''",
		"ALTER TABLE devices ADD COLUMN registration_id INTEGER DEFAULT 0",
		"ALTER TABLE devices ADD COLUMN signed_pre_key TEXT DEFAULT ''",
		"ALTER TABLE conversations ADD COLUMN description TEXT DEFAULT ''",
		"ALTER TABLE conversations ADD COLUMN avatar_url TEXT DEFAULT ''",
		"ALTER TABLE conversations ADD COLUMN pinned_message_id TEXT DEFAULT ''",
		"ALTER TABLE conversations ADD COLUMN security_mode TEXT DEFAULT 'normal'",
		"ALTER TABLE conversations ADD COLUMN disappearing_ttl INTEGER DEFAULT 0",
		"ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT ''",
		"ALTER TABLE messages ADD COLUMN edited_at DATETIME",
		"ALTER TABLE messages ADD COLUMN is_deleted INTEGER DEFAULT 0",
		"ALTER TABLE messages ADD COLUMN is_pinned INTEGER DEFAULT 0",
		"ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '{}'",
		"ALTER TABLE messages ADD COLUMN expires_at DATETIME",
		"ALTER TABLE sticker_packs ADD COLUMN creator_id TEXT DEFAULT ''",
		"ALTER TABLE sticker_packs ADD COLUMN share_code TEXT DEFAULT ''",
		"ALTER TABLE sticker_packs ADD COLUMN is_builtin INTEGER DEFAULT 0",
	}
	if s.driverName == "postgres" {
		alterCols = []string{
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''",
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT ''",
			"ALTER TABLE devices ADD COLUMN IF NOT EXISTS registration_id INTEGER DEFAULT 0",
			"ALTER TABLE devices ADD COLUMN IF NOT EXISTS signed_pre_key TEXT DEFAULT ''",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT ''",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned_message_id TEXT DEFAULT ''",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS security_mode VARCHAR(32) DEFAULT 'normal'",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS disappearing_ttl INTEGER DEFAULT 0",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id TEXT DEFAULT ''",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP WITH TIME ZONE",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions TEXT DEFAULT '{}'",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE",
			"ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS creator_id VARCHAR(64) DEFAULT ''",
			"ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS share_code VARCHAR(64) DEFAULT ''",
			"ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN DEFAULT FALSE",
		}
	}
	for _, alterStmt := range alterCols {
		_, _ = s.db.Exec(alterStmt) // ignore if column already exists
	}

	_ = s.seedBuiltinStickers()

	return nil
}

// ---------------------------------------------------------------------
// User operations
// ---------------------------------------------------------------------

func (s *SQLStore) CreateUser(ctx context.Context, u *models.User) error {
	if u.ID == "" {
		u.ID = "usr_" + uuid.New().String()
	}
	now := time.Now().UTC()
	u.CreatedAt = now
	u.UpdatedAt = now

	query := `INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at) 
	          VALUES (?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at) 
		          VALUES ($1, $2, $3, $4, $5, $6)`
	}

	_, err := s.db.ExecContext(ctx, query, u.ID, u.Username, u.DisplayName, u.PasswordHash, u.CreatedAt, u.UpdatedAt)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") || strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			return ErrAlreadyExists
		}
		return err
	}
	return nil
}

func (s *SQLStore) GetUserByID(ctx context.Context, id string) (*models.User, error) {
	query := `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), created_at, updated_at FROM users WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), created_at, updated_at FROM users WHERE id = $1`
	}

	row := s.db.QueryRowContext(ctx, query, id)
	var u models.User
	if err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Bio, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &u, nil
}

func (s *SQLStore) GetUserByUsername(ctx context.Context, username string) (*models.User, error) {
	query := `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), created_at, updated_at FROM users WHERE LOWER(username) = LOWER(?)`
	if s.driverName == "postgres" {
		query = `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), created_at, updated_at FROM users WHERE LOWER(username) = LOWER($1)`
	}

	row := s.db.QueryRowContext(ctx, query, username)
	var u models.User
	if err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Bio, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &u, nil
}

func (s *SQLStore) SearchUsers(ctx context.Context, queryStr string, excludeUserID string) ([]*models.User, error) {
	pattern := "%" + strings.ToLower(queryStr) + "%"
	query := `SELECT id, username, display_name, COALESCE(bio, ''), COALESCE(avatar_url, ''), created_at, updated_at FROM users 
	          WHERE (LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?) AND id != ? 
	          ORDER BY username ASC LIMIT 20`
	if s.driverName == "postgres" {
		query = `SELECT id, username, display_name, COALESCE(bio, ''), COALESCE(avatar_url, ''), created_at, updated_at FROM users 
		          WHERE (LOWER(username) LIKE $1 OR LOWER(display_name) LIKE $2) AND id != $3 
		          ORDER BY username ASC LIMIT 20`
	}

	rows, err := s.db.QueryContext(ctx, query, pattern, pattern, excludeUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Bio, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		users = append(users, &u)
	}
	return users, rows.Err()
}

func (s *SQLStore) UpdateUser(ctx context.Context, u *models.User) error {
	u.UpdatedAt = time.Now().UTC()
	query := `UPDATE users SET display_name = ?, bio = ?, avatar_url = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE users SET display_name = $1, bio = $2, avatar_url = $3, updated_at = $4 WHERE id = $5`
	}
	_, err := s.db.ExecContext(ctx, query, u.DisplayName, u.Bio, u.AvatarURL, u.UpdatedAt, u.ID)
	return err
}

// ---------------------------------------------------------------------
// Device operations
// ---------------------------------------------------------------------

func (s *SQLStore) CreateDevice(ctx context.Context, d *models.Device) error {
	if d.ID == "" {
		d.ID = "dev_" + uuid.New().String()
	}
	now := time.Now().UTC()
	d.CreatedAt = now
	d.LastSeenAt = now

	query := `INSERT INTO devices (id, user_id, device_name, identity_public_key, registration_id, signed_pre_key, created_at, last_seen_at) 
	          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO devices (id, user_id, device_name, identity_public_key, registration_id, signed_pre_key, created_at, last_seen_at) 
		          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
	}

	_, err := s.db.ExecContext(ctx, query, d.ID, d.UserID, d.DeviceName, d.IdentityPublicKey, d.RegistrationID, d.SignedPreKey, d.CreatedAt, d.LastSeenAt)
	return err
}

func (s *SQLStore) GetDeviceByID(ctx context.Context, id string) (*models.Device, error) {
	query := `SELECT id, user_id, device_name, COALESCE(identity_public_key, ''), COALESCE(registration_id, 0), COALESCE(signed_pre_key, ''), created_at, last_seen_at FROM devices WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, user_id, device_name, COALESCE(identity_public_key, ''), COALESCE(registration_id, 0), COALESCE(signed_pre_key, ''), created_at, last_seen_at FROM devices WHERE id = $1`
	}

	row := s.db.QueryRowContext(ctx, query, id)
	var d models.Device
	if err := row.Scan(&d.ID, &d.UserID, &d.DeviceName, &d.IdentityPublicKey, &d.RegistrationID, &d.SignedPreKey, &d.CreatedAt, &d.LastSeenAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &d, nil
}

func (s *SQLStore) GetDevicesByUserID(ctx context.Context, userID string) ([]*models.Device, error) {
	query := `SELECT id, user_id, device_name, COALESCE(identity_public_key, ''), COALESCE(registration_id, 0), COALESCE(signed_pre_key, ''), created_at, last_seen_at FROM devices WHERE user_id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, user_id, device_name, COALESCE(identity_public_key, ''), COALESCE(registration_id, 0), COALESCE(signed_pre_key, ''), created_at, last_seen_at FROM devices WHERE user_id = $1`
	}

	rows, err := s.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []*models.Device
	for rows.Next() {
		var d models.Device
		if err := rows.Scan(&d.ID, &d.UserID, &d.DeviceName, &d.IdentityPublicKey, &d.RegistrationID, &d.SignedPreKey, &d.CreatedAt, &d.LastSeenAt); err != nil {
			return nil, err
		}
		devices = append(devices, &d)
	}
	return devices, rows.Err()
}

func (s *SQLStore) UpdateDeviceKey(ctx context.Context, deviceID, pubKey string) error {
	query := `UPDATE devices SET identity_public_key = ?, last_seen_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE devices SET identity_public_key = $1, last_seen_at = $2 WHERE id = $3`
	}
	_, err := s.db.ExecContext(ctx, query, pubKey, time.Now().UTC(), deviceID)
	return err
}

func (s *SQLStore) UpdateDeviceSignalKeys(ctx context.Context, deviceID string, pubKey string, regID uint32, signedPreKey string) error {
	query := `UPDATE devices SET identity_public_key = ?, registration_id = ?, signed_pre_key = ?, last_seen_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE devices SET identity_public_key = $1, registration_id = $2, signed_pre_key = $3, last_seen_at = $4 WHERE id = $5`
	}
	_, err := s.db.ExecContext(ctx, query, pubKey, regID, signedPreKey, time.Now().UTC(), deviceID)
	return err
}

func (s *SQLStore) UpdateDeviceLastSeen(ctx context.Context, deviceID string) error {
	now := time.Now().UTC()
	query := `UPDATE devices SET last_seen_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE devices SET last_seen_at = $1 WHERE id = $2`
	}
	_, err := s.db.ExecContext(ctx, query, now, deviceID)
	return err
}

func (s *SQLStore) DeleteDevice(ctx context.Context, deviceID string, userID string) error {
	delSess := `DELETE FROM sessions WHERE device_id = ? AND user_id = ?`
	delDev := `DELETE FROM devices WHERE id = ? AND user_id = ?`
	if s.driverName == "postgres" {
		delSess = `DELETE FROM sessions WHERE device_id = $1 AND user_id = $2`
		delDev = `DELETE FROM devices WHERE id = $1 AND user_id = $2`
	}
	_, _ = s.db.ExecContext(ctx, delSess, deviceID, userID)
	_, err := s.db.ExecContext(ctx, delDev, deviceID, userID)
	return err
}

// ---------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------

func (s *SQLStore) CreateSession(ctx context.Context, sess *models.Session) error {
	if sess.ID == "" {
		sess.ID = "ses_" + uuid.New().String()
	}
	sess.CreatedAt = time.Now().UTC()

	query := `INSERT INTO sessions (id, token, user_id, device_id, expires_at, created_at) 
	          VALUES (?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO sessions (id, token, user_id, device_id, expires_at, created_at) 
		          VALUES ($1, $2, $3, $4, $5, $6)`
	}

	_, err := s.db.ExecContext(ctx, query, sess.ID, sess.Token, sess.UserID, sess.DeviceID, sess.ExpiresAt, sess.CreatedAt)
	return err
}

func (s *SQLStore) GetSessionByToken(ctx context.Context, token string) (*models.Session, error) {
	query := `SELECT id, token, user_id, device_id, expires_at, created_at FROM sessions WHERE token = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, token, user_id, device_id, expires_at, created_at FROM sessions WHERE token = $1`
	}

	row := s.db.QueryRowContext(ctx, query, token)
	var sess models.Session
	var devID sql.NullString
	if err := row.Scan(&sess.ID, &sess.Token, &sess.UserID, &devID, &sess.ExpiresAt, &sess.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if devID.Valid {
		sess.DeviceID = devID.String
	}
	if time.Now().UTC().After(sess.ExpiresAt) {
		_ = s.DeleteSession(ctx, token)
		return nil, ErrUnauthorized
	}
	return &sess, nil
}

func (s *SQLStore) DeleteSession(ctx context.Context, token string) error {
	query := `DELETE FROM sessions WHERE token = ?`
	if s.driverName == "postgres" {
		query = `DELETE FROM sessions WHERE token = $1`
	}
	_, err := s.db.ExecContext(ctx, query, token)
	return err
}

// ---------------------------------------------------------------------
// Conversation operations
// ---------------------------------------------------------------------

func (s *SQLStore) CreateConversation(ctx context.Context, c *models.Conversation, memberUserIDs []string) error {
	if c.ID == "" {
		c.ID = "cnv_" + uuid.New().String()
	}
	if c.SecurityMode == "" {
		c.SecurityMode = "normal"
	}
	now := time.Now().UTC()
	c.CreatedAt = now
	c.UpdatedAt = now

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	convQuery := `INSERT INTO conversations (id, type, title, description, avatar_url, pinned_message_id, security_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		convQuery = `INSERT INTO conversations (id, type, title, description, avatar_url, pinned_message_id, security_mode, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
	}

	if _, err := tx.ExecContext(ctx, convQuery, c.ID, c.Type, c.Title, c.Description, c.AvatarURL, c.PinnedMessageID, c.SecurityMode, c.CreatedAt, c.UpdatedAt); err != nil {
		return err
	}

	memQuery := `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`
	if s.driverName == "postgres" {
		memQuery = `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`
	}

	seenMembers := make(map[string]bool)
	var validMembers []string
	for _, uid := range memberUserIDs {
		trimmed := strings.TrimSpace(uid)
		if trimmed != "" && !seenMembers[trimmed] {
			seenMembers[trimmed] = true
			validMembers = append(validMembers, trimmed)
		}
	}

	for i, uid := range validMembers {
		role := "member"
		if i == 0 && c.Type != "direct" {
			role = "owner"
		}
		if _, err := tx.ExecContext(ctx, memQuery, c.ID, uid, role, now); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *SQLStore) GetConversationByID(ctx context.Context, id string) (*models.Conversation, error) {
	query := `SELECT id, type, COALESCE(title, ''), COALESCE(description, ''), COALESCE(avatar_url, ''), COALESCE(pinned_message_id, ''), COALESCE(security_mode, 'normal'), COALESCE(disappearing_ttl, 0), created_at, updated_at FROM conversations WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, type, COALESCE(title, ''), COALESCE(description, ''), COALESCE(avatar_url, ''), COALESCE(pinned_message_id, ''), COALESCE(security_mode, 'normal'), COALESCE(disappearing_ttl, 0), created_at, updated_at FROM conversations WHERE id = $1`
	}

	row := s.db.QueryRowContext(ctx, query, id)
	var c models.Conversation
	if err := row.Scan(&c.ID, &c.Type, &c.Title, &c.Description, &c.AvatarURL, &c.PinnedMessageID, &c.SecurityMode, &c.DisappearingTTL, &c.CreatedAt, &c.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	partQuery := `
		SELECT u.id, u.username, u.display_name, COALESCE(u.avatar_url, ''), COALESCE(u.bio, ''), u.created_at, u.updated_at
		FROM users u
		INNER JOIN conversation_members cm ON u.id = cm.user_id
		WHERE cm.conversation_id = ?
	`
	if s.driverName == "postgres" {
		partQuery = `
			SELECT u.id, u.username, u.display_name, COALESCE(u.avatar_url, ''), COALESCE(u.bio, ''), u.created_at, u.updated_at
			FROM users u
			INNER JOIN conversation_members cm ON u.id = cm.user_id
			WHERE cm.conversation_id = $1
		`
	}
	pRows, err := s.db.QueryContext(ctx, partQuery, c.ID)
	if err == nil {
		for pRows.Next() {
			var u models.User
			if err := pRows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.Bio, &u.CreatedAt, &u.UpdatedAt); err == nil {
				c.Participants = append(c.Participants, &u)
			}
		}
		if pErr := pRows.Err(); pErr != nil {
			pRows.Close()
			return nil, pErr
		}
		pRows.Close()
	}

	return &c, nil
}

func (s *SQLStore) UpdateConversation(ctx context.Context, c *models.Conversation) error {
	c.UpdatedAt = time.Now().UTC()
	query := `UPDATE conversations SET title = ?, description = ?, avatar_url = ?, pinned_message_id = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE conversations SET title = $1, description = $2, avatar_url = $3, pinned_message_id = $4, updated_at = $5 WHERE id = $6`
	}
	_, err := s.db.ExecContext(ctx, query, c.Title, c.Description, c.AvatarURL, c.PinnedMessageID, c.UpdatedAt, c.ID)
	return err
}

func (s *SQLStore) AddConversationMember(ctx context.Context, convID, userID, role string) error {
	if role == "" {
		role = "member"
	}
	now := time.Now().UTC()
	query := `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4) ON CONFLICT (conversation_id, user_id) DO NOTHING`
	} else {
		query = `INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`
	}
	_, err := s.db.ExecContext(ctx, query, convID, userID, role, now)
	return err
}

func (s *SQLStore) RemoveConversationMember(ctx context.Context, convID, userID string) error {
	query := `DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
	if s.driverName == "postgres" {
		query = `DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`
	}
	_, err := s.db.ExecContext(ctx, query, convID, userID)
	return err
}

func (s *SQLStore) ListConversationsForUser(ctx context.Context, userID string) ([]*models.Conversation, error) {
	query := `
		SELECT c.id, c.type, COALESCE(c.title, ''), COALESCE(c.description, ''), COALESCE(c.avatar_url, ''), COALESCE(c.pinned_message_id, ''), COALESCE(c.security_mode, 'normal'), COALESCE(c.disappearing_ttl, 0), c.created_at, c.updated_at 
		FROM conversations c
		INNER JOIN conversation_members cm ON c.id = cm.conversation_id
		WHERE cm.user_id = ?
		ORDER BY c.updated_at DESC
	`
	if s.driverName == "postgres" {
		query = `
			SELECT c.id, c.type, COALESCE(c.title, ''), COALESCE(c.description, ''), COALESCE(c.avatar_url, ''), COALESCE(c.pinned_message_id, ''), COALESCE(c.security_mode, 'normal'), COALESCE(c.disappearing_ttl, 0), c.created_at, c.updated_at 
			FROM conversations c
			INNER JOIN conversation_members cm ON c.id = cm.conversation_id
			WHERE cm.user_id = $1
			ORDER BY c.updated_at DESC
		`
	}

	rows, err := s.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var convs []*models.Conversation
	for rows.Next() {
		var c models.Conversation
		if err := rows.Scan(&c.ID, &c.Type, &c.Title, &c.Description, &c.AvatarURL, &c.PinnedMessageID, &c.SecurityMode, &c.DisappearingTTL, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		convs = append(convs, &c)
	}

	// Fetch participants & last message & unread count for each conversation
	for _, c := range convs {
		partQuery := `
			SELECT u.id, u.username, u.display_name, COALESCE(u.avatar_url, ''), COALESCE(u.bio, ''), u.created_at, u.updated_at
			FROM users u
			INNER JOIN conversation_members cm ON u.id = cm.user_id
			WHERE cm.conversation_id = ?
		`
		if s.driverName == "postgres" {
			partQuery = `
				SELECT u.id, u.username, u.display_name, COALESCE(u.avatar_url, ''), COALESCE(u.bio, ''), u.created_at, u.updated_at
				FROM users u
				INNER JOIN conversation_members cm ON u.id = cm.user_id
				WHERE cm.conversation_id = $1
			`
		}
		pRows, err := s.db.QueryContext(ctx, partQuery, c.ID)
		if err == nil {
			for pRows.Next() {
				var u models.User
				if err := pRows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.Bio, &u.CreatedAt, &u.UpdatedAt); err == nil {
					c.Participants = append(c.Participants, &u)
				}
			}
			if pErr := pRows.Err(); pErr != nil {
				pRows.Close()
				return nil, pErr
			}
			pRows.Close()
		}

		// Fetch unread count for this user in this conversation
		unreadQuery := `
			SELECT COUNT(*) 
			FROM messages m
			LEFT JOIN user_message_deletions umd ON m.id = umd.message_id AND umd.user_id = ?
			LEFT JOIN conversation_read_state crs ON crs.conversation_id = m.conversation_id AND crs.user_id = ?
			WHERE m.conversation_id = ? 
			  AND m.sender_id != ?
			  AND umd.message_id IS NULL
			  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
			  AND (crs.last_read_at IS NULL OR m.created_at > crs.last_read_at)
		`
		if s.driverName == "postgres" {
			unreadQuery = `
				SELECT COUNT(*) 
				FROM messages m
				LEFT JOIN user_message_deletions umd ON m.id = umd.message_id AND umd.user_id = $1
				LEFT JOIN conversation_read_state crs ON crs.conversation_id = m.conversation_id AND crs.user_id = $2
				WHERE m.conversation_id = $3 
				  AND m.sender_id != $4
				  AND umd.message_id IS NULL
				  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
				  AND (crs.last_read_at IS NULL OR m.created_at > crs.last_read_at)
			`
		}
		var unread int
		if err := s.db.QueryRowContext(ctx, unreadQuery, userID, userID, c.ID, userID).Scan(&unread); err == nil {
			c.UnreadCount = unread
		}

		// Fetch latest message (excluding Delete for Me messages)
		msgQuery := `
			SELECT m.id, m.conversation_id, m.sender_id, m.ciphertext, m.nonce, m.created_at
			FROM messages m
			LEFT JOIN user_message_deletions umd ON m.id = umd.message_id AND umd.user_id = ?
			WHERE m.conversation_id = ? AND umd.message_id IS NULL
			  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
			ORDER BY m.created_at DESC LIMIT 1
		`
		if s.driverName == "postgres" {
			msgQuery = `
				SELECT m.id, m.conversation_id, m.sender_id, m.ciphertext, m.nonce, m.created_at
				FROM messages m
				LEFT JOIN user_message_deletions umd ON m.id = umd.message_id AND umd.user_id = $1
				WHERE m.conversation_id = $2 AND umd.message_id IS NULL
				  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
				ORDER BY m.created_at DESC LIMIT 1
			`
		}
		mRow := s.db.QueryRowContext(ctx, msgQuery, userID, c.ID)
		var m models.Message
		if err := mRow.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Ciphertext, &m.Nonce, &m.CreatedAt); err == nil {
			c.LastMessage = &m
		}
	}

	return convs, rows.Err()
}

func (s *SQLStore) IsMember(ctx context.Context, conversationID, userID string) (bool, error) {
	query := `SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
	if s.driverName == "postgres" {
		query = `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`
	}

	var exists int
	err := s.db.QueryRowContext(ctx, query, conversationID, userID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return exists == 1, nil
}

func (s *SQLStore) GetConversationMembers(ctx context.Context, conversationID string) ([]string, error) {
	query := `SELECT user_id FROM conversation_members WHERE conversation_id = ?`
	if s.driverName == "postgres" {
		query = `SELECT user_id FROM conversation_members WHERE conversation_id = $1`
	}

	rows, err := s.db.QueryContext(ctx, query, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var userIDs []string
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		userIDs = append(userIDs, uid)
	}
	return userIDs, rows.Err()
}

func (s *SQLStore) GetConversationMemberDetails(ctx context.Context, conversationID string) ([]*models.ConversationMemberDetail, error) {
	query := `
		SELECT cm.user_id, u.username, u.display_name, COALESCE(u.avatar_url, ''), cm.role, cm.joined_at
		FROM conversation_members cm
		JOIN users u ON cm.user_id = u.id
		WHERE cm.conversation_id = ?
		ORDER BY CASE cm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, cm.joined_at ASC
	`
	if s.driverName == "postgres" {
		query = `
			SELECT cm.user_id, u.username, u.display_name, COALESCE(u.avatar_url, ''), cm.role, cm.joined_at
			FROM conversation_members cm
			JOIN users u ON cm.user_id = u.id
			WHERE cm.conversation_id = $1
			ORDER BY CASE cm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, cm.joined_at ASC
		`
	}

	rows, err := s.db.QueryContext(ctx, query, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var members []*models.ConversationMemberDetail
	for rows.Next() {
		var m models.ConversationMemberDetail
		if err := rows.Scan(&m.UserID, &m.Username, &m.DisplayName, &m.AvatarURL, &m.Role, &m.JoinedAt); err != nil {
			return nil, err
		}
		members = append(members, &m)
	}
	return members, rows.Err()
}

// ---------------------------------------------------------------------
// Message & Transactional Outbox operations
// ---------------------------------------------------------------------

func (s *SQLStore) CreateMessageWithOutbox(ctx context.Context, msg *models.Message, recipientUserIDs []string) (*models.Message, []*models.EventOutbox, error) {
	if msg.ID == "" {
		msg.ID = "msg_" + uuid.New().String()
	}
	now := time.Now().UTC()
	msg.CreatedAt = now

	// Idempotency check: scoped strictly to conversation, sender, and idempotency key
	if msg.IdempotencyKey != "" {
		checkQuery := `SELECT id, conversation_id, sender_id, ciphertext, nonce, ephemeral_public_key, idempotency_key, created_at 
		               FROM messages WHERE idempotency_key = ? AND sender_id = ? AND conversation_id = ?`
		if s.driverName == "postgres" {
			checkQuery = `SELECT id, conversation_id, sender_id, ciphertext, nonce, ephemeral_public_key, idempotency_key, created_at 
			               FROM messages WHERE idempotency_key = $1 AND sender_id = $2 AND conversation_id = $3`
		}
		row := s.db.QueryRowContext(ctx, checkQuery, msg.IdempotencyKey, msg.SenderID, msg.ConversationID)
		var existing models.Message
		var epKey, idempKey sql.NullString
		if err := row.Scan(&existing.ID, &existing.ConversationID, &existing.SenderID, &existing.Ciphertext, &existing.Nonce, &epKey, &idempKey, &existing.CreatedAt); err == nil {
			if epKey.Valid {
				existing.EphemeralPublicKey = epKey.String
			}
			if idempKey.Valid {
				existing.IdempotencyKey = idempKey.String
			}
			if existing.Ciphertext != msg.Ciphertext {
				return nil, nil, ErrIdempotencyConflict
			}
			return &existing, nil, nil
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()

	// 1. Insert message
	if msg.ExpiresAt == nil {
		var ttl int
		ttlQuery := `SELECT COALESCE(disappearing_ttl, 0) FROM conversations WHERE id = ?`
		if s.driverName == "postgres" {
			ttlQuery = `SELECT COALESCE(disappearing_ttl, 0) FROM conversations WHERE id = $1`
		}
		if err := tx.QueryRowContext(ctx, ttlQuery, msg.ConversationID).Scan(&ttl); err == nil && ttl > 0 {
			exp := msg.CreatedAt.Add(time.Duration(ttl) * time.Second)
			msg.ExpiresAt = &exp
		}
	}

	msgQuery := `INSERT INTO messages (id, conversation_id, sender_id, ciphertext, nonce, ephemeral_public_key, idempotency_key, reply_to_id, is_deleted, is_pinned, reactions, expires_at, created_at)
	             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		msgQuery = `INSERT INTO messages (id, conversation_id, sender_id, ciphertext, nonce, ephemeral_public_key, idempotency_key, reply_to_id, is_deleted, is_pinned, reactions, expires_at, created_at)
		             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`
	}

	var idempVal sql.NullString
	if msg.IdempotencyKey != "" {
		idempVal = sql.NullString{String: msg.IdempotencyKey, Valid: true}
	}
	var ephemVal sql.NullString
	if msg.EphemeralPublicKey != "" {
		ephemVal = sql.NullString{String: msg.EphemeralPublicKey, Valid: true}
	}
	if msg.Reactions == "" {
		msg.Reactions = "{}"
	}

	_, err = tx.ExecContext(ctx, msgQuery, msg.ID, msg.ConversationID, msg.SenderID, msg.Ciphertext, msg.Nonce, ephemVal, idempVal, msg.ReplyToID, msg.IsDeleted, msg.IsPinned, msg.Reactions, msg.ExpiresAt, msg.CreatedAt)
	if err != nil {
		_ = tx.Rollback()
		if msg.IdempotencyKey != "" {
			// Check if this was a concurrent race with the same idempotency key
			checkQuery := `SELECT id, conversation_id, sender_id, ciphertext, nonce, ephemeral_public_key, idempotency_key, created_at
			               FROM messages WHERE idempotency_key = ? AND sender_id = ? AND conversation_id = ?`
			if s.driverName == "postgres" {
				checkQuery = `SELECT id, conversation_id, sender_id, ciphertext, nonce, ephemeral_public_key, idempotency_key, created_at
				               FROM messages WHERE idempotency_key = $1 AND sender_id = $2 AND conversation_id = $3`
			}
			row := s.db.QueryRowContext(ctx, checkQuery, msg.IdempotencyKey, msg.SenderID, msg.ConversationID)
			var existing models.Message
			var epKey, idempKey sql.NullString
			if scanErr := row.Scan(&existing.ID, &existing.ConversationID, &existing.SenderID, &existing.Ciphertext, &existing.Nonce, &epKey, &idempKey, &existing.CreatedAt); scanErr == nil {
				if epKey.Valid {
					existing.EphemeralPublicKey = epKey.String
				}
				if idempKey.Valid {
					existing.IdempotencyKey = idempKey.String
				}
				if existing.Ciphertext != msg.Ciphertext {
					return nil, nil, ErrIdempotencyConflict
				}
				return &existing, nil, nil
			}
		}
		return nil, nil, err
	}

	// 2. Touch conversation updated_at
	upQuery := `UPDATE conversations SET updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		upQuery = `UPDATE conversations SET updated_at = $1 WHERE id = $2`
	}
	if _, err := tx.ExecContext(ctx, upQuery, msg.CreatedAt, msg.ConversationID); err != nil {
		return nil, nil, err
	}

	// 3. Insert outbox events for all participants (atomically in same transaction)
	payloadMap := map[string]interface{}{
		"id":                   msg.ID,
		"message_id":           msg.ID,
		"conversation_id":      msg.ConversationID,
		"sender_id":            msg.SenderID,
		"ciphertext":           msg.Ciphertext,
		"nonce":                msg.Nonce,
		"ephemeral_public_key": msg.EphemeralPublicKey,
		"reply_to_id":          msg.ReplyToID,
		"reactions":            msg.Reactions,
		"created_at":           msg.CreatedAt.Format(time.RFC3339Nano),
	}
	if msg.IdempotencyKey != "" {
		payloadMap["idempotency_key"] = msg.IdempotencyKey
	}
	if msg.ExpiresAt != nil {
		payloadMap["expires_at"] = msg.ExpiresAt.Format(time.RFC3339Nano)
	}
	payloadBytes, _ := json.Marshal(payloadMap)
	payloadStr := string(payloadBytes)

	var createdEvents []*models.EventOutbox
	for _, recipientID := range recipientUserIDs {
		if s.driverName == "postgres" {
			var evID int64
			outboxQueryPG := `INSERT INTO event_outbox (event_type, conversation_id, recipient_user_id, payload, created_at) 
			                  VALUES ($1, $2, $3, $4, $5) RETURNING id`
			if err := tx.QueryRowContext(ctx, outboxQueryPG, "message.created", msg.ConversationID, recipientID, payloadStr, now).Scan(&evID); err != nil {
				return nil, nil, err
			}
			createdEvents = append(createdEvents, &models.EventOutbox{
				ID:              evID,
				EventType:       "message.created",
				ConversationID:  msg.ConversationID,
				RecipientUserID: recipientID,
				Payload:         payloadStr,
				CreatedAt:       now,
			})
		} else {
			outboxQuery := `INSERT INTO event_outbox (event_type, conversation_id, recipient_user_id, payload, created_at) 
			                VALUES (?, ?, ?, ?, ?)`
			res, err := tx.ExecContext(ctx, outboxQuery, "message.created", msg.ConversationID, recipientID, payloadStr, now)
			if err != nil {
				return nil, nil, err
			}
			evID, _ := res.LastInsertId()
			createdEvents = append(createdEvents, &models.EventOutbox{
				ID:              evID,
				EventType:       "message.created",
				ConversationID:  msg.ConversationID,
				RecipientUserID: recipientID,
				Payload:         payloadStr,
				CreatedAt:       now,
			})
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}

	return msg, createdEvents, nil
}

func (s *SQLStore) GetMessages(ctx context.Context, conversationID string, beforeID string, limit int) ([]*models.Message, error) {
	return s.GetMessagesForUser(ctx, conversationID, "", beforeID, limit)
}

func (s *SQLStore) GetMessagesForUser(ctx context.Context, conversationID, userID, beforeID string, limit int) ([]*models.Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	var rows *sql.Rows
	var err error

	if userID == "" {
		if beforeID == "" {
			query := `
				SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, 0), COALESCE(m.is_pinned, 0), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
				FROM messages m
				JOIN users u ON m.sender_id = u.id
				WHERE m.conversation_id = ?
				  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
				ORDER BY m.created_at DESC
				LIMIT ?
			`
			if s.driverName == "postgres" {
				query = `
					SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, false), COALESCE(m.is_pinned, false), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
					FROM messages m
					JOIN users u ON m.sender_id = u.id
					WHERE m.conversation_id = $1
					  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
					ORDER BY m.created_at DESC
					LIMIT $2
				`
			}
			rows, err = s.db.QueryContext(ctx, query, conversationID, limit)
		} else {
			query := `
				SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, 0), COALESCE(m.is_pinned, 0), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
				FROM messages m
				JOIN users u ON m.sender_id = u.id
				WHERE m.conversation_id = ? 
				  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
				  AND m.created_at < (SELECT created_at FROM messages WHERE id = ?)
				ORDER BY m.created_at DESC
				LIMIT ?
			`
			if s.driverName == "postgres" {
				query = `
					SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, false), COALESCE(m.is_pinned, false), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
					FROM messages m
					JOIN users u ON m.sender_id = u.id
					WHERE m.conversation_id = $1 
					  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
					  AND m.created_at < (SELECT created_at FROM messages WHERE id = $2)
					ORDER BY m.created_at DESC
					LIMIT $3
				`
			}
			rows, err = s.db.QueryContext(ctx, query, conversationID, beforeID, limit)
		}
	} else {
		// Filter out "Delete for Me" and messages before "Clear Chat for Me"
		if beforeID == "" {
			query := `
				SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, 0), COALESCE(m.is_pinned, 0), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
				FROM messages m
				JOIN users u ON m.sender_id = u.id
				LEFT JOIN user_message_deletions umd ON m.id = umd.message_id AND umd.user_id = ?
				LEFT JOIN user_conversation_clears ucc ON m.conversation_id = ucc.conversation_id AND ucc.user_id = ?
				WHERE m.conversation_id = ? 
				  AND umd.message_id IS NULL
				  AND (ucc.cleared_at IS NULL OR m.created_at > ucc.cleared_at)
				  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
				ORDER BY m.created_at DESC
				LIMIT ?
			`
			if s.driverName == "postgres" {
				query = `
					SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, false), COALESCE(m.is_pinned, false), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
					FROM messages m
					JOIN users u ON m.sender_id = u.id
					LEFT JOIN user_message_deletions umd ON m.id = umd.message_id AND umd.user_id = $1
					LEFT JOIN user_conversation_clears ucc ON m.conversation_id = ucc.conversation_id AND ucc.user_id = $2
					WHERE m.conversation_id = $3 
					  AND umd.message_id IS NULL
					  AND (ucc.cleared_at IS NULL OR m.created_at > ucc.cleared_at)
					  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
					ORDER BY m.created_at DESC
					LIMIT $4
				`
				rows, err = s.db.QueryContext(ctx, query, userID, userID, conversationID, limit)
			} else {
				rows, err = s.db.QueryContext(ctx, query, userID, userID, conversationID, limit)
			}
		} else {
			query := `
				SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, 0), COALESCE(m.is_pinned, 0), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
				FROM messages m
				JOIN users u ON m.sender_id = u.id
				LEFT JOIN user_message_deletions umd ON m.id = umd.message_id AND umd.user_id = ?
				LEFT JOIN user_conversation_clears ucc ON m.conversation_id = ucc.conversation_id AND ucc.user_id = ?
				WHERE m.conversation_id = ? 
				  AND umd.message_id IS NULL
				  AND (ucc.cleared_at IS NULL OR m.created_at > ucc.cleared_at)
				  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
				  AND m.created_at < (SELECT created_at FROM messages WHERE id = ?)
				ORDER BY m.created_at DESC
				LIMIT ?
			`
			if s.driverName == "postgres" {
				query = `
					SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, false), COALESCE(m.is_pinned, false), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
					FROM messages m
					JOIN users u ON m.sender_id = u.id
					LEFT JOIN user_message_deletions umd ON m.id = umd.message_id AND umd.user_id = $1
					LEFT JOIN user_conversation_clears ucc ON m.conversation_id = ucc.conversation_id AND ucc.user_id = $2
					WHERE m.conversation_id = $3 
					  AND umd.message_id IS NULL
					  AND (ucc.cleared_at IS NULL OR m.created_at > ucc.cleared_at)
					  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
					  AND m.created_at < (SELECT created_at FROM messages WHERE id = $4)
					ORDER BY m.created_at DESC
					LIMIT $5
				`
				rows, err = s.db.QueryContext(ctx, query, userID, userID, conversationID, beforeID, limit)
			} else {
				rows, err = s.db.QueryContext(ctx, query, userID, userID, conversationID, beforeID, limit)
			}
		}
	}

	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []*models.Message
	for rows.Next() {
		var m models.Message
		var epKey, idempKey sql.NullString
		var editedAt, expAt sql.NullTime
		if s.driverName == "postgres" {
			var isDel, isPin bool
			if err := rows.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.SenderUsername, &m.Ciphertext, &m.Nonce, &epKey, &idempKey, &m.ReplyToID, &editedAt, &isDel, &isPin, &m.Reactions, &expAt, &m.CreatedAt); err != nil {
				return nil, err
			}
			m.IsDeleted = isDel
			m.IsPinned = isPin
		} else {
			var isDelInt, isPinInt int
			if err := rows.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.SenderUsername, &m.Ciphertext, &m.Nonce, &epKey, &idempKey, &m.ReplyToID, &editedAt, &isDelInt, &isPinInt, &m.Reactions, &expAt, &m.CreatedAt); err != nil {
				return nil, err
			}
			m.IsDeleted = (isDelInt != 0)
			m.IsPinned = (isPinInt != 0)
		}
		if epKey.Valid {
			m.EphemeralPublicKey = epKey.String
		}
		if idempKey.Valid {
			m.IdempotencyKey = idempKey.String
		}
		if editedAt.Valid {
			m.EditedAt = &editedAt.Time
		}
		if expAt.Valid {
			m.ExpiresAt = &expAt.Time
		}
		msgs = append(msgs, &m)
	}

	// Reverse so returned order is chronological (oldest to newest)
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}

	if len(msgs) > 0 {
		// 1. Fetch read timestamps for conversation
		var maxOtherReadAt, myReadAt time.Time
		var otherStr, myStr sql.NullString
		otherReadQuery := `SELECT MAX(last_read_at) FROM conversation_read_state WHERE conversation_id = ? AND user_id != ?`
		myReadQuery := `SELECT MAX(last_read_at) FROM conversation_read_state WHERE conversation_id = ? AND user_id = ?`
		if s.driverName == "postgres" {
			otherReadQuery = `SELECT MAX(last_read_at) FROM conversation_read_state WHERE conversation_id = $1 AND user_id != $2`
			myReadQuery = `SELECT MAX(last_read_at) FROM conversation_read_state WHERE conversation_id = $1 AND user_id = $2`
		}
		_ = s.db.QueryRowContext(ctx, otherReadQuery, conversationID, userID).Scan(&otherStr)
		if userID != "" {
			_ = s.db.QueryRowContext(ctx, myReadQuery, conversationID, userID).Scan(&myStr)
		}

		parseTime := func(str string) time.Time {
			if str == "" {
				return time.Time{}
			}
			for _, layout := range []string{
				"2006-01-02 15:04:05.999999999 -0700 MST",
				"2006-01-02 15:04:05.999999999 -0700 -0700",
				"2006-01-02 15:04:05.999999999 -0700",
				time.RFC3339Nano,
				time.RFC3339,
				"2006-01-02 15:04:05.999999999-07:00",
				"2006-01-02 15:04:05.999999999",
				"2006-01-02 15:04:05",
				"2006-01-02T15:04:05",
			} {
				if t, err := time.Parse(layout, str); err == nil {
					return t
				}
			}
			return time.Time{}
		}

		if otherStr.Valid {
			maxOtherReadAt = parseTime(otherStr.String)
		}
		if myStr.Valid {
			myReadAt = parseTime(myStr.String)
		}

		// 2. Fetch view counts for conversation messages
		viewCounts := make(map[string]int)
		vcQuery := `SELECT message_id, COUNT(*) FROM message_views WHERE conversation_id = ? GROUP BY message_id`
		if s.driverName == "postgres" {
			vcQuery = `SELECT message_id, COUNT(*) FROM message_views WHERE conversation_id = $1 GROUP BY message_id`
		}
		if vcRows, err := s.db.QueryContext(ctx, vcQuery, conversationID); err == nil {
			for vcRows.Next() {
				var mid string
				var count int
				if err := vcRows.Scan(&mid, &count); err == nil {
					viewCounts[mid] = count
				}
			}
			if vcErr := vcRows.Err(); vcErr != nil {
				vcRows.Close()
				return nil, vcErr
			}
			vcRows.Close()
		}

		// Fetch all participant read timestamps for this conversation
		readStates := []time.Time{}
		rsQuery := `SELECT last_read_at FROM conversation_read_state WHERE conversation_id = ?`
		if s.driverName == "postgres" {
			rsQuery = `SELECT last_read_at FROM conversation_read_state WHERE conversation_id = $1`
		}
		if rsRows, err := s.db.QueryContext(ctx, rsQuery, conversationID); err == nil {
			for rsRows.Next() {
				var rStr sql.NullString
				if err := rsRows.Scan(&rStr); err == nil && rStr.Valid {
					t := parseTime(rStr.String)
					if !t.IsZero() {
						readStates = append(readStates, t)
					}
				}
			}
			if rsErr := rsRows.Err(); rsErr != nil {
				rsRows.Close()
				return nil, rsErr
			}
			rsRows.Close()
		}

		// Fetch read counts from message_reads
		readCounts := make(map[string]int)
		myReads := make(map[string]bool)
		rcQuery := `SELECT message_id, COUNT(*) FROM message_reads WHERE conversation_id = ? GROUP BY message_id`
		if s.driverName == "postgres" {
			rcQuery = `SELECT message_id, COUNT(*) FROM message_reads WHERE conversation_id = $1 GROUP BY message_id`
		}
		if rcRows, err := s.db.QueryContext(ctx, rcQuery, conversationID); err == nil {
			for rcRows.Next() {
				var mid string
				var count int
				if err := rcRows.Scan(&mid, &count); err == nil {
					readCounts[mid] = count
				}
			}
			if rcErr := rcRows.Err(); rcErr != nil {
				rcRows.Close()
				return nil, rcErr
			}
			rcRows.Close()
		}

		if userID != "" {
			mrQuery := `SELECT message_id FROM message_reads WHERE conversation_id = ? AND user_id = ?`
			if s.driverName == "postgres" {
				mrQuery = `SELECT message_id FROM message_reads WHERE conversation_id = $1 AND user_id = $2`
			}
			if mrRows, err := s.db.QueryContext(ctx, mrQuery, conversationID, userID); err == nil {
				for mrRows.Next() {
					var mid string
					if err := mrRows.Scan(&mid); err == nil {
						myReads[mid] = true
					}
				}
				if mrErr := mrRows.Err(); mrErr != nil {
					mrRows.Close()
					return nil, mrErr
				}
				mrRows.Close()
			}
		}

		// 3. Populate fields on messages
		for _, m := range msgs {
			m.ViewsCount = viewCounts[m.ID]
			rc := readCounts[m.ID]
			m.ReadCount = rc

			if m.SenderID == userID {
				// Outgoing message: strictly true if at least one eligible reader read it in message_reads
				if len(readCounts) > 0 {
					m.IsRead = rc > 0
				} else {
					// Legacy fallback for conversations prior to message_reads
					m.IsRead = !maxOtherReadAt.IsZero() && !m.CreatedAt.After(maxOtherReadAt.Add(time.Second))
				}
			} else {
				// Incoming message: read if current user read receipt exists
				if len(myReads) > 0 {
					m.IsRead = myReads[m.ID]
				} else {
					m.IsRead = !myReadAt.IsZero() && !m.CreatedAt.After(myReadAt.Add(time.Second))
				}
			}
		}
	}

	return msgs, rows.Err()
}

func (s *SQLStore) GetMessageByID(ctx context.Context, id string) (*models.Message, error) {
	query := `
		SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, 0), COALESCE(m.is_pinned, 0), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
		FROM messages m
		JOIN users u ON m.sender_id = u.id
		WHERE m.id = ?
	`
	if s.driverName == "postgres" {
		query = `
			SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, false), COALESCE(m.is_pinned, false), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
			FROM messages m
			JOIN users u ON m.sender_id = u.id
			WHERE m.id = $1
		`
	}
	row := s.db.QueryRowContext(ctx, query, id)
	var m models.Message
	var epKey, idempKey sql.NullString
	var editedAt, expAt sql.NullTime
	var isDel, isPin bool
	var err error
	if s.driverName == "postgres" {
		err = row.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.SenderUsername, &m.Ciphertext, &m.Nonce, &epKey, &idempKey, &m.ReplyToID, &editedAt, &isDel, &isPin, &m.Reactions, &expAt, &m.CreatedAt)
	} else {
		var isDelInt, isPinInt int
		err = row.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.SenderUsername, &m.Ciphertext, &m.Nonce, &epKey, &idempKey, &m.ReplyToID, &editedAt, &isDelInt, &isPinInt, &m.Reactions, &expAt, &m.CreatedAt)
		isDel = (isDelInt != 0)
		isPin = (isPinInt != 0)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if epKey.Valid {
		m.EphemeralPublicKey = epKey.String
	}
	if idempKey.Valid {
		m.IdempotencyKey = idempKey.String
	}
	if editedAt.Valid {
		m.EditedAt = &editedAt.Time
	}
	if expAt.Valid {
		m.ExpiresAt = &expAt.Time
	}
	m.IsDeleted = isDel
	m.IsPinned = isPin
	return &m, nil
}

func (s *SQLStore) UpdateMessageCiphertext(ctx context.Context, messageID string, ciphertext string, nonce string) (*models.Message, error) {
	now := time.Now().UTC()
	query := `UPDATE messages SET ciphertext = ?, nonce = ?, edited_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE messages SET ciphertext = $1, nonce = $2, edited_at = $3 WHERE id = $4`
	}
	_, err := s.db.ExecContext(ctx, query, ciphertext, nonce, now, messageID)
	if err != nil {
		return nil, err
	}
	return s.GetMessageByID(ctx, messageID)
}

func (s *SQLStore) DeleteMessage(ctx context.Context, msgID string) error {
	query := `UPDATE messages SET is_deleted = 1, ciphertext = '{"deleted":true}', nonce = '' WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE messages SET is_deleted = TRUE, ciphertext = '{"deleted":true}', nonce = '' WHERE id = $1`
	}
	_, err := s.db.ExecContext(ctx, query, msgID)
	return err
}

func (s *SQLStore) AddMessageReaction(ctx context.Context, messageID string, userID string, emoji string) (string, error) {
	msg, err := s.GetMessageByID(ctx, messageID)
	if err != nil {
		return "", err
	}

	reactionsMap := make(map[string][]string)
	if msg.Reactions != "" && msg.Reactions != "{}" {
		_ = json.Unmarshal([]byte(msg.Reactions), &reactionsMap)
	}

	userList := reactionsMap[emoji]
	found := false
	var updatedList []string
	for _, u := range userList {
		if u == userID {
			found = true
		} else {
			updatedList = append(updatedList, u)
		}
	}
	if !found {
		updatedList = append(updatedList, userID)
	}
	if len(updatedList) > 0 {
		reactionsMap[emoji] = updatedList
	} else {
		delete(reactionsMap, emoji)
	}

	data, _ := json.Marshal(reactionsMap)
	reactionsJSON := string(data)

	query := `UPDATE messages SET reactions = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE messages SET reactions = $1 WHERE id = $2`
	}
	_, err = s.db.ExecContext(ctx, query, reactionsJSON, messageID)
	if err != nil {
		return "", err
	}
	return reactionsJSON, nil
}

func (s *SQLStore) PinMessage(ctx context.Context, conversationID string, messageID string, isPinned bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	pinnedID := ""
	pinnedVal := 0
	if isPinned {
		pinnedID = messageID
		pinnedVal = 1
	}

	upConv := `UPDATE conversations SET pinned_message_id = ? WHERE id = ?`
	if s.driverName == "postgres" {
		upConv = `UPDATE conversations SET pinned_message_id = $1 WHERE id = $2`
	}
	if _, err := tx.ExecContext(ctx, upConv, pinnedID, conversationID); err != nil {
		return err
	}

	upMsgs := `UPDATE messages SET is_pinned = ? WHERE id = ? AND conversation_id = ?`
	if s.driverName == "postgres" {
		upMsgs = `UPDATE messages SET is_pinned = $1 WHERE id = $2 AND conversation_id = $3`
	}
	if _, err := tx.ExecContext(ctx, upMsgs, pinnedVal, messageID, conversationID); err != nil {
		return err
	}

	return tx.Commit()
}

func (s *SQLStore) CreateAttachment(ctx context.Context, a *models.Attachment) error {
	if a.ID == "" {
		a.ID = "att_" + uuid.New().String()
	}
	a.CreatedAt = time.Now().UTC()

	query := `INSERT INTO attachments (id, conversation_id, uploader_id, filename, content_type, size_bytes, storage_path, is_encrypted, created_at)
	          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO attachments (id, conversation_id, uploader_id, filename, content_type, size_bytes, storage_path, is_encrypted, created_at)
		          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
	}

	encVal := 1
	if !a.IsEncrypted {
		encVal = 0
	}
	var err error
	if s.driverName == "postgres" {
		_, err = s.db.ExecContext(ctx, query, a.ID, a.ConversationID, a.UploaderID, a.Filename, a.ContentType, a.SizeBytes, a.StoragePath, a.IsEncrypted, a.CreatedAt)
	} else {
		_, err = s.db.ExecContext(ctx, query, a.ID, a.ConversationID, a.UploaderID, a.Filename, a.ContentType, a.SizeBytes, a.StoragePath, encVal, a.CreatedAt)
	}
	return err
}

func (s *SQLStore) GetAttachmentByID(ctx context.Context, id string) (*models.Attachment, error) {
	query := `SELECT id, conversation_id, uploader_id, filename, content_type, size_bytes, storage_path, is_encrypted, created_at FROM attachments WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, conversation_id, uploader_id, filename, content_type, size_bytes, storage_path, is_encrypted, created_at FROM attachments WHERE id = $1`
	}

	row := s.db.QueryRowContext(ctx, query, id)
	var a models.Attachment
	var encInt int
	var err error
	if s.driverName == "postgres" {
		err = row.Scan(&a.ID, &a.ConversationID, &a.UploaderID, &a.Filename, &a.ContentType, &a.SizeBytes, &a.StoragePath, &a.IsEncrypted, &a.CreatedAt)
	} else {
		err = row.Scan(&a.ID, &a.ConversationID, &a.UploaderID, &a.Filename, &a.ContentType, &a.SizeBytes, &a.StoragePath, &encInt, &a.CreatedAt)
		a.IsEncrypted = (encInt != 0)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *SQLStore) BlockUser(ctx context.Context, blockerID, blockedID string) error {
	query := `INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`
	}
	_, err := s.db.ExecContext(ctx, query, blockerID, blockedID, time.Now().UTC())
	return err
}

func (s *SQLStore) UnblockUser(ctx context.Context, blockerID, blockedID string) error {
	query := `DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?`
	if s.driverName == "postgres" {
		query = `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`
	}
	_, err := s.db.ExecContext(ctx, query, blockerID, blockedID)
	return err
}

func (s *SQLStore) IsUserBlocked(ctx context.Context, blockerID, blockedID string) (bool, error) {
	query := `SELECT COUNT(1) FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?`
	if s.driverName == "postgres" {
		query = `SELECT COUNT(1) FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`
	}
	var count int
	err := s.db.QueryRowContext(ctx, query, blockerID, blockedID).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (s *SQLStore) GetOutboxEventsAfter(ctx context.Context, recipientUserID string, afterID int64, limit int) ([]*models.EventOutbox, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	query := `
		SELECT id, event_type, conversation_id, recipient_user_id, payload, created_at
		FROM event_outbox
		WHERE recipient_user_id = ? AND id > ?
		ORDER BY id ASC
		LIMIT ?
	`
	if s.driverName == "postgres" {
		query = `
			SELECT id, event_type, conversation_id, recipient_user_id, payload, created_at
			FROM event_outbox
			WHERE recipient_user_id = $1 AND id > $2
			ORDER BY id ASC
			LIMIT $3
		`
	}

	rows, err := s.db.QueryContext(ctx, query, recipientUserID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []*models.EventOutbox
	for rows.Next() {
		var e models.EventOutbox
		var convID sql.NullString
		if err := rows.Scan(&e.ID, &e.EventType, &convID, &e.RecipientUserID, &e.Payload, &e.CreatedAt); err != nil {
			return nil, err
		}
		if convID.Valid {
			e.ConversationID = convID.String
		}
		events = append(events, &e)
	}

	return events, rows.Err()
}

// ---------------------------------------------------------------------
// Crypto Key Package operations
// ---------------------------------------------------------------------

func (s *SQLStore) SaveKeyPackages(ctx context.Context, pkgs []*models.KeyPackage) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	query := `INSERT INTO key_packages (id, device_id, one_time_pre_key, used, created_at) VALUES (?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO key_packages (id, device_id, one_time_pre_key, used, created_at) VALUES ($1, $2, $3, $4, $5)`
	}

	now := time.Now().UTC()
	for _, p := range pkgs {
		if p.ID == "" {
			p.ID = "key_" + uuid.New().String()
		}
		p.CreatedAt = now
		usedVal := 0
		if p.Used {
			usedVal = 1
		}
		if s.driverName == "postgres" {
			if _, err := tx.ExecContext(ctx, query, p.ID, p.DeviceID, p.OneTimePreKey, p.Used, p.CreatedAt); err != nil {
				return err
			}
		} else {
			if _, err := tx.ExecContext(ctx, query, p.ID, p.DeviceID, p.OneTimePreKey, usedVal, p.CreatedAt); err != nil {
				return err
			}
		}
	}

	return tx.Commit()
}

func (s *SQLStore) GetAvailableKeyPackage(ctx context.Context, deviceID string) (*models.KeyPackage, error) {
	query := `SELECT id, device_id, one_time_pre_key, used, created_at FROM key_packages WHERE device_id = ? AND used = 0 LIMIT 1`
	if s.driverName == "postgres" {
		query = `SELECT id, device_id, one_time_pre_key, used, created_at FROM key_packages WHERE device_id = $1 AND used = FALSE LIMIT 1`
	}

	row := s.db.QueryRowContext(ctx, query, deviceID)
	var p models.KeyPackage
	var usedInt int
	var err error
	if s.driverName == "postgres" {
		err = row.Scan(&p.ID, &p.DeviceID, &p.OneTimePreKey, &p.Used, &p.CreatedAt)
	} else {
		err = row.Scan(&p.ID, &p.DeviceID, &p.OneTimePreKey, &usedInt, &p.CreatedAt)
		p.Used = (usedInt != 0)
	}

	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	// Mark as used
	upQuery := `UPDATE key_packages SET used = 1 WHERE id = ?`
	if s.driverName == "postgres" {
		upQuery = `UPDATE key_packages SET used = TRUE WHERE id = $1`
	}
	_, _ = s.db.ExecContext(ctx, upQuery, p.ID)

	return &p, nil
}

// ---------------------------------------------------------------------
// Conversation Member Roles
// ---------------------------------------------------------------------

func (s *SQLStore) GetMemberRole(ctx context.Context, conversationID, userID string) (string, error) {
	query := `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
	if s.driverName == "postgres" {
		query = `SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`
	}
	var role string
	err := s.db.QueryRowContext(ctx, query, conversationID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return role, err
}

// ---------------------------------------------------------------------
// Stickers & Sticker Packs
// ---------------------------------------------------------------------

func (s *SQLStore) ListStickerPacks(ctx context.Context) ([]*models.StickerPack, error) {
	query := `SELECT id, name, title, thumbnail_url, author, sticker_count, created_at FROM sticker_packs ORDER BY created_at ASC`
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var packs []*models.StickerPack
	for rows.Next() {
		var p models.StickerPack
		if err := rows.Scan(&p.ID, &p.Name, &p.Title, &p.ThumbnailURL, &p.Author, &p.StickerCount, &p.CreatedAt); err != nil {
			return nil, err
		}
		p.IsBuiltin = strings.HasPrefix(p.ID, "pack_builtin_") || strings.HasPrefix(p.ID, "pack_nexa_") || strings.HasPrefix(p.ID, "pack_crypto_")
		packs = append(packs, &p)
	}
	if packs == nil {
		packs = []*models.StickerPack{}
	}
	return packs, rows.Err()
}

func (s *SQLStore) GetStickerPackByID(ctx context.Context, id string) (*models.StickerPack, error) {
	query := `SELECT id, name, title, thumbnail_url, author, sticker_count, created_at FROM sticker_packs WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, name, title, thumbnail_url, author, sticker_count, created_at FROM sticker_packs WHERE id = $1`
	}
	row := s.db.QueryRowContext(ctx, query, id)
	var p models.StickerPack
	if err := row.Scan(&p.ID, &p.Name, &p.Title, &p.ThumbnailURL, &p.Author, &p.StickerCount, &p.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	p.IsBuiltin = strings.HasPrefix(p.ID, "pack_builtin_") || strings.HasPrefix(p.ID, "pack_nexa_") || strings.HasPrefix(p.ID, "pack_crypto_")

	stickers, err := s.GetStickersForPack(ctx, p.ID)
	if err == nil {
		p.Stickers = stickers
	}
	return &p, nil
}

func (s *SQLStore) GetStickersForPack(ctx context.Context, packID string) ([]*models.Sticker, error) {
	query := `SELECT id, pack_id, emoji, asset_url, width, height FROM stickers WHERE pack_id = ? ORDER BY id ASC`
	if s.driverName == "postgres" {
		query = `SELECT id, pack_id, emoji, asset_url, width, height FROM stickers WHERE pack_id = $1 ORDER BY id ASC`
	}
	rows, err := s.db.QueryContext(ctx, query, packID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*models.Sticker
	for rows.Next() {
		var st models.Sticker
		if err := rows.Scan(&st.ID, &st.PackID, &st.Emoji, &st.AssetURL, &st.Width, &st.Height); err != nil {
			return nil, err
		}
		list = append(list, &st)
	}
	if list == nil {
		list = []*models.Sticker{}
	}
	return list, rows.Err()
}

func (s *SQLStore) InstallStickerPack(ctx context.Context, userID, packID string) error {
	query := `INSERT OR IGNORE INTO user_installed_stickers (user_id, pack_id, installed_at) VALUES (?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO user_installed_stickers (user_id, pack_id, installed_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`
	}
	_, err := s.db.ExecContext(ctx, query, userID, packID, time.Now().UTC())
	return err
}

func (s *SQLStore) UninstallStickerPack(ctx context.Context, userID, packID string) error {
	query := `DELETE FROM user_installed_stickers WHERE user_id = ? AND pack_id = ?`
	if s.driverName == "postgres" {
		query = `DELETE FROM user_installed_stickers WHERE user_id = $1 AND pack_id = $2`
	}
	_, err := s.db.ExecContext(ctx, query, userID, packID)
	return err
}

func (s *SQLStore) GetInstalledStickerPacks(ctx context.Context, userID string) ([]*models.StickerPack, error) {
	query := `SELECT sp.id, sp.name, sp.title, sp.thumbnail_url, sp.author, sp.sticker_count, sp.created_at
	          FROM sticker_packs sp
	          INNER JOIN user_installed_stickers uis ON sp.id = uis.pack_id
	          WHERE uis.user_id = ?
	          ORDER BY uis.installed_at DESC`
	if s.driverName == "postgres" {
		query = `SELECT sp.id, sp.name, sp.title, sp.thumbnail_url, sp.author, sp.sticker_count, sp.created_at
		          FROM sticker_packs sp
		          INNER JOIN user_installed_stickers uis ON sp.id = uis.pack_id
		          WHERE uis.user_id = $1
		          ORDER BY uis.installed_at DESC`
	}
	rows, err := s.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var packs []*models.StickerPack
	for rows.Next() {
		var p models.StickerPack
		if err := rows.Scan(&p.ID, &p.Name, &p.Title, &p.ThumbnailURL, &p.Author, &p.StickerCount, &p.CreatedAt); err != nil {
			return nil, err
		}
		p.IsBuiltin = strings.HasPrefix(p.ID, "pack_builtin_") || strings.HasPrefix(p.ID, "pack_nexa_") || strings.HasPrefix(p.ID, "pack_crypto_")
		if stks, err := s.GetStickersForPack(ctx, p.ID); err == nil {
			p.Stickers = stks
		}
		packs = append(packs, &p)
	}
	if packs == nil {
		// If user has none installed, auto-return all built-in packs
		return s.ListStickerPacks(ctx)
	}
	return packs, rows.Err()
}

func (s *SQLStore) seedBuiltinStickers() error {
	var count int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM sticker_packs`).Scan(&count)
	if count > 0 {
		return nil
	}

	now := time.Now().UTC()
	// Builtin Pack 1: Senora Classic
	p1Query := `INSERT INTO sticker_packs (id, name, title, thumbnail_url, author, sticker_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		p1Query = `INSERT INTO sticker_packs (id, name, title, thumbnail_url, author, sticker_count, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`
	}

	thumb1 := "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%2324A1DE'/><text x='50' y='65' font-size='45' text-anchor='middle'>⚡</text></svg>"
	_, _ = s.db.Exec(p1Query, "pack_senora_classic", "senora_classic", "Senora Classic", thumb1, "Senora Team", 6, now)

	// Builtin Pack 2: Crypto Animals
	thumb2 := "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%2310b981'/><text x='50' y='65' font-size='45' text-anchor='middle'>🦊</text></svg>"
	_, _ = s.db.Exec(p1Query, "pack_crypto_animals", "crypto_animals", "Crypto Animals", thumb2, "Senora Team", 6, now)

	stQuery := `INSERT INTO stickers (id, pack_id, emoji, asset_url, width, height) VALUES (?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		stQuery = `INSERT INTO stickers (id, pack_id, emoji, asset_url, width, height) VALUES ($1, $2, $3, $4, $5, $6)`
	}

	stickersP1 := []struct {
		id, emoji, sym string
	}{
		{"stk_nc_1", "😎", "😎"},
		{"stk_nc_2", "🔥", "🔥"},
		{"stk_nc_3", "🚀", "🚀"},
		{"stk_nc_4", "🛡️", "🛡️"},
		{"stk_nc_5", "❤️", "❤️"},
		{"stk_nc_6", "🎉", "🎉"},
	}
	for _, st := range stickersP1 {
		asset := fmt.Sprintf("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><circle cx='60' cy='60' r='55' fill='none'/><text x='60' y='80' font-size='70' text-anchor='middle'>%s</text></svg>", st.sym)
		_, _ = s.db.Exec(stQuery, st.id, "pack_senora_classic", st.emoji, asset, 256, 256)
	}

	stickersP2 := []struct {
		id, emoji, sym string
	}{
		{"stk_ca_1", "🐱", "🐱"},
		{"stk_ca_2", "🐶", "🐶"},
		{"stk_ca_3", "🦊", "🦊"},
		{"stk_ca_4", "🦉", "🦉"},
		{"stk_ca_5", "🐻", "🐻"},
		{"stk_ca_6", "🦅", "🦅"},
	}
	for _, st := range stickersP2 {
		asset := fmt.Sprintf("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><circle cx='60' cy='60' r='55' fill='none'/><text x='60' y='80' font-size='70' text-anchor='middle'>%s</text></svg>", st.sym)
		_, _ = s.db.Exec(stQuery, st.id, "pack_crypto_animals", st.emoji, asset, 256, 256)
	}

	return nil
}

// ---------------------------------------------------------------------
// Call Logs
// ---------------------------------------------------------------------

func (s *SQLStore) CreateCallLog(ctx context.Context, call *models.CallLog) error {
	if call.ID == "" {
		call.ID = "call_" + uuid.New().String()
	}
	if call.CreatedAt.IsZero() {
		call.CreatedAt = time.Now().UTC()
	}
	query := `INSERT INTO call_logs (id, conversation_id, caller_id, receiver_id, call_type, status, duration_seconds, created_at)
	          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO call_logs (id, conversation_id, caller_id, receiver_id, call_type, status, duration_seconds, created_at)
		          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
	}
	_, err := s.db.ExecContext(ctx, query, call.ID, call.ConversationID, call.CallerID, call.ReceiverID, call.CallType, call.Status, call.DurationSeconds, call.CreatedAt)
	return err
}

func (s *SQLStore) UpdateCallLog(ctx context.Context, callID, status string, duration int) error {
	now := time.Now().UTC()
	query := `UPDATE call_logs SET status = ?, duration_seconds = ?, ended_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE call_logs SET status = $1, duration_seconds = $2, ended_at = $3 WHERE id = $4`
	}
	_, err := s.db.ExecContext(ctx, query, status, duration, now, callID)
	return err
}

func (s *SQLStore) GetCallLogs(ctx context.Context, userID string) ([]*models.CallLog, error) {
	query := `SELECT cl.id, cl.conversation_id, cl.caller_id, u1.display_name, cl.receiver_id, u2.display_name, cl.call_type, cl.status, cl.duration_seconds, cl.created_at, cl.ended_at
	          FROM call_logs cl
	          LEFT JOIN users u1 ON cl.caller_id = u1.id
	          LEFT JOIN users u2 ON cl.receiver_id = u2.id
	          WHERE cl.caller_id = ? OR cl.receiver_id = ?
	          ORDER BY cl.created_at DESC LIMIT 50`
	if s.driverName == "postgres" {
		query = `SELECT cl.id, cl.conversation_id, cl.caller_id, u1.display_name, cl.receiver_id, u2.display_name, cl.call_type, cl.status, cl.duration_seconds, cl.created_at, cl.ended_at
		          FROM call_logs cl
		          LEFT JOIN users u1 ON cl.caller_id = u1.id
		          LEFT JOIN users u2 ON cl.receiver_id = u2.id
		          WHERE cl.caller_id = $1 OR cl.receiver_id = $2
		          ORDER BY cl.created_at DESC LIMIT 50`
	}
	rows, err := s.db.QueryContext(ctx, query, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []*models.CallLog
	for rows.Next() {
		var cl models.CallLog
		var cName, rName sql.NullString
		if err := rows.Scan(&cl.ID, &cl.ConversationID, &cl.CallerID, &cName, &cl.ReceiverID, &rName, &cl.CallType, &cl.Status, &cl.DurationSeconds, &cl.CreatedAt, &cl.EndedAt); err != nil {
			return nil, err
		}
		if cName.Valid {
			cl.CallerName = cName.String
		}
		if rName.Valid {
			cl.ReceiverName = rName.String
		}
		logs = append(logs, &cl)
	}
	if logs == nil {
		logs = []*models.CallLog{}
	}
	return logs, rows.Err()
}

// ---------------------------------------------------------------------
// Phase 9: Security Modes, Deletion, Avatars, Voice Chat, Stickers
// ---------------------------------------------------------------------

func (s *SQLStore) SetConversationSecurityMode(ctx context.Context, conversationID string, mode string) error {
	now := time.Now().UTC()
	query := `UPDATE conversations SET security_mode = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE conversations SET security_mode = $1, updated_at = $2 WHERE id = $3`
	}
	_, err := s.db.ExecContext(ctx, query, mode, now, conversationID)
	return err
}

func (s *SQLStore) DeleteMessageForMe(ctx context.Context, userID, messageID string) error {
	now := time.Now().UTC()
	query := `INSERT OR IGNORE INTO user_message_deletions (user_id, message_id, created_at) VALUES (?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO user_message_deletions (user_id, message_id, created_at) VALUES ($1, $2, $3) ON CONFLICT (user_id, message_id) DO NOTHING`
	}
	_, err := s.db.ExecContext(ctx, query, userID, messageID, now)
	return err
}

func (s *SQLStore) DeleteMessageForEveryone(ctx context.Context, conversationID, messageID, authorID string) error {
	msg, err := s.GetMessageByID(ctx, messageID)
	if err != nil {
		return err
	}
	if msg.ConversationID != conversationID {
		return ErrUnauthorized
	}
	if msg.SenderID != authorID {
		role, _ := s.GetMemberRole(ctx, conversationID, authorID)
		if role != "owner" && role != "admin" {
			return ErrUnauthorized
		}
	}
	return s.DeleteMessage(ctx, messageID)
}

func (s *SQLStore) ClearConversationForMe(ctx context.Context, userID, conversationID string) error {
	now := time.Now().UTC()
	query := `INSERT INTO user_conversation_clears (user_id, conversation_id, cleared_at) VALUES (?, ?, ?)
	          ON CONFLICT(user_id, conversation_id) DO UPDATE SET cleared_at = excluded.cleared_at`
	if s.driverName == "postgres" {
		query = `INSERT INTO user_conversation_clears (user_id, conversation_id, cleared_at) VALUES ($1, $2, $3)
		          ON CONFLICT(user_id, conversation_id) DO UPDATE SET cleared_at = EXCLUDED.cleared_at`
	}
	_, err := s.db.ExecContext(ctx, query, userID, conversationID, now)
	return err
}

func (s *SQLStore) DeleteConversationForBoth(ctx context.Context, conversationID string, userID string) error {
	conv, err := s.GetConversationByID(ctx, conversationID)
	if err != nil {
		return err
	}
	isMem, err := s.IsMember(ctx, conversationID, userID)
	if err != nil || !isMem {
		return ErrUnauthorized
	}
	if conv.Type != "direct" {
		role, _ := s.GetMemberRole(ctx, conversationID, userID)
		if role != "owner" && role != "admin" {
			return ErrUnauthorized
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	queries := []string{
		`DELETE FROM conversation_members WHERE conversation_id = ?`,
		`DELETE FROM messages WHERE conversation_id = ?`,
		`DELETE FROM user_conversation_clears WHERE conversation_id = ?`,
		`DELETE FROM conversations WHERE id = ?`,
	}
	if s.driverName == "postgres" {
		queries = []string{
			`DELETE FROM conversation_members WHERE conversation_id = $1`,
			`DELETE FROM messages WHERE conversation_id = $1`,
			`DELETE FROM user_conversation_clears WHERE conversation_id = $1`,
			`DELETE FROM conversations WHERE id = $1`,
		}
	}

	for _, q := range queries {
		if _, err := tx.ExecContext(ctx, q, conversationID); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *SQLStore) UpdateUserAvatar(ctx context.Context, userID, avatarURL string) error {
	now := time.Now().UTC()
	query := `UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE users SET avatar_url = $1, updated_at = $2 WHERE id = $3`
	}
	_, err := s.db.ExecContext(ctx, query, avatarURL, now, userID)
	return err
}

func (s *SQLStore) GetUserPreferences(ctx context.Context, userID string) (string, error) {
	query := `SELECT preferences FROM user_preferences WHERE user_id = ?`
	if s.driverName == "postgres" {
		query = `SELECT preferences FROM user_preferences WHERE user_id = $1`
	}
	var prefs string
	err := s.db.QueryRowContext(ctx, query, userID).Scan(&prefs)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "{}", nil
		}
		return "", err
	}
	return prefs, nil
}

func (s *SQLStore) SetUserPreferences(ctx context.Context, userID, preferencesJSON string) error {
	var query string
	if s.driverName == "postgres" {
		query = `
		INSERT INTO user_preferences (user_id, preferences, updated_at)
		VALUES ($1, $2, CURRENT_TIMESTAMP)
		ON CONFLICT (user_id) DO UPDATE SET
			preferences = EXCLUDED.preferences,
			updated_at = CURRENT_TIMESTAMP`
	} else {
		query = `
		INSERT INTO user_preferences (user_id, preferences, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT (user_id) DO UPDATE SET
			preferences = excluded.preferences,
			updated_at = CURRENT_TIMESTAMP`
	}
	_, err := s.db.ExecContext(ctx, query, userID, preferencesJSON)
	return err
}

func (s *SQLStore) CreateUserStickerPack(ctx context.Context, pack *models.StickerPack, stickers []*models.Sticker) error {
	if pack.ID == "" {
		pack.ID = "pack_user_" + uuid.New().String()
	}
	if pack.ShareCode == "" {
		pack.ShareCode = "stk_" + strings.ReplaceAll(uuid.New().String()[:8], "-", "")
	}
	now := time.Now().UTC()
	pack.CreatedAt = now
	pack.StickerCount = len(stickers)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	packQuery := `INSERT INTO sticker_packs (id, name, title, thumbnail_url, author, creator_id, share_code, sticker_count, is_builtin, created_at)
	              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		packQuery = `INSERT INTO sticker_packs (id, name, title, thumbnail_url, author, creator_id, share_code, sticker_count, is_builtin, created_at)
		              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`
	}
	if _, err := tx.ExecContext(ctx, packQuery, pack.ID, pack.Name, pack.Title, pack.ThumbnailURL, pack.Author, pack.CreatorID, pack.ShareCode, pack.StickerCount, pack.IsBuiltin, pack.CreatedAt); err != nil {
		return err
	}

	stQuery := `INSERT INTO stickers (id, pack_id, emoji, asset_url, width, height) VALUES (?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		stQuery = `INSERT INTO stickers (id, pack_id, emoji, asset_url, width, height) VALUES ($1, $2, $3, $4, $5, $6)`
	}
	for i, st := range stickers {
		if st.ID == "" {
			st.ID = fmt.Sprintf("%s_stk_%d", pack.ID, i+1)
		}
		st.PackID = pack.ID
		if st.Width == 0 {
			st.Width = 256
		}
		if st.Height == 0 {
			st.Height = 256
		}
		if _, err := tx.ExecContext(ctx, stQuery, st.ID, st.PackID, st.Emoji, st.AssetURL, st.Width, st.Height); err != nil {
			return err
		}
	}

	// Auto-install for creator
	if pack.CreatorID != "" {
		instQuery := `INSERT OR IGNORE INTO user_installed_stickers (user_id, pack_id, installed_at) VALUES (?, ?, ?)`
		if s.driverName == "postgres" {
			instQuery = `INSERT INTO user_installed_stickers (user_id, pack_id, installed_at) VALUES ($1, $2, $3) ON CONFLICT (user_id, pack_id) DO NOTHING`
		}
		_, _ = tx.ExecContext(ctx, instQuery, pack.CreatorID, pack.ID, now)
	}

	return tx.Commit()
}

func (s *SQLStore) GetStickerPackByShareCode(ctx context.Context, shareCode string) (*models.StickerPack, error) {
	query := `SELECT id, name, title, thumbnail_url, author, COALESCE(creator_id, ''), COALESCE(share_code, ''), sticker_count, created_at FROM sticker_packs WHERE share_code = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, name, title, thumbnail_url, author, COALESCE(creator_id, ''), COALESCE(share_code, ''), sticker_count, created_at FROM sticker_packs WHERE share_code = $1`
	}
	var p models.StickerPack
	row := s.db.QueryRowContext(ctx, query, shareCode)
	if err := row.Scan(&p.ID, &p.Name, &p.Title, &p.ThumbnailURL, &p.Author, &p.CreatorID, &p.ShareCode, &p.StickerCount, &p.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	p.IsBuiltin = strings.HasPrefix(p.ID, "pack_builtin_") || strings.HasPrefix(p.ID, "pack_nexa_") || strings.HasPrefix(p.ID, "pack_crypto_")
	stks, err := s.GetStickersForPack(ctx, p.ID)
	if err == nil {
		p.Stickers = stks
	}
	return &p, nil
}

func (s *SQLStore) CreateVoiceChatRoom(ctx context.Context, room *models.VoiceChatRoom) error {
	if room.ID == "" {
		room.ID = "vc_" + uuid.New().String()
	}
	if room.CreatedAt.IsZero() {
		room.CreatedAt = time.Now().UTC()
	}
	room.IsActive = true

	// Return active room if one already exists
	existing, err := s.GetActiveVoiceChatRoom(ctx, room.ConversationID)
	if err == nil && existing != nil {
		*room = *existing
		return nil
	}

	query := `INSERT INTO voice_chat_rooms (id, conversation_id, title, is_active, created_by, created_at)
	          VALUES (?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO voice_chat_rooms (id, conversation_id, title, is_active, created_by, created_at)
		          VALUES ($1, $2, $3, $4, $5, $6)`
	}
	activeVal := 1
	if s.driverName == "postgres" {
		_, err = s.db.ExecContext(ctx, query, room.ID, room.ConversationID, room.Title, true, room.CreatedBy, room.CreatedAt)
	} else {
		_, err = s.db.ExecContext(ctx, query, room.ID, room.ConversationID, room.Title, activeVal, room.CreatedBy, room.CreatedAt)
	}
	return err
}

func (s *SQLStore) GetActiveVoiceChatRoom(ctx context.Context, conversationID string) (*models.VoiceChatRoom, error) {
	query := `SELECT id, conversation_id, title, is_active, created_by, created_at, ended_at
	          FROM voice_chat_rooms
	          WHERE conversation_id = ? AND is_active = 1
	          ORDER BY created_at DESC LIMIT 1`
	if s.driverName == "postgres" {
		query = `SELECT id, conversation_id, title, is_active, created_by, created_at, ended_at
		          FROM voice_chat_rooms
		          WHERE conversation_id = $1 AND is_active = TRUE
		          ORDER BY created_at DESC LIMIT 1`
	}
	var r models.VoiceChatRoom
	var endedAt sql.NullTime
	row := s.db.QueryRowContext(ctx, query, conversationID)
	var err error
	if s.driverName == "postgres" {
		var isActive bool
		err = row.Scan(&r.ID, &r.ConversationID, &r.Title, &isActive, &r.CreatedBy, &r.CreatedAt, &endedAt)
		r.IsActive = isActive
	} else {
		var isActiveInt int
		err = row.Scan(&r.ID, &r.ConversationID, &r.Title, &isActiveInt, &r.CreatedBy, &r.CreatedAt, &endedAt)
		r.IsActive = (isActiveInt == 1)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if endedAt.Valid {
		r.EndedAt = &endedAt.Time
	}

	countQuery := `SELECT COUNT(*) FROM voice_chat_participants WHERE room_id = ? AND left_at IS NULL`
	if s.driverName == "postgres" {
		countQuery = `SELECT COUNT(*) FROM voice_chat_participants WHERE room_id = $1 AND left_at IS NULL`
	}
	_ = s.db.QueryRowContext(ctx, countQuery, r.ID).Scan(&r.ParticipantCount)

	return &r, nil
}

func (s *SQLStore) JoinVoiceChat(ctx context.Context, p *models.VoiceChatParticipant) error {
	now := time.Now().UTC()
	p.JoinedAt = now

	query := `INSERT INTO voice_chat_participants (room_id, user_id, is_muted, is_speaking, joined_at, left_at)
	          VALUES (?, ?, ?, ?, ?, NULL)
	          ON CONFLICT(room_id, user_id) DO UPDATE SET is_muted = excluded.is_muted, is_speaking = excluded.is_speaking, joined_at = excluded.joined_at, left_at = NULL`
	if s.driverName == "postgres" {
		query = `INSERT INTO voice_chat_participants (room_id, user_id, is_muted, is_speaking, joined_at, left_at)
		          VALUES ($1, $2, $3, $4, $5, NULL)
		          ON CONFLICT(room_id, user_id) DO UPDATE SET is_muted = EXCLUDED.is_muted, is_speaking = EXCLUDED.is_speaking, joined_at = EXCLUDED.joined_at, left_at = NULL`
	}
	mutedVal := 0
	if p.IsMuted {
		mutedVal = 1
	}
	speakingVal := 0
	if p.IsSpeaking {
		speakingVal = 1
	}
	if s.driverName == "postgres" {
		_, err := s.db.ExecContext(ctx, query, p.RoomID, p.UserID, p.IsMuted, p.IsSpeaking, p.JoinedAt)
		return err
	}
	_, err := s.db.ExecContext(ctx, query, p.RoomID, p.UserID, mutedVal, speakingVal, p.JoinedAt)
	return err
}

func (s *SQLStore) LeaveVoiceChat(ctx context.Context, roomID, userID string) error {
	now := time.Now().UTC()
	query := `UPDATE voice_chat_participants SET left_at = ? WHERE room_id = ? AND user_id = ? AND left_at IS NULL`
	if s.driverName == "postgres" {
		query = `UPDATE voice_chat_participants SET left_at = $1 WHERE room_id = $2 AND user_id = $3 AND left_at IS NULL`
	}
	_, err := s.db.ExecContext(ctx, query, now, roomID, userID)
	return err
}

func (s *SQLStore) UpdateVoiceChatParticipant(ctx context.Context, roomID, userID string, isMuted, isSpeaking bool) error {
	query := `UPDATE voice_chat_participants SET is_muted = ?, is_speaking = ? WHERE room_id = ? AND user_id = ? AND left_at IS NULL`
	if s.driverName == "postgres" {
		query = `UPDATE voice_chat_participants SET is_muted = $1, is_speaking = $2 WHERE room_id = $3 AND user_id = $4 AND left_at IS NULL`
	}
	mutedVal := 0
	if isMuted {
		mutedVal = 1
	}
	speakingVal := 0
	if isSpeaking {
		speakingVal = 1
	}
	if s.driverName == "postgres" {
		_, err := s.db.ExecContext(ctx, query, isMuted, isSpeaking, roomID, userID)
		return err
	}
	_, err := s.db.ExecContext(ctx, query, mutedVal, speakingVal, roomID, userID)
	return err
}

func (s *SQLStore) GetVoiceChatParticipants(ctx context.Context, roomID string) ([]*models.VoiceChatParticipant, error) {
	query := `SELECT vcp.room_id, vcp.user_id, u.username, u.display_name, COALESCE(u.avatar_url, ''), vcp.is_muted, vcp.is_speaking, vcp.joined_at
	          FROM voice_chat_participants vcp
	          JOIN users u ON vcp.user_id = u.id
	          WHERE vcp.room_id = ? AND vcp.left_at IS NULL
	          ORDER BY vcp.joined_at ASC`
	if s.driverName == "postgres" {
		query = `SELECT vcp.room_id, vcp.user_id, u.username, u.display_name, COALESCE(u.avatar_url, ''), vcp.is_muted, vcp.is_speaking, vcp.joined_at
		          FROM voice_chat_participants vcp
		          JOIN users u ON vcp.user_id = u.id
		          WHERE vcp.room_id = $1 AND vcp.left_at IS NULL
		          ORDER BY vcp.joined_at ASC`
	}
	rows, err := s.db.QueryContext(ctx, query, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var parts []*models.VoiceChatParticipant
	for rows.Next() {
		var p models.VoiceChatParticipant
		if s.driverName == "postgres" {
			var muted, speaking bool
			if err := rows.Scan(&p.RoomID, &p.UserID, &p.Username, &p.DisplayName, &p.AvatarURL, &muted, &speaking, &p.JoinedAt); err != nil {
				return nil, err
			}
			p.IsMuted = muted
			p.IsSpeaking = speaking
		} else {
			var mutedInt, speakingInt int
			if err := rows.Scan(&p.RoomID, &p.UserID, &p.Username, &p.DisplayName, &p.AvatarURL, &mutedInt, &speakingInt, &p.JoinedAt); err != nil {
				return nil, err
			}
			p.IsMuted = (mutedInt == 1)
			p.IsSpeaking = (speakingInt == 1)
		}
		parts = append(parts, &p)
	}
	if parts == nil {
		parts = []*models.VoiceChatParticipant{}
	}
	return parts, rows.Err()
}

func (s *SQLStore) EndVoiceChatRoom(ctx context.Context, roomID string) error {
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	rQuery := `UPDATE voice_chat_rooms SET is_active = 0, ended_at = ? WHERE id = ?`
	pQuery := `UPDATE voice_chat_participants SET left_at = ? WHERE room_id = ? AND left_at IS NULL`
	if s.driverName == "postgres" {
		rQuery = `UPDATE voice_chat_rooms SET is_active = FALSE, ended_at = $1 WHERE id = $2`
		pQuery = `UPDATE voice_chat_participants SET left_at = $1 WHERE room_id = $2 AND left_at IS NULL`
	}
	if _, err := tx.ExecContext(ctx, rQuery, now, roomID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, pQuery, now, roomID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLStore) CreatePoll(ctx context.Context, p *models.Poll, options []string) (*models.Poll, error) {
	if p.ID == "" {
		p.ID = uuid.New().String()
	}
	p.CreatedAt = time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	pollQuery := `INSERT INTO polls (id, conversation_id, creator_id, question, is_anonymous, allows_multiple, is_quiz, correct_option, explanation, is_closed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	optQuery := `INSERT INTO poll_options (id, poll_id, text, vote_count) VALUES (?, ?, ?, 0)`
	if s.driverName == "postgres" {
		pollQuery = `INSERT INTO polls (id, conversation_id, creator_id, question, is_anonymous, allows_multiple, is_quiz, correct_option, explanation, is_closed, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`
		optQuery = `INSERT INTO poll_options (id, poll_id, text, vote_count) VALUES ($1, $2, $3, 0)`
	}

	var isAnon, allowsMult, isQuiz, isClosed interface{}
	if s.driverName == "sqlite" {
		isAnon = 0
		if p.IsAnonymous {
			isAnon = 1
		}
		allowsMult = 0
		if p.AllowsMultiple {
			allowsMult = 1
		}
		isQuiz = 0
		if p.IsQuiz {
			isQuiz = 1
		}
		isClosed = 0
		if p.IsClosed {
			isClosed = 1
		}
	} else {
		isAnon = p.IsAnonymous
		allowsMult = p.AllowsMultiple
		isQuiz = p.IsQuiz
		isClosed = p.IsClosed
	}

	if _, err := tx.ExecContext(ctx, pollQuery, p.ID, p.ConversationID, p.CreatorID, p.Question, isAnon, allowsMult, isQuiz, p.CorrectOption, p.Explanation, isClosed, p.CreatedAt); err != nil {
		return nil, err
	}

	p.Options = make([]*models.PollOption, 0, len(options))
	for i, optText := range options {
		if _, err := tx.ExecContext(ctx, optQuery, i, p.ID, optText); err != nil {
			return nil, err
		}
		p.Options = append(p.Options, &models.PollOption{
			ID:        i,
			PollID:    p.ID,
			Text:      optText,
			VoteCount: 0,
		})
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return p, nil
}

func (s *SQLStore) GetPoll(ctx context.Context, pollID string, userID string) (*models.Poll, error) {
	query := `SELECT id, conversation_id, creator_id, question, is_anonymous, allows_multiple, is_quiz, correct_option, explanation, is_closed, created_at FROM polls WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, conversation_id, creator_id, question, is_anonymous, allows_multiple, is_quiz, correct_option, explanation, is_closed, created_at FROM polls WHERE id = $1`
	}

	var p models.Poll
	if s.driverName == "postgres" {
		if err := s.db.QueryRowContext(ctx, query, pollID).Scan(
			&p.ID, &p.ConversationID, &p.CreatorID, &p.Question, &p.IsAnonymous,
			&p.AllowsMultiple, &p.IsQuiz, &p.CorrectOption, &p.Explanation, &p.IsClosed, &p.CreatedAt,
		); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, err
		}
	} else {
		var isAnon, allowsMult, isQuiz, isClosed int
		if err := s.db.QueryRowContext(ctx, query, pollID).Scan(
			&p.ID, &p.ConversationID, &p.CreatorID, &p.Question, &isAnon,
			&allowsMult, &isQuiz, &p.CorrectOption, &p.Explanation, &isClosed, &p.CreatedAt,
		); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, err
		}
		p.IsAnonymous = (isAnon == 1)
		p.AllowsMultiple = (allowsMult == 1)
		p.IsQuiz = (isQuiz == 1)
		p.IsClosed = (isClosed == 1)
	}

	optQuery := `SELECT id, poll_id, text, vote_count FROM poll_options WHERE poll_id = ? ORDER BY id ASC`
	if s.driverName == "postgres" {
		optQuery = `SELECT id, poll_id, text, vote_count FROM poll_options WHERE poll_id = $1 ORDER BY id ASC`
	}
	rows, err := s.db.QueryContext(ctx, optQuery, pollID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	totalVotes := 0
	p.Options = []*models.PollOption{}
	for rows.Next() {
		var opt models.PollOption
		if err := rows.Scan(&opt.ID, &opt.PollID, &opt.Text, &opt.VoteCount); err != nil {
			return nil, err
		}
		totalVotes += opt.VoteCount
		p.Options = append(p.Options, &opt)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	p.TotalVotes = totalVotes

	if userID != "" {
		voteQuery := `SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?`
		if s.driverName == "postgres" {
			voteQuery = `SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2`
		}
		vRows, err := s.db.QueryContext(ctx, voteQuery, pollID, userID)
		if err == nil {
			for vRows.Next() {
				var optID int
				if err := vRows.Scan(&optID); err == nil {
					p.MyVotes = append(p.MyVotes, optID)
				}
			}
			if vErr := vRows.Err(); vErr != nil {
				vRows.Close()
				return nil, vErr
			}
			vRows.Close()
		}
	}

	return &p, nil
}

func (s *SQLStore) VotePoll(ctx context.Context, pollID string, userID string, optionID int) (*models.Poll, error) {
	p, err := s.GetPoll(ctx, pollID, userID)
	if err != nil {
		return nil, err
	}
	if p.IsClosed {
		return nil, errors.New("poll is closed")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	checkQuery := `SELECT COUNT(*) FROM poll_votes WHERE poll_id = ? AND option_id = ? AND user_id = ?`
	if s.driverName == "postgres" {
		checkQuery = `SELECT COUNT(*) FROM poll_votes WHERE poll_id = $1 AND option_id = $2 AND user_id = $3`
	}
	var count int
	if err := tx.QueryRowContext(ctx, checkQuery, pollID, optionID, userID).Scan(&count); err != nil {
		return nil, err
	}

	if count > 0 {
		delQuery := `DELETE FROM poll_votes WHERE poll_id = ? AND option_id = ? AND user_id = ?`
		decQuery := `UPDATE poll_options SET vote_count = MAX(0, vote_count - 1) WHERE poll_id = ? AND id = ?`
		if s.driverName == "postgres" {
			delQuery = `DELETE FROM poll_votes WHERE poll_id = $1 AND option_id = $2 AND user_id = $3`
			decQuery = `UPDATE poll_options SET vote_count = GREATEST(0, vote_count - 1) WHERE poll_id = $1 AND id = $2`
		}
		if _, err := tx.ExecContext(ctx, delQuery, pollID, optionID, userID); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, decQuery, pollID, optionID); err != nil {
			return nil, err
		}
	} else {
		if !p.AllowsMultiple {
			selVotesQuery := `SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?`
			delAllQuery := `DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?`
			decQuery := `UPDATE poll_options SET vote_count = MAX(0, vote_count - 1) WHERE poll_id = ? AND id = ?`
			if s.driverName == "postgres" {
				selVotesQuery = `SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2`
				delAllQuery = `DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2`
				decQuery = `UPDATE poll_options SET vote_count = GREATEST(0, vote_count - 1) WHERE poll_id = $1 AND id = $2`
			}
			rows, err := tx.QueryContext(ctx, selVotesQuery, pollID, userID)
			if err == nil {
				existingOpts := []int{}
				for rows.Next() {
					var oID int
					if err := rows.Scan(&oID); err == nil {
						existingOpts = append(existingOpts, oID)
					}
				}
				if rErr := rows.Err(); rErr != nil {
					rows.Close()
					return nil, rErr
				}
				rows.Close()
				for _, oID := range existingOpts {
					_, _ = tx.ExecContext(ctx, decQuery, pollID, oID)
				}
			}
			_, _ = tx.ExecContext(ctx, delAllQuery, pollID, userID)
		}

		insQuery := `INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?)`
		incQuery := `UPDATE poll_options SET vote_count = vote_count + 1 WHERE poll_id = ? AND id = ?`
		if s.driverName == "postgres" {
			insQuery = `INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES ($1, $2, $3, $4)`
			incQuery = `UPDATE poll_options SET vote_count = vote_count + 1 WHERE poll_id = $1 AND id = $2`
		}
		if _, err := tx.ExecContext(ctx, insQuery, pollID, optionID, userID, time.Now().UTC()); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, incQuery, pollID, optionID); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetPoll(ctx, pollID, userID)
}

func (s *SQLStore) ClosePoll(ctx context.Context, pollID string, userID string) (*models.Poll, error) {
	p, err := s.GetPoll(ctx, pollID, userID)
	if err != nil {
		return nil, err
	}
	if p.CreatorID != userID {
		role, _ := s.GetMemberRole(ctx, p.ConversationID, userID)
		if role != "owner" && role != "admin" {
			return nil, ErrUnauthorized
		}
	}

	query := `UPDATE polls SET is_closed = 1 WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE polls SET is_closed = TRUE WHERE id = $1`
	}
	if _, err := s.db.ExecContext(ctx, query, pollID); err != nil {
		return nil, err
	}
	p.IsClosed = true
	return p, nil
}

func (s *SQLStore) CreateStory(ctx context.Context, st *models.Story) error {
	if st.ID == "" {
		st.ID = uuid.New().String()
	}
	st.CreatedAt = time.Now().UTC()
	if st.ExpiresAt.IsZero() {
		st.ExpiresAt = st.CreatedAt.Add(24 * time.Hour)
	}

	query := `INSERT INTO stories (id, user_id, media_url, media_type, caption, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO stories (id, user_id, media_url, media_type, caption, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`
	}
	_, err := s.db.ExecContext(ctx, query, st.ID, st.UserID, st.MediaURL, st.MediaType, st.Caption, st.CreatedAt, st.ExpiresAt)
	return err
}

func (s *SQLStore) GetActiveStories(ctx context.Context, currentUserID string) ([]*models.Story, error) {
	now := time.Now().UTC()
	query := `SELECT s.id, s.user_id, u.username, u.display_name, u.avatar_url, s.media_url, s.media_type, s.caption, s.created_at, s.expires_at FROM stories s JOIN users u ON s.user_id = u.id WHERE s.expires_at > ? ORDER BY s.created_at DESC`
	if s.driverName == "postgres" {
		query = `SELECT s.id, s.user_id, u.username, u.display_name, u.avatar_url, s.media_url, s.media_type, s.caption, s.created_at, s.expires_at FROM stories s JOIN users u ON s.user_id = u.id WHERE s.expires_at > $1 ORDER BY s.created_at DESC`
	}

	rows, err := s.db.QueryContext(ctx, query, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stories := []*models.Story{}
	for rows.Next() {
		var st models.Story
		if err := rows.Scan(&st.ID, &st.UserID, &st.Username, &st.DisplayName, &st.AvatarURL, &st.MediaURL, &st.MediaType, &st.Caption, &st.CreatedAt, &st.ExpiresAt); err != nil {
			return nil, err
		}
		stories = append(stories, &st)
	}
	return stories, rows.Err()
}

func (s *SQLStore) DeleteStory(ctx context.Context, storyID, userID string) error {
	query := `DELETE FROM stories WHERE id = ? AND user_id = ?`
	if s.driverName == "postgres" {
		query = `DELETE FROM stories WHERE id = $1 AND user_id = $2`
	}
	res, err := s.db.ExecContext(ctx, query, storyID, userID)
	if err != nil {
		return err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLStore) CreateScheduledMessage(ctx context.Context, sm *models.ScheduledMessage) error {
	if sm.ID == "" {
		sm.ID = uuid.New().String()
	}
	sm.CreatedAt = time.Now().UTC()
	query := `INSERT INTO scheduled_messages (id, conversation_id, sender_id, ciphertext, nonce, scheduled_for, is_sent, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO scheduled_messages (id, conversation_id, sender_id, ciphertext, nonce, scheduled_for, is_sent, created_at) VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)`
	}
	_, err := s.db.ExecContext(ctx, query, sm.ID, sm.ConversationID, sm.SenderID, sm.Ciphertext, sm.Nonce, sm.ScheduledFor, sm.CreatedAt)
	return err
}

func (s *SQLStore) GetScheduledMessages(ctx context.Context, conversationID, senderID string) ([]*models.ScheduledMessage, error) {
	query := `SELECT id, conversation_id, sender_id, ciphertext, nonce, scheduled_for, created_at FROM scheduled_messages WHERE conversation_id = ? AND sender_id = ? AND is_sent = 0 ORDER BY scheduled_for ASC`
	if s.driverName == "postgres" {
		query = `SELECT id, conversation_id, sender_id, ciphertext, nonce, scheduled_for, created_at FROM scheduled_messages WHERE conversation_id = $1 AND sender_id = $2 AND is_sent = FALSE ORDER BY scheduled_for ASC`
	}
	rows, err := s.db.QueryContext(ctx, query, conversationID, senderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := []*models.ScheduledMessage{}
	for rows.Next() {
		var sm models.ScheduledMessage
		sm.IsSent = false
		if err := rows.Scan(&sm.ID, &sm.ConversationID, &sm.SenderID, &sm.Ciphertext, &sm.Nonce, &sm.ScheduledFor, &sm.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, &sm)
	}
	return list, rows.Err()
}

func (s *SQLStore) DeleteScheduledMessage(ctx context.Context, id, senderID string) error {
	query := `DELETE FROM scheduled_messages WHERE id = ? AND sender_id = ?`
	if s.driverName == "postgres" {
		query = `DELETE FROM scheduled_messages WHERE id = $1 AND sender_id = $2`
	}
	res, err := s.db.ExecContext(ctx, query, id, senderID)
	if err != nil {
		return err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------------
// Phase 16: Member Role Management
// ---------------------------------------------------------------------

func (s *SQLStore) UpdateMemberRole(ctx context.Context, conversationID, targetUserID, newRole string) error {
	if newRole != "admin" && newRole != "member" {
		return errors.New("invalid role; must be 'admin' or 'member'")
	}
	currentRole, err := s.GetMemberRole(ctx, conversationID, targetUserID)
	if err != nil {
		return err
	}
	if currentRole == "owner" {
		return errors.New("cannot change the role of the conversation owner")
	}

	query := `UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ? AND role != 'owner'`
	if s.driverName == "postgres" {
		query = `UPDATE conversation_members SET role = $1 WHERE conversation_id = $2 AND user_id = $3 AND role != 'owner'`
	}
	res, err := s.db.ExecContext(ctx, query, newRole, conversationID, targetUserID)
	if err != nil {
		return err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------------
// Phase 16: Read Receipts & Unread Tracking
// ---------------------------------------------------------------------

func (s *SQLStore) RecordMessageRead(ctx context.Context, messageID, userID, conversationID string) error {
	now := time.Now().UTC()
	query := `INSERT OR IGNORE INTO message_reads (message_id, user_id, conversation_id, read_at) VALUES (?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO message_reads (message_id, user_id, conversation_id, read_at) VALUES ($1, $2, $3, $4) ON CONFLICT (message_id, user_id) DO NOTHING`
	}
	_, err := s.db.ExecContext(ctx, query, messageID, userID, conversationID, now)
	return err
}

func (s *SQLStore) MarkConversationRead(ctx context.Context, conversationID, userID, messageID string) error {
	now := time.Now().UTC()
	query := `
		INSERT INTO conversation_read_state (conversation_id, user_id, last_read_message_id, last_read_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(conversation_id, user_id) DO UPDATE SET
			last_read_message_id = excluded.last_read_message_id,
			last_read_at = excluded.last_read_at
	`
	if s.driverName == "postgres" {
		query = `
			INSERT INTO conversation_read_state (conversation_id, user_id, last_read_message_id, last_read_at)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT(conversation_id, user_id) DO UPDATE SET
				last_read_message_id = EXCLUDED.last_read_message_id,
				last_read_at = EXCLUDED.last_read_at
		`
	}
	if _, err := s.db.ExecContext(ctx, query, conversationID, userID, messageID, now); err != nil {
		return err
	}

	// Also insert records into message_reads for incoming messages (never mark own messages) up to messageID
	if messageID != "" {
		insertReadsQuery := `
			INSERT OR IGNORE INTO message_reads (message_id, user_id, conversation_id, read_at)
			SELECT m.id, ?, m.conversation_id, ?
			FROM messages m
			WHERE m.conversation_id = ?
			  AND m.sender_id != ?
			  AND m.created_at <= (SELECT created_at FROM messages WHERE id = ?)
		`
		if s.driverName == "postgres" {
			insertReadsQuery = `
				INSERT INTO message_reads (message_id, user_id, conversation_id, read_at)
				SELECT m.id, $1, m.conversation_id, $2
				FROM messages m
				WHERE m.conversation_id = $3
				  AND m.sender_id != $4
				  AND m.created_at <= (SELECT created_at FROM messages WHERE id = $5)
				ON CONFLICT (message_id, user_id) DO NOTHING
			`
		}
		_, _ = s.db.ExecContext(ctx, insertReadsQuery, userID, now, conversationID, userID, messageID)
	}

	return nil
}

func (s *SQLStore) GetConversationReadState(ctx context.Context, conversationID, userID string) (*models.ConversationReadState, error) {
	query := `SELECT conversation_id, user_id, last_read_message_id, last_read_at FROM conversation_read_state WHERE conversation_id = ? AND user_id = ?`
	if s.driverName == "postgres" {
		query = `SELECT conversation_id, user_id, last_read_message_id, last_read_at FROM conversation_read_state WHERE conversation_id = $1 AND user_id = $2`
	}
	var st models.ConversationReadState
	err := s.db.QueryRowContext(ctx, query, conversationID, userID).Scan(&st.ConversationID, &st.UserID, &st.LastReadMessageID, &st.LastReadAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &st, nil
}

// ---------------------------------------------------------------------
// Phase 16: Conversation Invites
// ---------------------------------------------------------------------

func (s *SQLStore) CreateConversationInvite(ctx context.Context, inv *models.ConversationInvite) error {
	if inv.ID == "" {
		inv.ID = uuid.New().String()
	}
	inv.CreatedAt = time.Now().UTC()
	query := `INSERT INTO conversation_invites (id, conversation_id, creator_id, invite_code, max_uses, uses_count, expires_at, is_revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO conversation_invites (id, conversation_id, creator_id, invite_code, max_uses, uses_count, expires_at, is_revoked, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8)`
	}
	_, err := s.db.ExecContext(ctx, query, inv.ID, inv.ConversationID, inv.CreatorID, inv.InviteCode, inv.MaxUses, inv.UsesCount, inv.ExpiresAt, inv.CreatedAt)
	return err
}

func (s *SQLStore) GetConversationInviteByCode(ctx context.Context, code string) (*models.ConversationInvite, error) {
	query := `SELECT id, conversation_id, creator_id, invite_code, max_uses, uses_count, expires_at, is_revoked, created_at FROM conversation_invites WHERE invite_code = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, conversation_id, creator_id, invite_code, max_uses, uses_count, expires_at, is_revoked, created_at FROM conversation_invites WHERE invite_code = $1`
	}
	var inv models.ConversationInvite
	var isRevokedInt int
	var isRevokedBool bool
	var err error
	if s.driverName == "postgres" {
		err = s.db.QueryRowContext(ctx, query, code).Scan(&inv.ID, &inv.ConversationID, &inv.CreatorID, &inv.InviteCode, &inv.MaxUses, &inv.UsesCount, &inv.ExpiresAt, &isRevokedBool, &inv.CreatedAt)
		inv.IsRevoked = isRevokedBool
	} else {
		err = s.db.QueryRowContext(ctx, query, code).Scan(&inv.ID, &inv.ConversationID, &inv.CreatorID, &inv.InviteCode, &inv.MaxUses, &inv.UsesCount, &inv.ExpiresAt, &isRevokedInt, &inv.CreatedAt)
		inv.IsRevoked = isRevokedInt != 0
	}
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &inv, nil
}

func (s *SQLStore) ListConversationInvites(ctx context.Context, conversationID string) ([]*models.ConversationInvite, error) {
	query := `SELECT id, conversation_id, creator_id, invite_code, max_uses, uses_count, expires_at, is_revoked, created_at FROM conversation_invites WHERE conversation_id = ? AND is_revoked = 0 ORDER BY created_at DESC`
	if s.driverName == "postgres" {
		query = `SELECT id, conversation_id, creator_id, invite_code, max_uses, uses_count, expires_at, is_revoked, created_at FROM conversation_invites WHERE conversation_id = $1 AND is_revoked = FALSE ORDER BY created_at DESC`
	}
	rows, err := s.db.QueryContext(ctx, query, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*models.ConversationInvite
	for rows.Next() {
		var inv models.ConversationInvite
		var isRevokedInt int
		var isRevokedBool bool
		if s.driverName == "postgres" {
			if err := rows.Scan(&inv.ID, &inv.ConversationID, &inv.CreatorID, &inv.InviteCode, &inv.MaxUses, &inv.UsesCount, &inv.ExpiresAt, &isRevokedBool, &inv.CreatedAt); err != nil {
				return nil, err
			}
			inv.IsRevoked = isRevokedBool
		} else {
			if err := rows.Scan(&inv.ID, &inv.ConversationID, &inv.CreatorID, &inv.InviteCode, &inv.MaxUses, &inv.UsesCount, &inv.ExpiresAt, &isRevokedInt, &inv.CreatedAt); err != nil {
				return nil, err
			}
			inv.IsRevoked = isRevokedInt != 0
		}
		list = append(list, &inv)
	}
	return list, rows.Err()
}

func (s *SQLStore) RevokeConversationInvite(ctx context.Context, conversationID, code string) error {
	query := `UPDATE conversation_invites SET is_revoked = 1 WHERE conversation_id = ? AND invite_code = ?`
	if s.driverName == "postgres" {
		query = `UPDATE conversation_invites SET is_revoked = TRUE WHERE conversation_id = $1 AND invite_code = $2`
	}
	res, err := s.db.ExecContext(ctx, query, conversationID, code)
	if err != nil {
		return err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLStore) UseConversationInvite(ctx context.Context, code, userID string) (*models.Conversation, error) {
	inv, err := s.GetConversationInviteByCode(ctx, code)
	if err != nil {
		return nil, errors.New("invite link is invalid or expired")
	}
	if inv.IsRevoked {
		return nil, errors.New("invite link has been revoked")
	}
	if inv.ExpiresAt != nil && inv.ExpiresAt.Before(time.Now().UTC()) {
		return nil, errors.New("invite link has expired")
	}
	if inv.MaxUses > 0 && inv.UsesCount >= inv.MaxUses {
		return nil, errors.New("invite link has reached its maximum usage limit")
	}

	// Check if user is already a member
	isMember, _ := s.IsMember(ctx, inv.ConversationID, userID)
	if !isMember {
		// Atomic conditional update on uses_count to eliminate race conditions
		updQuery := `UPDATE conversation_invites SET uses_count = uses_count + 1 WHERE id = ? AND is_revoked = 0 AND (max_uses = 0 OR uses_count < max_uses)`
		if s.driverName == "postgres" {
			updQuery = `UPDATE conversation_invites SET uses_count = uses_count + 1 WHERE id = $1 AND is_revoked = FALSE AND (max_uses = 0 OR uses_count < max_uses)`
		}
		res, err := s.db.ExecContext(ctx, updQuery, inv.ID)
		if err != nil {
			return nil, err
		}
		rows, _ := res.RowsAffected()
		if rows == 0 {
			return nil, errors.New("invite link has reached its maximum usage limit or has been revoked")
		}

		if err := s.AddConversationMember(ctx, inv.ConversationID, userID, "member"); err != nil {
			return nil, err
		}
	}

	return s.GetConversationByID(ctx, inv.ConversationID)
}

// ---------------------------------------------------------------------
// Phase 16: Channel Message Views
// ---------------------------------------------------------------------

func (s *SQLStore) RecordMessageView(ctx context.Context, messageID, userID, conversationID string) (int, error) {
	now := time.Now().UTC()
	query := `INSERT OR IGNORE INTO message_views (message_id, user_id, conversation_id, viewed_at) VALUES (?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO message_views (message_id, user_id, conversation_id, viewed_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`
	}
	_, err := s.db.ExecContext(ctx, query, messageID, userID, conversationID, now)
	if err != nil {
		return 0, err
	}
	return s.GetMessageViewsCount(ctx, messageID)
}

func (s *SQLStore) GetMessageViewsCount(ctx context.Context, messageID string) (int, error) {
	query := `SELECT COUNT(*) FROM message_views WHERE message_id = ?`
	if s.driverName == "postgres" {
		query = `SELECT COUNT(*) FROM message_views WHERE message_id = $1`
	}
	var count int
	err := s.db.QueryRowContext(ctx, query, messageID).Scan(&count)
	return count, err
}

// ---------------------------------------------------------------------
// Phase 16: Disappearing Messages (TTL)
// ---------------------------------------------------------------------

func (s *SQLStore) SetConversationTTL(ctx context.Context, conversationID string, ttlSeconds int) error {
	query := `UPDATE conversations SET disappearing_ttl = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE conversations SET disappearing_ttl = $1 WHERE id = $2`
	}
	_, err := s.db.ExecContext(ctx, query, ttlSeconds, conversationID)
	return err
}

// ---------------------------------------------------------------------
// Phase 16: Global Search
// ---------------------------------------------------------------------

func (s *SQLStore) GlobalSearch(ctx context.Context, userID, query string) (map[string]interface{}, error) {
	trimmed := "%" + strings.TrimSpace(query) + "%"

	// 1. Search public channels
	chQuery := `SELECT id, type, COALESCE(title, ''), COALESCE(description, ''), COALESCE(avatar_url, '') FROM conversations WHERE type = 'channel' AND (title LIKE ? OR description LIKE ?) LIMIT 10`
	if s.driverName == "postgres" {
		chQuery = `SELECT id, type, COALESCE(title, ''), COALESCE(description, ''), COALESCE(avatar_url, '') FROM conversations WHERE type = 'channel' AND (title ILIKE $1 OR description ILIKE $2) LIMIT 10`
	}
	chRows, err := s.db.QueryContext(ctx, chQuery, trimmed, trimmed)
	channels := []map[string]interface{}{}
	if err == nil {
		for chRows.Next() {
			var id, cType, title, desc, avatar string
			if err := chRows.Scan(&id, &cType, &title, &desc, &avatar); err == nil {
				channels = append(channels, map[string]interface{}{
					"id": id, "type": cType, "title": title, "description": desc, "avatar_url": avatar,
				})
			}
		}
		if chErr := chRows.Err(); chErr != nil {
			chRows.Close()
			return nil, chErr
		}
		chRows.Close()
	}

	// 2. Search users
	users, _ := s.SearchUsers(ctx, strings.TrimSpace(query), userID)

	// 3. Search user's active conversations
	convs, _ := s.ListConversationsForUser(ctx, userID)
	matchedConvs := []*models.Conversation{}
	qLower := strings.ToLower(strings.TrimSpace(query))
	for _, c := range convs {
		if strings.Contains(strings.ToLower(c.Title), qLower) || strings.Contains(strings.ToLower(c.Description), qLower) {
			matchedConvs = append(matchedConvs, c)
		}
	}

	return map[string]interface{}{
		"channels":      channels,
		"users":         users,
		"conversations": matchedConvs,
	}, nil
}

// ---------------------------------------------------------------------
// Message Readers Inspection
// ---------------------------------------------------------------------

func (s *SQLStore) GetMessageReaders(ctx context.Context, conversationID, messageID string) ([]*models.MessageReader, error) {
	msg, err := s.GetMessageByID(ctx, messageID)
	if err != nil {
		return nil, err
	}
	if msg.ConversationID != conversationID {
		return nil, errors.New("message does not belong to conversation")
	}

	query := `
		SELECT u.id, u.username, u.display_name, COALESCE(u.avatar_url, ''), mr.read_at
		FROM message_reads mr
		JOIN users u ON mr.user_id = u.id
		WHERE mr.message_id = ?
		  AND u.id != ?
		ORDER BY mr.read_at ASC
	`
	if s.driverName == "postgres" {
		query = `
			SELECT u.id, u.username, u.display_name, COALESCE(u.avatar_url, ''), mr.read_at
			FROM message_reads mr
			JOIN users u ON mr.user_id = u.id
			WHERE mr.message_id = $1
			  AND u.id != $2
			ORDER BY mr.read_at ASC
		`
	}

	rows, err := s.db.QueryContext(ctx, query, messageID, msg.SenderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var readers []*models.MessageReader
	for rows.Next() {
		var r models.MessageReader
		var readAt time.Time
		if err := rows.Scan(&r.UserID, &r.Username, &r.DisplayName, &r.AvatarURL, &readAt); err == nil {
			r.ID = r.UserID
			r.ReadAt = readAt
			readers = append(readers, &r)
		}
	}

	// Fallback for older messages before message_reads existed
	if len(readers) == 0 {
		fbQuery := `
			SELECT u.id, u.username, u.display_name, COALESCE(u.avatar_url, ''), crs.last_read_at
			FROM conversation_read_state crs
			JOIN users u ON crs.user_id = u.id
			JOIN conversation_members cm ON cm.conversation_id = crs.conversation_id AND cm.user_id = u.id
			WHERE crs.conversation_id = ?
			  AND crs.last_read_at >= ?
			  AND u.id != ?
			ORDER BY crs.last_read_at ASC
		`
		if s.driverName == "postgres" {
			fbQuery = `
				SELECT u.id, u.username, u.display_name, COALESCE(u.avatar_url, ''), crs.last_read_at
				FROM conversation_read_state crs
				JOIN users u ON crs.user_id = u.id
				JOIN conversation_members cm ON cm.conversation_id = crs.conversation_id AND cm.user_id = u.id
				WHERE crs.conversation_id = $1
				  AND crs.last_read_at >= $2
				  AND u.id != $3
				ORDER BY crs.last_read_at ASC
			`
		}
		if fbRows, err := s.db.QueryContext(ctx, fbQuery, conversationID, msg.CreatedAt, msg.SenderID); err == nil {
			for fbRows.Next() {
				var r models.MessageReader
				var lastReadAt time.Time
				if err := fbRows.Scan(&r.UserID, &r.Username, &r.DisplayName, &r.AvatarURL, &lastReadAt); err == nil {
					r.ID = r.UserID
					r.ReadAt = lastReadAt
					readers = append(readers, &r)
				}
			}
			if fbErr := fbRows.Err(); fbErr != nil {
				fbRows.Close()
				return nil, fbErr
			}
			fbRows.Close()
		}
	}

	if readers == nil {
		readers = []*models.MessageReader{}
	}
	return readers, rows.Err()
}

// ---------------------------------------------------------------------
// Disappearing Messages Physical Pruning
// ---------------------------------------------------------------------

func (s *SQLStore) PurgeExpiredMessages(ctx context.Context) (int64, error) {
	now := time.Now().UTC()
	query := `DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?`
	if s.driverName == "postgres" {
		query = `DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= $1`
	}
	res, err := s.db.ExecContext(ctx, query, now)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ---------------------------------------------------------------------
// Bot Tokens & Authentication
// ---------------------------------------------------------------------

func (s *SQLStore) CreateBotToken(ctx context.Context, name, scope, createdBy string) (*models.BotToken, string, error) {
	if strings.TrimSpace(name) == "" {
		name = "default-bot"
	}
	if strings.TrimSpace(scope) == "" {
		scope = "messages:send"
	}

	// 1. Generate 32 cryptographically secure random bytes = 256 bits of entropy
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, "", fmt.Errorf("failed to generate random token: %w", err)
	}
	rawToken := "bot_" + hex.EncodeToString(tokenBytes)

	// 2. Hash raw token with SHA-256 for one-way secure storage
	h := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(h[:])

	tokenID := "bt_" + uuid.New().String()
	now := time.Now().UTC()

	query := `INSERT INTO bot_tokens (id, bot_id, token_hash, name, permissions, webhook_url, created_at) VALUES (?, ?, ?, ?, ?, '', ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO bot_tokens (id, bot_id, token_hash, name, permissions, webhook_url, created_at) VALUES ($1, $2, $3, $4, $5, '', $6)`
	}

	_, err := s.db.ExecContext(ctx, query, tokenID, createdBy, tokenHash, name, scope, now)
	if err != nil {
		return nil, "", err
	}

	tokenModel := &models.BotToken{
		ID:        tokenID,
		BotID:     createdBy,
		TokenHash: tokenHash,
		Name:      name,
		Scope:     scope,
		CreatedBy: createdBy,
		IsRevoked: false,
		CreatedAt: now,
	}

	return tokenModel, rawToken, nil
}

func (s *SQLStore) ValidateBotToken(ctx context.Context, rawToken, requiredScope string) (*models.BotToken, error) {
	if strings.TrimSpace(rawToken) == "" {
		return nil, errors.New("empty bot token")
	}

	h := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(h[:])

	query := `SELECT id, bot_id, name, permissions, created_at, revoked_at FROM bot_tokens WHERE token_hash = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, bot_id, name, permissions, created_at, revoked_at FROM bot_tokens WHERE token_hash = $1`
	}

	row := s.db.QueryRowContext(ctx, query, tokenHash)
	var id, botID, name, permissions string
	var createdAt time.Time
	var revokedAt sql.NullTime

	if err := row.Scan(&id, &botID, &name, &permissions, &createdAt, &revokedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errors.New("invalid bot token")
		}
		return nil, err
	}

	if revokedAt.Valid {
		return nil, errors.New("bot token has been revoked")
	}

	// Scope validation
	if requiredScope != "" && permissions != "*" {
		scopes := strings.Split(permissions, ",")
		matched := false
		for _, sc := range scopes {
			if strings.TrimSpace(sc) == requiredScope || strings.TrimSpace(sc) == "*" {
				matched = true
				break
			}
		}
		if !matched {
			return nil, fmt.Errorf("bot token lacks required scope %q", requiredScope)
		}
	}

	return &models.BotToken{
		ID:        id,
		BotID:     botID,
		Name:      name,
		Scope:     permissions,
		CreatedBy: botID,
		IsRevoked: false,
		CreatedAt: createdAt,
	}, nil
}

func (s *SQLStore) ListBotTokens(ctx context.Context, createdBy string) ([]*models.BotToken, error) {
	query := `SELECT id, bot_id, name, permissions, created_at, revoked_at FROM bot_tokens WHERE bot_id = ? ORDER BY created_at DESC`
	if s.driverName == "postgres" {
		query = `SELECT id, bot_id, name, permissions, created_at, revoked_at FROM bot_tokens WHERE bot_id = $1 ORDER BY created_at DESC`
	}

	rows, err := s.db.QueryContext(ctx, query, createdBy)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tokens []*models.BotToken
	for rows.Next() {
		var bt models.BotToken
		var revokedAt sql.NullTime
		if err := rows.Scan(&bt.ID, &bt.BotID, &bt.Name, &bt.Scope, &bt.CreatedAt, &revokedAt); err != nil {
			return nil, err
		}
		bt.CreatedBy = bt.BotID
		bt.IsRevoked = revokedAt.Valid
		tokens = append(tokens, &bt)
	}
	if tokens == nil {
		tokens = []*models.BotToken{}
	}
	return tokens, rows.Err()
}

func (s *SQLStore) RevokeBotToken(ctx context.Context, tokenID, createdBy string) error {
	now := time.Now().UTC()
	query := `UPDATE bot_tokens SET revoked_at = ? WHERE id = ? AND bot_id = ? AND revoked_at IS NULL`
	if s.driverName == "postgres" {
		query = `UPDATE bot_tokens SET revoked_at = $1 WHERE id = $2 AND bot_id = $3 AND revoked_at IS NULL`
	}

	res, err := s.db.ExecContext(ctx, query, now, tokenID, createdBy)
	if err != nil {
		return err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

