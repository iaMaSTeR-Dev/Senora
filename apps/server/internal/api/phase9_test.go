package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"testing"
	"time"

	"senora/server/internal/auth"
	"senora/server/internal/conversations"
	"senora/server/internal/crypto"
	"senora/server/internal/events"
	"senora/server/internal/identity"
	"senora/server/internal/messages"
	"senora/server/internal/models"
	"senora/server/internal/storage"
)

func setupPhase9TestServer(t *testing.T) (*httptest.Server, storage.Store, *events.Hub) {
	driver := "sqlite"
	tempDB := filepath.Join(t.TempDir(), "phase9_test.db")
	dsn := tempDB
	if testDB := os.Getenv("TEST_DATABASE_URL"); testDB != "" {
		driver = "postgres"
		dsn = testDB
	}
	store, err := storage.NewSQLStore(driver, dsn)
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}
	_ = store.ResetForTesting(context.Background())

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

func registerAndLoginPhase9User(t *testing.T, server *httptest.Server, username, password string) (string, string) {
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

	if resp.StatusCode == http.StatusBadRequest {
		loginBody, _ := json.Marshal(map[string]string{
			"username":    username,
			"password":    password,
			"device_name": "TestDevice",
		})
		loginResp, loginErr := http.Post(server.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(loginBody))
		if loginErr == nil && loginResp.StatusCode == http.StatusOK {
			defer loginResp.Body.Close()
			var loginResult struct {
				User  models.User `json:"user"`
				Token string      `json:"token"`
			}
			if err := json.NewDecoder(loginResp.Body).Decode(&loginResult); err == nil && loginResult.Token != "" {
				return loginResult.User.ID, loginResult.Token
			}
		}
	}

	var regResult struct {
		User  models.User `json:"user"`
		Token string      `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&regResult); err != nil {
		t.Fatalf("Failed to decode register response: %v", err)
	}
	return regResult.User.ID, regResult.Token
}

func TestPhase9SecurityModeNormalDefaultAndActivation(t *testing.T) {
	server, _, _ := setupPhase9TestServer(t)

	aliceID, aliceToken := registerAndLoginPhase9User(t, server, "alice_sec", "P@ssword12345!")
	bobID, _ := registerAndLoginPhase9User(t, server, "bob_sec", "P@ssword12345!")

	// 1. Create direct conversation
	cBody, _ := json.Marshal(map[string]interface{}{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(cBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create conversation: %v, status=%d", err, resp.StatusCode)
	}
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	// Verify Track A: Default is "normal"
	if conv.SecurityMode != "normal" {
		t.Fatalf("Expected default security mode to be 'normal', got %s", conv.SecurityMode)
	}

	// 2. Activate E2EE
	modeBody, _ := json.Marshal(map[string]string{"security_mode": "e2ee_active"})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/security-mode", bytes.NewReader(modeBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to activate E2EE: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// Verify conversation now has security_mode = e2ee_active
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	var listResp struct {
		Conversations []models.Conversation `json:"conversations"`
	}
	json.NewDecoder(resp.Body).Decode(&listResp)
	resp.Body.Close()

	found := false
	for _, c := range listResp.Conversations {
		if c.ID == conv.ID {
			found = true
			if c.SecurityMode != "e2ee_active" {
				t.Fatalf("Expected security mode to be 'e2ee_active', got %s", c.SecurityMode)
			}
		}
	}
	if !found {
		t.Fatalf("Conversation %s not found in list", conv.ID)
	}

	// Reject invalid mode
	invalidBody, _ := json.Marshal(map[string]string{"security_mode": "unsupported_mode"})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/security-mode", bytes.NewReader(invalidBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("Expected status 400 for invalid mode, got %d", resp.StatusCode)
	}
	resp.Body.Close()
	_ = aliceID
}

func TestPhase9DeleteForMeAndEveryone(t *testing.T) {
	server, _, _ := setupPhase9TestServer(t)

	aliceID, aliceToken := registerAndLoginPhase9User(t, server, "alice_del", "P@ssword12345!")
	bobID, bobToken := registerAndLoginPhase9User(t, server, "bob_del", "P@ssword12345!")

	// Create conversation
	cBody, _ := json.Marshal(map[string]interface{}{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(cBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ := http.DefaultClient.Do(req)
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	// Alice sends Msg 1
	m1Body, _ := json.Marshal(map[string]string{
		"ciphertext": "Hello Msg 1",
		"nonce":      "normal",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(m1Body))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	var msg1 models.Message
	json.NewDecoder(resp.Body).Decode(&msg1)
	resp.Body.Close()

	// Alice sends Msg 2
	m2Body, _ := json.Marshal(map[string]string{
		"ciphertext": "Hello Msg 2",
		"nonce":      "normal",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(m2Body))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	var msg2 models.Message
	json.NewDecoder(resp.Body).Decode(&msg2)
	resp.Body.Close()

	// 1. Bob deletes Msg 1 "FOR ME"
	req, _ = http.NewRequest("DELETE", server.URL+"/api/v1/conversations/"+conv.ID+"/messages/"+msg1.ID+"?scope=me", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to delete for me: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// Verify Bob's messages do NOT include Msg 1
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = http.DefaultClient.Do(req)
	var bobMsgs struct {
		Messages []models.Message `json:"messages"`
	}
	json.NewDecoder(resp.Body).Decode(&bobMsgs)
	resp.Body.Close()

	for _, m := range bobMsgs.Messages {
		if m.ID == msg1.ID {
			t.Fatalf("Msg 1 should NOT be returned to Bob after Delete for Me")
		}
	}
	if len(bobMsgs.Messages) != 1 || bobMsgs.Messages[0].ID != msg2.ID {
		t.Fatalf("Expected Bob to see only Msg 2, got %d messages", len(bobMsgs.Messages))
	}

	// Verify Alice STILL sees Msg 1 (Delete for Me isolation)
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	var aliceMsgs struct {
		Messages []models.Message `json:"messages"`
	}
	json.NewDecoder(resp.Body).Decode(&aliceMsgs)
	resp.Body.Close()

	hasMsg1 := false
	for _, m := range aliceMsgs.Messages {
		if m.ID == msg1.ID {
			hasMsg1 = true
		}
	}
	if !hasMsg1 {
		t.Fatalf("Alice should still see Msg 1 because Bob deleted it for me only")
	}

	// 2. Alice deletes Msg 2 "FOR EVERYONE"
	req, _ = http.NewRequest("DELETE", server.URL+"/api/v1/conversations/"+conv.ID+"/messages/"+msg2.ID+"?scope=everyone", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to delete for everyone: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// Verify Msg 2 is marked is_deleted for Bob
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = http.DefaultClient.Do(req)
	json.NewDecoder(resp.Body).Decode(&bobMsgs)
	resp.Body.Close()

	if len(bobMsgs.Messages) == 0 || !bobMsgs.Messages[0].IsDeleted {
		t.Fatalf("Msg 2 should be marked is_deleted for Bob")
	}
	_ = aliceID
}

func TestPhase9DeleteChatForMeAndBoth(t *testing.T) {
	server, _, _ := setupPhase9TestServer(t)

	_, aliceToken := registerAndLoginPhase9User(t, server, "alice_chat", "P@ssword12345!")
	bobID, bobToken := registerAndLoginPhase9User(t, server, "bob_chat", "P@ssword12345!")

	cBody, _ := json.Marshal(map[string]interface{}{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(cBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ := http.DefaultClient.Do(req)
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	// Send messages
	for i := 1; i <= 3; i++ {
		mBody, _ := json.Marshal(map[string]string{
			"ciphertext": fmt.Sprintf("Message %d", i),
			"nonce":      "normal",
		})
		req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(mBody))
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		resp, _ = http.DefaultClient.Do(req)
		resp.Body.Close()
	}

	// 1. Bob clears chat FOR ME
	req, _ = http.NewRequest("DELETE", server.URL+"/api/v1/conversations/"+conv.ID+"?scope=me", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to clear chat for me: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// Bob has 0 messages in history
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = http.DefaultClient.Do(req)
	var bobMsgs struct {
		Messages []models.Message `json:"messages"`
	}
	json.NewDecoder(resp.Body).Decode(&bobMsgs)
	resp.Body.Close()

	if len(bobMsgs.Messages) != 0 {
		t.Fatalf("Expected 0 messages for Bob after Clear Chat for Me, got %d", len(bobMsgs.Messages))
	}

	// Alice STILL has all 3 messages
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	var aliceMsgs struct {
		Messages []models.Message `json:"messages"`
	}
	json.NewDecoder(resp.Body).Decode(&aliceMsgs)
	resp.Body.Close()

	if len(aliceMsgs.Messages) != 3 {
		t.Fatalf("Expected 3 messages for Alice, got %d", len(aliceMsgs.Messages))
	}

	// 2. Alice deletes conversation FOR BOTH
	req, _ = http.NewRequest("DELETE", server.URL+"/api/v1/conversations/"+conv.ID+"?scope=both", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to delete chat for both: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// Conversation is gone from both
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusNotFound {
		t.Fatalf("Expected 403 or 404 for deleted conversation, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestPhase9GroupVoiceChatLifecycle(t *testing.T) {
	server, _, _ := setupPhase9TestServer(t)

	_, aliceToken := registerAndLoginPhase9User(t, server, "alice_vc", "P@ssword12345!")
	bobID, bobToken := registerAndLoginPhase9User(t, server, "bob_vc", "P@ssword12345!")

	// Create group conversation
	cBody, _ := json.Marshal(map[string]interface{}{
		"type":       "group",
		"title":      "Voice Chat Group",
		"member_ids": []string{bobID},
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(cBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ := http.DefaultClient.Do(req)
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	// 1. Alice starts/joins voice chat
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/voice-chat", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to start voice chat: status=%d", resp.StatusCode)
	}
	var vcResp struct {
		Room         models.VoiceChatRoom            `json:"room"`
		Participants []*models.VoiceChatParticipant `json:"participants"`
	}
	json.NewDecoder(resp.Body).Decode(&vcResp)
	resp.Body.Close()

	if !vcResp.Room.IsActive || len(vcResp.Participants) != 1 {
		t.Fatalf("Expected active room with 1 participant, got %d", len(vcResp.Participants))
	}

	// 2. Bob joins voice chat
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/voice-chat", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed for Bob to join voice chat: status=%d", resp.StatusCode)
	}
	json.NewDecoder(resp.Body).Decode(&vcResp)
	resp.Body.Close()

	if len(vcResp.Participants) != 2 {
		t.Fatalf("Expected 2 participants in voice chat, got %d", len(vcResp.Participants))
	}

	// 3. Bob updates state (unmutes, speaking)
	stateBody, _ := json.Marshal(map[string]bool{"is_muted": false, "is_speaking": true})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/voice-chat/state", bytes.NewReader(stateBody))
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to update voice chat state: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// 4. Bob leaves voice chat
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/voice-chat/leave", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to leave voice chat: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// Active check shows 1 participant remaining
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/voice-chat", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	json.NewDecoder(resp.Body).Decode(&vcResp)
	resp.Body.Close()

	if len(vcResp.Participants) != 1 {
		t.Fatalf("Expected 1 participant remaining, got %d", len(vcResp.Participants))
	}

	// 5. Alice ends voice chat
	req, _ = http.NewRequest("DELETE", server.URL+"/api/v1/conversations/"+conv.ID+"/voice-chat", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to end voice chat: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// Verify room is now ended
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/voice-chat", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = http.DefaultClient.Do(req)
	var getResp struct {
		Room *models.VoiceChatRoom `json:"room"`
	}
	json.NewDecoder(resp.Body).Decode(&getResp)
	resp.Body.Close()
	if getResp.Room != nil {
		t.Fatalf("Expected nil active room after ending, got %v", getResp.Room)
	}
}

func TestPhase9AvatarUploadAndServing(t *testing.T) {
	server, _, _ := setupPhase9TestServer(t)

	_, aliceToken := registerAndLoginPhase9User(t, server, "alice_avt", "P@ssword12345!")

	// 1. Upload Avatar
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="avatar"; filename="avatar.png"`)
	header.Set("Content-Type", "image/png")
	part, _ := writer.CreatePart(header)
	// Write dummy PNG header bytes
	pngBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R'}
	part.Write(pngBytes)
	writer.Close()

	req, _ := http.NewRequest("POST", server.URL+"/api/v1/users/avatar", body)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to upload avatar: status=%d", resp.StatusCode)
	}
	var user models.User
	json.NewDecoder(resp.Body).Decode(&user)
	resp.Body.Close()

	if user.AvatarURL == "" {
		t.Fatalf("Expected non-empty avatar URL after upload")
	}

	// 2. Serve Avatar
	getReq, _ := http.NewRequest("GET", server.URL+user.AvatarURL, nil)
	getResp, err := http.DefaultClient.Do(getReq)
	if err != nil || getResp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to retrieve avatar: status=%d", getResp.StatusCode)
	}
	avatarData, _ := io.ReadAll(getResp.Body)
	getResp.Body.Close()
	if len(avatarData) != len(pngBytes) {
		t.Fatalf("Avatar payload size mismatch")
	}

	// 3. Delete Avatar
	delReq, _ := http.NewRequest("DELETE", server.URL+"/api/v1/users/avatar", nil)
	delReq.Header.Set("Authorization", "Bearer "+aliceToken)
	delResp, _ := http.DefaultClient.Do(delReq)
	if delResp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to delete avatar: status=%d", delResp.StatusCode)
	}
	var delUser models.User
	json.NewDecoder(delResp.Body).Decode(&delUser)
	delResp.Body.Close()

	if delUser.AvatarURL != "" {
		t.Fatalf("Expected empty avatar URL after deletion, got %s", delUser.AvatarURL)
	}
}

func TestPhase9UserCreatedStickersAndSharing(t *testing.T) {
	server, _, _ := setupPhase9TestServer(t)

	_, aliceToken := registerAndLoginPhase9User(t, server, "alice_stk", "P@ssword12345!")
	_, bobToken := registerAndLoginPhase9User(t, server, "bob_stk", "P@ssword12345!")

	// 1. Alice creates custom pack
	packReq, _ := json.Marshal(map[string]interface{}{
		"title": "Alice Custom Pack",
		"name":  "alice_pack_1",
		"stickers": []map[string]string{
			{"emoji": "🌟", "asset_url": "data:image/svg+xml;utf8,<svg>star</svg>"},
			{"emoji": "💫", "asset_url": "data:image/svg+xml;utf8,<svg>sparkle</svg>"},
		},
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/stickers/packs", bytes.NewReader(packReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create sticker pack: status=%d", resp.StatusCode)
	}
	var createdPack models.StickerPack
	json.NewDecoder(resp.Body).Decode(&createdPack)
	resp.Body.Close()

	if createdPack.ShareCode == "" || createdPack.StickerCount != 2 {
		t.Fatalf("Invalid created pack: share_code=%s, count=%d", createdPack.ShareCode, createdPack.StickerCount)
	}

	// 2. Bob retrieves pack via Share Code
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/stickers/share/"+createdPack.ShareCode, nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to resolve shared pack: status=%d", resp.StatusCode)
	}
	var sharedPack models.StickerPack
	json.NewDecoder(resp.Body).Decode(&sharedPack)
	resp.Body.Close()

	if sharedPack.ID != createdPack.ID || len(sharedPack.Stickers) != 2 {
		t.Fatalf("Shared pack mismatch: id=%s, stickers=%d", sharedPack.ID, len(sharedPack.Stickers))
	}
}

func TestPhase9GIFSearch(t *testing.T) {
	server, _, _ := setupPhase9TestServer(t)

	_, aliceToken := registerAndLoginPhase9User(t, server, "alice_gif", "P@ssword12345!")

	req, _ := http.NewRequest("GET", server.URL+"/api/v1/media/gifs?query=laugh", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to search GIFs: status=%d", resp.StatusCode)
	}
	var gifResp struct {
		GIFs []GIFItem `json:"gifs"`
	}
	json.NewDecoder(resp.Body).Decode(&gifResp)
	resp.Body.Close()

	if len(gifResp.GIFs) == 0 {
		t.Fatalf("Expected GIF results for query 'laugh', got 0")
	}
}

func TestPhase9SecurityModeNormalVsE2EEMessages(t *testing.T) {
	server, _, _ := setupPhase9TestServer(t)

	aliceID, aliceToken := registerAndLoginPhase9User(t, server, "alice_sec", "P@ssword12345!")
	bobID, bobToken := registerAndLoginPhase9User(t, server, "bob_sec", "P@ssword12345!")

	_ = aliceID

	// 1. Create direct conversation (must default to "normal")
	convReq, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create direct conversation: status=%d", resp.StatusCode)
	}
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	if conv.SecurityMode != "normal" {
		t.Fatalf("Expected default security mode 'normal', got '%s'", conv.SecurityMode)
	}

	// 2. Submit normal message with nonce "normal" -> must succeed
	msgReq, _ := json.Marshal(map[string]string{
		"ciphertext": `{"text":"Hello Normal World","type":"text"}`,
		"nonce":      "normal",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to send normal message: status=%d", resp.StatusCode)
	}
	var createdMsg models.Message
	json.NewDecoder(resp.Body).Decode(&createdMsg)
	resp.Body.Close()

	if createdMsg.Nonce != "normal" {
		t.Fatalf("Expected nonce 'normal', got '%s'", createdMsg.Nonce)
	}

	// 3. Bob retrieves message history -> normal message returned
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob failed to fetch messages: status=%d", resp.StatusCode)
	}
	var msgResp struct {
		Messages []*models.Message `json:"messages"`
	}
	json.NewDecoder(resp.Body).Decode(&msgResp)
	resp.Body.Close()

	if len(msgResp.Messages) != 1 || msgResp.Messages[0].Nonce != "normal" {
		t.Fatalf("Expected 1 normal message in history, got %d", len(msgResp.Messages))
	}

	// 4. Activate E2EE mode
	secReq, _ := json.Marshal(map[string]string{
		"security_mode": "e2ee_active",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/security-mode", bytes.NewReader(secReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to set security mode to e2ee_active: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// 5. Attempt to send unencrypted "normal" message in e2ee_active mode -> MUST BE REJECTED
	badMsgReq, _ := json.Marshal(map[string]string{
		"ciphertext": `{"text":"Sneaky Plaintext","type":"text"}`,
		"nonce":      "normal",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(badMsgReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Network error: %v", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("Expected HTTP 400 Bad Request when sending normal message in e2ee_active mode, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 6. Send legitimate encrypted E2EE message with non-empty cryptographic nonce -> MUST SUCCEED
	e2eeMsgReq, _ := json.Marshal(map[string]string{
		"ciphertext": `{"v":2,"sender_user_id":"` + aliceID + `","devices":{"dev_1":{"type":999,"body":"cipher123","nonce":"nonce123"}}}`,
		"nonce":      "e2ee_crypto_nonce_base64",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(e2eeMsgReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to send e2ee encrypted message: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// 7. Bob retrieves messages -> both messages exist with proper nonces
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob failed to fetch messages: status=%d", resp.StatusCode)
	}
	var finalMsgResp struct {
		Messages []*models.Message `json:"messages"`
	}
	json.NewDecoder(resp.Body).Decode(&finalMsgResp)
	resp.Body.Close()

	if len(finalMsgResp.Messages) != 2 {
		t.Fatalf("Expected 2 messages in conversation history, got %d", len(finalMsgResp.Messages))
	}
}
