-- 000008_banned_ips.sql
-- IP Blacklist / Ban management and Registration IP tracking

ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_ip VARCHAR(64) DEFAULT '';

CREATE TABLE IF NOT EXISTS banned_ips (
    ip VARCHAR(64) PRIMARY KEY,
    reason TEXT DEFAULT '',
    banned_by VARCHAR(64) DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_banned_ips_created ON banned_ips(created_at DESC);
