package storage

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Existing installations are not enrolled retroactively. Only an explicit
// account-expiry policy can activate the scheduler's destructive operation.
func (s *SQLStore) ExpireInactiveAccounts(ctx context.Context, now time.Time) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT u.id,u.self_destruct_months,u.last_seen_at,p.activated_at FROM users u JOIN account_expiry_policies p ON p.user_id=u.id WHERE NOT u.is_owner AND u.self_destruct_months>0`)
	if err != nil {
		return nil, err
	}
	type candidate struct {
		id        string
		months    int
		last      sql.NullTime
		activated time.Time
	}
	list := []candidate{}
	for rows.Next() {
		var c candidate
		if err = rows.Scan(&c.id, &c.months, &c.last, &c.activated); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	expired := []string{}
	for _, c := range list {
		last := c.activated
		if c.last.Valid && c.last.Time.After(last) {
			last = c.last.Time
		}
		devices, err := s.GetDevicesByUserID(ctx, c.id)
		if err != nil {
			return expired, err
		}
		for _, d := range devices {
			if d.LastSeenAt.After(last) {
				last = d.LastSeenAt
			}
		}
		if now.Before(last.AddDate(0, c.months, 0)) {
			continue
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return expired, err
		}
		// Authentication updates last_seen_at; a concurrent active session prevents
		// expiry even if it appeared after the candidate scan above.
		result, err := tx.ExecContext(ctx, s.bind(`UPDATE users SET username=?,display_name='Deleted Account',password_hash='!',bio='',avatar_url='',registration_ip='',is_approved=FALSE,is_banned=TRUE,self_destruct_months=0 WHERE id=? AND NOT is_owner AND (last_seen_at IS NULL OR last_seen_at<=?)`), "deleted_"+c.id, c.id, now.AddDate(0, -c.months, 0))
		if err != nil {
			tx.Rollback()
			return expired, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			tx.Rollback()
			return expired, err
		}
		if count == 0 {
			tx.Rollback()
			continue
		}
		for _, query := range []string{"DELETE FROM sessions WHERE user_id=?", "DELETE FROM devices WHERE user_id=?", "DELETE FROM user_preferences WHERE user_id=?", "DELETE FROM push_devices WHERE user_id=?", "DELETE FROM stories WHERE user_id=?", "DELETE FROM account_expiry_policies WHERE user_id=?"} {
			if _, err = tx.ExecContext(ctx, s.bind(query), c.id); err != nil {
				break
			}
		}
		if err != nil {
			tx.Rollback()
			return expired, err
		}
		if err = tx.Commit(); err != nil {
			return expired, err
		}
		expired = append(expired, c.id)
	}
	return expired, nil
}

func (s *SQLStore) setAccountExpiry(ctx context.Context, userID string, months int) error {
	if months < 0 || months > 24 {
		return errors.New("expiry must be disabled or between 1 and 24 months")
	}
	u, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return err
	}
	if months > 0 && u.IsOwner {
		return errors.New("transfer server ownership before enabling account expiry")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	if _, err = tx.ExecContext(ctx, s.bind("UPDATE users SET self_destruct_months=?,updated_at=? WHERE id=?"), months, now, userID); err != nil {
		return err
	}
	if months == 0 {
		_, err = tx.ExecContext(ctx, s.bind("DELETE FROM account_expiry_policies WHERE user_id=?"), userID)
	} else {
		_, err = tx.ExecContext(ctx, s.bind("INSERT INTO account_expiry_policies (user_id,activated_at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET activated_at=excluded.activated_at"), userID, now)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
