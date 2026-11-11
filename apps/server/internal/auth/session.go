package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/google/uuid"

	"senora/server/internal/models"
	"senora/server/internal/storage"
)

var (
	ErrSessionExpired = errors.New("session has expired")
	ErrInvalidToken   = errors.New("invalid session token")
)

type SessionService struct {
	store storage.Store
	ttl   time.Duration
}

func NewSessionService(store storage.Store, ttl time.Duration) *SessionService {
	if ttl <= 0 {
		ttl = 30 * 24 * time.Hour // Default 30 days
	}
	return &SessionService{
		store: store,
		ttl:   ttl,
	}
}

// GenerateToken creates 32 bytes (256 bits) of cryptographically secure random bytes.
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "ses_" + base64.RawURLEncoding.EncodeToString(b), nil
}

// CreateSession provisions a new session for a user and device.
func (s *SessionService) CreateSession(ctx context.Context, userID, deviceID string) (*models.Session, error) {
	token, err := GenerateToken()
	if err != nil {
		return nil, err
	}

	session := &models.Session{
		ID:        "ses_" + uuid.New().String(),
		Token:     token,
		UserID:    userID,
		DeviceID:  deviceID,
		ExpiresAt: time.Now().UTC().Add(s.ttl),
		CreatedAt: time.Now().UTC(),
	}

	if err := s.store.CreateSession(ctx, session); err != nil {
		return nil, err
	}

	return session, nil
}

// ValidateSession verifies a token and returns the corresponding session and user.
func (s *SessionService) ValidateSession(ctx context.Context, token string) (*models.Session, *models.User, error) {
	if token == "" {
		return nil, nil, ErrInvalidToken
	}

	session, err := s.store.GetSessionByToken(ctx, token)
	if err != nil {
		return nil, nil, err
	}

	if time.Now().UTC().After(session.ExpiresAt) {
		_ = s.store.DeleteSession(ctx, token)
		return nil, nil, ErrSessionExpired
	}

	user, err := s.store.GetUserByID(ctx, session.UserID)
	if err != nil {
		return nil, nil, err
	}

	_ = s.store.UpdateUserLastSeen(ctx, user.ID)
	return session, user, nil
}

// RevokeSession deletes the given session.
func (s *SessionService) RevokeSession(ctx context.Context, token string) error {
	return s.store.DeleteSession(ctx, token)
}
