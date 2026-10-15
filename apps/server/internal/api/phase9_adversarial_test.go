package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"testing"

	"nexachat/server/internal/models"
)

func TestPhase9UserPreferences(t *testing.T) {
	server, _, _ := setupPhase9TestServer(t)

	_, aliceToken := registerAndLoginPhase9User(t, server, "alice_pref", "P@ssword12345!")
	_, bobToken := registerAndLoginPhase9User(t, server, "bob_pref", "P@ssword12345!")

	// 1. Initial preferences should be empty JSON
	req, _ := http.NewRequest("GET", server.URL+"/api/v1/users/preferences", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to get initial preferences: status=%d", resp.StatusCode)
	}
	var initPrefs map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&initPrefs)
	resp.Body.Close()
	if len(initPrefs) != 0 {
		t.Fatalf("Expected empty initial preferences, got %v", initPrefs)
	}

	// 2. Set Alice's preferences (including an disallowed key to test mass-assignment filter)
	alicePayload := map[string]interface{}{
		"theme":          "dark",
		"accentColor":    "#10b981",
		"fontSize":       "large",
		"language":       "fa",
		"sendOnEnter":    false,
		"disallowed_key": "malicious_injection",
	}
	payloadBytes, _ := json.Marshal(alicePayload)
	req, _ = http.NewRequest("PUT", server.URL+"/api/v1/users/preferences", bytes.NewReader(payloadBytes))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to save preferences: status=%d", resp.StatusCode)
	}
	var savedPrefs map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&savedPrefs)
	resp.Body.Close()

	if savedPrefs["theme"] != "dark" || savedPrefs["accentColor"] != "#10b981" || savedPrefs["language"] != "fa" {
		t.Fatalf("Unexpected saved preferences: %v", savedPrefs)
	}
	if _, exists := savedPrefs["disallowed_key"]; exists {
		t.Fatalf("Expected disallowed_key to be filtered out, but it was saved")
	}

	// 3. Bob's preferences should remain isolated
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/users/preferences", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob failed to get preferences: status=%d", resp.StatusCode)
	}
	var bobPrefs map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&bobPrefs)
	resp.Body.Close()
	if len(bobPrefs) != 0 {
		t.Fatalf("Cross-user leakage: Bob saw Alice's preferences: %v", bobPrefs)
	}
}

func TestPhase9AdversarialE2EEServerEnforcement(t *testing.T) {
	server, _, _ := setupPhase9TestServer(t)

	aliceID, aliceToken := registerAndLoginPhase9User(t, server, "alice_adv", "P@ssword12345!")
	bobID, bobToken := registerAndLoginPhase9User(t, server, "bob_adv", "P@ssword12345!")
	_ = bobToken

	// Create conversation and activate E2EE
	convReq, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create conversation: status=%d", resp.StatusCode)
	}
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	secReq, _ := json.Marshal(map[string]string{
		"security_mode": "e2ee_active",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/security-mode", bytes.NewReader(secReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to set e2ee_active: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// Helper to send message
	sendMsg := func(token, ciphertext, nonce string) int {
		body, _ := json.Marshal(map[string]string{
			"ciphertext": ciphertext,
			"nonce":      nonce,
		})
		r, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		res, doErr := http.DefaultClient.Do(r)
		if doErr != nil {
			t.Fatalf("Network error: %v", doErr)
		}
		defer res.Body.Close()
		return res.StatusCode
	}

	// 1. nonce: "normal" -> REJECT (400)
	if status := sendMsg(aliceToken, `{"v":2,"devices":{}}`, "normal"); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for nonce: normal in E2EE, got %d", status)
	}

	// 2. empty nonce -> REJECT (400)
	if status := sendMsg(aliceToken, `{"v":2,"devices":{}}`, ""); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for empty nonce in E2EE, got %d", status)
	}

	// 3. whitespace nonce -> REJECT (400)
	if status := sendMsg(aliceToken, `{"v":2,"devices":{}}`, "   "); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for whitespace nonce in E2EE, got %d", status)
	}

	// 4. unsupported envelope version v: 999 -> REJECT (400)
	if status := sendMsg(aliceToken, `{"v":999,"devices":{}}`, "signal-v2"); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for unsupported envelope version, got %d", status)
	}

	// 5. malformed encrypted envelope (invalid JSON) -> REJECT (400)
	if status := sendMsg(aliceToken, `not a json at all`, "signal-v2"); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for malformed encrypted envelope, got %d", status)
	}

	// 6. payload without required metadata (plain text claiming to be encrypted) -> REJECT (400)
	if status := sendMsg(aliceToken, `{"text":"Sneaky unencrypted"}`, "signal-v2"); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for payload without metadata in E2EE, got %d", status)
	}

	// 7. envelope missing devices field -> REJECT (400)
	if status := sendMsg(aliceToken, `{"v":2,"sender_user_id":"alice_adv"}`, "signal-v2"); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for envelope missing devices map, got %d", status)
	}

	// 7b. envelope with empty devices map -> REJECT (400)
	if status := sendMsg(aliceToken, `{"v":2,"devices":{}}`, "signal-v2"); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for envelope with empty devices map, got %d", status)
	}

	// 7c. envelope with spoofed sender_user_id -> REJECT (400)
	if status := sendMsg(aliceToken, `{"v":2,"sender_user_id":"impostor_bob","devices":{"dev_1":{"type":1,"body":"enc"}}}`, "signal-v2"); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for envelope with spoofed sender_user_id, got %d", status)
	}

	// 7d. envelope with empty device key -> REJECT (400)
	if status := sendMsg(aliceToken, `{"v":2,"devices":{"":{"type":1,"body":"enc"}}}`, "signal-v2"); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for envelope with empty device key, got %d", status)
	}

	// 7e. envelope with null device value -> REJECT (400)
	if status := sendMsg(aliceToken, `{"v":2,"devices":{"dev_1":null}}`, "signal-v2"); status != http.StatusBadRequest {
		t.Fatalf("Expected 400 for envelope with null device value, got %d", status)
	}

	// 8. genuine valid E2EE envelope -> ACCEPT (201)
	validEnv := `{"v":2,"sender_user_id":"` + aliceID + `","devices":{"dev_1":{"type":999,"body":"cipher123","nonce":"nonce123"}}}`
	body, _ := json.Marshal(map[string]string{
		"ciphertext": validEnv,
		"nonce":      "signal-v2",
	})
	r, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+aliceToken)
	res, _ := http.DefaultClient.Do(r)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("Expected 201 for valid E2EE envelope, got %d", res.StatusCode)
	}
	var createdMsg models.Message
	json.NewDecoder(res.Body).Decode(&createdMsg)
	res.Body.Close()

	// 9. Edit message in E2EE with unencrypted plaintext -> REJECT (400)
	editReq, _ := json.Marshal(map[string]string{
		"ciphertext": `Sneaky plaintext edit`,
	})
	r, _ = http.NewRequest("PUT", server.URL+"/api/v1/conversations/"+conv.ID+"/messages/"+createdMsg.ID, bytes.NewReader(editReq))
	r.Header.Set("Authorization", "Bearer "+aliceToken)
	res, _ = http.DefaultClient.Do(r)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("Expected 400 when editing E2EE message with unencrypted text, got %d", res.StatusCode)
	}
	res.Body.Close()

	// 10. Edit message in E2EE with valid E2EE envelope -> ACCEPT (200)
	validEditEnv := `{"v":2,"sender_user_id":"` + aliceID + `","devices":{"dev_1":{"type":999,"body":"editedcipher","nonce":"nonce123"}}}`
	editReq, _ = json.Marshal(map[string]string{
		"ciphertext": validEditEnv,
	})
	r, _ = http.NewRequest("PUT", server.URL+"/api/v1/conversations/"+conv.ID+"/messages/"+createdMsg.ID, bytes.NewReader(editReq))
	r.Header.Set("Authorization", "Bearer "+aliceToken)
	res, _ = http.DefaultClient.Do(r)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200 when editing E2EE message with valid envelope, got %d", res.StatusCode)
	}
	res.Body.Close()

	// 11. Upload attachment with is_encrypted: "false" in E2EE -> REJECT (400)
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	w.WriteField("conversation_id", conv.ID)
	w.WriteField("is_encrypted", "false")
	part, _ := w.CreateFormFile("file", "plaintext.txt")
	part.Write([]byte("unencrypted confidential file"))
	w.Close()

	r, _ = http.NewRequest("POST", server.URL+"/api/v1/attachments", &b)
	r.Header.Set("Authorization", "Bearer "+aliceToken)
	r.Header.Set("Content-Type", w.FormDataContentType())
	res, _ = http.DefaultClient.Do(r)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("Expected 400 when uploading unencrypted attachment to E2EE conversation, got %d", res.StatusCode)
	}
	res.Body.Close()

	// 12. Upload attachment with is_encrypted: "true" in E2EE -> ACCEPT (201)
	var b2 bytes.Buffer
	w2 := multipart.NewWriter(&b2)
	w2.WriteField("conversation_id", conv.ID)
	w2.WriteField("is_encrypted", "true")
	part2, _ := w2.CreateFormFile("file", "ciphertext.enc")
	part2.Write([]byte("encrypted bytes AES-GCM"))
	w2.Close()

	r, _ = http.NewRequest("POST", server.URL+"/api/v1/attachments", &b2)
	r.Header.Set("Authorization", "Bearer "+aliceToken)
	r.Header.Set("Content-Type", w2.FormDataContentType())
	res, _ = http.DefaultClient.Do(r)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("Expected 201 when uploading encrypted attachment to E2EE conversation, got %d", res.StatusCode)
	}
	res.Body.Close()

	// 13. Non-member trying to send message -> REJECT (403)
	charlieID, charlieToken := registerAndLoginPhase9User(t, server, "charlie_adv", "P@ssword12345!")
	_ = charlieID
	if status := sendMsg(charlieToken, validEnv, "signal-v2"); status != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for non-member message submission, got %d", status)
	}
}

func TestZeroPlaintextSentinelLeakageAudit(t *testing.T) {
	server, store, _ := setupPhase9TestServer(t)

	aliceID, aliceToken := registerAndLoginPhase9User(t, server, "alice_sentinel", "P@ssword12345!")
	bobID, bobToken := registerAndLoginPhase9User(t, server, "bob_sentinel", "P@ssword12345!")
	_, eveToken := registerAndLoginPhase9User(t, server, "eve_sentinel", "P@ssword12345!")

	const sentinel = "NEXA_E2EE_SECRET_SENTINEL_7F31"

	// 1. Create direct E2EE conversation between Alice and Bob
	convReq, _ := json.Marshal(map[string]string{
		"type":                "direct",
		"participant_user_id": bobID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create conversation: status=%d", resp.StatusCode)
	}
	var conv models.Conversation
	json.NewDecoder(resp.Body).Decode(&conv)
	resp.Body.Close()

	// Activate E2EE
	secReq, _ := json.Marshal(map[string]string{
		"security_mode": "e2ee_active",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/security-mode", bytes.NewReader(secReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to activate E2EE: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// 2. Submit E2EE message with encrypted envelope
	// Simulated AES-256-GCM / Signal ciphertext that does NOT expose the sentinel
	encryptedBodyBase64 := "ZXhhbXBsZV9jaXBoZXJ0ZXh0X25vX3NlbnRpbmVsX2F0X2FsbF8xMjM0NQ=="
	e2eeEnvelope := `{"v":2,"sender_user_id":"` + aliceID + `","devices":{"` + bobID + `_dev1":{"type":1,"body":"` + encryptedBodyBase64 + `","nonce":"nonce_abc"}}}`

	msgReq, _ := json.Marshal(map[string]string{
		"ciphertext": e2eeEnvelope,
		"nonce":      "signal-v2",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", bytes.NewReader(msgReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to submit E2EE message: status=%d", resp.StatusCode)
	}
	var msg models.Message
	json.NewDecoder(resp.Body).Decode(&msg)
	resp.Body.Close()

	// Verify server storage does not contain the sentinel
	storedMsg, err := store.GetMessageByID(req.Context(), msg.ID)
	if err != nil {
		t.Fatalf("Failed to load message from store: %v", err)
	}
	if bytes.Contains([]byte(storedMsg.Ciphertext), []byte(sentinel)) {
		t.Fatalf("LEAKAGE DETECTED: Stored message ciphertext contains plaintext sentinel!")
	}

	// 3. Submit E2EE Poll with client-encrypted question and options
	// In E2EE mode, the client encrypts the question and options before POST /polls
	encPollQuestion := "enc_question_AES_GCM_base64_blob"
	encPollOption1 := "enc_opt1_AES_GCM_base64_blob"
	encPollOption2 := "enc_opt2_AES_GCM_base64_blob"

	pollReq, _ := json.Marshal(map[string]interface{}{
		"question": encPollQuestion,
		"options":  []string{encPollOption1, encPollOption2},
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/polls", bytes.NewReader(pollReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create E2EE poll: status=%d", resp.StatusCode)
	}
	var poll models.Poll
	json.NewDecoder(resp.Body).Decode(&poll)
	resp.Body.Close()

	// Verify server storage for poll does not contain the sentinel
	storedPoll, err := store.GetPoll(req.Context(), poll.ID, aliceID)
	if err != nil {
		t.Fatalf("Failed to load poll from store: %v", err)
	}
	if bytes.Contains([]byte(storedPoll.Question), []byte(sentinel)) {
		t.Fatalf("LEAKAGE DETECTED: Stored poll question contains plaintext sentinel!")
	}
	for _, opt := range storedPoll.Options {
		if bytes.Contains([]byte(opt.Text), []byte(sentinel)) {
			t.Fatalf("LEAKAGE DETECTED: Stored poll option contains plaintext sentinel!")
		}
	}

	// 4. Bob retrieves messages and poll
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob failed to get messages: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/polls/"+poll.ID, nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob failed to get poll: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// 5. Eve (unauthorized third user) attempts to read messages -> 403 Forbidden
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", nil)
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Authorization failure: expected 403 for Eve getting messages, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 6. Eve attempts to read poll -> 403 Forbidden
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+conv.ID+"/polls/"+poll.ID, nil)
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Authorization failure: expected 403 for Eve getting poll, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 7. Eve attempts to vote on poll -> 403 Forbidden
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+conv.ID+"/polls/"+poll.ID+"/vote", bytes.NewReader([]byte(`{"option_id":0}`)))
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Authorization failure: expected 403 for Eve voting on poll, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}
