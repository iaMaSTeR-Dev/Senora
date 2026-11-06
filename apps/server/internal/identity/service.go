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
	ErrPendingApproval    = errors.New("account registration is pending administrator approval")
	ErrUserBanned         = errors.New("account has been banned by server administrator")
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
	Username       string
	DisplayName    string
	Password       string
	DeviceName     string
	RegistrationIP string
}

type AuthResult struct {
	User              *models.User    `json:"user"`
	Device            *models.Device  `json:"device"`
	Session           *models.Session `json:"session,omitempty"`
	IsPendingApproval bool            `json:"is_pending_approval,omitempty"`
	IsOwner           bool            `json:"is_owner,omitempty"`
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

	// Count existing users to determine if this is the very first user (Server Owner)
	userCount, _ := s.store.CountUsers(ctx)
	isFirstUser := (userCount == 0)

	approvalSetting, _ := s.store.GetServerSetting(ctx, "registration_approval", "false")
	requiresApproval := (approvalSetting == "true")

	isApproved := true
	isOwner := false

	if isFirstUser {
		// The very first user is always approved and designated as Server Owner
		isApproved = true
		isOwner = true
	} else if requiresApproval {
		isApproved = false
		isOwner = false
	}

	user := &models.User{
		ID:             "usr_" + uuid.New().String(),
		Username:       username,
		DisplayName:    displayName,
		PasswordHash:   hash,
		IsApproved:     isApproved,
		IsOwner:        isOwner,
		IsBanned:       false,
		RegistrationIP: strings.TrimSpace(p.RegistrationIP),
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

	if !isApproved {
		// Registration is pending owner approval; do not issue session token yet
		return &AuthResult{
			User:              user,
			Device:            device,
			Session:           nil,
			IsPendingApproval: true,
			IsOwner:           false,
		}, nil
	}

	session, err := s.sessions.CreateSession(ctx, user.ID, device.ID)
	if err != nil {
		return nil, err
	}

	return &AuthResult{
		User:              user,
		Device:            device,
		Session:           session,
		IsPendingApproval: false,
		IsOwner:           isOwner,
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

	if user.IsBanned {
		return nil, ErrUserBanned
	}

	if !user.IsApproved {
		return nil, ErrPendingApproval
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
		IsOwner: user.IsOwner,
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
