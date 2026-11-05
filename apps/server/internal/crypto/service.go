package crypto

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"senora/server/internal/models"
	"senora/server/internal/storage"
)

var (
	ErrDeviceNotFound = errors.New("device not found")
)

type Service struct {
	store storage.Store
}

func NewService(store storage.Store) *Service {
	return &Service{store: store}
}

type RegisterKeysParams struct {
	UserID            string
	DeviceID          string
	IdentityPublicKey string
	RegistrationID    uint32
	SignedPreKey      string
	PreKeys           []string
}

func (s *Service) RegisterKeys(ctx context.Context, p RegisterKeysParams) error {
	if len(p.IdentityPublicKey) < 32 || len(p.IdentityPublicKey) > 2048 {
		return errors.New("invalid identity public key length")
	}

	device, err := s.store.GetDeviceByID(ctx, p.DeviceID)
	if err != nil {
		return err
	}
	if device.UserID != p.UserID {
		return storage.ErrUnauthorized
	}

	if err := s.store.UpdateDeviceKey(ctx, p.DeviceID, p.IdentityPublicKey); err != nil {
		return err
	}

	if p.RegistrationID != 0 || p.SignedPreKey != "" {
		if err := s.store.UpdateDeviceSignalKeys(ctx, p.DeviceID, p.IdentityPublicKey, p.RegistrationID, p.SignedPreKey); err != nil {
			return err
		}
	}

	if len(p.PreKeys) > 0 {
		var pkgs []*models.KeyPackage
		for _, pk := range p.PreKeys {
			pkgs = append(pkgs, &models.KeyPackage{
				ID:            "key_" + uuid.New().String(),
				DeviceID:      p.DeviceID,
				OneTimePreKey: pk,
				Used:          false,
			})
		}
		if err := s.store.SaveKeyPackages(ctx, pkgs); err != nil {
			return err
		}
	}

	return nil
}

type UserKeyPackage struct {
	UserID  string             `json:"user_id"`
	Devices []*DeviceKeyBundle `json:"devices"`
}

type DeviceKeyBundle struct {
	DeviceID          string `json:"device_id"`
	IdentityPublicKey string `json:"identity_public_key"`
	RegistrationID    uint32 `json:"registration_id,omitempty"`
	SignedPreKey      string `json:"signed_pre_key,omitempty"`
	OneTimePreKey     string `json:"one_time_pre_key,omitempty"`
}

func (s *Service) GetUserKeyPackages(ctx context.Context, targetUserID string) (*UserKeyPackage, error) {
	if _, err := s.store.GetUserByID(ctx, targetUserID); err != nil {
		return nil, storage.ErrNotFound
	}

	devices, err := s.store.GetDevicesByUserID(ctx, targetUserID)
	if err != nil {
		return nil, err
	}

	res := &UserKeyPackage{
		UserID:  targetUserID,
		Devices: make([]*DeviceKeyBundle, 0, len(devices)),
	}

	for _, d := range devices {
		if d.IdentityPublicKey == "" {
			continue
		}
		bundle := &DeviceKeyBundle{
			DeviceID:          d.ID,
			IdentityPublicKey: d.IdentityPublicKey,
			RegistrationID:    d.RegistrationID,
			SignedPreKey:      d.SignedPreKey,
		}
		pkg, err := s.store.GetAvailableKeyPackage(ctx, d.ID)
		if err == nil && pkg != nil {
			bundle.OneTimePreKey = pkg.OneTimePreKey
		}
		res.Devices = append(res.Devices, bundle)
	}

	return res, nil
}
