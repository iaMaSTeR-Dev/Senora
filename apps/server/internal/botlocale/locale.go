// Package botlocale selects the language of built-in bot responses. Templates
// are selected before interpolation, so user-provided text is never translated.
package botlocale

import (
	"context"
	"encoding/json"
	"strings"
)

type preferences interface {
	GetUserPreferences(context.Context, string) (string, error)
}
type languageKey struct{}

func WithUser(ctx context.Context, store preferences, userID string) context.Context {
	language := "en"
	if raw, err := store.GetUserPreferences(ctx, userID); err == nil {
		var p struct {
			Language string `json:"language"`
		}
		if json.Unmarshal([]byte(raw), &p) == nil {
			requested := strings.ToLower(strings.TrimSpace(p.Language))
			if requested == "fa" || strings.HasPrefix(requested, "fa-") {
				language = "fa"
			}
		}
	}
	return context.WithValue(ctx, languageKey{}, language)
}

func Text(ctx context.Context, english, persian string) string {
	if ctx.Value(languageKey{}) == "fa" {
		return persian
	}
	return english
}
