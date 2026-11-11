package conversations

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"

	"senora/server/internal/models"
	"senora/server/internal/storage"
)

var (
	ErrForbidden = errors.New("user is not a participant in this conversation")
)

type Service struct {
	store storage.Store
}

func NewService(store storage.Store) *Service {
	return &Service{store: store}
}

// CreateDirectConversation establishes or retrieves a 1-on-1 direct conversation or Saved Messages self-chat.
func (s *Service) CreateDirectConversation(ctx context.Context, creatorID, peerID string) (*models.Conversation, error) {
	if creatorID == peerID {
		// Saved Messages: check if user already has a saved messages conversation
		existingConvs, err := s.store.ListConversationsForUser(ctx, creatorID)
		if err == nil {
			for _, conv := range existingConvs {
				if conv.Type == "saved" || (conv.Type == "direct" && len(conv.Participants) == 1 && conv.Participants[0].ID == creatorID) {
					return conv, nil
				}
			}
		}

		conv := &models.Conversation{
			ID:    "cnv_" + uuid.New().String(),
			Type:  "saved",
			Title: "Saved Messages",
		}

		if err := s.store.CreateConversation(ctx, conv, []string{creatorID}); err != nil {
			return nil, err
		}

		return s.store.GetConversationByID(ctx, conv.ID)
	}

	// Verify peer user exists
	if _, err := s.store.GetUserByID(ctx, peerID); err != nil {
		return nil, err
	}

	// Check if conversation between these two already exists
	existingConvs, err := s.store.ListConversationsForUser(ctx, creatorID)
	if err == nil {
		for _, conv := range existingConvs {
			if conv.Type == "direct" && len(conv.Participants) == 2 {
				p0 := conv.Participants[0].ID
				p1 := conv.Participants[1].ID
				if (p0 == creatorID && p1 == peerID) || (p0 == peerID && p1 == creatorID) {
					return conv, nil
				}
			}
		}
	}

	conv := &models.Conversation{
		ID:   "cnv_" + uuid.New().String(),
		Type: "direct",
	}

	if err := s.store.CreateConversation(ctx, conv, []string{creatorID, peerID}); err != nil {
		return nil, err
	}

	return s.store.GetConversationByID(ctx, conv.ID)
}

// CreateGroupConversation creates a multi-user group chat.
func (s *Service) CreateGroupConversation(ctx context.Context, creatorID, title string, memberIDs []string) (*models.Conversation, error) {
	creatorID = strings.TrimSpace(creatorID)
	if creatorID == "" {
		return nil, errors.New("creatorID cannot be empty")
	}

	if title == "" {
		title = "New Group"
	}

	membersList := []string{creatorID}
	seen := map[string]bool{creatorID: true}
	for _, m := range memberIDs {
		m = strings.TrimSpace(m)
		if m != "" && !seen[m] {
			seen[m] = true
			membersList = append(membersList, m)
		}
	}

	conv := &models.Conversation{
		ID:    "cnv_" + uuid.New().String(),
		Type:  "group",
		Title: title,
	}

	if err := s.store.CreateConversation(ctx, conv, membersList); err != nil {
		return nil, err
	}

	return s.store.GetConversationByID(ctx, conv.ID)
}

func (s *Service) ListConversations(ctx context.Context, userID string) ([]*models.Conversation, error) {
	convs, err := s.store.ListConversationsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	isOwner, _ := s.store.IsUserOwner(ctx, userID)
	if isOwner {
		return convs, nil
	}
	// For non-owners: completely strip out any conversation involving the master bot
	filtered := make([]*models.Conversation, 0, len(convs))
	for _, c := range convs {
		if strings.Contains(c.ID, "masterbot") {
			continue
		}
		hasBot := false
		for _, p := range c.Participants {
			if p.ID == "usr_senoramasterbot" {
				hasBot = true
				break
			}
		}
		if !hasBot {
			filtered = append(filtered, c)
		}
	}
	return filtered, nil
}

func (s *Service) GetConversation(ctx context.Context, convID, userID string) (*models.Conversation, error) {
	if strings.Contains(convID, "masterbot") {
		isOwner, _ := s.store.IsUserOwner(ctx, userID)
		if !isOwner {
			return nil, ErrForbidden
		}
	}
	isMember, err := s.store.IsMember(ctx, convID, userID)
	if err != nil {
		return nil, err
	}
	if !isMember {
		return nil, ErrForbidden
	}
	return s.store.GetConversationByID(ctx, convID)
}

func (s *Service) ValidateMembership(ctx context.Context, convID, userID string) error {
	isMember, err := s.store.IsMember(ctx, convID, userID)
	if err != nil {
		return err
	}
	if !isMember {
		return ErrForbidden
	}
	return nil
}

func (s *Service) GetMembers(ctx context.Context, convID string) ([]string, error) {
	return s.store.GetConversationMembers(ctx, convID)
}

func (s *Service) GetConversationMemberDetails(ctx context.Context, convID, requesterID string) ([]*models.ConversationMemberDetail, error) {
	if err := s.ValidateMembership(ctx, convID, requesterID); err != nil {
		return nil, err
	}
	conv, err := s.store.GetConversationByID(ctx, convID)
	if err != nil {
		return nil, err
	}

	details, err := s.store.GetConversationMemberDetails(ctx, convID)
	if err != nil {
		return nil, err
	}

	// For channels: respect privacy model. Regular subscribers can see admins/owner only; admins/owner can see all members.
	if conv.Type == "channel" {
		callerRole, _ := s.store.GetMemberRole(ctx, convID, requesterID)
		if callerRole != "admin" && callerRole != "owner" {
			var filtered []*models.ConversationMemberDetail
			for _, m := range details {
				if m.Role == "admin" || m.Role == "owner" {
					filtered = append(filtered, m)
				}
			}
			return filtered, nil
		}
	}

	return details, nil
}

func (s *Service) CreateChannelConversation(ctx context.Context, creatorID, title, description string, username ...string) (*models.Conversation, error) {
	if title == "" {
		title = "New Channel"
	}

	u := ""
	if len(username) > 0 {
		u = strings.TrimPrefix(strings.TrimSpace(username[0]), "@")
	}

	conv := &models.Conversation{
		ID:          "cnv_" + uuid.New().String(),
		Type:        "channel",
		Title:       title,
		Description: description,
		Username:    u,
	}

	if err := s.store.CreateConversation(ctx, conv, []string{creatorID}); err != nil {
		return nil, err
	}

	return s.store.GetConversationByID(ctx, conv.ID)
}

func (s *Service) AddMember(ctx context.Context, convID, requesterID, newUserID, role string) error {
	if err := s.ValidateMembership(ctx, convID, requesterID); err != nil {
		return err
	}
	conv, err := s.store.GetConversationByID(ctx, convID)
	if err != nil {
		return err
	}
	if conv.Type == "direct" {
		return ErrForbidden
	}
	if conv.SecurityMode != "normal" && (newUserID == models.BotFatherID || strings.HasPrefix(newUserID, "bot_")) {
		return ErrForbidden
	}

	if role == "" {
		role = "member"
	}
	return s.store.AddConversationMember(ctx, convID, newUserID, role)
}

func (s *Service) RemoveMember(ctx context.Context, convID, requesterID, targetUserID string) error {
	if err := s.ValidateMembership(ctx, convID, requesterID); err != nil {
		return err
	}
	// User can leave themselves or admin can remove
	return s.store.RemoveConversationMember(ctx, convID, targetUserID)
}

func (s *Service) UpdateDetails(ctx context.Context, convID, requesterID, title, description, avatarURL string) error {
	if err := s.ValidateMembership(ctx, convID, requesterID); err != nil {
		return err
	}
	conv, err := s.store.GetConversationByID(ctx, convID)
	if err != nil {
		return err
	}
	if title != "" {
		conv.Title = title
	}
	if description != "" {
		conv.Description = description
	}
	if avatarURL != "" {
		conv.AvatarURL = avatarURL
	}
	return s.store.UpdateConversation(ctx, conv)
}

func (s *Service) SetSecurityMode(ctx context.Context, convID, requesterID, mode string) error {
	if err := s.ValidateMembership(ctx, convID, requesterID); err != nil {
		return err
	}
	conv, err := s.store.GetConversationByID(ctx, convID)
	if err != nil {
		return err
	}
	// Direct conversations support promotion to E2EE
	if conv.Type != "direct" && mode != "normal" {
		return errors.New("e2ee mode is only supported for direct 1-to-1 conversations")
	}
	validModes := map[string]bool{
		"normal":            true,
		"e2ee_initializing": true,
		"e2ee_active":       true,
		"e2ee_failed":       true,
	}
	if !validModes[mode] {
		return errors.New("invalid security mode")
	}
	if mode != "normal" {
		members, err := s.store.GetConversationMembers(ctx, convID)
		if err != nil {
			return err
		}
		for _, id := range members {
			if id == models.BotFatherID || id == "usr_senoramasterbot" || strings.HasPrefix(id, "bot_") {
				return errors.New("server bots cannot participate in end-to-end encrypted conversations")
			}
		}
	}
	return s.store.SetConversationSecurityMode(ctx, convID, mode)
}

func (s *Service) ClearForMe(ctx context.Context, convID, userID string) error {
	if err := s.ValidateMembership(ctx, convID, userID); err != nil {
		return err
	}
	return s.store.ClearConversationForMe(ctx, userID, convID)
}

func (s *Service) DeleteForBoth(ctx context.Context, convID, userID string) error {
	if err := s.ValidateMembership(ctx, convID, userID); err != nil {
		return err
	}
	return s.store.DeleteConversationForBoth(ctx, convID, userID)
}
