package storage

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"senora/server/internal/models"
)

type BotRepository interface {
	BotCanReadMessage(context.Context, *models.ManagedBot, *models.Message) bool
	BotCanReadAttachment(context.Context, *models.ManagedBot, string) bool
	PruneBotUpdates(context.Context, time.Time) error
	DeleteUnreferencedAttachment(context.Context, string) (bool, error)
	ClaimBotFatherMessage(context.Context, string) (bool, error)
	CreateManagedBot(context.Context, string, string, string) (*models.ManagedBot, string, error)
	GetManagedBot(context.Context, string) (*models.ManagedBot, error)
	GetManagedBotByToken(context.Context, string) (*models.ManagedBot, error)
	ListManagedBots(context.Context, string) ([]*models.ManagedBot, error)
	UpdateManagedBot(context.Context, string, string, models.BotSettings) error
	RotateManagedBotToken(context.Context, string, string) (string, error)
	DisableManagedBot(context.Context, string, string) error
	SetBotWebhook(context.Context, string, string, string, string) error
	GetBotUpdates(context.Context, string, int64, int) ([]*models.BotUpdate, error)
	AcknowledgeBotUpdates(context.Context, string, int64) error
	DueBotWebhooks(context.Context, time.Time) ([]*models.ManagedBot, error)
	ClaimBotWebhook(context.Context, string, time.Time) (bool, error)
	FinishBotWebhook(context.Context, string, bool, time.Time) error
	CreateBotCallback(context.Context, string, string, string, string, string) (string, error)
	AnswerBotCallback(context.Context, string, string, string, bool) ([]*models.EventOutbox, error)
	GetBotFatherState(context.Context, string) (string, error)
	SetBotFatherState(context.Context, string, string) error
}

func (s *SQLStore) migrateBots() error {
	serial := "INTEGER PRIMARY KEY AUTOINCREMENT"
	if s.driverName == "postgres" {
		serial = "BIGSERIAL PRIMARY KEY"
	}
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),owner_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL UNIQUE,privacy_mode BOOLEAN NOT NULL DEFAULT TRUE,enabled BOOLEAN NOT NULL DEFAULT TRUE,
        commands TEXT NOT NULL DEFAULT '[]',webhook_url TEXT NOT NULL DEFAULT '',webhook_secret TEXT NOT NULL DEFAULT '',
        webhook_next_at TIMESTAMP,webhook_lease_until TIMESTAMP,webhook_failures INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',created_at TIMESTAMP NOT NULL
    );CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
    CREATE TABLE IF NOT EXISTS bot_updates(id ` + serial + `,bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,event_type TEXT NOT NULL,payload TEXT NOT NULL,created_at TIMESTAMP NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_bot_updates_bot ON bot_updates(bot_id,id);
    CREATE TABLE IF NOT EXISTS bot_callbacks(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),from_id TEXT NOT NULL REFERENCES users(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),message_id TEXT NOT NULL REFERENCES messages(id),data TEXT NOT NULL,answered BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMP NOT NULL);
    CREATE TABLE IF NOT EXISTS botfather_processed(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS botfather_states(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,state TEXT NOT NULL)`)
	return err
}

func newBotToken() (string, string, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", "", err
	}
	raw := "snb_" + base64.RawURLEncoding.EncodeToString(data)
	return raw, botTokenHash(raw), nil
}
func botTokenHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

var botUsername = regexp.MustCompile(`^[a-z][a-z0-9_]{2,27}bot$`)

func (s *SQLStore) CreateManagedBot(ctx context.Context, owner, username, name string) (*models.ManagedBot, string, error) {
	username = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	name = strings.TrimSpace(name)
	if !botUsername.MatchString(username) || username == models.BotFatherUsername || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 64 {
		return nil, "", errors.New("name must contain 1-64 characters; username must contain 6-31 ASCII characters and end in bot")
	}
	raw, hash, err := newBotToken()
	if err != nil {
		return nil, "", err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback()
	if s.driverName == "postgres" {
		if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", username); err != nil {
			return nil, "", err
		}
	}
	var exists, allowed bool
	if err = tx.QueryRowContext(ctx, s.bind("SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(username)=?)"), username).Scan(&exists); err != nil {
		return nil, "", err
	}
	if exists {
		return nil, "", ErrAlreadyExists
	}
	if err = tx.QueryRowContext(ctx, s.bind("SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND is_approved AND NOT is_banned)"), owner).Scan(&allowed); err != nil || !allowed {
		return nil, "", ErrUnauthorized
	}
	now := time.Now().UTC()
	id := "b_" + uuid.NewString()
	userID := "bot_" + uuid.NewString()
	if _, err = tx.ExecContext(ctx, s.bind("INSERT INTO users(id,username,display_name,password_hash,is_approved,is_owner,is_banned,created_at,updated_at) VALUES (?,?,?,'!',TRUE,FALSE,FALSE,?,?)"), userID, username, name, now, now); err != nil {
		return nil, "", err
	}
	if _, err = tx.ExecContext(ctx, s.bind("INSERT INTO bots(id,user_id,owner_id,token_hash,created_at) VALUES (?,?,?,?,?)"), id, userID, owner, hash, now); err != nil {
		return nil, "", err
	}
	if err = tx.Commit(); err != nil {
		return nil, "", err
	}
	bot, err := s.GetManagedBot(ctx, id)
	return bot, raw, err
}

const botColumns = "b.id,b.user_id,b.owner_id,u.username,u.display_name,COALESCE(u.bio,''),b.privacy_mode,b.enabled,b.commands,b.webhook_url,b.webhook_secret,b.webhook_failures,b.last_error,b.created_at"

type scanner interface{ Scan(...any) error }

func scanBot(row scanner) (*models.ManagedBot, error) {
	b := &models.ManagedBot{}
	var commands string
	err := row.Scan(&b.ID, &b.UserID, &b.OwnerID, &b.Username, &b.Name, &b.Description, &b.PrivacyMode, &b.Enabled, &commands, &b.WebhookURL, &b.WebhookSecret, &b.WebhookFailures, &b.LastError, &b.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	b.Commands = json.RawMessage(commands)
	return b, err
}
func (s *SQLStore) GetManagedBot(ctx context.Context, id string) (*models.ManagedBot, error) {
	return scanBot(s.db.QueryRowContext(ctx, s.bind("SELECT "+botColumns+" FROM bots b JOIN users u ON u.id=b.user_id WHERE b.id=? OR b.user_id=? OR u.username=?"), id, id, strings.TrimPrefix(id, "@")))
}
func (s *SQLStore) GetManagedBotByToken(ctx context.Context, raw string) (*models.ManagedBot, error) {
	return scanBot(s.db.QueryRowContext(ctx, s.bind("SELECT "+botColumns+" FROM bots b JOIN users u ON u.id=b.user_id JOIN users owner ON owner.id=b.owner_id WHERE b.token_hash=? AND b.enabled AND u.is_approved AND NOT u.is_banned AND owner.is_approved AND NOT owner.is_banned"), botTokenHash(raw)))
}
func (s *SQLStore) ListManagedBots(ctx context.Context, owner string) ([]*models.ManagedBot, error) {
	rows, err := s.db.QueryContext(ctx, s.bind("SELECT "+botColumns+" FROM bots b JOIN users u ON u.id=b.user_id WHERE b.owner_id=? ORDER BY b.created_at"), owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []*models.ManagedBot{}
	for rows.Next() {
		b, err := scanBot(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, b)
	}
	return list, rows.Err()
}
func (s *SQLStore) UpdateManagedBot(ctx context.Context, id, owner string, settings models.BotSettings) error {
	if n := utf8.RuneCountInString(strings.TrimSpace(settings.Name)); n < 1 || n > 64 {
		return errors.New("invalid bot name")
	}
	if utf8.RuneCountInString(settings.Description) > 1024 || !json.Valid(settings.Commands) {
		return errors.New("invalid description or commands")
	}
	var commands []struct {
		Command     string `json:"command"`
		Description string `json:"description"`
	}
	if json.Unmarshal(settings.Commands, &commands) != nil || len(commands) > 100 {
		return errors.New("commands must be an array with at most 100 entries")
	}
	for _, c := range commands {
		if !regexp.MustCompile(`^[a-z0-9_]{1,32}$`).MatchString(c.Command) || c.Description == "" || utf8.RuneCountInString(c.Description) > 256 {
			return errors.New("invalid command")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, s.bind("UPDATE bots SET privacy_mode=?,commands=? WHERE id=? AND owner_id=? AND enabled"), settings.PrivacyMode, string(settings.Commands), id, owner)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrUnauthorized
	}
	_, err = tx.ExecContext(ctx, s.bind("UPDATE users SET display_name=?,bio=?,updated_at=? WHERE id=(SELECT user_id FROM bots WHERE id=?)"), settings.Name, settings.Description, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	return tx.Commit()
}
func (s *SQLStore) RotateManagedBotToken(ctx context.Context, id, owner string) (string, error) {
	raw, hash, err := newBotToken()
	if err != nil {
		return "", err
	}
	res, err := s.db.ExecContext(ctx, s.bind("UPDATE bots SET token_hash=? WHERE id=? AND owner_id=? AND enabled"), hash, id, owner)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return "", ErrUnauthorized
	}
	return raw, nil
}
func (s *SQLStore) DisableManagedBot(ctx context.Context, id, owner string) error {
	res, err := s.db.ExecContext(ctx, s.bind("UPDATE bots SET enabled=FALSE,webhook_url='',webhook_secret='' WHERE id=? AND owner_id=?"), id, owner)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrUnauthorized
	}
	return nil
}
func (s *SQLStore) SetBotWebhook(ctx context.Context, id, owner, url, secret string) error {
	res, err := s.db.ExecContext(ctx, s.bind("UPDATE bots SET webhook_url=?,webhook_secret=?,webhook_next_at=NULL,webhook_lease_until=NULL,webhook_failures=0,last_error='' WHERE id=? AND owner_id=? AND enabled"), url, secret, id, owner)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrUnauthorized
	}
	return nil
}
func (s *SQLStore) GetBotUpdates(ctx context.Context, id string, offset int64, limit int) ([]*models.BotUpdate, error) {
	if limit < 1 || limit > 100 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, s.bind("SELECT id,event_type,payload,created_at FROM bot_updates WHERE bot_id=? AND id>=? ORDER BY id LIMIT ?"), id, offset, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*models.BotUpdate{}
	for rows.Next() {
		u := &models.BotUpdate{}
		var raw string
		if err = rows.Scan(&u.ID, &u.Type, &raw, &u.CreatedAt); err != nil {
			return nil, err
		}
		u.Data = json.RawMessage(raw)
		result = append(result, u)
	}
	return result, rows.Err()
}
func (s *SQLStore) AcknowledgeBotUpdates(ctx context.Context, id string, before int64) error {
	_, err := s.db.ExecContext(ctx, s.bind("DELETE FROM bot_updates WHERE bot_id=? AND id<?"), id, before)
	return err
}

func (s *SQLStore) DueBotWebhooks(ctx context.Context, now time.Time) ([]*models.ManagedBot, error) {
	rows, err := s.db.QueryContext(ctx, s.bind("SELECT "+botColumns+" FROM bots b JOIN users u ON u.id=b.user_id JOIN users owner ON owner.id=b.owner_id WHERE b.enabled AND NOT u.is_banned AND NOT owner.is_banned AND b.webhook_url<>'' AND u.is_approved AND owner.is_approved AND EXISTS(SELECT 1 FROM bot_updates pending WHERE pending.bot_id=b.id) AND (b.webhook_next_at IS NULL OR b.webhook_next_at<=?) AND (b.webhook_lease_until IS NULL OR b.webhook_lease_until<=?) ORDER BY b.created_at LIMIT 100"), now, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []*models.ManagedBot{}
	for rows.Next() {
		b, err := scanBot(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, b)
	}
	return list, rows.Err()
}
func (s *SQLStore) ClaimBotWebhook(ctx context.Context, id string, now time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx, s.bind("UPDATE bots SET webhook_lease_until=? WHERE id=? AND enabled AND (webhook_lease_until IS NULL OR webhook_lease_until<=?)"), now.Add(time.Minute), id, now)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}
func (s *SQLStore) FinishBotWebhook(ctx context.Context, id string, success bool, now time.Time) error {
	failures := 0
	message := ""
	next := now
	if !success {
		b, err := s.GetManagedBot(ctx, id)
		if err != nil {
			return err
		}
		failures = b.WebhookFailures + 1
		shift := failures
		if shift > 8 {
			shift = 8
		}
		next = now.Add(time.Duration(1<<shift) * time.Second)
		message = "delivery failed; retry scheduled"
	}
	_, err := s.db.ExecContext(ctx, s.bind("UPDATE bots SET webhook_lease_until=NULL,webhook_next_at=?,webhook_failures=?,last_error=? WHERE id=?"), next, failures, message, id)
	return err
}

func enqueueBotUpdate(ctx context.Context, tx *sql.Tx, s *SQLStore, id, kind string, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, s.bind("INSERT INTO bot_updates(bot_id,event_type,payload,created_at) VALUES (?,?,?,?)"), id, kind, string(raw), time.Now().UTC())
	return err
}

func (s *SQLStore) enqueueMessageBots(ctx context.Context, tx *sql.Tx, msg *models.Message, kind string) error {
	if msg.Nonce != "normal" {
		return nil
	}
	rows, err := tx.QueryContext(ctx, s.bind("SELECT b.id,b.user_id,u.username,b.privacy_mode,c.type FROM bots b JOIN users u ON u.id=b.user_id JOIN conversation_members cm ON cm.user_id=b.user_id JOIN conversations c ON c.id=cm.conversation_id WHERE cm.conversation_id=? AND b.enabled AND c.security_mode<>'e2ee_active' AND NOT EXISTS(SELECT 1 FROM bots sender WHERE sender.user_id=?)"), msg.ConversationID, msg.SenderID)
	if err != nil {
		return err
	}
	type target struct {
		id, user, username, kind string
		privacy                  bool
	}
	targets := []target{}
	for rows.Next() {
		var t target
		if err = rows.Scan(&t.id, &t.user, &t.username, &t.privacy, &t.kind); err != nil {
			rows.Close()
			return err
		}
		targets = append(targets, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	text := msg.Ciphertext
	var payload struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(text), &payload) == nil {
		if payload.Type == "whisper" {
			return nil
		}
		text = payload.Text
	}
	for _, t := range targets {
		allowed := !t.privacy || t.kind == "direct" || strings.HasPrefix(strings.TrimSpace(text), "/") || strings.Contains(strings.ToLower(text), "@"+t.username)
		if !allowed && msg.ReplyToID != "" {
			var sender string
			_ = tx.QueryRowContext(ctx, s.bind("SELECT sender_id FROM messages WHERE id=? AND conversation_id=?"), msg.ReplyToID, msg.ConversationID).Scan(&sender)
			allowed = sender == t.user
		}
		if allowed {
			if err = enqueueBotUpdate(ctx, tx, s, t.id, kind, map[string]any{"message": botEventMessage(msg, kind)}); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *SQLStore) CreateBotCallback(ctx context.Context, botID, from, conv, msgID, data string) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	id := "cb_" + uuid.NewString()
	if _, err = tx.ExecContext(ctx, s.bind("INSERT INTO bot_callbacks(id,bot_id,from_id,conversation_id,message_id,data,created_at) VALUES (?,?,?,?,?,?,?)"), id, botID, from, conv, msgID, data, time.Now().UTC()); err != nil {
		return "", err
	}
	if err = enqueueBotUpdate(ctx, tx, s, botID, "callback_query", map[string]any{"id": id, "from_id": from, "conversation_id": conv, "message_id": msgID, "data": data}); err != nil {
		return "", err
	}
	return id, tx.Commit()
}
func (s *SQLStore) AnswerBotCallback(ctx context.Context, botID, id, text string, alert bool) ([]*models.EventOutbox, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var from, conv string
	if err = tx.QueryRowContext(ctx, s.bind("SELECT from_id,conversation_id FROM bot_callbacks WHERE id=? AND bot_id=? AND NOT answered AND created_at>?"), id, botID, time.Now().UTC().Add(-5*time.Minute)).Scan(&from, &conv); err != nil {
		return nil, ErrNotFound
	}
	res, err := tx.ExecContext(ctx, s.bind("UPDATE bot_callbacks SET answered=TRUE WHERE id=? AND bot_id=? AND NOT answered"), id, botID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return nil, ErrNotFound
	}
	list, err := s.appendMutationEvents(ctx, tx, conv, "bot.callback_answer", map[string]any{"id": id, "conversation_id": conv, "text": text, "show_alert": alert}, from)
	if err != nil {
		return nil, err
	}
	return list, tx.Commit()
}
func (s *SQLStore) GetBotFatherState(ctx context.Context, user string) (string, error) {
	var value string
	err := s.db.QueryRowContext(ctx, s.bind("SELECT state FROM botfather_states WHERE user_id=?"), user).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return value, err
}
func (s *SQLStore) SetBotFatherState(ctx context.Context, user, value string) error {
	_, err := s.db.ExecContext(ctx, s.bind("INSERT INTO botfather_states(user_id,state) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state"), user, value)
	return err
}

func botEventMessage(msg *models.Message, kind string) *models.Message {
	if kind != "message.deleted" {
		return msg
	}
	copy := *msg
	copy.Ciphertext = `{"deleted":true}`
	copy.AttachmentIDs = nil
	return &copy
}
