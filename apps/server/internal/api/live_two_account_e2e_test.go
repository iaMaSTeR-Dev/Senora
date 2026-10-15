package api

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"testing"
	"time"
)

func TestLiveTwoAccountFullEndToEnd(t *testing.T) {
	server, _, store := setupTestServer(t)
	client := server.Client()

	// Helper to register user
	registerUser := func(username, password string) (string, string) {
		body, _ := json.Marshal(map[string]string{
			"username":     username,
			"display_name": username + " Display",
			"password":     password,
			"device_name":  username + " Test Device",
		})
		resp, err := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(body))
		if err != nil || resp.StatusCode != http.StatusCreated {
			t.Fatalf("Failed to register %s: err=%v status=%d", username, err, resp.StatusCode)
		}
		var res map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&res)
		token := res["token"].(string)
		user := res["user"].(map[string]interface{})
		return token, user["id"].(string)
	}

	// 1. Register Alice and Bob
	aliceToken, aliceID := registerUser("alice_live", "Password123!")
	bobToken, bobID := registerUser("bob_live", "Password123!")
	eveToken, _ := registerUser("eve_live", "Password123!")

	// 2. Alice creates a Direct Conversation with Bob
	convReq, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Alice failed to create direct conversation: %v status=%d", err, resp.StatusCode)
	}
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	convID := convRes["id"].(string)

	// 3. Alice sends a message to Bob
	msgReq, _ := json.Marshal(map[string]string{
		"ciphertext": "Hello Bob, live e2e test",
		"nonce":      "normal",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(msgReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Alice failed to send message: %v status=%d", err, resp.StatusCode)
	}
	var msgRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&msgRes)
	msgID := msgRes["id"].(string)

	// 4. Bob reads messages in conversation
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob failed to get messages: %v status=%d", err, resp.StatusCode)
	}
	var msgsRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&msgsRes)
	items := msgsRes["messages"].([]interface{})
	if len(items) == 0 {
		t.Fatalf("Bob saw 0 messages, expected at least 1")
	}

	// 5. Bob replies to Alice's message
	replyReq, _ := json.Marshal(map[string]string{
		"ciphertext":  "Hi Alice, received loud and clear",
		"nonce":       "normal",
		"reply_to_id": msgID,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(replyReq))
	req.Header.Set("Authorization", "Bearer "+bobToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Bob failed to reply: %v status=%d", err, resp.StatusCode)
	}

	// 6. Alice creates a Poll
	pollReq, _ := json.Marshal(map[string]interface{}{
		"question":        "Lunch preference?",
		"options":         []string{"Pizza", "Sushi", "Salad"},
		"allows_multiple": false,
		"is_anonymous":    false,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/polls", bytes.NewReader(pollReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Alice failed to create poll: %v status=%d", err, resp.StatusCode)
	}
	var pollRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&pollRes)
	pollID := pollRes["id"].(string)

	// 7. Bob votes for option 0 (Pizza)
	voteReq, _ := json.Marshal(map[string]interface{}{
		"option_id": 0,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/polls/"+pollID+"/vote", bytes.NewReader(voteReq))
	req.Header.Set("Authorization", "Bearer "+bobToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob failed to vote on poll: %v status=%d", err, resp.StatusCode)
	}
	var votedPoll map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&votedPoll)
	if int(votedPoll["total_votes"].(float64)) != 1 {
		t.Fatalf("Expected 1 total vote on poll, got %v", votedPoll["total_votes"])
	}

	// 8. Eve attempts to access the conversation -> 403 Forbidden
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for Eve accessing conversation, got %d", resp.StatusCode)
	}

	// 9. Eve attempts to vote on the poll -> 403 Forbidden
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/polls/"+pollID+"/vote", bytes.NewReader(voteReq))
	req.Header.Set("Authorization", "Bearer "+eveToken)
	req.Header.Set("Content-Type", "application/json")
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for Eve voting on poll, got %d", resp.StatusCode)
	}

	// 10. Alice uploads an attachment
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	w.WriteField("conversation_id", convID)
	w.WriteField("is_encrypted", "false")
	part, _ := w.CreateFormFile("file", "notes.txt")
	part.Write([]byte("Confidential Project Notes"))
	w.Close()

	req, _ = http.NewRequest("POST", server.URL+"/api/v1/attachments", &b)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Alice failed to upload attachment: %v status=%d", err, resp.StatusCode)
	}
	var attachRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&attachRes)
	attachID := attachRes["id"].(string)

	// 11. Bob downloads the attachment -> 200 OK
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/attachments/"+attachID, nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob failed to download attachment: %v status=%d", err, resp.StatusCode)
	}
	resp.Body.Close()

	// 12. Eve tries to download the attachment -> 403 Forbidden
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/attachments/"+attachID, nil)
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for Eve downloading attachment, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 13. Alice schedules a message
	futureTime := time.Now().UTC().Add(1 * time.Hour).Format(time.RFC3339)
	schedReq, _ := json.Marshal(map[string]interface{}{
		"ciphertext":    "Scheduled reminder message",
		"nonce":         "normal",
		"scheduled_for": futureTime,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/scheduled", bytes.NewReader(schedReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Alice failed to schedule message: %v status=%d", err, resp.StatusCode)
	}
	resp.Body.Close()

	// 14. Eve attempts to send a message to Alice & Bob's conversation -> 403 Forbidden
	eveSendReq, _ := json.Marshal(map[string]string{
		"ciphertext": "Eve eavesdropping and injecting",
		"nonce":      "normal",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(eveSendReq))
	req.Header.Set("Authorization", "Bearer "+eveToken)
	req.Header.Set("Content-Type", "application/json")
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for Eve injecting message, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 15. Eve attempts to delete Alice's message -> 403 Forbidden
	req, _ = http.NewRequest("DELETE", server.URL+"/api/v1/conversations/"+convID+"/messages/"+msgID, nil)
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for Eve deleting Alice's message, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 16. Verify real persistence at storage layer
	persistedMsg, err := store.GetMessageByID(context.Background(), msgID)
	if err != nil {
		t.Fatalf("Failed to fetch persisted message directly from store: %v", err)
	}
	if persistedMsg.SenderID != aliceID {
		t.Fatalf("Persisted sender mismatch: expected %s, got %s", aliceID, persistedMsg.SenderID)
	}
	if persistedMsg.Ciphertext != "Hello Bob, live e2e test" {
		t.Fatalf("Persisted ciphertext mismatch: %s", persistedMsg.Ciphertext)
	}
	if persistedMsg.Nonce != "normal" {
		t.Fatalf("Persisted nonce mismatch: %s", persistedMsg.Nonce)
	}

	// 17. Bob logs out -> token invalidated
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob failed to logout: %v status=%d", err, resp.StatusCode)
	}
	resp.Body.Close()

	// Bob's revoked token cannot fetch messages anymore -> 401 Unauthorized
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 Unauthorized after Bob logout, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 18. Alice logs out -> token invalidated
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Alice failed to logout: %v status=%d", err, resp.StatusCode)
	}
	resp.Body.Close()

	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 Unauthorized after Alice logout, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}
