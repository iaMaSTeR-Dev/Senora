-- Senora Phase 9 Additive Schema Migration (PostgreSQL)

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS security_mode VARCHAR(32) DEFAULT 'normal';
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS creator_id VARCHAR(64) DEFAULT '';
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS share_code VARCHAR(64) DEFAULT '';
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN DEFAULT FALSE;

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
