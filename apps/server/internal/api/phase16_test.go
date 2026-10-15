package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

func TestPhase16Features(t *testing.T) {
	server, _, _ := setupTestServer(t)
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

	aliceToken, aliceID := regUser("alice_p16")
	bobToken, bobID := regUser("bob_p16")
	charlieToken, _ := regUser("charlie_p16")

	// 1. Create a group conversation: Alice (owner) + Bob (member)
	convReq, _ := json.Marshal(map[string]interface{}{
		"type":       "group",
		"title":      "Phase 16 Testing Group",
		"member_ids": []string{bobID},
		"is_e2ee":    false,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create conversation: %v, status: %d", err, resp.StatusCode)
	}
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	convID := convRes["id"].(string)

	// 2. Test Member Role Promotion & Demotion
	t.Run("Update Member Role", func(t *testing.T) {
		// Non-admin (Bob) tries to promote himself -> Should fail 403
		roleBody, _ := json.Marshal(map[string]string{"role": "admin"})
		req, _ = http.NewRequest("PUT", server.URL+"/api/v1/conversations/"+convID+"/members/"+bobID+"/role", bytes.NewReader(roleBody))
		req.Header.Set("Authorization", "Bearer "+bobToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("Expected 403 Forbidden when non-admin changes role, got %d", resp.StatusCode)
		}

		// Owner (Alice) promotes Bob to admin -> Should succeed 200
		req, _ = http.NewRequest("PUT", server.URL+"/api/v1/conversations/"+convID+"/members/"+bobID+"/role", bytes.NewReader(roleBody))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK when owner changes role, got %d", resp.StatusCode)
		}
	})

	// 3. Test Authentic Conversation Invites
	var inviteCode string
	t.Run("Conversation Invites Workflow", func(t *testing.T) {
		// Alice creates invite link with max_uses=2 and expiry=48h
		invReq, _ := json.Marshal(map[string]interface{}{
			"max_uses":         2,
			"expires_in_hours": 48,
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/invites", bytes.NewReader(invReq))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusCreated {
			t.Fatalf("Expected 201 Created for invite creation, got %d", resp.StatusCode)
		}
		var invRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&invRes)
		inviteCode = invRes["invite_code"].(string)
		if inviteCode == "" {
			t.Fatalf("Invite code is empty")
		}

		// List invites as Alice -> Should show 1 invite
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/invites", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK listing invites, got %d", resp.StatusCode)
		}

		// Charlie previews invite
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/invites/"+inviteCode, nil)
		req.Header.Set("Authorization", "Bearer "+charlieToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK previewing invite, got %d", resp.StatusCode)
		}
		var prevRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&prevRes)
		if prevRes["title"] != "Phase 16 Testing Group" {
			t.Fatalf("Expected preview title 'Phase 16 Testing Group', got %v", prevRes["title"])
		}

		// Charlie joins via invite code
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/invites/"+inviteCode+"/join", nil)
		req.Header.Set("Authorization", "Bearer "+charlieToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK joining via invite, got %d", resp.StatusCode)
		}
	})

	// 4. Test Read Receipts & Unread Counts
	t.Run("Read Receipts and Unread Counts", func(t *testing.T) {
		// Alice sends 2 messages
		for i := 1; i <= 2; i++ {
			msgReq, _ := json.Marshal(map[string]interface{}{
				"ciphertext": "Hello message number " + string(rune('0'+i)),
				"nonce":      "normal",
			})
			req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(msgReq))
			req.Header.Set("Authorization", "Bearer "+aliceToken)
			req.Header.Set("Content-Type", "application/json")
			resp, _ = client.Do(req)
			if resp.StatusCode != http.StatusCreated {
				t.Fatalf("Failed to send message: %d", resp.StatusCode)
			}
		}

		// Bob checks his conversation list -> unread_count should be 2
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations", nil)
		req.Header.Set("Authorization", "Bearer "+bobToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Failed to get conversations for Bob: %d", resp.StatusCode)
		}
		var convListRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&convListRes)
		convs := convListRes["conversations"].([]interface{})
		foundConv := false
		for _, raw := range convs {
			c := raw.(map[string]interface{})
			if c["id"] == convID {
				foundConv = true
				unreadCount := int(c["unread_count"].(float64))
				if unreadCount != 2 {
					t.Fatalf("Expected Bob unread count 2, got %d", unreadCount)
				}
			}
		}
		if !foundConv {
			t.Fatalf("Conversation %s not found in Bob's list", convID)
		}

		// Bob marks conversation read
		markReq, _ := json.Marshal(map[string]interface{}{})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/read", bytes.NewReader(markReq))
		req.Header.Set("Authorization", "Bearer "+bobToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK marking conversation read, got %d", resp.StatusCode)
		}

		// Bob checks conversation list again -> unread_count should be 0
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations", nil)
		req.Header.Set("Authorization", "Bearer "+bobToken)
		resp, _ = client.Do(req)
		var convsAfterRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&convsAfterRes)
		convsAfter := convsAfterRes["conversations"].([]interface{})
		for _, raw := range convsAfter {
			c := raw.(map[string]interface{})
			if c["id"] == convID {
				unreadCount := int(c["unread_count"].(float64))
				if unreadCount != 0 {
					t.Fatalf("Expected Bob unread count 0 after mark read, got %d", unreadCount)
				}
			}
		}

		// Alice checks messages -> Bob has read, so messages should have is_read = true
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, _ = client.Do(req)
		var msgListRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&msgListRes)
		msgs := msgListRes["messages"].([]interface{})
		if len(msgs) < 2 {
			t.Fatalf("Expected at least 2 messages, got %d", len(msgs))
		}
		for _, raw := range msgs {
			m := raw.(map[string]interface{})
			if m["is_read"] != true {
				t.Fatalf("Expected message %v to have is_read=true", m["id"])
			}
		}
	})

	// 5. Test Channel Message Views
	t.Run("Channel Post Views", func(t *testing.T) {
		// Alice posts a message
		msgReq, _ := json.Marshal(map[string]interface{}{
			"ciphertext": "Channel post announcement",
			"nonce":      "normal",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(msgReq))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, _ = client.Do(req)
		var postMsg map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&postMsg)
		postID := postMsg["id"].(string)

		// Bob views the message
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages/"+postID+"/view", nil)
		req.Header.Set("Authorization", "Bearer "+bobToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK recording view, got %d", resp.StatusCode)
		}
		var viewRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&viewRes)
		if int(viewRes["views_count"].(float64)) < 1 {
			t.Fatalf("Expected views_count >= 1, got %v", viewRes["views_count"])
		}
	})

	// 6. Test Disappearing Messages (TTL)
	t.Run("Disappearing Message TTL Setting", func(t *testing.T) {
		ttlReq, _ := json.Marshal(map[string]int{"ttl": 3600})
		req, _ = http.NewRequest("PUT", server.URL+"/api/v1/conversations/"+convID+"/ttl", bytes.NewReader(ttlReq))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK setting conversation TTL, got %d", resp.StatusCode)
		}
	})

	// 7. Test Global Search
	t.Run("Global Search", func(t *testing.T) {
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/search?q=Phase", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK for global search, got %d", resp.StatusCode)
		}
		var searchRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&searchRes)
		convs := searchRes["conversations"].([]interface{})
		if len(convs) == 0 {
			t.Fatalf("Expected to find conversation in search results")
		}
	})

	// 8. Test Presence & Last Seen
	t.Run("User Presence", func(t *testing.T) {
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/presence/"+aliceID, nil)
		req.Header.Set("Authorization", "Bearer "+bobToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK for presence, got %d", resp.StatusCode)
		}
		var presRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&presRes)
		if presRes["user_id"] != aliceID {
			t.Fatalf("Expected user_id %s, got %v", aliceID, presRes["user_id"])
		}
	})

	// 9. Test WebRTC Dynamic ICE Servers
	t.Run("WebRTC ICE Servers", func(t *testing.T) {
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/webrtc/ice-servers", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK for ice-servers, got %d", resp.StatusCode)
		}
		var iceList []map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&iceList)
		if len(iceList) == 0 {
			t.Fatalf("Expected at least 1 ICE server configuration")
		}
	})
}
