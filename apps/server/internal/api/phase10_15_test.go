package api

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
	"time"

	"senora/server/internal/models"
)

func TestPollsAPI(t *testing.T) {
	server, _, _ := setupTestServer(t)
	client := server.Client()

	// 1. Register Alice, Bob, Eve
	regUser := func(username string) (string, string) {
		body, _ := json.Marshal(map[string]string{
			"username":     username,
			"display_name": username + " Test",
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

	aliceToken, _ := regUser("alice_poll")
	bobToken, bobID := regUser("bob_poll")
	eveToken, _ := regUser("eve_poll")

	// 2. Alice creates a group conversation with Bob
	convReq, _ := json.Marshal(map[string]interface{}{
		"type":       "group",
		"title":      "Poll Testing Group",
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

	// 3. Eve (non-member) tries to create a poll -> 403 Forbidden
	pollReqBody, _ := json.Marshal(map[string]interface{}{
		"question":        "Best language?",
		"options":         []string{"Go", "TypeScript", "Rust"},
		"allows_multiple": false,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/polls", bytes.NewReader(pollReqBody))
	req.Header.Set("Authorization", "Bearer "+eveToken)
	req.Header.Set("Content-Type", "application/json")
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for Eve creating poll, got %d", resp.StatusCode)
	}

	// 4. Alice creates poll
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/polls", bytes.NewReader(pollReqBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Alice failed to create poll: %v, status: %d", err, resp.StatusCode)
	}
	var pollRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&pollRes)
	pollID := pollRes["id"].(string)
	opts := pollRes["options"].([]interface{})
	if len(opts) != 3 {
		t.Fatalf("Expected 3 options, got %d", len(opts))
	}

	// 5. Bob votes for option 1 ("TypeScript")
	voteReq, _ := json.Marshal(map[string]interface{}{
		"option_id": 1,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/polls/"+pollID+"/vote", bytes.NewReader(voteReq))
	req.Header.Set("Authorization", "Bearer "+bobToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob voting failed: %v, status: %d", err, resp.StatusCode)
	}
	var votedPoll map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&votedPoll)
	totalVotes := int(votedPoll["total_votes"].(float64))
	if totalVotes != 1 {
		t.Fatalf("Expected total_votes 1, got %d", totalVotes)
	}

	// 6. Eve tries to vote -> 403 Forbidden
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/polls/"+pollID+"/vote", bytes.NewReader(voteReq))
	req.Header.Set("Authorization", "Bearer "+eveToken)
	req.Header.Set("Content-Type", "application/json")
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for Eve voting, got %d", resp.StatusCode)
	}

	// 7. Eve tries to close poll -> 403 Forbidden
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/polls/"+pollID+"/close", nil)
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for Eve closing poll, got %d", resp.StatusCode)
	}

	// 8. Alice closes poll -> 200 OK
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/polls/"+pollID+"/close", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Alice closing poll failed: %v, status: %d", err, resp.StatusCode)
	}

	// 9. Bob tries to vote in closed poll -> 400 Bad Request
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/polls/"+pollID+"/vote", bytes.NewReader(voteReq))
	req.Header.Set("Authorization", "Bearer "+bobToken)
	req.Header.Set("Content-Type", "application/json")
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("Expected 400 Bad Request for voting in closed poll, got %d", resp.StatusCode)
	}
}

func TestStoriesAPI(t *testing.T) {
	server, _, _ := setupTestServer(t)
	client := server.Client()

	regUser := func(username string) string {
		body, _ := json.Marshal(map[string]string{
			"username":     username,
			"display_name": username + " Display",
			"password":     "Password123!",
			"device_name":  username + " Device",
		})
		resp, err := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(body))
		if err != nil || resp.StatusCode != http.StatusCreated {
			t.Fatalf("Failed to register %s: %v", username, err)
		}
		var res map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&res)
		return res["token"].(string)
	}

	aliceToken := regUser("alice_story")
	bobToken := regUser("bob_story")

	// 1. Alice creates a story
	storyBody, _ := json.Marshal(map[string]interface{}{
		"media_url":  "https://example.com/alice_story.jpg",
		"media_type": "photo",
		"caption":    "Testing stories Phase 15!",
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/stories", bytes.NewReader(storyBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create story: %v, status: %d", err, resp.StatusCode)
	}
	var createdStory map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&createdStory)
	storyID := createdStory["id"].(string)

	// 2. Bob lists active stories
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/stories", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to list active stories: %v, status: %d", err, resp.StatusCode)
	}
	var storiesList map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&storiesList)
	stories := storiesList["stories"].([]interface{})
	if len(stories) == 0 {
		t.Fatalf("Expected at least 1 story in active list, got 0")
	}

	// 3. Bob tries to delete Alice's story -> 400 / error
	req, _ = http.NewRequest("DELETE", server.URL+"/api/v1/stories/"+storyID, nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = client.Do(req)
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("Bob should not be able to delete Alice's story")
	}

	// 4. Alice deletes her story -> 200 OK
	req, _ = http.NewRequest("DELETE", server.URL+"/api/v1/stories/"+storyID, nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Alice failed to delete her story: %v, status: %d", err, resp.StatusCode)
	}
}

func TestScheduledMessagesAndRolesAPI(t *testing.T) {
	server, _, _ := setupTestServer(t)
	client := server.Client()

	regUser := func(username string) (string, string) {
		body, _ := json.Marshal(map[string]string{
			"username":     username,
			"display_name": username + " Display",
			"password":     "Password123!",
			"device_name":  username + " Device",
		})
		resp, _ := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(body))
		var res map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&res)
		return res["token"].(string), res["user"].(map[string]interface{})["id"].(string)
	}

	aliceToken, _ := regUser("alice_sch")
	bobToken, bobID := regUser("bob_sch")
	eveToken, _ := regUser("eve_sch")

	// Create group
	convReq, _ := json.Marshal(map[string]interface{}{
		"type":       "group",
		"title":      "Scheduled Chat",
		"member_ids": []string{bobID},
		"is_e2ee":    false,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, _ := client.Do(req)
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	convID := convRes["id"].(string)

	// Test Roles: Alice is admin, Bob is member, Eve is forbidden
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/role", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, _ = client.Do(req)
	var roleRes map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&roleRes)
	if roleRes["role"] != "admin" && roleRes["role"] != "owner" {
		t.Fatalf("Expected Alice to have role admin/owner, got %s", roleRes["role"])
	}

	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/role", nil)
	req.Header.Set("Authorization", "Bearer "+bobToken)
	resp, _ = client.Do(req)
	_ = json.NewDecoder(resp.Body).Decode(&roleRes)
	if roleRes["role"] != "member" {
		t.Fatalf("Expected Bob to have role member, got %s", roleRes["role"])
	}

	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/role", nil)
	req.Header.Set("Authorization", "Bearer "+eveToken)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for Eve's role check, got %d", resp.StatusCode)
	}

	// Schedule message in the past -> rejected
	pastTime := time.Now().Add(-1 * time.Hour)
	schPastBody, _ := json.Marshal(map[string]interface{}{
		"ciphertext":    "Hello from past",
		"nonce":         "normal",
		"scheduled_for": pastTime,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/scheduled", bytes.NewReader(schPastBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("Expected 400 Bad Request for scheduling in past, got %d", resp.StatusCode)
	}

	// Schedule message in future -> 201 Created
	futureTime := time.Now().Add(2 * time.Hour)
	schFutureBody, _ := json.Marshal(map[string]interface{}{
		"ciphertext":    "Hello future message",
		"nonce":         "normal",
		"scheduled_for": futureTime,
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/scheduled", bytes.NewReader(schFutureBody))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create scheduled message: %v, status: %d", err, resp.StatusCode)
	}
	var createdSch map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&createdSch)
	schID := createdSch["id"].(string)

	// List scheduled messages
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/scheduled", nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to get scheduled messages: %v, status: %d", err, resp.StatusCode)
	}
	var listSch []interface{}
	_ = json.NewDecoder(resp.Body).Decode(&listSch)
	if len(listSch) != 1 {
		t.Fatalf("Expected 1 scheduled message, got %d", len(listSch))
	}

	// Delete scheduled message
	req, _ = http.NewRequest("DELETE", server.URL+"/api/v1/conversations/"+convID+"/scheduled/"+schID, nil)
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to delete scheduled message: %v, status: %d", err, resp.StatusCode)
	}
}

func TestBotSendMessageAPI(t *testing.T) {
	server, _, _ := setupTestServer(t)
	client := server.Client()

	// Register Alice and create a normal conversation
	body, _ := json.Marshal(map[string]string{
		"username":     "alice_bot_test",
		"display_name": "Alice Bot Test",
		"password":     "Password123!",
		"device_name":  "Alice Device",
	})
	resp, _ := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(body))
	var res map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&res)
	aliceToken := res["token"].(string)

	convReq, _ := json.Marshal(map[string]interface{}{
		"type":    "channel",
		"title":   "Bot Broadcast Channel",
		"is_e2ee": false,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+aliceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, _ = client.Do(req)
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	convID := convRes["id"].(string)

	// 1. Without bot token -> 401 Unauthorized
	botMsg, _ := json.Marshal(map[string]string{
		"conversation_id": convID,
		"text":            "System update announcement",
	})
	resp, _ = client.Post(server.URL+"/api/v1/bot/sendMessage", "application/json", bytes.NewReader(botMsg))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 Unauthorized for bot without token, got %d", resp.StatusCode)
	}

	// 2. With invalid bot token -> 401 Unauthorized
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/bot/sendMessage", bytes.NewReader(botMsg))
	req.Header.Set("X-Bot-Token", "invalid_token_123")
	req.Header.Set("Content-Type", "application/json")
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401 Unauthorized for invalid bot token, got %d", resp.StatusCode)
	}

	// 3. With valid bot token -> 201 Created
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/bot/sendMessage", bytes.NewReader(botMsg))
	req.Header.Set("X-Bot-Token", "senora_bot_dev_token")
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Expected 201 Created for bot message, got status %d, err: %v", resp.StatusCode, err)
	}
	var createdMsg map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&createdMsg)
	if createdMsg["sender_id"] != "bot_system" {
		t.Fatalf("Expected sender_id bot_system, got %v", createdMsg["sender_id"])
	}
}

func TestGroupAdminRoleAssignmentDeterministicStress(t *testing.T) {
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
		return res["token"].(string), res["user"].(map[string]interface{})["id"].(string)
	}

	creatorToken, creatorID := regUser("creator_stress")
	tokenA, idA := regUser("member_a")
	tokenB, idB := regUser("member_b")
	tokenC, idC := regUser("member_c")
	eveToken, _ := regUser("eve_nonmember")

	testCases := []struct {
		name      string
		memberIDs []string
	}{
		{"Order ABC", []string{idA, idB, idC}},
		{"Order CBA", []string{idC, idB, idA}},
		{"Order BCA", []string{idB, idC, idA}},
		{"With duplicate creator", []string{creatorID, idA, creatorID, idB}},
		{"With duplicate members", []string{idA, idA, idB, idB, idC, idC}},
		{"With empty strings", []string{"", idA, "  ", idB, "", idC, "   "}},
		{"Single member", []string{idA}},
		{"Empty members", []string{}},
	}

	for i, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			convReq, _ := json.Marshal(map[string]interface{}{
				"type":       "group",
				"title":      "Stress Group " + tc.name,
				"member_ids": tc.memberIDs,
			})
			req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
			req.Header.Set("Authorization", "Bearer "+creatorToken)
			req.Header.Set("Content-Type", "application/json")
			resp, err := client.Do(req)
			if err != nil || resp.StatusCode != http.StatusCreated {
				t.Fatalf("Case %d (%s) failed to create group: status %d, err: %v", i, tc.name, resp.StatusCode, err)
			}
			var convRes map[string]interface{}
			_ = json.NewDecoder(resp.Body).Decode(&convRes)
			convID := convRes["id"].(string)

			// 1. Creator must be admin
			req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/role", nil)
			req.Header.Set("Authorization", "Bearer "+creatorToken)
			resp, _ = client.Do(req)
			var roleRes map[string]string
			_ = json.NewDecoder(resp.Body).Decode(&roleRes)
			if roleRes["role"] != "admin" && roleRes["role"] != "owner" {
				t.Fatalf("Case %s: expected creator to have admin role, got %s", tc.name, roleRes["role"])
			}

			// 2. Any present member must be 'member' (never admin)
			for _, memberToken := range []string{tokenA, tokenB, tokenC} {
				req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/role", nil)
				req.Header.Set("Authorization", "Bearer "+memberToken)
				resp, _ = client.Do(req)
				if resp.StatusCode == http.StatusOK {
					var mRole map[string]string
					_ = json.NewDecoder(resp.Body).Decode(&mRole)
					if mRole["role"] != "member" {
						t.Fatalf("Case %s: member has role %s, expected 'member'", tc.name, mRole["role"])
					}
				}
			}

			// 3. Eve must always be 403 Forbidden
			req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/role", nil)
			req.Header.Set("Authorization", "Bearer "+eveToken)
			resp, _ = client.Do(req)
			if resp.StatusCode != http.StatusForbidden {
				t.Fatalf("Case %s: expected Eve to receive 403 Forbidden, got %d", tc.name, resp.StatusCode)
			}
		})
	}

	_ = store
}

func TestSavedMessagesSelfChat(t *testing.T) {
	server, _, _ := setupTestServer(t)
	defer server.Close()
	client := server.Client()

	// Register user
	regBody, _ := json.Marshal(map[string]string{
		"username":     "self_saver_user",
		"display_name": "Self Saver",
		"password":     "SecretPass123!",
	})
	resp, err := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(regBody))
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to register: %v", err)
	}
	var authRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&authRes)
	token := authRes["token"].(string)
	userID := authRes["user"].(map[string]interface{})["id"].(string)

	// Create self direct chat (Saved Messages)
	createReq, _ := json.Marshal(map[string]interface{}{
		"type":    "direct",
		"peer_id": userID,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(createReq))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to create Saved Messages chat: status=%d, err=%v", resp.StatusCode, err)
	}
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	convID := convRes["id"].(string)
	if convRes["type"] != "saved" {
		t.Fatalf("Expected conversation type 'saved', got %v", convRes["type"])
	}

	// Calling create again should return existing saved chat idempotently
	req2, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(createReq))
	req2.Header.Set("Authorization", "Bearer "+token)
	req2.Header.Set("Content-Type", "application/json")
	resp2, _ := client.Do(req2)
	var convRes2 map[string]interface{}
	_ = json.NewDecoder(resp2.Body).Decode(&convRes2)
	if convRes2["id"] != convID {
		t.Fatalf("Expected idempotent retrieval of Saved Messages conversation")
	}

	// Submit a message to Saved Messages
	msgReq, _ := json.Marshal(map[string]interface{}{
		"ciphertext": "Hello to myself in Saved Messages",
		"nonce":      "normal",
	})
	postMsgReq, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/messages", bytes.NewReader(msgReq))
	postMsgReq.Header.Set("Authorization", "Bearer "+token)
	postMsgReq.Header.Set("Content-Type", "application/json")
	msgResp, err := client.Do(postMsgReq)
	if err != nil || msgResp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to post message to Saved Messages: status=%d", msgResp.StatusCode)
	}

	// Retrieve messages
	getMsgsReq, _ := http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/messages", nil)
	getMsgsReq.Header.Set("Authorization", "Bearer "+token)
	getResp, err := client.Do(getMsgsReq)
	if err != nil || getResp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to retrieve messages from Saved Messages: status=%d", getResp.StatusCode)
	}
	var listRes map[string]interface{}
	_ = json.NewDecoder(getResp.Body).Decode(&listRes)
	msgs := listRes["messages"].([]interface{})
	if len(msgs) != 1 {
		t.Fatalf("Expected 1 message in Saved Messages, got %d", len(msgs))
	}
}

func TestGetConversationMembers(t *testing.T) {
	server, _, _ := setupTestServer(t)
	defer server.Close()
	client := server.Client()

	reg := func(name string) (string, string) {
		body, _ := json.Marshal(map[string]string{
			"username":     name,
			"display_name": "Display " + name,
			"password":     "SecretPass123!",
		})
		resp, _ := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(body))
		var r map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&r)
		return r["token"].(string), r["user"].(map[string]interface{})["id"].(string)
	}

	tokenOwner, _ := reg("group_owner")
	_, idMember := reg("group_member")
	tokenEve, _ := reg("group_eve")

	// Create group
	convReq, _ := json.Marshal(map[string]interface{}{
		"type":       "group",
		"title":      "Test Members Group",
		"member_ids": []string{idMember},
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+tokenOwner)
	req.Header.Set("Content-Type", "application/json")
	resp, _ := client.Do(req)
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	convID := convRes["id"].(string)

	// Add member explicitly
	addReq, _ := json.Marshal(map[string]string{
		"user_id": idMember,
		"role":    "member",
	})
	req, _ = http.NewRequest("POST", server.URL+"/api/v1/conversations/"+convID+"/members", bytes.NewReader(addReq))
	req.Header.Set("Authorization", "Bearer "+tokenOwner)
	req.Header.Set("Content-Type", "application/json")
	_, _ = client.Do(req)

	// 1. Authorized member requests member list
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/members", nil)
	req.Header.Set("Authorization", "Bearer "+tokenOwner)
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to fetch group members: status=%d", resp.StatusCode)
	}
	var membersRes struct {
		Members []models.ConversationMemberDetail `json:"members"`
		Count   int                               `json:"count"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&membersRes)
	if membersRes.Count < 2 {
		t.Fatalf("Expected at least 2 members, got %d", membersRes.Count)
	}

	// 2. Non-member Eve requests member list -> 403 Forbidden
	req, _ = http.NewRequest("GET", server.URL+"/api/v1/conversations/"+convID+"/members", nil)
	req.Header.Set("Authorization", "Bearer "+tokenEve)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for non-member, got %d", resp.StatusCode)
	}
}

func TestUnicodePersianAttachmentDownload(t *testing.T) {
	server, _, _ := setupTestServer(t)
	defer server.Close()
	client := server.Client()

	reg := func(name string) (string, string) {
		body, _ := json.Marshal(map[string]string{
			"username":     name,
			"display_name": "Display " + name,
			"password":     "SecretPass123!",
		})
		resp, _ := client.Post(server.URL+"/api/v1/auth/register", "application/json", bytes.NewReader(body))
		var r map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&r)
		return r["token"].(string), r["user"].(map[string]interface{})["id"].(string)
	}

	tokenUser, idUser := reg("downloader_user")
	tokenPeer, idPeer := reg("downloader_peer")
	tokenEve, _ := reg("downloader_eve")

	// Create direct conversation
	convReq, _ := json.Marshal(map[string]interface{}{
		"type":    "direct",
		"peer_id": idPeer,
	})
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/conversations", bytes.NewReader(convReq))
	req.Header.Set("Authorization", "Bearer "+tokenUser)
	req.Header.Set("Content-Type", "application/json")
	resp, _ := client.Do(req)
	var convRes map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&convRes)
	convID := convRes["id"].(string)

	// Create attachment with Persian filename and exact payload bytes
	persianFilename := "سند محرمانه سنورا.pdf"
	originalContent := []byte("%PDF-1.4 %Senora Persian Test Payload 1234567890 🧪 سلام دنیا")

	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	_ = w.WriteField("conversation_id", convID)
	_ = w.WriteField("is_encrypted", "false")
	part, err := w.CreateFormFile("file", persianFilename)
	if err != nil {
		t.Fatalf("Failed to create form file: %v", err)
	}
	_, _ = part.Write(originalContent)
	_ = w.Close()

	uploadReq, _ := http.NewRequest("POST", server.URL+"/api/v1/attachments", &b)
	uploadReq.Header.Set("Authorization", "Bearer "+tokenUser)
	uploadReq.Header.Set("Content-Type", w.FormDataContentType())
	uploadResp, err := client.Do(uploadReq)
	if err != nil || uploadResp.StatusCode != http.StatusCreated {
		t.Fatalf("Failed to upload attachment: status=%d, err=%v", uploadResp.StatusCode, err)
	}
	var att models.Attachment
	_ = json.NewDecoder(uploadResp.Body).Decode(&att)
	if att.ID == "" {
		t.Fatalf("Expected non-empty attachment ID")
	}

	// 1. Authorized download by conversation member
	downReq, _ := http.NewRequest("GET", server.URL+"/api/v1/attachments/"+att.ID, nil)
	downReq.Header.Set("Authorization", "Bearer "+tokenPeer)
	downResp, err := client.Do(downReq)
	if err != nil || downResp.StatusCode != http.StatusOK {
		t.Fatalf("Failed to download attachment: status=%d, err=%v", downResp.StatusCode, err)
	}
	defer downResp.Body.Close()

	// Verify headers
	disp := downResp.Header.Get("Content-Disposition")
	if !strings.Contains(disp, "filename*=") {
		t.Fatalf("Expected RFC 5987 filename* header in Content-Disposition, got %s", disp)
	}

	// Verify byte-level integrity
	downloadedBytes, err := io.ReadAll(downResp.Body)
	if err != nil {
		t.Fatalf("Failed to read downloaded body: %v", err)
	}
	if !bytes.Equal(downloadedBytes, originalContent) {
		t.Fatalf("Byte integrity mismatch! Expected %d bytes, got %d bytes", len(originalContent), len(downloadedBytes))
	}

	// 2. Unauthorized download by Eve -> 403 Forbidden
	downReqEve, _ := http.NewRequest("GET", server.URL+"/api/v1/attachments/"+att.ID, nil)
	downReqEve.Header.Set("Authorization", "Bearer "+tokenEve)
	downRespEve, _ := client.Do(downReqEve)
	if downRespEve.StatusCode != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden for unauthorized user, got %d", downRespEve.StatusCode)
	}

	_ = idUser
}
