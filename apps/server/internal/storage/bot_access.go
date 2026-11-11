package storage

import (
	"context"
	"encoding/json"
	"senora/server/internal/models"
	"strings"
	"time"
)

// BotCanReadMessage applies the same privacy policy to history and file access
// as to the durable update inbox. Membership is always checked independently.
func (s *SQLStore) BotCanReadMessage(ctx context.Context, b *models.ManagedBot, m *models.Message) bool {
	if m == nil || m.IsDeleted || m.Nonce != "normal" {
		return false
	}
	c, err := s.GetConversationByID(ctx, m.ConversationID)
	if err != nil || c.SecurityMode != "normal" {
		return false
	}
	member, err := s.IsMember(ctx, c.ID, b.UserID)
	if err != nil || !member {
		return false
	}
	text := m.Ciphertext
	var p struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(text), &p) == nil {
		if p.Type == "whisper" {
			return false
		}
		text = p.Text
	}
	if m.SenderID == b.UserID || !b.PrivacyMode || c.Type == "direct" || strings.HasPrefix(strings.TrimSpace(text), "/") || strings.Contains(strings.ToLower(text), "@"+b.Username) {
		return true
	}
	if m.ReplyToID != "" {
		reply, err := s.GetMessageByID(ctx, m.ReplyToID)
		return err == nil && reply.ConversationID == c.ID && reply.SenderID == b.UserID
	}
	return false
}

func (s *SQLStore) BotCanReadAttachment(ctx context.Context, b *models.ManagedBot, id string) bool {
	a, err := s.GetAttachmentByID(ctx, id)
	if err != nil || a.IsEncrypted {
		return false
	}
	if a.UploaderID == b.UserID {
		member, err := s.IsMember(ctx, a.ConversationID, b.UserID)
		return err == nil && member
	}
	rows, err := s.db.QueryContext(ctx, s.bind("SELECT message_id FROM message_attachments WHERE attachment_id=?"), id)
	if err != nil {
		return false
	}
	var ids []string
	for rows.Next() {
		var mid string
		if rows.Scan(&mid) != nil {
			rows.Close()
			return false
		}
		ids = append(ids, mid)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false
	}
	for _, mid := range ids {
		m, err := s.GetMessageByID(ctx, mid)
		if err == nil && s.BotCanReadMessage(ctx, b, m) {
			return true
		}
	}
	return false
}

func (s *SQLStore) PruneBotUpdates(ctx context.Context, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, s.bind("DELETE FROM bot_updates WHERE created_at<?"), now.UTC().Add(-7*24*time.Hour)); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, s.bind("DELETE FROM bot_callbacks WHERE created_at<?"), now.UTC().Add(-24*time.Hour)); err != nil {
		return err
	}
	return tx.Commit()
}

// Only newly created, unreferenced attachments may be discarded after a failed
// send. Existing media and files referenced by committed messages are preserved.
func (s *SQLStore) DeleteUnreferencedAttachment(ctx context.Context, id string) (bool, error) {
	result, err := s.db.ExecContext(ctx, s.bind("DELETE FROM attachments WHERE id=? AND NOT EXISTS(SELECT 1 FROM message_attachments WHERE attachment_id=?)"), id, id)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

func (s *SQLStore) ClaimBotFatherMessage(ctx context.Context, id string) (bool, error) {
	result, err := s.db.ExecContext(ctx, s.bind("INSERT INTO botfather_processed(message_id) VALUES (?) ON CONFLICT DO NOTHING"), id)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}
