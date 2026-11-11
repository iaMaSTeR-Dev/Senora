package storage

import (
	"context"
	"time"

	"senora/server/internal/models"
)

func (s *SQLStore) ListDueScheduledMessages(ctx context.Context, now time.Time) ([]*models.ScheduledMessage, error) {
	rows, err := s.db.QueryContext(ctx, s.bind("SELECT id,conversation_id,sender_id,ciphertext,nonce,scheduled_for,created_at FROM scheduled_messages WHERE NOT is_sent AND delivery_error='' AND scheduled_for<=? ORDER BY scheduled_for,id LIMIT 100"), now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*models.ScheduledMessage{}
	for rows.Next() {
		m := &models.ScheduledMessage{}
		if err = rows.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Ciphertext, &m.Nonce, &m.ScheduledFor, &m.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, m)
	}
	return result, rows.Err()
}

func (s *SQLStore) FinishScheduledMessage(ctx context.Context, id, deliveryError string) error {
	_, err := s.db.ExecContext(ctx, s.bind("UPDATE scheduled_messages SET is_sent=?,delivery_error=? WHERE id=?"), deliveryError == "", deliveryError, id)
	return err
}
