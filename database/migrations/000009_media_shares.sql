-- 000009_media_shares.sql
-- Media Shares for public RFC 7233 range streaming & standalone web player

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
