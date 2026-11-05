package config

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"

	"senora/server/internal/storage"
)

var (
	ErrMissingDatabaseURL    = errors.New("production environment requires DATABASE_URL to be set; SQLite fallback is forbidden in production")
	ErrSQLiteInProduction    = errors.New("SQLite is not permitted in production; please configure a valid PostgreSQL connection string")
	ErrUnsupportedDBScheme   = errors.New("unsupported database scheme; only postgresql is supported in production")
	ErrMissingDBPassword     = errors.New("production environment requires database password authentication")
	ErrInsecureDBPassword    = errors.New("insecure default database password detected; please set a secure random password")
	ErrMissingSessionSecret  = errors.New("production environment requires SESSION_SECRET to be configured")
	ErrInsecureSessionSecret = errors.New("insecure placeholder or low-entropy SESSION_SECRET detected; please generate a secure random secret")
	ErrSessionSecretTooShort = errors.New("SESSION_SECRET is too short; must provide at least 32 decoded bytes (min 256 bits of entropy)")
	ErrInvalidSessionSecret  = errors.New("invalid SESSION_SECRET encoding or format")
	ErrInvalidEnvironment    = errors.New("invalid ENVIRONMENT value; must be 'production', 'staging', 'development', or 'test'")
)

var knownInsecurePasswords = []string{
	"senora_secure_pass",
	"replace_with_a_secure_random_password_min_32_chars",
	"password",
	"postgres",
	"root",
	"admin",
	"123456",
	"12345678",
	"secret",
}

var knownInsecureSecrets = []string{
	"replace_with_a_64_character_hex_or_base64_random_secret",
	"replace_with_a_secure_random_password_min_32_chars",
	"secret",
	"changeme",
	"password",
	"admin",
	"12345678",
	"dev_secret",
	"test_secret",
}

// Config represents the validated runtime configuration.
type Config struct {
	Environment    string // "production", "staging", "development", "test"
	Port           string // Default "8080"
	DatabaseURL    string // Unredacted DSN for database connection
	Driver         string // "postgres" or "sqlite"
	SessionSecret  string // Cryptographic session secret
	TrustProxy     bool   // Whether to trust reverse proxy headers
	AllowedOrigins string // Comma-separated allowed CORS/WS origins
}

// LoadFromEnv loads configuration from the actual process environment.
func LoadFromEnv() (*Config, error) {
	return LoadFromMap(func(key string) string {
		return os.Getenv(key)
	})
}

// LoadFromMap allows deterministic testing with arbitrary environment lookups.
func LoadFromMap(getEnv func(string) string) (*Config, error) {
	rawEnv := strings.TrimSpace(getEnv("ENVIRONMENT"))
	if rawEnv == "" {
		rawEnv = "development"
	}
	env := strings.ToLower(rawEnv)

	switch env {
	case "production", "staging", "development", "test":
	default:
		return nil, fmt.Errorf("%w: %q", ErrInvalidEnvironment, rawEnv)
	}

	port := strings.TrimSpace(getEnv("PORT"))
	if port == "" {
		port = "8080"
	}

	rawDB := strings.TrimSpace(getEnv("DATABASE_URL"))
	driver := "postgres"
	dbURL := rawDB

	if env == "production" || env == "staging" {
		if rawDB == "" {
			return nil, ErrMissingDatabaseURL
		}
		if isSQLiteIndicator(rawDB) {
			return nil, ErrSQLiteInProduction
		}

		u, err := url.Parse(rawDB)
		if err != nil || u.Scheme == "" {
			return nil, fmt.Errorf("%w: invalid connection url format", ErrUnsupportedDBScheme)
		}
		if u.Scheme != "postgres" && u.Scheme != "postgresql" {
			return nil, fmt.Errorf("%w: %q", ErrUnsupportedDBScheme, u.Scheme)
		}

		if u.User == nil {
			return nil, ErrMissingDBPassword
		}
		pass, hasPass := u.User.Password()
		if !hasPass || strings.TrimSpace(pass) == "" {
			return nil, ErrMissingDBPassword
		}
		for _, bad := range knownInsecurePasswords {
			if strings.EqualFold(pass, bad) {
				return nil, ErrInsecureDBPassword
			}
		}
		driver = "postgres"
	} else {
		// Non-production (development / test)
		if rawDB == "" || isSQLiteIndicator(rawDB) {
			driver = "sqlite"
			if rawDB == "" {
				dbURL = "file:senora.db?cache=shared&mode=rwc"
			}
		} else if strings.HasPrefix(rawDB, "postgres://") || strings.HasPrefix(rawDB, "postgresql://") {
			driver = "postgres"
		} else {
			return nil, fmt.Errorf("%w: %q", ErrUnsupportedDBScheme, rawDB)
		}
	}

	// Secret validation
	sessionSecret := strings.TrimSpace(getEnv("SESSION_SECRET"))
	if env == "production" || env == "staging" {
		if err := ValidateSessionSecret(sessionSecret); err != nil {
			return nil, err
		}
	}

	trustProxy := strings.EqualFold(strings.TrimSpace(getEnv("TRUST_PROXY")), "true")
	allowedOrigins := strings.TrimSpace(getEnv("ALLOWED_ORIGINS"))

	return &Config{
		Environment:    env,
		Port:           port,
		DatabaseURL:    dbURL,
		Driver:         driver,
		SessionSecret:  sessionSecret,
		TrustProxy:     trustProxy,
		AllowedOrigins: allowedOrigins,
	}, nil
}

// ValidateSessionSecret validates that SESSION_SECRET provides at least 32 decoded bytes (256 bits)
// of cryptographic key material, is not a known development placeholder, is not low entropy,
// and does not leak secret bytes in error messages.
func ValidateSessionSecret(secret string) error {
	trimmed := strings.TrimSpace(secret)
	if trimmed == "" {
		return ErrMissingSessionSecret
	}

	for _, bad := range knownInsecureSecrets {
		if strings.EqualFold(trimmed, bad) {
			return ErrInsecureSessionSecret
		}
	}

	// Determine decoded bytes and encoding
	var decoded []byte
	isHex := isHexString(trimmed)
	if isHex {
		if len(trimmed)%2 != 0 {
			return ErrInvalidSessionSecret
		}
		dec, err := hex.DecodeString(trimmed)
		if err != nil {
			return ErrInvalidSessionSecret
		}
		if len(dec) < 32 {
			return ErrSessionSecretTooShort
		}
		decoded = dec
	} else if looksLikeBase64(trimmed) {
		dec, err := decodeBase64Flexible(trimmed)
		if err == nil {
			if len(dec) < 32 {
				return ErrSessionSecretTooShort
			}
			decoded = dec
		} else {
			if len(trimmed) < 32 {
				return ErrSessionSecretTooShort
			}
			decoded = []byte(trimmed)
		}
	} else {
		// Raw string format
		if len(trimmed) < 32 {
			return ErrSessionSecretTooShort
		}
		decoded = []byte(trimmed)
	}

	if len(decoded) < 32 {
		return ErrSessionSecretTooShort
	}

	// Entropy / Diversity check: verify distinct bytes
	uniqueBytes := make(map[byte]struct{})
	for _, b := range decoded {
		uniqueBytes[b] = struct{}{}
	}
	if len(uniqueBytes) < 8 {
		return ErrInsecureSessionSecret
	}

	return nil
}

func isHexString(s string) bool {
	if len(s) == 0 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func looksLikeBase64(s string) bool {
	if len(s) < 32 {
		return false
	}
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '-' || c == '_' || c == '=') {
			return false
		}
	}
	return true
}

func decodeBase64Flexible(s string) ([]byte, error) {
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
}

// RedactedDatabaseURL returns the connection URL with sensitive credentials stripped.
func (c *Config) RedactedDatabaseURL() string {
	if c.Driver == "sqlite" {
		return c.DatabaseURL
	}
	u, err := url.Parse(c.DatabaseURL)
	if err != nil {
		return "<redacted-db-url>"
	}
	if u.User != nil {
		username := u.User.Username()
		if _, hasPass := u.User.Password(); hasPass {
			u.User = url.UserPassword(username, "REDACTED")
		}
	}
	q := u.Query()
	for k := range q {
		if strings.Contains(strings.ToLower(k), "pass") || strings.Contains(strings.ToLower(k), "secret") {
			q.Set(k, "REDACTED")
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// InitStorage initializes the storage backend and guarantees no silent fallback.
func (c *Config) InitStorage() (storage.Store, error) {
	store, err := storage.NewSQLStore(c.Driver, c.DatabaseURL)
	if err != nil {
		redacted := c.RedactedDatabaseURL()
		sanitizedErr := sanitizeErrorString(err.Error(), c.DatabaseURL)
		return nil, fmt.Errorf("failed to connect to %s (%s): %s", c.Driver, redacted, sanitizedErr)
	}
	return store, nil
}

func isSQLiteIndicator(raw string) bool {
	l := strings.ToLower(raw)
	return strings.HasPrefix(l, "file:") ||
		strings.HasSuffix(l, ".db") ||
		strings.HasSuffix(l, ".sqlite") ||
		strings.HasPrefix(l, "sqlite://") ||
		strings.HasPrefix(l, "sqlite3://")
}

func sanitizeErrorString(msg, rawURL string) string {
	u, err := url.Parse(rawURL)
	if err == nil {
		if u.User != nil {
			if pass, hasPass := u.User.Password(); hasPass && pass != "" {
				msg = strings.ReplaceAll(msg, pass, "*****")
			}
		}
		for _, vals := range u.Query() {
			for _, v := range vals {
				if len(v) > 3 {
					msg = strings.ReplaceAll(msg, v, "*****")
				}
			}
		}
	}
	return msg
}
