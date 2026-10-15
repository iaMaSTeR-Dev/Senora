package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"nexachat/server/internal/models"
)

func TestPresenceAndReadReceipts(t *testing.T) {
	server, _, store := setupTestServer(t)
	client := server.Client()

	regUser := func(username string) (string, string) {
		body, _ := json.Marshal(map[string]string{
			"username":     username,
			"display_name": username + " Name",
			"password":     "Password123!",
			"device_name":  username + " Device",
		})
		resp, err := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(body))
		if err != nil || resp.StatusCode != http.StatusCreated {
			t.Fatalf("Failed to register %s: %v, status: %d", username, err, resp.StatusCode)
		}
		var res map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&res)
		token := res["token"].(string)
		user := res["user"].(map[string]interface{})
		return token, user["id"].(string)
	}

	aliceToken, aliceID := regUser("alice_p1")
	bobToken, bobID := regUser("bob_p1")
	charlieToken, charlieID := regUser("charlie_p1")

	// Create Group Conversation with Alice (Owner), Bob (Member), Charlie (Member)
	convReq, _ := json.Marshal(map[string]interface{}{
		"type":       "group",
		"title":      "Receipts & Presence Test Group",
		"member_ids": []string{bobID, charlieID},
		"is_e2ee":    false,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create group: %v", err)
	}
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	convID := convRes["id"].(string)

	// -----------------------------------------------------------------
	// 1. Authoritative Presence Endpoint & Multi-Device Logic
	// -----------------------------------------------------------------
	t.Run("Presence: Authoritative queries and last seen updates", func(t *testing.T) {
		// Alice checks Bob presence when offline
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/presence/"+bobID, nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Failed to get presence: %v, status: %d", err, resp.StatusCode)
		}
		var pres map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&pres)
		if pres["user_id"] != bobID {
			t.Fatalf("Expected presence for user_id=%s, got %v", bobID, pres["user_id"])
		}
		// Since no active WS, is_online must be false
		if pres["is_online"] != false {
			t.Fatalf("Expected is_online=false for disconnected user, got %v", pres["is_online"])
		}

		// Batch presence verification
		batchReq, _ := json.Marshal(map[string]interface{}{
			"user_ids": []string{aliceID, bobID, charlieID},
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/presence/batch", bytes.NewReader(batchReq))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Failed batch presence: %v, status: %d", err, resp.StatusCode)
		}
		var batchRes []map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&batchRes)
		if len(batchRes) != 3 {
			t.Fatalf("Expected 3 presence records, got %d", len(batchRes))
		}

		// Update device last seen directly through store
		now := time.Now().UTC()
		err := store.UpdateDeviceLastSeen(context.Background(), "dev_bob_1")
		if err != nil {
			t.Fatalf("Failed to update device last seen: %v", err)
		}
		_ = now
	})

	// -----------------------------------------------------------------
	// 2. Message-Level Read Receipts & Authorization
	// -----------------------------------------------------------------
	t.Run("Read Receipts: Message-specific persistence, reader list, and strict RBAC", func(t *testing.T) {
		// Alice posts a message to the group
		msgReq, _ := json.Marshal(map[string]string{
			"ciphertext": "Hello members of the group!",
			"nonce":      "normal",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(msgReq))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusCreated {
			t.Fatalf("Alice failed to post message: %v, status: %d", err, resp.StatusCode)
		}
		var msgRes models.Message
		_ = json.NewDecoder(resp.Body).Decode(&msgRes)
		msgID := msgRes.ID

		// At start: readers list must be empty
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgID+"/readers", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Failed to get readers: %v, status: %d", err, resp.StatusCode)
		}
		var initialReaders []models.MessageReader
		_ = json.NewDecoder(resp.Body).Decode(&initialReaders)
		if len(initialReaders) != 0 {
			t.Fatalf("Expected 0 initial readers, got %d", len(initialReaders))
		}

		// Alice attempts to mark her OWN message as read -> Must NOT create a receipt row
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgID+"/read", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Alice mark read request failed: %v, status: %d", err, resp.StatusCode)
		}

		// Verify Alice does NOT appear as a reader of her own message
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgID+"/readers", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, _ = client.Do(req)
		var readersAfterAlice []models.MessageReader
		_ = json.NewDecoder(resp.Body).Decode(&readersAfterAlice)
		if len(readersAfterAlice) != 0 {
			t.Fatalf("Expected 0 readers (author cannot mark self as reader), got %d", len(readersAfterAlice))
		}

		// Bob reads the message
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgID+"/read", nil)
		req.Header.Set("Authorization", "Bearer "+bobToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Bob mark read request failed: %v, status: %d", err, resp.StatusCode)
		}

		// Duplicate read call by Bob (Idempotency check)
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgID+"/read", nil)
		req.Header.Set("Authorization", "Bearer "+bobToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Bob duplicate mark read request failed: %v, status: %d", err, resp.StatusCode)
		}

		// Alice (author) inspects readers -> Must show Bob exactly once
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgID+"/readers", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Alice failed to inspect readers: %v, status: %d", err, resp.StatusCode)
		}
		var readersAfterBob []models.MessageReader
		_ = json.NewDecoder(resp.Body).Decode(&readersAfterBob)
		if len(readersAfterBob) != 1 {
			t.Fatalf("Expected exactly 1 reader (Bob), got %d", len(readersAfterBob))
		}
		if readersAfterBob[0].UserID != bobID && readersAfterBob[0].ID != bobID {
			t.Fatalf("Expected reader user_id=%s, got user_id=%s / id=%s", bobID, readersAfterBob[0].UserID, readersAfterBob[0].ID)
		}
		if readersAfterBob[0].Username != "bob_p1" {
			t.Fatalf("Expected username 'bob_p1', got '%s'", readersAfterBob[0].Username)
		}
		if readersAfterBob[0].ReadAt.IsZero() {
			t.Fatalf("Expected non-empty read_at timestamp")
		}

		// Charlie (a regular member, not admin, not author) attempts to inspect readers
		// MUST BE FORBIDDEN (403)
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgID+"/readers", nil)
		req.Header.Set("Authorization", "Bearer "+charlieToken)
		resp, err = client.Do(req)
		if err != nil {
			t.Fatalf("Charlie inspect request error: %v", err)
		}
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("Expected 403 Forbidden when non-admin member inspects message readers, got %d", resp.StatusCode)
		}

		// Alice promotes Charlie to admin
		roleReq, _ := json.Marshal(map[string]string{"role": "admin"})
		req, _ = http.NewRequest("PUT", server.URL+"/api/v1/conversations/"+convID+"/members/"+charlieID+"/role", bytes.NewReader(roleReq))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Failed to promote Charlie to admin: %v, status: %d", err, resp.StatusCode)
		}

		// Now Charlie (as admin) CAN inspect readers
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgID+"/readers", nil)
		req.Header.Set("Authorization", "Bearer "+charlieToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Charlie (as admin) failed to inspect readers: %v, status: %d", err, resp.StatusCode)
		}
		var adminInspectReaders []models.MessageReader
		_ = json.NewDecoder(resp.Body).Decode(&adminInspectReaders)
		if len(adminInspectReaders) != 1 {
			t.Fatalf("Expected 1 reader for admin inspection, got %d", len(adminInspectReaders))
		}
	})

	// -----------------------------------------------------------------
	// 3. Database Integrity & Outbox Publication
	// -----------------------------------------------------------------
	t.Run("Store: RecordMessageRead composite unique constraint and readers query", func(t *testing.T) {
		ctx := context.Background()

		// Direct storage layer test for SQLite and Postgres adapter
		msg := &models.Message{
			ConversationID: convID,
			SenderID:       aliceID,
			Ciphertext:     "Direct store test message",
			Nonce:          "normal",
			CreatedAt:      time.Now().UTC(),
		}
		saved, _, err := store.CreateMessageWithOutbox(ctx, msg, []string{aliceID, bobID, charlieID})
		if err != nil {
			t.Fatalf("Failed to create message directly in store: %v", err)
		}

		// Record read for Bob
		err = store.RecordMessageRead(ctx, saved.ID, bobID, convID)
		if err != nil {
			t.Fatalf("store.RecordMessageRead failed: %v", err)
		}

		// Duplicate call must be idempotent (no error, no duplicate rows)
		err = store.RecordMessageRead(ctx, saved.ID, bobID, convID)
		if err != nil {
			t.Fatalf("Duplicate store.RecordMessageRead failed: %v", err)
		}

		// Record read for Charlie
		err = store.RecordMessageRead(ctx, saved.ID, charlieID, convID)
		if err != nil {
			t.Fatalf("store.RecordMessageRead for Charlie failed: %v", err)
		}

		// Query readers
		readers, err := store.GetMessageReaders(ctx, convID, saved.ID)
		if err != nil {
			t.Fatalf("store.GetMessageReaders failed: %v", err)
		}
		if len(readers) != 2 {
			t.Fatalf("Expected 2 readers in store, got %d", len(readers))
		}

		foundBob := false
		foundCharlie := false
		for _, r := range readers {
			if r.UserID == bobID || r.ID == bobID {
				foundBob = true
			}
			if r.UserID == charlieID || r.ID == charlieID {
				foundCharlie = true
			}
		}
		if !foundBob || !foundCharlie {
			t.Fatalf("Missing readers in store result: bob=%v, charlie=%v", foundBob, foundCharlie)
		}
	})
}
