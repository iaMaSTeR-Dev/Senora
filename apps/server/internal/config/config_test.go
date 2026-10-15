package config

import (
	"errors"
	"os"
	"strings"
	"testing"
)

func TestConfigProductionNoDatabaseURL(t *testing.T) {
	env := map[string]string{
		"ENVIRONMENT":    "production",
		"SESSION_SECRET": "a1b2c3d4e5f67890123456789012345678901234567890123456789012345678",
	}
	_, err := LoadFromMap(func(k string) string { return env[k] })
	if !errors.Is(err, ErrMissingDatabaseURL) {
		t.Fatalf("Expected ErrMissingDatabaseURL when DATABASE_URL is absent, got: %v", err)
	}
}

func TestConfigProductionEmptyDatabaseURL(t *testing.T) {
	env := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   "   ",
		"SESSION_SECRET": "a1b2c3d4e5f67890123456789012345678901234567890123456789012345678",
	}
	_, err := LoadFromMap(func(k string) string { return env[k] })
	if !errors.Is(err, ErrMissingDatabaseURL) {
		t.Fatalf("Expected ErrMissingDatabaseURL when DATABASE_URL is whitespace/empty, got: %v", err)
	}
}

func TestConfigProductionSQLiteForbidden(t *testing.T) {
	env := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   "file:prod.db?cache=shared",
		"SESSION_SECRET": "a1b2c3d4e5f67890123456789012345678901234567890123456789012345678",
	}
	_, err := LoadFromMap(func(k string) string { return env[k] })
	if !errors.Is(err, ErrSQLiteInProduction) {
		t.Fatalf("Expected ErrSQLiteInProduction when SQLite file is supplied in production, got: %v", err)
	}
}

func TestConfigProductionInvalidScheme(t *testing.T) {
	env := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   "mysql://user:pass@localhost:3306/db",
		"SESSION_SECRET": "a1b2c3d4e5f67890123456789012345678901234567890123456789012345678",
	}
	_, err := LoadFromMap(func(k string) string { return env[k] })
	if !errors.Is(err, ErrUnsupportedDBScheme) {
		t.Fatalf("Expected ErrUnsupportedDBScheme when mysql:// scheme is used, got: %v", err)
	}
}

func TestConfigProductionInsecurePassword(t *testing.T) {
	env := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   "postgres://senora:senora_secure_pass@localhost:5432/senora_db",
		"SESSION_SECRET": "a1b2c3d4e5f67890123456789012345678901234567890123456789012345678",
	}
	_, err := LoadFromMap(func(k string) string { return env[k] })
	if !errors.Is(err, ErrInsecureDBPassword) {
		t.Fatalf("Expected ErrInsecureDBPassword for default password, got: %v", err)
	}
}

func TestConfigProductionMissingSessionSecret(t *testing.T) {
	env := map[string]string{
		"ENVIRONMENT":  "production",
		"DATABASE_URL": "postgres://user:random_strong_pass_9281@localhost:5432/db",
	}
	_, err := LoadFromMap(func(k string) string { return env[k] })
	if !errors.Is(err, ErrMissingSessionSecret) {
		t.Fatalf("Expected ErrMissingSessionSecret when SESSION_SECRET is unset, got: %v", err)
	}
}

func TestConfigProductionPlaceholderSessionSecret(t *testing.T) {
	env := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   "postgres://user:random_strong_pass_9281@localhost:5432/db",
		"SESSION_SECRET": "replace_with_a_64_character_hex_or_base64_random_secret",
	}
	_, err := LoadFromMap(func(k string) string { return env[k] })
	if !errors.Is(err, ErrInsecureSessionSecret) {
		t.Fatalf("Expected ErrInsecureSessionSecret for placeholder secret, got: %v", err)
	}
}

func TestConfigProductionShortSessionSecret(t *testing.T) {
	env := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   "postgres://user:random_strong_pass_9281@localhost:5432/db",
		"SESSION_SECRET": "short_secret_under_32_chars",
	}
	_, err := LoadFromMap(func(k string) string { return env[k] })
	if !errors.Is(err, ErrSessionSecretTooShort) {
		t.Fatalf("Expected ErrSessionSecretTooShort for secret with length < 32, got: %v", err)
	}
}

// Task 3: Test valid encodings, entropy checks, and error redactions for SESSION_SECRET
func TestConfigSessionSecretEncodingsAndEntropy(t *testing.T) {
	// Case 1: Valid 64-char hex random secret (32 decoded bytes)
	validHex := "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5"
	if err := ValidateSessionSecret(validHex); err != nil {
		t.Fatalf("Expected valid 64-character hex secret to pass, got: %v", err)
	}

	// Case 2: Valid 44-char base64 secret (32 decoded bytes)
	validB64 := "SGVsbG8gV29ybGQgZnJvbSBOZXhhQ2hhdCBzZWN1cmUgc2VjcmV0ISE="
	if err := ValidateSessionSecret(validB64); err != nil {
		t.Fatalf("Expected valid base64 secret to pass, got: %v", err)
	}

	// Case 3: 32-character hex secret (only 16 decoded bytes) must be rejected as too short
	shortHex := "4a7b9c1d2e3f405162738495a6b7c8d9"
	if err := ValidateSessionSecret(shortHex); !errors.Is(err, ErrSessionSecretTooShort) {
		t.Fatalf("Expected 32-char hex secret (16 bytes) to be rejected as ErrSessionSecretTooShort, got: %v", err)
	}

	// Case 4: Low entropy repeated characters (e.g. 64 zeros) must be rejected
	lowEntropyHex := "0000000000000000000000000000000000000000000000000000000000000000"
	if err := ValidateSessionSecret(lowEntropyHex); !errors.Is(err, ErrInsecureSessionSecret) {
		t.Fatalf("Expected low-entropy hex secret to be rejected as ErrInsecureSessionSecret, got: %v", err)
	}

	// Case 5: Whitespace-only secret must be rejected as missing
	whitespaceSecret := "    \t\n   "
	if err := ValidateSessionSecret(whitespaceSecret); !errors.Is(err, ErrMissingSessionSecret) {
		t.Fatalf("Expected whitespace-only secret to be rejected as ErrMissingSessionSecret, got: %v", err)
	}

	// Case 6: Verify error strings do not leak secret material
	testSecretValue := "super_secret_payload_that_must_never_leak_in_errors_12345678"
	err := ValidateSessionSecret(testSecretValue)
	if err != nil && strings.Contains(err.Error(), testSecretValue) {
		t.Fatalf("SECURITY VIOLATION: Secret value leaked in error message! Error: %v", err)
	}
}

// Task 4: Test production database password requirement
func TestConfigProductionMissingDBPassword(t *testing.T) {
	// Missing user / password
	env1 := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   "postgres://localhost:5432/senora_prod",
		"SESSION_SECRET": "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5",
	}
	_, err1 := LoadFromMap(func(k string) string { return env1[k] })
	if !errors.Is(err1, ErrMissingDBPassword) {
		t.Fatalf("Expected ErrMissingDBPassword when password is absent, got: %v", err1)
	}

	// Empty password with username
	env2 := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   "postgres://user:@localhost:5432/senora_prod",
		"SESSION_SECRET": "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5",
	}
	_, err2 := LoadFromMap(func(k string) string { return env2[k] })
	if !errors.Is(err2, ErrMissingDBPassword) {
		t.Fatalf("Expected ErrMissingDBPassword when password is empty string, got: %v", err2)
	}
}

// Task 4: Test production whitespace-only DATABASE_URL
func TestConfigProductionWhitespaceDatabaseURL(t *testing.T) {
	env := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   "   \t\n  ",
		"SESSION_SECRET": "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5",
	}
	_, err := LoadFromMap(func(k string) string { return env[k] })
	if !errors.Is(err, ErrMissingDatabaseURL) {
		t.Fatalf("Expected ErrMissingDatabaseURL for whitespace database URL, got: %v", err)
	}
}

// Task 4: Test environment case insensitivity and rejection of invalid values
func TestConfigEnvironmentHandling(t *testing.T) {
	// Leading/trailing whitespace and uppercase in ENVIRONMENT
	envValid := map[string]string{
		"ENVIRONMENT":    "   PRODUCTION  ",
		"DATABASE_URL":   "postgres://user:random_strong_pass_9281@localhost:5432/db",
		"SESSION_SECRET": "4a7b9c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5",
	}
	cfg, err := LoadFromMap(func(k string) string { return envValid[k] })
	if err != nil {
		t.Fatalf("Expected trimmed uppercase 'PRODUCTION' to load successfully, got: %v", err)
	}
	if cfg.Environment != "production" {
		t.Fatalf("Expected environment 'production', got: %q", cfg.Environment)
	}

	// Invalid environment name must be rejected, not default to development
	envInvalid := map[string]string{
		"ENVIRONMENT": "prod",
	}
	_, errInvalid := LoadFromMap(func(k string) string { return envInvalid[k] })
	if !errors.Is(errInvalid, ErrInvalidEnvironment) {
		t.Fatalf("Expected ErrInvalidEnvironment for 'prod', got: %v", errInvalid)
	}
}

func TestConfigDevelopmentSQLiteFallback(t *testing.T) {
	env := map[string]string{
		"ENVIRONMENT": "development",
	}
	cfg, err := LoadFromMap(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("Unexpected error in development without DATABASE_URL: %v", err)
	}
	if cfg.Driver != "sqlite" {
		t.Fatalf("Expected driver 'sqlite', got: %s", cfg.Driver)
	}
	if !strings.Contains(cfg.DatabaseURL, "senora.db") {
		t.Fatalf("Expected fallback to senora.db, got: %s", cfg.DatabaseURL)
	}

	// Verify InitStorage works cleanly with SQLite in development
	store, err := cfg.InitStorage()
	if err != nil {
		t.Fatalf("Expected development SQLite InitStorage to succeed, got: %v", err)
	}
	_ = store.Close()
}

func TestConfigValidPostgreSQLRedaction(t *testing.T) {
	// Construct simulated credentials dynamically without embedding in static source
	user := "appuser"
	pass := "super_secret_dynamic_password_12345"
	host := "db.internal.net:5432"
	dbname := "senora_prod"
	dsn := "postgres://" + user + ":" + pass + "@" + host + "/" + dbname + "?sslmode=require"

	env := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   dsn,
		"SESSION_SECRET": "64_chars_hex_token_random_secret_entropy_check_secure_ok_12345678",
	}
	cfg, err := LoadFromMap(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("Expected valid production config to pass, got: %v", err)
	}
	if cfg.Driver != "postgres" {
		t.Fatalf("Expected driver 'postgres', got: %s", cfg.Driver)
	}

	redacted := cfg.RedactedDatabaseURL()
	if strings.Contains(redacted, pass) {
		t.Fatalf("Redacted URL leaked raw password! Redacted: %s", redacted)
	}
	if !strings.Contains(redacted, "REDACTED") && !strings.Contains(redacted, "*****") && !strings.Contains(redacted, "%2A%2A%2A%2A%2A") {
		t.Fatalf("Expected redaction indicator in URL, got: %s", redacted)
	}
	if !strings.Contains(redacted, user) || !strings.Contains(redacted, host) {
		t.Fatalf("Redacted URL lost host/user info: %s", redacted)
	}
}

func TestConfigPostgreSQLConnectionFailureTerminatesWithoutPasswordLeak(t *testing.T) {
	// Non-existent unreachable port on loopback
	user := "testuser"
	pass := "confidential_password_xyz987"
	dsn := "postgres://" + user + ":" + pass + "@127.0.0.1:54329/testdb?sslmode=disable&connect_timeout=1"

	env := map[string]string{
		"ENVIRONMENT":    "production",
		"DATABASE_URL":   dsn,
		"SESSION_SECRET": "64_chars_hex_token_random_secret_entropy_check_secure_ok_12345678",
	}
	cfg, err := LoadFromMap(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("Config load failed: %v", err)
	}

	// Must fail connection immediately without fallback to SQLite
	store, connErr := cfg.InitStorage()
	if connErr == nil {
		_ = store.Close()
		t.Fatalf("Expected connection failure to unreachable port 54329, got nil")
	}

	errStr := connErr.Error()
	if strings.Contains(errStr, pass) {
		t.Fatalf("Connection error leaked raw password! Error string: %s", errStr)
	}
	if !strings.Contains(errStr, "postgres") {
		t.Fatalf("Expected error message to mention postgres, got: %s", errStr)
	}
	if strings.Contains(errStr, "sqlite") {
		t.Fatalf("Silent fallback to SQLite detected! Error was: %s", errStr)
	}
}

func TestLoadFromActualEnv(t *testing.T) {
	// Test actual boundary with os.Getenv
	origEnv := os.Getenv("ENVIRONMENT")
	origDB := os.Getenv("DATABASE_URL")
	origSec := os.Getenv("SESSION_SECRET")
	defer func() {
		os.Setenv("ENVIRONMENT", origEnv)
		os.Setenv("DATABASE_URL", origDB)
		os.Setenv("SESSION_SECRET", origSec)
	}()

	os.Setenv("ENVIRONMENT", "production")
	os.Setenv("DATABASE_URL", "")
	os.Setenv("SESSION_SECRET", "")

	_, err := LoadFromEnv()
	if !errors.Is(err, ErrMissingDatabaseURL) {
		t.Fatalf("Expected ErrMissingDatabaseURL from real LoadFromEnv(), got: %v", err)
	}
}
