package storage

import (
	"context"
	"os"
	"testing"
	"time"

	"nexachat/server/internal/models"
)

func newTestStore(t *testing.T) Store {
	driver := "sqlite"
	dsn := "file:memdb_" + time.Now().Format("150405.000000") + "?mode=memory&cache=shared"
	if testDB := os.Getenv("TEST_DATABASE_URL"); testDB != "" {
		driver = "postgres"
		dsn = testDB
	}
	store, err := NewSQLStore(driver, dsn)
	if err != nil {
		t.Fatalf("Failed to initialize test store (%s): %v", driver, err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	return store
}

func TestUserAndDeviceLifecycle(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)

	user := &models.User{
		Username:     "alice",
		DisplayName:  "Alice Smith",
		PasswordHash: "fake_hash_123",
	}

	if err := store.CreateUser(ctx, user); err != nil {
		t.Fatalf("CreateUser failed: %v", err)
	}

	// Duplicate username should fail
	dupUser := &models.User{
		Username:     "alice",
		DisplayName:  "Alice Clone",
		PasswordHash: "fake_hash_456",
	}
	if err := store.CreateUser(ctx, dupUser); err != ErrAlreadyExists {
		t.Fatalf("Expected ErrAlreadyExists, got: %v", err)
	}

	// Fetch by ID
	fetched, err := store.GetUserByID(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetUserByID failed: %v", err)
	}
	if fetched.Username != "alice" || fetched.DisplayName != "Alice Smith" {
		t.Fatalf("Unexpected user data: %+v", fetched)
	}

	// Create Device
	device := &models.Device{
		UserID:     user.ID,
		DeviceName: "Chrome on Windows",
	}
	if err := store.CreateDevice(ctx, device); err != nil {
		t.Fatalf("CreateDevice failed: %v", err)
	}

	devices, err := store.GetDevicesByUserID(ctx, user.ID)
	if err != nil || len(devices) != 1 {
		t.Fatalf("Expected 1 device, got %d (err: %v)", len(devices), err)
	}

	// Update public key
	if err := store.UpdateDeviceKey(ctx, device.ID, "pubkey_p256_base64"); err != nil {
		t.Fatalf("UpdateDeviceKey failed: %v", err)
	}

	updatedDev, err := store.GetDeviceByID(ctx, device.ID)
	if err != nil || updatedDev.IdentityPublicKey != "pubkey_p256_base64" {
		t.Fatalf("Expected updated pubkey, got: %+v", updatedDev)
	}
}

func TestConversationAndMessagesWithOutbox(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)

	u1 := &models.User{Username: "user1", DisplayName: "User One", PasswordHash: "hash1"}
	u2 := &models.User{Username: "user2", DisplayName: "User Two", PasswordHash: "hash2"}
	_ = store.CreateUser(ctx, u1)
	_ = store.CreateUser(ctx, u2)

	conv := &models.Conversation{Type: "direct"}
	if err := store.CreateConversation(ctx, conv, []string{u1.ID, u2.ID}); err != nil {
		t.Fatalf("CreateConversation failed: %v", err)
	}

	// Verify membership
	isMem, err := store.IsMember(ctx, conv.ID, u1.ID)
	if err != nil || !isMem {
		t.Fatalf("Expected u1 to be member, got %v (err: %v)", isMem, err)
	}

	isMem, err = store.IsMember(ctx, conv.ID, "non_existent_user")
	if err != nil || isMem {
		t.Fatalf("Expected false for non-member, got %v", isMem)
	}

	// Submit message with outbox
	msg := &models.Message{
		ConversationID: conv.ID,
		SenderID:       u1.ID,
		Ciphertext:     "ciphertext_base64_blob",
		Nonce:          "nonce_12byte_base64",
		IdempotencyKey: "idemp-uuid-1111",
	}

	savedMsg, _, err := store.CreateMessageWithOutbox(ctx, msg, []string{u1.ID, u2.ID})
	if err != nil {
		t.Fatalf("CreateMessageWithOutbox failed: %v", err)
	}
	if savedMsg.ID == "" {
		t.Fatal("Expected saved message to have an ID")
	}

	// Idempotent retry with same key
	dupMsg, _, err := store.CreateMessageWithOutbox(ctx, msg, []string{u1.ID, u2.ID})
	if err != nil {
		t.Fatalf("Idempotent submission failed: %v", err)
	}
	if dupMsg.ID != savedMsg.ID {
		t.Fatalf("Expected same message ID %s, got %s", savedMsg.ID, dupMsg.ID)
	}

	// Verify outbox events for recipient u2
	events, err := store.GetOutboxEventsAfter(ctx, u2.ID, 0, 10)
	if err != nil {
		t.Fatalf("GetOutboxEventsAfter failed: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("Expected 1 outbox event for u2, got %d", len(events))
	}
	if events[0].EventType != "message.created" {
		t.Fatalf("Unexpected event type: %s", events[0].EventType)
	}

	// Verify messages list
	msgs, err := store.GetMessages(ctx, conv.ID, "", 10)
	if err != nil || len(msgs) != 1 {
		t.Fatalf("Expected 1 message, got %d (err: %v)", len(msgs), err)
	}
	if msgs[0].Ciphertext != "ciphertext_base64_blob" {
		t.Fatalf("Unexpected ciphertext: %s", msgs[0].Ciphertext)
	}
}
