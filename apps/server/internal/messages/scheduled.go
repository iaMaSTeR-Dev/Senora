package messages

import (
	"context"
	"errors"
	"log"
	"time"

	"senora/server/internal/conversations"
	"senora/server/internal/storage"
)

func (s *Service) DispatchScheduledMessages(ctx context.Context, now time.Time) (int, error) {
	maintenance, err := s.store.GetServerSetting(ctx, "maintenance_mode", "false")
	if err != nil {
		return 0, err
	}
	if maintenance == "true" {
		return 0, nil
	}
	jobs, err := s.store.ListDueScheduledMessages(ctx, now)
	if err != nil {
		return 0, err
	}
	sent := 0
	for _, job := range jobs {
		u, err := s.store.GetUserByID(ctx, job.SenderID)
		if err != nil {
			return sent, err
		}
		if !u.IsApproved || u.IsBanned {
			if err = s.store.FinishScheduledMessage(ctx, job.ID, "حساب فرستنده فعال نیست."); err != nil {
				return sent, err
			}
			continue
		}
		_, err = s.SubmitMessage(ctx, SubmitMessageParams{ConversationID: job.ConversationID, SenderID: job.SenderID, Ciphertext: job.Ciphertext, Nonce: job.Nonce, IdempotencyKey: "scheduled:" + job.ID})
		if err != nil {
			if errors.Is(err, storage.ErrUnauthorized) || errors.Is(err, storage.ErrPrivatePayload) || errors.Is(err, conversations.ErrForbidden) || errors.Is(err, ErrNormalMessageInE2EE) || errors.Is(err, ErrMalformedEncryptedEnvelope) || errors.Is(err, ErrUnsupportedEnvelopeVersion) || errors.Is(err, ErrMissingEncryptionMetadata) {
				if err = s.store.FinishScheduledMessage(ctx, job.ID, "مجوز ارسال یا اطلاعات رمزنگاری معتبر نیست؛ پیام را دوباره زمان‌بندی کنید."); err != nil {
					return sent, err
				}
				continue
			}
			return sent, err // transient failure is retried with the same idempotency key
		}
		if err = s.store.FinishScheduledMessage(ctx, job.ID, ""); err != nil {
			return sent, err
		}
		sent++
	}
	return sent, nil
}

func (s *Service) RunScheduledTasks(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var lastExpiry time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if _, err := s.DispatchScheduledMessages(ctx, now.UTC()); err != nil {
				log.Printf("[Scheduler] Delivery deferred: %v", err)
			}
			if lastExpiry.IsZero() || now.Sub(lastExpiry) >= time.Hour {
				ids, err := s.store.ExpireInactiveAccounts(ctx, now.UTC())
				if err != nil {
					log.Printf("[Scheduler] Account expiry deferred: %v", err)
				} else {
					for _, id := range ids {
						s.hub.DisconnectUser(id)
					}
					lastExpiry = now
				}
			}
		}
	}
}
