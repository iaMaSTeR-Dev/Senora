package api

import (
	"context"
	"fmt"
	"testing"
	"time"

	"nexachat/server/internal/models"
	"nexachat/server/internal/storage"
)

func BenchmarkRateLimiterAllow(b *testing.B) {
	rl := NewRateLimiter(100000, time.Minute)
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		ip := "192.168.1.100"
		for pb.Next() {
			_, _ = rl.Allow(ip)
		}
	})
}

func BenchmarkMessagePersistence(b *testing.B) {
	dsn := fmt.Sprintf("file:bench_test_%d?mode=memory&cache=shared", time.Now().UnixNano())
	store, err := storage.NewSQLStore("sqlite", dsn)
	if err != nil {
		b.Fatalf("Failed to init store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	user := &models.User{
		ID:           "bench_sender",
		Username:     "bench_user",
		DisplayName:  "Bench User",
		PasswordHash: "dummyhash",
	}
	_ = store.CreateUser(ctx, user)
	conv := &models.Conversation{
		ID:    "bench_conv_1",
		Type:  "direct",
		Title: "Bench Conv",
	}
	_ = store.CreateConversation(ctx, conv, []string{user.ID})

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		msg := &models.Message{
			ConversationID: conv.ID,
			SenderID:       user.ID,
			Ciphertext:     "bench_ciphertext_payload",
			Nonce:          "bench_nonce_123",
		}
		_, _, err := store.CreateMessageWithOutbox(ctx, msg, []string{user.ID})
		if err != nil {
			b.Fatalf("Failed to persist message: %v", err)
		}
	}
}
