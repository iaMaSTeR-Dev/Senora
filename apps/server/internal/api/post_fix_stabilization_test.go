package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"senora/server/internal/models"
)

func TestPostFixStabilizationVerification(t *testing.T) {
	server, _, _ := setupTestServer(t)
	client := server.Client()

	registerUser := func(username string) (string, string) {
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

	aliceToken, aliceID := registerUser("alice_stab")
	bobToken, bobID := registerUser("bob_stab")
	charlieToken, charlieID := registerUser("charlie_stab")

	// 1. Direct conversation between Alice and Bob
	convReq, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create direct conversation: %v, status: %d", err, resp.StatusCode)
	}
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	directConvID := convRes["id"].(string)

	// Helper to dial WS
	dialWS := func(token string) (*websocket.Conn, error) {
		wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + token
		dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
		conn, _, err := dialer.Dial(wsURL, nil)
		return conn, err
	}

	// -----------------------------------------------------------------
	// Test A: Presence Multi-Session & Disconnect/Reconnect Lifecycles
	// -----------------------------------------------------------------
	// -----------------------------------------------------------------
	// Test A: Presence Multi-Session & Disconnect/Reconnect Lifecycles
	// -----------------------------------------------------------------
	t.Run("Presence Lifecycle and Race Avoidance", func(t *testing.T) {
		getPres := func(targetID string) bool {
			req, _ := http.NewRequest("GET", server.URL+"/api/v1/presence/"+targetID, nil)
			req.Header.Set("Authorization", "Bearer "+aliceToken)
			resp, err := client.Do(req)
			if err != nil || resp.StatusCode != http.StatusOK {
				t.Fatalf("Failed to get presence for %s: %v, status: %d", targetID, err, resp.StatusCode)
			}
			defer resp.Body.Close()
			var p map[string]interface{}
			_ = json.NewDecoder(resp.Body).Decode(&p)
			if on, ok := p["is_online"].(bool); ok {
				return on
			}
			return false
		}

		// Both Bob and Alice initially offline
		presReq, _ := json.Marshal(map[string]interface{}{
			"user_ids": []string{aliceID, bobID},
		})
		bReq, _ := http.NewRequest("POST", server.URL+"/api/v1/presence/batch", bytes.NewReader(presReq))
		bReq.Header.Set("Authorization", "Bearer "+aliceToken)
		bReq.Header.Set("Content-Type", "application/json")
		r, err := client.Do(bReq)
		if err != nil || r.StatusCode != http.StatusOK {
			t.Fatalf("Failed batch presence: %v, status: %d", err, r.StatusCode)
		}
		var batchRes []map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&batchRes)
		r.Body.Close()
		if len(batchRes) != 2 || batchRes[0]["is_online"] != false || batchRes[1]["is_online"] != false {
			t.Fatalf("Expected both users offline initially, got: %v", batchRes)
		}

		// Alice connects WS
		aliceWS, err := dialWS(aliceToken)
		if err != nil {
			t.Fatalf("Alice failed to connect WS: %v", err)
		}
		defer aliceWS.Close()
		time.Sleep(50 * time.Millisecond)

		// Bob connects WS (Session 1)
		bobWS1, err := dialWS(bobToken)
		if err != nil {
			t.Fatalf("Bob failed to connect WS1: %v", err)
		}
		time.Sleep(50 * time.Millisecond)

		// Check presence: Bob must be online
		if !getPres(bobID) {
			t.Fatalf("Expected Bob online after WS1 connect")
		}

		// Bob connects Session 2 (multi-device)
		bobWS2, err := dialWS(bobToken)
		if err != nil {
			t.Fatalf("Bob failed to connect WS2: %v", err)
		}
		time.Sleep(50 * time.Millisecond)

		// Bob disconnects Session 1 -> Bob must STILL be online because Session 2 active
		bobWS1.Close()
		time.Sleep(80 * time.Millisecond)

		if !getPres(bobID) {
			t.Fatalf("Expected Bob still online with second session")
		}

		// Bob disconnects Session 2 -> Bob now offline
		bobWS2.Close()
		time.Sleep(80 * time.Millisecond)

		if getPres(bobID) {
			t.Fatalf("Expected Bob offline after all sessions closed")
		}

		// Rapid Reconnect: Bob connects Session 3 immediately
		bobWS3, err := dialWS(bobToken)
		if err != nil {
			t.Fatalf("Bob failed rapid reconnect WS3: %v", err)
		}
		defer bobWS3.Close()
		time.Sleep(100 * time.Millisecond)

		// Bob must be online and must not be flipped back to offline by any lagging goroutine
		if !getPres(bobID) {
			t.Fatalf("Expected Bob online after rapid reconnect")
		}
	})

	// -----------------------------------------------------------------
	// Test B: Real-Time Messaging & Non-Duplication Outbox Payload
	// -----------------------------------------------------------------
	t.Run("Real-Time Message Delivery and Payload ID Normalization", func(t *testing.T) {
		bobWS, err := dialWS(bobToken)
		if err != nil {
			t.Fatalf("Bob failed to connect WS: %v", err)
		}
		defer bobWS.Close()

		// Channel to receive Bob's message
		msgReceived := make(chan map[string]interface{}, 5)
		go func() {
			for {
				_, msg, err := bobWS.ReadMessage()
				if err != nil {
					return
				}
				var env map[string]interface{}
				if err := json.Unmarshal(msg, &env); err == nil {
					if env["type"] == "message.created" {
						payload := env["payload"].(map[string]interface{})
						msgReceived <- payload
					}
				}
			}
		}()

		// Alice submits message M1
		msgBody, _ := json.Marshal(map[string]string{
			"ciphertext":      "Message M1 Content",
			"nonce":           "normal",
			"idempotency_key": "idemp_test_m1",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+directConvID+"/messages", bytes.NewReader(msgBody))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusCreated {
			t.Fatalf("Alice failed to post M1: %v, status: %d", err, resp.StatusCode)
		}
		var m1 models.Message
		_ = json.NewDecoder(resp.Body).Decode(&m1)

		// Verify Bob received message.created over WS within 1 second
		select {
		case payload := <-msgReceived:
			// CRITICAL CHECK: Payload must contain BOTH 'id' and 'message_id' matching m1.ID
			if payload["id"] != m1.ID {
				t.Fatalf("Expected payload['id'] == %s, got %v", m1.ID, payload["id"])
			}
			if payload["message_id"] != m1.ID {
				t.Fatalf("Expected payload['message_id'] == %s, got %v", m1.ID, payload["message_id"])
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("Bob timed out waiting for message.created over WebSocket")
		}
	})

	// -----------------------------------------------------------------
	// Test C: Seen Status, Read Receipts, and Cursor Independence
	// -----------------------------------------------------------------
	t.Run("Message-Level Read Receipts and Multi-Message Independence", func(t *testing.T) {
		aliceWS, _ := dialWS(aliceToken)
		defer aliceWS.Close()

		aliceEvents := make(chan map[string]interface{}, 10)
		go func() {
			for {
				_, msg, err := aliceWS.ReadMessage()
				if err != nil {
					return
				}
				var env map[string]interface{}
				if err := json.Unmarshal(msg, &env); err == nil {
					aliceEvents <- env
				}
			}
		}()

		// Alice submits M1
		msg1Body, _ := json.Marshal(map[string]string{
			"ciphertext": "M1 for Read Testing",
			"nonce":      "normal",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+directConvID+"/messages", bytes.NewReader(msg1Body))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, _ = client.Do(req)
		var m1 models.Message
		_ = json.NewDecoder(resp.Body).Decode(&m1)

		// Before Bob reads M1: Alice loads messages -> M1 is_read must be false
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+directConvID+"/messages", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, _ = client.Do(req)
		var listRes struct {
			Messages []*models.Message `json:"messages"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&listRes)

		var foundM1 *models.Message
		for _, m := range listRes.Messages {
			if m.ID == m1.ID {
				foundM1 = m
				break
			}
		}
		if foundM1 == nil {
			t.Fatalf("M1 not found in listMessages")
		}
		if foundM1.IsRead != false || foundM1.ReadCount != 0 {
			t.Fatalf("Expected M1 unread initially, got is_read=%v, read_count=%d", foundM1.IsRead, foundM1.ReadCount)
		}

		// Bob reads M1 via POST /messages/{msgId}/read
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+directConvID+"/messages/"+m1.ID+"/read", nil)
		req.Header.Set("Authorization", "Bearer "+bobToken)
		resp, err = client.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("Bob failed to record read for M1: %v, status: %d", err, resp.StatusCode)
		}

		// Verify Alice receives message.read WebSocket event
		var gotMessageReadEvent bool
		for i := 0; i < 5; i++ {
			select {
			case ev := <-aliceEvents:
				if ev["type"] == "message.read" {
					gotMessageReadEvent = true
					payload := ev["payload"].(map[string]interface{})
					if payload["message_id"] != m1.ID {
						t.Fatalf("Expected message.read for M1, got %v", payload["message_id"])
					}
				}
			case <-time.After(500 * time.Millisecond):
			}
			if gotMessageReadEvent {
				break
			}
		}
		if !gotMessageReadEvent {
			t.Fatalf("Alice never received message.read event over WebSocket")
		}

		// Alice now re-queries messages: M1 must be read (is_read=true, read_count=1)
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+directConvID+"/messages", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, _ = client.Do(req)
		_ = json.NewDecoder(resp.Body).Decode(&listRes)
		for _, m := range listRes.Messages {
			if m.ID == m1.ID {
				foundM1 = m
				break
			}
		}
		if foundM1.IsRead != true || foundM1.ReadCount < 1 {
			t.Fatalf("Expected M1 read after Bob read receipt, got is_read=%v, read_count=%d", foundM1.IsRead, foundM1.ReadCount)
		}

		// Alice sends M2
		time.Sleep(20 * time.Millisecond)
		msg2Body, _ := json.Marshal(map[string]string{
			"ciphertext": "M2 Unread Message",
			"nonce":      "normal",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+directConvID+"/messages", bytes.NewReader(msg2Body))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, _ = client.Do(req)
		var m2 models.Message
		_ = json.NewDecoder(resp.Body).Decode(&m2)

		// Bob has NOT read M2. Alice queries messages: M1 must be read, M2 MUST BE UNREAD!
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+directConvID+"/messages", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, _ = client.Do(req)
		_ = json.NewDecoder(resp.Body).Decode(&listRes)

		var checkedM1, checkedM2 *models.Message
		for _, m := range listRes.Messages {
			if m.ID == m1.ID {
				checkedM1 = m
			}
			if m.ID == m2.ID {
				checkedM2 = m
			}
		}
		if checkedM1 == nil || checkedM2 == nil {
			t.Fatalf("Failed to locate M1 or M2 in listMessages")
		}
		if checkedM1.IsRead != true {
			t.Fatalf("M1 should still be read, got is_read=%v", checkedM1.IsRead)
		}
		if checkedM2.IsRead != false || checkedM2.ReadCount != 0 {
			t.Fatalf("CRITICAL DEFECT: M2 should be unread, but got is_read=%v, read_count=%d", checkedM2.IsRead, checkedM2.ReadCount)
		}
	})

	// -----------------------------------------------------------------
	// Test D: Group Reader Inspection RBAC (Admin Scope)
	// -----------------------------------------------------------------
	t.Run("Group Read Receipt Inspection RBAC", func(t *testing.T) {
		// Create Group Conversation: Alice (Owner), Bob (Member), Charlie (Member)
		grpReq, _ := json.Marshal(map[string]interface{}{
			"type":                 "group",
			"title":                "Stab Group",
			"member_ids":           []string{bobID, charlieID},
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(grpReq))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, _ = client.Do(req)
		var grpRes map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&grpRes)
		grpID := grpRes["id"].(string)

		// Alice posts group message GM1
		gmBody, _ := json.Marshal(map[string]string{
			"ciphertext": "Group Message 1",
			"nonce":      "normal",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+grpID+"/messages", bytes.NewReader(gmBody))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		req.Header.Set("Content-Type", "application/json")
		resp, _ = client.Do(req)
		var gm models.Message
		_ = json.NewDecoder(resp.Body).Decode(&gm)

		// Bob reads GM1
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+grpID+"/messages/"+gm.ID+"/read", nil)
		req.Header.Set("Authorization", "Bearer "+bobToken)
		client.Do(req)

		// Non-admin member Charlie tries to inspect readers -> MUST FAIL with 403 Forbidden!
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+grpID+"/messages/"+gm.ID+"/readers", nil)
		req.Header.Set("Authorization", "Bearer "+charlieToken)
		resp, _ = client.Do(req)
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("Expected 403 Forbidden for regular member inspecting group readers, got %d", resp.StatusCode)
		}

		// Owner/Admin Alice inspects readers -> MUST SUCCEED with 200 OK and Bob listed
		req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+grpID+"/messages/"+gm.ID+"/readers", nil)
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, _ = client.Do(req)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("Expected 200 OK for owner inspecting group readers, got %d", resp.StatusCode)
		}
		var readers []models.MessageReader
		_ = json.NewDecoder(resp.Body).Decode(&readers)
		if len(readers) != 1 || readers[0].UserID != bobID {
			t.Fatalf("Expected Bob in reader list, got: %v", readers)
		}
	})
}
