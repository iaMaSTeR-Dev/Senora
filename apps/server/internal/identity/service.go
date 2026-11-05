package identity

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"

	"senora/server/internal/auth"
	"senora/server/internal/models"
	"senora/server/internal/storage"
)

var (
	ErrInvalidInput       = errors.New("invalid input")
	ErrInvalidCredentials = errors.New("invalid username or password")
)

type Service struct {
	store    storage.Store
	sessions *auth.SessionService
}

func NewService(store storage.Store, sessions *auth.SessionService) *Service {
	return &Service{
		store:    store,
		sessions: sessions,
	}
}

type RegisterParams struct {
	Username    string
	DisplayName string
	Password    string
	DeviceName  string
}

type AuthResult struct {
	User     *models.User    `json:"user"`
	Device   *models.Device  `json:"device"`
	Session  *models.Session `json:"session"`
}

func (s *Service) Register(ctx context.Context, p RegisterParams) (*AuthResult, error) {
	username := strings.TrimSpace(p.Username)
	displayName := strings.TrimSpace(p.DisplayName)
	if len(username) < 3 || len(username) > 32 {
		return nil, errors.New("username must be between 3 and 32 characters")
	}
	if len(displayName) < 1 || len(displayName) > 64 {
		return nil, errors.New("display name must be between 1 and 64 characters")
	}
	if len(p.Password) < 8 {
		return nil, errors.New("password must be at least 8 characters long")
	}

	hash, err := auth.HashPassword(p.Password, nil)
	if err != nil {
		return nil, err
	}

	user := &models.User{
		ID:           "usr_" + uuid.New().String(),
		Username:     username,
		DisplayName:  displayName,
		PasswordHash: hash,
	}

	if err := s.store.CreateUser(ctx, user); err != nil {
		return nil, err
	}

	deviceName := p.DeviceName
	if deviceName == "" {
		deviceName = "Web Client"
	}

	device := &models.Device{
		ID:         "dev_" + uuid.New().String(),
		UserID:     user.ID,
		DeviceName: deviceName,
	}
	if err := s.store.CreateDevice(ctx, device); err != nil {
		return nil, err
	}

	session, err := s.sessions.CreateSession(ctx, user.ID, device.ID)
	if err != nil {
		return nil, err
	}

	return &AuthResult{
		User:    user,
		Device:  device,
		Session: session,
	}, nil
}

func (s *Service) Login(ctx context.Context, username, password, deviceName string) (*AuthResult, error) {
	user, err := s.store.GetUserByUsername(ctx, strings.TrimSpace(username))
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, ErrInvalidCredentials
		}
		return nil, err
	}

	match, err := auth.ComparePassword(password, user.PasswordHash)
	if err != nil || !match {
		return nil, ErrInvalidCredentials
	}

	if deviceName == "" {
		deviceName = "Web Client"
	}

	device := &models.Device{
		ID:         "dev_" + uuid.New().String(),
		UserID:     user.ID,
		DeviceName: deviceName,
	}
	if err := s.store.CreateDevice(ctx, device); err != nil {
		return nil, err
	}

	session, err := s.sessions.CreateSession(ctx, user.ID, device.ID)
	if err != nil {
		return nil, err
	}

	return &AuthResult{
		User:    user,
		Device:  device,
		Session: session,
	}, nil
}

func (s *Service) SearchUsers(ctx context.Context, query string, excludeUserID string) ([]*models.User, error) {
	return s.store.SearchUsers(ctx, query, excludeUserID)
}

func (s *Service) GetUser(ctx context.Context, userID string) (*models.User, error) {
	return s.store.GetUserByID(ctx, userID)
}

func (s *Service) GetDevices(ctx context.Context, userID string) ([]*models.Device, error) {
	return s.store.GetDevicesByUserID(ctx, userID)
}
