package storage

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
	_ "modernc.org/sqlite"

	"senora/server/internal/models"
)

type SQLStore struct {
	db             *sql.DB
	driverName     string
	dataSourceName string
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

	if driverName != "postgres" {
		_, _ = db.Exec("PRAGMA busy_timeout = 10000;")
		_, _ = db.Exec("PRAGMA journal_mode = WAL;")
	}

	s := &SQLStore{
		db:             db,
		driverName:     driverName,
		dataSourceName: dataSourceName,
	}

	if err := s.Migrate(); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	return s, nil
}

func (s *SQLStore) Close() error {
	return s.db.Close()
}

func (s *SQLStore) ResetForTesting(ctx context.Context) error {
	if s.driverName == "postgres" {
		_, err := s.db.ExecContext(ctx, `TRUNCATE TABLE users, conversations, bot_tokens, banned_ips CASCADE;`)
		return err
	}
	return nil
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

CREATE TABLE IF NOT EXISTS push_devices (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    platform VARCHAR(32) NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT DEFAULT '',
    auth TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_push_devices_user_device UNIQUE (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id);

CREATE TABLE IF NOT EXISTS server_settings (
    key VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS banned_ips (
    ip VARCHAR(64) PRIMARY KEY,
    reason TEXT DEFAULT '',
    banned_by VARCHAR(64) DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_banned_ips_created ON banned_ips(created_at DESC);

CREATE TABLE IF NOT EXISTS media_shares (
    id VARCHAR(64) PRIMARY KEY,
    message_id VARCHAR(64) DEFAULT '',
    file_path TEXT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(128) NOT NULL,
    creator_id VARCHAR(64) NOT NULL,
    creator_name VARCHAR(64) DEFAULT '',
    password_hash TEXT DEFAULT '',
    expires_at TIMESTAMP WITH TIME ZONE,
    max_downloads INT DEFAULT 0,
    download_count INT DEFAULT 0,
    views_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_media_shares_creator ON media_shares(creator_id);
CREATE INDEX IF NOT EXISTS idx_media_shares_created ON media_shares(created_at DESC);
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

CREATE TABLE IF NOT EXISTS push_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT DEFAULT '',
    auth TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id);

CREATE TABLE IF NOT EXISTS server_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS banned_ips (
    ip TEXT PRIMARY KEY,
    reason TEXT DEFAULT '',
    banned_by TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_banned_ips_created ON banned_ips(created_at DESC);

CREATE TABLE IF NOT EXISTS media_shares (
    id TEXT PRIMARY KEY,
    message_id TEXT DEFAULT '',
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    creator_name TEXT DEFAULT '',
    password_hash TEXT DEFAULT '',
    expires_at DATETIME,
    max_downloads INTEGER DEFAULT 0,
    download_count INTEGER DEFAULT 0,
    views_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_media_shares_creator ON media_shares(creator_id);
CREATE INDEX IF NOT EXISTS idx_media_shares_created ON media_shares(created_at DESC);
`
	}

	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	// Additive migrations for existing databases
	alterCols := []string{
		"ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''",
		"ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT ''",
		"ALTER TABLE users ADD COLUMN is_approved INTEGER DEFAULT 1",
		"ALTER TABLE users ADD COLUMN is_owner INTEGER DEFAULT 0",
		"ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0",
		"ALTER TABLE users ADD COLUMN registration_ip TEXT DEFAULT ''",
		`CREATE TABLE IF NOT EXISTS banned_ips (
			ip TEXT PRIMARY KEY,
			reason TEXT DEFAULT '',
			banned_by TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		"CREATE INDEX IF NOT EXISTS idx_banned_ips_created ON banned_ips(created_at DESC)",
		"ALTER TABLE devices ADD COLUMN registration_id INTEGER DEFAULT 0",
		"ALTER TABLE devices ADD COLUMN signed_pre_key TEXT DEFAULT ''",
		"ALTER TABLE conversations ADD COLUMN description TEXT DEFAULT ''",
		"ALTER TABLE conversations ADD COLUMN avatar_url TEXT DEFAULT ''",
		"ALTER TABLE conversations ADD COLUMN pinned_message_id TEXT DEFAULT ''",
		"ALTER TABLE conversations ADD COLUMN security_mode TEXT DEFAULT 'normal'",
		"ALTER TABLE conversations ADD COLUMN disappearing_ttl INTEGER DEFAULT 0",
		"ALTER TABLE conversations ADD COLUMN username TEXT DEFAULT ''",
		"CREATE INDEX IF NOT EXISTS idx_conversations_username ON conversations(username)",
		"ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT ''",
		"ALTER TABLE messages ADD COLUMN edited_at DATETIME",
		"ALTER TABLE messages ADD COLUMN is_deleted INTEGER DEFAULT 0",
		"ALTER TABLE messages ADD COLUMN is_pinned INTEGER DEFAULT 0",
		"ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '{}'",
		"ALTER TABLE messages ADD COLUMN expires_at DATETIME",
		"ALTER TABLE sticker_packs ADD COLUMN creator_id TEXT DEFAULT ''",
		"ALTER TABLE sticker_packs ADD COLUMN share_code TEXT DEFAULT ''",
		"ALTER TABLE sticker_packs ADD COLUMN is_builtin INTEGER DEFAULT 0",
		"ALTER TABLE conversations ADD COLUMN slow_mode_seconds INTEGER DEFAULT 0",
		"ALTER TABLE users ADD COLUMN self_destruct_months INTEGER DEFAULT 6",
		"ALTER TABLE users ADD COLUMN last_seen_at DATETIME",
		"ALTER TABLE conversations ADD COLUMN is_forum INTEGER DEFAULT 0",
		"ALTER TABLE messages ADD COLUMN topic_id TEXT DEFAULT ''",
		"ALTER TABLE attachments ADD COLUMN is_view_once INTEGER DEFAULT 0",
		"ALTER TABLE attachments ADD COLUMN storage_type TEXT DEFAULT 'local'",
		"ALTER TABLE attachments ADD COLUMN public_url TEXT DEFAULT ''",
		`CREATE TABLE IF NOT EXISTS forum_topics (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			title TEXT NOT NULL,
			icon TEXT DEFAULT '💬',
			color TEXT DEFAULT '#3390ec',
			created_by TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		"CREATE INDEX IF NOT EXISTS idx_forum_topics_conv ON forum_topics(conversation_id)",
		`CREATE TABLE IF NOT EXISTS conversation_pins (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
			pinned_by TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		"CREATE INDEX IF NOT EXISTS idx_conversation_pins_conv ON conversation_pins(conversation_id)",
		`CREATE TABLE IF NOT EXISTS media_shares (
			id TEXT PRIMARY KEY,
			message_id TEXT DEFAULT '',
			file_path TEXT NOT NULL,
			file_name TEXT NOT NULL,
			file_size INTEGER NOT NULL,
			mime_type TEXT NOT NULL,
			creator_id TEXT NOT NULL,
			creator_name TEXT DEFAULT '',
			password_hash TEXT DEFAULT '',
			expires_at DATETIME,
			max_downloads INTEGER DEFAULT 0,
			download_count INTEGER DEFAULT 0,
			views_count INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		"CREATE INDEX IF NOT EXISTS idx_media_shares_creator ON media_shares(creator_id)",
		"CREATE INDEX IF NOT EXISTS idx_media_shares_created ON media_shares(created_at DESC)",
	}
	if s.driverName == "postgres" {
		alterCols = []string{
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''",
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT ''",
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT TRUE",
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT FALSE",
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE",
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_ip VARCHAR(64) DEFAULT ''",
			`CREATE TABLE IF NOT EXISTS banned_ips (
				ip VARCHAR(64) PRIMARY KEY,
				reason TEXT DEFAULT '',
				banned_by VARCHAR(64) DEFAULT '',
				created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
			)`,
			"CREATE INDEX IF NOT EXISTS idx_banned_ips_created ON banned_ips(created_at DESC)",
			"ALTER TABLE devices ADD COLUMN IF NOT EXISTS registration_id INTEGER DEFAULT 0",
			"ALTER TABLE devices ADD COLUMN IF NOT EXISTS signed_pre_key TEXT DEFAULT ''",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT ''",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned_message_id TEXT DEFAULT ''",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS security_mode VARCHAR(32) DEFAULT 'normal'",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS disappearing_ttl INTEGER DEFAULT 0",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS username VARCHAR(64) DEFAULT ''",
			"CREATE INDEX IF NOT EXISTS idx_conversations_username ON conversations(username)",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id TEXT DEFAULT ''",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP WITH TIME ZONE",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions TEXT DEFAULT '{}'",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE",
			"ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS creator_id VARCHAR(64) DEFAULT ''",
			"ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS share_code VARCHAR(64) DEFAULT ''",
			"ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN DEFAULT FALSE",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS slow_mode_seconds INTEGER DEFAULT 0",
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS self_destruct_months INTEGER DEFAULT 6",
			"ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP WITH TIME ZONE",
			"ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_forum BOOLEAN DEFAULT FALSE",
			"ALTER TABLE messages ADD COLUMN IF NOT EXISTS topic_id VARCHAR(64) DEFAULT ''",
			"ALTER TABLE attachments ADD COLUMN IF NOT EXISTS is_view_once BOOLEAN DEFAULT FALSE",
			"ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_type VARCHAR(32) DEFAULT 'local'",
			"ALTER TABLE attachments ADD COLUMN IF NOT EXISTS public_url TEXT DEFAULT ''",
			`CREATE TABLE IF NOT EXISTS forum_topics (
				id VARCHAR(64) PRIMARY KEY,
				conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
				title VARCHAR(128) NOT NULL,
				icon VARCHAR(32) DEFAULT '💬',
				color VARCHAR(32) DEFAULT '#3390ec',
				created_by VARCHAR(64) DEFAULT '',
				created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
			)`,
			"CREATE INDEX IF NOT EXISTS idx_forum_topics_conv ON forum_topics(conversation_id)",
			`CREATE TABLE IF NOT EXISTS conversation_pins (
				id VARCHAR(64) PRIMARY KEY,
				conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
				message_id VARCHAR(64) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
				pinned_by VARCHAR(64) DEFAULT '',
				created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
			)`,
			"CREATE INDEX IF NOT EXISTS idx_conversation_pins_conv ON conversation_pins(conversation_id)",
			`CREATE TABLE IF NOT EXISTS media_shares (
				id VARCHAR(64) PRIMARY KEY,
				message_id VARCHAR(64) DEFAULT '',
				file_path TEXT NOT NULL,
				file_name VARCHAR(255) NOT NULL,
				file_size BIGINT NOT NULL,
				mime_type VARCHAR(128) NOT NULL,
				creator_id VARCHAR(64) NOT NULL,
				creator_name VARCHAR(64) DEFAULT '',
				password_hash TEXT DEFAULT '',
				expires_at TIMESTAMP WITH TIME ZONE,
				max_downloads INT DEFAULT 0,
				download_count INT DEFAULT 0,
				views_count INT DEFAULT 0,
				created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
			)`,
			"CREATE INDEX IF NOT EXISTS idx_media_shares_creator ON media_shares(creator_id)",
			"CREATE INDEX IF NOT EXISTS idx_media_shares_created ON media_shares(created_at DESC)",
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

	query := `INSERT INTO users (id, username, display_name, password_hash, is_approved, is_owner, is_banned, registration_ip, created_at, updated_at) 
	          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO users (id, username, display_name, password_hash, is_approved, is_owner, is_banned, registration_ip, created_at, updated_at) 
		          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`
	}

	apprVal := 0
	if u.IsApproved {
		apprVal = 1
	}
	ownerVal := 0
	if u.IsOwner {
		ownerVal = 1
	}
	bannedVal := 0
	if u.IsBanned {
		bannedVal = 1
	}

	var err error
	if s.driverName == "postgres" {
		_, err = s.db.ExecContext(ctx, query, u.ID, u.Username, u.DisplayName, u.PasswordHash, u.IsApproved, u.IsOwner, u.IsBanned, u.RegistrationIP, u.CreatedAt, u.UpdatedAt)
	} else {
		_, err = s.db.ExecContext(ctx, query, u.ID, u.Username, u.DisplayName, u.PasswordHash, apprVal, ownerVal, bannedVal, u.RegistrationIP, u.CreatedAt, u.UpdatedAt)
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") || strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			return ErrAlreadyExists
		}
		return err
	}

	instQuery := `INSERT OR IGNORE INTO user_installed_stickers (user_id, pack_id, installed_at)
	              SELECT ?, id, ? FROM sticker_packs WHERE is_builtin = 1 OR id LIKE 'pack_senora_%' OR id LIKE 'pack_crypto_%' OR id LIKE 'pack_builtin_%'`
	if s.driverName == "postgres" {
		instQuery = `INSERT INTO user_installed_stickers (user_id, pack_id, installed_at)
		              SELECT $1, id, $2 FROM sticker_packs WHERE is_builtin = TRUE OR id LIKE 'pack_senora_%' OR id LIKE 'pack_crypto_%' OR id LIKE 'pack_builtin_%' ON CONFLICT DO NOTHING`
	}
	_, _ = s.db.ExecContext(ctx, instQuery, u.ID, u.CreatedAt)

	return nil
}

func (s *SQLStore) GetUserByID(ctx context.Context, id string) (*models.User, error) {
	query := `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), COALESCE(is_approved, 1), COALESCE(is_owner, 0), COALESCE(is_banned, 0), COALESCE(registration_ip, ''), COALESCE(self_destruct_months, 6), created_at, updated_at FROM users WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), COALESCE(is_approved, TRUE), COALESCE(is_owner, FALSE), COALESCE(is_banned, FALSE), COALESCE(registration_ip, ''), COALESCE(self_destruct_months, 6), created_at, updated_at FROM users WHERE id = $1`
	}

	row := s.db.QueryRowContext(ctx, query, id)
	var u models.User
	var isApproved, isOwner, isBanned bool
	if err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Bio, &u.AvatarURL, &isApproved, &isOwner, &isBanned, &u.RegistrationIP, &u.SelfDestructMonths, &u.CreatedAt, &u.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	u.IsApproved = isApproved
	u.IsOwner = isOwner
	u.IsBanned = isBanned
	return &u, nil
}

func (s *SQLStore) GetUserByUsername(ctx context.Context, username string) (*models.User, error) {
	query := `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), COALESCE(is_approved, 1), COALESCE(is_owner, 0), COALESCE(is_banned, 0), COALESCE(registration_ip, ''), COALESCE(self_destruct_months, 6), created_at, updated_at FROM users WHERE LOWER(username) = LOWER(?)`
	if s.driverName == "postgres" {
		query = `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), COALESCE(is_approved, TRUE), COALESCE(is_owner, FALSE), COALESCE(is_banned, FALSE), COALESCE(registration_ip, ''), COALESCE(self_destruct_months, 6), created_at, updated_at FROM users WHERE LOWER(username) = LOWER($1)`
	}

	row := s.db.QueryRowContext(ctx, query, username)
	var u models.User
	var isApproved, isOwner, isBanned bool
	if err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Bio, &u.AvatarURL, &isApproved, &isOwner, &isBanned, &u.RegistrationIP, &u.SelfDestructMonths, &u.CreatedAt, &u.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	u.IsApproved = isApproved
	u.IsOwner = isOwner
	u.IsBanned = isBanned
	return &u, nil
}

func (s *SQLStore) SearchUsers(ctx context.Context, queryStr string, excludeUserID string) ([]*models.User, error) {
	cleanQuery := strings.TrimPrefix(strings.TrimSpace(queryStr), "@")
	cleanQuery = strings.TrimSpace(cleanQuery)
	if cleanQuery == "" || (len(cleanQuery) < 3 && !strings.HasPrefix(cleanQuery, "usr_")) {
		return []*models.User{}, nil
	}
	qLower := strings.ToLower(cleanQuery)
	query := `SELECT id, username, display_name, COALESCE(bio, ''), COALESCE(avatar_url, ''), created_at, updated_at FROM users 
	          WHERE (LOWER(username) = ? OR id = ?) AND id != ? AND id != 'usr_senoramasterbot'
	          LIMIT 5`
	if s.driverName == "postgres" {
		query = `SELECT id, username, display_name, COALESCE(bio, ''), COALESCE(avatar_url, ''), created_at, updated_at FROM users 
		          WHERE (LOWER(username) = $1 OR id = $2) AND id != $3 AND id != 'usr_senoramasterbot'
		          LIMIT 5`
	}

	rows, err := s.db.QueryContext(ctx, query, qLower, cleanQuery, excludeUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	users := []*models.User{}
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
	if u.SelfDestructMonths <= 0 {
		u.SelfDestructMonths = 6
	}
	query := `UPDATE users SET display_name = ?, bio = ?, avatar_url = ?, self_destruct_months = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE users SET display_name = $1, bio = $2, avatar_url = $3, self_destruct_months = $4, updated_at = $5 WHERE id = $6`
	}
	_, err := s.db.ExecContext(ctx, query, u.DisplayName, u.Bio, u.AvatarURL, u.SelfDestructMonths, u.UpdatedAt, u.ID)
	return err
}

func (s *SQLStore) UpdateUserSelfDestruct(ctx context.Context, userID string, months int) error {
	if months <= 0 {
		months = 6
	}
	query := `UPDATE users SET self_destruct_months = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE users SET self_destruct_months = $1, updated_at = $2 WHERE id = $3`
	}
	_, err := s.db.ExecContext(ctx, query, months, time.Now().UTC(), userID)
	return err
}

func (s *SQLStore) UpdateUserLastSeen(ctx context.Context, userID string) error {
	query := `UPDATE users SET last_seen_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE users SET last_seen_at = $1 WHERE id = $2`
	}
	_, err := s.db.ExecContext(ctx, query, time.Now().UTC(), userID)
	return err
}

func (s *SQLStore) UpdateUserPassword(ctx context.Context, userID, newPasswordHash string) error {
	query := `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3`
	}
	res, err := s.db.ExecContext(ctx, query, newPasswordHash, time.Now().UTC(), userID)
	if err != nil {
		return err
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrNotFound
	}
	return nil
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

	convQuery := `INSERT INTO conversations (id, type, title, description, avatar_url, pinned_message_id, security_mode, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		convQuery = `INSERT INTO conversations (id, type, title, description, avatar_url, pinned_message_id, security_mode, username, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`
	}

	if _, err := tx.ExecContext(ctx, convQuery, c.ID, c.Type, c.Title, c.Description, c.AvatarURL, c.PinnedMessageID, c.SecurityMode, c.Username, c.CreatedAt, c.UpdatedAt); err != nil {
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
	query := `SELECT id, type, COALESCE(title, ''), COALESCE(description, ''), COALESCE(avatar_url, ''), COALESCE(pinned_message_id, ''), COALESCE(security_mode, 'normal'), COALESCE(disappearing_ttl, 0), COALESCE(slow_mode_seconds, 0), COALESCE(username, ''), created_at, updated_at FROM conversations WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, type, COALESCE(title, ''), COALESCE(description, ''), COALESCE(avatar_url, ''), COALESCE(pinned_message_id, ''), COALESCE(security_mode, 'normal'), COALESCE(disappearing_ttl, 0), COALESCE(slow_mode_seconds, 0), COALESCE(username, ''), created_at, updated_at FROM conversations WHERE id = $1`
	}

	row := s.db.QueryRowContext(ctx, query, id)
	var c models.Conversation
	if err := row.Scan(&c.ID, &c.Type, &c.Title, &c.Description, &c.AvatarURL, &c.PinnedMessageID, &c.SecurityMode, &c.DisappearingTTL, &c.SlowModeSeconds, &c.Username, &c.CreatedAt, &c.UpdatedAt); err != nil {
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
	query := `UPDATE conversations SET title = ?, description = ?, avatar_url = ?, pinned_message_id = ?, slow_mode_seconds = ?, username = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE conversations SET title = $1, description = $2, avatar_url = $3, pinned_message_id = $4, slow_mode_seconds = $5, username = $6, updated_at = $7 WHERE id = $8`
	}
	_, err := s.db.ExecContext(ctx, query, c.Title, c.Description, c.AvatarURL, c.PinnedMessageID, c.SlowModeSeconds, c.Username, c.UpdatedAt, c.ID)
	return err
}

func (s *SQLStore) UpdateConversationSlowMode(ctx context.Context, convID string, seconds int) error {
	if seconds < 0 {
		seconds = 0
	}
	query := `UPDATE conversations SET slow_mode_seconds = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE conversations SET slow_mode_seconds = $1, updated_at = $2 WHERE id = $3`
	}
	_, err := s.db.ExecContext(ctx, query, seconds, time.Now().UTC(), convID)
	return err
}

func (s *SQLStore) GetUserLastMessageTime(ctx context.Context, convID, userID string) (time.Time, error) {
	query := `SELECT created_at FROM messages WHERE conversation_id = ? AND sender_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1`
	if s.driverName == "postgres" {
		query = `SELECT created_at FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND is_deleted = FALSE ORDER BY created_at DESC LIMIT 1`
	}
	var t time.Time
	err := s.db.QueryRowContext(ctx, query, convID, userID).Scan(&t)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return time.Time{}, nil
		}
		return time.Time{}, err
	}
	return t, nil
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
		SELECT c.id, c.type, COALESCE(c.title, ''), COALESCE(c.description, ''), COALESCE(c.avatar_url, ''), COALESCE(c.pinned_message_id, ''), COALESCE(c.security_mode, 'normal'), COALESCE(c.disappearing_ttl, 0), COALESCE(c.slow_mode_seconds, 0), COALESCE(c.username, ''), c.created_at, c.updated_at 
		FROM conversations c
		INNER JOIN conversation_members cm ON c.id = cm.conversation_id
		WHERE cm.user_id = ?
		ORDER BY c.updated_at DESC
	`
	if s.driverName == "postgres" {
		query = `
			SELECT c.id, c.type, COALESCE(c.title, ''), COALESCE(c.description, ''), COALESCE(c.avatar_url, ''), COALESCE(c.pinned_message_id, ''), COALESCE(c.security_mode, 'normal'), COALESCE(c.disappearing_ttl, 0), COALESCE(c.slow_mode_seconds, 0), COALESCE(c.username, ''), c.created_at, c.updated_at 
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
		if err := rows.Scan(&c.ID, &c.Type, &c.Title, &c.Description, &c.AvatarURL, &c.PinnedMessageID, &c.SecurityMode, &c.DisappearingTTL, &c.SlowModeSeconds, &c.Username, &c.CreatedAt, &c.UpdatedAt); err != nil {
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

	msgQuery := `INSERT INTO messages (id, conversation_id, sender_id, ciphertext, nonce, ephemeral_public_key, idempotency_key, topic_id, reply_to_id, is_deleted, is_pinned, reactions, expires_at, created_at)
	             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		msgQuery = `INSERT INTO messages (id, conversation_id, sender_id, ciphertext, nonce, ephemeral_public_key, idempotency_key, topic_id, reply_to_id, is_deleted, is_pinned, reactions, expires_at, created_at)
		             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`
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

	_, err = tx.ExecContext(ctx, msgQuery, msg.ID, msg.ConversationID, msg.SenderID, msg.Ciphertext, msg.Nonce, ephemVal, idempVal, msg.TopicID, msg.ReplyToID, msg.IsDeleted, msg.IsPinned, msg.Reactions, msg.ExpiresAt, msg.CreatedAt)
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

	var senderUsername, senderDisplayName, senderAvatarURL string
	userQuery := `SELECT username, display_name, COALESCE(avatar_url, '') FROM users WHERE id = ?`
	if s.driverName == "postgres" {
		userQuery = `SELECT username, display_name, COALESCE(avatar_url, '') FROM users WHERE id = $1`
	}
	_ = tx.QueryRowContext(ctx, userQuery, msg.SenderID).Scan(&senderUsername, &senderDisplayName, &senderAvatarURL)
	if senderDisplayName == "" {
		senderDisplayName = senderUsername
	}

	var convTitle, convType string
	convQuery := `SELECT COALESCE(title, ''), type FROM conversations WHERE id = ?`
	if s.driverName == "postgres" {
		convQuery = `SELECT COALESCE(title, ''), type FROM conversations WHERE id = $1`
	}
	_ = tx.QueryRowContext(ctx, convQuery, msg.ConversationID).Scan(&convTitle, &convType)

	// 3. Insert outbox events for all participants (atomically in same transaction)
	payloadMap := map[string]interface{}{
		"id":                   msg.ID,
		"message_id":           msg.ID,
		"conversation_id":      msg.ConversationID,
		"conversation_title":   convTitle,
		"conversation_type":    convType,
		"sender_id":            msg.SenderID,
		"sender_username":      senderUsername,
		"sender_display_name":  senderDisplayName,
		"sender_avatar_url":    senderAvatarURL,
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

	query := `INSERT INTO attachments (id, conversation_id, uploader_id, filename, content_type, size_bytes, storage_path, is_encrypted, is_view_once, storage_type, public_url, created_at)
	          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO attachments (id, conversation_id, uploader_id, filename, content_type, size_bytes, storage_path, is_encrypted, is_view_once, storage_type, public_url, created_at)
		          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`
	}

	encVal := 1
	if !a.IsEncrypted {
		encVal = 0
	}
	viewOnceVal := 0
	if a.IsViewOnce {
		viewOnceVal = 1
	}
	storageType := a.StorageType
	if storageType == "" {
		storageType = "local"
	}
	var err error
	if s.driverName == "postgres" {
		_, err = s.db.ExecContext(ctx, query, a.ID, a.ConversationID, a.UploaderID, a.Filename, a.ContentType, a.SizeBytes, a.StoragePath, a.IsEncrypted, a.IsViewOnce, storageType, a.PublicURL, a.CreatedAt)
	} else {
		_, err = s.db.ExecContext(ctx, query, a.ID, a.ConversationID, a.UploaderID, a.Filename, a.ContentType, a.SizeBytes, a.StoragePath, encVal, viewOnceVal, storageType, a.PublicURL, a.CreatedAt)
	}
	return err
}

func (s *SQLStore) GetAttachmentByID(ctx context.Context, id string) (*models.Attachment, error) {
	query := `SELECT id, conversation_id, uploader_id, filename, content_type, size_bytes, storage_path, is_encrypted, COALESCE(is_view_once, 0), COALESCE(storage_type, 'local'), COALESCE(public_url, ''), created_at FROM attachments WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, conversation_id, uploader_id, filename, content_type, size_bytes, storage_path, is_encrypted, COALESCE(is_view_once, false), COALESCE(storage_type, 'local'), COALESCE(public_url, ''), created_at FROM attachments WHERE id = $1`
	}

	row := s.db.QueryRowContext(ctx, query, id)
	var a models.Attachment
	var encInt, viewOnceInt int
	var isEnc, isViewOnce bool
	var err error
	if s.driverName == "postgres" {
		err = row.Scan(&a.ID, &a.ConversationID, &a.UploaderID, &a.Filename, &a.ContentType, &a.SizeBytes, &a.StoragePath, &isEnc, &isViewOnce, &a.StorageType, &a.PublicURL, &a.CreatedAt)
		a.IsEncrypted = isEnc
		a.IsViewOnce = isViewOnce
	} else {
		err = row.Scan(&a.ID, &a.ConversationID, &a.UploaderID, &a.Filename, &a.ContentType, &a.SizeBytes, &a.StoragePath, &encInt, &viewOnceInt, &a.StorageType, &a.PublicURL, &a.CreatedAt)
		a.IsEncrypted = (encInt != 0)
		a.IsViewOnce = (viewOnceInt != 0)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *SQLStore) UpdateAttachmentStorage(ctx context.Context, id, storageType, publicURL string) error {
	query := `UPDATE attachments SET storage_type = ?, public_url = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE attachments SET storage_type = $1, public_url = $2 WHERE id = $3`
	}
	_, err := s.db.ExecContext(ctx, query, storageType, publicURL, id)
	return err
}

func (s *SQLStore) ListLocalAttachments(ctx context.Context) ([]*models.Attachment, error) {
	query := `SELECT id, conversation_id, uploader_id, filename, content_type, size_bytes, storage_path, is_encrypted, COALESCE(is_view_once, 0), COALESCE(storage_type, 'local'), COALESCE(public_url, ''), created_at FROM attachments WHERE storage_type != 'arvan_s3' OR storage_type IS NULL ORDER BY created_at ASC`
	if s.driverName == "postgres" {
		query = `SELECT id, conversation_id, uploader_id, filename, content_type, size_bytes, storage_path, is_encrypted, COALESCE(is_view_once, false), COALESCE(storage_type, 'local'), COALESCE(public_url, ''), created_at FROM attachments WHERE storage_type != 'arvan_s3' OR storage_type IS NULL ORDER BY created_at ASC`
	}

	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*models.Attachment
	for rows.Next() {
		var a models.Attachment
		var encInt, viewOnceInt int
		var isEnc, isViewOnce bool
		if s.driverName == "postgres" {
			err = rows.Scan(&a.ID, &a.ConversationID, &a.UploaderID, &a.Filename, &a.ContentType, &a.SizeBytes, &a.StoragePath, &isEnc, &isViewOnce, &a.StorageType, &a.PublicURL, &a.CreatedAt)
			a.IsEncrypted = isEnc
			a.IsViewOnce = isViewOnce
		} else {
			err = rows.Scan(&a.ID, &a.ConversationID, &a.UploaderID, &a.Filename, &a.ContentType, &a.SizeBytes, &a.StoragePath, &encInt, &viewOnceInt, &a.StorageType, &a.PublicURL, &a.CreatedAt)
			a.IsEncrypted = (encInt != 0)
			a.IsViewOnce = (viewOnceInt != 0)
		}
		if err != nil {
			return nil, err
		}
		list = append(list, &a)
	}
	return list, rows.Err()
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
	query := `SELECT id, name, title, thumbnail_url, author, COALESCE(creator_id, ''), COALESCE(share_code, ''), sticker_count, is_builtin, created_at FROM sticker_packs ORDER BY created_at ASC`
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var packs []*models.StickerPack
	for rows.Next() {
		var p models.StickerPack
		if err := rows.Scan(&p.ID, &p.Name, &p.Title, &p.ThumbnailURL, &p.Author, &p.CreatorID, &p.ShareCode, &p.StickerCount, &p.IsBuiltin, &p.CreatedAt); err != nil {
			return nil, err
		}
		if !p.IsBuiltin && (strings.HasPrefix(p.ID, "pack_builtin_") || strings.HasPrefix(p.ID, "pack_senora_") || strings.HasPrefix(p.ID, "pack_crypto_")) {
			p.IsBuiltin = true
		}
		packs = append(packs, &p)
	}
	if packs == nil {
		packs = []*models.StickerPack{}
	}
	return packs, rows.Err()
}

func (s *SQLStore) GetStickerPackByID(ctx context.Context, id string) (*models.StickerPack, error) {
	query := `SELECT id, name, title, thumbnail_url, author, COALESCE(creator_id, ''), COALESCE(share_code, ''), sticker_count, is_builtin, created_at FROM sticker_packs WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, name, title, thumbnail_url, author, COALESCE(creator_id, ''), COALESCE(share_code, ''), sticker_count, is_builtin, created_at FROM sticker_packs WHERE id = $1`
	}
	row := s.db.QueryRowContext(ctx, query, id)
	var p models.StickerPack
	if err := row.Scan(&p.ID, &p.Name, &p.Title, &p.ThumbnailURL, &p.Author, &p.CreatorID, &p.ShareCode, &p.StickerCount, &p.IsBuiltin, &p.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if !p.IsBuiltin && (strings.HasPrefix(p.ID, "pack_builtin_") || strings.HasPrefix(p.ID, "pack_senora_") || strings.HasPrefix(p.ID, "pack_crypto_")) {
		p.IsBuiltin = true
	}

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

func (s *SQLStore) GetStickerByID(ctx context.Context, id string) (*models.Sticker, error) {
	query := `SELECT id, pack_id, emoji, asset_url, width, height FROM stickers WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, pack_id, emoji, asset_url, width, height FROM stickers WHERE id = $1`
	}
	var st models.Sticker
	err := s.db.QueryRowContext(ctx, query, id).Scan(&st.ID, &st.PackID, &st.Emoji, &st.AssetURL, &st.Width, &st.Height)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &st, nil
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

func (s *SQLStore) DeleteStickerPack(ctx context.Context, packID, userID string) error {
	pack, err := s.GetStickerPackByID(ctx, packID)
	if err != nil {
		return err
	}
	if pack.IsBuiltin {
		return errors.New("cannot delete built-in sticker packs")
	}
	isOwner, _ := s.IsUserOwner(ctx, userID)
	if !isOwner && pack.CreatorID != "" && pack.CreatorID != userID {
		return errors.New("only the creator can delete this sticker pack")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	delStk := `DELETE FROM stickers WHERE pack_id = ?`
	delInst := `DELETE FROM user_installed_stickers WHERE pack_id = ?`
	delPack := `DELETE FROM sticker_packs WHERE id = ?`
	if s.driverName == "postgres" {
		delStk = `DELETE FROM stickers WHERE pack_id = $1`
		delInst = `DELETE FROM user_installed_stickers WHERE pack_id = $1`
		delPack = `DELETE FROM sticker_packs WHERE id = $1`
	}

	if _, err := tx.ExecContext(ctx, delStk, packID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, delInst, packID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, delPack, packID); err != nil {
		return err
	}

	return tx.Commit()
}

func (s *SQLStore) DeleteSticker(ctx context.Context, stickerID, userID string) error {
	stk, err := s.GetStickerByID(ctx, stickerID)
	if err != nil {
		return err
	}
	pack, err := s.GetStickerPackByID(ctx, stk.PackID)
	if err != nil {
		return err
	}
	if pack.IsBuiltin {
		return errors.New("cannot delete stickers from built-in packs")
	}
	isOwner, _ := s.IsUserOwner(ctx, userID)
	if !isOwner && pack.CreatorID != "" && pack.CreatorID != userID {
		return errors.New("only the creator can delete stickers from this pack")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	delQuery := `DELETE FROM stickers WHERE id = ?`
	upQuery := `UPDATE sticker_packs SET sticker_count = MAX(0, sticker_count - 1) WHERE id = ?`
	if s.driverName == "postgres" {
		delQuery = `DELETE FROM stickers WHERE id = $1`
		upQuery = `UPDATE sticker_packs SET sticker_count = GREATEST(0, sticker_count - 1) WHERE id = $1`
	}

	if _, err := tx.ExecContext(ctx, delQuery, stickerID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, upQuery, stk.PackID); err != nil {
		return err
	}

	return tx.Commit()
}

func (s *SQLStore) GetInstalledStickerPacks(ctx context.Context, userID string) ([]*models.StickerPack, error) {
	query := `SELECT sp.id, sp.name, sp.title, sp.thumbnail_url, sp.author, COALESCE(sp.creator_id, ''), COALESCE(sp.share_code, ''), sp.sticker_count, sp.is_builtin, sp.created_at
	          FROM sticker_packs sp
	          INNER JOIN user_installed_stickers uis ON sp.id = uis.pack_id
	          WHERE uis.user_id = ?
	          ORDER BY uis.installed_at DESC`
	if s.driverName == "postgres" {
		query = `SELECT sp.id, sp.name, sp.title, sp.thumbnail_url, sp.author, COALESCE(sp.creator_id, ''), COALESCE(sp.share_code, ''), sp.sticker_count, sp.is_builtin, sp.created_at
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
		if err := rows.Scan(&p.ID, &p.Name, &p.Title, &p.ThumbnailURL, &p.Author, &p.CreatorID, &p.ShareCode, &p.StickerCount, &p.IsBuiltin, &p.CreatedAt); err != nil {
			return nil, err
		}
		if !p.IsBuiltin && (strings.HasPrefix(p.ID, "pack_builtin_") || strings.HasPrefix(p.ID, "pack_senora_") || strings.HasPrefix(p.ID, "pack_crypto_")) {
			p.IsBuiltin = true
		}
		if stks, err := s.GetStickersForPack(ctx, p.ID); err == nil {
			p.Stickers = stks
		}
		packs = append(packs, &p)
	}
	if packs == nil {
		packs = []*models.StickerPack{}
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
		conv, err := s.GetConversationByID(ctx, conversationID)
		if err != nil {
			return err
		}
		// In direct 1-on-1 chats, Telegram allows either participant to delete for both
		isDirect := conv.Type == "direct"
		if !isDirect {
			role, _ := s.GetMemberRole(ctx, conversationID, authorID)
			isOwner, _ := s.IsUserOwner(ctx, authorID)
			if role != "owner" && role != "admin" && !isOwner {
				return ErrUnauthorized
			}
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

func (s *SQLStore) AddStickerToPack(ctx context.Context, packID string, sticker *models.Sticker) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if sticker.ID == "" {
		sticker.ID = fmt.Sprintf("%s_stk_%d", packID, time.Now().UnixNano())
	}
	sticker.PackID = packID
	if sticker.Width == 0 {
		sticker.Width = 256
	}
	if sticker.Height == 0 {
		sticker.Height = 256
	}

	stQuery := `INSERT INTO stickers (id, pack_id, emoji, asset_url, width, height) VALUES (?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		stQuery = `INSERT INTO stickers (id, pack_id, emoji, asset_url, width, height) VALUES ($1, $2, $3, $4, $5, $6)`
	}
	if _, err := tx.ExecContext(ctx, stQuery, sticker.ID, sticker.PackID, sticker.Emoji, sticker.AssetURL, sticker.Width, sticker.Height); err != nil {
		return err
	}

	upQuery := `UPDATE sticker_packs SET sticker_count = sticker_count + 1 WHERE id = ?`
	if s.driverName == "postgres" {
		upQuery = `UPDATE sticker_packs SET sticker_count = sticker_count + 1 WHERE id = $1`
	}
	if _, err := tx.ExecContext(ctx, upQuery, packID); err != nil {
		return err
	}

	return tx.Commit()
}

func (s *SQLStore) GetStickerPackByShareCode(ctx context.Context, shareCode string) (*models.StickerPack, error) {
	query := `SELECT id, name, title, thumbnail_url, author, COALESCE(creator_id, ''), COALESCE(share_code, ''), sticker_count, is_builtin, created_at FROM sticker_packs WHERE share_code = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, name, title, thumbnail_url, author, COALESCE(creator_id, ''), COALESCE(share_code, ''), sticker_count, is_builtin, created_at FROM sticker_packs WHERE share_code = $1`
	}
	var p models.StickerPack
	row := s.db.QueryRowContext(ctx, query, shareCode)
	if err := row.Scan(&p.ID, &p.Name, &p.Title, &p.ThumbnailURL, &p.Author, &p.CreatorID, &p.ShareCode, &p.StickerCount, &p.IsBuiltin, &p.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if !p.IsBuiltin && (strings.HasPrefix(p.ID, "pack_builtin_") || strings.HasPrefix(p.ID, "pack_senora_") || strings.HasPrefix(p.ID, "pack_crypto_")) {
		p.IsBuiltin = true
	}
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
	var expVal interface{} = nil
	if inv.ExpiresAt != nil && !inv.ExpiresAt.IsZero() && inv.ExpiresAt.Year() > 1970 {
		expVal = inv.ExpiresAt.UTC()
	}
	query := `INSERT INTO conversation_invites (id, conversation_id, creator_id, invite_code, max_uses, uses_count, expires_at, is_revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO conversation_invites (id, conversation_id, creator_id, invite_code, max_uses, uses_count, expires_at, is_revoked, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8)`
	}
	_, err := s.db.ExecContext(ctx, query, inv.ID, inv.ConversationID, inv.CreatorID, inv.InviteCode, inv.MaxUses, inv.UsesCount, expVal, inv.CreatedAt)
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
	var expiresAt sql.NullTime
	var err error
	if s.driverName == "postgres" {
		err = s.db.QueryRowContext(ctx, query, code).Scan(&inv.ID, &inv.ConversationID, &inv.CreatorID, &inv.InviteCode, &inv.MaxUses, &inv.UsesCount, &expiresAt, &isRevokedBool, &inv.CreatedAt)
		inv.IsRevoked = isRevokedBool
	} else {
		err = s.db.QueryRowContext(ctx, query, code).Scan(&inv.ID, &inv.ConversationID, &inv.CreatorID, &inv.InviteCode, &inv.MaxUses, &inv.UsesCount, &expiresAt, &isRevokedInt, &inv.CreatedAt)
		inv.IsRevoked = isRevokedInt != 0
	}
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if expiresAt.Valid && !expiresAt.Time.IsZero() && expiresAt.Time.Year() > 1970 {
		t := expiresAt.Time.UTC()
		inv.ExpiresAt = &t
	} else {
		inv.ExpiresAt = nil
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
		var expiresAt sql.NullTime
		if s.driverName == "postgres" {
			if err := rows.Scan(&inv.ID, &inv.ConversationID, &inv.CreatorID, &inv.InviteCode, &inv.MaxUses, &inv.UsesCount, &expiresAt, &isRevokedBool, &inv.CreatedAt); err != nil {
				return nil, err
			}
			inv.IsRevoked = isRevokedBool
		} else {
			if err := rows.Scan(&inv.ID, &inv.ConversationID, &inv.CreatorID, &inv.InviteCode, &inv.MaxUses, &inv.UsesCount, &expiresAt, &isRevokedInt, &inv.CreatedAt); err != nil {
				return nil, err
			}
			inv.IsRevoked = isRevokedInt != 0
		}
		if expiresAt.Valid && !expiresAt.Time.IsZero() && expiresAt.Time.Year() > 1970 {
			t := expiresAt.Time.UTC()
			inv.ExpiresAt = &t
		} else {
			inv.ExpiresAt = nil
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
	if inv.ExpiresAt != nil && !inv.ExpiresAt.IsZero() && inv.ExpiresAt.Year() > 1970 && inv.ExpiresAt.Before(time.Now().UTC()) {
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
	cleanQuery := strings.TrimPrefix(strings.TrimSpace(query), "@")
	cleanQuery = strings.TrimSpace(cleanQuery)
	if cleanQuery == "" {
		return map[string]interface{}{
			"channels":      []map[string]interface{}{},
			"users":         []*models.User{},
			"conversations": []*models.Conversation{},
		}, nil
	}
	qLower := strings.ToLower(cleanQuery)

	// Search user's active conversations (local dialogs)
	convs, _ := s.ListConversationsForUser(ctx, userID)
	matchedConvs := []*models.Conversation{}
	for _, c := range convs {
		matched := false
		if strings.Contains(strings.ToLower(c.Title), qLower) || strings.Contains(strings.ToLower(c.Description), qLower) {
			matched = true
		} else {
			// Check peer participants' username and display_name for direct chats
			for _, p := range c.Participants {
				if strings.Contains(strings.ToLower(p.Username), qLower) || strings.Contains(strings.ToLower(p.DisplayName), qLower) {
					matched = true
					break
				}
			}
		}
		if matched {
			matchedConvs = append(matchedConvs, c)
		}
	}

	// Short queries (< 3 chars) that are not conversation IDs NEVER query public channels or users
	if len(cleanQuery) < 3 && !strings.HasPrefix(cleanQuery, "cnv_") && !strings.HasPrefix(cleanQuery, "usr_") {
		return map[string]interface{}{
			"channels":      []map[string]interface{}{},
			"users":         []*models.User{},
			"conversations": matchedConvs,
		}, nil
	}

	// 1. Search public channels & groups by EXACT conversation ID or EXACT username ONLY (no title matching)
	chQuery := `SELECT id, type, COALESCE(title, ''), COALESCE(description, ''), COALESCE(avatar_url, ''), COALESCE(username, '') 
	            FROM conversations 
	            WHERE (type = 'channel' OR type = 'group') 
	              AND (id = ? OR (username != '' AND LOWER(username) = ?)) 
	            LIMIT 5`
	if s.driverName == "postgres" {
		chQuery = `SELECT id, type, COALESCE(title, ''), COALESCE(description, ''), COALESCE(avatar_url, ''), COALESCE(username, '') 
		            FROM conversations 
		            WHERE (type = 'channel' OR type = 'group') 
		              AND (id = $1 OR (username != '' AND LOWER(username) = $2)) 
		            LIMIT 5`
	}
	chRows, err := s.db.QueryContext(ctx, chQuery, cleanQuery, qLower)
	channels := []map[string]interface{}{}
	if err == nil {
		for chRows.Next() {
			var id, cType, title, desc, avatar, uname string
			if err := chRows.Scan(&id, &cType, &title, &desc, &avatar, &uname); err == nil {
				channels = append(channels, map[string]interface{}{
					"id": id, "type": cType, "title": title, "description": desc, "avatar_url": avatar, "username": uname,
				})
			}
		}
		if chErr := chRows.Err(); chErr != nil {
			chRows.Close()
			return nil, chErr
		}
		chRows.Close()
	}

	// 2. Search users (stripping @ so @alice matches alice) - EXACT MATCH ONLY
	users, _ := s.SearchUsers(ctx, cleanQuery, userID)
	if users == nil {
		users = []*models.User{}
	}
	if channels == nil {
		channels = []map[string]interface{}{}
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

func (s *SQLStore) RegisterPushDevice(ctx context.Context, reg *models.PushDeviceRegistration) error {
	now := time.Now().UTC()
	reg.UpdatedAt = now
	if reg.CreatedAt.IsZero() {
		reg.CreatedAt = now
	}

	query := `INSERT INTO push_devices (id, user_id, device_id, platform, endpoint, p256dh, auth, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, device_id) DO UPDATE SET
			platform = excluded.platform,
			endpoint = excluded.endpoint,
			p256dh = excluded.p256dh,
			auth = excluded.auth,
			updated_at = excluded.updated_at`

	if s.driverName == "postgres" {
		query = `INSERT INTO push_devices (id, user_id, device_id, platform, endpoint, p256dh, auth, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT(user_id, device_id) DO UPDATE SET
				platform = EXCLUDED.platform,
				endpoint = EXCLUDED.endpoint,
				p256dh = EXCLUDED.p256dh,
				auth = EXCLUDED.auth,
				updated_at = EXCLUDED.updated_at`
	}

	_, err := s.db.ExecContext(ctx, query, reg.ID, reg.UserID, reg.DeviceID, reg.Platform, reg.Endpoint, reg.P256DH, reg.Auth, reg.CreatedAt, reg.UpdatedAt)
	return err
}

func (s *SQLStore) UnregisterPushDevice(ctx context.Context, userID, deviceID string) error {
	query := `DELETE FROM push_devices WHERE user_id = ? AND device_id = ?`
	if s.driverName == "postgres" {
		query = `DELETE FROM push_devices WHERE user_id = $1 AND device_id = $2`
	}
	_, err := s.db.ExecContext(ctx, query, userID, deviceID)
	return err
}

func (s *SQLStore) GetPushDevicesForUser(ctx context.Context, userID string) ([]*models.PushDeviceRegistration, error) {
	query := `SELECT id, user_id, device_id, platform, endpoint, p256dh, auth, created_at, updated_at FROM push_devices WHERE user_id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, user_id, device_id, platform, endpoint, p256dh, auth, created_at, updated_at FROM push_devices WHERE user_id = $1`
	}

	rows, err := s.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*models.PushDeviceRegistration
	for rows.Next() {
		var r models.PushDeviceRegistration
		if err := rows.Scan(&r.ID, &r.UserID, &r.DeviceID, &r.Platform, &r.Endpoint, &r.P256DH, &r.Auth, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		list = append(list, &r)
	}
	if list == nil {
		list = []*models.PushDeviceRegistration{}
	}
	return list, rows.Err()
}

// ---------------------------------------------------------------------
// Server Settings & Administration
// ---------------------------------------------------------------------

func (s *SQLStore) SetUserApproved(ctx context.Context, userID string, approved bool) error {
	now := time.Now().UTC()
	query := `UPDATE users SET is_approved = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE users SET is_approved = $1, updated_at = $2 WHERE id = $3`
		_, err := s.db.ExecContext(ctx, query, approved, now, userID)
		return err
	}
	apprVal := 0
	if approved {
		apprVal = 1
	}
	_, err := s.db.ExecContext(ctx, query, apprVal, now, userID)
	return err
}

func (s *SQLStore) SetUserBanned(ctx context.Context, userID string, banned bool) error {
	now := time.Now().UTC()
	query := `UPDATE users SET is_banned = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE users SET is_banned = $1, updated_at = $2 WHERE id = $3`
		if _, err := s.db.ExecContext(ctx, query, banned, now, userID); err != nil {
			return err
		}
	} else {
		bannedVal := 0
		if banned {
			bannedVal = 1
		}
		if _, err := s.db.ExecContext(ctx, query, bannedVal, now, userID); err != nil {
			return err
		}
	}
	// If banned, revoke all active sessions immediately
	if banned {
		delQuery := `DELETE FROM sessions WHERE user_id = ?`
		if s.driverName == "postgres" {
			delQuery = `DELETE FROM sessions WHERE user_id = $1`
		}
		_, _ = s.db.ExecContext(ctx, delQuery, userID)
	}
	return nil
}

func (s *SQLStore) SetUserOwner(ctx context.Context, userID string, isOwner bool) error {
	now := time.Now().UTC()
	query := `UPDATE users SET is_owner = ?, updated_at = ? WHERE id = ?`
	if s.driverName == "postgres" {
		query = `UPDATE users SET is_owner = $1, updated_at = $2 WHERE id = $3`
		_, err := s.db.ExecContext(ctx, query, isOwner, now, userID)
		return err
	}
	ownerVal := 0
	if isOwner {
		ownerVal = 1
	}
	_, err := s.db.ExecContext(ctx, query, ownerVal, now, userID)
	return err
}

func (s *SQLStore) IsUserOwner(ctx context.Context, userID string) (bool, error) {
	query := `SELECT COALESCE(is_owner, 0) FROM users WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT COALESCE(is_owner, FALSE) FROM users WHERE id = $1`
	}
	var isOwner bool
	err := s.db.QueryRowContext(ctx, query, userID).Scan(&isOwner)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return isOwner, nil
}

func (s *SQLStore) GetServerOwner(ctx context.Context) (*models.User, error) {
	query := `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), COALESCE(is_approved, 1), COALESCE(is_owner, 0), COALESCE(is_banned, 0), COALESCE(registration_ip, ''), created_at, updated_at FROM users WHERE is_owner = 1 LIMIT 1`
	if s.driverName == "postgres" {
		query = `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), COALESCE(is_approved, TRUE), COALESCE(is_owner, FALSE), COALESCE(is_banned, FALSE), COALESCE(registration_ip, ''), created_at, updated_at FROM users WHERE is_owner = TRUE LIMIT 1`
	}
	var u models.User
	var isApproved, isOwner, isBanned bool
	err := s.db.QueryRowContext(ctx, query).Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Bio, &u.AvatarURL, &isApproved, &isOwner, &isBanned, &u.RegistrationIP, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	u.IsApproved = isApproved
	u.IsOwner = isOwner
	u.IsBanned = isBanned
	return &u, nil
}

func (s *SQLStore) ListAllUsers(ctx context.Context) ([]*models.User, error) {
	query := `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), COALESCE(is_approved, 1), COALESCE(is_owner, 0), COALESCE(is_banned, 0), COALESCE(registration_ip, ''), created_at, updated_at FROM users WHERE id != 'usr_senoramasterbot' ORDER BY created_at DESC`
	if s.driverName == "postgres" {
		query = `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), COALESCE(is_approved, TRUE), COALESCE(is_owner, FALSE), COALESCE(is_banned, FALSE), COALESCE(registration_ip, ''), created_at, updated_at FROM users WHERE id != 'usr_senoramasterbot' ORDER BY created_at DESC`
	}
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*models.User
	for rows.Next() {
		var u models.User
		var isApproved, isOwner, isBanned bool
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Bio, &u.AvatarURL, &isApproved, &isOwner, &isBanned, &u.RegistrationIP, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		u.IsApproved = isApproved
		u.IsOwner = isOwner
		u.IsBanned = isBanned
		users = append(users, &u)
	}
	if users == nil {
		users = []*models.User{}
	}
	return users, rows.Err()
}

func (s *SQLStore) ListPendingUsers(ctx context.Context) ([]*models.User, error) {
	query := `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), COALESCE(is_approved, 1), COALESCE(is_owner, 0), COALESCE(is_banned, 0), COALESCE(registration_ip, ''), created_at, updated_at FROM users WHERE (is_approved = 0) AND id != 'usr_senoramasterbot' ORDER BY created_at ASC`
	if s.driverName == "postgres" {
		query = `SELECT id, username, display_name, password_hash, COALESCE(bio, ''), COALESCE(avatar_url, ''), COALESCE(is_approved, TRUE), COALESCE(is_owner, FALSE), COALESCE(is_banned, FALSE), COALESCE(registration_ip, ''), created_at, updated_at FROM users WHERE (is_approved = FALSE) AND id != 'usr_senoramasterbot' ORDER BY created_at ASC`
	}
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*models.User
	for rows.Next() {
		var u models.User
		var isApproved, isOwner, isBanned bool
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Bio, &u.AvatarURL, &isApproved, &isOwner, &isBanned, &u.RegistrationIP, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		u.IsApproved = isApproved
		u.IsOwner = isOwner
		u.IsBanned = isBanned
		users = append(users, &u)
	}
	if users == nil {
		users = []*models.User{}
	}
	return users, rows.Err()
}

func (s *SQLStore) DeleteUser(ctx context.Context, userID string) error {
	query := `DELETE FROM users WHERE id = ?`
	if s.driverName == "postgres" {
		query = `DELETE FROM users WHERE id = $1`
	}
	_, err := s.db.ExecContext(ctx, query, userID)
	return err
}

func (s *SQLStore) CountUsers(ctx context.Context) (int, error) {
	query := `SELECT COUNT(*) FROM users WHERE id != 'usr_senoramasterbot'`
	var count int
	err := s.db.QueryRowContext(ctx, query).Scan(&count)
	return count, err
}

func (s *SQLStore) GetServerSetting(ctx context.Context, key, defaultValue string) (string, error) {
	query := `SELECT value FROM server_settings WHERE key = ?`
	if s.driverName == "postgres" {
		query = `SELECT value FROM server_settings WHERE key = $1`
	}
	var val string
	err := s.db.QueryRowContext(ctx, query, key).Scan(&val)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return defaultValue, nil
		}
		return defaultValue, err
	}
	return val, nil
}

func (s *SQLStore) SetServerSetting(ctx context.Context, key, value string) error {
	now := time.Now().UTC()
	query := `INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)
	          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
	if s.driverName == "postgres" {
		query = `INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, $3)
		          ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`
	}
	_, err := s.db.ExecContext(ctx, query, key, value, now)
	return err
}

var serverStartTime = time.Now().UTC()

func (s *SQLStore) GetServerStats(ctx context.Context) (*models.ServerStats, error) {
	stats := &models.ServerStats{
		ServerStartedAt: serverStartTime,
		UptimeSeconds:   int64(time.Since(serverStartTime).Seconds()),
		GoVersion:       runtime.Version(),
	}

	// Memory & goroutines
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	stats.MemoryAllocMB = float64(m.Alloc) / (1024 * 1024)
	stats.MemorySysMB = float64(m.Sys) / (1024 * 1024)
	stats.NumGoroutines = runtime.NumGoroutine()

	// Users counts
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE id != 'usr_senoramasterbot'`).Scan(&stats.TotalUsers)
	
	if s.driverName == "postgres" {
		_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_approved = FALSE AND id != 'usr_senoramasterbot'`).Scan(&stats.PendingUsers)
		_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_banned = TRUE AND id != 'usr_senoramasterbot'`).Scan(&stats.BannedUsers)
	} else {
		_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_approved = 0 AND id != 'usr_senoramasterbot'`).Scan(&stats.PendingUsers)
		_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_banned = 1 AND id != 'usr_senoramasterbot'`).Scan(&stats.BannedUsers)
	}

	// Sessions active
	now := time.Now().UTC()
	sessQuery := `SELECT COUNT(*) FROM sessions WHERE expires_at > ?`
	if s.driverName == "postgres" {
		sessQuery = `SELECT COUNT(*) FROM sessions WHERE expires_at > $1`
	}
	_ = s.db.QueryRowContext(ctx, sessQuery, now).Scan(&stats.ActiveSessions)
	stats.OnlineUsers = stats.ActiveSessions

	// Conversations & Messages
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM conversations`).Scan(&stats.TotalConversations)
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE is_deleted = 0 OR is_deleted IS FALSE`).Scan(&stats.TotalMessages)

	// Attachments & Storage
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM attachments`).Scan(&stats.TotalAttachments, &stats.TotalStorageBytes)

	// Server settings flags
	apprStr, _ := s.GetServerSetting(ctx, "registration_approval", "true")
	stats.ApprovalRequired = (apprStr == "true")
	maintStr, _ := s.GetServerSetting(ctx, "maintenance_mode", "false")
	stats.MaintenanceMode = (maintStr == "true")

	return stats, nil
}

func (s *SQLStore) GetStorageAnalytics(ctx context.Context) (*models.StorageAnalytics, error) {
	analytics := &models.StorageAnalytics{}

	// Total attachments and total bytes
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM attachments`).
		Scan(&analytics.TotalAttachments, &analytics.TotalBytes)

	// Images
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM attachments WHERE content_type LIKE 'image/%'`).
		Scan(&analytics.ImageCount, &analytics.ImageBytes)

	// Videos
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM attachments WHERE content_type LIKE 'video/%'`).
		Scan(&analytics.VideoCount, &analytics.VideoBytes)

	// Audio / Voice
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM attachments WHERE content_type LIKE 'audio/%'`).
		Scan(&analytics.AudioCount, &analytics.AudioBytes)

	// Documents / Other
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM attachments WHERE content_type NOT LIKE 'image/%' AND content_type NOT LIKE 'video/%' AND content_type NOT LIKE 'audio/%'`).
		Scan(&analytics.DocumentCount, &analytics.DocumentBytes)

	// Arvan S3 vs Local
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM attachments WHERE storage_type = 'arvan_s3'`).
		Scan(&analytics.S3Count, &analytics.S3Bytes)
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM attachments WHERE storage_type != 'arvan_s3' OR storage_type IS NULL`).
		Scan(&analytics.LocalCount, &analytics.LocalBytes)

	return analytics, nil
}

func (s *SQLStore) GetDirectConversationBetween(ctx context.Context, user1ID, user2ID string) (*models.Conversation, error) {
	query := `SELECT c.id, c.type, COALESCE(c.title, ''), COALESCE(c.description, ''), COALESCE(c.avatar_url, ''), COALESCE(c.pinned_message_id, ''), COALESCE(c.security_mode, 'normal'), c.created_at, c.updated_at
	          FROM conversations c
	          JOIN conversation_members m1 ON c.id = m1.conversation_id AND m1.user_id = ?
	          JOIN conversation_members m2 ON c.id = m2.conversation_id AND m2.user_id = ?
	          WHERE c.type = 'direct'
	          LIMIT 1`
	if s.driverName == "postgres" {
		query = `SELECT c.id, c.type, COALESCE(c.title, ''), COALESCE(c.description, ''), COALESCE(c.avatar_url, ''), COALESCE(c.pinned_message_id, ''), COALESCE(c.security_mode, 'normal'), c.created_at, c.updated_at
		          FROM conversations c
		          JOIN conversation_members m1 ON c.id = m1.conversation_id AND m1.user_id = $1
		          JOIN conversation_members m2 ON c.id = m2.conversation_id AND m2.user_id = $2
		          WHERE c.type = 'direct'
		          LIMIT 1`
	}

	var c models.Conversation
	err := s.db.QueryRowContext(ctx, query, user1ID, user2ID).Scan(
		&c.ID, &c.Type, &c.Title, &c.Description, &c.AvatarURL, &c.PinnedMessageID, &c.SecurityMode, &c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &c, nil
}

func (s *SQLStore) ListAllConversations(ctx context.Context, limit int) ([]*models.Conversation, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	query := `SELECT id, type, COALESCE(title, ''), COALESCE(description, ''), COALESCE(avatar_url, ''), COALESCE(pinned_message_id, ''), COALESCE(security_mode, 'normal'), created_at, updated_at
	          FROM conversations
	          ORDER BY updated_at DESC
	          LIMIT ?`
	if s.driverName == "postgres" {
		query = `SELECT id, type, COALESCE(title, ''), COALESCE(description, ''), COALESCE(avatar_url, ''), COALESCE(pinned_message_id, ''), COALESCE(security_mode, 'normal'), created_at, updated_at
		          FROM conversations
		          ORDER BY updated_at DESC
		          LIMIT $1`
	}

	rows, err := s.db.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*models.Conversation
	for rows.Next() {
		var c models.Conversation
		if err := rows.Scan(&c.ID, &c.Type, &c.Title, &c.Description, &c.AvatarURL, &c.PinnedMessageID, &c.SecurityMode, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		list = append(list, &c)
	}
	if list == nil {
		list = []*models.Conversation{}
	}
	return list, rows.Err()
}

// ---------------------------------------------------------------------
// IP Blacklist & Ban Management
// ---------------------------------------------------------------------

func (s *SQLStore) BanIP(ctx context.Context, rawIP, reason, bannedBy string) error {
	ip := strings.TrimSpace(rawIP)
	if ip == "" {
		return errors.New("invalid empty IP address")
	}
	// Check if valid IP or CIDR notation
	if net.ParseIP(ip) == nil {
		if _, _, err := net.ParseCIDR(ip); err != nil {
			return fmt.Errorf("invalid IP address or CIDR subnet: %s", rawIP)
		}
	}
	now := time.Now().UTC()

	query := `INSERT INTO banned_ips (ip, reason, banned_by, created_at)
	          VALUES (?, ?, ?, ?)
	          ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = excluded.created_at`
	if s.driverName == "postgres" {
		query = `INSERT INTO banned_ips (ip, reason, banned_by, created_at)
		          VALUES ($1, $2, $3, $4)
		          ON CONFLICT(ip) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by, created_at = EXCLUDED.created_at`
	}

	_, err := s.db.ExecContext(ctx, query, ip, reason, bannedBy, now)
	return err
}

func (s *SQLStore) UnbanIP(ctx context.Context, rawIP string) error {
	ip := strings.TrimSpace(rawIP)
	if ip == "" {
		return errors.New("invalid empty IP address")
	}

	query := `DELETE FROM banned_ips WHERE ip = ?`
	if s.driverName == "postgres" {
		query = `DELETE FROM banned_ips WHERE ip = $1`
	}

	_, err := s.db.ExecContext(ctx, query, ip)
	return err
}

func (s *SQLStore) IsIPBanned(ctx context.Context, rawIP string) (bool, error) {
	ip := strings.TrimSpace(rawIP)
	if ip == "" {
		return false, nil
	}

	// 1. Direct match
	query := `SELECT 1 FROM banned_ips WHERE ip = ? LIMIT 1`
	if s.driverName == "postgres" {
		query = `SELECT 1 FROM banned_ips WHERE ip = $1 LIMIT 1`
	}

	var dummy int
	err := s.db.QueryRowContext(ctx, query, ip).Scan(&dummy)
	if err == nil {
		return true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}

	// 2. CIDR subnet check
	parsedClient := net.ParseIP(ip)
	if parsedClient != nil {
		cidrQuery := `SELECT ip FROM banned_ips WHERE ip LIKE '%/%'`
		rows, err := s.db.QueryContext(ctx, cidrQuery)
		if err == nil {
			defer rows.Close()
			isBanned := false
			for rows.Next() {
				var cidrStr string
				if err := rows.Scan(&cidrStr); err == nil {
					if _, cidr, err := net.ParseCIDR(cidrStr); err == nil {
						if cidr.Contains(parsedClient) {
							isBanned = true
							break
						}
					}
				}
			}
			if err := rows.Err(); err != nil {
				return false, err
			}
			if isBanned {
				return true, nil
			}
		}
	}

	return false, nil
}

func (s *SQLStore) ListBannedIPs(ctx context.Context) ([]*models.BannedIP, error) {
	query := `SELECT ip, COALESCE(reason, ''), COALESCE(banned_by, ''), created_at FROM banned_ips ORDER BY created_at DESC`
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*models.BannedIP
	for rows.Next() {
		var b models.BannedIP
		if err := rows.Scan(&b.IP, &b.Reason, &b.BannedBy, &b.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, &b)
	}
	if list == nil {
		list = []*models.BannedIP{}
	}
	return list, rows.Err()
}

// ---------------------------------------------------------------------
// Database Backup
// ---------------------------------------------------------------------

func formatSQLValue(v interface{}) string {
	if v == nil {
		return "NULL"
	}
	switch val := v.(type) {
	case bool:
		if val {
			return "TRUE"
		}
		return "FALSE"
	case int, int8, int16, int32, int64:
		return fmt.Sprintf("%d", val)
	case uint, uint8, uint16, uint32, uint64:
		return fmt.Sprintf("%d", val)
	case float32, float64:
		return fmt.Sprintf("%f", val)
	case time.Time:
		return fmt.Sprintf("'%s'", val.UTC().Format("2006-01-02 15:04:05.999999-07"))
	case []byte:
		if utf8.Valid(val) {
			s := strings.ReplaceAll(string(val), "'", "''")
			return fmt.Sprintf("'%s'", s)
		}
		return fmt.Sprintf("decode('%x', 'hex')", val)
	case string:
		s := strings.ReplaceAll(val, "'", "''")
		return fmt.Sprintf("'%s'", s)
	default:
		s := fmt.Sprintf("%v", val)
		s = strings.ReplaceAll(s, "'", "''")
		return fmt.Sprintf("'%s'", s)
	}
}

func (s *SQLStore) backupPostgres(ctx context.Context, destPath string) error {
	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("failed to create postgres backup file: %w", err)
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	defer w.Flush()

	fmt.Fprintf(w, "-- ========================================================\n")
	fmt.Fprintf(w, "-- Senora PostgreSQL Database Snapshot Backup\n")
	fmt.Fprintf(w, "-- Generated at: %s UTC\n", time.Now().UTC().Format(time.RFC3339))
	fmt.Fprintf(w, "-- ========================================================\n\n")
	fmt.Fprintf(w, "BEGIN;\n")
	fmt.Fprintf(w, "SET statement_timeout = 0;\n")
	fmt.Fprintf(w, "SET client_encoding = 'UTF8';\n")
	fmt.Fprintf(w, "SET standard_conforming_strings = on;\n\n")

	rows, err := s.db.QueryContext(ctx, `
		SELECT table_name 
		FROM information_schema.tables 
		WHERE table_schema = 'public' AND table_type = 'BASE TABLE' 
		ORDER BY table_name;
	`)
	if err != nil {
		return fmt.Errorf("failed to query postgres tables: %w", err)
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil && t != "" {
			tables = append(tables, t)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("error reading postgres tables: %w", err)
	}
	rows.Close()

	for _, tbl := range tables {
		fmt.Fprintf(w, "\n-- Table: %s\n", tbl)

		colRows, err := s.db.QueryContext(ctx, `
			SELECT column_name 
			FROM information_schema.columns 
			WHERE table_schema = 'public' AND table_name = $1 
			ORDER BY ordinal_position;
		`, tbl)
		if err != nil {
			continue
		}

		var cols []string
		for colRows.Next() {
			var col string
			if err := colRows.Scan(&col); err == nil {
				cols = append(cols, col)
			}
		}
		if err := colRows.Err(); err != nil {
			colRows.Close()
			continue
		}
		colRows.Close()

		if len(cols) == 0 {
			continue
		}

		quotedCols := make([]string, len(cols))
		for i, c := range cols {
			quotedCols[i] = fmt.Sprintf("%q", c)
		}
		colList := strings.Join(quotedCols, ", ")

		dataRows, err := s.db.QueryContext(ctx, fmt.Sprintf("SELECT %s FROM %q", colList, tbl))
		if err != nil {
			continue
		}

		colCount := len(cols)
		for dataRows.Next() {
			values := make([]interface{}, colCount)
			valuePtrs := make([]interface{}, colCount)
			for i := range values {
				valuePtrs[i] = &values[i]
			}

			if err := dataRows.Scan(valuePtrs...); err != nil {
				continue
			}

			valStrs := make([]string, colCount)
			for i, v := range values {
				valStrs[i] = formatSQLValue(v)
			}

			fmt.Fprintf(w, "INSERT INTO %q (%s) VALUES (%s);\n", tbl, colList, strings.Join(valStrs, ", "))
		}
		if err := dataRows.Err(); err != nil {
			dataRows.Close()
			continue
		}
		dataRows.Close()
	}

	fmt.Fprintf(w, "\nCOMMIT;\n-- End of Backup\n")
	return nil
}

func (s *SQLStore) dumpSQLiteTables(ctx context.Context, destPath string) error {
	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("failed to create sqlite backup file: %w", err)
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	defer w.Flush()

	fmt.Fprintf(w, "-- Senora SQLite Database Dump\nBEGIN;\n")
	rows, err := s.db.QueryContext(ctx, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		return err
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err == nil {
			tables = append(tables, name)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()

	for _, tbl := range tables {
		colRows, err := s.db.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%q)", tbl))
		if err != nil {
			continue
		}
		var cols []string
		for colRows.Next() {
			var cid int
			var cname, ctype string
			var notnull, pk int
			var dflt interface{}
			if err := colRows.Scan(&cid, &cname, &ctype, &notnull, &dflt, &pk); err == nil {
				cols = append(cols, cname)
			}
		}
		if err := colRows.Err(); err != nil {
			colRows.Close()
			continue
		}
		colRows.Close()

		if len(cols) == 0 {
			continue
		}

		quotedCols := make([]string, len(cols))
		for i, c := range cols {
			quotedCols[i] = fmt.Sprintf("%q", c)
		}
		colList := strings.Join(quotedCols, ", ")

		dataRows, err := s.db.QueryContext(ctx, fmt.Sprintf("SELECT %s FROM %q", colList, tbl))
		if err != nil {
			continue
		}

		for dataRows.Next() {
			values := make([]interface{}, len(cols))
			valuePtrs := make([]interface{}, len(cols))
			for i := range values {
				valuePtrs[i] = &values[i]
			}
			if err := dataRows.Scan(valuePtrs...); err != nil {
				continue
			}
			valStrs := make([]string, len(cols))
			for i, v := range values {
				valStrs[i] = formatSQLValue(v)
			}
			fmt.Fprintf(w, "INSERT INTO %q (%s) VALUES (%s);\n", tbl, colList, strings.Join(valStrs, ", "))
		}
		if err := dataRows.Err(); err != nil {
			dataRows.Close()
			continue
		}
		dataRows.Close()
	}
	fmt.Fprintf(w, "COMMIT;\n")
	return nil
}

func (s *SQLStore) BackupDatabase(ctx context.Context, destPath string) error {
	destPath = strings.TrimSpace(destPath)
	if destPath == "" {
		return errors.New("destination path cannot be empty")
	}

	dir := filepath.Dir(destPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create backup directory: %w", err)
	}

	if s.driverName == "postgres" {
		return s.backupPostgres(ctx, destPath)
	}

	// SQLite: flush WAL checkpoint first
	_, _ = s.db.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)")

	// Attempt VACUUM INTO
	cleanPath := strings.ReplaceAll(destPath, "'", "''")
	cleanPath = filepath.ToSlash(cleanPath)
	_ = os.Remove(destPath) // Remove if already exists so VACUUM INTO doesn't fail
	vacuumQuery := fmt.Sprintf("VACUUM INTO '%s'", cleanPath)
	if _, err := s.db.ExecContext(ctx, vacuumQuery); err == nil {
		if fi, statErr := os.Stat(destPath); statErr == nil && fi.Size() > 0 {
			return nil
		}
	}

	// Fallback 1: Direct file copy of source db file
	srcFile := s.dataSourceName
	if idx := strings.Index(srcFile, "?"); idx != -1 {
		srcFile = srcFile[:idx]
	}
	srcFile = strings.TrimPrefix(srcFile, "file:")
	if srcFile != ":memory:" && srcFile != "" {
		if in, err := os.Open(srcFile); err == nil {
			defer in.Close()
			if out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644); err == nil {
				defer out.Close()
				if _, err := io.Copy(out, in); err == nil {
					if fi, statErr := os.Stat(destPath); statErr == nil && fi.Size() > 0 {
						return nil
					}
				}
			}
		}
	}

	// Fallback 2: Comprehensive table dump
	return s.dumpSQLiteTables(ctx, destPath)
}

// ---------------------------------------------------------------------
// Forum Topics & Supergroups
// ---------------------------------------------------------------------

func (s *SQLStore) ToggleConversationForum(ctx context.Context, convID string, isForum bool) error {
	query := "UPDATE conversations SET is_forum = ?, updated_at = ? WHERE id = ?"
	isForumVal := 0
	if isForum {
		isForumVal = 1
	}
	if s.driverName == "postgres" {
		query = "UPDATE conversations SET is_forum = $1, updated_at = $2 WHERE id = $3"
		_, err := s.db.ExecContext(ctx, query, isForum, time.Now().UTC(), convID)
		return err
	}
	_, err := s.db.ExecContext(ctx, query, isForumVal, time.Now().UTC(), convID)
	return err
}

func (s *SQLStore) CreateForumTopic(ctx context.Context, topic *models.ForumTopic) error {
	if topic.ID == "" {
		topic.ID = "tpc_" + uuid.New().String()
	}
	if topic.CreatedAt.IsZero() {
		topic.CreatedAt = time.Now().UTC()
	}
	if topic.Icon == "" {
		topic.Icon = "💬"
	}
	if topic.Color == "" {
		topic.Color = "#3390ec"
	}
	query := "INSERT INTO forum_topics (id, conversation_id, title, icon, color, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
	if s.driverName == "postgres" {
		query = "INSERT INTO forum_topics (id, conversation_id, title, icon, color, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)"
	}
	_, err := s.db.ExecContext(ctx, query, topic.ID, topic.ConversationID, topic.Title, topic.Icon, topic.Color, topic.CreatedBy, topic.CreatedAt)
	return err
}

func (s *SQLStore) GetForumTopics(ctx context.Context, convID string) ([]*models.ForumTopic, error) {
	query := "SELECT id, conversation_id, title, icon, color, created_by, created_at FROM forum_topics WHERE conversation_id = ? ORDER BY created_at ASC"
	if s.driverName == "postgres" {
		query = "SELECT id, conversation_id, title, icon, color, created_by, created_at FROM forum_topics WHERE conversation_id = $1 ORDER BY created_at ASC"
	}
	rows, err := s.db.QueryContext(ctx, query, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var topics []*models.ForumTopic
	for rows.Next() {
		var t models.ForumTopic
		if err := rows.Scan(&t.ID, &t.ConversationID, &t.Title, &t.Icon, &t.Color, &t.CreatedBy, &t.CreatedAt); err != nil {
			return nil, err
		}
		topics = append(topics, &t)
	}
	return topics, rows.Err()
}

func (s *SQLStore) GetMessagesByTopic(ctx context.Context, convID, topicID, beforeID string, limit int) ([]*models.Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	query := `
		SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, 0), COALESCE(m.is_pinned, 0), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
		FROM messages m
		JOIN users u ON m.sender_id = u.id
		WHERE m.conversation_id = ? AND m.topic_id = ?
		  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
		ORDER BY m.created_at DESC
		LIMIT ?
	`
	if s.driverName == "postgres" {
		query = `
			SELECT m.id, m.conversation_id, m.sender_id, u.username, m.ciphertext, m.nonce, m.ephemeral_public_key, m.idempotency_key, COALESCE(m.reply_to_id, ''), m.edited_at, COALESCE(m.is_deleted, false), COALESCE(m.is_pinned, false), COALESCE(m.reactions, '{}'), m.expires_at, m.created_at
			FROM messages m
			JOIN users u ON m.sender_id = u.id
			WHERE m.conversation_id = $1 AND m.topic_id = $2
			  AND (m.expires_at IS NULL OR m.expires_at > CURRENT_TIMESTAMP)
			ORDER BY m.created_at DESC
			LIMIT $3
		`
	}
	rows, err := s.db.QueryContext(ctx, query, convID, topicID, limit)
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
			t := editedAt.Time
			m.EditedAt = &t
		}
		if expAt.Valid {
			t := expAt.Time
			m.ExpiresAt = &t
		}
		m.TopicID = topicID
		msgs = append(msgs, &m)
	}
	return msgs, rows.Err()
}

// ---------------------------------------------------------------------
// Multiple Conversation Pins
// ---------------------------------------------------------------------

func (s *SQLStore) AddConversationPin(ctx context.Context, pin *models.ConversationPin) error {
	if pin.ID == "" {
		pin.ID = "pin_" + uuid.New().String()
	}
	if pin.CreatedAt.IsZero() {
		pin.CreatedAt = time.Now().UTC()
	}
	query := "INSERT INTO conversation_pins (id, conversation_id, message_id, pinned_by, created_at) VALUES (?, ?, ?, ?, ?)"
	if s.driverName == "postgres" {
		query = "INSERT INTO conversation_pins (id, conversation_id, message_id, pinned_by, created_at) VALUES ($1, $2, $3, $4, $5)"
	}
	if _, err := s.db.ExecContext(ctx, query, pin.ID, pin.ConversationID, pin.MessageID, pin.PinnedBy, pin.CreatedAt); err != nil {
		return err
	}

	uQuery := "UPDATE conversations SET pinned_message_id = ? WHERE id = ?"
	mQuery := "UPDATE messages SET is_pinned = 1 WHERE id = ?"
	if s.driverName == "postgres" {
		uQuery = "UPDATE conversations SET pinned_message_id = $1 WHERE id = $2"
		mQuery = "UPDATE messages SET is_pinned = TRUE WHERE id = $1"
	}
	_, _ = s.db.ExecContext(ctx, uQuery, pin.MessageID, pin.ConversationID)
	_, _ = s.db.ExecContext(ctx, mQuery, pin.MessageID)
	return nil
}

func (s *SQLStore) RemoveConversationPin(ctx context.Context, convID, msgID string) error {
	query := "DELETE FROM conversation_pins WHERE conversation_id = ? AND message_id = ?"
	if s.driverName == "postgres" {
		query = "DELETE FROM conversation_pins WHERE conversation_id = $1 AND message_id = $2"
	}
	if _, err := s.db.ExecContext(ctx, query, convID, msgID); err != nil {
		return err
	}

	mQuery := "UPDATE messages SET is_pinned = 0 WHERE id = ?"
	if s.driverName == "postgres" {
		mQuery = "UPDATE messages SET is_pinned = FALSE WHERE id = $1"
	}
	_, _ = s.db.ExecContext(ctx, mQuery, msgID)
	return nil
}

func (s *SQLStore) GetConversationPins(ctx context.Context, convID string) ([]*models.ConversationPin, error) {
	query := "SELECT id, conversation_id, message_id, pinned_by, created_at FROM conversation_pins WHERE conversation_id = ? ORDER BY created_at DESC"
	if s.driverName == "postgres" {
		query = "SELECT id, conversation_id, message_id, pinned_by, created_at FROM conversation_pins WHERE conversation_id = $1 ORDER BY created_at DESC"
	}
	rows, err := s.db.QueryContext(ctx, query, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pins []*models.ConversationPin
	for rows.Next() {
		var p models.ConversationPin
		if err := rows.Scan(&p.ID, &p.ConversationID, &p.MessageID, &p.PinnedBy, &p.CreatedAt); err != nil {
			return nil, err
		}
		pins = append(pins, &p)
	}
	return pins, rows.Err()
}

// ---------------------------------------------------------------------
// Media Shares & Public Streaming
// ---------------------------------------------------------------------

func (s *SQLStore) CreateMediaShare(ctx context.Context, share *models.MediaShare) error {
	if share.ID == "" {
		share.ID = "sh_" + uuid.New().String()
	}
	if share.CreatedAt.IsZero() {
		share.CreatedAt = time.Now().UTC()
	}
	query := `INSERT INTO media_shares (
		id, message_id, file_path, file_name, file_size, mime_type,
		creator_id, creator_name, password_hash, expires_at,
		max_downloads, download_count, views_count, created_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.driverName == "postgres" {
		query = `INSERT INTO media_shares (
			id, message_id, file_path, file_name, file_size, mime_type,
			creator_id, creator_name, password_hash, expires_at,
			max_downloads, download_count, views_count, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`
	}
	var expVal interface{}
	if share.ExpiresAt != nil && !share.ExpiresAt.IsZero() && share.ExpiresAt.Year() > 1970 {
		expVal = share.ExpiresAt
	}
	_, err := s.db.ExecContext(ctx, query,
		share.ID, share.MessageID, share.FilePath, share.FileName, share.FileSize, share.MimeType,
		share.CreatorID, share.CreatorName, share.PasswordHash, expVal,
		share.MaxDownloads, share.DownloadCount, share.ViewsCount, share.CreatedAt,
	)
	return err
}

func (s *SQLStore) GetMediaShareByID(ctx context.Context, id string) (*models.MediaShare, error) {
	query := `SELECT id, message_id, file_path, file_name, file_size, mime_type,
		creator_id, creator_name, password_hash, expires_at,
		max_downloads, download_count, views_count, created_at
		FROM media_shares WHERE id = ?`
	if s.driverName == "postgres" {
		query = `SELECT id, message_id, file_path, file_name, file_size, mime_type,
			creator_id, creator_name, password_hash, expires_at,
			max_downloads, download_count, views_count, created_at
			FROM media_shares WHERE id = $1`
	}
	row := s.db.QueryRowContext(ctx, query, id)
	var share models.MediaShare
	var expiresAt sql.NullTime
	var msgID, creatorName, pwdHash sql.NullString
	if err := row.Scan(
		&share.ID, &msgID, &share.FilePath, &share.FileName, &share.FileSize, &share.MimeType,
		&share.CreatorID, &creatorName, &pwdHash, &expiresAt,
		&share.MaxDownloads, &share.DownloadCount, &share.ViewsCount, &share.CreatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	share.MessageID = msgID.String
	share.CreatorName = creatorName.String
	share.PasswordHash = pwdHash.String
	share.HasPassword = share.PasswordHash != ""
	if expiresAt.Valid && !expiresAt.Time.IsZero() && expiresAt.Time.Year() > 1970 {
		share.ExpiresAt = &expiresAt.Time
	}
	return &share, nil
}

func (s *SQLStore) IncrementMediaShareViews(ctx context.Context, id string) error {
	query := "UPDATE media_shares SET views_count = views_count + 1 WHERE id = ?"
	if s.driverName == "postgres" {
		query = "UPDATE media_shares SET views_count = views_count + 1 WHERE id = $1"
	}
	_, err := s.db.ExecContext(ctx, query, id)
	return err
}

func (s *SQLStore) IncrementMediaShareDownloads(ctx context.Context, id string) error {
	query := "UPDATE media_shares SET download_count = download_count + 1 WHERE id = ?"
	if s.driverName == "postgres" {
		query = "UPDATE media_shares SET download_count = download_count + 1 WHERE id = $1"
	}
	_, err := s.db.ExecContext(ctx, query, id)
	return err
}

func (s *SQLStore) DeleteMediaShare(ctx context.Context, id string) error {
	query := "DELETE FROM media_shares WHERE id = ?"
	if s.driverName == "postgres" {
		query = "DELETE FROM media_shares WHERE id = $1"
	}
	_, err := s.db.ExecContext(ctx, query, id)
	return err
}





