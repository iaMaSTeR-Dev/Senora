package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"senora/server/internal/botlocale"
	"senora/server/internal/messages"
	"senora/server/internal/models"
	"senora/server/internal/storage"
)

const botFatherHelpFA = `🤖 SENORA BotFather

برای ساخت ربات و دریافت کلید اختصاصی /newbot را بفرستید.
Create your own bot and API key with /newbot.

/newbot — ساخت مرحله‌به‌مرحله / create a bot
/mybots — ربات‌های من / list your bots
/manage @username — مدیریت یک ربات / manage a bot
/token @username — صدور کلید جدید و ابطال کلید قبلی / rotate API key
/setname @username Name — نام نمایشی / display name
/setdescription @username Text — توضیحات / description
/setprivacy @username on|off — دسترسی پیام‌های گروه / group privacy
/setcommands @username [{"command":"start","description":"Start"}]
/disable @username — غیرفعال‌سازی ربات و کلید / disable bot and key
/api — راهنمای API / API reference
/cancel — لغو ساخت / cancel

کلید را فقط در برنامهٔ خود نگه دارید. ربات فقط به گفتگوهایی دسترسی دارد که عضو آن است. ربات‌های سروری وارد گفتگوی E2EE نمی‌شوند.`

func botFatherHelp(ctx context.Context) string {
	return botlocale.Text(ctx, `🤖 SENORA BotFather

Create your own bot and API key with /newbot.

/newbot — Create a bot step by step
/mybots — List your bots
/manage @username — Manage a bot
/token @username — Rotate the API key and revoke the old key
/setname @username Name — Change display name
/setdescription @username Text — Change description
/setprivacy @username on|off — Set group message privacy
/setcommands @username [{"command":"start","description":"Start"}]
/disable @username — Disable bot and key
/api — API reference
/cancel — Cancel creation

Keep your key private. Bots can access only conversations they have joined.
Server bots cannot read E2EE conversations.
Responses follow your language preference in Settings → Language. English is the default.`, botFatherHelpFA)
}

func (r *Router) ensureBotFather(ctx context.Context) error {
	if existing, err := r.store.GetUserByID(ctx, models.BotFatherID); err == nil && existing != nil {
		return nil
	} else if err != nil && !errors.Is(err, storage.ErrNotFound) {
		return err
	}
	return r.store.CreateUser(ctx, &models.User{ID: models.BotFatherID, Username: models.BotFatherUsername, DisplayName: "SENORA BotFather", Bio: botlocale.Text(ctx, "Create and manage your SENORA bots", "Create and manage your SENORA bots · ساخت و مدیریت ربات"), PasswordHash: "!", IsApproved: true})
}
func (r *Router) openBotFather(w http.ResponseWriter, req *http.Request) {
	req = req.WithContext(botlocale.WithUser(req.Context(), r.store, getUserFromContext(req.Context()).ID))
	if err := r.ensureBotFather(req.Context()); err != nil && !errors.Is(err, storage.ErrAlreadyExists) {
		r.writeError(w, 500, "BOTFATHER_UNAVAILABLE", "Could not initialize BotFather")
		return
	}
	father, err := r.store.GetUserByUsername(req.Context(), models.BotFatherUsername)
	if err != nil || father.ID != models.BotFatherID {
		r.writeError(w, 409, "BOTFATHER_USERNAME_CONFLICT", "Reserved username belongs to an existing account; no account was overwritten")
		return
	}
	conv, err := r.convs.CreateDirectConversation(req.Context(), getUserFromContext(req.Context()).ID, models.BotFatherID)
	if err != nil {
		r.writeError(w, 400, "CONVERSATION_FAILED", err.Error())
		return
	}
	history, err := r.store.GetMessagesForUser(req.Context(), conv.ID, getUserFromContext(req.Context()).ID, "", 1)
	if err != nil {
		r.writeError(w, 500, "STORAGE_ERROR", "Could not load BotFather")
		return
	}
	if len(history) == 0 {
		if err = r.sendBotFather(req.Context(), conv.ID, botFatherHelp(req.Context())); err != nil {
			r.writeError(w, 500, "BOTFATHER_UNAVAILABLE", "Could not send welcome message")
			return
		}
	}
	r.writeJSON(w, 200, conv)
}
func (r *Router) sendBotFather(ctx context.Context, conv, text string) error {
	raw, _ := json.Marshal(map[string]any{"text": text, "bot_actions": [][]map[string]string{{{"text": botlocale.Text(ctx, "➕ New bot", "➕ New bot / ساخت ربات"), "command": "/newbot"}, {"text": botlocale.Text(ctx, "🤖 My bots", "🤖 My bots / ربات‌های من"), "command": "/mybots"}}, {{"text": "API", "command": "/api"}, {"text": botlocale.Text(ctx, "Cancel", "Cancel / لغو"), "command": "/cancel"}}}})
	_, err := r.msgs.SubmitMessage(ctx, messages.SubmitMessageParams{ConversationID: conv, SenderID: models.BotFatherID, Ciphertext: string(raw), Nonce: "normal"})
	return err
}
func (r *Router) handleBotFatherMessage(ctx context.Context, user, convID, ciphertext string) error {
	ctx = botlocale.WithUser(ctx, r.store, user)
	conv, err := r.store.GetConversationByID(ctx, convID)
	if err != nil {
		return err
	}
	members, err := r.store.GetConversationMembers(ctx, convID)
	if err != nil {
		return err
	}
	if conv.Type != "direct" || conv.SecurityMode != "normal" || len(members) != 2 {
		return r.sendBotFather(ctx, convID, botlocale.Text(ctx, "BotFather works only in your private direct conversation.", "BotFather works only in your private direct conversation. مدیریت کلید فقط در گفتگوی خصوصی ممکن است."))
	}
	foundUser, foundFather := false, false
	for _, id := range members {
		foundUser = foundUser || id == user
		foundFather = foundFather || id == models.BotFatherID
	}
	if !foundUser || !foundFather {
		return storage.ErrUnauthorized
	}
	text := strings.TrimSpace(ciphertext)
	var p struct {
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(text), &p) == nil {
		text = strings.TrimSpace(p.Text)
	}
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return nil
	}
	command := strings.ToLower(fields[0])
	reply := botFatherHelp(ctx)
	switch command {
	case "/start", "/help":
		reply = botFatherHelp(ctx)
	case "/cancel":
		if err = r.store.SetBotFatherState(ctx, user, ""); err != nil {
			return err
		}
		reply = botlocale.Text(ctx, "Cancelled. Use /newbot to start again.", "ساخت ربات لغو شد. /newbot برای شروع دوباره.\nCancelled. Use /newbot to start again.")
	case "/newbot":
		if len(fields) >= 3 {
			return r.createBotFatherBot(ctx, user, convID, fields[1], strings.Join(fields[2:], " "))
		}
		if err = r.store.SetBotFatherState(ctx, user, `{"step":"name"}`); err != nil {
			return err
		}
		reply = botlocale.Text(ctx, "Send the bot display name (1–64 characters).", "نام نمایشی ربات را بفرستید (۱ تا ۶۴ نویسه).\nSend the bot display name (1–64 characters).")
	case "/mybots":
		list, err := r.store.ListManagedBots(ctx, user)
		if err != nil {
			return err
		}
		reply = botlocale.Text(ctx, "Your bots:\n", "ربات‌های شما / Your bots:\n")
		if len(list) == 0 {
			reply += botlocale.Text(ctx, "No bots yet. Send /newbot to create one.", "هنوز رباتی نساخته‌اید. /newbot\nNo bots yet. /newbot")
		}
		for _, b := range list {
			reply += fmt.Sprintf("\n@%s — %s (enabled=%t)\n/manage @%s\n", b.Username, b.Name, b.Enabled, b.Username)
		}
	case "/api":
		reply = botlocale.Text(ctx, "SENORA Native Bot API\nAuthorization: Bot <API_KEY>\nGET /api/v1/bot/me\nGET /api/v1/bot/updates?offset=0&timeout=30\nPOST /api/v1/bot/messages\nPOST /api/v1/bot/attachments\nPOST /api/v1/bot/callbacks/{id}/answer\n\nSend: {\"conversation_id\":\"…\",\"text\":\"Hello\"}\nWebhook: PUT /api/v1/bot/webhook with a public HTTPS URL and secret.\nAcknowledge processed updates by advancing the offset. Full reference: docs/BOT_API.md.\nBots use normal conversations and cannot read E2EE. Any approved user can create a bot.", "SENORA Native Bot API\nAuthorization: Bot <API_KEY>\nGET /api/v1/bot/me\nGET /api/v1/bot/updates?offset=0&timeout=30\nPOST /api/v1/bot/messages\nPOST /api/v1/bot/attachments\nPOST /api/v1/bot/callbacks/{id}/answer\n\nارسال پیام: {\"conversation_id\":\"…\",\"text\":\"Hello\"}\nWebhook: PUT /api/v1/bots/{id}/webhook با url عمومی HTTPS و secret.\nبا offset بعدی، دریافت رویداد قبلی را تأیید کنید. مستندات کامل در docs/BOT_API.md همراه نسخه است.\nUse a normal conversation; bots cannot read E2EE. No server-owner permission is needed to create a bot.")
	case "/manage", "/token", "/revoke", "/disable", "/setname", "/setdescription", "/setprivacy", "/setcommands":
		if len(fields) < 2 {
			reply = botlocale.Text(ctx, "Enter the bot username, for example /manage @example_bot", "نام کاربری ربات را وارد کنید؛ مثلاً /manage @example_bot")
			break
		}
		b, err := r.store.GetManagedBot(ctx, strings.TrimPrefix(fields[1], "@"))
		if err != nil || b.OwnerID != user {
			reply = botlocale.Text(ctx, "Your bot was not found.", "ربات متعلق به شما پیدا نشد.\nYour bot was not found.")
			break
		}
		settings := models.BotSettings{Name: b.Name, Description: b.Description, PrivacyMode: b.PrivacyMode, Commands: b.Commands}
		switch command {
		case "/manage":
			reply = fmt.Sprintf("@%s\n%s\nID: %s\nenabled=%t; privacy=%t\n\n/token @%s\n/setname @%s New name\n/setdescription @%s Description\n/setprivacy @%s off\n/disable @%s", b.Username, b.Name, b.ID, b.Enabled, b.PrivacyMode, b.Username, b.Username, b.Username, b.Username, b.Username)
		case "/token", "/revoke":
			key, err := r.store.RotateManagedBotToken(ctx, b.ID, user)
			if err != nil {
				reply = botlocale.Text(ctx, "Could not issue a key. The bot must be enabled.", "صدور کلید انجام نشد؛ ربات باید فعال باشد.")
			} else {
				reply = botlocale.Text(ctx, "The previous key was revoked. New API key:\n`", "کلید قبلی باطل شد. کلید جدید / New API key:\n`") + key + botlocale.Text(ctx, "`\nKeep this key private.", "`\nاین کلید را برای دیگران نفرستید. Keep it private.")
			}
		case "/disable":
			if err = r.store.DisableManagedBot(ctx, b.ID, user); err != nil {
				return err
			}
			reply = botlocale.Text(ctx, "Bot and API key disabled; historical messages preserved.", "ربات و کلیدش غیرفعال شدند؛ پیام‌های قبلی حفظ شدند.\nBot and API key disabled; historical messages preserved.")
		default:
			value := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(strings.TrimPrefix(text, fields[0])), fields[1]))
			switch command {
			case "/setname":
				settings.Name = value
			case "/setdescription":
				settings.Description = value
			case "/setprivacy":
				if value != "on" && value != "off" {
					return r.sendBotFather(ctx, convID, "Use /setprivacy @username on|off")
				}
				settings.PrivacyMode = value == "on"
			case "/setcommands":
				settings.Commands = json.RawMessage(value)
			}
			if err = r.store.UpdateManagedBot(ctx, b.ID, user, settings); err != nil {
				reply = botlocale.Text(ctx, "Could not save settings: ", "تنظیمات ذخیره نشد: ") + err.Error()
			} else {
				reply = botlocale.Text(ctx, "Settings saved.", "تنظیمات ذخیره شد.\nSettings saved.")
			}
		}
	default:
		raw, err := r.store.GetBotFatherState(ctx, user)
		if err != nil {
			return err
		}
		var state struct {
			Step string `json:"step"`
			Name string `json:"name"`
		}
		_ = json.Unmarshal([]byte(raw), &state)
		if state.Step == "name" {
			if utf8.RuneCountInString(text) > 64 {
				return r.sendBotFather(ctx, convID, "Name must contain 1-64 characters.")
			}
			data, _ := json.Marshal(map[string]string{"step": "username", "name": text})
			if err = r.store.SetBotFatherState(ctx, user, string(data)); err != nil {
				return err
			}
			reply = botlocale.Text(ctx, "Send a unique username ending in bot, for example sample_bot.", "نام کاربری یکتا بفرستید؛ حروف انگلیسی، عدد و زیرخط، با bot در انتها؛ مثلاً sample_bot.\nSend a unique username ending in bot, for example sample_bot.")
		} else if state.Step == "username" {
			return r.createBotFatherBot(ctx, user, convID, text, state.Name)
		}
	}
	return r.sendBotFather(ctx, convID, reply)
}
func (r *Router) createBotFatherBot(ctx context.Context, user, conv, username, name string) error {
	bot, key, err := r.store.CreateManagedBot(ctx, user, username, name)
	if err != nil {
		return r.sendBotFather(ctx, conv, botlocale.Text(ctx, "Creation failed: ", "ساخت ربات انجام نشد / Creation failed: ")+err.Error()+botlocale.Text(ctx, "\nChoose another username or send /cancel.", "\nنام دیگری انتخاب کنید یا /cancel را بفرستید."))
	}
	if err = r.store.SetBotFatherState(ctx, user, ""); err != nil {
		return err
	}
	return r.sendBotFather(ctx, conv, fmt.Sprintf(botlocale.Text(ctx, "✅ Bot created\n@%s\nID: %s\n\nAPI key:\n`%s`\n\nKeep the key private. Send /api for integration instructions.", "✅ ربات ساخته شد / Bot created\n@%s\nID: %s\n\nAPI key:\n`%s`\n\nکلید را خصوصی نگه دارید. /api برای شروع برنامه‌نویسی.\nKeep the key private. Send /api for integration instructions."), bot.Username, bot.ID, key))
}
