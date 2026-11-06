-- 000006_push_devices.sql
-- Push notification device registrations partitioned by user and device

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
