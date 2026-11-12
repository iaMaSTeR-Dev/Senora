package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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

func setupCallTestServer(t *testing.T) (*httptest.Server, storage.Store, *events.Hub) {
	t.Helper()
	driver := "sqlite"
	tempDB := filepath.Join(t.TempDir(), "call_test.db")
	dsn := tempDB
	if testDB := os.Getenv("TEST_DATABASE_URL"); testDB != "" {
		driver = "postgres"
		dsn = testDB
	}
	store, err := storage.NewSQLStore(driver, dsn)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}

	sessionSvc := auth.NewSessionService(store, 24*time.Hour)
	idSvc := identity.NewService(store, sessionSvc)
	convSvc := conversations.NewService(store)
	hub := events.NewHub(store)
	msgSvc := messages.NewService(store, convSvc, hub)
	cryptoSvc := crypto.NewService(store)

	ctx, cancel := context.WithCancel(context.Background())
	go hub.Run(ctx)

	router := NewRouter(store, idSvc, sessionSvc, convSvc, msgSvc, cryptoSvc, hub)
	server := httptest.NewServer(router)
	t.Cleanup(func() {
		server.Close()
		cancel()
		store.Close()
		_ = os.Remove(tempDB)
	})

	return server, store, hub
}

func registerCallTestUser(t *testing.T, server *httptest.Server, username, password string) (string, string) {
	t.Helper()
	regBody, _ := json.Marshal(map[string]string{
		"username":     username,
		"display_name": username + " Display",
		"password":     password,
		"device_name":  "TestDevice",
	})
	resp, err := http.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(regBody))
	if err != nil {
		t.Fatalf("Failed to register %s: %v", username, err)
	}
	defer resp.Body.Close()

	var regResult struct {
		User  models.User `json:"user"`
		Token string      `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&regResult); err != nil {
		t.Fatalf("Failed to decode register response: %v", err)
	}
	return regResult.User.ID, regResult.Token
}

func TestCallSignalingLifecycleAndSecurity(t *testing.T) {
	server, _, _ := setupCallTestServer(t)

	// 1. Register Alice, Bob, and Charlie
	aliceID, aliceToken := registerCallTestUser(t, server, "alice_caller", "Password123!")
	bobID, bobToken := registerCallTestUser(t, server, "bob_callee", "Password123!")
	_, charlieToken := registerCallTestUser(t, server, "charlie_eavesdropper", "Password123!")

	// 2. Create direct conversation between Alice and Bob
	convReq, _ := json.Marshal(map[string]interface{}{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := server.Client().Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create conversation: %v, status: %d", err, resp.StatusCode)
	}
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	// 3. Connect WebSockets for Alice and Bob
	wsHeader := http.Header{}
	wsHeader.Set("Origin", "http://localhost:5173")

	wsURLAlice := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + aliceToken
	wsAlice, _, err := websocket.DefaultDialer.Dial(wsURLAlice, wsHeader)
	if err != nil {
		t.Fatalf("Alice WS connect failed: %v", err)
	}
	defer wsAlice.Close()

	wsURLBob := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + bobToken
	wsBob, respBob, err := websocket.DefaultDialer.Dial(wsURLBob, wsHeader)
	if err != nil {
		status := 0
		if respBob != nil {
			status = respBob.StatusCode
		}
		t.Fatalf("Bob WS connect failed (status %d): %v", status, err)
	}
	defer wsBob.Close()

	// 4. Alice sends call invite to Bob with caller_id: ""
	invitePayload := models.CallSignalPayload{
		CallID:         "call_test_123",
		ConversationID: conv.ID,
		CallerID:       "",
		ReceiverID:     bobID,
		CallType:       "audio",
		SignalType:     "invite",
		Data: map[string]interface{}{
			"peer_name": "bob_callee",
		},
	}
	inviteBytes, _ := json.Marshal(invitePayload)
	clientEnv := events.ClientEnvelope{
		V:       1,
		Type:    "call.signal",
		ID:      "env_invite_1",
		Payload: inviteBytes,
	}
	envBytes, _ := json.Marshal(clientEnv)
	if err := wsAlice.WriteMessage(websocket.TextMessage, envBytes); err != nil {
		t.Fatalf("Failed to write invite from Alice: %v", err)
	}

	// 5. Bob must receive call.signal event with CallerID = aliceID and enriched caller_name
	wsBob.SetReadDeadline(time.Now().Add(6 * time.Second))
	var receivedEnv events.ClientEnvelope
	for {
		_, msgData, err := wsBob.ReadMessage()
		if err != nil {
			t.Fatalf("Bob failed to receive incoming call signal: %v", err)
		}
		var tempEnv events.ClientEnvelope
		if err := json.Unmarshal(msgData, &tempEnv); err == nil && tempEnv.Type == "call.signal" {
			receivedEnv = tempEnv
			break
		}
	}

	var receivedSignal models.CallSignalPayload
	if err := json.Unmarshal(receivedEnv.Payload, &receivedSignal); err != nil {
		t.Fatalf("Failed to unmarshal signal payload: %v", err)
	}

	if receivedSignal.CallerID != aliceID {
		t.Fatalf("Expected CallerID to be Alice (%s), got: %s", aliceID, receivedSignal.CallerID)
	}
	if receivedSignal.ReceiverID != bobID {
		t.Fatalf("Expected ReceiverID to be Bob (%s), got: %s", bobID, receivedSignal.ReceiverID)
	}
	if receivedSignal.SignalType != "invite" {
		t.Fatalf("Expected SignalType invite, got: %s", receivedSignal.SignalType)
	}

	dataMap, ok := receivedSignal.Data.(map[string]interface{})
	if !ok || dataMap["caller_name"] == nil {
		t.Fatalf("Expected caller_name in signal data, got: %v", receivedSignal.Data)
	}

	// 6. Bob responds with accept signal (receiver_id: "", caller_id: aliceID)
	acceptPayload := models.CallSignalPayload{
		CallID:         "call_test_123",
		ConversationID: conv.ID,
		CallerID:       aliceID,
		ReceiverID:     "",
		CallType:       "audio",
		SignalType:     "accept",
	}
	acceptBytes, _ := json.Marshal(acceptPayload)
	acceptEnv := events.ClientEnvelope{
		V:       1,
		Type:    "call.signal",
		ID:      "env_accept_1",
		Payload: acceptBytes,
	}
	acceptEnvBytes, _ := json.Marshal(acceptEnv)
	if err := wsBob.WriteMessage(websocket.TextMessage, acceptEnvBytes); err != nil {
		t.Fatalf("Failed to write accept from Bob: %v", err)
	}

	// 7. Alice receives accept signal from Bob
	wsAlice.SetReadDeadline(time.Now().Add(6 * time.Second))
	var aliceReceivedEnv events.ClientEnvelope
	for {
		_, msgData, err := wsAlice.ReadMessage()
		if err != nil {
			t.Fatalf("Alice failed to receive accept signal: %v", err)
		}
		var tempEnv events.ClientEnvelope
		if err := json.Unmarshal(msgData, &tempEnv); err == nil && tempEnv.Type == "call.signal" {
			aliceReceivedEnv = tempEnv
			break
		}
	}

	var aliceSignal models.CallSignalPayload
	if err := json.Unmarshal(aliceReceivedEnv.Payload, &aliceSignal); err != nil {
		t.Fatalf("Failed to unmarshal Alice's signal payload: %v", err)
	}
	if aliceSignal.SignalType != "accept" {
		t.Fatalf("Expected signal accept, got: %s", aliceSignal.SignalType)
	}

	// 8. Charlie (non-member) attempts to forge a signal into Alice & Bob's conversation -> MUST BE REJECTED
	wsURLCharlie := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + charlieToken
	wsCharlie, _, err := websocket.DefaultDialer.Dial(wsURLCharlie, wsHeader)
	if err != nil {
		t.Fatalf("Charlie WS connect failed: %v", err)
	}
	defer wsCharlie.Close()

	charlieForge := models.CallSignalPayload{
		CallID:         "call_forge_666",
		ConversationID: conv.ID,
		CallerID:       aliceID,
		ReceiverID:     bobID,
		CallType:       "audio",
		SignalType:     "invite",
	}
	forgeBytes, _ := json.Marshal(charlieForge)
	forgeEnv := events.ClientEnvelope{
		V:       1,
		Type:    "call.signal",
		ID:      "env_forge_1",
		Payload: forgeBytes,
	}
	forgeEnvBytes, _ := json.Marshal(forgeEnv)
	_ = wsCharlie.WriteMessage(websocket.TextMessage, forgeEnvBytes)

	wsBob.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	for {
		_, msgData, err := wsBob.ReadMessage()
		if err != nil {
			break
		}
		var tempEnv events.ClientEnvelope
		if err := json.Unmarshal(msgData, &tempEnv); err == nil && tempEnv.Type == "call.signal" {
			var sig models.CallSignalPayload
			json.Unmarshal(tempEnv.Payload, &sig)
			if sig.CallID == "call_forge_666" {
				t.Fatalf("SECURITY VIOLATION: Non-member Charlie forged call signal into Alice and Bob's call!")
			}
		}
	}
}

func TestOutboxMessageEventMetadata(t *testing.T) {
	server, _, _ := setupCallTestServer(t)

	_, aliceToken := registerCallTestUser(t, server, "alice_meta", "Password123!")
	bobID, bobToken := registerCallTestUser(t, server, "bob_meta", "Password123!")

	convReq, _ := json.Marshal(map[string]interface{}{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, _ := server.Client().Do(req)
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	wsHeader := http.Header{}
	wsHeader.Set("Origin", "http://localhost:5173")
	wsURLBob := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + bobToken
	wsBob, _, err := websocket.DefaultDialer.Dial(wsURLBob, wsHeader)
	if err != nil {
		t.Fatalf("Bob WS connect failed: %v", err)
	}
	defer wsBob.Close()

	msgReq, _ := json.Marshal(map[string]interface{}{
		"ciphertext": "Hello Bob!",
		"nonce":      "normal",
	})
	reqMsg, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgReq))
	reqMsg.Header.Set("Authorization", "Bearer "+aliceToken)
	reqMsg.Header.Set("Content-Type", "application/json")
	respMsg, err := server.Client().Do(reqMsg)
	if err != nil || respMsg.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to submit message: %v, status: %d", err, respMsg.StatusCode)
	}
	respMsg.Body.Close()

	wsBob.SetReadDeadline(time.Now().Add(6 * time.Second))
	for {
		_, msgData, err := wsBob.ReadMessage()
		if err != nil {
			t.Fatalf("Bob failed to receive message.created event: %v", err)
		}
		var tempEnv events.ClientEnvelope
		if err := json.Unmarshal(msgData, &tempEnv); err == nil && tempEnv.Type == "message.created" {
			var payload map[string]interface{}
			if err := json.Unmarshal(tempEnv.Payload, &payload); err == nil {
				if payload["sender_username"] != "alice_meta" {
					t.Fatalf("Expected sender_username alice_meta, got: %v", payload["sender_username"])
				}
				if payload["sender_display_name"] == "" {
					t.Fatalf("Expected non-empty sender_display_name, got empty")
				}
				if payload["conversation_id"] != conv.ID {
					t.Fatalf("Expected conversation_id %s, got: %v", conv.ID, payload["conversation_id"])
				}
				return
			}
		}
	}
}

func TestCallSignalingValidationOfflineAndBlock(t *testing.T) {
	server, store, _ := setupCallTestServer(t)

	aliceID, aliceToken := registerCallTestUser(t, server, "alice_sig_val", "Password123!")
	bobID, bobToken := registerCallTestUser(t, server, "bob_sig_val", "Password123!")

	convReq, _ := json.Marshal(map[string]interface{}{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := server.Client().Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create DM conversation: %v", err)
	}
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	wsHeader := http.Header{}
	wsHeader.Set("Origin", "http://localhost:5173")
	wsURLAlice := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + aliceToken
	wsAlice, _, err := websocket.DefaultDialer.Dial(wsURLAlice, wsHeader)
	if err != nil {
		t.Fatalf("Alice WS connect failed: %v", err)
	}
	defer wsAlice.Close()

	// 1. Invite offline Bob -> Alice receives call.signal_status target_offline
	offlineInvite, _ := json.Marshal(events.ClientEnvelope{
		V:       1,
		Type:    "call.signal",
		ID:      "env_offline_invite",
		Payload: json.RawMessage(`{"call_id":"call_off_1","conversation_id":"` + conv.ID + `","receiver_id":"` + bobID + `","call_type":"audio","signal_type":"invite"}`),
	})
	if err := wsAlice.WriteMessage(websocket.TextMessage, offlineInvite); err != nil {
		t.Fatalf("Write offline invite failed: %v", err)
	}

	wsAlice.SetReadDeadline(time.Now().Add(4 * time.Second))
	gotOffline := false
	for {
		_, msgData, err := wsAlice.ReadMessage()
		if err != nil {
			break
		}
		var env events.ClientEnvelope
		if json.Unmarshal(msgData, &env) == nil && env.Type == "call.signal_status" {
			var statusPayload events.CallSignalStatusPayload
			if json.Unmarshal(env.Payload, &statusPayload) == nil && statusPayload.CallID == "call_off_1" && statusPayload.Status == "target_offline" {
				gotOffline = true
				break
			}
		}
	}
	if !gotOffline {
		t.Fatalf("Expected call.signal_status=target_offline when calling offline user")
	}

	// Connect Bob now and send invalid signal_type / empty call_id -> must NOT forward
	wsURLBob := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws?token=" + bobToken
	wsBob, _, err := websocket.DefaultDialer.Dial(wsURLBob, wsHeader)
	if err != nil {
		t.Fatalf("Bob WS connect failed: %v", err)
	}
	defer wsBob.Close()

	emptyCallID, _ := json.Marshal(events.ClientEnvelope{
		V:       1,
		Type:    "call.signal",
		Payload: json.RawMessage(`{"call_id":"","conversation_id":"` + conv.ID + `","receiver_id":"` + bobID + `","call_type":"audio","signal_type":"invite"}`),
	})
	_ = wsAlice.WriteMessage(websocket.TextMessage, emptyCallID)

	badType, _ := json.Marshal(events.ClientEnvelope{
		V:       1,
		Type:    "call.signal",
		Payload: json.RawMessage(`{"call_id":"call_bad_1","conversation_id":"` + conv.ID + `","receiver_id":"` + bobID + `","call_type":"audio","signal_type":"evil_admin_override"}`),
	})
	_ = wsAlice.WriteMessage(websocket.TextMessage, badType)

	// Block Alice from Bob's side -> invite must drop + emit status=blocked to Alice
	if err := store.BlockUser(context.Background(), bobID, aliceID); err != nil {
		t.Fatalf("BlockUser failed: %v", err)
	}
	blockedInvite, _ := json.Marshal(events.ClientEnvelope{
		V:       1,
		Type:    "call.signal",
		Payload: json.RawMessage(`{"call_id":"call_blk_1","conversation_id":"` + conv.ID + `","receiver_id":"` + bobID + `","call_type":"audio","signal_type":"invite"}`),
	})
	_ = wsAlice.WriteMessage(websocket.TextMessage, blockedInvite)

	wsBob.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	for {
		_, msgData, err := wsBob.ReadMessage()
		if err != nil {
			break
		}
		var env events.ClientEnvelope
		if json.Unmarshal(msgData, &env) == nil && env.Type == "call.signal" {
			t.Fatalf("Bob received disallowed/blocked call.signal: %s", string(msgData))
		}
	}

	wsAlice.SetReadDeadline(time.Now().Add(3 * time.Second))
	gotBlocked := false
	for {
		_, msgData, err := wsAlice.ReadMessage()
		if err != nil {
			break
		}
		var env events.ClientEnvelope
		if json.Unmarshal(msgData, &env) == nil && env.Type == "call.signal_status" {
			var statusPayload events.CallSignalStatusPayload
			if json.Unmarshal(env.Payload, &statusPayload) == nil && statusPayload.CallID == "call_blk_1" && statusPayload.Status == "blocked" {
				gotBlocked = true
				break
			}
		}
	}
	if !gotBlocked {
		t.Fatalf("Expected call.signal_status=blocked when blocked peer is invited")
	}
}

func TestVoiceChatSignalSecurityAndSenderStamping(t *testing.T) {
	server, _, _ := setupCallTestServer(t)

	aliceID, aliceToken := registerCallTestUser(t, server, "alice_vcsig", "Password123!")
	bobID, bobToken := registerCallTestUser(t, server, "bob_vcsig", "Password123!")
	charlieID, charlieToken := registerCallTestUser(t, server, "charlie_vcsig", "Password123!")

	cBody, _ := json.Marshal(map[string]interface{}{
		"type":       "group",
		"title":      "Voice Signal Group",
		"member_ids": []string{bobID},
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(cBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err := server.Client().Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Create group failed: %v", err)
	}
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	// Alice & Bob join voice chat room
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/voice-chat", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = server.Client().Do(req)
	var vcResp struct {
		Room models.VoiceChatRoom `json:"room"`
	}
	json.NewDecoder(resp.Body).Decode(&vcResp)
	resp.Body.Close()

	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/voice-chat", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = server.Client().Do(req)
	resp.Body.Close()

	wsHeader := http.Header{}
	wsHeader.Set("Origin", "http://localhost:5173")
	wsAlice, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/v1/ws?token="+aliceToken, wsHeader)
	if err != nil {
		t.Fatalf("Alice WS connect failed: %v", err)
	}
	defer wsAlice.Close()

	wsBob, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/v1/ws?token="+bobToken, wsHeader)
	if err != nil {
		t.Fatalf("Bob WS connect failed: %v", err)
	}
	defer wsBob.Close()

	wsCharlie, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/v1/ws?token="+charlieToken, wsHeader)
	if err != nil {
		t.Fatalf("Charlie WS connect failed: %v", err)
	}
	defer wsCharlie.Close()

	// 1. Bob attempts to spoof sender_user_id=aliceID -> server MUST overwrite sender_user_id=bobID
	spoofOffer, _ := json.Marshal(events.ClientEnvelope{
		V:       1,
		Type:    "voice_chat.signal",
		Payload: json.RawMessage(`{"room_id":"` + vcResp.Room.ID + `","conversation_id":"` + conv.ID + `","sender_user_id":"` + aliceID + `","target_user_id":"` + aliceID + `","signal_type":"sdp_offer","data":{"type":"offer","sdp":"v=0"}}`),
	})
	if err := wsBob.WriteMessage(websocket.TextMessage, spoofOffer); err != nil {
		t.Fatalf("Bob write failed: %v", err)
	}

	wsAlice.SetReadDeadline(time.Now().Add(4 * time.Second))
	gotStamped := false
	for {
		_, msgData, err := wsAlice.ReadMessage()
		if err != nil {
			break
		}
		var env events.ClientEnvelope
		if json.Unmarshal(msgData, &env) == nil && env.Type == "voice_chat.signal" {
			var vc events.VoiceChatSignalPayload
			if json.Unmarshal(env.Payload, &vc) == nil {
				if vc.SenderUserID != bobID {
					t.Fatalf("SECURITY VIOLATION: expected server-stamped sender_user_id=%s, got %s", bobID, vc.SenderUserID)
				}
				gotStamped = true
				break
			}
		}
	}
	if !gotStamped {
		t.Fatalf("Alice did not receive stamped voice_chat.signal from Bob")
	}

	// 2. Bob (non-admin member) attempts to forge room_ended over WS -> MUST be dropped
	forgedEnd, _ := json.Marshal(events.ClientEnvelope{
		V:       1,
		Type:    "voice_chat.signal",
		Payload: json.RawMessage(`{"room_id":"` + vcResp.Room.ID + `","conversation_id":"` + conv.ID + `","signal_type":"room_ended"}`),
	})
	_ = wsBob.WriteMessage(websocket.TextMessage, forgedEnd)

	// 3. Mismatched room_id or non-member Charlie target -> MUST be dropped
	badRoom, _ := json.Marshal(events.ClientEnvelope{
		V:       1,
		Type:    "voice_chat.signal",
		Payload: json.RawMessage(`{"room_id":"vc_wrong_room","conversation_id":"` + conv.ID + `","target_user_id":"` + aliceID + `","signal_type":"sdp_offer","data":{}}`),
	})
	_ = wsBob.WriteMessage(websocket.TextMessage, badRoom)

	nonMemberTarget, _ := json.Marshal(events.ClientEnvelope{
		V:       1,
		Type:    "voice_chat.signal",
		Payload: json.RawMessage(`{"room_id":"` + vcResp.Room.ID + `","conversation_id":"` + conv.ID + `","target_user_id":"` + charlieID + `","signal_type":"sdp_offer","data":{}}`),
	})
	_ = wsAlice.WriteMessage(websocket.TextMessage, nonMemberTarget)
	_ = wsCharlie.WriteMessage(websocket.TextMessage, spoofOffer)

	wsAlice.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	for {
		_, msgData, err := wsAlice.ReadMessage()
		if err != nil {
			break
		}
		var env events.ClientEnvelope
		if json.Unmarshal(msgData, &env) == nil && env.Type == "voice_chat.signal" {
			t.Fatalf("Alice received disallowed voice_chat.signal: %s", string(msgData))
		}
	}
}

func TestCallLogsDeduplicationE2EEAndIceServers(t *testing.T) {
	server, _, _ := setupCallTestServer(t)

	aliceID, aliceToken := registerCallTestUser(t, server, "alice_log", "Password123!")
	bobID, bobToken := registerCallTestUser(t, server, "bob_log", "Password123!")

	// 1. Dynamic Coturn HMAC-SHA1 credentials with TURN_URL + TURN_AUTH_SECRET
	t.Setenv("TURN_URL", "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp")
	t.Setenv("TURN_AUTH_SECRET", "super-secret-turn-key")
	reqIce, _ := http.NewRequest("GET", server.URL+"/api/v1/webrtc/ice-servers", nil)
	reqIce.Header.Set("Authorization", "Bearer "+aliceToken)
	respIce, err := server.Client().Do(reqIce)
	if err != nil || respIce.StatusCode != http.StatusOK {
		t.Fatalf("GET ice-servers failed: %v", err)
	}
	var iceList []map[string]interface{}
	json.NewDecoder(respIce.Body).Decode(&iceList)
	respIce.Body.Close()

	var turnFound bool
	for _, entry := range iceList {
		uname, _ := entry["username"].(string)
		cred, _ := entry["credential"].(string)
		if strings.Contains(uname, ":"+aliceID) && cred != "" {
			mac := hmac.New(sha1.New, []byte("super-secret-turn-key"))
			mac.Write([]byte(uname))
			expectedCred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
			if cred != expectedCred {
				t.Fatalf("TURN HMAC mismatch: expected %s, got %s", expectedCred, cred)
			}
			turnFound = true
		}
	}
	if !turnFound {
		t.Fatalf("Expected Coturn HMAC TURN entry in ice servers response: %+v", iceList)
	}

	// 2. Normal conversation call log deduplication + caller/receiver integrity
	convReq, _ := json.Marshal(map[string]interface{}{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ := server.Client().Do(req)
	var normalConv models.Conversation
	json.NewDecoder(resp.Body).Decode(&normalConv)
	resp.Body.Close()

	bobLogBody, _ := json.Marshal(map[string]interface{}{
		"id":               "call_dedup_1",
		"conversation_id":  normalConv.ID,
		"caller_id":        aliceID,
		"receiver_id":      bobID,
		"call_type":        "video",
		"status":           "completed",
		"duration_seconds": 12,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/calls/logs", bytes.NewReader(bobLogBody))
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = server.Client().Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Bob create call log failed: %v status=%d", err, resp.StatusCode)
	}
	resp.Body.Close()

	aliceLogBody, _ := json.Marshal(map[string]interface{}{
		"id":               "call_dedup_1",
		"conversation_id":  normalConv.ID,
		"caller_id":        aliceID,
		"receiver_id":      bobID,
		"call_type":        "video",
		"status":           "completed",
		"duration_seconds": 14,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/calls/logs", bytes.NewReader(aliceLogBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = server.Client().Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Alice upsert call log failed: %v status=%d", err, resp.StatusCode)
	}
	resp.Body.Close()

	req, _ = http.NewRequest("GET", server.URL+"/api/v1/calls/logs", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = server.Client().Do(req)
	var logsResp struct {
		Calls []*models.CallLog `json:"calls"`
	}
	json.NewDecoder(resp.Body).Decode(&logsResp)
	resp.Body.Close()
	if len(logsResp.Calls) != 1 || logsResp.Calls[0].CallerID != aliceID || logsResp.Calls[0].ReceiverID != bobID || logsResp.Calls[0].DurationSeconds != 14 {
		t.Fatalf("Unexpected call logs after dual submission: %+v", logsResp.Calls)
	}

	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+normalConv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = server.Client().Do(req)
	var msgsResp struct {
		Messages []*models.Message `json:"messages"`
	}
	json.NewDecoder(resp.Body).Decode(&msgsResp)
	resp.Body.Close()
	if len(msgsResp.Messages) != 1 {
		t.Fatalf("Expected exactly 1 call_event message in conversation, got %d", len(msgsResp.Messages))
	}

	// 3. Switch conversation to e2ee_active -> POST /calls/logs must NOT write any plaintext call_event message
	modeReq, _ := json.Marshal(map[string]string{"security_mode": "e2ee_active"})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+normalConv.ID+"/security-mode", bytes.NewReader(modeReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = server.Client().Do(req)
	resp.Body.Close()

	e2eeLogBody, _ := json.Marshal(map[string]interface{}{
		"id":               "call_e2ee_1",
		"conversation_id":  normalConv.ID,
		"caller_id":        aliceID,
		"receiver_id":      bobID,
		"call_type":        "audio",
		"status":           "completed",
		"duration_seconds": 30,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/calls/logs", bytes.NewReader(e2eeLogBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = server.Client().Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("E2EE call log creation failed: %v status=%d", err, resp.StatusCode)
	}
	resp.Body.Close()

	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+normalConv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = server.Client().Do(req)
	var msgsAfterE2EE struct {
		Messages []*models.Message `json:"messages"`
	}
	json.NewDecoder(resp.Body).Decode(&msgsAfterE2EE)
	resp.Body.Close()
	if len(msgsAfterE2EE.Messages) != 1 {
		t.Fatalf("SECURITY VIOLATION: expected zero new plaintext messages in e2ee_active chat, got total=%d", len(msgsAfterE2EE.Messages))
	}
}

func TestWebSocketOriginBehindTrustedHTTPSProxy(t *testing.T) {
	server, _, _ := setupCallTestServer(t)
	_, token := registerCallTestUser(t, server, "alice_wss_proxy", "Password123!")

	parsedSrv, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("Parse server URL failed: %v", err)
	}
	dialer := websocket.Dialer{
		NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, parsedSrv.Host)
		},
	}

	proxiedURL := "ws://chat.example.com/api/v1/ws?token=" + token
	header := http.Header{}
	header.Set("Origin", "https://chat.example.com")
	header.Set("X-Forwarded-Proto", "https")

	// 1. Without TRUST_PROXY / TRUSTED_PROXIES, spoofed X-Forwarded-Proto must be rejected (Origin port 443 != HTTP port 80)
	t.Setenv("TRUST_PROXY", "false")
	t.Setenv("TRUSTED_PROXIES", "")
	t.Setenv("ALLOWED_ORIGINS", "")
	if conn, _, err := dialer.Dial(proxiedURL, header); err == nil {
		conn.Close()
		t.Fatal("Expected untrusted X-Forwarded-Proto header to be rejected")
	}

	// 2. With TRUST_PROXY=true from loopback proxy, same-origin https://chat.example.com must succeed
	t.Setenv("TRUST_PROXY", "true")
	conn, _, err := dialer.Dial(proxiedURL, header)
	if err != nil {
		t.Fatalf("Expected trusted-proxy WSS upgrade to succeed, got: %v", err)
	}
	conn.Close()

	// 3. Wrong host behind trusted proxy must still be rejected
	badHeader := http.Header{}
	badHeader.Set("Origin", "https://evil.example.com")
	badHeader.Set("X-Forwarded-Proto", "https")
	if conn2, _, err := dialer.Dial(proxiedURL, badHeader); err == nil {
		conn2.Close()
		t.Fatal("Expected mismatched Origin behind trusted proxy to be rejected")
	}
}

