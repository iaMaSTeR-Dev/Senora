package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"senora/server/internal/events"
	"senora/server/internal/messages"
	"senora/server/internal/models"
	"senora/server/internal/netguard"
	"senora/server/internal/storage"
)

const botContextKey contextKey = "managed_bot"

func (r *Router) botRoutes() {
	for pattern, handler := range map[string]http.HandlerFunc{
		"GET /api/v1/bots": r.manageBots, "POST /api/v1/bots": r.manageBots,
		"GET /api/v1/bots/{botID}": r.manageBot, "PATCH /api/v1/bots/{botID}": r.manageBot, "DELETE /api/v1/bots/{botID}": r.manageBot,
		"POST /api/v1/bots/{botID}/token":                               r.rotateBotToken,
		"PUT /api/v1/bots/{botID}/webhook":                              r.manageBotWebhook,
		"POST /api/v1/botfather/open":                                   r.openBotFather,
		"POST /api/v1/conversations/{id}/messages/{msgId}/bot-callback": r.createBotCallback,
	} {
		r.mux.Handle(pattern, r.authMiddleware(handler))
	}
	for pattern, handler := range map[string]http.HandlerFunc{
		"PUT /api/v1/bot/webhook": r.manageBotWebhook,
		"GET /api/v1/bot/me":      r.botMe, "GET /api/v1/bot/updates": r.botUpdates,
		"POST /api/v1/bot/messages": r.botSendMessage, "PATCH /api/v1/bot/messages/{msgId}": r.botEditMessage, "DELETE /api/v1/bot/messages/{msgId}": r.botDeleteMessage,
		"POST /api/v1/bot/forward": r.botForwardMessage, "POST /api/v1/bot/callbacks/{callbackID}/answer": r.botAnswerCallback,
		"GET /api/v1/bot/conversations": r.handleListConversations, "GET /api/v1/bot/conversations/{id}": r.handleGetConversation,
		"GET /api/v1/bot/conversations/{id}/members":  r.handleGetConversationMembers,
		"GET /api/v1/bot/conversations/{id}/messages": r.handleGetMessages,
		"POST /api/v1/bot/conversations/{id}/leave":   r.botLeave,
		"POST /api/v1/bot/conversations/{id}/typing":  r.botTyping,
		"POST /api/v1/bot/attachments":                r.handleUploadAttachment, "GET /api/v1/bot/attachments/{id}": r.handleDownloadAttachment,
		"POST /api/v1/bot/media/share": r.handleCreateMediaShare, "DELETE /api/v1/bot/media/share/{id}": r.handleDeleteMediaShare,
		"GET /api/v1/bot/conversations/{id}/topics":                      r.handleGetForumTopics,
		"POST /api/v1/bot/conversations/{id}/polls":                      r.handleCreatePoll,
		"GET /api/v1/bot/conversations/{id}/polls/{pollId}":              r.handleGetPoll,
		"POST /api/v1/bot/conversations/{id}/polls/{pollId}/close":       r.handleClosePoll,
		"POST /api/v1/bot/conversations/{id}/messages/{msgId}/reactions": r.handleMessageReaction,
		"POST /api/v1/bot/conversations/{id}/read":                       r.handleMarkConversationRead,
		"GET /api/v1/bot/conversations/{id}/pins":                        r.handleGetConversationPins,
	} {
		r.mux.Handle(pattern, r.botAuth(handler))
	}
	for pattern, handler := range map[string]http.HandlerFunc{
		"POST /api/v1/bot/conversations/{id}/topics":               r.handleCreateForumTopic,
		"PATCH /api/v1/bot/conversations/{id}":                     r.handleUpdateConversation,
		"POST /api/v1/bot/conversations/{id}/pins":                 r.handleAddConversationPin,
		"DELETE /api/v1/bot/conversations/{id}/pins/{msgId}":       r.handleRemoveConversationPin,
		"POST /api/v1/bot/conversations/{id}/invites":              r.handleCreateConversationInvite,
		"GET /api/v1/bot/conversations/{id}/invites":               r.handleListConversationInvites,
		"DELETE /api/v1/bot/conversations/{id}/invites/{code}":     r.handleRevokeConversationInvite,
		"DELETE /api/v1/bot/conversations/{id}/members/{userId}":   r.handleRemoveConversationMember,
		"PUT /api/v1/bot/conversations/{id}/members/{userId}/role": r.handleUpdateMemberRole,
	} {
		r.mux.Handle(pattern, r.botAuth(func(w http.ResponseWriter, req *http.Request) {
			role, err := r.store.GetMemberRole(req.Context(), req.PathValue("id"), getUserFromContext(req.Context()).ID)
			if err != nil || (role != "owner" && role != "admin") {
				r.writeError(w, 403, "FORBIDDEN", "Bot requires administrator permissions")
				return
			}
			handler(w, req)
		}))
	}
}

func botToken(req *http.Request) string {
	if value := req.Header.Get("X-Bot-Token"); value != "" {
		return value
	}
	for _, prefix := range []string{"Bot ", "Bearer "} {
		if strings.HasPrefix(req.Header.Get("Authorization"), prefix) {
			return strings.TrimPrefix(req.Header.Get("Authorization"), prefix)
		}
	}
	return ""
}
func (r *Router) botAuth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		bot, err := r.store.GetManagedBotByToken(req.Context(), botToken(req))
		if err != nil {
			r.writeError(w, 401, "INVALID_BOT_TOKEN", "Invalid, disabled or revoked bot token")
			return
		}
		user, err := r.store.GetUserByID(req.Context(), bot.UserID)
		if err != nil {
			r.writeError(w, 401, "INVALID_BOT_TOKEN", "Bot identity is unavailable")
			return
		}
		if bot.UserID == models.BotFatherID {
			r.writeError(w, 403, "FORBIDDEN", "Invalid managed identity")
			return
		}
		ctx := context.WithValue(req.Context(), botContextKey, bot)
		ctx = context.WithValue(ctx, userContextKey, user)
		req = req.WithContext(ctx)
		if id := req.PathValue("id"); id != "" && strings.Contains(req.URL.Path, "/conversations/") {
			conv, err := r.convs.GetConversation(ctx, id, bot.UserID)
			if err != nil || conv.SecurityMode != "normal" {
				r.writeError(w, 403, "FORBIDDEN", "Bot has no access to this conversation")
				return
			}
		}
		if id := req.PathValue("id"); id != "" && strings.Contains(req.URL.Path, "/attachments/") && !r.store.BotCanReadAttachment(ctx, bot, id) {
			r.writeError(w, 403, "FORBIDDEN", "Attachment is not visible to this bot")
			return
		}

		next(w, req)
	})
}
func managedBot(req *http.Request) *models.ManagedBot {
	return req.Context().Value(botContextKey).(*models.ManagedBot)
}
func (r *Router) ownedBot(w http.ResponseWriter, req *http.Request) *models.ManagedBot {
	b, err := r.store.GetManagedBot(req.Context(), req.PathValue("botID"))
	if err != nil || b.OwnerID != getUserFromContext(req.Context()).ID {
		r.writeError(w, 404, "NOT_FOUND", "Bot not found")
		return nil
	}
	return b
}
func decodeBotBody(w http.ResponseWriter, req *http.Request, dst any) error {
	req.Body = http.MaxBytesReader(w, req.Body, 256<<10)
	dec := json.NewDecoder(req.Body)
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return errors.New("one JSON object is required")
	}
	return nil
}
func (r *Router) manageBots(w http.ResponseWriter, req *http.Request) {
	owner := getUserFromContext(req.Context()).ID
	if req.Method == http.MethodGet {
		list, err := r.store.ListManagedBots(req.Context(), owner)
		if err != nil {
			r.writeError(w, 500, "STORAGE_ERROR", "Cannot list bots")
			return
		}
		r.writeJSON(w, 200, map[string]any{"bots": list})
		return
	}
	var body struct {
		Username string `json:"username"`
		Name     string `json:"name"`
	}
	if decodeBotBody(w, req, &body) != nil {
		r.writeError(w, 400, "INVALID_BODY", "Expected username and name")
		return
	}
	b, key, err := r.store.CreateManagedBot(req.Context(), owner, body.Username, body.Name)
	if err != nil {
		r.writeError(w, 400, "BOT_CREATE_FAILED", err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	r.writeJSON(w, 201, map[string]any{"bot": b, "api_key": key})
}
func (r *Router) manageBot(w http.ResponseWriter, req *http.Request) {
	b := r.ownedBot(w, req)
	if b == nil {
		return
	}
	switch req.Method {
	case http.MethodGet:
		r.writeJSON(w, 200, b)
	case http.MethodDelete:
		if err := r.store.DisableManagedBot(req.Context(), b.ID, b.OwnerID); err != nil {
			r.writeError(w, 500, "STORAGE_ERROR", "Could not disable bot")
			return
		}
		r.writeJSON(w, 200, map[string]bool{"disabled": true})
	default:
		settings := models.BotSettings{Name: b.Name, Description: b.Description, PrivacyMode: b.PrivacyMode, Commands: b.Commands}
		if decodeBotBody(w, req, &settings) != nil {
			r.writeError(w, 400, "INVALID_BODY", "Invalid bot settings")
			return
		}
		if err := r.store.UpdateManagedBot(req.Context(), b.ID, b.OwnerID, settings); err != nil {
			r.writeError(w, 400, "INVALID_SETTINGS", err.Error())
			return
		}
		updated, _ := r.store.GetManagedBot(req.Context(), b.ID)
		r.writeJSON(w, 200, updated)
	}
}
func (r *Router) rotateBotToken(w http.ResponseWriter, req *http.Request) {
	b := r.ownedBot(w, req)
	if b == nil {
		return
	}
	raw, err := r.store.RotateManagedBotToken(req.Context(), b.ID, b.OwnerID)
	if err != nil {
		r.writeError(w, 400, "ROTATION_FAILED", "Cannot rotate key")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	r.writeJSON(w, 200, map[string]string{"api_key": raw})
}
func (r *Router) manageBotWebhook(w http.ResponseWriter, req *http.Request) {
	b, ok := req.Context().Value(botContextKey).(*models.ManagedBot)
	if !ok {
		b = r.ownedBot(w, req)
	}
	if b == nil {
		return
	}
	var body struct {
		URL    string `json:"url"`
		Secret string `json:"secret"`
	}
	if req.Method != http.MethodDelete {
		if decodeBotBody(w, req, &body) != nil {
			r.writeError(w, 400, "INVALID_BODY", "Invalid webhook settings")
			return
		}
		u, err := url.Parse(body.URL)
		if body.URL != "" && (err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || len(body.URL) > 2048 || len(body.Secret) < 16 || len(body.Secret) > 256 || strings.ContainsAny(body.Secret, "\r\n") || netguard.ValidateURL(req.Context(), body.URL) != nil) {
			r.writeError(w, 400, "INVALID_WEBHOOK", "Use a public HTTPS URL and a 16-256 character secret")
			return
		}
	}
	if err := r.store.SetBotWebhook(req.Context(), b.ID, b.OwnerID, body.URL, body.Secret); err != nil {
		r.writeError(w, 500, "STORAGE_ERROR", "Could not configure webhook")
		return
	}
	r.writeJSON(w, 200, map[string]bool{"configured": body.URL != ""})
}
func (r *Router) botMe(w http.ResponseWriter, req *http.Request) {
	r.writeJSON(w, 200, managedBot(req))
}
func (r *Router) botUpdates(w http.ResponseWriter, req *http.Request) {
	b := managedBot(req)
	if b.WebhookURL != "" {
		r.writeError(w, 409, "WEBHOOK_ACTIVE", "Disable the webhook before using polling")
		return
	}
	offset, err := strconv.ParseInt(req.URL.Query().Get("offset"), 10, 64)
	if req.URL.Query().Get("offset") == "" {
		offset = 0
		err = nil
	}
	if err != nil || offset < 0 {
		r.writeError(w, 400, "INVALID_OFFSET", "Offset must be a nonnegative update ID")
		return
	}
	limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
	wait, _ := strconv.Atoi(req.URL.Query().Get("timeout"))
	if wait < 0 || wait > 50 {
		r.writeError(w, 400, "INVALID_TIMEOUT", "timeout must be 0-50 seconds")
		return
	}
	if offset > 0 {
		if err = r.store.AcknowledgeBotUpdates(req.Context(), b.ID, offset); err != nil {
			r.writeError(w, 500, "STORAGE_ERROR", "Acknowledgement failed")
			return
		}
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Duration(wait+15) * time.Second))
	deadline := time.Now().Add(time.Duration(wait) * time.Second)
	for {
		current, err := r.store.GetManagedBotByToken(req.Context(), botToken(req))
		if err != nil {
			r.writeError(w, 401, "INVALID_BOT_TOKEN", "Token revoked")
			return
		}
		if current.WebhookURL != "" {
			r.writeError(w, 409, "WEBHOOK_ACTIVE", "Webhook enabled during polling")
			return
		}
		updates, err := r.store.GetBotUpdates(req.Context(), b.ID, offset, limit)
		if err != nil {
			r.writeError(w, 500, "STORAGE_ERROR", "Cannot read updates")
			return
		}
		if len(updates) > 0 || !time.Now().Before(deadline) {
			r.writeJSON(w, 200, map[string]any{"updates": updates})
			return
		}
		select {
		case <-req.Context().Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
}

type botButton struct {
	Text string `json:"text"`
	Data string `json:"callback_data,omitempty"`
	URL  string `json:"url,omitempty"`
}
type botMessageBody struct {
	ConversationID string        `json:"conversation_id"`
	Text           string        `json:"text"`
	AttachmentID   string        `json:"attachment_id,omitempty"`
	ReplyToID      string        `json:"reply_to_id,omitempty"`
	TopicID        string        `json:"topic_id,omitempty"`
	IdempotencyKey string        `json:"idempotency_key,omitempty"`
	Buttons        [][]botButton `json:"buttons,omitempty"`
	PollID         string        `json:"poll_id,omitempty"`
}

func (r *Router) botMessagePayload(ctx context.Context, b *models.ManagedBot, body botMessageBody) (string, []string, error) {
	if body.ConversationID == "" || utf8.RuneCountInString(body.Text) > 32000 {
		return "", nil, errors.New("conversation_id and a supported message are required")
	}
	conv, err := r.convs.GetConversation(ctx, body.ConversationID, b.UserID)
	if err != nil || conv.SecurityMode != "normal" {
		return "", nil, storage.ErrUnauthorized
	}
	if len(body.Buttons) > 20 {
		return "", nil, errors.New("too many keyboard rows")
	}
	for _, row := range body.Buttons {
		if len(row) > 8 {
			return "", nil, errors.New("too many buttons in a row")
		}
		for _, button := range row {
			u, err := url.Parse(button.URL)
			if button.Text == "" || len(button.Text) > 256 || len(button.Data) > 128 || (button.Data == "") == (button.URL == "") || (button.URL != "" && (err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil)) {
				return "", nil, errors.New("buttons require text and exactly one callback_data or HTTP(S) URL")
			}
		}
	}
	payload := map[string]any{"type": "text", "text": body.Text, "bot_actions": body.Buttons}
	ids := []string{}
	if body.AttachmentID != "" {
		a, err := r.store.GetAttachmentByID(ctx, body.AttachmentID)
		if err != nil || a.ConversationID != body.ConversationID || a.UploaderID != b.UserID || a.IsEncrypted {
			return "", nil, storage.ErrUnauthorized
		}
		ids = append(ids, a.ID)
		payload["type"] = "attachment"
		payload["attachmentMeta"] = map[string]any{"id": a.ID, "filename": a.Filename, "contentType": a.ContentType, "sizeBytes": a.SizeBytes, "isVideo": strings.HasPrefix(a.ContentType, "video/"), "isPhoto": strings.HasPrefix(a.ContentType, "image/"), "isVoice": strings.HasPrefix(a.ContentType, "audio/"), "isViewOnce": a.IsViewOnce}
	} else if body.PollID != "" {
		poll, err := r.store.GetPoll(ctx, body.PollID, b.UserID)
		if err != nil || poll.ConversationID != conv.ID || poll.CreatorID != b.UserID {
			return "", nil, storage.ErrUnauthorized
		}
		payload["type"] = "poll"
		payload["poll_id"] = poll.ID
	} else if strings.TrimSpace(body.Text) == "" {
		return "", nil, errors.New("text must not be empty")
	}
	if body.ReplyToID != "" {
		reply, err := r.store.GetMessageByID(ctx, body.ReplyToID)
		if err != nil || reply.ConversationID != conv.ID {
			return "", nil, storage.ErrUnauthorized
		}
	}
	raw, err := json.Marshal(payload)
	return string(raw), ids, err
}
func (r *Router) botSendMessage(w http.ResponseWriter, req *http.Request) {
	var body botMessageBody
	if decodeBotBody(w, req, &body) != nil {
		r.writeError(w, 400, "INVALID_BODY", "Invalid message body")
		return
	}
	b := managedBot(req)
	payload, ids, err := r.botMessagePayload(req.Context(), b, body)
	if err != nil {
		r.writeError(w, 400, "INVALID_MESSAGE", err.Error())
		return
	}
	if body.IdempotencyKey == "" {
		body.IdempotencyKey = uuid.NewString()
	}
	msg, err := r.msgs.SubmitMessage(req.Context(), messages.SubmitMessageParams{ConversationID: body.ConversationID, SenderID: b.UserID, Ciphertext: payload, Nonce: "normal", AttachmentIDs: ids, IdempotencyKey: body.IdempotencyKey, ReplyToID: body.ReplyToID, TopicID: body.TopicID})
	if err != nil {
		r.writeError(w, 400, "SEND_FAILED", err.Error())
		return
	}
	r.writeJSON(w, 201, msg)
}
func (r *Router) botEditMessage(w http.ResponseWriter, req *http.Request) {
	var body botMessageBody
	if decodeBotBody(w, req, &body) != nil {
		r.writeError(w, 400, "INVALID_BODY", "Invalid message body")
		return
	}
	old, oldErr := r.store.GetMessageByID(req.Context(), req.PathValue("msgId"))
	if oldErr != nil || old.SenderID != managedBot(req).UserID || old.ConversationID != body.ConversationID {
		r.writeError(w, 403, "FORBIDDEN", "Message unavailable")
		return
	}
	var prior struct {
		Attachment struct {
			ID string `json:"id"`
		} `json:"attachmentMeta"`
	}
	_ = json.Unmarshal([]byte(old.Ciphertext), &prior)
	if body.AttachmentID == "" {
		body.AttachmentID = prior.Attachment.ID
	}
	if body.AttachmentID != prior.Attachment.ID {
		r.writeError(w, 400, "INVALID_MESSAGE", "Send a new message to change the attachment")
		return
	}
	payload, _, err := r.botMessagePayload(req.Context(), managedBot(req), body)
	if err == nil {
		err = r.msgs.EditMessage(req.Context(), body.ConversationID, req.PathValue("msgId"), managedBot(req).UserID, payload)
	}
	if err != nil {
		r.writeError(w, 400, "EDIT_FAILED", err.Error())
		return
	}
	msg, _ := r.store.GetMessageByID(req.Context(), req.PathValue("msgId"))
	r.writeJSON(w, 200, msg)
}
func (r *Router) botDeleteMessage(w http.ResponseWriter, req *http.Request) {
	conv := req.URL.Query().Get("conversation_id")
	err := r.msgs.DeleteMessageForEveryone(req.Context(), conv, req.PathValue("msgId"), managedBot(req).UserID)
	if err != nil {
		r.writeError(w, 403, "DELETE_FAILED", err.Error())
		return
	}
	r.writeJSON(w, 200, map[string]bool{"deleted": true})
}
func (r *Router) botForwardMessage(w http.ResponseWriter, req *http.Request) {
	var body struct {
		ConversationID string `json:"conversation_id"`
		MessageID      string `json:"message_id"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if decodeBotBody(w, req, &body) != nil {
		r.writeError(w, 400, "INVALID_BODY", "Invalid forward body")
		return
	}
	b := managedBot(req)
	source, err := r.store.GetMessageByID(req.Context(), body.MessageID)
	if err != nil || source.IsDeleted || source.Nonce != "normal" {
		r.writeError(w, 403, "FORBIDDEN", "Source unavailable")
		return
	}
	if !r.store.BotCanReadMessage(req.Context(), b, source) {
		r.writeError(w, 403, "FORBIDDEN", "Source access denied")
		return
	}
	destination, err := r.convs.GetConversation(req.Context(), body.ConversationID, b.UserID)
	if err != nil || destination.SecurityMode != "normal" {
		r.writeError(w, 403, "FORBIDDEN", "Destination access denied")
		return
	}
	var p map[string]any
	_ = json.Unmarshal([]byte(source.Ciphertext), &p)
	if p["type"] == "whisper" {
		r.writeError(w, 403, "FORBIDDEN", "Private whispers cannot be forwarded by a bot")
		return
	}
	if body.IdempotencyKey == "" {
		body.IdempotencyKey = uuid.NewString()
	}
	msg, err := r.msgs.SubmitMessage(req.Context(), messages.SubmitMessageParams{ConversationID: body.ConversationID, SenderID: b.UserID, Ciphertext: source.Ciphertext, Nonce: "normal", IdempotencyKey: body.IdempotencyKey})
	if err != nil {
		r.writeError(w, 400, "FORWARD_FAILED", err.Error())
		return
	}
	r.writeJSON(w, 201, msg)
}
func (r *Router) botLeave(w http.ResponseWriter, req *http.Request) {
	if err := r.store.RemoveConversationMember(req.Context(), req.PathValue("id"), managedBot(req).UserID); err != nil {
		r.writeError(w, 400, "LEAVE_FAILED", err.Error())
		return
	}
	r.writeJSON(w, 200, map[string]bool{"left": true})
}
func (r *Router) botTyping(w http.ResponseWriter, req *http.Request) {
	payload, _ := json.Marshal(map[string]any{"conversation_id": req.PathValue("id"), "user_id": managedBot(req).UserID, "is_typing": true})
	r.hub.BroadcastToConversation(req.PathValue("id"), events.ClientEnvelope{V: 1, Type: "typing", Payload: payload})
	r.writeJSON(w, 200, map[string]bool{"ok": true})
}
func (r *Router) createBotCallback(w http.ResponseWriter, req *http.Request) {
	if !r.authorizeMessage(w, req, req.PathValue("id"), req.PathValue("msgId"), getUserFromContext(req.Context()).ID) {
		return
	}
	var body struct {
		Data string `json:"data"`
	}
	if decodeBotBody(w, req, &body) != nil {
		r.writeError(w, 400, "INVALID_BODY", "Invalid callback data")
		return
	}
	msg, err := r.store.GetMessageByID(req.Context(), req.PathValue("msgId"))
	if err != nil || msg.IsDeleted {
		r.writeError(w, 404, "NOT_FOUND", "Message unavailable")
		return
	}
	b, err := r.store.GetManagedBot(req.Context(), msg.SenderID)
	if err != nil || !b.Enabled {
		r.writeError(w, 404, "NOT_FOUND", "Bot unavailable")
		return
	}
	var payload struct {
		Buttons [][]botButton `json:"bot_actions"`
	}
	_ = json.Unmarshal([]byte(msg.Ciphertext), &payload)
	valid := false
	for _, row := range payload.Buttons {
		for _, button := range row {
			if button.Data != "" && button.Data == body.Data {
				valid = true
			}
		}
	}
	if !valid {
		r.writeError(w, 400, "INVALID_CALLBACK", "Button not found")
		return
	}
	id, err := r.store.CreateBotCallback(req.Context(), b.ID, getUserFromContext(req.Context()).ID, msg.ConversationID, msg.ID, body.Data)
	if err != nil {
		r.writeError(w, 500, "STORAGE_ERROR", "Could not queue callback")
		return
	}
	r.writeJSON(w, 201, map[string]string{"id": id})
}
func (r *Router) botAnswerCallback(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Text  string `json:"text"`
		Alert bool   `json:"show_alert"`
	}
	if decodeBotBody(w, req, &body) != nil || utf8.RuneCountInString(body.Text) > 512 {
		r.writeError(w, 400, "INVALID_BODY", "Invalid callback answer")
		return
	}
	list, err := r.store.AnswerBotCallback(req.Context(), managedBot(req).ID, req.PathValue("callbackID"), body.Text, body.Alert)
	if err != nil {
		r.writeError(w, 404, "NOT_FOUND", "Callback expired or already answered")
		return
	}
	for _, ev := range list {
		r.hub.PublishEvent(ev)
	}
	r.writeJSON(w, 200, map[string]bool{"answered": true})
}

// DispatchBotWebhooks uses durable updates and a lease. Successful deliveries
// are acknowledged; failures remain queued for exponential retry (at least once).
func (r *Router) DispatchBotWebhooks(ctx context.Context, now time.Time, client *http.Client) error {
	bots, err := r.store.DueBotWebhooks(ctx, now)
	if err != nil {
		return err
	}
	if client == nil {
		client = netguard.Client(12 * time.Second)
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	for _, b := range bots {
		claimed, err := r.store.ClaimBotWebhook(ctx, b.ID, now)
		if err != nil {
			return err
		}
		if !claimed {
			continue
		}
		updates, err := r.store.GetBotUpdates(ctx, b.ID, 0, 1)
		if err != nil {
			_ = r.store.FinishBotWebhook(ctx, b.ID, false, now)
			return err
		}
		success := true
		for _, update := range updates {
			data, _ := json.Marshal(update)
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.WebhookURL, bytes.NewReader(data))
			if err != nil {
				success = false
				break
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Senora-Bot-Secret", b.WebhookSecret)
			response, err := client.Do(req)
			if response != nil {
				_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
				response.Body.Close()
			}
			if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
				success = false
				break
			}
			if err = r.store.AcknowledgeBotUpdates(ctx, b.ID, update.ID+1); err != nil {
				return err
			}
		}
		if err = r.store.FinishBotWebhook(ctx, b.ID, success, now); err != nil {
			return err
		}
	}
	return nil
}
func (r *Router) RunBotWebhooks(ctx context.Context) {
	lastPrune := time.Time{}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if now.Sub(lastPrune) > time.Hour {
				if r.store.PruneBotUpdates(ctx, now.UTC()) == nil {
					lastPrune = now
				}
			}
			maintenance, err := r.store.GetServerSetting(ctx, "maintenance_mode", "false")
			if err == nil && maintenance != "true" {
				_ = r.DispatchBotWebhooks(ctx, now.UTC(), nil)
			}
		}
	}
}
