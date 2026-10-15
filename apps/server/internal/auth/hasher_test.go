package auth

import (
	"testing"
)

func TestHashAndComparePassword(t *testing.T) {
	password := "UltraSecureP@ssw0rd123!"

	// Use faster parameters for unit test speed
	fastParams := &HashParams{
		Memory:      16 * 1024,
		Iterations:  1,
		Parallelism: 1,
		SaltLength:  16,
		KeyLength:   32,
	}

	hash, err := HashPassword(password, fastParams)
	if err != nil {
		t.Fatalf("Failed to hash password: %v", err)
	}

	if len(hash) == 0 {
		t.Fatal("Expected non-empty hash string")
	}

	// Verify valid password
	match, err := ComparePassword(password, hash)
	if err != nil {
		t.Fatalf("ComparePassword failed: %v", err)
	}
	if !match {
		t.Fatal("Expected password to match")
	}

	// Verify incorrect password
	match, err = ComparePassword("WrongPassword123!", hash)
	if err != nil {
		t.Fatalf("ComparePassword failed: %v", err)
	}
	if match {
		t.Fatal("Expected incorrect password not to match")
	}
}

func TestMalformedHash(t *testing.T) {
	_, err := ComparePassword("secret", "not-a-valid-argon2-hash")
	if err == nil {
		t.Fatal("Expected error on malformed hash, got nil")
	}
}

func BenchmarkArgon2idFast(b *testing.B) {
	fastParams := &HashParams{
		Memory:      16 * 1024,
		Iterations:  1,
		Parallelism: 1,
		SaltLength:  16,
		KeyLength:   32,
	}
	password := "BenchmarkPassword123!"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		hash, err := HashPassword(password, fastParams)
		if err != nil {
			b.Fatal(err)
		}
		_, _ = ComparePassword(password, hash)
	}
}

func BenchmarkArgon2idProductionParams(b *testing.B) {
	password := "BenchmarkPassword123!"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		hash, err := HashPassword(password, DefaultParams)
		if err != nil {
			b.Fatal(err)
		}
		_, _ = ComparePassword(password, hash)
	}
}
