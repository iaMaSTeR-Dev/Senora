package messages

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"senora/server/internal/conversations"
	"senora/server/internal/events"
	"senora/server/internal/models"
	"senora/server/internal/storage"
)

var (
	ErrEmptyCiphertext            = errors.New("ciphertext and nonce must not be empty")
	ErrPayloadTooLarge            = errors.New("ciphertext payload exceeds maximum allowed size")
	ErrNormalMessageInE2EE        = errors.New("cannot submit unencrypted normal message to an e2ee_active conversation")
	ErrMalformedEncryptedEnvelope = errors.New("malformed encrypted envelope")
	ErrUnsupportedEnvelopeVersion = errors.New("unsupported envelope version")
	ErrMissingEncryptionMetadata = errors.New("missing required encryption metadata")
	ErrSenderMismatch             = errors.New("envelope sender does not match authenticated user")
)

type e2eeEnvelopeHeader struct {
	V            int                    `json:"v"`
	Type         string                 `json:"type"`
	SenderUserID string                 `json:"sender_user_id"`
	Devices      map[string]interface{} `json:"devices"`
}

func validateE2EEEnvelope(ciphertext, senderID string) error {
	var env e2eeEnvelopeHeader
	if err := json.Unmarshal([]byte(ciphertext), &env); err != nil {
		return ErrMalformedEncryptedEnvelope
	}
	if env.V != 1 && env.V != 2 {
		return ErrUnsupportedEnvelopeVersion
	}
	if env.Devices == nil || len(env.Devices) == 0 {
		return ErrMissingEncryptionMetadata
	}
	if len(env.Devices) > 256 {
		return ErrPayloadTooLarge
	}
	// Check sender user ID binding if declared in envelope
	if env.SenderUserID != "" && env.SenderUserID != senderID {
		return ErrMalformedEncryptedEnvelope
	}
	// Validate each device entry
	for devID, devVal := range env.Devices {
		if strings.TrimSpace(devID) == "" || len(devID) > 128 {
			return ErrMalformedEncryptedEnvelope
		}
		if devVal == nil {
			return ErrMissingEncryptionMetadata
		}
	}
	return nil
}

const MaxCiphertextBytes = 64 * 1024 // 64 KB

type Service struct {
	store storage.Store
	convs *conversations.Service
	hub   *events.Hub
}

func NewService(store storage.Store, convs *conversations.Service, hub *events.Hub) *Service {
	return &Service{
		store: store,
		convs: convs,
		hub:   hub,
	}
}

type SubmitMessageParams struct {
	ConversationID     string
	SenderID           string
	Ciphertext         string
	Nonce              string
	EphemeralPublicKey string
	IdempotencyKey     string
	ReplyToID          string
}

func (s *Service) SubmitMessage(ctx context.Context, p SubmitMessageParams) (*models.Message, error) {
	if p.Ciphertext == "" {
		return nil, ErrEmptyCiphertext
	}
	if strings.TrimSpace(p.Nonce) == "" {
		p.Nonce = "normal"
	}
	if len(p.Ciphertext) > MaxCiphertextBytes {
		return nil, ErrPayloadTooLarge
	}

	// Verify sender is an authorized member and get conversation state
	conv, err := s.convs.GetConversation(ctx, p.ConversationID, p.SenderID)
	if err != nil {
		return nil, err
	}

	if conv.SecurityMode == "e2ee_active" {
		if p.Nonce == "normal" {
			return nil, ErrNormalMessageInE2EE
		}
		if err := validateE2EEEnvelope(p.Ciphertext, p.SenderID); err != nil {
			return nil, err
		}
	}

	// Get all participants of this conversation to populate outbox events
	memberIDs, err := s.convs.GetMembers(ctx, p.ConversationID)
	if err != nil {
		return nil, err
	}

	msg := &models.Message{
		ConversationID:     p.ConversationID,
		SenderID:           p.SenderID,
		Ciphertext:         p.Ciphertext,
		Nonce:              p.Nonce,
		EphemeralPublicKey: p.EphemeralPublicKey,
		IdempotencyKey:     p.IdempotencyKey,
		ReplyToID:          p.ReplyToID,
	}

	savedMsg, outboxEvents, err := s.store.CreateMessageWithOutbox(ctx, msg, memberIDs)
	if err != nil {
		return nil, err
	}

	for _, ev := range outboxEvents {
		s.hub.PublishEvent(ev)
	}

	return savedMsg, nil
}

func (s *Service) GetMessages(ctx context.Context, conversationID, userID, beforeID string, limit int) ([]*models.Message, error) {
	if err := s.convs.ValidateMembership(ctx, conversationID, userID); err != nil {
		return nil, err
	}
	return s.store.GetMessagesForUser(ctx, conversationID, userID, beforeID, limit)
}

func (s *Service) EditMessage(ctx context.Context, convID, msgID, senderID, ciphertext string) error {
	if ciphertext == "" {
		return ErrEmptyCiphertext
	}
	if len(ciphertext) > MaxCiphertextBytes {
		return ErrPayloadTooLarge
	}

	conv, err := s.convs.GetConversation(ctx, convID, senderID)
	if err != nil {
		return err
	}

	msg, err := s.store.GetMessageByID(ctx, msgID)
	if err != nil {
		return err
	}
	if msg.ConversationID != convID || msg.SenderID != senderID {
		return storage.ErrUnauthorized
	}
	if msg.IsDeleted {
		return errors.New("cannot edit deleted message")
	}

	if conv.SecurityMode == "e2ee_active" || msg.Nonce != "normal" {
		if err := validateE2EEEnvelope(ciphertext, senderID); err != nil {
			return err
		}
	}

	updatedMsg, err := s.store.UpdateMessageCiphertext(ctx, msgID, ciphertext, msg.Nonce)
	if err != nil {
		return err
	}

	payloadBytes, _ := json.Marshal(map[string]interface{}{
		"message_id":      msgID,
		"conversation_id": convID,
		"ciphertext":      ciphertext,
		"edited_at":       updatedMsg.CreatedAt.Format(time.RFC3339Nano),
	})
	members, _ := s.convs.GetMembers(ctx, convID)
	for _, m := range members {
		s.hub.PublishEvent(&models.EventOutbox{
			EventType:       "message.updated",
			ConversationID:  convID,
			RecipientUserID: m,
			Payload:         string(payloadBytes),
		})
	}
	return nil
}

func (s *Service) DeleteMessage(ctx context.Context, convID, msgID, senderID string) error {
	return s.DeleteMessageForEveryone(ctx, convID, msgID, senderID)
}

func (s *Service) DeleteMessageForMe(ctx context.Context, convID, msgID, userID string) error {
	if err := s.convs.ValidateMembership(ctx, convID, userID); err != nil {
		return err
	}
	if err := s.store.DeleteMessageForMe(ctx, userID, msgID); err != nil {
		return err
	}
	s.hub.PublishEvent(&models.EventOutbox{
		EventType:       "message.deleted_for_me",
		ConversationID:  convID,
		RecipientUserID: userID,
		Payload:         fmt.Sprintf(`{"message_id":"%s","conversation_id":"%s"}`, msgID, convID),
	})
	return nil
}

func (s *Service) DeleteMessageForEveryone(ctx context.Context, convID, msgID, senderID string) error {
	if err := s.convs.ValidateMembership(ctx, convID, senderID); err != nil {
		return err
	}

	if err := s.store.DeleteMessageForEveryone(ctx, convID, msgID, senderID); err != nil {
		return err
	}

	members, _ := s.convs.GetMembers(ctx, convID)
	for _, m := range members {
		s.hub.PublishEvent(&models.EventOutbox{
			EventType:       "message.deleted",
			ConversationID:  convID,
			RecipientUserID: m,
			Payload:         fmt.Sprintf(`{"message_id":"%s","conversation_id":"%s","scope":"everyone"}`, msgID, convID),
		})
	}
	return nil
}

func (s *Service) AddReaction(ctx context.Context, convID, msgID, userID, emoji string) (string, error) {
	if err := s.convs.ValidateMembership(ctx, convID, userID); err != nil {
		return "", err
	}

	reactionsJSON, err := s.store.AddMessageReaction(ctx, msgID, userID, emoji)
	if err != nil {
		return "", err
	}

	members, _ := s.convs.GetMembers(ctx, convID)
	for _, m := range members {
		s.hub.PublishEvent(&models.EventOutbox{
			EventType:       "message.reaction",
			ConversationID:  convID,
			RecipientUserID: m,
			Payload:         fmt.Sprintf(`{"message_id":"%s","conversation_id":"%s","reactions":%s}`, msgID, convID, reactionsJSON),
		})
	}
	return reactionsJSON, nil
}

func (s *Service) PinMessage(ctx context.Context, convID, msgID, userID string, isPinned bool) error {
	if err := s.convs.ValidateMembership(ctx, convID, userID); err != nil {
		return err
	}

	if err := s.store.PinMessage(ctx, convID, msgID, isPinned); err != nil {
		return err
	}

	members, _ := s.convs.GetMembers(ctx, convID)
	for _, m := range members {
		s.hub.PublishEvent(&models.EventOutbox{
			EventType:       "message.pinned",
			ConversationID:  convID,
			RecipientUserID: m,
			Payload:         fmt.Sprintf(`{"message_id":"%s","conversation_id":"%s","is_pinned":%t}`, msgID, convID, isPinned),
		})
	}
	return nil
}
