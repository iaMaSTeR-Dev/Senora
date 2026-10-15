package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"senora/server/internal/models"
)

func TestAuditRemediation(t *testing.T) {
	server, _, store := setupTestServer(t)
	client := server.Client()

	regUser := func(username string) (string, string) {
		body, _ := json.Marshal(map[string]string{
			"username":     username,
			"display_name": username + " Display",
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

	ownerToken, ownerID := regUser("audit_owner")
	adminToken, adminID := regUser("audit_admin")
	memberToken, memberID := regUser("audit_member")

	// 1. Create a group conversation
	convReq, _ := json.Marshal(map[string]interface{}{
		"type":       "group",
		"title":      "Audit Security Group",
		"member_ids": []string{adminID, memberID},
		"is_e2ee":    false,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+ownerToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create conversation: %v", err)
	}
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	convID := convRes["id"].(string)

	// Owner promotes adminID to admin
	roleReq, _ := json.Marshal(map[string]string{"role": "admin"})
	req, _ = http.NewRequest("PUT", server.URL+"/api/v1/conversations/"+convID+"/members/"+adminID+"/role", bytes.NewReader(roleReq))
	req.Header.Set("Authorization", "Bearer "+ownerToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Owner failed to promote admin: %v, status: %d", err, resp.StatusCode)
	}

	// -------------------------------------------------------------
	// Test A: Role Update Authorization (RBAC security)
	// -------------------------------------------------------------
	t.Run("RBAC: Admin cannot demote owner or change roles", func(t *testing.T) {
		// Admin attempts to demote owner to member -> MUST FAIL (403 Forbidden)
		demoteOwnerReq, _ := json.Marshal(map[string]string{"role": "member"})
		req, _ = http.NewRequest("PUT", server.URL+"/api/v1/conversations/"+convID+"/members/"+ownerID+"/role", bytes.NewReader(demoteOwnerReq))
		req.Header.Set("Authorization", "Bearer "+adminToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil {
			t.Fatalf("Request error: %v", err)
		}
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("Expected 403 Forbidden when admin attempts to demote owner, got %d", resp.StatusCode)
		}

		// Owner attempts to demote self -> MUST FAIL (403 Forbidden)
		req, _ = http.NewRequest("PUT", server.URL+"/api/v1/conversations/"+convID+"/members/"+ownerID+"/role", bytes.NewReader(demoteOwnerReq))
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		req.Header.Set("Content-Type", "application/json")
		resp, _ = client.Do(req)
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("Expected 403 Forbidden when altering owner role, got %d", resp.StatusCode)
		}
	})

	// -------------------------------------------------------------
	// Test B: High-Entropy Invite Codes & Concurrency Limit
	// -------------------------------------------------------------
	t.Run("Invites: High Entropy and Usage Limits", func(t *testing.T) {
		invReq, _ := json.Marshal(map[string]interface{}{
			"max_uses":         1,
			"expires_in_hours": 2,
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/invites", bytes.NewReader(invReq))
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusCreated {
			t.Fatalf("Failed to create invite: %v, status: %d", err, resp.StatusCode)
		}
		var inv models.ConversationInvite
		_ = json.NewDecoder(resp.Body).Decode(&inv)

		// Verify 128-bit cryptographic entropy (inv_ + 32 hex chars)
		if !strings.HasPrefix(inv.InviteCode, "inv_") || len(inv.InviteCode) < 36 {
			t.Fatalf("Expected high-entropy invite code (inv_<32hex>), got %s (len: %d)", inv.InviteCode, len(inv.InviteCode))
		}

		// Create user 4 to join via invite
		u4Token, _ := regUser("audit_joiner_1")
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/invites/"+inv.InviteCode+"/join", nil)
		req.Header.Set("Authorization", "Bearer "+u4Token)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("First join should succeed, got status: %d", resp.StatusCode)
		}

		// Create user 5 to join via same invite -> MUST FAIL (usage limit exhausted)
		u5Token, _ := regUser("audit_joiner_2")
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/invites/"+inv.InviteCode+"/join", nil)
		req.Header.Set("Authorization", "Bearer "+u5Token)
		resp, err = client.Do(req)
		if err != nil {
			t.Fatalf("Request error: %v", err)
		}
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("Second join on max_uses=1 invite must fail with 400 Bad Request, got %d", resp.StatusCode)
		}
	})

	// -------------------------------------------------------------
	// Test C: Message Readers Tracking
	// -------------------------------------------------------------
	t.Run("Message Readers Inspection", func(t *testing.T) {
		// Owner sends a message to the group
		sendReq, _ := json.Marshal(map[string]interface{}{
			"conversation_id": convID,
			"ciphertext":      "Hello Audit Group",
			"nonce":           "plain",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(sendReq))
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusCreated {
			t.Fatalf("Failed to send message: %v, status: %d", err, resp.StatusCode)
		}
		var msgRes models.Message
		_ = json.NewDecoder(resp.Body).Decode(&msgRes)

		// Before anyone reads, readers list should be empty
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgRes.ID+"/readers", nil)
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Failed to get message readers: %v, status: %d", err, resp.StatusCode)
		}
		var readers []*models.User
		_ = json.NewDecoder(resp.Body).Decode(&readers)
		if len(readers) != 0 {
			t.Fatalf("Expected 0 readers initially, got %d", len(readers))
		}

		// Member marks conversation as read
		time.Sleep(10 * time.Millisecond)
		readReq, _ := json.Marshal(map[string]string{"message_id": msgRes.ID})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/read", bytes.NewReader(readReq))
		req.Header.Set("Authorization", "Bearer "+memberToken)
		req.Header.Set("Content-Type", "application/json")
		resp, _ = client.Do(req)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("Member failed to mark read: %d", resp.StatusCode)
		}

		// Now query readers again -> member should be present!
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgRes.ID+"/readers", nil)
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		resp, _ = client.Do(req)
		_ = json.NewDecoder(resp.Body).Decode(&readers)
		if len(readers) != 1 || readers[0].ID != memberID {
			t.Fatalf("Expected 1 reader (memberID %s), got %d readers", memberID, len(readers))
		}
	})

	// -------------------------------------------------------------
	// Test D: Bot Tokens & Authentication Lifecycle
	// -------------------------------------------------------------
	t.Run("Bot Tokens: Creation, Hashing, Validation, and Revocation", func(t *testing.T) {
		// 1. Create a bot token
		createBotReq, _ := json.Marshal(map[string]string{
			"name":  "Audit Test Bot",
			"scope": "messages:send",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/bots/tokens", bytes.NewReader(createBotReq))
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusCreated {
			t.Fatalf("Failed to create bot token: %v, status: %d", err, resp.StatusCode)
		}
		var botTokenRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&botTokenRes)
		rawToken := botTokenRes["token"].(string)
		tokenID := botTokenRes["id"].(string)

		if !strings.HasPrefix(rawToken, "bot_") || len(rawToken) < 68 {
			t.Fatalf("Expected 256-bit entropy token (bot_<64hex>), got %s", rawToken)
		}

		// 2. Send message using bot token
		botSendReq, _ := json.Marshal(map[string]string{
			"conversation_id": convID,
			"text":            "Message from Audit Bot",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/bot/sendMessage", bytes.NewReader(botSendReq))
		req.Header.Set("X-Bot-Token", rawToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusCreated {
			t.Fatalf("Bot send message failed: %v, status: %d", err, resp.StatusCode)
		}

		// 3. List bot tokens
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/bots/tokens", nil)
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Failed to list bot tokens: %v", err)
		}
		var tokensList []*models.BotToken
		_ = json.NewDecoder(resp.Body).Decode(&tokensList)
		if len(tokensList) != 1 || tokensList[0].ID != tokenID {
			t.Fatalf("Expected 1 bot token in list, got %d", len(tokensList))
		}

		// 4. Revoke bot token
		req, _ = http.NewRequest("DELETE", server.URL+"/api/v1/bots/tokens/"+tokenID, nil)
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Failed to revoke bot token: %v, status: %d", err, resp.StatusCode)
		}

		// 5. Try to send message with revoked token -> MUST FAIL (401 Unauthorized)
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/bot/sendMessage", bytes.NewReader(botSendReq))
		req.Header.Set("X-Bot-Token", rawToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil {
			t.Fatalf("Request error: %v", err)
		}
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("Expected 401 Unauthorized for revoked bot token, got %d", resp.StatusCode)
		}
	})

	// -------------------------------------------------------------
	// Test E: SSRF Defenses on Webhooks
	// -------------------------------------------------------------
	t.Run("Bot Webhooks: SSRF Defenses", func(t *testing.T) {
		// Valid token
		createBotReq, _ := json.Marshal(map[string]string{
			"name":  "SSRF Bot",
			"scope": "messages:send",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/bots/tokens", bytes.NewReader(createBotReq))
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		req.Header.Set("Content-Type", "application/json")
		resp, _ = client.Do(req)
		var botTokenRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&botTokenRes)
		botToken := botTokenRes["token"].(string)

		ssrfTargets := []string{
			"http://127.0.0.1:8080/hook",
			"http://localhost:3000/hook",
			"http://169.254.169.254/latest/meta-data",
			"http://10.0.0.1/hook",
			"http://192.168.1.1/hook",
			"http://[::1]/hook",
			"ftp://example.com/hook",
		}

		for _, target := range ssrfTargets {
			whReq, _ := json.Marshal(map[string]string{
				"url": target,
			})
			req, _ = http.NewRequest("POST", server.URL+"/api/v1/bot/setWebhook", bytes.NewReader(whReq))
			req.Header.Set("X-Bot-Token", botToken)
			req.Header.Set("Content-Type", "application/json")
			resp, err = client.Do(req)
			if err != nil {
				t.Fatalf("Request error on %s: %v", target, err)
			}
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("SSRF Target %s was not rejected! Got status: %d", target, resp.StatusCode)
			}
		}
	})

	// -------------------------------------------------------------
	// Test F: Disappearing Messages Physical Pruning
	// -------------------------------------------------------------
	t.Run("Disappearing Messages: Physical DB Pruning", func(t *testing.T) {
		pastTime := time.Now().UTC().Add(-1 * time.Hour)
		expiredMsg := &models.Message{
			ID:             "msg_exp_" + time.Now().Format("150405"),
			ConversationID: convID,
			SenderID:       ownerID,
			Ciphertext:     "Expiring message",
			Nonce:          "plain",
			ExpiresAt:      &pastTime,
			CreatedAt:      pastTime.Add(-10 * time.Minute),
		}

		members, _ := store.GetConversationMembers(context.Background(), convID)
		_, _, err := store.CreateMessageWithOutbox(context.Background(), expiredMsg, members)
		if err != nil {
			t.Fatalf("Failed to insert expired test message: %v", err)
		}

		// Purge expired messages
		purged, err := store.PurgeExpiredMessages(context.Background())
		if err != nil {
			t.Fatalf("Failed to purge expired messages: %v", err)
		}
		if purged < 1 {
			t.Fatalf("Expected at least 1 purged message, got %d", purged)
		}

		// Verify message is physically gone from database
		_, err = store.GetMessageByID(context.Background(), expiredMsg.ID)
		if err == nil {
			t.Fatalf("Expired message should have been physically deleted from database!")
		}
	})
}
