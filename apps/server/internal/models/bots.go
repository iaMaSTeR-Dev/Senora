package models

import (
	"encoding/json"
	"time"
)

const BotFatherID = "usr_senora_botfather"
const BotFatherUsername = "botfather"

type ManagedBot struct {
	ID              string          `json:"id"`
	UserID          string          `json:"user_id"`
	OwnerID         string          `json:"owner_id"`
	Username        string          `json:"username"`
	Name            string          `json:"name"`
	Description     string          `json:"description"`
	PrivacyMode     bool            `json:"privacy_mode"`
	Enabled         bool            `json:"enabled"`
	Commands        json.RawMessage `json:"commands"`
	WebhookURL      string          `json:"webhook_url"`
	WebhookSecret   string          `json:"-"`
	WebhookFailures int             `json:"webhook_failures"`
	LastError       string          `json:"last_error,omitempty"`
	CreatedAt       time.Time       `json:"created_at"`
}

type BotUpdate struct {
	ID        int64           `json:"update_id"`
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
	CreatedAt time.Time       `json:"created_at"`
}

type BotSettings struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	PrivacyMode bool            `json:"privacy_mode"`
	Commands    json.RawMessage `json:"commands"`
}
