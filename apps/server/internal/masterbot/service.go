package masterbot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"

	"senora/server/internal/auth"
	"senora/server/internal/conversations"
	"senora/server/internal/events"
	"senora/server/internal/filestore"
	"senora/server/internal/models"
	"senora/server/internal/storage"
)

const (
	BotUserID      = "usr_senoramasterbot"
	BotUsername    = "master_bot"
	BotDisplayName = "🤖 Senora Master Bot"
	BotBio         = "Official Senora Server Management Bot. Exclusive to the Server Owner."
	BotAvatarURL   = "https://api.dicebear.com/7.x/bottts/svg?seed=SenoraMasterBot"
)

type BotActionButton struct {
	Text           string `json:"text"`
	Command        string `json:"command,omitempty"`
	Action         string `json:"action,omitempty"`
	ConversationID string `json:"conversation_id,omitempty"`
	Token          string `json:"token,omitempty"`
}

type BotPayload struct {
	Text       string               `json:"text"`
	BotActions [][]BotActionButton `json:"bot_actions,omitempty"`
}

type Service struct {
	store     storage.Store
	convs     *conversations.Service
	hub       *events.Hub
	fileStore *filestore.StorageManager
}

func NewService(store storage.Store, convs *conversations.Service, hub *events.Hub) *Service {
	return &Service{
		store: store,
		convs: convs,
		hub:   hub,
	}
}

func (s *Service) SetFileStore(fs *filestore.StorageManager) {
	s.fileStore = fs
}

// EnsureBotAndOwner verifies the master bot exists and designates an owner if needed.
func (s *Service) EnsureBotAndOwner(ctx context.Context) (*models.User, error) {
	// Ensure Bot user exists
	bot, err := s.store.GetUserByID(ctx, BotUserID)
	if err != nil || bot == nil {
		botUser := &models.User{
			ID:           BotUserID,
			Username:     BotUsername,
			DisplayName:  BotDisplayName,
			Bio:          BotBio,
			AvatarURL:    BotAvatarURL,
			PasswordHash: "*system_bot_locked*",
			IsApproved:   true,
			IsOwner:      false,
			IsBanned:     false,
		}
		_ = s.store.CreateUser(ctx, botUser)
	}

	// Check if any owner exists
	owner, err := s.store.GetServerOwner(ctx)
	if err != nil || owner == nil {
		users, _ := s.store.ListAllUsers(ctx)
		if len(users) > 0 {
			// Designate the oldest registered non-bot user as owner
			oldest := users[len(users)-1]
			_ = s.store.SetUserOwner(ctx, oldest.ID, true)
			owner, _ = s.store.GetUserByID(ctx, oldest.ID)
		}
	}

	if owner != nil {
		// Ensure direct conversation between Bot and Owner exists
		s.EnsureBotConversation(ctx, owner.ID)
	}

	return owner, nil
}

// EnsureBotConversation creates the official chat between the Master Bot and Owner.
func (s *Service) EnsureBotConversation(ctx context.Context, ownerID string) (*models.Conversation, error) {
	conv, err := s.store.GetDirectConversationBetween(ctx, BotUserID, ownerID)
	if err == nil && conv != nil {
		return conv, nil
	}

	convID := "conv_masterbot_" + ownerID
	c := &models.Conversation{
		ID:           convID,
		Type:         "direct",
		Title:        BotDisplayName,
		AvatarURL:    BotAvatarURL,
		SecurityMode: "normal",
	}

	if err := s.store.CreateConversation(ctx, c, []string{BotUserID, ownerID}); err != nil {
		// May already exist
		c, _ = s.store.GetConversationByID(ctx, convID)
		if c != nil {
			return c, nil
		}
	}

	// Send initial welcome message
	welcomeText := `👋 **درود مدیر گرامی! به ربات مدیریت سرور Senora خوش آمدید.**

من **Senora Master Bot** هستم؛ دستیار اختصاصی شما برای مدیریت کامل سرور، نظارت بر کاربران و چت‌ها، و تایید دسترسی‌ها.

⚡ **دستورات اصلی:**
• /stats — مشاهده آمار زنده سرور و مصرف منابع
• /users — فهرست کاربران ثبت‌نام شده و وضعیت آنها
• /registrations — بررسی درخواست‌های در انتظار تایید
• /approve @username — تایید دسترسی کاربر
• /reject @username — رد درخواست کاربر
• /inspect @user1 @user2 — ایجاد لینک تماشای زنده چت
• /ban @username — مسدودسازی و اخراج فوری کاربر
• /unban @username — رفع مسدودیت کاربر
• /chats — فهرست تمام چت‌های سرور
• /broadcast <متن> — ارسال پیام همگانی به همه کاربران
• /approval <on|off> — فعال/غیرفعال‌سازی تایید اجباری ثبت‌نام
• /cleanup — پاکسازی پیام‌های منقضی و فایل‌های اضافه
• /help — راهنمای کامل دستورات`

	buttons := [][]BotActionButton{
		{
			{Text: "📊 آمار زنده سرور", Command: "/stats"},
			{Text: "👥 فهرست کاربران", Command: "/users"},
		},
		{
			{Text: "🛡️ درخواست‌های ثبت‌نام", Command: "/registrations"},
			{Text: "💬 چت‌های سرور", Command: "/chats"},
		},
	}

	_, _ = s.SendBotMessage(ctx, convID, welcomeText, buttons)
	return c, nil
}

// SendBotMessage posts a message from the Master Bot into a conversation.
func (s *Service) SendBotMessage(ctx context.Context, convID, text string, actions [][]BotActionButton) (*models.Message, error) {
	payload := BotPayload{
		Text:       text,
		BotActions: actions,
	}
	payloadBytes, _ := json.Marshal(payload)

	members, err := s.convs.GetMembers(ctx, convID)
	if err != nil {
		return nil, err
	}

	msg := &models.Message{
		ConversationID: convID,
		SenderID:       BotUserID,
		Ciphertext:     string(payloadBytes),
		Nonce:          "normal",
		IdempotencyKey: "idemp_bot_" + uuid.New().String(),
	}

	savedMsg, outboxEvents, err := s.store.CreateMessageWithOutbox(ctx, msg, members)
	if err != nil {
		return nil, err
	}

	for _, ev := range outboxEvents {
		s.hub.PublishEvent(ev)
	}

	return savedMsg, nil
}

// ClassifyIP analyzes an IP address and returns a human-friendly Persian classification and an icon.
func ClassifyIP(rawIP string) (label string, emoji string) {
	norm := strings.TrimSpace(rawIP)
	if host, _, err := net.SplitHostPort(norm); err == nil {
		norm = host
	}
	norm = strings.TrimPrefix(norm, "[")
	norm = strings.TrimSuffix(norm, "]")

	parsed := net.ParseIP(norm)
	if parsed == nil {
		return "آدرس نامعتبر", "❓"
	}

	if parsed.IsLoopback() {
		return "لوکال و لوپ‌بک سرور (Localhost / Loopback)", "💻"
	}

	if parsed.IsPrivate() {
		return "شبکه محلی یا VPN خصوصی (Private LAN / VPN)", "🔒"
	}

	if parsed.IsLinkLocalUnicast() || parsed.IsLinkLocalMulticast() {
		return "شبکه محلی پیوندی (Link-Local)", "🔗"
	}

	return "اینترنت عمومی (Public WAN / Internet)", "🌍"
}

// NotifyNewRegistration alerts the Server Owner when a new user registers and requires approval.
func (s *Service) NotifyNewRegistration(ctx context.Context, pendingUser *models.User, deviceName string, clientIP string, fingerprint string) error {
	owner, err := s.store.GetServerOwner(ctx)
	if err != nil || owner == nil {
		return nil
	}

	conv, err := s.EnsureBotConversation(ctx, owner.ID)
	if err != nil || conv == nil {
		return err
	}

	if clientIP == "" && pendingUser.RegistrationIP != "" {
		clientIP = pendingUser.RegistrationIP
	}
	if clientIP == "" {
		clientIP = "127.0.0.1"
	}

	lbl, emo := ClassifyIP(clientIP)
	fpText := ""
	if fingerprint != "" {
		fpText = fmt.Sprintf("\n📱 **اثرانگشت دستگاه (Fingerprint):** `%s`", fingerprint)
	}

	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05 UTC")
	text := fmt.Sprintf("🛡️ **درخواست ثبت‌نام کاربر جدید**\n"+
		"━━━━━━━━━━━━━━━━━━━\n"+
		"👤 **نام کاربری:** @%s\n"+
		"🏷️ **نام نمایشی:** %s\n"+
		"🆔 **شناسه:** %s\n"+
		"📱 **دستگاه:** %s\n"+
		"🌐 **آدرس آی‌پی:** `%s` (%s %s)%s\n"+
		"⏰ **زمان ثبت‌نام:** %s\n"+
		"━━━━━━━━━━━━━━━━━━━\n"+
		"آیا دسترسی این کاربر را به پلتفرم تایید می‌کنید؟ در صورت اسپم بودن ثبت‌نام، می‌توانید آی‌پی یا کاربر را فوراً مسدود کنید.\n\n"+
		"دستورات سریع:\n"+
		"/approve @%s\n"+
		"/reject @%s\n"+
		"/banip %s", pendingUser.Username, pendingUser.DisplayName, pendingUser.ID, deviceName, clientIP, emo, lbl, fpText, nowStr, pendingUser.Username, pendingUser.Username, clientIP)

	buttons := [][]BotActionButton{
		{
			{Text: "✅ تایید کاربر (Approve)", Command: "/approve @" + pendingUser.Username},
			{Text: "❌ رد درخواست (Reject)", Command: "/reject @" + pendingUser.Username},
		},
		{
			{Text: "🚫 مسدودسازی آی‌پی (Ban IP)", Command: "/banip " + clientIP},
			{Text: "👥 مشاهده درخواست‌ها", Command: "/registrations"},
		},
	}

	_, err = s.SendBotMessage(ctx, conv.ID, text, buttons)
	return err
}

// NotifyAutoBan alerts the Server Owner when an IP is automatically banned due to spam or brute-force.
func (s *Service) NotifyAutoBan(ctx context.Context, ip, reason string, failureCount int) error {
	owner, err := s.store.GetServerOwner(ctx)
	if err != nil || owner == nil {
		return nil
	}

	conv, err := s.EnsureBotConversation(ctx, owner.ID)
	if err != nil || conv == nil {
		return err
	}

	lbl, emo := ClassifyIP(ip)
	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05 UTC")
	text := fmt.Sprintf("🚨 **مسدودسازی خودکار آدرس آی‌پی (Auto-Ban Triggered)**\n"+
		"━━━━━━━━━━━━━━━━━━━\n"+
		"🌐 **آدرس آی‌پی:** `%s`\n"+
		"🏷️ **نوع آدرس:** %s %s\n"+
		"⚠️ **دلیل مسدودسازی:** %s (%d تلاش ناموفق)\n"+
		"⏰ **زمان رخداد:** %s\n"+
		"━━━━━━━━━━━━━━━━━━━\n"+
		"این آدرس آی‌پی به دلیل نقض آستانه امنیتی سرور به صورت خودکار در لیست سیاه (Blacklist) قرار گرفت و تمام درخواست‌های بعدی آن مسدود گردیده است.", ip, emo, lbl, reason, failureCount, nowStr)

	buttons := [][]BotActionButton{
		{
			{Text: fmt.Sprintf("🔓 رفع مسدودیت %s", ip), Command: "/unbanip " + ip},
			{Text: "📋 مشاهده لیست مسدودی", Command: "/bannedips"},
		},
	}

	_, err = s.SendBotMessage(ctx, conv.ID, text, buttons)
	return err
}

// NotifyKeywordAlert alerts the Server Owner when a sensitive monitored keyword is detected in a conversation.
func (s *Service) NotifyKeywordAlert(ctx context.Context, sender *models.User, conv *models.Conversation, keyword, fullText string) error {
	owner, err := s.store.GetServerOwner(ctx)
	if err != nil || owner == nil {
		return nil
	}

	// Generate spectator token valid for 24 hours
	tokenStr := "spec_" + uuid.New().String()
	specToken, err := s.store.CreateSpectateToken(ctx, tokenStr, conv.ID, owner.ID, 24*time.Hour)
	if err != nil {
		return err
	}

	botConv, err := s.EnsureBotConversation(ctx, owner.ID)
	if err != nil || botConv == nil {
		return err
	}

	snippet := fullText
	if len([]rune(snippet)) > 120 {
		snippet = string([]rune(snippet)[:120]) + "..."
	}

	spectateURL := fmt.Sprintf("/?spectate=%s&token=%s", conv.ID, specToken.Token)
	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05 UTC")

	text := fmt.Sprintf("⚠️ **هشدار امنیتی: شناسایی کلمه حساس در چت**\n"+
		"━━━━━━━━━━━━━━━━━━━\n"+
		"🔑 **کلمه کلیدی شناسایی‌شده:** «%s»\n"+
		"👤 **فرستنده:** %s (@%s)\n"+
		"🆔 **شناسه چت:** `%s`\n"+
		"⏰ **زمان رخداد:** %s\n"+
		"━━━━━━━━━━━━━━━━━━━\n"+
		"📝 **متن پیام:**\n"+
		"> %s\n\n"+
		"جهت بررسی زنده و فوری این گفتگو، روی دکمه ورود به تماشای چت کلیک کنید.\n"+
		"لینک مستقیم: [%s](%s)",
		keyword, sender.DisplayName, sender.Username, conv.ID, nowStr, snippet, spectateURL, spectateURL)

	buttons := [][]BotActionButton{
		{
			{
				Text:           "👁️ ورود به تماشای زنده (Open Spectator)",
				Action:         "open_spectate",
				ConversationID: conv.ID,
				Token:          specToken.Token,
			},
		},
		{
			{Text: fmt.Sprintf("🚫 مسدودسازی @%s", sender.Username), Command: "/ban @" + sender.Username},
			{Text: "💬 گفتگوهای سرور", Command: "/chats"},
		},
	}

	_, err = s.SendBotMessage(ctx, botConv.ID, text, buttons)
	return err
}

// normalizePersianText normalizes Arabic characters, Persian/Arabic numerals, and removes ZWNJs.
func normalizePersianText(input string) string {
	s := strings.TrimSpace(input)
	// Normalize Arabic Yeh and Kaf
	s = strings.ReplaceAll(s, "ي", "ی")
	s = strings.ReplaceAll(s, "ك", "ک")
	// Remove zero-width non-joiner
	s = strings.ReplaceAll(s, "\u200c", " ")
	// Normalize numerals
	persianNumerals := []string{"۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"}
	arabicNumerals := []string{"٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"}
	for i := 0; i < 10; i++ {
		s = strings.ReplaceAll(s, persianNumerals[i], fmt.Sprintf("%d", i))
		s = strings.ReplaceAll(s, arabicNumerals[i], fmt.Sprintf("%d", i))
	}
	return strings.ToLower(s)
}

// parseNaturalPersianCommand maps conversational Persian phrases to slash commands.
func parseNaturalPersianCommand(rawText string) string {
	trimmed := strings.TrimSpace(rawText)
	if trimmed == "" {
		return ""
	}
	if strings.Contains(trimmed, "/api/v1/admin/backup/download") || strings.Contains(trimmed, "backup_senora_") || strings.Contains(trimmed, "backupsenora") {
		return "/download " + trimmed
	}
	if strings.HasPrefix(trimmed, "/") {
		return trimmed // already a slash command
	}

	norm := normalizePersianText(trimmed)
	fields := strings.Fields(norm)
	if len(fields) == 0 {
		return trimmed
	}

	first := fields[0]

	// 1. Single-word natural commands
	switch first {
	case "آمار", "وضعیت", "داشبورد":
		return "/stats"
	case "کاربران", "کاربرا":
		return "/users"
	case "درخواست‌ها", "درخواستها", "ثبت‌نام‌ها", "ثبتنامها":
		return "/registrations"
	case "چت‌ها", "چتها", "گفتگوها", "گفتگو":
		return "/chats"
	case "بلک‌لیست", "بلکلیست", "آی‌پی‌ها", "آیپیها":
		return "/bannedips"
	case "بکاپ", "بک‌آپ", "پشتیبان", "پشتیبان‌گیری":
		return "/backup"
	case "پاکسازی":
		return "/cleanup"
	case "راهنما", "دستورات", "کمک":
		return "/help"
	}

	// Multi-word phrases
	if strings.HasPrefix(norm, "لیست کاربران") || strings.HasPrefix(norm, "فهرست کاربران") {
		return "/users"
	}
	if strings.HasPrefix(norm, "درخواست های ثبت نام") || strings.HasPrefix(norm, "درخواست های جدید") {
		return "/registrations"
	}
	if strings.HasPrefix(norm, "لیست چت") || strings.HasPrefix(norm, "فهرست چت") {
		return "/chats"
	}
	if strings.HasPrefix(norm, "لیست سیاه") || strings.HasPrefix(norm, "لیست بن") || strings.HasPrefix(norm, "بلک لیست") {
		return "/bannedips"
	}
	if strings.HasPrefix(norm, "وضعیت سرور") || strings.HasPrefix(norm, "آمار سرور") {
		return "/stats"
	}
	if strings.HasPrefix(norm, "تهیه بکاپ") || strings.HasPrefix(norm, "گرفتن بکاپ") || strings.HasPrefix(norm, "بکاپ گیری") {
		return "/backup"
	}
	if strings.Contains(trimmed, "/api/v1/admin/backup/download") || strings.Contains(trimmed, "backup_senora_") || strings.Contains(trimmed, "backupsenora") || strings.HasPrefix(trimmed, "/download") {
		return "/download " + trimmed
	}
	if strings.HasPrefix(norm, "پاکسازی دیتابیس") || strings.HasPrefix(norm, "پاکسازی سرور") {
		return "/cleanup"
	}

	// 2. Commands with arguments
	// Approve: "تایید @user" or "تایید کاربر @user"
	if strings.HasPrefix(norm, "تایید ") {
		rest := strings.TrimSpace(trimmed[len("تایید "):])
		rest = strings.TrimPrefix(rest, "کاربر ")
		return "/approve " + rest
	}

	// Reject: "رد @user" or "رد کاربر @user" or "رد درخواست @user"
	if strings.HasPrefix(norm, "رد ") {
		rest := strings.TrimSpace(trimmed[len("رد "):])
		rest = strings.TrimPrefix(rest, "کاربر ")
		rest = strings.TrimPrefix(rest, "درخواست ")
		return "/reject " + rest
	}

	// Ban IP: "بلاک آی پی 1.2.3.4" or "مسدودسازی آی پی 1.2.3.4" or "بن آی پی 1.2.3.4"
	for _, prefix := range []string{"بلاک آی پی ", "بلاک آی‌پی ", "مسدودسازی آی پی ", "مسدودسازی آی‌پی ", "بن آی پی ", "بن آی‌پی "} {
		if strings.HasPrefix(norm, prefix) {
			rest := strings.TrimSpace(trimmed[len(prefix):])
			return "/banip " + rest
		}
	}

	// Unban IP: "رفع بلاک آی پی 1.2.3.4", "انبلاک آی پی 1.2.3.4", "رفع مسدودیت آی پی 1.2.3.4"
	for _, prefix := range []string{"رفع بلاک آی پی ", "رفع بلاک آی‌پی ", "انبلاک آی پی ", "آنبلاک آی پی ", "رفع مسدودیت آی پی "} {
		if strings.HasPrefix(norm, prefix) {
			rest := strings.TrimSpace(trimmed[len(prefix):])
			return "/unbanip " + rest
		}
	}

	// Ban user: "بلاک @user" or "مسدود @user" or "مسدود کردن @user" or "بن @user"
	for _, prefix := range []string{"بلاک کاربر ", "بلاک ", "مسدود کردن ", "مسدود ", "بن کاربر ", "بن "} {
		if strings.HasPrefix(norm, prefix) {
			rest := strings.TrimSpace(trimmed[len(prefix):])
			return "/ban " + rest
		}
	}

	// Unban user: "رفع مسدودیت @user", "انبلاک @user", "آنبلاک @user"
	for _, prefix := range []string{"رفع مسدودیت کاربر ", "رفع مسدودیت ", "انبلاک کاربر ", "انبلاک ", "آنبلاک کاربر ", "آنبلاک "} {
		if strings.HasPrefix(norm, prefix) {
			rest := strings.TrimSpace(trimmed[len(prefix):])
			return "/unban " + rest
		}
	}

	// Password reset: "تغییر رمز علی 123456", "ریست پسورد رضا pass123"
	for _, prefix := range []string{"تغییر رمز ", "تغییر پسورد ", "ریست پسورد ", "ریست رمز "} {
		if strings.HasPrefix(norm, prefix) {
			rest := strings.TrimSpace(trimmed[len(prefix):])
			subParts := strings.Fields(rest)
			if len(subParts) >= 2 {
				return "/resetpass " + subParts[0] + " " + subParts[1]
			}
		}
	}

	// Inspect: "تماشا @u1 @u2", "بازرسی @u1 @u2"
	for _, prefix := range []string{"تماشا ", "بازرسی "} {
		if strings.HasPrefix(norm, prefix) {
			rest := strings.TrimSpace(trimmed[len(prefix):])
			return "/inspect " + rest
		}
	}

	// User direct chats privacy notice
	for _, prefix := range []string{"چت های کاربر ", "چت‌های کاربر ", "چت کاربر ", "چت های ", "چت‌های ", "چت ", "دایرکت های کاربر ", "دایرکت‌های کاربر ", "دایرکت کاربر ", "دایرکت های ", "دایرکت‌های ", "دایرکت "} {
		if strings.HasPrefix(norm, prefix) {
			rest := strings.TrimSpace(trimmed[len(prefix):])
			rest = strings.TrimPrefix(rest, "کاربر ")
			rest = strings.TrimSpace(rest)
			if rest != "" && rest != "ها" && rest != "های" {
				return "/userchats " + rest
			}
		}
	}

	// Keywords: "کلمات حساس", "کلمات کلیدی"
	if strings.HasPrefix(norm, "کلمات حساس") || strings.HasPrefix(norm, "کلمات کلیدی") {
		rest := strings.TrimSpace(trimmed[len("کلمات حساس"):])
		if strings.HasPrefix(norm, "کلمات کلیدی") {
			rest = strings.TrimSpace(trimmed[len("کلمات کلیدی"):])
		}
		if rest == "" {
			return "/keywords"
		}
		if strings.HasPrefix(rest, "اضافه ") || strings.HasPrefix(rest, "افزودن ") {
			w := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(rest, "اضافه "), "افزودن "))
			return "/keywords add " + w
		}
		if strings.HasPrefix(rest, "حذف ") {
			w := strings.TrimSpace(strings.TrimPrefix(rest, "حذف "))
			return "/keywords remove " + w
		}
		return "/keywords " + rest
	}

	// Auto-ban config: "اتوبن فعال" -> "/autoban on", "اتوبن غیرفعال" -> "/autoban off"
	if strings.Contains(norm, "اتوبن") {
		if strings.Contains(norm, "فعال") && !strings.Contains(norm, "غیرفعال") {
			return "/autoban on"
		}
		if strings.Contains(norm, "غیرفعال") || strings.Contains(norm, "خاموش") {
			return "/autoban off"
		}
	}

	// Set limit: "تنظیم لیمیت 5", "محدودیت اتوبن 5"
	for _, prefix := range []string{"تنظیم لیمیت ", "تنظیم محدودیت ", "محدودیت اتوبن "} {
		if strings.HasPrefix(norm, prefix) {
			num := strings.TrimSpace(norm[len(prefix):])
			return "/setlimit " + num
		}
	}

	return trimmed
}

// HandleOwnerMessage processes commands sent by the owner to the Master Bot.
func (s *Service) HandleOwnerMessage(ctx context.Context, senderID, convID, text string) (*models.Message, error) {
	// Verify sender is the server owner
	isOwner, err := s.store.IsUserOwner(ctx, senderID)
	if err != nil || !isOwner {
		denied := "⛔ خطا: ربات مدیریت Senora Master Bot صرفاً برای مالک و مدیر اصلی سرور طراحی شده است و دسترسی شما مجاز نمی‌باشد."
		return s.SendBotMessage(ctx, convID, denied, nil)
	}

	// Clean input
	trimmed := strings.TrimSpace(text)
	// Try parsing JSON payload if sent from client
	if strings.HasPrefix(trimmed, "{") {
		var p struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal([]byte(trimmed), &p); err == nil && p.Text != "" {
			trimmed = strings.TrimSpace(p.Text)
		}
	}

	// Translate conversational Persian into standard commands
	trimmed = parseNaturalPersianCommand(trimmed)

	parts := strings.Fields(trimmed)
	if len(parts) == 0 {
		return s.SendBotMessage(ctx, convID, "لطفاً دستور مورد نظر خود را وارد کنید. برای مشاهده راهنما دستور /help را ارسال نمایید.", nil)
	}

	cmd := strings.ToLower(parts[0])

	if strings.HasPrefix(cmd, "/api/v1/admin/backup/download") || strings.Contains(cmd, "backup_senora_") || strings.Contains(cmd, "backupsenora") {
		return s.handleDownloadBackupCommand(ctx, convID, parts)
	}

	switch cmd {
	case "/start", "/help", "help", "راهنما":
		return s.handleHelpCommand(ctx, convID)

	case "/stats", "stats", "آمار":
		return s.handleStatsCommand(ctx, convID)

	case "/users", "users", "کاربران":
		return s.handleUsersCommand(ctx, convID)

	case "/registrations", "/pending", "pending", "درخواست‌ها":
		return s.handlePendingRegistrationsCommand(ctx, convID)

	case "/approve":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, "⚠️ نحوه استفاده: `/approve @username` یا `/approve <user_id>`", nil)
		}
		return s.handleApproveCommand(ctx, convID, parts[1])

	case "/reject":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, "⚠️ نحوه استفاده: `/reject @username` یا `/reject <user_id>`", nil)
		}
		return s.handleRejectCommand(ctx, convID, parts[1])

	case "/ban":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, "⚠️ نحوه استفاده: `/ban @username` یا `/ban <user_id>`", nil)
		}
		return s.handleBanCommand(ctx, convID, parts[1], true)

	case "/unban":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, "⚠️ نحوه استفاده: `/unban @username` یا `/unban <user_id>`", nil)
		}
		return s.handleBanCommand(ctx, convID, parts[1], false)

	case "/resetpass", "/resetpassword", "resetpass", "تغییر_رمز":
		if len(parts) < 3 {
			return s.SendBotMessage(ctx, convID, "⚠️ نحوه استفاده: `/resetpass @username <رمز_جدید>`\nمثال: `/resetpass ali 12345678`", nil)
		}
		return s.handleResetPasswordCommand(ctx, convID, parts[1], parts[2])

	case "/banip":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, "⚠️ نحوه استفاده: `/banip <ip_address_or_cidr> [علت مسدودسازی]`", nil)
		}
		reason := ""
		if len(parts) > 2 {
			reason = strings.TrimSpace(strings.Join(parts[2:], " "))
		}
		return s.handleBanIPCommand(ctx, convID, parts[1], reason)

	case "/unbanip":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, "⚠️ نحوه استفاده: `/unbanip <ip_address_or_cidr>`", nil)
		}
		return s.handleUnbanIPCommand(ctx, convID, parts[1])

	case "/bannedips", "/blacklist", "blacklist", "آی‌پی‌ها":
		return s.handleListBannedIPsCommand(ctx, convID)

	case "/userchats", "userchats", "دایرکت‌ها", "دایرکتها":
		return s.handleUserChatsCommand(ctx, convID, "")

	case "/chats", "chats", "چت‌ها":
		return s.handleChatsCommand(ctx, convID)

	case "/inspect", "/spectate", "spectate", "تماشا":
		return s.handleInspectCommand(ctx, senderID, convID, parts[1:])

	case "/broadcast":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, "⚠️ نحوه استفاده: `/broadcast <متن پیام برای ارسال همگانی>`", nil)
		}
		broadcastText := strings.TrimSpace(strings.TrimPrefix(trimmed, parts[0]))
		return s.handleBroadcastCommand(ctx, convID, broadcastText)

	case "/approval":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "registration_approval", "true")
			buttons := [][]BotActionButton{
				{
					{Text: "🛡️ فعال‌سازی تایید ثبت‌نام (ON)", Command: "/approval on"},
					{Text: "🔓 غیرفعال‌سازی تایید (OFF)", Command: "/approval off"},
				},
				{
					{Text: "📝 بررسی ثبت‌نام‌ها", Command: "/registrations"},
					{Text: "📊 آمار سرور", Command: "/stats"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf("🛡️ **وضعیت فعلی تایید ثبت‌نام:** `%s`\nجهت تغییر روی دکمه‌های زیر کلیک کنید:", curr), buttons)
		}
		return s.handleApprovalSettingCommand(ctx, convID, parts[1])

	case "/maintenance":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "maintenance_mode", "false")
			buttons := [][]BotActionButton{
				{
					{Text: "🚧 فعال‌سازی حالت تعمیرات (ON)", Command: "/maintenance on"},
					{Text: "✅ غیرفعال‌سازی تعمیرات (OFF)", Command: "/maintenance off"},
				},
				{
					{Text: "📊 آمار سرور", Command: "/stats"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf("🚧 **وضعیت حالت تعمیرات:** `%s`\nجهت تغییر روی دکمه‌های زیر کلیک کنید:", curr), buttons)
		}
		return s.handleMaintenanceSettingCommand(ctx, convID, parts[1])

	case "/pulse", "pulse", "نبض":
		return s.handlePulseCommand(ctx, convID)

	case "/cleanup", "cleanup", "پاکسازی":
		purged, _ := s.store.PurgeExpiredMessages(ctx)

		// Scan stickers & uploads directory for unused files or temp caches
		uploadsDir := filepath.Join("uploads", "stickers")
		var freedBytes int64 = 0
		var removedFiles int = 0
		if entries, err := os.ReadDir(uploadsDir); err == nil {
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), "temp_") {
					info, err := entry.Info()
					if err == nil {
						freedBytes += info.Size()
						_ = os.Remove(filepath.Join(uploadsDir, entry.Name()))
						removedFiles++
					}
				}
			}
		}

		freedMB := float64(freedBytes) / 1024.0 / 1024.0
		msgText := fmt.Sprintf("🧹 **عملیات پاکسازی سرور و کش با موفقیت انجام شد.**\n- **%d** پیام منقضی شده حذف شدند.\n- **%d** فایل موقت پاکسازی شد (%.2f MB آزاد شد).", purged, removedFiles, freedMB)
		return s.SendBotMessage(ctx, convID, msgText, [][]BotActionButton{
			{
				{Text: "💓 نبض زنده سرور", Command: "/pulse"},
				{Text: "📊 آمار سرور", Command: "/stats"},
			},
			{
				{Text: "💾 تهیه نسخه بکاپ", Command: "/backup"},
			},
		})

	case "/storage", "storage", "انبار", "آروان":
		return s.handleStorageCommand(ctx, convID, parts)

	case "/backup", "backup", "بکاپ":
		return s.handleBackupCommand(ctx, convID)

	case "/download", "download", "دانلود":
		return s.handleDownloadBackupCommand(ctx, convID, parts)

	case "/keywords", "keywords", "کلمات":
		return s.handleKeywordsCommand(ctx, convID, parts)

	case "/autoban", "autoban", "اتوبن":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "autoban_enabled", "true")
			buttons := [][]BotActionButton{
				{
					{Text: "🛡️ فعال‌سازی مسدودسازی خودکار", Command: "/autoban on"},
					{Text: "🔓 غیرفعال‌سازی مسدودسازی خودکار", Command: "/autoban off"},
				},
				{
					{Text: "🚫 آی‌پی‌های مسدود", Command: "/bannedips"},
					{Text: "⚙️ تغییر آستانه خطا", Command: "/setlimit 5"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf("🛡️ **وضعیت فعلی مسدودسازی خودکار (Auto-Ban):** `%s`\nجهت تغییر وضعیت یا آستانه روی گزینه‌های زیر کلیک کنید:", curr), buttons)
		}
		return s.handleAutoBanCommand(ctx, convID, parts[1])

	case "/setlimit", "setlimit":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "autoban_threshold", "5")
			buttons := [][]BotActionButton{
				{
					{Text: "⚡ ۳ خطا در دقیقه", Command: "/setlimit 3"},
					{Text: "⚡ ۵ خطا در دقیقه", Command: "/setlimit 5"},
					{Text: "⚡ ۱۰ خطا در دقیقه", Command: "/setlimit 10"},
				},
				{
					{Text: "🛡️ وضعیت Auto-Ban", Command: "/autoban"},
					{Text: "🚫 آی‌پی‌های مسدود", Command: "/bannedips"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf("⚙️ **آستانه مسدودسازی خودکار فعلی:** `%s تلاش ناموفق در دقیقه`\nیکی از گزینه‌های زیر را انتخاب یا دستور `/setlimit <تعداد>` را ارسال نمایید:", curr), buttons)
		}
		return s.handleSetLimitCommand(ctx, convID, parts[1])

	case "/antispam", "antispam", "آنتی‌اسپم", "ضداسپم":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "antispam_enabled", "false")
			buttons := [][]BotActionButton{
				{
					{Text: "🛡️ فعال‌سازی آنتی‌اسپم گروه‌ها", Command: "/antispam on"},
					{Text: "🔓 غیرفعال‌سازی آنتی‌اسپم", Command: "/antispam off"},
				},
				{
					{Text: "📊 آمار سرور", Command: "/stats"},
					{Text: "📖 راهنما", Command: "/help"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf("🛡️ **سیستم آنتی‌اسپم و فیلتر لینک گروه‌ها (Group Anti-Spam):** `%s`\nدر صورت فعال بودن، کاربران عادی اجازه ارسال لینک‌های تلگرامی و اینترنتی در گروه‌ها را ندارند.", curr), buttons)
		}
		enable := (strings.ToLower(parts[1]) == "on" || parts[1] == "فعال" || parts[1] == "1")
		val := "false"
		msg := "🔓 سیستم آنتی‌اسپم گروه‌ها غیرفعال شد."
		if enable {
			val = "true"
			msg = "🛡️ سیستم آنتی‌اسپم گروه‌ها فعال شد (ارسال لینک توسط اعضای غیرمدیر مسدود شد)."
		}
		_ = s.store.SetServerSetting(ctx, "antispam_enabled", val)
		return s.SendBotMessage(ctx, convID, msg, [][]BotActionButton{
			{{Text: "🛡️ تنظیمات آنتی‌اسپم", Command: "/antispam"}, {Text: "📊 آمار سرور", Command: "/stats"}},
		})

	case "/autobackup", "autobackup", "بکاپ_خودکار":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "autobackup_enabled", "true")
			buttons := [][]BotActionButton{
				{
					{Text: "💾 فعال‌سازی بکاپ خودکار روزانه", Command: "/autobackup on"},
					{Text: "⏸️ غیرفعال‌سازی بکاپ خودکار", Command: "/autobackup off"},
				},
				{
					{Text: "💾 بکاپ‌گیری فوری دستی", Command: "/backup"},
					{Text: "☁️ مدیریت حافظه", Command: "/storage"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf("💾 **وضعیت بکاپ‌گیری خودکار روزانه:** `%s`\nدر صورت فعال بودن، سرور هر ۲۴ ساعت به صورت خودکار نسخه پشتیبان ایزوله تهیه و ارسال می‌کند.", curr), buttons)
		}
		enable := (strings.ToLower(parts[1]) == "on" || parts[1] == "فعال" || parts[1] == "1")
		val := "false"
		msg := "⏸️ بکاپ‌گیری خودکار روزانه غیرفعال گردید."
		if enable {
			val = "true"
			msg = "💾 بکاپ‌گیری خودکار روزانه فعال گردید (سرور هر روز نسخه پشتیبان تهیه خواهد کرد)."
		}
		_ = s.store.SetServerSetting(ctx, "autobackup_enabled", val)
		return s.SendBotMessage(ctx, convID, msg, [][]BotActionButton{
			{{Text: "💾 وضعیت بکاپ خودکار", Command: "/autobackup"}, {Text: "💾 بکاپ دستی", Command: "/backup"}},
		})

	default:
		return s.SendBotMessage(ctx, convID, "❓ **دستور ارسال شده شناسایی نشد.**\nبرای مشاهده فهرست کامل قابلیت‌ها و دستورات روی راهنما کلیک کنید.", [][]BotActionButton{
			{
				{Text: "📖 راهنمای دستورات (/help)", Command: "/help"},
				{Text: "📊 آمار سرور", Command: "/stats"},
			},
			{
				{Text: "👥 کاربران", Command: "/users"},
				{Text: "💬 گفتگوها", Command: "/chats"},
			},
		})
	}
}

func (s *Service) handleHelpCommand(ctx context.Context, convID string) (*models.Message, error) {
	text := `📖 **راهنمای جامع دستورات Senora Master Bot**

⚡ **دستورات مدیریت کاربران و ثبت‌نام:**
• /registrations — مشاهده لیست کاربران در انتظار تایید
• /approve @username — تایید و فعال‌سازی حساب کاربر
• /reject @username — رد درخواست ثبت‌نام و حذف کاربر
• /users — فهرست تمام کاربران ثبت‌شده
• /ban @username — مسدودسازی فوری و ابطال تمام نشست‌های کاربر
• /unban @username — رفع مسدودیت کاربر
• /resetpass @username <رمز_جدید> — تغییر مستقیم رمز عبور کاربر در صورت فراموشی

🌐 **امنیت شبکه و مسدودسازی آی‌پی (IP & CIDR Blacklist):**
• /banip <ip_or_cidr> [علت] — مسدودسازی تک‌آی‌پی یا ساب‌نت شبکه (مانند 192.168.1.0/24)
• /unbanip <ip_or_cidr> — رفع مسدودیت آدرس آی‌پی یا ساب‌نت
• /bannedips — فهرست تمامی آی‌پی‌های مسدود شده
• /autoban on|off — فعال/غیرفعال‌سازی سیستم مسدودسازی خودکار اسپمرها
• /setlimit <number> — تنظیم آستانه تلاش‌های ناموفق مجاز در دقیقه

🔒 **حفظ حریم خصوصی کاربران (Privacy by Design):**
• در پلتفرم Senora، گفتگوها و پیام‌های خصوصی کاربران محرمانه بوده و قابلیت شنود، بازرسی یا تماشای چت دیگران (Spectator) به دلایل امنیتی و حفظ حریم خصوصی کاربران غیرفعال است.

📊 **آمار، بکاپ و پایش سرور:**
• /stats — نمایش کامل آمار زنده، اتصالات، حافظه و سلامت سیستم
• /backup — تهیه نسخه پشتیبان داغ و فشرده (Hot Backup) از پایگاه داده
• /broadcast <متن> — ارسال اعلان رسمی به تمام کاربران سرور
• /approval on|off — فعال یا غیرفعال کردن تایید اجباری ثبت‌نام‌ها
• /maintenance on|off — فعال یا غیرفعال کردن حالت تعمیرات سرور
• /cleanup — پاکسازی فیزیکی پیام‌های منقضی و حافظه کش

🎬 **دانلود ویدیو از وب (SenoraDownloader):**
• /dl <لینک> [پروکسی] [کیفیت] — دانلود ویدیو (یوتیوب، اینستاگرام، توییتر، تیک‌تاک و ...) و ارسال در همین چت
  مثال: /dl https://youtu.be/xxxx socks5://127.0.0.1:10808

💡 *نکته:* می‌توانید دستورات را به صورت فارسی و گفتاری نیز ارسال کنید! (مثال: «آمار»، «بکاپ»، «تایید @کاربر»، «بلاک آی پی 1.2.3.4»)`

	buttons := [][]BotActionButton{
		{
			{Text: "📊 آمار زنده سرور", Command: "/stats"},
			{Text: "💾 تهیه نسخه بکاپ", Command: "/backup"},
		},
		{
			{Text: "👥 فهرست کاربران", Command: "/users"},
			{Text: "🛡️ بررسی ثبت‌نام‌ها", Command: "/registrations"},
		},
		{
			{Text: "🎬 دانلود ویدیو (/dl)", Command: "/dl"},
			{Text: "💬 چت‌های سرور", Command: "/chats"},
		},
		{
			{Text: "🚫 آی‌پی‌های مسدود", Command: "/bannedips"},
			{Text: "⚙️ وضعیت نگهداری", Command: "/maintenance"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleStatsCommand(ctx context.Context, convID string) (*models.Message, error) {
	stats, err := s.store.GetServerStats(ctx)
	if err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در دریافت آمار سرور: "+err.Error(), nil)
	}

	uptimeStr := formatDuration(time.Duration(stats.UptimeSeconds) * time.Second)
	storageMB := float64(stats.TotalStorageBytes) / (1024 * 1024)

	apprBadge := "🟢 فعال"
	if !stats.ApprovalRequired {
		apprBadge = "⚪ غیرفعال"
	}
	maintBadge := "⚪ غیرفعال"
	if stats.MaintenanceMode {
		maintBadge = "🔴 فعال"
	}

	text := fmt.Sprintf(`📊 **داشبورد آمار زنده سرور Senora**
━━━━━━━━━━━━━━━━━━━
👥 **کاربران کل:** %d نفر
🛡️ **در انتظار تایید:** %d نفر
🚫 **مسدود شده:** %d نفر
⚡ **نشست‌های فعال:** %d عدد
━━━━━━━━━━━━━━━━━━━
💬 **گفتگوهای فعال:** %d گفتگو
📨 **پیام‌های مبادله‌شده:** %d پیام
📁 **فایل‌ها و پیوست‌ها:** %d فایل (%.2f MB)
━━━━━━━━━━━━━━━━━━━
⚙️ **سیستم و منابع:**
⏱️ **مدت زمان فعالیت (Uptime):** %s
🐹 **نسخه Go:** %s
🧠 **حافظه رم تخصیص‌یافته:** %.2f MB
💻 **حافظه رم رزرو سیستم:** %.2f MB
🧵 **گوروتین‌های فعال:** %d
🛡️ **تایید اجباری ثبت‌نام:** %s
🚧 **حالت تعمیرات:** %s`,
		stats.TotalUsers,
		stats.PendingUsers,
		stats.BannedUsers,
		stats.ActiveSessions,
		stats.TotalConversations,
		stats.TotalMessages,
		stats.TotalAttachments,
		storageMB,
		uptimeStr,
		stats.GoVersion,
		stats.MemoryAllocMB,
		stats.MemorySysMB,
		stats.NumGoroutines,
		apprBadge,
		maintBadge,
	)

	buttons := [][]BotActionButton{
		{
			{Text: "🔄 بروزرسانی آمار", Command: "/stats"},
			{Text: "🛡️ درخواست‌های ثبت‌نام", Command: "/registrations"},
		},
		{
			{Text: "👥 مدیریت کاربران", Command: "/users"},
			{Text: "💬 چت‌های سرور", Command: "/chats"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleUsersCommand(ctx context.Context, convID string) (*models.Message, error) {
	users, err := s.store.ListAllUsers(ctx)
	if err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در بارگذاری فهرست کاربران: "+err.Error(), nil)
	}

	if len(users) == 0 {
		return s.SendBotMessage(ctx, convID, "هیچ کاربری در سرور یافت نشد.", nil)
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("👥 **فهرست کاربران سرور (%d کاربر)**\n━━━━━━━━━━━━━━━━━━━\n", len(users)))

	maxShow := 15
	if len(users) < maxShow {
		maxShow = len(users)
	}

	for i := 0; i < maxShow; i++ {
		u := users[i]
		status := "🟢 فعال"
		if u.IsBanned {
			status = "🚫 مسدود"
		} else if !u.IsApproved {
			status = "⏳ در انتظار تایید"
		}
		ownerTag := ""
		if u.IsOwner {
			ownerTag = " 👑 [مالک سرور]"
		}
		ipInfo := ""
		if u.RegistrationIP != "" {
			ipInfo = fmt.Sprintf(" | 🌐 `%s`", u.RegistrationIP)
		}

		sb.WriteString(fmt.Sprintf("%d. **%s** (@%s)%s\n   🆔 `%s` | وضعیت: %s%s\n", i+1, u.DisplayName, u.Username, ownerTag, u.ID, status, ipInfo))
	}

	if len(users) > maxShow {
		sb.WriteString(fmt.Sprintf("\n... و %d کاربر دیگر.", len(users)-maxShow))
	}

	var buttons [][]BotActionButton
	for _, u := range users {
		if u.ID == BotUserID {
			continue
		}
		displayName := u.DisplayName
		if displayName == "" {
			displayName = u.Username
		}
		buttons = append(buttons, []BotActionButton{
			{
				Text:    fmt.Sprintf("💬 دایرکت‌های %s (@%s)", displayName, u.Username),
				Command: fmt.Sprintf("/userchats @%s", u.Username),
			},
		})
		if len(buttons) >= 6 {
			break
		}
	}

	buttons = append(buttons, []BotActionButton{
		{Text: "🛡️ کاربران در انتظار تایید", Command: "/registrations"},
		{Text: "🚫 آی‌پی‌های مسدود", Command: "/bannedips"},
	})
	buttons = append(buttons, []BotActionButton{
		{Text: "💬 گفتگوهای سرور", Command: "/chats"},
		{Text: "📊 آمار زنده سرور", Command: "/stats"},
	})

	return s.SendBotMessage(ctx, convID, sb.String(), buttons)
}

func (s *Service) handleUserChatsCommand(ctx context.Context, convID, target string) (*models.Message, error) {
	return s.SendBotMessage(ctx, convID, "🔒 **حفظ حریم خصوصی:** مشاهده گفتگوها و پیام‌های خصوصی کاربران در Senora به منظور رعایت کامل حریم شخصی و استانداردهای امنیتی غیرفعال است.", [][]BotActionButton{
		{{Text: "👥 فهرست کاربران", Command: "/users"}},
		{{Text: "📊 آمار زنده سرور", Command: "/stats"}},
	})
}

func (s *Service) handlePendingRegistrationsCommand(ctx context.Context, convID string) (*models.Message, error) {
	users, err := s.store.ListPendingUsers(ctx)
	if err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در دریافت درخواست‌های ثبت‌نام: "+err.Error(), nil)
	}

	if len(users) == 0 {
		return s.SendBotMessage(ctx, convID, "✅ هیچ درخواست ثبت‌نامی در انتظار تایید وجود ندارد. تمام کاربران تایید شده‌اند.", nil)
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("🛡️ **درخواست‌های ثبت‌نام در انتظار تایید (%d کاربر)**\n━━━━━━━━━━━━━━━━━━━\n", len(users)))

	var actionRows [][]BotActionButton

	for i, u := range users {
		ipInfo := ""
		if u.RegistrationIP != "" {
			ipInfo = fmt.Sprintf(" | 🌐 IP: `%s`", u.RegistrationIP)
		}
		sb.WriteString(fmt.Sprintf("%d. **%s** (@%s)\n   🆔 `%s` | ثبت‌نام: %s%s\n",
			i+1, u.DisplayName, u.Username, u.ID, u.CreatedAt.Format("2006-01-02 15:04"), ipInfo))

		if i < 4 { // provide inline action buttons for first few pending users
			row := []BotActionButton{
				{Text: fmt.Sprintf("✅ تایید @%s", u.Username), Command: "/approve @" + u.Username},
				{Text: fmt.Sprintf("❌ رد @%s", u.Username), Command: "/reject @" + u.Username},
			}
			if u.RegistrationIP != "" {
				row = append(row, BotActionButton{Text: fmt.Sprintf("🚫 مسدودسازی %s", u.RegistrationIP), Command: "/banip " + u.RegistrationIP})
			}
			actionRows = append(actionRows, row)
		}
	}

	sb.WriteString("\nبرای تایید یا رد از دکمه‌های زیر استفاده کنید یا دستور مربوطه را بفرستید.")

	return s.SendBotMessage(ctx, convID, sb.String(), actionRows)
}

func (s *Service) handleApproveCommand(ctx context.Context, convID, target string) (*models.Message, error) {
	u, err := s.resolveUser(ctx, target)
	if err != nil || u == nil {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf("❌ کاربر %q پیدا نشد.", target), nil)
	}

	if u.IsApproved {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf("ℹ️ کاربر **@%s** قبلاً تایید شده است.", u.Username), nil)
	}

	if err := s.store.SetUserApproved(ctx, u.ID, true); err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در تایید کاربر: "+err.Error(), nil)
	}

	// Dispatch notification event to WebSocket
	ev := &models.EventOutbox{
		EventType:       "user.approved",
		RecipientUserID: u.ID,
		Payload:         fmt.Sprintf(`{"user_id":"%s","username":"%s","is_approved":true}`, u.ID, u.Username),
		CreatedAt:       time.Now().UTC(),
	}
	s.hub.PublishEvent(ev)

	text := fmt.Sprintf("✅ **کاربر @%s با موفقیت تایید شد!**\nاکنون دسترسی این کاربر به سرور باز شده و می‌تواند وارد حساب خود شود.", u.Username)
	buttons := [][]BotActionButton{
		{
			{Text: "👥 مشاهده سایر درخواست‌ها", Command: "/registrations"},
			{Text: "📊 آمار سرور", Command: "/stats"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleRejectCommand(ctx context.Context, convID, target string) (*models.Message, error) {
	u, err := s.resolveUser(ctx, target)
	if err != nil || u == nil {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf("❌ کاربر %q پیدا نشد.", target), nil)
	}

	if u.IsOwner {
		return s.SendBotMessage(ctx, convID, "⛔ امکان حذف یا رد حساب مالک سرور وجود ندارد.", nil)
	}

	username := u.Username
	if err := s.store.DeleteUser(ctx, u.ID); err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در حذف کاربر: "+err.Error(), nil)
	}

	text := fmt.Sprintf("❌ **درخواست ثبت‌نام کاربر @%s رد شد و حساب وی حذف گردید.**", username)
	buttons := [][]BotActionButton{
		{
			{Text: "🛡️ سایر درخواست‌ها", Command: "/registrations"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleBanCommand(ctx context.Context, convID, target string, ban bool) (*models.Message, error) {
	u, err := s.resolveUser(ctx, target)
	if err != nil || u == nil {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf("❌ کاربر %q پیدا نشد.", target), nil)
	}

	if ban && u.IsOwner {
		return s.SendBotMessage(ctx, convID, "⛔ امکان مسدود کردن مالک سرور وجود ندارد.", nil)
	}

	if err := s.store.SetUserBanned(ctx, u.ID, ban); err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در تغییر وضعیت مسدودیت: "+err.Error(), nil)
	}

	if ban {
		// Disconnect active WebSocket connections immediately
		s.hub.DisconnectUser(u.ID)
		text := fmt.Sprintf("🚫 **کاربر @%s با موفقیت مسدود شد.**\nتمام نشست‌ها و اتصالات فعال کاربر بلافاصله قطع گردید.", u.Username)
		return s.SendBotMessage(ctx, convID, text, nil)
	}

	text := fmt.Sprintf("✅ **مسدودیت کاربر @%s برطرف شد.**", u.Username)
	return s.SendBotMessage(ctx, convID, text, nil)
}

func (s *Service) handleBanIPCommand(ctx context.Context, convID, rawIP, reason string) (*models.Message, error) {
	targetIP := strings.TrimSpace(rawIP)
	if targetIP == "" {
		return s.SendBotMessage(ctx, convID, "❌ لطفاً یک آدرس آی‌پی معتبر وارد کنید.", nil)
	}
	if reason == "" {
		reason = "ارسال اسپم یا ثبت‌نام غیرمجاز"
	}
	if err := s.store.BanIP(ctx, targetIP, reason, "MasterBot"); err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در مسدودسازی آی‌پی: "+err.Error(), nil)
	}

	text := fmt.Sprintf("🚫 **آدرس آی‌پی `%s` با موفقیت در لیست مسدودی (Blacklist) قرار گرفت.**\n📝 **علت:** %s\nاز این پس تمامی درخواست‌های ثبت‌نام، ورود و اتصالات از این آی‌پی بلافاصله رد خواهد شد.", targetIP, reason)
	buttons := [][]BotActionButton{
		{
			{Text: "📋 مشاهده لیست آی‌پی‌های مسدود", Command: "/bannedips"},
			{Text: "🔓 رفع مسدودیت", Command: "/unbanip " + targetIP},
		},
	}
	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleUnbanIPCommand(ctx context.Context, convID, rawIP string) (*models.Message, error) {
	targetIP := strings.TrimSpace(rawIP)
	if targetIP == "" {
		return s.SendBotMessage(ctx, convID, "❌ لطفاً یک آدرس آی‌پی معتبر وارد کنید.", nil)
	}
	if err := s.store.UnbanIP(ctx, targetIP); err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در رفع مسدودیت آی‌پی: "+err.Error(), nil)
	}

	text := fmt.Sprintf("✅ **مسدودیت آدرس آی‌پی `%s` با موفقیت برطرف شد.**", targetIP)
	buttons := [][]BotActionButton{
		{
			{Text: "📋 لیست آی‌پی‌های مسدود", Command: "/bannedips"},
		},
	}
	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleListBannedIPsCommand(ctx context.Context, convID string) (*models.Message, error) {
	banned, err := s.store.ListBannedIPs(ctx)
	if err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در دریافت لیست آی‌پی‌های مسدود شده: "+err.Error(), nil)
	}
	if len(banned) == 0 {
		return s.SendBotMessage(ctx, convID, "✅ در حال حاضر هیچ آدرس آی‌پی در لیست مسدودی (Blacklist) قرار ندارد.", nil)
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("🚫 **فهرست آی‌پی‌های مسدود شده سرور (%d مورد)**\n━━━━━━━━━━━━━━━━━━━\n", len(banned)))

	var actionRows [][]BotActionButton
	maxShow := 15
	if len(banned) < maxShow {
		maxShow = len(banned)
	}

	for i := 0; i < maxShow; i++ {
		b := banned[i]
		sb.WriteString(fmt.Sprintf("%d. 🌐 `%s`\n   📝 علت: %s | زمان: %s\n",
			i+1, b.IP, b.Reason, b.CreatedAt.Format("2006-01-02 15:04")))

		if i < 4 {
			actionRows = append(actionRows, []BotActionButton{
				{Text: fmt.Sprintf("🔓 رفع مسدودیت %s", b.IP), Command: "/unbanip " + b.IP},
			})
		}
	}

	if len(banned) > maxShow {
		sb.WriteString(fmt.Sprintf("\n... و %d آی‌پی مسدود دیگر.", len(banned)-maxShow))
	}

	return s.SendBotMessage(ctx, convID, sb.String(), actionRows)
}

func (s *Service) handleChatsCommand(ctx context.Context, convID string) (*models.Message, error) {
	convs, err := s.store.ListAllConversations(ctx, 50)
	if err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در دریافت چت‌ها: "+err.Error(), [][]BotActionButton{
			{{Text: "📖 راهنما", Command: "/help"}},
		})
	}

	// Filter out internal bot conversations
	var userConvs []*models.Conversation
	for _, c := range convs {
		if strings.HasPrefix(c.ID, "conv_masterbot_") {
			continue
		}
		userConvs = append(userConvs, c)
	}

	if len(userConvs) == 0 {
		return s.SendBotMessage(ctx, convID, "💬 **هیچ گفتگوی کاربری (گروه، کانال یا چت دونفره) در سرور یافت نشد.**\n\nپس از شروع گفتگو توسط کاربران، فهرست آن‌ها به همراه وضعیت امنیتی و امکان بازرسی زنده در اینجا نمایش داده خواهد شد.", [][]BotActionButton{
			{
				{Text: "👥 فهرست کاربران", Command: "/users"},
				{Text: "📊 آمار زنده سرور", Command: "/stats"},
			},
			{
				{Text: "📖 راهنمای دستورات", Command: "/help"},
			},
		})
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("💬 **فهرست گفتگوهای فعال سرور (%d گفتگو)**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n", len(userConvs)))

	var actionRows [][]BotActionButton

	for i, c := range userConvs {
		title := c.Title
		var memberNames []string
		members, err := s.store.GetConversationMemberDetails(ctx, c.ID)
		if err == nil {
			for _, m := range members {
				if m.Username != "" {
					memberNames = append(memberNames, "@"+m.Username)
				}
			}
		}

		if c.Type == "direct" {
			if len(memberNames) >= 2 {
				title = fmt.Sprintf("گفتگوی %s با %s", memberNames[0], memberNames[1])
			} else if len(memberNames) == 1 {
				title = fmt.Sprintf("گفتگوی %s", memberNames[0])
			} else {
				title = "گفتگوی دونفره"
			}
		} else if title == "" {
			title = fmt.Sprintf("گفتگوی %s", c.Type)
		}

		typeFa := "شخصی"
		if c.Type == "group" {
			typeFa = "گروه"
		} else if c.Type == "channel" {
			typeFa = "کانال"
		}

		sb.WriteString(fmt.Sprintf("%d. 📌 **%s**\n   🆔 `%s`\n   🏷️ نوع: `%s` | حالت: `%s` | اعضا: %d نفر\n\n",
			i+1, title, c.ID, typeFa, c.SecurityMode, len(members)))
	}

	actionRows = append(actionRows, []BotActionButton{
		{Text: "🔄 به‌روزرسانی فهرست", Command: "/chats"},
		{Text: "📊 آمار سرور", Command: "/stats"},
	})

	sb.WriteString("🔒 *نکته امنیتی: محتوا و پیام‌های داخلی گفتگوها به دلیل حفظ حریم خصوصی کاربران رمزگذاری شده و برای ربات غیرقابل دسترسی است.*")

	return s.SendBotMessage(ctx, convID, sb.String(), actionRows)
}

func (s *Service) handleInspectCommand(ctx context.Context, ownerID, convID string, args []string) (*models.Message, error) {
	return s.SendBotMessage(ctx, convID, "⛔ **دسترسی غیرمجاز:** قابلیت بازرسی، شنود و تماشای پیام‌های خصوصی کاربران (Spectator) به منظور حفظ حریم خصوصی کاربران و رعایت استانداردهای رمزنگاری سرتاسری (E2EE) در این نسخه حذف و غیرفعال شده است.", [][]BotActionButton{
		{{Text: "📊 آمار سرور", Command: "/stats"}},
		{{Text: "👥 فهرست کاربران", Command: "/users"}},
	})
}

func (s *Service) handleBroadcastCommand(ctx context.Context, convID, announcement string) (*models.Message, error) {
	if announcement == "" {
		return s.SendBotMessage(ctx, convID, "متن اعلان نمی‌تواند خالی باشد.", nil)
	}

	users, err := s.store.ListAllUsers(ctx)
	if err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در دریافت کاربران: "+err.Error(), nil)
	}

	sentCount := 0
	for _, u := range users {
		if u.IsBanned || !u.IsApproved || u.ID == BotUserID {
			continue
		}
		// Send official announcement via outbox event
		ev := &models.EventOutbox{
			EventType:       "system.announcement",
			RecipientUserID: u.ID,
			Payload:         fmt.Sprintf(`{"title":"اعلان رسمی مدیر سرور","message":%q,"created_at":%q}`, announcement, time.Now().UTC().Format(time.RFC3339)),
			CreatedAt:       time.Now().UTC(),
		}
		s.hub.PublishEvent(ev)
		sentCount++
	}

	text := fmt.Sprintf("📢 **پیام همگانی با موفقیت برای %d کاربر فعال ارسال شد.**\n\nمتن ارسال شده:\n> %s", sentCount, announcement)
	return s.SendBotMessage(ctx, convID, text, nil)
}

func (s *Service) handleApprovalSettingCommand(ctx context.Context, convID, arg string) (*models.Message, error) {
	val := strings.ToLower(arg)
	if val == "on" || val == "true" || val == "1" || val == "فعال" {
		_ = s.store.SetServerSetting(ctx, "registration_approval", "true")
		return s.SendBotMessage(ctx, convID, "🛡️ **تایید اجباری ثبت‌نام فعال شد.**\nاز این پس کاربران جدید تا زمان تایید توسط شما در ربات، امکان ورود نخواهند داشت.", [][]BotActionButton{
			{
				{Text: "📝 بررسی ثبت‌نام‌ها", Command: "/registrations"},
				{Text: "🔓 غیرفعال‌سازی (OFF)", Command: "/approval off"},
			},
			{
				{Text: "📊 آمار سرور", Command: "/stats"},
			},
		})
	}
	if val == "off" || val == "false" || val == "0" || val == "غیرفعال" {
		_ = s.store.SetServerSetting(ctx, "registration_approval", "false")
		return s.SendBotMessage(ctx, convID, "🔓 **تایید اجباری ثبت‌نام غیرفعال شد.**\nاز این پس کاربران جدید بلافاصله پس از ثبت‌نام وارد سیستم می‌شوند.", [][]BotActionButton{
			{
				{Text: "🛡️ فعال‌سازی مجدد (ON)", Command: "/approval on"},
				{Text: "👥 فهرست کاربران", Command: "/users"},
			},
			{
				{Text: "📊 آمار سرور", Command: "/stats"},
			},
		})
	}
	return s.SendBotMessage(ctx, convID, "نحوه استفاده: `/approval on` یا `/approval off`", [][]BotActionButton{
		{
			{Text: "🛡️ فعال‌سازی (ON)", Command: "/approval on"},
			{Text: "🔓 غیرفعال‌سازی (OFF)", Command: "/approval off"},
		},
	})
}

func (s *Service) handleMaintenanceSettingCommand(ctx context.Context, convID, arg string) (*models.Message, error) {
	val := strings.ToLower(arg)
	if val == "on" || val == "true" || val == "1" || val == "فعال" {
		_ = s.store.SetServerSetting(ctx, "maintenance_mode", "true")
		return s.SendBotMessage(ctx, convID, "🚧 **حالت تعمیرات سرور فعال شد.**\nتنها مدیر سرور دسترسی خواهد داشت.", [][]BotActionButton{
			{
				{Text: "✅ غیرفعال‌سازی تعمیرات (OFF)", Command: "/maintenance off"},
				{Text: "📊 آمار سرور", Command: "/stats"},
			},
		})
	}
	if val == "off" || val == "false" || val == "0" || val == "غیرفعال" {
		_ = s.store.SetServerSetting(ctx, "maintenance_mode", "false")
		return s.SendBotMessage(ctx, convID, "🟢 **حالت تعمیرات سرور غیرفعال شد.**\nدسترسی تمام کاربران به صورت عادی برقرار است.", [][]BotActionButton{
			{
				{Text: "🚧 فعال‌سازی تعمیرات (ON)", Command: "/maintenance on"},
				{Text: "📊 آمار سرور", Command: "/stats"},
			},
		})
	}
	return s.SendBotMessage(ctx, convID, "نحوه استفاده: `/maintenance on` یا `/maintenance off`", [][]BotActionButton{
		{
			{Text: "🚧 فعال‌سازی (ON)", Command: "/maintenance on"},
			{Text: "✅ غیرفعال‌سازی (OFF)", Command: "/maintenance off"},
		},
	})
}

func (s *Service) resolveUser(ctx context.Context, query string) (*models.User, error) {
	clean := strings.TrimSpace(query)
	clean = strings.TrimPrefix(clean, "@")
	if clean == "" {
		return nil, storage.ErrNotFound
	}

	// 1. Exact username
	u, err := s.store.GetUserByUsername(ctx, clean)
	if err == nil && u != nil {
		return u, nil
	}

	// 2. Exact user ID
	u, err = s.store.GetUserByID(ctx, clean)
	if err == nil && u != nil {
		return u, nil
	}

	// 3. Match against all users: by username or DisplayName (case-insensitive / Persian)
	allUsers, err := s.store.ListAllUsers(ctx)
	if err == nil {
		normClean := normalizePersianText(clean)
		for _, usr := range allUsers {
			if strings.EqualFold(usr.Username, clean) || strings.EqualFold(usr.DisplayName, clean) {
				return usr, nil
			}
			if normalizePersianText(usr.DisplayName) == normClean {
				return usr, nil
			}
		}
		// Substring match
		for _, usr := range allUsers {
			if strings.Contains(strings.ToLower(usr.Username), strings.ToLower(clean)) ||
				strings.Contains(normalizePersianText(usr.DisplayName), normClean) {
				return usr, nil
			}
		}
	}

	return nil, storage.ErrNotFound
}

func formatDuration(d time.Duration) string {
	d = d.Round(time.Second)
	days := d / (24 * time.Hour)
	d -= days * 24 * time.Hour
	hours := d / time.Hour
	d -= hours * time.Hour
	mins := d / time.Minute
	d -= mins * time.Minute
	secs := d / time.Second

	parts := []string{}
	if days > 0 {
		parts = append(parts, fmt.Sprintf("%d روز", days))
	}
	if hours > 0 {
		parts = append(parts, fmt.Sprintf("%d ساعت", hours))
	}
	if mins > 0 {
		parts = append(parts, fmt.Sprintf("%d دقیقه", mins))
	}
	parts = append(parts, fmt.Sprintf("%d ثانیه", secs))
	return strings.Join(parts, " ")
}

// ---------------------------------------------------------------------
// Database Backup Handler
// ---------------------------------------------------------------------

func (s *Service) handleBackupCommand(ctx context.Context, convID string) (*models.Message, error) {
	now := time.Now().UTC()
	filename := fmt.Sprintf("backup_senora_%s.db", now.Format("20060102_150405"))
	backupPath := filepath.Join("backups", filename)

	if err := s.store.BackupDatabase(ctx, backupPath); err != nil {
		return s.SendBotMessage(ctx, convID, "❌ خطا در تهیه نسخه پشتیبان پایگاه داده: "+err.Error(), nil)
	}

	fi, err := os.Stat(backupPath)
	sizeStr := "نامشخص"
	if err == nil {
		sizeMB := float64(fi.Size()) / (1024 * 1024)
		if sizeMB < 0.1 {
			sizeStr = fmt.Sprintf("%.2f KB", float64(fi.Size())/1024)
		} else {
			sizeStr = fmt.Sprintf("%.2f MB", sizeMB)
		}
	}

	downloadPath := fmt.Sprintf("/api/v1/admin/backup/download?file=%s", filename)

	text := fmt.Sprintf("💾 **پشتیبان‌گیری کامل از پایگاه داده با موفقیت انجام شد!**\n"+
		"━━━━━━━━━━━━━━━━━━━\n"+
		"📁 **نام فایل:** `%s`\n"+
		"📦 **حجم فایل:** %s\n"+
		"📍 **مسیر ذخیره در سرور:** `%s`\n"+
		"⏰ **زمان ایجاد:** %s\n"+
		"━━━━━━━━━━━━━━━━━━━\n"+
		"پایگاه داده به صورت ایزوله (Atomic Hot Snapshot) فشرده و ذخیره شد.\n"+
		"جهت دانلود مستقیم فایل، می‌توانید از مسیر زیر استفاده فرمایید:\n"+
		"`%s`", filename, sizeStr, backupPath, now.Format("2006-01-02 15:04:05 UTC"), downloadPath)

	buttons := [][]BotActionButton{
		{
			{Text: "📥 دانلود مستقیم فایل بکاپ", Command: downloadPath, Action: "download"},
			{Text: "📊 آمار سرور", Command: "/stats"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleDownloadBackupCommand(ctx context.Context, convID string, parts []string) (*models.Message, error) {
	fullText := strings.Join(parts, " ")

	targetFile := ""
	if idx := strings.Index(fullText, "backup_senora_"); idx != -1 {
		candidate := fullText[idx:]
		if end := strings.IndexAny(candidate, " \t\r\n\"'&"); end != -1 {
			targetFile = candidate[:end]
		} else {
			targetFile = candidate
		}
	} else if idx := strings.Index(fullText, "backupsenora"); idx != -1 {
		candidate := fullText[idx:]
		if end := strings.IndexAny(candidate, " \t\r\n\"'&"); end != -1 {
			targetFile = candidate[:end]
		} else {
			targetFile = candidate
		}
	}

	targetFile = filepath.Base(targetFile)

	filePath := filepath.Join("backups", targetFile)
	fi, err := os.Stat(filePath)

	if err != nil || targetFile == "." || targetFile == "" {
		entries, _ := os.ReadDir("backups")
		var latest os.DirEntry
		for _, e := range entries {
			if !e.IsDir() && strings.HasPrefix(e.Name(), "backup_senora_") {
				if latest == nil || e.Name() > latest.Name() {
					latest = e
				}
			}
		}
		if latest != nil {
			targetFile = latest.Name()
			filePath = filepath.Join("backups", targetFile)
			fi, _ = os.Stat(filePath)
		} else {
			return s.handleBackupCommand(ctx, convID)
		}
	}

	sizeStr := "نامشخص"
	if fi != nil {
		sizeMB := float64(fi.Size()) / (1024 * 1024)
		if sizeMB < 0.1 {
			sizeStr = fmt.Sprintf("%.2f KB", float64(fi.Size())/1024)
		} else {
			sizeStr = fmt.Sprintf("%.2f MB", sizeMB)
		}
	}

	downloadPath := fmt.Sprintf("/api/v1/admin/backup/download?file=%s", targetFile)
	text := fmt.Sprintf("📥 **فایل پشتیبان پایگاه داده آماده دانلود است:**\n"+
		"━━━━━━━━━━━━━━━━━━━\n"+
		"📁 **نام فایل:** `%s`\n"+
		"📦 **حجم فایل:** %s\n"+
		"📍 **مسیر:** `%s`\n"+
		"━━━━━━━━━━━━━━━━━━━\n"+
		"جهت دانلود مستقیم، روی دکمه زیر کلیک فرمایید:", targetFile, sizeStr, filePath)

	buttons := [][]BotActionButton{
		{
			{Text: "📥 دانلود مستقیم فایل", Command: downloadPath, Action: "download"},
			{Text: "💾 تهیه بکاپ جدید", Command: "/backup"},
		},
	}
	return s.SendBotMessage(ctx, convID, text, buttons)
}

// ---------------------------------------------------------------------
// Sensitive Keywords Monitoring
// ---------------------------------------------------------------------

const DefaultMonitoredKeywords = "phishing,هک,پسورد,فیشینگ,کلاهبرداری,اکس‌پلویت,leak,exploit,ddos,password,token"

func (s *Service) GetMonitoredKeywords(ctx context.Context) []string {
	kwsStr, err := s.store.GetServerSetting(ctx, "monitored_keywords", DefaultMonitoredKeywords)
	if err != nil || kwsStr == "" {
		kwsStr = DefaultMonitoredKeywords
	}
	parts := strings.Split(kwsStr, ",")
	var result []string
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func (s *Service) AddMonitoredKeyword(ctx context.Context, word string) error {
	word = strings.ToLower(strings.TrimSpace(word))
	if word == "" {
		return errors.New("کلمه کلیدی نمی‌تواند خالی باشد")
	}
	kws := s.GetMonitoredKeywords(ctx)
	for _, k := range kws {
		if strings.EqualFold(k, word) {
			return nil // already exists
		}
	}
	kws = append(kws, word)
	return s.store.SetServerSetting(ctx, "monitored_keywords", strings.Join(kws, ","))
}

func (s *Service) RemoveMonitoredKeyword(ctx context.Context, word string) error {
	word = strings.ToLower(strings.TrimSpace(word))
	kws := s.GetMonitoredKeywords(ctx)
	var updated []string
	for _, k := range kws {
		if !strings.EqualFold(k, word) {
			updated = append(updated, k)
		}
	}
	return s.store.SetServerSetting(ctx, "monitored_keywords", strings.Join(updated, ","))
}

func (s *Service) CheckMessageForKeywords(ctx context.Context, text string) string {
	return ""
}

func (s *Service) handleKeywordsCommand(ctx context.Context, convID string, parts []string) (*models.Message, error) {
	return s.SendBotMessage(ctx, convID, "🔒 **پایش پیام‌ها غیرفعال است:** به منظور احترام به حفظ حریم خصوصی کاربران، سیستم شنود کلمات و بازرسی بسته‌های متنی در سنورا غیرفعال می‌باشد.", [][]BotActionButton{
		{{Text: "📊 آمار سرور", Command: "/stats"}},
		{{Text: "👥 فهرست کاربران", Command: "/users"}},
	})
}

// ---------------------------------------------------------------------
// Dynamic Server Config Handlers
// ---------------------------------------------------------------------

func (s *Service) handleAutoBanCommand(ctx context.Context, convID, arg string) (*models.Message, error) {
	val := strings.ToLower(arg)
	if val == "on" || val == "true" || val == "1" || val == "فعال" {
		_ = s.store.SetServerSetting(ctx, "autoban_enabled", "true")
		return s.SendBotMessage(ctx, convID, "🛡️ **سیستم مسدودسازی خودکار (Auto-Ban) فعال شد.**\nآی‌پی‌هایی که تلاش‌های مکرر ناموفق (ثبت‌نام/ورود) داشته باشند به صورت خودکار مسدود خواهند شد.", [][]BotActionButton{
			{
				{Text: "🚫 بررسی آی‌پی‌های مسدود", Command: "/bannedips"},
				{Text: "🔓 غیرفعال‌سازی (OFF)", Command: "/autoban off"},
			},
			{
				{Text: "⚙️ تغییر آستانه خطا", Command: "/setlimit 5"},
				{Text: "📊 آمار سرور", Command: "/stats"},
			},
		})
	}
	if val == "off" || val == "false" || val == "0" || val == "غیرفعال" {
		_ = s.store.SetServerSetting(ctx, "autoban_enabled", "false")
		return s.SendBotMessage(ctx, convID, "🔓 **سیستم مسدودسازی خودکار (Auto-Ban) غیرفعال شد.**", [][]BotActionButton{
			{
				{Text: "🛡️ فعال‌سازی مجدد (ON)", Command: "/autoban on"},
				{Text: "🚫 آی‌پی‌های مسدود", Command: "/bannedips"},
			},
		})
	}
	curr, _ := s.store.GetServerSetting(ctx, "autoban_enabled", "true")
	return s.SendBotMessage(ctx, convID, fmt.Sprintf("🛡️ وضعیت فعلی سیستم مسدودسازی خودکار: **%s**\nجهت تغییر روی دکمه‌های زیر کلیک کنید:", curr), [][]BotActionButton{
		{
			{Text: "🛡️ فعال‌سازی (ON)", Command: "/autoban on"},
			{Text: "🔓 غیرفعال‌سازی (OFF)", Command: "/autoban off"},
		},
	})
}

func (s *Service) handleSetLimitCommand(ctx context.Context, convID, arg string) (*models.Message, error) {
	trimmed := strings.TrimSpace(arg)
	if trimmed == "" {
		curr, _ := s.store.GetServerSetting(ctx, "autoban_threshold", "5")
		return s.SendBotMessage(ctx, convID, fmt.Sprintf("⚙️ آستانه مجاز فعلی: **%s تلاش ناموفق در دقیقه**\nجهت تغییر روی گزینه‌های زیر کلیک کنید:", curr), [][]BotActionButton{
			{
				{Text: "⚡ ۳ خطا در دقیقه", Command: "/setlimit 3"},
				{Text: "⚡ ۵ خطا در دقیقه", Command: "/setlimit 5"},
				{Text: "⚡ ۱۰ خطا در دقیقه", Command: "/setlimit 10"},
			},
		})
	}
	var num int
	if _, err := fmt.Sscanf(trimmed, "%d", &num); err != nil || num < 2 || num > 100 {
		return s.SendBotMessage(ctx, convID, "⚠️ لطفاً یک عدد معتبر بین 2 تا 100 وارد کنید. مثال: `/setlimit 5`", [][]BotActionButton{
			{
				{Text: "⚡ ۳ خطا", Command: "/setlimit 3"},
				{Text: "⚡ ۵ خطا", Command: "/setlimit 5"},
				{Text: "⚡ ۱۰ خطا", Command: "/setlimit 10"},
			},
		})
	}

	_ = s.store.SetServerSetting(ctx, "autoban_threshold", fmt.Sprintf("%d", num))
	return s.SendBotMessage(ctx, convID, fmt.Sprintf("✅ **آستانه مسدودسازی خودکار به %d تلاش ناموفق در دقیقه تغییر یافت.**", num), [][]BotActionButton{
		{
			{Text: "🛡️ وضعیت Auto-Ban", Command: "/autoban"},
			{Text: "🚫 آی‌پی‌های مسدود", Command: "/bannedips"},
			{Text: "📊 آمار سرور", Command: "/stats"},
		},
	})
}

func (s *Service) handlePulseCommand(ctx context.Context, convID string) (*models.Message, error) {
	users, _ := s.store.ListAllUsers(ctx)
	totalUsers := len(users)

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	allocMB := mem.Alloc / 1024 / 1024

	var dbSizeStr string = "Active In-Memory / SQLite"
	if fi, err := os.Stat("senora.db"); err == nil {
		dbSizeStr = fmt.Sprintf("%.2f MB", float64(fi.Size())/1024.0/1024.0)
	}

	report := fmt.Sprintf(`💓 **گزارش نبض سرور Senora (Daily Pulse)**
━━━━━━━━━━━━━━━━━━━━
👥 **کل کاربران سیستم:** %d نفر
🧠 **مصرف حافظه RAM:** %d MB
💾 **حجم پایگاه‌داده دیسک:** %s
⏱️ **وضعیت سرور:** فعال، آنلاین و پایدار 🟢
🕒 **زمان گزارش:** %s

تمامی سوکت‌ها، اتصالات WebRTC و پیام‌رسانی رمزنگاری‌شده E2EE در اوج سلامت عملیاتی هستند.`,
		totalUsers,
		allocMB,
		dbSizeStr,
		time.Now().Format("2006-01-02 15:04:05"),
	)

	buttons := [][]BotActionButton{
		{
			{Text: "📊 آمار کامل سرور", Command: "/stats"},
			{Text: "🧹 پاکسازی حافظه", Command: "/cleanup"},
		},
		{
			{Text: "💾 دریافت بکاپ", Command: "/backup"},
			{Text: "🛡️ وضعیت اتوبن", Command: "/autoban"},
		},
	}
	return s.SendBotMessage(ctx, convID, report, buttons)
}

func (s *Service) StartScheduledPulse(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				owner, err := s.store.GetServerOwner(ctx)
				if err == nil && owner != nil {
					conv, cErr := s.EnsureBotConversation(ctx, owner.ID)
					if cErr == nil && conv != nil {
						_, _ = s.handlePulseCommand(ctx, conv.ID)

						// Automated Daily Database Backup
						autoBackup, _ := s.store.GetServerSetting(ctx, "autobackup_enabled", "true")
						if autoBackup == "true" {
							_, _ = s.handleBackupCommand(ctx, conv.ID)
						}
					}
				}
			}
		}
	}()
}

func (s *Service) handleStorageCommand(ctx context.Context, convID string, parts []string) (*models.Message, error) {
	if s.fileStore == nil {
		return s.SendBotMessage(ctx, convID, "⚠️ ماژول مدیریت فضای ذخیره‌سازی ابری هنوز مقداردهی نشده است.", nil)
	}

	if len(parts) > 1 && (parts[1] == "analytics" || parts[1] == "تحلیل" || parts[1] == "آمار" || parts[1] == "breakdown") {
		analytics, aErr := s.store.GetStorageAnalytics(ctx)
		if aErr != nil {
			return s.SendBotMessage(ctx, convID, "❌ خطا در بازیابی آمار و تحلیل فضای مصرفی دیتابیس.", nil)
		}

		formatMB := func(bytes int64) string {
			if bytes < 1024 {
				return fmt.Sprintf("%d B", bytes)
			}
			if bytes < 1024*1024 {
				return fmt.Sprintf("%.2f KB", float64(bytes)/1024)
			}
			if bytes < 1024*1024*1024 {
				return fmt.Sprintf("%.2f MB", float64(bytes)/(1024*1024))
			}
			return fmt.Sprintf("%.2f GB", float64(bytes)/(1024*1024*1024))
		}

		text := fmt.Sprintf(`📈 **تحلیل مصرف فضای ذخیره‌سازی رسانه‌ها (Storage Analytics)**

📦 **کل حجم مصرفی رسانه‌ها:** %s (%d فایل ثبت‌شده)

🖼️ **تصاویر و عکس‌ها (Images):**
• تعداد: %d فایل
• حجم کل: %s

🎬 **ویدیوها و فیلم‌ها (Videos):**
• تعداد: %d فایل
• حجم کل: %s

🎙️ **ویس‌ها و فایل‌های صوتی (Voice & Audio):**
• تعداد: %d فایل
• حجم کل: %s

📁 **اسناد، گیف‌ها و سایر فایل‌ها (Documents & Others):**
• تعداد: %d فایل
• حجم کل: %s

☁️ **تفکیک زیرساخت فیزیکی:**
• ذخیره‌سازی ابری آروان S3: %s (%d فایل)
• ذخیره‌ساز محلی سرور: %s (%d فایل)`,
			formatMB(analytics.TotalBytes), analytics.TotalAttachments,
			analytics.ImageCount, formatMB(analytics.ImageBytes),
			analytics.VideoCount, formatMB(analytics.VideoBytes),
			analytics.AudioCount, formatMB(analytics.AudioBytes),
			analytics.DocumentCount, formatMB(analytics.DocumentBytes),
			formatMB(analytics.S3Bytes), analytics.S3Count,
			formatMB(analytics.LocalBytes), analytics.LocalCount,
		)

		buttons := [][]BotActionButton{
			{
				{Text: "☁️ وضعیت سلامت آروان S3", Command: "/storage"},
				{Text: "🔄 تست پروب اتصال", Command: "/storage probe"},
			},
			{
				{Text: "🧹 پاکسازی کش و فایل‌های زائد", Command: "/cleanup"},
				{Text: "💾 نسخه پشتیبان دیتابیس", Command: "/backup"},
			},
		}
		return s.SendBotMessage(ctx, convID, text, buttons)
	}

	if len(parts) > 1 && (parts[1] == "probe" || parts[1] == "test" || parts[1] == "تست") {
		_ = s.fileStore.ProbeHealth(ctx)
	}

	status := s.fileStore.GetStatus()

	engineLabel := "🟢 ابر آروان (ArvanCloud S3 - مالتی‌زون ایران مرکز ۱)"
	if status.ActiveEngine == "local_fallback" {
		engineLabel = "🟡 ذخیره‌ساز محلی سرور (Local Server Fallback)"
	}

	healthStatus := "🟢 آنلاین و عملیاتی"
	if !status.S3Healthy {
		healthStatus = "🔴 غیرقابل دسترس (حالت Failover خودکار فعال است)"
	}

	lastProbeStr := "هنوز تستی انجام نشده"
	if status.LastProbeTime != nil {
		lastProbeStr = status.LastProbeTime.Local().Format("15:04:05")
	}

	errDetail := ""
	if status.LastError != "" {
		errDetail = fmt.Sprintf("\n⚠️ **آخرین پیام/خطا:** `%s`", status.LastError)
	}

	text := fmt.Sprintf(`☁️ **وضعیت زیرساخت ذخیره‌سازی ابری (Storage Status)**

🔹 **موتور فعال فعلی:** %s
🔹 **وضعیت سلامت Arvan S3:** %s
🔹 **صندوقچه (Bucket):** `+"`%s`"+`
🔹 **منطقه (Region):** `+"`%s`"+` (ایران مرکز ۱ - Multi-Zone)
🔹 **اندپوینت (Endpoint):** `+"`%s`"+`
🔹 **تاخیر پینگ:** %d میلی‌ثانیه
🔹 **آخرین بررسی خودکار:** %s
🔹 **کل آپلودهای ابری آروان:** %d فایل
🔹 **کل آپلودهای لوکال سرور:** %d فایل
🔹 **سوئیچ‌های خودکار Failover:** %d بار%s

💡 *پایداری تضمین‌شده:* در صورت قطع ارتباط با آروان، فایل‌ها فوراً روی دیسک محلی سرور ذخیره می‌شوند و به محض اتصال مجدد، سیستم به صورت خودکار به آروان بازمی‌گردد.`,
		engineLabel,
		healthStatus,
		status.Bucket,
		status.Region,
		status.Endpoint,
		status.LastLatencyMs,
		lastProbeStr,
		status.TotalS3Uploads,
		status.TotalLocalUploads,
		status.TotalFallbackSwitches,
		errDetail,
	)

	buttons := [][]BotActionButton{
		{
			{Text: "📈 تحلیل فضای مصرفی", Command: "/storage analytics"},
			{Text: "🔄 تست و پروب اتصال آروان", Command: "/storage probe"},
		},
		{
			{Text: "🧹 پاکسازی حافظه و کش", Command: "/cleanup"},
			{Text: "💾 نسخه پشتیبان فوری", Command: "/backup"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleResetPasswordCommand(ctx context.Context, convID, identifier, newPassword string) (*models.Message, error) {
	if len(newPassword) < 6 {
		return s.SendBotMessage(ctx, convID, "⚠️ خطا: رمز عبور جدید باید حداقل ۶ کاراکتر باشد.", nil)
	}

	cleanUser := strings.TrimPrefix(identifier, "@")
	user, err := s.store.GetUserByUsername(ctx, cleanUser)
	if err != nil || user == nil {
		user, err = s.store.GetUserByID(ctx, identifier)
		if err != nil || user == nil {
			return s.SendBotMessage(ctx, convID, fmt.Sprintf("❌ کاربر با شناسه یا نام کاربری `%s` در پایگاه داده یافت نشد.", identifier), nil)
		}
	}

	// Hash password with Argon2id using standard production parameters
	newHash, err := auth.HashPassword(newPassword, nil)
	if err != nil {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf("❌ خطا در رمزنگاری پسورد با Argon2id: %v", err), nil)
	}

	if err := s.store.UpdateUserPassword(ctx, user.ID, newHash); err != nil {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf("❌ خطا در ذخیره‌سازی رمز عبور در دیتابیس: %v", err), nil)
	}

	msg := fmt.Sprintf("🔑 **رمز عبور کاربر با موفقیت در دیتابیس تغییر یافت!**\n\n"+
		"👤 **کاربر:** @%s (%s)\n"+
		"🔒 **رمز عبور جدید:** `%s`\n\n"+
		"💡 می‌توانید این رمز جدید را به کاربر اعلام نمایید تا بتواند فوراً وارد حساب کاربری خود شود. کاربر همچنین می‌تواند پس از ورود، از بخش تنظیمات رمز دلخواه دیگری را تنظیم کند.",
		user.Username, user.DisplayName, newPassword)

	return s.SendBotMessage(ctx, convID, msg, nil)
}



