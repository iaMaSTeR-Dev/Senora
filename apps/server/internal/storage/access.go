package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func (s *SQLStore) bind(query string) string {
	if s.driverName != "postgres" {
		return query
	}
	var b strings.Builder
	n := 0
	for _, c := range query {
		if c == '?' {
			n++
			fmt.Fprintf(&b, "$%d", n)
		} else {
			b.WriteRune(c)
		}
	}
	return b.String()
}

func (s *SQLStore) GetOutboxHead(ctx context.Context, userID string) (int64, error) {
	var head int64
	err := s.db.QueryRowContext(ctx, s.bind("SELECT COALESCE(MAX(id),0) FROM event_outbox WHERE recipient_user_id=?"), userID).Scan(&head)
	return head, err
}

func (s *SQLStore) DeleteUserSessions(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, s.bind("DELETE FROM sessions WHERE user_id = ?"), userID)
	return err
}

func RedactLegacyWhisper(ctx context.Context, store Store, ciphertext, senderID, viewerID string) string {
	if senderID == viewerID {
		return ciphertext
	}
	var p map[string]any
	if json.Unmarshal([]byte(ciphertext), &p) != nil || p["type"] != "whisper" {
		return ciphertext
	}
	secret, _ := p["secret_text"].(string)
	if secret == "" {
		return ciphertext
	}
	if target, _ := p["target_id"].(string); target != "" {
		if target == viewerID {
			return ciphertext
		}
	} else {
		user, err := store.GetUserByID(ctx, viewerID)
		if target, _ := p["target_username"].(string); err == nil && strings.EqualFold(strings.TrimPrefix(target, "@"), user.Username) {
			return ciphertext
		}
	}
	p["secret_text"] = ""
	data, err := json.Marshal(p)
	if err != nil {
		return ""
	}
	return string(data)
}

func RedactLegacyWhisperEvent(ctx context.Context, store Store, payload, viewerID string) string {
	var p map[string]any
	if json.Unmarshal([]byte(payload), &p) != nil {
		return payload
	}
	ciphertext, ok := p["ciphertext"].(string)
	if !ok {
		return payload
	}
	sender, _ := p["sender_id"].(string)
	filtered := RedactLegacyWhisper(ctx, store, ciphertext, sender, viewerID)
	if filtered == ciphertext {
		return payload
	}
	p["ciphertext"] = filtered
	data, err := json.Marshal(p)
	if err != nil {
		return "{}"
	}
	return string(data)
}

var ErrPrivatePayload = errors.New("whisper text must be encrypted for its recipient")

func validatePrivatePayload(ciphertext string) error {
	var p struct {
		Type       string `json:"type"`
		SecretText string `json:"secret_text"`
	}
	if json.Unmarshal([]byte(ciphertext), &p) == nil && p.Type == "whisper" && p.SecretText != "" {
		return ErrPrivatePayload
	}
	return nil
}

// CanViewUserField enforces a stored privacy preference on every reader, including
// anonymous media requests. A corrupt or unavailable preference fails closed.
func CanViewUserField(ctx context.Context, store Store, target, viewer, field string) bool {
	if target == viewer && viewer != "" {
		return true
	}
	raw, err := store.GetUserPreferences(ctx, target)
	if err != nil {
		return false
	}
	prefs := map[string]any{}
	if raw != "" && json.Unmarshal([]byte(raw), &prefs) != nil {
		return false
	}
	visibility, _ := prefs[field].(string)
	switch visibility {
	case "nobody":
		return false
	case "contacts":
		if viewer == "" {
			return false
		}
		convs, err := store.ListConversationsForUser(ctx, target)
		if err != nil {
			return false
		}
		for _, c := range convs {
			if c.Type == "direct" {
				ok, err := store.IsMember(ctx, c.ID, viewer)
				if err == nil && ok {
					return true
				}
			}
		}
		return false
	case "", "everybody", "everyone":
		return true
	default:
		return false
	}
}

func (s *SQLStore) GetAvatarOwner(ctx context.Context, filename string) (string, error) {
	// Avatar filenames are generated identifiers; suffix matching also supports
	// legacy absolute URLs without exposing the current storage location.
	var id string
	escaped := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(filename)
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id FROM users WHERE avatar_url LIKE ? ESCAPE '\'`), "%/"+escaped).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return id, err
}

func (s *SQLStore) AuthorizeAttachmentDownload(ctx context.Context, id, viewer string, consume bool) error {
	var revoked bool
	err := s.db.QueryRowContext(ctx, s.bind("SELECT revoked FROM attachment_access WHERE attachment_id = ?"), id).Scan(&revoked)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if revoked {
		return ErrUnauthorized
	}
	var links int
	if err := s.db.QueryRowContext(ctx, s.bind("SELECT COUNT(*) FROM message_attachments WHERE attachment_id=?"), id).Scan(&links); err != nil {
		return err
	}
	if links > 0 {
		visible, err := s.CanReadAttachmentReference(ctx, id, viewer)
		if err != nil {
			return err
		}
		if !visible {
			owner, err := s.IsUserOwner(ctx, viewer)
			if err != nil || !owner {
				return ErrUnauthorized
			}
		}
	}
	att, err := s.GetAttachmentByID(ctx, id)
	if err != nil {
		return err
	}
	if att.IsViewOnce && consume {
		if viewer == "" {
			return ErrUnauthorized
		}
		_, err = s.db.ExecContext(ctx, s.bind("INSERT INTO attachment_views (attachment_id, viewer_id) VALUES (?, ?)"), id, viewer)
		if err != nil {
			return ErrUnauthorized
		}
	}
	return nil
}

func (s *SQLStore) CanReadAttachmentReference(ctx context.Context, id, viewer string) (bool, error) {
	var allowed bool

	err := s.db.QueryRowContext(ctx, s.bind("SELECT EXISTS(SELECT 1 FROM message_attachments ma JOIN messages m ON m.id=ma.message_id JOIN conversation_members cm ON cm.conversation_id=m.conversation_id WHERE ma.attachment_id=? AND NOT m.is_deleted AND cm.user_id=?)"), id, viewer).Scan(&allowed)
	return allowed, err
}
