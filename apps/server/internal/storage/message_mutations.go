package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"senora/server/internal/models"
)

func attachmentIDs(msg *models.Message) []string {
	ids := append([]string(nil), msg.AttachmentIDs...)
	if msg.Nonce == "normal" {
		var p struct {
			AttachmentID string `json:"attachment_id"`
			Attachment   struct {
				ID string `json:"id"`
			} `json:"attachment"`
			AttachmentMeta struct {
				ID string `json:"id"`
			} `json:"attachmentMeta"`
		}
		if json.Unmarshal([]byte(msg.Ciphertext), &p) == nil {
			if p.Attachment.ID != "" {
				ids = append(ids, p.Attachment.ID)
			}
			if p.AttachmentID != "" {
				ids = append(ids, p.AttachmentID)
			}
			if p.AttachmentMeta.ID != "" {
				ids = append(ids, p.AttachmentMeta.ID)
			}
		}
	}
	return ids
}

func (s *SQLStore) linkMessageAttachments(ctx context.Context, tx *sql.Tx, msg *models.Message) error {
	for _, id := range attachmentIDs(msg) {
		var conversation string
		if err := tx.QueryRowContext(ctx, s.bind("SELECT conversation_id FROM attachments WHERE id = ?"), id).Scan(&conversation); err != nil {
			return err
		}
		if conversation != msg.ConversationID {
			var member bool
			if err := tx.QueryRowContext(ctx, s.bind("SELECT EXISTS(SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?)"), conversation, msg.SenderID).Scan(&member); err != nil || !member {
				return ErrUnauthorized
			}
		}
		if _, err := tx.ExecContext(ctx, s.bind("INSERT INTO message_attachments (message_id,attachment_id) VALUES (?,?) ON CONFLICT DO NOTHING"), msg.ID, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLStore) appendMutationEvents(ctx context.Context, tx *sql.Tx, convID, kind string, payload any, onlyUser string) ([]*models.EventOutbox, error) {
	users := []string{}
	if onlyUser != "" {
		users = append(users, onlyUser)
	} else {
		rows, err := tx.QueryContext(ctx, s.bind("SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY user_id"), convID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			users = append(users, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	events := []*models.EventOutbox{}
	now := time.Now().UTC()
	for _, user := range users {
		event := &models.EventOutbox{ConversationID: convID, EventType: kind, RecipientUserID: user, Payload: string(data), CreatedAt: now}
		if err := tx.QueryRowContext(ctx, s.bind("INSERT INTO event_outbox (event_type,conversation_id,recipient_user_id,payload,created_at) VALUES (?,?,?,?,?) RETURNING id"), kind, convID, user, event.Payload, now).Scan(&event.ID); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, nil
}

// MutateMessageWithOutbox commits the state change and every recipient's replay
// event together. Authorization uses the actual message's conversation.
func (s *SQLStore) MutateMessageWithOutbox(ctx context.Context, convID, msgID, actor, kind, value, nonce string) (*models.Message, []*models.EventOutbox, error) {
	msg, err := s.GetMessageByID(ctx, msgID)
	if err != nil {
		return nil, nil, err
	}
	if msg.ConversationID != convID {
		return nil, nil, ErrUnauthorized
	}
	role, err := s.GetMemberRole(ctx, convID, actor)
	if err != nil {
		return nil, nil, ErrUnauthorized
	}
	conv, err := s.GetConversationByID(ctx, convID)
	if err != nil {
		return nil, nil, err
	}
	admin := role == "owner" || role == "admin"
	if kind == "message.updated" && msg.SenderID != actor {
		return nil, nil, ErrUnauthorized
	}
	if kind == "message.deleted" && msg.SenderID != actor && conv.Type != "direct" && !admin {
		return nil, nil, ErrUnauthorized
	}
	if kind == "message.pinned" && !admin {
		return nil, nil, ErrUnauthorized
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	lock := s.bind("SELECT ciphertext, reactions, is_deleted FROM messages WHERE id = ? AND conversation_id = ?")
	if s.driverName == "postgres" {
		lock += " FOR UPDATE"
	}
	if err = tx.QueryRowContext(ctx, lock, msgID, convID).Scan(&msg.Ciphertext, &msg.Reactions, &msg.IsDeleted); err != nil {
		return nil, nil, err
	}
	if msg.IsDeleted && kind != "message.deleted_for_me" {
		return nil, nil, ErrNotFound
	}
	payload := map[string]any{"message_id": msgID, "conversation_id": convID}
	onlyUser := ""
	switch kind {
	case "message.updated":
		if err := validatePrivatePayload(value); err != nil {
			return nil, nil, err
		}
		now := time.Now().UTC()
		msg.Ciphertext = value
		msg.Nonce = nonce
		msg.EditedAt = &now
		_, err = tx.ExecContext(ctx, s.bind("UPDATE messages SET ciphertext=?,nonce=?,edited_at=? WHERE id=?"), value, nonce, now, msgID)
		payload["ciphertext"] = value
		payload["nonce"] = nonce
		payload["edited_at"] = now.Format(time.RFC3339Nano)
	case "message.deleted":
		if value != "" {
			var supplied []string
			if json.Unmarshal([]byte(value), &supplied) != nil || len(supplied) > 16 {
				return nil, nil, ErrUnauthorized
			}
			for _, id := range supplied {
				var uploader, conversation string
				if err := tx.QueryRowContext(ctx, s.bind("SELECT uploader_id,conversation_id FROM attachments WHERE id=?"), id).Scan(&uploader, &conversation); err != nil {
					return nil, nil, err
				}
				if uploader != msg.SenderID || conversation != convID {
					return nil, nil, ErrUnauthorized
				}
				msg.AttachmentIDs = append(msg.AttachmentIDs, id)
			}
		}
		// Backfill references for pre-upgrade plaintext attachments before erasure.
		if err = s.linkMessageAttachments(ctx, tx, msg); err != nil {
			return nil, nil, err
		}
		_, err = tx.ExecContext(ctx, s.bind("INSERT INTO attachment_access (attachment_id,revoked) SELECT ma.attachment_id,TRUE FROM message_attachments ma WHERE ma.message_id=? AND NOT EXISTS(SELECT 1 FROM message_attachments other JOIN messages m ON m.id=other.message_id WHERE other.attachment_id=ma.attachment_id AND NOT m.is_deleted AND m.id<>?) ON CONFLICT(attachment_id) DO UPDATE SET revoked=TRUE"), msgID, msgID)
		if err != nil {
			return nil, nil, err
		}
		_, err = tx.ExecContext(ctx, s.bind("UPDATE messages SET is_deleted=TRUE,ciphertext=?,nonce='' WHERE id=?"), `{"deleted":true}`, msgID)
		msg.IsDeleted = true
		if _, err = tx.ExecContext(ctx, s.bind("DELETE FROM media_shares WHERE message_id=?"), msgID); err != nil {
			return nil, nil, err
		}
		payload["scope"] = "everyone"
	case "message.deleted_for_me":
		_, err = tx.ExecContext(ctx, s.bind("INSERT INTO user_message_deletions (user_id,message_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING"), actor, msgID, time.Now().UTC())
		onlyUser = actor
	case "message.reaction":
		if strings.TrimSpace(value) == "" || len(value) > 128 {
			return nil, nil, errors.New("invalid reaction")
		}
		reactions := map[string][]string{}
		_ = json.Unmarshal([]byte(msg.Reactions), &reactions)
		previous := reactions[value]
		next := []string{}
		found := false
		for _, u := range previous {
			if u == actor {
				found = true
			} else {
				next = append(next, u)
			}
		}
		if !found {
			next = append(next, actor)
		}
		if len(next) == 0 {
			delete(reactions, value)
		} else {
			reactions[value] = next
		}
		data, _ := json.Marshal(reactions)
		msg.Reactions = string(data)
		payload["reactions"] = reactions
		_, err = tx.ExecContext(ctx, s.bind("UPDATE messages SET reactions=? WHERE id=?"), msg.Reactions, msgID)
	case "message.pinned":
		pinned := value == "true"
		pinnedID := ""
		if pinned {
			pinnedID = msgID
		}
		_, err = tx.ExecContext(ctx, s.bind("UPDATE conversations SET pinned_message_id=? WHERE id=?"), pinnedID, convID)
		if err != nil {
			return nil, nil, err
		}
		_, err = tx.ExecContext(ctx, s.bind("UPDATE messages SET is_pinned=? WHERE id=?"), pinned, msgID)
		msg.IsPinned = pinned
		payload["is_pinned"] = pinned
	default:
		return nil, nil, errors.New("unsupported message mutation")
	}
	if err != nil {
		return nil, nil, err
	}
	events, err := s.appendMutationEvents(ctx, tx, convID, kind, payload, onlyUser)
	if err != nil {
		return nil, nil, err
	}
	if onlyUser == "" && (kind == "message.updated" || kind == "message.deleted") {
		if err = s.enqueueMessageBots(ctx, tx, msg, kind); err != nil { return nil,nil,err }
	}
	if err = tx.Commit(); err != nil {
		return nil, nil, err
	}
	return msg, events, nil
}
