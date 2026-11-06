-- 000007_master_bot_and_server_settings.sql
-- Master Bot, Server Settings, Registration Approval & Chat Spectate Tokens

-- Add user status columns if they do not exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;

-- Server runtime key-value settings table
CREATE TABLE IF NOT EXISTS server_settings (
    key VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Audit spectate tokens for secure admin chat spectating
CREATE TABLE IF NOT EXISTS audit_spectate_tokens (
    token VARCHAR(128) PRIMARY KEY,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_by VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_spectate_tokens_conv ON audit_spectate_tokens(conversation_id);
