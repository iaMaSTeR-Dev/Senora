package api

import (
	"encoding/json"
	"mime"
	"net/http"
	"strings"
	"time"

	"senora/server/internal/models"
	"senora/server/internal/storage"
)

func (r *Router) authorizePublication(w http.ResponseWriter, req *http.Request, convID, userID string) bool {
	conv, err := r.convs.GetConversation(req.Context(), convID, userID)
	if err != nil {
		r.writeError(w, 403, "FORBIDDEN", "Conversation access denied")
		return false
	}
	if conv.Type == "channel" {
		role, err := r.store.GetMemberRole(req.Context(), convID, userID)
		if err != nil || (role != "owner" && role != "admin") {
			r.writeError(w, 403, "FORBIDDEN", "Only channel administrators can publish")
			return false
		}
	}
	return true
}

func (r *Router) authorizePoll(w http.ResponseWriter, req *http.Request, convID, pollID, userID string) bool {
	p, err := r.store.GetPoll(req.Context(), pollID, userID)
	if err != nil || p.ConversationID != convID {
		r.writeError(w, 404, "NOT_FOUND", "Poll not found")
		return false
	}
	return true
}

func (r *Router) authorizeMessage(w http.ResponseWriter, req *http.Request, convID, msgID, userID string) bool {
	member, err := r.store.IsMember(req.Context(), convID, userID)
	if err != nil || !member {
		r.writeError(w, 403, "FORBIDDEN", "Conversation access denied")
		return false
	}
	msg, err := r.store.GetMessageByID(req.Context(), msgID)
	if err != nil || msg.ConversationID != convID {
		r.writeError(w, 404, "NOT_FOUND", "Message not found")
		return false
	}
	return true
}

func pollForViewer(p *models.Poll, viewer string) map[string]any {
	var result map[string]any
	data, _ := json.Marshal(p)
	_ = json.Unmarshal(data, &result)
	if p.IsQuiz && !p.IsClosed && viewer != p.CreatorID && (viewer == "" || len(p.MyVotes) == 0) {
		delete(result, "correct_option")
		delete(result, "explanation")
	}
	if viewer == "" {
		delete(result, "my_votes")
	}
	return result
}

func safeInlineType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil {
		return false
	}
	switch strings.ToLower(mediaType) {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav", "audio/mp4":
		return true
	}
	return false
}

func (r *Router) optionalViewer(req *http.Request) string {
	if user := getUserFromContext(req.Context()); user != nil {
		return user.ID
	}
	token := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
	if token == "" {
		token = req.URL.Query().Get("auth")
	}
	if token == "" {
		token = req.URL.Query().Get("token")
	}
	if token == "" {
		if cookie, err := req.Cookie("senora_session"); err == nil {
			token = cookie.Value
		}
	}
	_, user, err := r.sessions.ValidateSession(req.Context(), token)
	if err != nil || user == nil {
		return ""
	}
	return user.ID
}

func (r *Router) visibleAvatarURL(req *http.Request, target *models.User) string {
	if !storage.CanViewUserField(req.Context(), r.store, target.ID, r.optionalViewer(req), "profilePhotoVisibility") {
		return ""
	}
	return target.AvatarURL
}

func (r *Router) presenceFor(req *http.Request, target string) map[string]any {
	result := map[string]any{"user_id": target, "is_online": false, "last_seen_at": nil}
	if !storage.CanViewUserField(req.Context(), r.store, target, r.optionalViewer(req), "lastSeenVisibility") {
		return result
	}
	result["is_online"] = r.hub.IsUserOnline(target)
	devices, err := r.store.GetDevicesByUserID(req.Context(), target)
	if err != nil {
		return result
	}
	var last time.Time
	for _, d := range devices {
		if d.LastSeenAt.After(last) {
			last = d.LastSeenAt
		}
	}
	if !last.IsZero() {
		result["last_seen_at"] = last
	}
	return result
}
