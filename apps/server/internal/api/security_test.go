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

func setupSecurityTestServer(t *testing.T) (*httptest.Server, *Router, storage.Store, *auth.SessionService) {
	driver := "sqlite"
	dsn := fmt.Sprintf("file:sec_test_%d?mode=memory&cache=shared", time.Now().UnixNano())
	if testDB := os.Getenv("TEST_DATABASE_URL"); testDB != "" {
		driver = "postgres"
		dsn = testDB
	}
	store, err := storage.NewSQLStore(driver, dsn)
	if err != nil {
		t.Fatalf("Failed to initialize security test store (%s): %v", driver, err)
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

	return server, router, store, sessionService
}

func registerTestUser(t *testing.T, server *httptest.Server, username, password string) (string, string) {
	client := server.Client()
	body, _ := json.Marshal(map[string]string{
		"username":     username,
		"display_name": username + " Display",
		"password":     password,
	})
	resp, err := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(body))
	if err == nil && resp.StatusCode == http.StatusBadRequest {
		loginBody, _ := json.Marshal(map[string]string{
			"username": username,
			"password": password,
		})
		loginResp, loginErr := client.Post(server.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(loginBody))
		if loginErr == nil && loginResp.StatusCode == http.StatusOK {
			var res map[string]interface{}
			_ = json.NewDecoder(loginResp.Body).Decode(&res)
			token := res["token"].(string)
			user := res["user"].(map[string]interface{})
			return user["id"].(string), token
		}
	}
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to register %s: %v, status: %d", username, err, resp.StatusCode)
	}
	var res map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&res)
	token := res["token"].(string)
	user := res["user"].(map[string]interface{})
	return user["id"].(string), token
}

// 1. Adversarial Test: Unauthorized Conversation Access (Broken Object Level Authorization - BOLA)
func TestSecurityUnauthorizedConversationAccess(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	client := server.Client()

	aliceID, aliceToken := registerTestUser(t, server, "alice_sec", "Password123!")
	bobID, _ := registerTestUser(t, server, "bob_sec", "Password123!")
	_, eveToken := registerTestUser(t, server, "eve_sec", "Password123!")

	// Alice creates direct conversation with Bob
	convBody, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create conversation: %v, status: %d", err, resp.StatusCode)
	}
	var conv models.Conversation
	_ = json.NewDecoder(resp.Body).Decode(&conv)

	// Alice sends message
	msgBody, _ := json.Marshal(map[string]string{
		"ciphertext": "confidential_alice_bob_payload",
		"nonce":      "nonce_12345",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to send message: %d", resp.StatusCode)
	}

	// Adversary Eve attempts to read messages -> MUST return 403 Forbidden
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("SECURITY FAW: Eve was able to access conversation! Expected 403 Forbidden, got: %d", resp.StatusCode)
	}

	// Adversary Eve attempts to post message to Alice-Bob conversation -> MUST return 403 Forbidden
	eveMsgBody, _ := json.Marshal(map[string]string{
		"ciphertext": "malicious_injected_message",
		"nonce":      "nonce_67890",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(eveMsgBody))
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("SECURITY FLAW: Eve was able to inject message into conversation! Expected 403 Forbidden, got: %d", resp.StatusCode)
	}

	_ = aliceID
}

// 2. Adversarial Test: Missing, Invalid, and Expired Sessions
func TestSecuritySessionValidationAndExpiration(t *testing.T) {
	server, _, store, sessionService := setupSecurityTestServer(t)
	client := server.Client()

	userID, validToken := registerTestUser(t, server, "session_user", "Password123!")

	// A. Missing token
	req, _ := http.NewRequest("GET", server.URL+"/api/v1/auth/me", nil)
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 on missing token, got: %d", resp.StatusCode)
	}

	// B. Forged/invalid token
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer ses_forged_random_fake_token_123")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 on forged token, got: %d", resp.StatusCode)
	}

	// C. Valid token succeeds
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+validToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200 on valid token, got: %d", resp.StatusCode)
	}

	// D. Expired token: create session with negative TTL
	expiredSess := &models.Session{
		ID:        "ses_expired_test",
		Token:     "ses_expired_token_123",
		UserID:    userID,
		ExpiresAt: time.Now().UTC().Add(-1 * time.Hour),
		CreatedAt: time.Now().UTC().Add(-2 * time.Hour),
	}
	_ = store.CreateSession(context.Background(), expiredSess)

	req, _ = http.NewRequest("GET", server.URL+"/api/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer ses_expired_token_123")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 on expired session token, got: %d", resp.StatusCode)
	}

	// E. Session revocation (Logout)
	_ = sessionService.RevokeSession(context.Background(), validToken)
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+validToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 after session revocation, got: %d", resp.StatusCode)
	}
}

// 3. Adversarial Test: Oversized Payload & Missing Mandatory Fields
func TestSecurityPayloadLimitsAndValidation(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	client := server.Client()

	_, aliceToken := registerTestUser(t, server, "payload_alice", "Password123!")
	bobID, _ := registerTestUser(t, server, "payload_bob", "Password123!")

	// Create conversation
	convBody, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ := client.Do(req)
	var conv models.Conversation
	_ = json.NewDecoder(resp.Body).Decode(&conv)

	// A. Empty ciphertext & nonce -> Must reject
	emptyMsg, _ := json.Marshal(map[string]string{
		"ciphertext": "",
		"nonce":      "",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(emptyMsg))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("Expected 400 Bad Request on empty ciphertext/nonce, got: %d", resp.StatusCode)
	}

	// B. Oversized ciphertext (> 64KB) -> Must reject
	oversizedBytes := make([]byte, 70*1024)
	for i := range oversizedBytes {
		oversizedBytes[i] = 'A'
	}
	oversizedMsg, _ := json.Marshal(map[string]string{
		"ciphertext": string(oversizedBytes),
		"nonce":      "nonce_123",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(oversizedMsg))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("Expected 400 Bad Request on oversized payload, got: %d", resp.StatusCode)
	}
}

// 4. Adversarial Test: Cross-Site WebSocket Hijacking (Origin Header Validation)
func TestSecurityWebSocketOriginCheck(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	_, token := registerTestUser(t, server, "ws_origin_user", "Password123!")

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + token

	// Connecting with unauthorized evil origin: "https://evil-attacker-site.com"
	header := http.Header{}
	header.Set("Origin", "https://evil-attacker-site.com")

	dialer := websocket.DefaultDialer
	_, resp, err := dialer.Dial(wsURL, header)
	if err == nil {
		t.Fatal("SECURITY FLAW: WebSocket connection succeeded from unauthorized origin 'https://evil-attacker-site.com'!")
	}
	if resp != nil && resp.StatusCode != http.StatusForbidden {
		t.Logf("WebSocket handshake failed as expected with status: %d", resp.StatusCode)
	}
}

// 5. Adversarial Test: WebSocket Origin Prefix-Bypass Defense
func TestSecurityWebSocketOriginPrefixBypassRejection(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	_, token := registerTestUser(t, server, "ws_prefix_user", "Password123!")
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + token

	bypasses := []string{
		"https://localhost.attacker.com",
		"http://localhost.evil-domain.xyz",
		"https://127.0.0.1.attacker.net",
		"http://127.0.0.1.phishing.org",
	}

	dialer := websocket.DefaultDialer
	for _, origin := range bypasses {
		header := http.Header{}
		header.Set("Origin", origin)
		_, resp, err := dialer.Dial(wsURL, header)
		if err == nil {
			t.Fatalf("SECURITY FLAW: Prefix bypass succeeded for Origin: %s!", origin)
		}
		if resp != nil && resp.StatusCode != http.StatusForbidden {
			t.Logf("Origin %s properly rejected with status %d", origin, resp.StatusCode)
		}
	}
}

// 6. Adversarial Test: Rate Limiting Defense (HTTP 429 on abuse)
func TestSecurityRateLimiting(t *testing.T) {
	server, router, _, _ := setupSecurityTestServer(t)
	router.GetAuthLimiter().Reset()
	client := server.Client()

	loginPayload, _ := json.Marshal(map[string]string{
		"username": "ratelimit_target",
		"password": "WrongPassword!",
	})

	// Make 10 requests (the limit)
	for i := 0; i < 10; i++ {
		req, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/login", bytes.NewReader(loginPayload))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Request %d failed: %v", i, err)
		}
		_ = resp.Body.Close()
	}

	// 11th request must receive HTTP 429 Too Many Requests
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/login", bytes.NewReader(loginPayload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("11th request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("Expected HTTP 429 Too Many Requests, got %d", resp.StatusCode)
	}

	retryAfter := resp.Header.Get("Retry-After")
	if retryAfter == "" {
		t.Fatalf("Expected Retry-After header on HTTP 429 response")
	}
}

// 7. Adversarial Test: Active WebSocket Terminated on Session Logout
func TestSecurityWebSocketDisconnectOnLogout(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	_, token := registerTestUser(t, server, "ws_logout_user", "Password123!")

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + token
	header := http.Header{}
	header.Set("Origin", "http://localhost:5173")

	dialer := websocket.DefaultDialer
	conn, _, err := dialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("Failed to establish WebSocket connection: %v", err)
	}
	defer conn.Close()

	// Call logout endpoint
	client := server.Client()
	logoutReq, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/logout", nil)
	logoutReq.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(logoutReq)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Logout request failed: %v", err)
	}
	_ = resp.Body.Close()

	// The active WebSocket should receive EOF or Close within 1 second
	conn.SetReadDeadline(time.Now().Add(1 * time.Second))
	_, _, err = conn.ReadMessage()
	if err == nil {
		t.Fatal("SECURITY FLAW: WebSocket connection remained active after logout!")
	}
}

// 8. Adversarial Test: Key Registration Device ID Binding
func TestSecurityRegisterKeysSessionDeviceBinding(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	_, aliceToken := registerTestUser(t, server, "device_alice", "Password123!")
	_, _ = registerTestUser(t, server, "device_bob", "Password123!")

	client := server.Client()

	// Alice attempts to register keys under an unauthorized/foreign device ID
	foreignDeviceKeys, _ := json.Marshal(map[string]interface{}{
		"device_id":           "dev_foreign_device_999",
		"identity_public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7pQ7...",
	})

	req, _ := http.NewRequest("POST", server.URL+"/api/v1/crypto/keys", bytes.NewReader(foreignDeviceKeys))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected HTTP 403 Forbidden when registering keys for non-session device, got: %d", resp.StatusCode)
	}
}

// 9. Adversarial Test: Revoked Token Reuse and Sending Messages After Logout
func TestSecurityReuseRevokedTokenAndSendMessageAfterLogout(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	_, token := registerTestUser(t, server, "revoked_user_1", "Password123!")
	bobID, _ := registerTestUser(t, server, "revoked_bob_1", "Password123!")

	client := server.Client()

	// Create conversation while authenticated
	convBody, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	cReq, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convBody))
	cReq.Header.Set("Authorization", "Bearer "+token)
	cResp, err := client.Do(cReq)
	if err != nil || cResp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create conversation: %v", err)
	}
	var conv models.Conversation
	_ = json.NewDecoder(cResp.Body).Decode(&conv)
	cResp.Body.Close()

	// Log out
	logoutReq, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/logout", nil)
	logoutReq.Header.Set("Authorization", "Bearer "+token)
	lResp, err := client.Do(logoutReq)
	if err != nil || lResp.StatusCode != http.StatusOK {
		t.Fatalf("Logout failed: %v", err)
	}
	lResp.Body.Close()

	// 1. Attempt GET /api/v1/auth/me with revoked token -> must receive HTTP 401
	meReq, _ := http.NewRequest("GET", server.URL+"/api/v1/auth/me", nil)
	meReq.Header.Set("Authorization", "Bearer "+token)
	meResp, err := client.Do(meReq)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer meResp.Body.Close()
	if meResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected HTTP 401 Unauthorized for revoked token, got: %d", meResp.StatusCode)
	}

	// 2. Attempt POST message with revoked token -> must receive HTTP 401
	msgBody, _ := json.Marshal(map[string]string{
		"ciphertext": "post_logout_attempt",
		"nonce":      "nonce_abc",
	})
	mReq, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgBody))
	mReq.Header.Set("Authorization", "Bearer "+token)
	mResp, err := client.Do(mReq)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer mResp.Body.Close()
	if mResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected HTTP 401 Unauthorized for post-logout message, got: %d", mResp.StatusCode)
	}

	// 3. Attempt WebSocket handshake with revoked token -> must fail
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + token
	header := http.Header{}
	header.Set("Origin", "http://localhost:5173")
	_, _, err = websocket.DefaultDialer.Dial(wsURL, header)
	if err == nil {
		t.Fatal("Expected WebSocket connection to be rejected for revoked token, but it succeeded")
	}
}

// 10. Adversarial Test: Multi-Device Session Isolation (Per-Device Logout)
func TestSecurityMultiDeviceSessionIsolation(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	client := server.Client()

	// Register multidev user on device 1
	regBody, _ := json.Marshal(map[string]string{
		"username":     "multidev_user",
		"display_name": "Multi Device User",
		"password":     "Password123!",
		"device_name":  "Laptop",
	})
	rResp, err := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(regBody))
	if err != nil || rResp.StatusCode != http.StatusCreated {
		t.Fatalf("Registration failed: %v", err)
	}
	var res1 map[string]interface{}
	_ = json.NewDecoder(rResp.Body).Decode(&res1)
	rResp.Body.Close()
	dev1Token := res1["token"].(string)

	// Login same user on device 2
	loginBody, _ := json.Marshal(map[string]string{
		"username":    "multidev_user",
		"password":    "Password123!",
		"device_name": "Mobile Phone",
	})
	lResp, err := client.Post(server.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(loginBody))
	if err != nil || lResp.StatusCode != http.StatusOK {
		t.Fatalf("Login on second device failed: %v", err)
	}
	var res2 map[string]interface{}
	_ = json.NewDecoder(lResp.Body).Decode(&res2)
	lResp.Body.Close()
	dev2Token := res2["token"].(string)

	if dev1Token == dev2Token {
		t.Fatal("Different devices must receive distinct session tokens")
	}

	// Connect WebSockets for both devices
	wsHeader := http.Header{}
	wsHeader.Set("Origin", "http://localhost:5173")

	wsURL1 := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + dev1Token
	conn1, _, err := websocket.DefaultDialer.Dial(wsURL1, wsHeader)
	if err != nil {
		t.Fatalf("Device 1 WS connection failed: %v", err)
	}
	defer conn1.Close()

	wsURL2 := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + dev2Token
	conn2, _, err := websocket.DefaultDialer.Dial(wsURL2, wsHeader)
	if err != nil {
		t.Fatalf("Device 2 WS connection failed: %v", err)
	}
	defer conn2.Close()

	// Device 1 logs out (per-device logout)
	logoutReq, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/logout", nil)
	logoutReq.Header.Set("Authorization", "Bearer "+dev1Token)
	resp, err := client.Do(logoutReq)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Device 1 logout request failed: %v", err)
	}
	resp.Body.Close()

	// Device 1's WebSocket must be closed
	conn1.SetReadDeadline(time.Now().Add(1 * time.Second))
	_, _, err = conn1.ReadMessage()
	if err == nil {
		t.Fatal("Device 1 WebSocket should have been disconnected upon logout")
	}

	// Device 2's WebSocket MUST STILL BE ACTIVE and functional
	pingEnv := events.ClientEnvelope{V: 1, Type: "ping", ID: "ping_dev2"}
	pingData, _ := json.Marshal(pingEnv)
	if err := conn2.WriteMessage(websocket.TextMessage, pingData); err != nil {
		t.Fatalf("Device 2 should still be able to write: %v", err)
	}

	conn2.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := conn2.ReadMessage()
	if err != nil {
		t.Fatalf("Device 2 WebSocket unexpectedly failed after Device 1 logged out: %v", err)
	}

	var pongEnv events.ClientEnvelope
	_ = json.Unmarshal(msg, &pongEnv)
	if pongEnv.Type != "pong" {
		t.Fatalf("Expected pong from Device 2, got type: %s", pongEnv.Type)
	}
}

// 11. Adversarial Test: Idempotency Cross-User and Cross-Conversation Isolation
func TestSecurityIdempotencyCrossUserIsolation(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	client := server.Client()

	aliceID, aliceToken := registerTestUser(t, server, "idemp_alice", "Password123!")
	bobID, _ := registerTestUser(t, server, "idemp_bob", "Password123!")
	charlieID, charlieToken := registerTestUser(t, server, "idemp_charlie", "Password123!")
	daveID, _ := registerTestUser(t, server, "idemp_dave", "Password123!")

	// Alice creates Conversation A with Bob
	cBodyA, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	rA, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(cBodyA))
	rA.Header.Set("Authorization", "Bearer "+aliceToken)
	respA, _ := client.Do(rA)
	var convA models.Conversation
	_ = json.NewDecoder(respA.Body).Decode(&convA)
	respA.Body.Close()

	// Charlie creates Conversation B with Dave
	cBodyB, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": daveID,
	})
	rB, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(cBodyB))
	rB.Header.Set("Authorization", "Bearer "+charlieToken)
	respB, _ := client.Do(rB)
	var convB models.Conversation
	_ = json.NewDecoder(respB.Body).Decode(&convB)
	respB.Body.Close()

	sharedIdempKey := "shared_tx_key_9999"

	// Alice submits message with sharedIdempKey
	aliceMsgBody, _ := json.Marshal(map[string]string{
		"ciphertext":      "alice_confidential_message",
		"nonce":           "nonce_alice",
		"idempotency_key": sharedIdempKey,
	})
	reqAliceMsg, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convA.ID+"/messages", bytes.NewReader(aliceMsgBody))
	reqAliceMsg.Header.Set("Authorization", "Bearer "+aliceToken)
	respAliceMsg, err := client.Do(reqAliceMsg)
	if err != nil || respAliceMsg.StatusCode != http.StatusCreated {
		t.Fatalf("Alice message creation failed: %v", err)
	}
	var aliceMsg models.Message
	_ = json.NewDecoder(respAliceMsg.Body).Decode(&aliceMsg)
	respAliceMsg.Body.Close()

	// Charlie submits message with the EXACT SAME idempotency key in Conversation B
	charlieMsgBody, _ := json.Marshal(map[string]string{
		"ciphertext":      "charlie_distinct_message",
		"nonce":           "nonce_charlie",
		"idempotency_key": sharedIdempKey,
	})
	reqCharlieMsg, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convB.ID+"/messages", bytes.NewReader(charlieMsgBody))
	reqCharlieMsg.Header.Set("Authorization", "Bearer "+charlieToken)
	respCharlieMsg, err := client.Do(reqCharlieMsg)
	if err != nil || respCharlieMsg.StatusCode != http.StatusCreated {
		t.Fatalf("Charlie message creation failed: %v", err)
	}
	var charlieMsg models.Message
	_ = json.NewDecoder(respCharlieMsg.Body).Decode(&charlieMsg)
	respCharlieMsg.Body.Close()

	// Verify Charlie's message did NOT receive Alice's data!
	if charlieMsg.Ciphertext == aliceMsg.Ciphertext {
		t.Fatal("SECURITY FLAW: Charlie's message retrieved Alice's data across idempotency key boundary!")
	}
	if charlieMsg.SenderID != charlieID {
		t.Fatalf("Expected sender %s, got: %s", charlieID, charlieMsg.SenderID)
	}
	if aliceMsg.SenderID != aliceID {
		t.Fatalf("Expected sender %s, got: %s", aliceID, aliceMsg.SenderID)
	}

	// Charlie resubmits with same idempotency key -> returns Charlie's existing message (idempotent deduplication)
	reqRetry, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convB.ID+"/messages", bytes.NewReader(charlieMsgBody))
	reqRetry.Header.Set("Authorization", "Bearer "+charlieToken)
	respRetry, _ := client.Do(reqRetry)
	var retryMsg models.Message
	_ = json.NewDecoder(respRetry.Body).Decode(&retryMsg)
	respRetry.Body.Close()

	if retryMsg.ID != charlieMsg.ID {
		t.Fatalf("Expected same message ID %s on idempotent retry, got: %s", charlieMsg.ID, retryMsg.ID)
	}
}

// 12. Adversarial Test: Spoofed X-Forwarded-For Header Does Not Bypass Rate Limiter
func TestSecurityRateLimiterSpoofedForwardingHeader(t *testing.T) {
	server, router, _, _ := setupSecurityTestServer(t)
	router.GetAuthLimiter().Reset()
	client := server.Client()

	payload, _ := json.Marshal(map[string]string{
		"username": "spoof_user",
		"password": "wrong_password",
	})

	// Client sends 10 requests rotating fake X-Forwarded-For headers
	for i := 0; i < 10; i++ {
		req, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/login", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d", i+1))
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Request %d failed: %v", i, err)
		}
		resp.Body.Close()
	}

	// 11th request with yet another spoofed IP must STILL be blocked (because proxy is not trusted)
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/login", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", "203.0.113.250")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("11th request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("SECURITY FLAW: Rate limiter bypassed via spoofed X-Forwarded-For! Expected HTTP 429, got: %d", resp.StatusCode)
	}
}

// 13. Adversarial Test: Account-Level Rate Limiting Against Distributed Credential Stuffing
func TestSecurityAccountBruteForceRateLimiting(t *testing.T) {
	server, router, _, _ := setupSecurityTestServer(t)
	router.GetAccountLimiter().Reset()
	client := server.Client()

	// 5 failed login attempts for victim account
	for i := 0; i < 5; i++ {
		payload, _ := json.Marshal(map[string]string{
			"username": "victim_target_user",
			"password": fmt.Sprintf("bad_password_%d", i),
		})
		req, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/login", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Attempt %d failed: %v", i, err)
		}
		resp.Body.Close()
	}

	// 6th attempt on the victim account must be throttled with HTTP 429
	payload, _ := json.Marshal(map[string]string{
		"username": "victim_target_user",
		"password": "another_bad_password",
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/login", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("6th attempt failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("Expected HTTP 429 for account brute-force throttling, got: %d", resp.StatusCode)
	}
	var res map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&res)
	errMap := res["error"].(map[string]interface{})
	if errMap["code"] != "ACCOUNT_RATE_LIMIT_EXCEEDED" {
		t.Fatalf("Expected code ACCOUNT_RATE_LIMIT_EXCEEDED, got: %s", errMap["code"])
	}
}

// 14. Adversarial Test: WebSocket Origin Scheme and Port Enforcement
func TestSecurityWebSocketOriginStrictPortAndScheme(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	_, token := registerTestUser(t, server, "origin_strict_user", "Password123!")

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + token

	// Test 1: Untrusted scheme (ftp://)
	h1 := http.Header{}
	h1.Set("Origin", "ftp://localhost:5173")
	_, _, err := websocket.DefaultDialer.Dial(wsURL, h1)
	if err == nil {
		t.Fatal("Expected rejection for non-http/https scheme ftp://")
	}

	// Test 2: Host prefix bypass domain
	h2 := http.Header{}
	h2.Set("Origin", "http://localhost.attacker.com:5173")
	_, _, err = websocket.DefaultDialer.Dial(wsURL, h2)
	if err == nil {
		t.Fatal("Expected rejection for prefix domain localhost.attacker.com")
	}

	// Test 3: Valid loopback origin (PASS)
	h3 := http.Header{}
	h3.Set("Origin", "http://localhost:5173")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, h3)
	if err != nil {
		t.Fatalf("Valid loopback origin should succeed: %v", err)
	}
	conn.Close()
}

// 15. Functional Test: Route Normalization Handles Trailing Slashes
func TestSecurityRouteNormalizationTrailingSlash(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	client := server.Client()

	// Calling POST /api/v1/auth/login/ with a trailing slash should match the login handler
	// rather than returning a 404 Not Found
	payload, _ := json.Marshal(map[string]string{
		"username": "nonexistent",
		"password": "wrong",
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/login/", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		t.Fatal("Router failed to normalize trailing slash: returned 404 Not Found")
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected HTTP 401 Unauthorized from login handler, got: %d", resp.StatusCode)
	}
}

// 16. Multi-Device E2EE Integration Scenario (Alice A1, Alice A2, Bob B1, Bob B2)
func TestSecurityFourDeviceMultiDeviceScenario(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	client := server.Client()

	// 1. Register Alice (Device A1)
	aliceRegBody, _ := json.Marshal(map[string]string{
		"username":     "alice_multidev",
		"display_name": "Alice M",
		"password":     "AlicePass123!",
	})
	respA1, err := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(aliceRegBody))
	if err != nil {
		t.Fatalf("Alice A1 register failed: %v", err)
	}
	var a1Auth map[string]interface{}
	_ = json.NewDecoder(respA1.Body).Decode(&a1Auth)
	respA1.Body.Close()
	aliceID := a1Auth["user"].(map[string]interface{})["id"].(string)
	a1Token := a1Auth["token"].(string)
	a1DeviceID := a1Auth["device_id"].(string)

	// 2. Alice logs in from second device (Device A2)
	aliceLoginBody, _ := json.Marshal(map[string]string{
		"username": "alice_multidev",
		"password": "AlicePass123!",
	})
	respA2, err := client.Post(server.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(aliceLoginBody))
	if err != nil {
		t.Fatalf("Alice A2 login failed: %v", err)
	}
	var a2Auth map[string]interface{}
	_ = json.NewDecoder(respA2.Body).Decode(&a2Auth)
	respA2.Body.Close()
	a2Token := a2Auth["token"].(string)
	a2DeviceID := a2Auth["device_id"].(string)

	if a1DeviceID == a2DeviceID {
		t.Fatal("Expected distinct device IDs for Alice A1 and Alice A2")
	}

	// 3. Register Bob (Device B1)
	bobRegBody, _ := json.Marshal(map[string]string{
		"username":     "bob_multidev",
		"display_name": "Bob M",
		"password":     "BobPass123!",
	})
	respB1, _ := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(bobRegBody))
	var b1Auth map[string]interface{}
	_ = json.NewDecoder(respB1.Body).Decode(&b1Auth)
	respB1.Body.Close()
	bobID := b1Auth["user"].(map[string]interface{})["id"].(string)
	b1Token := b1Auth["token"].(string)
	b1DeviceID := b1Auth["device_id"].(string)

	// 4. Bob logs in from second device (Device B2)
	bobLoginBody, _ := json.Marshal(map[string]string{
		"username": "bob_multidev",
		"password": "BobPass123!",
	})
	respB2, _ := client.Post(server.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(bobLoginBody))
	var b2Auth map[string]interface{}
	_ = json.NewDecoder(respB2.Body).Decode(&b2Auth)
	respB2.Body.Close()
	b2Token := b2Auth["token"].(string)
	b2DeviceID := b2Auth["device_id"].(string)

	if b1DeviceID == b2DeviceID {
		t.Fatal("Expected distinct device IDs for Bob B1 and Bob B2")
	}

	// 5. Each of the 4 devices registers distinct public keys
	registerKey := func(token, devID, pubKey string) {
		body, _ := json.Marshal(map[string]interface{}{
			"device_id":           devID,
			"identity_public_key": pubKey,
			"pre_keys":            []string{"prekey_1", "prekey_2"},
		})
		req, _ := http.NewRequest("POST", server.URL+"/api/v1/crypto/keys", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		r, err := client.Do(req)
		if err != nil || r.StatusCode != http.StatusOK {
			t.Fatalf("Key registration failed for dev %s: code %d, err %v", devID, r.StatusCode, err)
		}
		r.Body.Close()
	}

	registerKey(a1Token, a1DeviceID, "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEalice_d1_valid_key_32chars")
	registerKey(a2Token, a2DeviceID, "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEalice_d2_valid_key_32chars")
	registerKey(b1Token, b1DeviceID, "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbob_d1_valid_key_32chars")
	registerKey(b2Token, b2DeviceID, "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbob_d2_valid_key_32chars")

	// 6. Alice A1 discovers Bob's devices: must return both B1 and B2
	reqBobKeys, _ := http.NewRequest("GET", server.URL+"/api/v1/crypto/keys/"+bobID, nil)
	reqBobKeys.Header.Set("Authorization", "Bearer "+a1Token)
	rBobKeys, err := client.Do(reqBobKeys)
	if err != nil || rBobKeys.StatusCode != http.StatusOK {
		t.Fatalf("Failed to fetch Bob's keys: %v", err)
	}
	var bobPkg map[string]interface{}
	_ = json.NewDecoder(rBobKeys.Body).Decode(&bobPkg)
	rBobKeys.Body.Close()

	bobDevices := bobPkg["devices"].([]interface{})
	if len(bobDevices) != 2 {
		t.Fatalf("Expected 2 devices for Bob, got %d", len(bobDevices))
	}

	// 7. Alice A1 discovers her own devices: must return both A1 and A2
	reqAliceKeys, _ := http.NewRequest("GET", server.URL+"/api/v1/crypto/keys/"+aliceID, nil)
	reqAliceKeys.Header.Set("Authorization", "Bearer "+a1Token)
	rAliceKeys, err := client.Do(reqAliceKeys)
	if err != nil || rAliceKeys.StatusCode != http.StatusOK {
		t.Fatalf("Failed to fetch Alice's keys: %v", err)
	}
	var alicePkg map[string]interface{}
	_ = json.NewDecoder(rAliceKeys.Body).Decode(&alicePkg)
	rAliceKeys.Body.Close()

	aliceDevices := alicePkg["devices"].([]interface{})
	if len(aliceDevices) != 2 {
		t.Fatalf("Expected 2 devices for Alice, got %d", len(aliceDevices))
	}

	// 8. Create direct conversation between Alice and Bob
	cBody, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	reqConv, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(cBody))
	reqConv.Header.Set("Authorization", "Bearer "+a1Token)
	rConv, _ := client.Do(reqConv)
	var conv models.Conversation
	_ = json.NewDecoder(rConv.Body).Decode(&conv)
	rConv.Body.Close()

	// 9. Alice A1 submits multi-device encrypted envelope
	multiDeviceEnvelope := fmt.Sprintf(`{"v":1,"sender_device_id":"%s","sender_public_key":"spki_key_alice_d1","devices":{"%s":{"ciphertext":"ct_for_b1","nonce":"n1"},"%s":{"ciphertext":"ct_for_b2","nonce":"n2"},"%s":{"ciphertext":"ct_for_a2","nonce":"n3"}}}`,
		a1DeviceID, b1DeviceID, b2DeviceID, a2DeviceID)

	msgBody, _ := json.Marshal(map[string]string{
		"ciphertext": multiDeviceEnvelope,
		"nonce":      "multidevice",
	})
	reqMsg, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgBody))
	reqMsg.Header.Set("Authorization", "Bearer "+a1Token)
	rMsg, err := client.Do(reqMsg)
	if err != nil || rMsg.StatusCode != http.StatusCreated {
		t.Fatalf("Message submission failed: code %d, err %v", rMsg.StatusCode, err)
	}
	var submittedMsg models.Message
	_ = json.NewDecoder(rMsg.Body).Decode(&submittedMsg)
	rMsg.Body.Close()

	// 10. Verify Zero Plaintext on Server: ciphertext must be the encrypted envelope, never plaintext
	if strings.Contains(submittedMsg.Ciphertext, "secret_plaintext") {
		t.Fatal("Server persists plaintext! Zero Plaintext rule violated!")
	}
	if submittedMsg.Ciphertext != multiDeviceEnvelope {
		t.Fatal("Persisted ciphertext does not match submitted multi-device envelope")
	}

	// 11. Bob B1, Bob B2, and Alice A2 can all fetch the message
	verifyCanFetch := func(token string, expectedDevice string) {
		req, _ := http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages?limit=10", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		r, err := client.Do(req)
		if err != nil || r.StatusCode != http.StatusOK {
			t.Fatalf("Fetch messages failed for device %s: %v", expectedDevice, err)
		}
		var listResp map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&listResp)
		r.Body.Close()
		msgs := listResp["messages"].([]interface{})
		if len(msgs) != 1 {
			t.Fatalf("Device %s expected 1 message, got %d", expectedDevice, len(msgs))
		}
		rawMsg := msgs[0].(map[string]interface{})
		if rawMsg["ciphertext"] != multiDeviceEnvelope {
			t.Fatalf("Device %s did not receive multi-device envelope", expectedDevice)
		}
	}

	verifyCanFetch(b1Token, "Bob B1")
	verifyCanFetch(b2Token, "Bob B2")
	verifyCanFetch(a2Token, "Alice A2")

	// 12. Unauthorized user Eve cannot fetch the message
	_, eveToken := registerTestUser(t, server, "eve_snooper", "EvePass123!")
	reqEve, _ := http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages?limit=10", nil)
	reqEve.Header.Set("Authorization", "Bearer "+eveToken)
	rEve, _ := client.Do(reqEve)
	if rEve.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for Eve, got %d", rEve.StatusCode)
	}
	rEve.Body.Close()

	// 13. Alice logs out of Device A1: verifies per-device revocation (A1 revoked, A2 still active)
	reqLogoutA1, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/logout", nil)
	reqLogoutA1.Header.Set("Authorization", "Bearer "+a1Token)
	rLogoutA1, _ := client.Do(reqLogoutA1)
	if rLogoutA1.StatusCode != http.StatusOK {
		t.Fatalf("A1 logout failed: %d", rLogoutA1.StatusCode)
	}
	rLogoutA1.Body.Close()

	// A1 token is rejected
	reqA1After, _ := http.NewRequest("GET", server.URL+"/api/v1/auth/me", nil)
	reqA1After.Header.Set("Authorization", "Bearer "+a1Token)
	rA1After, _ := client.Do(reqA1After)
	if rA1After.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 for revoked A1 token, got %d", rA1After.StatusCode)
	}
	rA1After.Body.Close()

	// A2 token is STILL valid (session isolation)
	reqA2After, _ := http.NewRequest("GET", server.URL+"/api/v1/auth/me", nil)
	reqA2After.Header.Set("Authorization", "Bearer "+a2Token)
	rA2After, _ := client.Do(reqA2After)
	if rA2After.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200 OK for still-active A2 token, got %d", rA2After.StatusCode)
	}
	rA2After.Body.Close()
}

func TestSecurityChannelWriteAuthorization(t *testing.T) {
	server, _, store, _ := setupSecurityTestServer(t)
	client := server.Client()

	aliceID, aliceToken := registerTestUser(t, server, "alice_channel_owner", "Password123!")
	bobID, bobToken := registerTestUser(t, server, "bob_channel_subscriber", "Password123!")

	// Create channel conversation
	channelConv := &models.Conversation{
		ID:        "conv_test_channel_" + fmt.Sprintf("%d", time.Now().UnixNano()),
		Type:      "channel",
		Title:     "Announcements Channel",
		CreatedAt: time.Now().UTC(),
	}
	if err := store.CreateConversation(context.Background(), channelConv, []string{aliceID}); err != nil {
		t.Fatalf("Failed to create channel: %v", err)
	}

	// Add Bob as a member (subscriber)
	if err := store.AddConversationMember(context.Background(), channelConv.ID, bobID, "member"); err != nil {
		t.Fatalf("Failed to add bob to channel: %v", err)
	}

	// Alice (owner) posts message -> 201 Created
	msgPayloadAlice, _ := json.Marshal(map[string]string{
		"ciphertext": "Hello from owner",
		"nonce":      "nonce_123",
	})
	reqAlice, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+channelConv.ID+"/messages", bytes.NewBuffer(msgPayloadAlice))
	reqAlice.Header.Set("Authorization", "Bearer "+aliceToken)
	reqAlice.Header.Set("Content-Type", "application/json")
	rAlice, err := client.Do(reqAlice)
	if err != nil || rAlice.StatusCode != http.StatusCreated {
		t.Fatalf("Expected Alice (owner) to post to channel, got %d (err: %v)", rAlice.StatusCode, err)
	}
	rAlice.Body.Close()

	// Bob (member/subscriber) attempts to post message -> MUST be 403 Forbidden
	msgPayloadBob, _ := json.Marshal(map[string]string{
		"ciphertext": "Unauthorized post attempt",
		"nonce":      "nonce_456",
	})
	reqBob, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+channelConv.ID+"/messages", bytes.NewBuffer(msgPayloadBob))
	reqBob.Header.Set("Authorization", "Bearer "+bobToken)
	reqBob.Header.Set("Content-Type", "application/json")
	rBob, err := client.Do(reqBob)
	if err != nil || rBob.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected Bob (subscriber) post to be 403 Forbidden, got %d", rBob.StatusCode)
	}
	rBob.Body.Close()
}

func TestSecurityStickersLifecycle(t *testing.T) {
	server, _, _, _ := setupSecurityTestServer(t)
	client := server.Client()

	_, aliceToken := registerTestUser(t, server, "alice_stickers", "Password123!")

	// 1. List sticker packs
	reqList, _ := http.NewRequest("GET", server.URL+"/api/v1/stickers/packs", nil)
	reqList.Header.Set("Authorization", "Bearer "+aliceToken)
	respList, err := client.Do(reqList)
	if err != nil || respList.StatusCode != http.StatusOK {
		t.Fatalf("Failed to list sticker packs: %v, status: %d", err, respList.StatusCode)
	}
	var packsResp struct {
		Packs []*models.StickerPack `json:"packs"`
	}
	_ = json.NewDecoder(respList.Body).Decode(&packsResp)
	respList.Body.Close()

	if len(packsResp.Packs) == 0 {
		t.Fatalf("Expected seeded sticker packs, got 0")
	}

	packID := packsResp.Packs[0].ID

	// 2. Get pack details
	reqGet, _ := http.NewRequest("GET", server.URL+"/api/v1/stickers/packs/"+packID, nil)
	reqGet.Header.Set("Authorization", "Bearer "+aliceToken)
	respGet, err := client.Do(reqGet)
	if err != nil || respGet.StatusCode != http.StatusOK {
		t.Fatalf("Failed to get pack details: %v, status: %d", err, respGet.StatusCode)
	}
	var packDetail models.StickerPack
	_ = json.NewDecoder(respGet.Body).Decode(&packDetail)
	respGet.Body.Close()

	if len(packDetail.Stickers) == 0 {
		t.Fatalf("Expected stickers in pack %s, got 0", packID)
	}

	// 3. Install pack
	reqInstall, _ := http.NewRequest("POST", server.URL+"/api/v1/stickers/installed/"+packID, nil)
	reqInstall.Header.Set("Authorization", "Bearer "+aliceToken)
	respInstall, err := client.Do(reqInstall)
	if err != nil || respInstall.StatusCode != http.StatusOK {
		t.Fatalf("Failed to install pack: %v, status: %d", err, respInstall.StatusCode)
	}
	respInstall.Body.Close()

	// 4. Get installed packs
	reqInstalled, _ := http.NewRequest("GET", server.URL+"/api/v1/stickers/installed", nil)
	reqInstalled.Header.Set("Authorization", "Bearer "+aliceToken)
	respInstalled, err := client.Do(reqInstalled)
	if err != nil || respInstalled.StatusCode != http.StatusOK {
		t.Fatalf("Failed to get installed packs: %v, status: %d", err, respInstalled.StatusCode)
	}
	var installedResp struct {
		Packs []*models.StickerPack `json:"packs"`
	}
	_ = json.NewDecoder(respInstalled.Body).Decode(&installedResp)
	respInstalled.Body.Close()

	found := false
	for _, p := range installedResp.Packs {
		if p.ID == packID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("Installed pack %s not found in user installed packs", packID)
	}

	// 5. Uninstall pack
	reqUninstall, _ := http.NewRequest("DELETE", server.URL+"/api/v1/stickers/installed/"+packID, nil)
	reqUninstall.Header.Set("Authorization", "Bearer "+aliceToken)
	respUninstall, err := client.Do(reqUninstall)
	if err != nil || respUninstall.StatusCode != http.StatusOK {
		t.Fatalf("Failed to uninstall pack: %v, status: %d", err, respUninstall.StatusCode)
	}
	respUninstall.Body.Close()
}

func TestSecurityCallLogsAndSignaling(t *testing.T) {
	server, _, store, _ := setupSecurityTestServer(t)
	client := server.Client()

	aliceID, aliceToken := registerTestUser(t, server, "alice_caller", "Password123!")
	bobID, bobToken := registerTestUser(t, server, "bob_callee", "Password123!")

	// Create direct conversation
	dmConv := &models.Conversation{
		ID:        "conv_dm_call_" + fmt.Sprintf("%d", time.Now().UnixNano()),
		Type:      "direct",
		CreatedAt: time.Now().UTC(),
	}
	if err := store.CreateConversation(context.Background(), dmConv, []string{aliceID, bobID}); err != nil {
		t.Fatalf("Failed to create DM conversation: %v", err)
	}

	// 1. Create call log via API
	callLogPayload, _ := json.Marshal(map[string]interface{}{
		"conversation_id":  dmConv.ID,
		"receiver_id":      bobID,
		"call_type":        "video",
		"status":           "completed",
		"duration_seconds": 45,
	})
	reqCreateCall, _ := http.NewRequest("POST", server.URL+"/api/v1/calls/logs", bytes.NewBuffer(callLogPayload))
	reqCreateCall.Header.Set("Authorization", "Bearer "+aliceToken)
	reqCreateCall.Header.Set("Content-Type", "application/json")
	respCreateCall, err := client.Do(reqCreateCall)
	if err != nil || respCreateCall.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create call log: %v, status: %d", err, respCreateCall.StatusCode)
	}
	respCreateCall.Body.Close()

	// 2. Retrieve call logs for Bob (callee)
	reqGetCalls, _ := http.NewRequest("GET", server.URL+"/api/v1/calls/logs", nil)
	reqGetCalls.Header.Set("Authorization", "Bearer "+bobToken)
	respGetCalls, err := client.Do(reqGetCalls)
	if err != nil || respGetCalls.StatusCode != http.StatusOK {
		t.Fatalf("Failed to get call logs: %v, status: %d", err, respGetCalls.StatusCode)
	}
	var callLogsResp struct {
		Calls []*models.CallLog `json:"calls"`
	}
	_ = json.NewDecoder(respGetCalls.Body).Decode(&callLogsResp)
	respGetCalls.Body.Close()

	if len(callLogsResp.Calls) == 0 {
		t.Fatalf("Expected at least 1 call log for Bob, got 0")
	}
	if callLogsResp.Calls[0].CallType != "video" || callLogsResp.Calls[0].DurationSeconds != 45 {
		t.Fatalf("Call log attributes mismatch: %+v", callLogsResp.Calls[0])
	}
}


