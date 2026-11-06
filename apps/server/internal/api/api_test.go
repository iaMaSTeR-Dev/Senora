package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"senora/server/internal/auth"
	"senora/server/internal/conversations"
	"senora/server/internal/crypto"
	"senora/server/internal/events"
	"senora/server/internal/identity"
	"senora/server/internal/messages"
	"senora/server/internal/models"
	"senora/server/internal/storage"
)

func setupTestServer(t *testing.T) (*httptest.Server, *Router, storage.Store) {
	driver := "sqlite"
	dsn := fmt.Sprintf("file:api_test_%d?mode=memory&cache=shared", time.Now().UnixNano())
	if testDB := os.Getenv("TEST_DATABASE_URL"); testDB != "" {
		driver = "postgres"
		dsn = testDB
	}
	store, err := storage.NewSQLStore(driver, dsn)
	if err != nil {
		t.Fatalf("Failed to initialize store: %v", err)
	}
	_ = store.ResetForTesting(context.Background())

	sessionService := auth.NewSessionService(store, 24*time.Hour)
	identityService := identity.NewService(store, sessionService)
	convService := conversations.NewService(store)
	hub := events.NewHub(store)
	msgService := messages.NewService(store, convService, hub)
	cryptoService := crypto.NewService(store)

	ctx, cancel := context.WithCancel(context.Background())
	go hub.Run(ctx)

	router := NewRouter(store, identityService, sessionService, convService, msgService, cryptoService, hub)
	server := httptest.NewServer(router)

	t.Cleanup(func() {
		server.Close()
		cancel()
		_ = store.Close()
	})

	return server, router, store
}

func TestE2EApiWorkflow(t *testing.T) {
	server, _, _ := setupTestServer(t)
	client := server.Client()

	// 1. Health check
	resp, err := client.Get(server.URL + "/api/v1/health")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Health check failed: %v, status: %d", err, resp.StatusCode)
	}

	// 2. Register Alice
	aliceRegBody, _ := json.Marshal(map[string]string{
		"username":     "alice",
		"display_name": "Alice Wonderland",
		"password":     "Password123!",
		"device_name":  "Alice iPhone",
	})
	resp, err = client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(aliceRegBody))
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Alice registration failed: %v, status: %d", err, resp.StatusCode)
	}
	var aliceAuth map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&aliceAuth)
	aliceToken := aliceAuth["token"].(string)
	aliceUser := aliceAuth["user"].(map[string]interface{})
	aliceID := aliceUser["id"].(string)

	// 3. Register Bob
	bobRegBody, _ := json.Marshal(map[string]string{
		"username":     "bob",
		"display_name": "Bob Builder",
		"password":     "Password123!",
		"device_name":  "Bob Desktop",
	})
	resp, err = client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(bobRegBody))
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Bob registration failed: %v, status: %d", err, resp.StatusCode)
	}
	var bobAuth map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&bobAuth)
	bobToken := bobAuth["token"].(string)
	bobUser := bobAuth["user"].(map[string]interface{})
	bobID := bobUser["id"].(string)

	// 4. Register Eve (attacker)
	eveRegBody, _ := json.Marshal(map[string]string{
		"username":     "eve",
		"display_name": "Eve Eavesdropper",
		"password":     "Password123!",
	})
	resp, err = client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(eveRegBody))
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Eve registration failed: %v", err)
	}
	var eveAuth map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&eveAuth)
	eveToken := eveAuth["token"].(string)

	// 5. Alice searches for Bob
	req, _ := http.NewRequest("GET", server.URL+"/api/v1/users?query=bob", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Search users failed: %v", err)
	}
	var searchRes struct {
		Users []models.User `json:"users"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&searchRes)
	if len(searchRes.Users) == 0 || searchRes.Users[0].Username != "bob" {
		t.Fatalf("Expected Bob in search results, got: %+v", searchRes.Users)
	}

	// 6. Alice creates direct conversation with Bob
	convBody, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Create conversation failed: %v, status: %d", err, resp.StatusCode)
	}
	var conv models.Conversation
	_ = json.NewDecoder(resp.Body).Decode(&conv)

	// 7. Alice submits encrypted message
	msgBody, _ := json.Marshal(map[string]string{
		"idempotency_key": "msg-idemp-12345",
		"ciphertext":      "e2ee_encrypted_ciphertext_sample",
		"nonce":           "sample_nonce_123",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Submit message failed: %v, status: %d", err, resp.StatusCode)
	}
	var createdMsg models.Message
	_ = json.NewDecoder(resp.Body).Decode(&createdMsg)
	if createdMsg.Ciphertext != "e2ee_encrypted_ciphertext_sample" {
		t.Fatalf("Unexpected ciphertext: %s", createdMsg.Ciphertext)
	}

	// 8. Idempotency test: Alice submits duplicate message with identical key
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Idempotent resubmit failed: %v, status: %d", err, resp.StatusCode)
	}
	var dupMsg models.Message
	_ = json.NewDecoder(resp.Body).Decode(&dupMsg)
	if dupMsg.ID != createdMsg.ID {
		t.Fatalf("Expected duplicate message to have identical ID, got %s vs %s", dupMsg.ID, createdMsg.ID)
	}

	// 9. Bob retrieves messages from conversation
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob get messages failed: %v, status: %d", err, resp.StatusCode)
	}
	var msgList struct {
		Messages []models.Message `json:"messages"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&msgList)
	if len(msgList.Messages) != 1 {
		t.Fatalf("Expected exactly 1 message (due to idempotency deduplication), got %d", len(msgList.Messages))
	}
	if msgList.Messages[0].SenderID != aliceID {
		t.Fatalf("Expected sender Alice, got: %s", msgList.Messages[0].SenderID)
	}

	// 10. Security Authorization Check: Eve attempts to read Alice & Bob's conversation -> MUST return 403 Forbidden!
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("Eve request failed: %v", err)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("SECURITY VIOLATION: Expected 403 Forbidden for unauthorized user Eve, got: %d", resp.StatusCode)
	}

	// 11. Security Authorization Check: Eve attempts to send message to Alice & Bob's conversation -> MUST return 403 Forbidden!
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgBody))
	req.Header.Set("Authorization", "Bearer "+eveToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("Eve post request failed: %v", err)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("SECURITY VIOLATION: Expected 403 Forbidden for unauthorized user Eve, got: %d", resp.StatusCode)
	}

	// 12. Crypto Key Package Registration & Retrieval
	bobDevID := bobAuth["device_id"].(string)
	keyRegBody, _ := json.Marshal(map[string]interface{}{
		"device_id":           bobDevID,
		"identity_public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtestpublickey12345",
		"pre_keys":            []string{"prekey_001", "prekey_002"},
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/crypto/keys", bytes.NewReader(keyRegBody))
	req.Header.Set("Authorization", "Bearer "+bobToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob key registration failed: %v, status: %d", err, resp.StatusCode)
	}

	// Alice fetches Bob's key package
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/crypto/keys/"+bobID, nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Alice fetch Bob keys failed: %v", err)
	}
	var userKeys crypto.UserKeyPackage
	_ = json.NewDecoder(resp.Body).Decode(&userKeys)
	if len(userKeys.Devices) != 1 || userKeys.Devices[0].IdentityPublicKey != "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtestpublickey12345" {
		t.Fatalf("Unexpected user keys: %+v", userKeys)
	}
	if userKeys.Devices[0].OneTimePreKey != "prekey_001" {
		t.Fatalf("Expected one_time_pre_key 'prekey_001', got: %s", userKeys.Devices[0].OneTimePreKey)
	}
}

func TestWebSocketLiveEventAndCursorReplay(t *testing.T) {
	server, _, _ := setupTestServer(t)
	client := server.Client()

	// Register Charlie and Dana
	regPayload, _ := json.Marshal(map[string]string{
		"username":     "charlie",
		"display_name": "Charlie",
		"password":     "Password123!",
	})
	resp, _ := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(regPayload))
	var cAuth map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&cAuth)
	charlieToken := cAuth["token"].(string)

	regPayload, _ = json.Marshal(map[string]string{
		"username":     "dana",
		"display_name": "Dana",
		"password":     "Password123!",
	})
	resp, _ = client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(regPayload))
	var dAuth map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&dAuth)
	danaToken := dAuth["token"].(string)
	danaUser := dAuth["user"].(map[string]interface{})
	danaID := danaUser["id"].(string)

	// Charlie creates direct conversation with Dana
	convBody, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": danaID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convBody))
	req.Header.Set("Authorization", "Bearer "+charlieToken)
	resp, _ = client.Do(req)
	var conv models.Conversation
	_ = json.NewDecoder(resp.Body).Decode(&conv)

	// Connect Dana to WebSocket
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + danaToken
	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("WebSocket connection failed: %v", err)
	}
	defer wsConn.Close()

	// Send ping over WS
	pingEnv := events.ClientEnvelope{V: 1, Type: "ping", ID: "ping-1"}
	if err := wsConn.WriteJSON(pingEnv); err != nil {
		t.Fatalf("Failed to send ping: %v", err)
	}

	// Read pong
	var pongEnv events.ClientEnvelope
	_ = wsConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err := wsConn.ReadJSON(&pongEnv); err != nil || pongEnv.Type != "pong" {
		t.Fatalf("Expected pong, got: %+v (err: %v)", pongEnv, err)
	}

	// Charlie sends message
	msgBody, _ := json.Marshal(map[string]string{
		"ciphertext": "secret_realtime_msg",
		"nonce":      "nonce_ws_123",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgBody))
	req.Header.Set("Authorization", "Bearer "+charlieToken)
	_, _ = client.Do(req)

	// Dana should receive live event on WebSocket!
	var liveEvent events.ClientEnvelope
	_ = wsConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err := wsConn.ReadJSON(&liveEvent); err != nil {
		t.Fatalf("Failed to receive real-time event on WebSocket: %v", err)
	}
	if liveEvent.Type != "message.created" {
		t.Fatalf("Expected event type 'message.created', got: %s", liveEvent.Type)
	}
	if !strings.Contains(string(liveEvent.Payload), "secret_realtime_msg") {
		t.Fatalf("Expected payload to contain ciphertext, got: %s", string(liveEvent.Payload))
	}

	// Disconnect Dana
	wsConn.Close()

	// Charlie sends another message while Dana is offline
	msgBody2, _ := json.Marshal(map[string]string{
		"ciphertext": "offline_message_while_disconnected",
		"nonce":      "nonce_ws_456",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgBody2))
	req.Header.Set("Authorization", "Bearer "+charlieToken)
	_, _ = client.Do(req)

	// Dana reconnects and requests cursor sync from last received cursor
	reconnWS, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Reconnect failed: %v", err)
	}
	defer reconnWS.Close()

	syncPayloadBytes, _ := json.Marshal(events.SyncRequestPayload{
		LastEventID: liveEvent.Cursor,
	})
	syncReq := events.ClientEnvelope{
		V:       1,
		Type:    "sync.request",
		ID:      "sync-1",
		Payload: syncPayloadBytes,
	}
	if err := reconnWS.WriteJSON(syncReq); err != nil {
		t.Fatalf("Failed to send sync.request: %v", err)
	}

	// Replayed event must be received!
	var replayedEvent events.ClientEnvelope
	_ = reconnWS.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err := reconnWS.ReadJSON(&replayedEvent); err != nil {
		t.Fatalf("Failed to receive replayed event: %v", err)
	}
	if replayedEvent.Type != "message.created" {
		t.Fatalf("Expected replayed event 'message.created', got: %s", replayedEvent.Type)
	}
	if !strings.Contains(string(replayedEvent.Payload), "offline_message_while_disconnected") {
		t.Fatalf("Expected replayed payload to contain offline message, got: %s", string(replayedEvent.Payload))
	}
}
