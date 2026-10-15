package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"nexachat/server/internal/models"
)

func TestDeduplicationAndIdempotencySuite(t *testing.T) {
	server, _, store := setupTestServer(t)
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

	aliceToken, aliceID := registerUser("alice_dedup")
	bobToken, bobID := registerUser("bob_dedup")

	// Direct conversation between Alice and Bob
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
	convID := convRes["id"].(string)

	// 1. One normal send creates one database message and the expected outbox record with idempotency_key
	t.Run("NormalSendCreatesOneMessageAndOutboxRecord", func(t *testing.T) {
		idempKey := "idemp_test_1"
		sendReq, _ := json.Marshal(map[string]string{
			"ciphertext":      "Hello Bob!",
			"nonce":           "normal",
			"idempotency_key": idempKey,
		})
		sReq, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(sendReq))
		sReq.Header.Set("Authorization", "Bearer "+aliceToken)
		sReq.Header.Set("Content-Type", "application/json")
		sResp, err := client.Do(sReq)
		if err != nil || sResp.StatusCode != http.StatusCreated {
			t.Fatalf("Send failed: %v, code: %d", err, sResp.StatusCode)
		}
		var msgRes map[string]interface{}
		_ = json.NewDecoder(sResp.Body).Decode(&msgRes)
		msgID := msgRes["id"].(string)

		// Verify database message count
		msgs, err := store.GetMessages(context.Background(), convID, "", 10)
		if err != nil {
			t.Fatalf("GetMessages failed: %v", err)
		}
		if len(msgs) != 1 {
			t.Fatalf("Expected 1 persisted message, got %d", len(msgs))
		}
		if msgs[0].ID != msgID || msgs[0].IdempotencyKey != idempKey {
			t.Fatalf("Message fields mismatch: %+v", msgs[0])
		}

		// Verify outbox record for Bob contains idempotency_key
		events, err := store.GetOutboxEventsAfter(context.Background(), bobID, 0, 10)
		if err != nil {
			t.Fatalf("GetOutboxEventsAfter failed: %v", err)
		}
		if len(events) != 1 {
			t.Fatalf("Expected 1 outbox event for Bob, got %d", len(events))
		}
		var payloadMap map[string]interface{}
		if err := json.Unmarshal([]byte(events[0].Payload), &payloadMap); err != nil {
			t.Fatalf("Failed to parse outbox payload: %v", err)
		}
		if payloadMap["idempotency_key"] != idempKey {
			t.Fatalf("Expected outbox event to contain idempotency_key %q, got %v", idempKey, payloadMap["idempotency_key"])
		}
		if payloadMap["id"] != msgID {
			t.Fatalf("Expected outbox event id %q, got %v", msgID, payloadMap["id"])
		}
	})

	// 2. Two concurrent requests with the same sender, conversation, idempotency key, and payload result in one logical message
	t.Run("ConcurrentRequestsWithSameIdempotencyKey", func(t *testing.T) {
		idempKey := "idemp_concurrent_key"
		payload := map[string]string{
			"ciphertext":      "Concurrent Message Test",
			"nonce":           "normal",
			"idempotency_key": idempKey,
		}
		payloadBytes, _ := json.Marshal(payload)

		const numConcurrent = 5
		var wg sync.WaitGroup
		statusCodes := make([]int, numConcurrent)
		messageIDs := make([]string, numConcurrent)

		for i := 0; i < numConcurrent; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				r, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(payloadBytes))
				r.Header.Set("Authorization", "Bearer "+aliceToken)
				r.Header.Set("Content-Type", "application/json")
				res, reqErr := client.Do(r)
				if reqErr != nil {
					return
				}
				defer res.Body.Close()
				statusCodes[idx] = res.StatusCode
				var body map[string]interface{}
				_ = json.NewDecoder(res.Body).Decode(&body)
				if id, ok := body["id"].(string); ok {
					messageIDs[idx] = id
				}
			}(i)
		}
		wg.Wait()

		// All requests should succeed with 201 Created (or 200 OK)
		var canonicalID string
		for i, code := range statusCodes {
			if code != http.StatusCreated && code != http.StatusOK {
				t.Fatalf("Concurrent request %d returned unexpected status %d", i, code)
			}
			if canonicalID == "" {
				canonicalID = messageIDs[i]
			} else if messageIDs[i] != canonicalID {
				t.Fatalf("Concurrent requests returned mismatched message IDs: %s vs %s", canonicalID, messageIDs[i])
			}
		}

		// Verify database only has 2 messages total (1 from Test 1 + 1 from Test 2)
		msgs, err := store.GetMessages(context.Background(), convID, "", 10)
		if err != nil {
			t.Fatalf("GetMessages failed: %v", err)
		}
		if len(msgs) != 2 {
			t.Fatalf("Expected exactly 2 persisted messages in DB, got %d", len(msgs))
		}
	})

	// 3. Retrying a successful send returns or identifies the existing message instead of inserting a duplicate
	t.Run("RetryingSendReturnsExistingMessageWithoutDuplicate", func(t *testing.T) {
		idempKey := "idemp_retry_key"
		payload, _ := json.Marshal(map[string]string{
			"ciphertext":      "Retryable Message Content",
			"nonce":           "normal",
			"idempotency_key": idempKey,
		})

		// Send 1
		r1, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(payload))
		r1.Header.Set("Authorization", "Bearer "+aliceToken)
		r1.Header.Set("Content-Type", "application/json")
		res1, err := client.Do(r1)
		if err != nil || res1.StatusCode != http.StatusCreated {
			t.Fatalf("Initial send failed: %v, code: %d", err, res1.StatusCode)
		}
		var body1 map[string]interface{}
		_ = json.NewDecoder(res1.Body).Decode(&body1)
		msgID1 := body1["id"].(string)

		// Send 2 (Retry)
		r2, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(payload))
		r2.Header.Set("Authorization", "Bearer "+aliceToken)
		r2.Header.Set("Content-Type", "application/json")
		res2, err := client.Do(r2)
		if err != nil || (res2.StatusCode != http.StatusCreated && res2.StatusCode != http.StatusOK) {
			t.Fatalf("Retry send failed: %v, code: %d", err, res2.StatusCode)
		}
		var body2 map[string]interface{}
		_ = json.NewDecoder(res2.Body).Decode(&body2)
		msgID2 := body2["id"].(string)

		if msgID1 != msgID2 {
			t.Fatalf("Expected retry to return original message ID %s, got %s", msgID1, msgID2)
		}

		// Verify database count
		msgs, err := store.GetMessages(context.Background(), convID, "", 10)
		if err != nil {
			t.Fatalf("GetMessages failed: %v", err)
		}
		if len(msgs) != 3 {
			t.Fatalf("Expected exactly 3 persisted messages in DB, got %d", len(msgs))
		}
	})

	// 4. Reusing the same idempotency key with a different payload is rejected safely
	t.Run("ReusingIdempotencyKeyWithDifferentPayloadRejected", func(t *testing.T) {
		idempKey := "idemp_conflict_key"
		p1, _ := json.Marshal(map[string]string{
			"ciphertext":      "Original payload text",
			"nonce":           "normal",
			"idempotency_key": idempKey,
		})
		r1, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(p1))
		r1.Header.Set("Authorization", "Bearer "+aliceToken)
		r1.Header.Set("Content-Type", "application/json")
		res1, err := client.Do(r1)
		if err != nil || res1.StatusCode != http.StatusCreated {
			t.Fatalf("Initial send failed: %v, code: %d", err, res1.StatusCode)
		}

		// Conflicting send with different ciphertext
		p2, _ := json.Marshal(map[string]string{
			"ciphertext":      "Conflicting different payload text!",
			"nonce":           "normal",
			"idempotency_key": idempKey,
		})
		r2, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(p2))
		r2.Header.Set("Authorization", "Bearer "+aliceToken)
		r2.Header.Set("Content-Type", "application/json")
		res2, err := client.Do(r2)
		if err != nil {
			t.Fatalf("Conflicting request failed: %v", err)
		}
		if res2.StatusCode != http.StatusConflict {
			t.Fatalf("Expected HTTP 409 Conflict for conflicting payload, got %d", res2.StatusCode)
		}
		var errBody map[string]interface{}
		_ = json.NewDecoder(res2.Body).Decode(&errBody)
		if errObj, ok := errBody["error"].(map[string]interface{}); ok {
			if errObj["code"] != "IDEMPOTENCY_CONFLICT" {
				t.Fatalf("Expected error code IDEMPOTENCY_CONFLICT, got: %v", errObj["code"])
			}
		}
	})

	// 5. Independent idempotency keys allow two legitimate messages with identical text
	t.Run("IdenticalTextWithDifferentIdempotencyKeysAllowed", func(t *testing.T) {
		text := "Identical repeated text message"
		p1, _ := json.Marshal(map[string]string{
			"ciphertext":      text,
			"nonce":           "normal",
			"idempotency_key": "idemp_msg_A",
		})
		r1, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(p1))
		r1.Header.Set("Authorization", "Bearer "+aliceToken)
		r1.Header.Set("Content-Type", "application/json")
		res1, _ := client.Do(r1)
		var b1 map[string]interface{}
		_ = json.NewDecoder(res1.Body).Decode(&b1)
		id1 := b1["id"].(string)

		p2, _ := json.Marshal(map[string]string{
			"ciphertext":      text,
			"nonce":           "normal",
			"idempotency_key": "idemp_msg_B",
		})
		r2, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(p2))
		r2.Header.Set("Authorization", "Bearer "+aliceToken)
		r2.Header.Set("Content-Type", "application/json")
		res2, _ := client.Do(r2)
		var b2 map[string]interface{}
		_ = json.NewDecoder(res2.Body).Decode(&b2)
		id2 := b2["id"].(string)

		if id1 == id2 {
			t.Fatalf("Expected two distinct messages with different IDs, got both %s", id1)
		}
	})

	// 6. An outbox retry does not create another database message
	t.Run("OutboxRetryDoesNotCreateAnotherDatabaseMessage", func(t *testing.T) {
		msgsBefore, err := store.GetMessages(context.Background(), convID, "", 50)
		if err != nil {
			t.Fatalf("GetMessages failed: %v", err)
		}

		// Query outbox events for Bob
		events, err := store.GetOutboxEventsAfter(context.Background(), bobID, 0, 50)
		if err != nil {
			t.Fatalf("GetOutboxEventsAfter failed: %v", err)
		}
		if len(events) == 0 {
			t.Fatal("Expected outbox events for Bob")
		}

		// Simulate client reconnection by reading outbox events again from cursor 0
		replayedEvents, err := store.GetOutboxEventsAfter(context.Background(), bobID, 0, 50)
		if err != nil {
			t.Fatalf("Replay failed: %v", err)
		}
		if len(replayedEvents) != len(events) {
			t.Fatalf("Replayed events length mismatch: %d vs %d", len(replayedEvents), len(events))
		}

		msgsAfter, err := store.GetMessages(context.Background(), convID, "", 50)
		if err != nil {
			t.Fatalf("GetMessages failed: %v", err)
		}
		if len(msgsAfter) != len(msgsBefore) {
			t.Fatalf("Message count changed after outbox replay: %d vs %d", len(msgsAfter), len(msgsBefore))
		}
	})

	// 7. Database transactions preserve consistency when an error occurs
	t.Run("DatabaseTransactionPreservesConsistencyOnError", func(t *testing.T) {
		msgsBefore, _ := store.GetMessages(context.Background(), convID, "", 50)

		// Submit invalid payload (e.g. malformed or oversized payload)
		hugeCipher := string(make([]byte, 2*1024*1024)) // 2MB exceeds MaxCiphertextBytes
		p, _ := json.Marshal(map[string]string{
			"ciphertext":      hugeCipher,
			"nonce":           "normal",
			"idempotency_key": "idemp_huge_fail",
		})
		r, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(p))
		r.Header.Set("Authorization", "Bearer "+aliceToken)
		r.Header.Set("Content-Type", "application/json")
		res, _ := client.Do(r)
		if res.StatusCode != http.StatusBadRequest && res.StatusCode != http.StatusRequestEntityTooLarge {
			t.Fatalf("Expected rejection, got: %d", res.StatusCode)
		}

		msgsAfter, _ := store.GetMessages(context.Background(), convID, "", 50)
		if len(msgsAfter) != len(msgsBefore) {
			t.Fatalf("Database was modified during failed transaction: %d vs %d", len(msgsAfter), len(msgsBefore))
		}
	})

	// 8. Authorization prevents one user from reusing another user's idempotency scope
	t.Run("IdempotencyCrossUserIsolation", func(t *testing.T) {
		sharedKey := "idemp_shared_key_test"
		aliceMsg, _ := json.Marshal(map[string]string{
			"ciphertext":      "Alice message",
			"nonce":           "normal",
			"idempotency_key": sharedKey,
		})
		rAlice, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(aliceMsg))
		rAlice.Header.Set("Authorization", "Bearer "+aliceToken)
		rAlice.Header.Set("Content-Type", "application/json")
		resAlice, _ := client.Do(rAlice)
		var bAlice map[string]interface{}
		_ = json.NewDecoder(resAlice.Body).Decode(&bAlice)
		aliceMsgID := bAlice["id"].(string)

		// Bob sends with the SAME idempotency key in the SAME conversation
		bobMsg, _ := json.Marshal(map[string]string{
			"ciphertext":      "Bob message with same key",
			"nonce":           "normal",
			"idempotency_key": sharedKey,
		})
		rBob, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(bobMsg))
		rBob.Header.Set("Authorization", "Bearer "+bobToken)
		rBob.Header.Set("Content-Type", "application/json")
		resBob, _ := client.Do(rBob)
		if resBob.StatusCode != http.StatusCreated {
			t.Fatalf("Bob send failed: code %d", resBob.StatusCode)
		}
		var bBob map[string]interface{}
		_ = json.NewDecoder(resBob.Body).Decode(&bBob)
		bobMsgID := bBob["id"].(string)

		if aliceMsgID == bobMsgID {
			t.Fatalf("Bob was incorrectly returned Alice's message: %s", aliceMsgID)
		}
	})

	// 9. Existing E2EE and attachment message flows remain compatible
	t.Run("E2EEAndAttachmentCompatibility", func(t *testing.T) {
		attPayload := map[string]interface{}{
			"text": "photo.png",
			"type": "attachment",
			"attachment": map[string]interface{}{
				"filename":    "photo.png",
				"contentType": "image/png",
				"sizeBytes":   1024,
				"isPhoto":     true,
			},
		}
		attBytes, _ := json.Marshal(attPayload)
		p, _ := json.Marshal(map[string]string{
			"ciphertext":      string(attBytes),
			"nonce":           "normal",
			"idempotency_key": fmt.Sprintf("idemp_att_%d", time.Now().UnixNano()),
		})
		r, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(p))
		r.Header.Set("Authorization", "Bearer "+aliceToken)
		r.Header.Set("Content-Type", "application/json")
		res, err := client.Do(r)
		if err != nil || res.StatusCode != http.StatusCreated {
			t.Fatalf("Attachment message send failed: %v, code: %d", err, res.StatusCode)
		}
		var b map[string]interface{}
		_ = json.NewDecoder(res.Body).Decode(&b)
		if b["id"] == nil || b["ciphertext"] != string(attBytes) {
			t.Fatalf("Unexpected attachment response: %+v", b)
		}

		// Also verify direct call to CreateMessageWithOutbox with models.Message
		e2eeMsg := &models.Message{
			ConversationID: convID,
			SenderID:       aliceID,
			Ciphertext:     "encrypted_ciphertext_envelope_mock",
			Nonce:          "mock_nonce_12345",
			IdempotencyKey: fmt.Sprintf("idemp_e2ee_%d", time.Now().UnixNano()),
		}
		saved, outbox, err := store.CreateMessageWithOutbox(context.Background(), e2eeMsg, []string{aliceID, bobID})
		if err != nil {
			t.Fatalf("CreateMessageWithOutbox for E2EE failed: %v", err)
		}
		if saved.ID == "" || len(outbox) != 2 {
			t.Fatalf("Expected 2 outbox events, got %d", len(outbox))
		}
	})
}

func TestMultiSessionRealWorldDuplicateVerification(t *testing.T) {
	server, _, store := setupTestServer(t)
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

	aliceToken, aliceID := registerUser("alice_ms")
	bobToken, bobID := registerUser("bob_ms")

	// Direct conversation between Alice and Bob
	convReq, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create conversation: %v", err)
	}
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	convID := convRes["id"].(string)

	dialWS := func(token string) (*websocket.Conn, error) {
		wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + token
		dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
		conn, _, err := dialer.Dial(wsURL, nil)
		return conn, err
	}

	// 1. Session A (Alice) and Session B (Bob) connect via WebSocket
	aliceWS, err := dialWS(aliceToken)
	if err != nil {
		t.Fatalf("Alice WS connection failed: %v", err)
	}
	defer aliceWS.Close()

	bobWS, err := dialWS(bobToken)
	if err != nil {
		t.Fatalf("Bob WS connection failed: %v", err)
	}
	defer bobWS.Close()

	time.Sleep(50 * time.Millisecond) // Wait for handshake registrations

	// 2. Session A sends one message to Session B with idempotency key
	idempKey := "idemp_ms_msg_1"
	sendReq, _ := json.Marshal(map[string]string{
		"ciphertext":      "Real world message from Alice",
		"nonce":           "normal",
		"idempotency_key": idempKey,
	})
	sReq, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(sendReq))
	sReq.Header.Set("Authorization", "Bearer "+aliceToken)
	sReq.Header.Set("Content-Type", "application/json")
	sResp, err := client.Do(sReq)
	if err != nil || sResp.StatusCode != http.StatusCreated {
		t.Fatalf("Send failed: %v, status: %d", err, sResp.StatusCode)
	}
	var msgBody map[string]interface{}
	_ = json.NewDecoder(sResp.Body).Decode(&msgBody)
	sentMsgID := msgBody["id"].(string)

	// 3. Confirm exactly one logical message is persisted in DB
	msgs, err := store.GetMessages(context.Background(), convID, "", 10)
	if err != nil || len(msgs) != 1 {
		t.Fatalf("Expected 1 persisted message, got %d (err: %v)", len(msgs), err)
	}
	if msgs[0].ID != sentMsgID {
		t.Fatalf("Persisted message ID %s != sent ID %s", msgs[0].ID, sentMsgID)
	}

	// 4. Confirm Session A and Session B receive the WebSocket event with matching message ID and idempotency key
	readNextMessageCreated := func(conn *websocket.Conn, timeout time.Duration) (map[string]interface{}, error) {
		deadline := time.Now().Add(timeout)
		for time.Now().Before(deadline) {
			_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
			var env map[string]interface{}
			err := conn.ReadJSON(&env)
			if err != nil {
				continue
			}
			if env["type"] == "message.created" {
				var payload map[string]interface{}
				if pBytes, ok := env["payload"].(string); ok {
					_ = json.Unmarshal([]byte(pBytes), &payload)
				} else if pMap, ok := env["payload"].(map[string]interface{}); ok {
					payload = pMap
				}
				return payload, nil
			}
		}
		return nil, fmt.Errorf("timed out waiting for message.created")
	}

	alicePayload, err := readNextMessageCreated(aliceWS, 2*time.Second)
	if err != nil {
		t.Fatalf("Alice timed out waiting for message.created: %v", err)
	}
	if alicePayload["id"] != sentMsgID || alicePayload["idempotency_key"] != idempKey {
		t.Fatalf("Alice payload mismatch: %+v", alicePayload)
	}

	bobPayload, err := readNextMessageCreated(bobWS, 2*time.Second)
	if err != nil {
		t.Fatalf("Bob timed out waiting for message.created: %v", err)
	}
	if bobPayload["id"] != sentMsgID || bobPayload["idempotency_key"] != idempKey {
		t.Fatalf("Bob payload mismatch: %+v", bobPayload)
	}

	// 5. Confirm outbox event exists for both Alice and Bob
	aliceEvents, _ := store.GetOutboxEventsAfter(context.Background(), aliceID, 0, 10)
	bobEvents, _ := store.GetOutboxEventsAfter(context.Background(), bobID, 0, 10)
	if len(aliceEvents) != 1 || len(bobEvents) != 1 {
		t.Fatalf("Expected 1 outbox event each, got Alice=%d, Bob=%d", len(aliceEvents), len(bobEvents))
	}

	// 6. Replay event or reconnect recipient (Bob)
	bobWS.Close()
	bobWS2, err := dialWS(bobToken)
	if err != nil {
		t.Fatalf("Bob reconnect failed: %v", err)
	}
	defer bobWS2.Close()

	// Request sync catchup
	syncReq := map[string]interface{}{
		"type":    "sync.request",
		"payload": map[string]interface{}{"last_event_id": 0},
	}
	if err := bobWS2.WriteJSON(syncReq); err != nil {
		t.Fatalf("Bob failed to send sync.request: %v", err)
	}

	replayedPayload, err := readNextMessageCreated(bobWS2, 2*time.Second)
	if err != nil {
		t.Fatalf("Bob timed out waiting for replayed message: %v", err)
	}
	if replayedPayload["id"] != sentMsgID || replayedPayload["idempotency_key"] != idempKey {
		t.Fatalf("Replayed payload mismatch: %+v", replayedPayload)
	}

	// 7. Retry the original request with same idempotency identity
	retryReq, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(sendReq))
	retryReq.Header.Set("Authorization", "Bearer "+aliceToken)
	retryReq.Header.Set("Content-Type", "application/json")
	retryResp, err := client.Do(retryReq)
	if err != nil || (retryResp.StatusCode != http.StatusCreated && retryResp.StatusCode != http.StatusOK) {
		t.Fatalf("Retry request failed: %v, status: %d", err, retryResp.StatusCode)
	}
	var retryBody map[string]interface{}
	_ = json.NewDecoder(retryResp.Body).Decode(&retryBody)
	if retryBody["id"] != sentMsgID {
		t.Fatalf("Retry returned different message ID %s vs %s", retryBody["id"], sentMsgID)
	}

	// Database still contains exactly one logical message
	msgsAfterRetry, _ := store.GetMessages(context.Background(), convID, "", 10)
	if len(msgsAfterRetry) != 1 {
		t.Fatalf("Database contains duplicate messages after retry: %d", len(msgsAfterRetry))
	}

	// 8. Send two separate messages with identical text
	for i := 1; i <= 2; i++ {
		separateKey := fmt.Sprintf("idemp_separate_%d", i)
		sPayload, _ := json.Marshal(map[string]string{
			"ciphertext":      "Identical text but separate sends",
			"nonce":           "normal",
			"idempotency_key": separateKey,
		})
		r, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(sPayload))
		r.Header.Set("Authorization", "Bearer "+aliceToken)
		r.Header.Set("Content-Type", "application/json")
		res, err := client.Do(r)
		if err != nil || res.StatusCode != http.StatusCreated {
			t.Fatalf("Separate send %d failed: %v", i, err)
		}
	}

	// Confirm both legitimate messages appear (total 3 messages now)
	finalMsgs, _ := store.GetMessages(context.Background(), convID, "", 10)
	if len(finalMsgs) != 3 {
		t.Fatalf("Expected 3 messages in database, got %d", len(finalMsgs))
	}
}

