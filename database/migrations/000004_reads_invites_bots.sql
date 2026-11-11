-- SENORA Read State, Invites, Views & Bot Tokens Migration (PostgreSQL & SQLite)

-- 1. Conversation Read State for authentic unread counting & read receipts
CREATE TABLE IF NOT EXISTS conversation_read_state (
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id VARCHAR(64) NOT NULL,
    last_read_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_read_state_user ON conversation_read_state(user_id);

-- 2. Secure Private Conversation Invites (with expiration, max uses, and revocation)
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

-- 3. Genuine Channel Message Views
CREATE TABLE IF NOT EXISTS message_views (
    message_id VARCHAR(64) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    viewed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_views_msg ON message_views(message_id);

-- 4. Bot Tokens and Webhooks
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

-- 5. Additive Columns to Conversations and Messages
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS disappearing_ttl INTEGER DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS username VARCHAR(64) DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_conversations_username ON conversations(username);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

