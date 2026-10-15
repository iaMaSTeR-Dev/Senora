-- NexaChat Phase 17 Message Reads & Reliable Receipts Migration (PostgreSQL & SQLite)

CREATE TABLE IF NOT EXISTS message_reads (
    message_id VARCHAR(64) NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    read_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_msg_reads_msg ON message_reads(message_id);
CREATE INDEX IF NOT EXISTS idx_msg_reads_conv_user ON message_reads(conversation_id, user_id);
