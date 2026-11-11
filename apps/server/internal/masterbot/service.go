package masterbot

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"

	"senora/server/internal/auth"
	"senora/server/internal/botlocale"
	"senora/server/internal/conversations"
	"senora/server/internal/events"
	"senora/server/internal/filestore"
	"senora/server/internal/models"
	"senora/server/internal/storage"
)

const (
	BotUserID      = "usr_senoramasterbot"
	BotUsername    = "master_bot"
	BotDisplayName = "🤖 SENORA Master Bot"
	BotBio         = "Official SENORA Server Management Bot. Exclusive to the Server Owner."
	BotAvatarURL   = "https://api.dicebear.com/7.x/bottts/svg?seed=SENORAMasterBot"
)

type BotActionButton struct {
	Text           string `json:"text"`
	Command        string `json:"command,omitempty"`
	Action         string `json:"action,omitempty"`
	ConversationID string `json:"conversation_id,omitempty"`
	Token          string `json:"token,omitempty"`
}

type BotPayload struct {
	Text       string              `json:"text"`
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
	} else if bot.DisplayName != BotDisplayName || bot.Bio != BotBio || bot.AvatarURL != BotAvatarURL {
		bot.DisplayName, bot.Bio, bot.AvatarURL = BotDisplayName, BotBio, BotAvatarURL
		if err := s.store.UpdateUser(ctx, bot); err != nil {
			return nil, err
		}
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
	ctx = botlocale.WithUser(ctx, s.store, ownerID)
	conv, err := s.store.GetDirectConversationBetween(ctx, BotUserID, ownerID)
	if err == nil && conv != nil {
		if conv.Title != BotDisplayName || conv.AvatarURL != BotAvatarURL {
			conv.Title, conv.AvatarURL = BotDisplayName, BotAvatarURL
			if err := s.store.UpdateConversation(ctx, conv); err != nil {
				return nil, err
			}
		}
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
	welcomeText := botlocale.Text(ctx, "👋 **Welcome to SENORA server management.**\n\nI am **SENORA Master Bot**, your server administration assistant.\n\n⚡ **Commands:**\n• /stats — Live server and resource statistics\n• /users — Registered users and account status\n• /registrations — Pending registration requests\n• /approve @username — Approve a user\n• /reject @username — Reject a registration\n• /ban @username — Ban a user and revoke sessions\n• /unban @username — Unban a user\n• /chats — Server conversations\n• /broadcast <message> — Broadcast an announcement\n• /approval on|off — Require registration approval\n• /cleanup — Remove expired messages and temporary files\n• /help — All commands\n\nResponses follow your language preference in Settings → Language. English is the default.", "👋 **درود مدیر گرامی! به ربات مدیریت سرور SENORA خوش آمدید.**\n\nمن **SENORA Master Bot** هستم؛ دستیار شما برای مدیریت سرور، بررسی کاربران و تایید دسترسی‌ها.\n\n⚡ **دستورات اصلی:**\n• /stats — مشاهده آمار زنده سرور و مصرف منابع\n• /users — فهرست کاربران ثبت‌نام شده و وضعیت آنها\n• /registrations — بررسی درخواست‌های در انتظار تایید\n• /approve @username — تایید دسترسی کاربر\n• /reject @username — رد درخواست کاربر\n• /ban @username — مسدودسازی و اخراج فوری کاربر\n• /unban @username — رفع مسدودیت کاربر\n• /chats — فهرست گفتگوهای سرور\n• /broadcast <متن> — ارسال پیام همگانی به همه کاربران\n• /approval <on|off> — فعال/غیرفعال‌سازی تایید اجباری ثبت‌نام\n• /cleanup — پاکسازی پیام‌های منقضی و فایل‌های اضافه\n• /help — راهنمای کامل دستورات")

	buttons := [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "📊 Live server statistics", "📊 آمار زنده سرور"), Command: "/stats"},
			{Text: botlocale.Text(ctx, "👥 Users", "👥 فهرست کاربران"), Command: "/users"},
		},
		{
			{Text: botlocale.Text(ctx, "🛡️ Registration requests", "🛡️ درخواست‌های ثبت‌نام"), Command: "/registrations"},
			{Text: botlocale.Text(ctx, "💬 Server chats", "💬 چت‌های سرور"), Command: "/chats"},
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
func ClassifyIP(rawIP string) (string, string) { return classifyIP(context.Background(), rawIP) }
func classifyIP(ctx context.Context, rawIP string) (label string, emoji string) {
	norm := strings.TrimSpace(rawIP)
	if host, _, err := net.SplitHostPort(norm); err == nil {
		norm = host
	}
	norm = strings.TrimPrefix(norm, "[")
	norm = strings.TrimSuffix(norm, "]")

	parsed := net.ParseIP(norm)
	if parsed == nil {
		return botlocale.Text(ctx, "Invalid address", "آدرس نامعتبر"), "❓"
	}

	if parsed.IsLoopback() {
		return botlocale.Text(ctx, "Localhost / Loopback", "لوکال و لوپ‌بک سرور (Localhost / Loopback)"), "💻"
	}

	if parsed.IsPrivate() {
		return botlocale.Text(ctx, "Private LAN / VPN", "شبکه محلی یا VPN خصوصی (Private LAN / VPN)"), "🔒"
	}

	if parsed.IsLinkLocalUnicast() || parsed.IsLinkLocalMulticast() {
		return botlocale.Text(ctx, "Link-local network", "شبکه محلی پیوندی (Link-Local)"), "🔗"
	}

	return botlocale.Text(ctx, "Public WAN / Internet", "اینترنت عمومی (Public WAN / Internet)"), "🌍"
}

// NotifyNewRegistration alerts the Server Owner when a new user registers and requires approval.
func (s *Service) NotifyNewRegistration(ctx context.Context, pendingUser *models.User, deviceName string, clientIP string, fingerprint string) error {
	owner, err := s.store.GetServerOwner(ctx)
	if err != nil || owner == nil {
		return nil
	}

	ctx = botlocale.WithUser(ctx, s.store, owner.ID)
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

	lbl, emo := classifyIP(ctx, clientIP)
	fpText := ""
	if fingerprint != "" {
		fpText = fmt.Sprintf(botlocale.Text(ctx, "\n📱 **Device fingerprint:** `%s`", "\n📱 **اثرانگشت دستگاه (Fingerprint):** `%s`"), fingerprint)
	}

	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05 UTC")
	text := fmt.Sprintf(botlocale.Text(ctx, "🛡️ **New registration request**\n", "🛡️ **درخواست ثبت‌نام کاربر جدید**\n")+
		"━━━━━━━━━━━━━━━━━━━\n"+
		botlocale.Text(ctx, "👤 **Username:** @%s\n", "👤 **نام کاربری:** @%s\n")+
		botlocale.Text(ctx, "🏷️ **Display name:** %s\n", "🏷️ **نام نمایشی:** %s\n")+
		botlocale.Text(ctx, "🆔 **ID:** %s\n", "🆔 **شناسه:** %s\n")+
		botlocale.Text(ctx, "📱 **Device:** %s\n", "📱 **دستگاه:** %s\n")+
		botlocale.Text(ctx, "🌐 **IP address:** `%s` (%s %s)%s\n", "🌐 **آدرس آی‌پی:** `%s` (%s %s)%s\n")+
		botlocale.Text(ctx, "⏰ **Registered:** %s\n", "⏰ **زمان ثبت‌نام:** %s\n")+
		"━━━━━━━━━━━━━━━━━━━\n"+
		botlocale.Text(ctx, "Approve this account? You can reject the registration or block the user/IP if it is spam.\n\n", "آیا دسترسی این کاربر را به پلتفرم تایید می‌کنید؟ در صورت اسپم بودن ثبت‌نام، می‌توانید آی‌پی یا کاربر را فوراً مسدود کنید.\n\n")+
		botlocale.Text(ctx, "Quick commands:\n", "دستورات سریع:\n")+
		"/approve @%s\n"+
		"/reject @%s\n"+
		"/banip %s", pendingUser.Username, pendingUser.DisplayName, pendingUser.ID, deviceName, clientIP, emo, lbl, fpText, nowStr, pendingUser.Username, pendingUser.Username, clientIP)

	buttons := [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "✅ Approve user", "✅ تایید کاربر (Approve)"), Command: "/approve @" + pendingUser.Username},
			{Text: botlocale.Text(ctx, "❌ Reject request", "❌ رد درخواست (Reject)"), Command: "/reject @" + pendingUser.Username},
		},
		{
			{Text: botlocale.Text(ctx, "🚫 Ban IP", "🚫 مسدودسازی آی‌پی (Ban IP)"), Command: "/banip " + clientIP},
			{Text: botlocale.Text(ctx, "👥 View requests", "👥 مشاهده درخواست‌ها"), Command: "/registrations"},
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

	ctx = botlocale.WithUser(ctx, s.store, owner.ID)
	conv, err := s.EnsureBotConversation(ctx, owner.ID)
	if err != nil || conv == nil {
		return err
	}

	lbl, emo := classifyIP(ctx, ip)
	nowStr := time.Now().UTC().Format("2006-01-02 15:04:05 UTC")
	text := fmt.Sprintf(botlocale.Text(ctx, "🚨 **Automatic IP ban triggered**\n", "🚨 **مسدودسازی خودکار آدرس آی‌پی (Auto-Ban Triggered)**\n")+
		"━━━━━━━━━━━━━━━━━━━\n"+
		botlocale.Text(ctx, "🌐 **IP address:** `%s`\n", "🌐 **آدرس آی‌پی:** `%s`\n")+
		botlocale.Text(ctx, "🏷️ **Address type:** %s %s\n", "🏷️ **نوع آدرس:** %s %s\n")+
		botlocale.Text(ctx, "⚠️ **Reason:** %s (%d failed attempts)\n", "⚠️ **دلیل مسدودسازی:** %s (%d تلاش ناموفق)\n")+
		botlocale.Text(ctx, "⏰ **Time:** %s\n", "⏰ **زمان رخداد:** %s\n")+
		"━━━━━━━━━━━━━━━━━━━\n"+
		botlocale.Text(ctx, "This IP exceeded the configured security threshold and was blocked. Subsequent requests from this address will be rejected.", "این آدرس آی‌پی به دلیل نقض آستانه امنیتی سرور به صورت خودکار در لیست سیاه (Blacklist) قرار گرفت و تمام درخواست‌های بعدی آن مسدود گردیده است."), ip, emo, lbl, reason, failureCount, nowStr)

	buttons := [][]BotActionButton{
		{
			{Text: fmt.Sprintf(botlocale.Text(ctx, "🔓 Unban %s", "🔓 رفع مسدودیت %s"), ip), Command: "/unbanip " + ip},
			{Text: botlocale.Text(ctx, "📋 Blocked addresses", "📋 مشاهده لیست مسدودی"), Command: "/bannedips"},
		},
	}

	_, err = s.SendBotMessage(ctx, conv.ID, text, buttons)
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
	ctx = botlocale.WithUser(ctx, s.store, senderID)
	// Verify sender is the server owner
	isOwner, err := s.store.IsUserOwner(ctx, senderID)
	if err != nil || !isOwner {
		denied := botlocale.Text(ctx, "⛔ SENORA Master Bot is available only to the server owner.", "⛔ خطا: ربات مدیریت SENORA Master Bot صرفاً برای مالک و مدیر اصلی سرور طراحی شده است و دسترسی شما مجاز نمی‌باشد.")
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
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "Enter a command. Send /help to see the available commands.", "لطفاً دستور مورد نظر خود را وارد کنید. برای مشاهده راهنما دستور /help را ارسال نمایید."), nil)
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
			return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ Usage: `/approve @username` or `/approve <user_id>`", "⚠️ نحوه استفاده: `/approve @username` یا `/approve <user_id>`"), nil)
		}
		return s.handleApproveCommand(ctx, convID, parts[1])

	case "/reject":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ Usage: `/reject @username` or `/reject <user_id>`", "⚠️ نحوه استفاده: `/reject @username` یا `/reject <user_id>`"), nil)
		}
		return s.handleRejectCommand(ctx, convID, parts[1])

	case "/ban":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ Usage: `/ban @username` or `/ban <user_id>`", "⚠️ نحوه استفاده: `/ban @username` یا `/ban <user_id>`"), nil)
		}
		return s.handleBanCommand(ctx, convID, parts[1], true)

	case "/unban":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ Usage: `/unban @username` or `/unban <user_id>`", "⚠️ نحوه استفاده: `/unban @username` یا `/unban <user_id>`"), nil)
		}
		return s.handleBanCommand(ctx, convID, parts[1], false)

	case "/resetpass", "/resetpassword", "resetpass", "تغییر_رمز":
		if len(parts) < 3 {
			return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ Usage: `/resetpass @username <new_password>`", "⚠️ نحوه استفاده: `/resetpass @username <رمز_جدید>`\nمثال: `/resetpass ali 12345678`"), nil)
		}
		return s.handleResetPasswordCommand(ctx, convID, parts[1], parts[2])

	case "/banip":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ Usage: `/banip <ip_address_or_cidr> [reason]`", "⚠️ نحوه استفاده: `/banip <ip_address_or_cidr> [علت مسدودسازی]`"), nil)
		}
		reason := ""
		if len(parts) > 2 {
			reason = strings.TrimSpace(strings.Join(parts[2:], " "))
		}
		return s.handleBanIPCommand(ctx, convID, parts[1], reason)

	case "/unbanip":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ Usage: `/unbanip <ip_address_or_cidr>`", "⚠️ نحوه استفاده: `/unbanip <ip_address_or_cidr>`"), nil)
		}
		return s.handleUnbanIPCommand(ctx, convID, parts[1])

	case "/bannedips", "/blacklist", "blacklist", "آی‌پی‌ها":
		return s.handleListBannedIPsCommand(ctx, convID)

	case "/chats", "chats", "چت‌ها":
		return s.handleChatsCommand(ctx, convID)

	case "/broadcast":
		if len(parts) < 2 {
			return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ Usage: `/broadcast <announcement>`", "⚠️ نحوه استفاده: `/broadcast <متن پیام برای ارسال همگانی>`"), nil)
		}
		broadcastText := strings.TrimSpace(strings.TrimPrefix(trimmed, parts[0]))
		return s.handleBroadcastCommand(ctx, convID, broadcastText)

	case "/approval":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "registration_approval", "true")
			buttons := [][]BotActionButton{
				{
					{Text: botlocale.Text(ctx, "🛡️ Enable registration approval", "🛡️ فعال‌سازی تایید ثبت‌نام (ON)"), Command: "/approval on"},
					{Text: botlocale.Text(ctx, "🔓 Disable registration approval", "🔓 غیرفعال‌سازی تایید (OFF)"), Command: "/approval off"},
				},
				{
					{Text: botlocale.Text(ctx, "📝 Review registrations", "📝 بررسی ثبت‌نام‌ها"), Command: "/registrations"},
					{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "🛡️ **Registration approval:** `%s`\nChoose an option below:", "🛡️ **وضعیت فعلی تایید ثبت‌نام:** `%s`\nجهت تغییر روی دکمه‌های زیر کلیک کنید:"), curr), buttons)
		}
		return s.handleApprovalSettingCommand(ctx, convID, parts[1])

	case "/maintenance":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "maintenance_mode", "false")
			buttons := [][]BotActionButton{
				{
					{Text: botlocale.Text(ctx, "🚧 Enable maintenance mode", "🚧 فعال‌سازی حالت تعمیرات (ON)"), Command: "/maintenance on"},
					{Text: botlocale.Text(ctx, "✅ Disable maintenance mode", "✅ غیرفعال‌سازی تعمیرات (OFF)"), Command: "/maintenance off"},
				},
				{
					{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "🚧 **Maintenance mode:** `%s`\nChoose an option below:", "🚧 **وضعیت حالت تعمیرات:** `%s`\nجهت تغییر روی دکمه‌های زیر کلیک کنید:"), curr), buttons)
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
		msgText := fmt.Sprintf(botlocale.Text(ctx, "🧹 **Cleanup completed.**\n- Removed **%d** expired messages.\n- Removed **%d** temporary files (%.2f MB freed).", "🧹 **عملیات پاکسازی سرور و کش با موفقیت انجام شد.**\n- **%d** پیام منقضی شده حذف شدند.\n- **%d** فایل موقت پاکسازی شد (%.2f MB آزاد شد)."), purged, removedFiles, freedMB)
		return s.SendBotMessage(ctx, convID, msgText, [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "💓 Server pulse", "💓 نبض زنده سرور"), Command: "/pulse"},
				{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
			},
			{
				{Text: botlocale.Text(ctx, "💾 Create backup", "💾 تهیه نسخه بکاپ"), Command: "/backup"},
			},
		})

	case "/storage", "storage", "انبار", "آروان":
		return s.handleStorageCommand(ctx, convID, parts)

	case "/backup", "backup", "بکاپ":
		return s.handleBackupCommand(ctx, convID)

	case "/download", "download", "دانلود":
		return s.handleDownloadBackupCommand(ctx, convID, parts)

	case "/autoban", "autoban", "اتوبن":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "autoban_enabled", "true")
			buttons := [][]BotActionButton{
				{
					{Text: botlocale.Text(ctx, "🛡️ Enable automatic bans", "🛡️ فعال‌سازی مسدودسازی خودکار"), Command: "/autoban on"},
					{Text: botlocale.Text(ctx, "🔓 Disable automatic bans", "🔓 غیرفعال‌سازی مسدودسازی خودکار"), Command: "/autoban off"},
				},
				{
					{Text: botlocale.Text(ctx, "🚫 Blocked IPs", "🚫 آی‌پی‌های مسدود"), Command: "/bannedips"},
					{Text: botlocale.Text(ctx, "⚙️ Change failure threshold", "⚙️ تغییر آستانه خطا"), Command: "/setlimit 5"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "🛡️ **Automatic bans:** `%s`\nChoose a setting or threshold:", "🛡️ **وضعیت فعلی مسدودسازی خودکار (Auto-Ban):** `%s`\nجهت تغییر وضعیت یا آستانه روی گزینه‌های زیر کلیک کنید:"), curr), buttons)
		}
		return s.handleAutoBanCommand(ctx, convID, parts[1])

	case "/setlimit", "setlimit":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "autoban_threshold", "5")
			buttons := [][]BotActionButton{
				{
					{Text: botlocale.Text(ctx, "⚡ 3 failures per minute", "⚡ ۳ خطا در دقیقه"), Command: "/setlimit 3"},
					{Text: botlocale.Text(ctx, "⚡ 5 failures per minute", "⚡ ۵ خطا در دقیقه"), Command: "/setlimit 5"},
					{Text: botlocale.Text(ctx, "⚡ 10 failures per minute", "⚡ ۱۰ خطا در دقیقه"), Command: "/setlimit 10"},
				},
				{
					{Text: botlocale.Text(ctx, "🛡️ Automatic ban status", "🛡️ وضعیت Auto-Ban"), Command: "/autoban"},
					{Text: botlocale.Text(ctx, "🚫 Blocked IPs", "🚫 آی‌پی‌های مسدود"), Command: "/bannedips"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "⚙️ **Current automatic ban threshold:** `%s failed attempts per minute`\nChoose an option or send `/setlimit <number>`:", "⚙️ **آستانه مسدودسازی خودکار فعلی:** `%s تلاش ناموفق در دقیقه`\nیکی از گزینه‌های زیر را انتخاب یا دستور `/setlimit <تعداد>` را ارسال نمایید:"), curr), buttons)
		}
		return s.handleSetLimitCommand(ctx, convID, parts[1])

	case "/antispam", "antispam", "آنتی‌اسپم", "ضداسپم":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "antispam_enabled", "false")
			buttons := [][]BotActionButton{
				{
					{Text: botlocale.Text(ctx, "🛡️ Enable group anti-spam", "🛡️ فعال‌سازی آنتی‌اسپم گروه‌ها"), Command: "/antispam on"},
					{Text: botlocale.Text(ctx, "🔓 Disable group anti-spam", "🔓 غیرفعال‌سازی آنتی‌اسپم"), Command: "/antispam off"},
				},
				{
					{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
					{Text: botlocale.Text(ctx, "📖 Help", "📖 راهنما"), Command: "/help"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "🛡️ **Group anti-spam and link filtering:** `%s`\nWhen enabled, non-admin members cannot post web or Telegram links in groups.", "🛡️ **سیستم آنتی‌اسپم و فیلتر لینک گروه‌ها (Group Anti-Spam):** `%s`\nدر صورت فعال بودن، کاربران عادی اجازه ارسال لینک‌های تلگرامی و اینترنتی در گروه‌ها را ندارند."), curr), buttons)
		}
		enable := (strings.ToLower(parts[1]) == "on" || parts[1] == "فعال" || parts[1] == "1")
		val := "false"
		msg := botlocale.Text(ctx, "🔓 Group anti-spam disabled.", "🔓 سیستم آنتی‌اسپم گروه‌ها غیرفعال شد.")
		if enable {
			val = "true"
			msg = botlocale.Text(ctx, "🛡️ Group anti-spam enabled. Links from non-admin members are blocked.", "🛡️ سیستم آنتی‌اسپم گروه‌ها فعال شد (ارسال لینک توسط اعضای غیرمدیر مسدود شد).")
		}
		_ = s.store.SetServerSetting(ctx, "antispam_enabled", val)
		return s.SendBotMessage(ctx, convID, msg, [][]BotActionButton{
			{{Text: botlocale.Text(ctx, "🛡️ Anti-spam settings", "🛡️ تنظیمات آنتی‌اسپم"), Command: "/antispam"}, {Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"}},
		})

	case "/autobackup", "autobackup", "بکاپ_خودکار":
		if len(parts) < 2 {
			curr, _ := s.store.GetServerSetting(ctx, "autobackup_enabled", "true")
			buttons := [][]BotActionButton{
				{
					{Text: botlocale.Text(ctx, "💾 Enable daily backups", "💾 فعال‌سازی بکاپ خودکار روزانه"), Command: "/autobackup on"},
					{Text: botlocale.Text(ctx, "⏸️ Disable daily backups", "⏸️ غیرفعال‌سازی بکاپ خودکار"), Command: "/autobackup off"},
				},
				{
					{Text: botlocale.Text(ctx, "💾 Back up now", "💾 بکاپ‌گیری فوری دستی"), Command: "/backup"},
					{Text: botlocale.Text(ctx, "☁️ Storage management", "☁️ مدیریت حافظه"), Command: "/storage"},
				},
			}
			return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "💾 **Daily automatic backups:** `%s`\nWhen enabled, a private backup is created every 24 hours.", "💾 **وضعیت بکاپ‌گیری خودکار روزانه:** `%s`\nدر صورت فعال بودن، سرور هر ۲۴ ساعت به صورت خودکار نسخه پشتیبان ایزوله تهیه و ارسال می‌کند."), curr), buttons)
		}
		enable := (strings.ToLower(parts[1]) == "on" || parts[1] == "فعال" || parts[1] == "1")
		val := "false"
		msg := botlocale.Text(ctx, "⏸️ Daily automatic backups disabled.", "⏸️ بکاپ‌گیری خودکار روزانه غیرفعال گردید.")
		if enable {
			val = "true"
			msg = botlocale.Text(ctx, "💾 Daily automatic backups enabled.", "💾 بکاپ‌گیری خودکار روزانه فعال گردید (سرور هر روز نسخه پشتیبان تهیه خواهد کرد).")
		}
		_ = s.store.SetServerSetting(ctx, "autobackup_enabled", val)
		return s.SendBotMessage(ctx, convID, msg, [][]BotActionButton{
			{{Text: botlocale.Text(ctx, "💾 Automatic backup status", "💾 وضعیت بکاپ خودکار"), Command: "/autobackup"}, {Text: botlocale.Text(ctx, "💾 Manual backup", "💾 بکاپ دستی"), Command: "/backup"}},
		})

	default:
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❓ **Unknown command.**\nOpen help to see all available commands.", "❓ **دستور ارسال شده شناسایی نشد.**\nبرای مشاهده فهرست کامل قابلیت‌ها و دستورات روی راهنما کلیک کنید."), [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "📖 Command help (/help)", "📖 راهنمای دستورات (/help)"), Command: "/help"},
				{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
			},
			{
				{Text: botlocale.Text(ctx, "👥 Users", "👥 کاربران"), Command: "/users"},
				{Text: botlocale.Text(ctx, "💬 Conversations", "💬 گفتگوها"), Command: "/chats"},
			},
		})
	}
}

func (s *Service) handleHelpCommand(ctx context.Context, convID string) (*models.Message, error) {
	text := botlocale.Text(ctx, "📖 **SENORA Master Bot commands**\n\n⚡ **Accounts and registration**\n/registrations — Pending requests\n/approve @username — Approve account\n/reject @username — Reject registration\n/users — Registered users\n/ban @username — Ban and revoke sessions\n/unban @username — Unban account\n/resetpass @username <new_password> — Reset password\n\n🌐 **Network security**\n/banip <ip_or_cidr> [reason] — Block IP/subnet\n/unbanip <ip_or_cidr> — Unblock IP/subnet\n/bannedips — Blocked addresses\n/autoban on|off — Automatic bans\n/setlimit <number> — Failed-attempt threshold per minute\n\n📊 **Server operations**\n/stats — Statistics and resource usage\n/pulse — Live server status\n/backup — Create database backup\n/autobackup on|off — Daily automatic backups\n/broadcast <message> — Announce to all users\n/approval on|off — Registration approval\n/maintenance on|off — Maintenance mode\n/antispam on|off — Group link filtering\n/cleanup — Expired messages and temporary files\n/storage — File storage status\n/dl <url> [proxy] [quality] — Download media\n/sync_s3 — Transfer local files to configured S3\n\nResponses follow Settings → Language; English is the default.\nPersian command aliases remain supported.", "📖 **راهنمای جامع دستورات SENORA Master Bot**\n\n⚡ **دستورات مدیریت کاربران و ثبت‌نام:**\n• /registrations — مشاهده لیست کاربران در انتظار تایید\n• /approve @username — تایید و فعال‌سازی حساب کاربر\n• /reject @username — رد درخواست ثبت‌نام و حذف کاربر\n• /users — فهرست تمام کاربران ثبت‌شده\n• /ban @username — مسدودسازی فوری و ابطال تمام نشست‌های کاربر\n• /unban @username — رفع مسدودیت کاربر\n• /resetpass @username <رمز_جدید> — تغییر مستقیم رمز عبور کاربر در صورت فراموشی\n\n🌐 **امنیت شبکه و مسدودسازی آی‌پی (IP & CIDR Blacklist):**\n• /banip <ip_or_cidr> [علت] — مسدودسازی تک‌آی‌پی یا ساب‌نت شبکه (مانند 192.168.1.0/24)\n• /unbanip <ip_or_cidr> — رفع مسدودیت آدرس آی‌پی یا ساب‌نت\n• /bannedips — فهرست تمامی آی‌پی‌های مسدود شده\n• /autoban on|off — فعال/غیرفعال‌سازی سیستم مسدودسازی خودکار اسپمرها\n• /setlimit <number> — تنظیم آستانه تلاش‌های ناموفق مجاز در دقیقه\n\n📊 **آمار، بکاپ و پایش سرور:**\n• /stats — نمایش کامل آمار زنده، اتصالات، حافظه و سلامت سیستم\n• /backup — تهیه نسخه پشتیبان داغ و فشرده (Hot Backup) از پایگاه داده\n• /broadcast <متن> — ارسال اعلان رسمی به تمام کاربران سرور\n• /approval on|off — فعال یا غیرفعال کردن تایید اجباری ثبت‌نام‌ها\n• /maintenance on|off — فعال یا غیرفعال کردن حالت تعمیرات سرور\n• /cleanup — پاکسازی فیزیکی پیام‌های منقضی و حافظه کش\n\n🎬 **دانلود ویدیو از وب (SENORADownloader):**\n• /dl <لینک> [پروکسی] [کیفیت] — دانلود ویدیو (یوتیوب، اینستاگرام، توییتر، تیک‌تاک و ...) و ارسال در همین چت\n  مثال: /dl https://youtu.be/xxxx socks5://127.0.0.1:10808\n\n💡 *نکته:* می‌توانید دستورات را به صورت فارسی و گفتاری نیز ارسال کنید! (مثال: «آمار»، «بکاپ»، «تایید @کاربر»، «بلاک آی پی 1.2.3.4»)")

	buttons := [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "📊 Live server statistics", "📊 آمار زنده سرور"), Command: "/stats"},
			{Text: botlocale.Text(ctx, "💾 Create backup", "💾 تهیه نسخه بکاپ"), Command: "/backup"},
		},
		{
			{Text: botlocale.Text(ctx, "👥 Users", "👥 فهرست کاربران"), Command: "/users"},
			{Text: botlocale.Text(ctx, "🛡️ Review registrations", "🛡️ بررسی ثبت‌نام‌ها"), Command: "/registrations"},
		},
		{
			{Text: botlocale.Text(ctx, "🎬 Download media (/dl)", "🎬 دانلود ویدیو (/dl)"), Command: "/dl"},
			{Text: botlocale.Text(ctx, "💬 Server chats", "💬 چت‌های سرور"), Command: "/chats"},
		},
		{
			{Text: botlocale.Text(ctx, "🚫 Blocked IPs", "🚫 آی‌پی‌های مسدود"), Command: "/bannedips"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleStatsCommand(ctx context.Context, convID string) (*models.Message, error) {
	stats, err := s.store.GetServerStats(ctx)
	if stats != nil {
		stats.OnlineUsers = s.hub.OnlineUserCount()
	}
	if err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not load server statistics: ", "❌ خطا در دریافت آمار سرور: ")+err.Error(), nil)
	}

	uptimeStr := formatDuration(ctx, time.Duration(stats.UptimeSeconds)*time.Second)
	storageMB := float64(stats.TotalStorageBytes) / (1024 * 1024)

	apprBadge := botlocale.Text(ctx, "🟢 Enabled", "🟢 فعال")
	if !stats.ApprovalRequired {
		apprBadge = botlocale.Text(ctx, "⚪ Disabled", "⚪ غیرفعال")
	}
	maintBadge := botlocale.Text(ctx, "⚪ Disabled", "⚪ غیرفعال")
	if stats.MaintenanceMode {
		maintBadge = botlocale.Text(ctx, "🔴 Enabled", "🔴 فعال")
	}

	text := fmt.Sprintf(botlocale.Text(ctx, "📊 **SENORA live server statistics**\n━━━━━━━━━━━━━━━━━━━\n👥 **Total users:** %d\n🛡️ **Pending approval:** %d\n🚫 **Banned:** %d\n⚡ **Active sessions:** %d\n━━━━━━━━━━━━━━━━━━━\n💬 **Conversations:** %d\n📨 **Messages:** %d\n📁 **Attachments:** %d (%.2f MB)\n━━━━━━━━━━━━━━━━━━━\n⚙️ **System resources**\n⏱️ **Uptime:** %s\n🐹 **Go version:** %s\n🧠 **Allocated RAM:** %.2f MB\n💻 **System RAM reserved:** %.2f MB\n🧵 **Goroutines:** %d\n🛡️ **Registration approval:** %s\n🚧 **Maintenance:** %s", "📊 **داشبورد آمار زنده سرور SENORA**\n━━━━━━━━━━━━━━━━━━━\n👥 **کاربران کل:** %d نفر\n🛡️ **در انتظار تایید:** %d نفر\n🚫 **مسدود شده:** %d نفر\n⚡ **نشست‌های فعال:** %d عدد\n━━━━━━━━━━━━━━━━━━━\n💬 **گفتگوهای فعال:** %d گفتگو\n📨 **پیام‌های مبادله‌شده:** %d پیام\n📁 **فایل‌ها و پیوست‌ها:** %d فایل (%.2f MB)\n━━━━━━━━━━━━━━━━━━━\n⚙️ **سیستم و منابع:**\n⏱️ **مدت زمان فعالیت (Uptime):** %s\n🐹 **نسخه Go:** %s\n🧠 **حافظه رم تخصیص‌یافته:** %.2f MB\n💻 **حافظه رم رزرو سیستم:** %.2f MB\n🧵 **گوروتین‌های فعال:** %d\n🛡️ **تایید اجباری ثبت‌نام:** %s\n🚧 **حالت تعمیرات:** %s"),
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
			{Text: botlocale.Text(ctx, "🔄 Refresh statistics", "🔄 بروزرسانی آمار"), Command: "/stats"},
			{Text: botlocale.Text(ctx, "🛡️ Registration requests", "🛡️ درخواست‌های ثبت‌نام"), Command: "/registrations"},
		},
		{
			{Text: botlocale.Text(ctx, "👥 Manage users", "👥 مدیریت کاربران"), Command: "/users"},
			{Text: botlocale.Text(ctx, "💬 Server chats", "💬 چت‌های سرور"), Command: "/chats"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleUsersCommand(ctx context.Context, convID string) (*models.Message, error) {
	users, err := s.store.ListAllUsers(ctx)
	if err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not load users: ", "❌ خطا در بارگذاری فهرست کاربران: ")+err.Error(), nil)
	}

	if len(users) == 0 {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "No users were found.", "هیچ کاربری در سرور یافت نشد."), nil)
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf(botlocale.Text(ctx, "👥 **Server users (%d)**\n━━━━━━━━━━━━━━━━━━━\n", "👥 **فهرست کاربران سرور (%d کاربر)**\n━━━━━━━━━━━━━━━━━━━\n"), len(users)))

	maxShow := 15
	if len(users) < maxShow {
		maxShow = len(users)
	}

	for i := 0; i < maxShow; i++ {
		u := users[i]
		status := botlocale.Text(ctx, "🟢 Enabled", "🟢 فعال")
		if u.IsBanned {
			status = botlocale.Text(ctx, "🚫 Banned", "🚫 مسدود")
		} else if !u.IsApproved {
			status = botlocale.Text(ctx, "⏳ Pending approval", "⏳ در انتظار تایید")
		}
		ownerTag := ""
		if u.IsOwner {
			ownerTag = botlocale.Text(ctx, " 👑 [Server owner]", " 👑 [مالک سرور]")
		}
		ipInfo := ""
		if u.RegistrationIP != "" {
			ipInfo = fmt.Sprintf(" | 🌐 `%s`", u.RegistrationIP)
		}

		sb.WriteString(fmt.Sprintf(botlocale.Text(ctx, "%d. **%s** (@%s)%s\n   🆔 `%s` | Status: %s%s\n", "%d. **%s** (@%s)%s\n   🆔 `%s` | وضعیت: %s%s\n"), i+1, u.DisplayName, u.Username, ownerTag, u.ID, status, ipInfo))
	}

	if len(users) > maxShow {
		sb.WriteString(fmt.Sprintf(botlocale.Text(ctx, "\n... and %d more users.", "\n... و %d کاربر دیگر."), len(users)-maxShow))
	}

	var buttons [][]BotActionButton

	buttons = append(buttons, []BotActionButton{
		{Text: botlocale.Text(ctx, "🛡️ Users pending approval", "🛡️ کاربران در انتظار تایید"), Command: "/registrations"},
		{Text: botlocale.Text(ctx, "🚫 Blocked IPs", "🚫 آی‌پی‌های مسدود"), Command: "/bannedips"},
	})
	buttons = append(buttons, []BotActionButton{
		{Text: botlocale.Text(ctx, "💬 Server conversations", "💬 گفتگوهای سرور"), Command: "/chats"},
		{Text: botlocale.Text(ctx, "📊 Live server statistics", "📊 آمار زنده سرور"), Command: "/stats"},
	})

	return s.SendBotMessage(ctx, convID, sb.String(), buttons)
}

func (s *Service) handlePendingRegistrationsCommand(ctx context.Context, convID string) (*models.Message, error) {
	users, err := s.store.ListPendingUsers(ctx)
	if err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not load registration requests: ", "❌ خطا در دریافت درخواست‌های ثبت‌نام: ")+err.Error(), nil)
	}

	if len(users) == 0 {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "✅ No registrations are pending approval.", "✅ هیچ درخواست ثبت‌نامی در انتظار تایید وجود ندارد. تمام کاربران تایید شده‌اند."), nil)
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf(botlocale.Text(ctx, "🛡️ **Pending registrations (%d users)**\n━━━━━━━━━━━━━━━━━━━\n", "🛡️ **درخواست‌های ثبت‌نام در انتظار تایید (%d کاربر)**\n━━━━━━━━━━━━━━━━━━━\n"), len(users)))

	var actionRows [][]BotActionButton

	for i, u := range users {
		ipInfo := ""
		if u.RegistrationIP != "" {
			ipInfo = fmt.Sprintf(" | 🌐 IP: `%s`", u.RegistrationIP)
		}
		sb.WriteString(fmt.Sprintf(botlocale.Text(ctx, "%d. **%s** (@%s)\n   🆔 `%s` | Registered: %s%s\n", "%d. **%s** (@%s)\n   🆔 `%s` | ثبت‌نام: %s%s\n"),
			i+1, u.DisplayName, u.Username, u.ID, u.CreatedAt.Format("2006-01-02 15:04"), ipInfo))

		if i < 4 { // provide inline action buttons for first few pending users
			row := []BotActionButton{
				{Text: fmt.Sprintf(botlocale.Text(ctx, "✅ Approve @%s", "✅ تایید @%s"), u.Username), Command: "/approve @" + u.Username},
				{Text: fmt.Sprintf(botlocale.Text(ctx, "❌ Reject @%s", "❌ رد @%s"), u.Username), Command: "/reject @" + u.Username},
			}
			if u.RegistrationIP != "" {
				row = append(row, BotActionButton{Text: fmt.Sprintf(botlocale.Text(ctx, "🚫 Ban %s", "🚫 مسدودسازی %s"), u.RegistrationIP), Command: "/banip " + u.RegistrationIP})
			}
			actionRows = append(actionRows, row)
		}
	}

	sb.WriteString(botlocale.Text(ctx, "\nUse the buttons below or send an approval/rejection command.", "\nبرای تایید یا رد از دکمه‌های زیر استفاده کنید یا دستور مربوطه را بفرستید."))

	return s.SendBotMessage(ctx, convID, sb.String(), actionRows)
}

func (s *Service) handleApproveCommand(ctx context.Context, convID, target string) (*models.Message, error) {
	u, err := s.resolveUser(ctx, target)
	if err != nil || u == nil {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "❌ User %q was not found.", "❌ کاربر %q پیدا نشد."), target), nil)
	}

	if u.IsApproved {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "ℹ️ **@%s** is already approved.", "ℹ️ کاربر **@%s** قبلاً تایید شده است."), u.Username), nil)
	}

	if err := s.store.SetUserApproved(ctx, u.ID, true); err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not approve user: ", "❌ خطا در تایید کاربر: ")+err.Error(), nil)
	}

	// Dispatch notification event to WebSocket
	ev := &models.EventOutbox{
		EventType:       "user.approved",
		RecipientUserID: u.ID,
		Payload:         fmt.Sprintf(`{"user_id":"%s","username":"%s","is_approved":true}`, u.ID, u.Username),
		CreatedAt:       time.Now().UTC(),
	}
	s.hub.PublishEvent(ev)

	text := fmt.Sprintf(botlocale.Text(ctx, "✅ **@%s approved.**\nThis user can now sign in.", "✅ **کاربر @%s با موفقیت تایید شد!**\nاکنون دسترسی این کاربر به سرور باز شده و می‌تواند وارد حساب خود شود."), u.Username)
	buttons := [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "👥 Other requests", "👥 مشاهده سایر درخواست‌ها"), Command: "/registrations"},
			{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleRejectCommand(ctx context.Context, convID, target string) (*models.Message, error) {
	u, err := s.resolveUser(ctx, target)
	if err != nil || u == nil {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "❌ User %q was not found.", "❌ کاربر %q پیدا نشد."), target), nil)
	}

	if u.IsOwner {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⛔ The server owner account cannot be rejected or deleted.", "⛔ امکان حذف یا رد حساب مالک سرور وجود ندارد."), nil)
	}

	username := u.Username
	if err := s.store.DeleteUser(ctx, u.ID); err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not delete user: ", "❌ خطا در حذف کاربر: ")+err.Error(), nil)
	}

	text := fmt.Sprintf(botlocale.Text(ctx, "❌ **Registration for @%s was rejected and the account removed.**", "❌ **درخواست ثبت‌نام کاربر @%s رد شد و حساب وی حذف گردید.**"), username)
	buttons := [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "🛡️ Other requests", "🛡️ سایر درخواست‌ها"), Command: "/registrations"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleBanCommand(ctx context.Context, convID, target string, ban bool) (*models.Message, error) {
	u, err := s.resolveUser(ctx, target)
	if err != nil || u == nil {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "❌ User %q was not found.", "❌ کاربر %q پیدا نشد."), target), nil)
	}

	if ban && u.IsOwner {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⛔ The server owner cannot be banned.", "⛔ امکان مسدود کردن مالک سرور وجود ندارد."), nil)
	}

	if err := s.store.SetUserBanned(ctx, u.ID, ban); err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not change ban status: ", "❌ خطا در تغییر وضعیت مسدودیت: ")+err.Error(), nil)
	}

	if ban {
		// Disconnect active WebSocket connections immediately
		s.hub.DisconnectUser(u.ID)
		text := fmt.Sprintf(botlocale.Text(ctx, "🚫 **@%s banned.**\nAll active sessions and connections were revoked.", "🚫 **کاربر @%s با موفقیت مسدود شد.**\nتمام نشست‌ها و اتصالات فعال کاربر بلافاصله قطع گردید."), u.Username)
		return s.SendBotMessage(ctx, convID, text, nil)
	}

	text := fmt.Sprintf(botlocale.Text(ctx, "✅ **@%s unbanned.**", "✅ **مسدودیت کاربر @%s برطرف شد.**"), u.Username)
	return s.SendBotMessage(ctx, convID, text, nil)
}

func (s *Service) handleBanIPCommand(ctx context.Context, convID, rawIP, reason string) (*models.Message, error) {
	targetIP := strings.TrimSpace(rawIP)
	if targetIP == "" {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Enter a valid IP address.", "❌ لطفاً یک آدرس آی‌پی معتبر وارد کنید."), nil)
	}
	if reason == "" {
		reason = botlocale.Text(ctx, "Spam or unauthorized registration", "ارسال اسپم یا ثبت‌نام غیرمجاز")
	}
	if err := s.store.BanIP(ctx, targetIP, reason, "MasterBot"); err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not ban IP: ", "❌ خطا در مسدودسازی آی‌پی: ")+err.Error(), nil)
	}

	text := fmt.Sprintf(botlocale.Text(ctx, "🚫 **IP `%s` was blocked.**\n📝 **Reason:** %s\nRegistration, login and connection requests from this address will be rejected.", "🚫 **آدرس آی‌پی `%s` با موفقیت در لیست مسدودی (Blacklist) قرار گرفت.**\n📝 **علت:** %s\nاز این پس تمامی درخواست‌های ثبت‌نام، ورود و اتصالات از این آی‌پی بلافاصله رد خواهد شد."), targetIP, reason)
	buttons := [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "📋 Blocked IP addresses", "📋 مشاهده لیست آی‌پی‌های مسدود"), Command: "/bannedips"},
			{Text: botlocale.Text(ctx, "🔓 Unban", "🔓 رفع مسدودیت"), Command: "/unbanip " + targetIP},
		},
	}
	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleUnbanIPCommand(ctx context.Context, convID, rawIP string) (*models.Message, error) {
	targetIP := strings.TrimSpace(rawIP)
	if targetIP == "" {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Enter a valid IP address.", "❌ لطفاً یک آدرس آی‌پی معتبر وارد کنید."), nil)
	}
	if err := s.store.UnbanIP(ctx, targetIP); err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not unblock IP: ", "❌ خطا در رفع مسدودیت آی‌پی: ")+err.Error(), nil)
	}

	text := fmt.Sprintf(botlocale.Text(ctx, "✅ **IP `%s` unblocked.**", "✅ **مسدودیت آدرس آی‌پی `%s` با موفقیت برطرف شد.**"), targetIP)
	buttons := [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "📋 Blocked IPs", "📋 لیست آی‌پی‌های مسدود"), Command: "/bannedips"},
		},
	}
	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleListBannedIPsCommand(ctx context.Context, convID string) (*models.Message, error) {
	banned, err := s.store.ListBannedIPs(ctx)
	if err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not load blocked addresses: ", "❌ خطا در دریافت لیست آی‌پی‌های مسدود شده: ")+err.Error(), nil)
	}
	if len(banned) == 0 {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "✅ No IP addresses are currently blocked.", "✅ در حال حاضر هیچ آدرس آی‌پی در لیست مسدودی (Blacklist) قرار ندارد."), nil)
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf(botlocale.Text(ctx, "🚫 **Blocked addresses (%d)**\n━━━━━━━━━━━━━━━━━━━\n", "🚫 **فهرست آی‌پی‌های مسدود شده سرور (%d مورد)**\n━━━━━━━━━━━━━━━━━━━\n"), len(banned)))

	var actionRows [][]BotActionButton
	maxShow := 15
	if len(banned) < maxShow {
		maxShow = len(banned)
	}

	for i := 0; i < maxShow; i++ {
		b := banned[i]
		sb.WriteString(fmt.Sprintf(botlocale.Text(ctx, "%d. 🌐 `%s`\n   📝 Reason: %s | Time: %s\n", "%d. 🌐 `%s`\n   📝 علت: %s | زمان: %s\n"),
			i+1, b.IP, b.Reason, b.CreatedAt.Format("2006-01-02 15:04")))

		if i < 4 {
			actionRows = append(actionRows, []BotActionButton{
				{Text: fmt.Sprintf(botlocale.Text(ctx, "🔓 Unban %s", "🔓 رفع مسدودیت %s"), b.IP), Command: "/unbanip " + b.IP},
			})
		}
	}

	if len(banned) > maxShow {
		sb.WriteString(fmt.Sprintf(botlocale.Text(ctx, "\n... and %d more blocked addresses.", "\n... و %d آی‌پی مسدود دیگر."), len(banned)-maxShow))
	}

	return s.SendBotMessage(ctx, convID, sb.String(), actionRows)
}

func (s *Service) handleChatsCommand(ctx context.Context, convID string) (*models.Message, error) {
	convs, err := s.store.ListAllConversations(ctx, 50)
	if err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not load conversations: ", "❌ خطا در دریافت چت‌ها: ")+err.Error(), [][]BotActionButton{
			{{Text: botlocale.Text(ctx, "📖 Help", "📖 راهنما"), Command: "/help"}},
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
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "💬 **No user conversations were found.**\n\nGroups, channels and direct chats will appear here when users create them.", "💬 **هیچ گفتگوی کاربری (گروه، کانال یا چت دونفره) در سرور یافت نشد.**\n\nپس از شروع گفتگو توسط کاربران، فهرست آن‌ها در اینجا نمایش داده خواهد شد."), [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "👥 Users", "👥 فهرست کاربران"), Command: "/users"},
				{Text: botlocale.Text(ctx, "📊 Live server statistics", "📊 آمار زنده سرور"), Command: "/stats"},
			},
			{
				{Text: botlocale.Text(ctx, "📖 Command help", "📖 راهنمای دستورات"), Command: "/help"},
			},
		})
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf(botlocale.Text(ctx, "💬 **Server conversations (%d)**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n", "💬 **فهرست گفتگوهای فعال سرور (%d گفتگو)**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"), len(userConvs)))

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
				title = fmt.Sprintf(botlocale.Text(ctx, "Conversation between %s and %s", "گفتگوی %s با %s"), memberNames[0], memberNames[1])
			} else if len(memberNames) == 1 {
				title = fmt.Sprintf(botlocale.Text(ctx, "Conversation with %s", "گفتگوی %s"), memberNames[0])
			} else {
				title = botlocale.Text(ctx, "Direct conversation", "گفتگوی دونفره")
			}
		} else if title == "" {
			title = fmt.Sprintf(botlocale.Text(ctx, "Conversation with %s", "گفتگوی %s"), c.Type)
		}

		typeFa := botlocale.Text(ctx, "Personal", "شخصی")
		if c.Type == "group" {
			typeFa = botlocale.Text(ctx, "Group", "گروه")
		} else if c.Type == "channel" {
			typeFa = botlocale.Text(ctx, "Channel", "کانال")
		}

		sb.WriteString(fmt.Sprintf(botlocale.Text(ctx, "%d. 📌 **%s**\n   🆔 `%s`\n   🏷️ Type: `%s` | Mode: `%s` | Members: %d\n\n", "%d. 📌 **%s**\n   🆔 `%s`\n   🏷️ نوع: `%s` | حالت: `%s` | اعضا: %d نفر\n\n"),
			i+1, title, c.ID, typeFa, c.SecurityMode, len(members)))

	}

	actionRows = append(actionRows, []BotActionButton{
		{Text: botlocale.Text(ctx, "🔄 Refresh conversations", "🔄 به‌روزرسانی چت‌ها"), Command: "/chats"},
		{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
	})

	return s.SendBotMessage(ctx, convID, sb.String(), actionRows)
}

func (s *Service) handleBroadcastCommand(ctx context.Context, convID, announcement string) (*models.Message, error) {
	if announcement == "" {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "The announcement cannot be empty.", "متن اعلان نمی‌تواند خالی باشد."), nil)
	}

	users, err := s.store.ListAllUsers(ctx)
	if err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not load users: ", "❌ خطا در دریافت کاربران: ")+err.Error(), nil)
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
			Payload:         fmt.Sprintf(botlocale.Text(ctx, "{\"title\":\"Server owner announcement\",\"message\":%q,\"created_at\":%q}", "{\"title\":\"اعلان رسمی مدیر سرور\",\"message\":%q,\"created_at\":%q}"), announcement, time.Now().UTC().Format(time.RFC3339)),
			CreatedAt:       time.Now().UTC(),
		}
		s.hub.PublishEvent(ev)
		sentCount++
	}

	text := fmt.Sprintf(botlocale.Text(ctx, "📢 **Announcement sent to %d active users.**\n\nMessage:\n> %s", "📢 **پیام همگانی با موفقیت برای %d کاربر فعال ارسال شد.**\n\nمتن ارسال شده:\n> %s"), sentCount, announcement)
	return s.SendBotMessage(ctx, convID, text, nil)
}

func (s *Service) handleApprovalSettingCommand(ctx context.Context, convID, arg string) (*models.Message, error) {
	val := strings.ToLower(arg)
	if val == "on" || val == "true" || val == "1" || val == "فعال" {
		_ = s.store.SetServerSetting(ctx, "registration_approval", "true")
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "🛡️ **Registration approval enabled.**\nNew users must be approved before signing in.", "🛡️ **تایید اجباری ثبت‌نام فعال شد.**\nاز این پس کاربران جدید تا زمان تایید توسط شما در ربات، امکان ورود نخواهند داشت."), [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "📝 Review registrations", "📝 بررسی ثبت‌نام‌ها"), Command: "/registrations"},
				{Text: botlocale.Text(ctx, "🔓 Disable (OFF)", "🔓 غیرفعال‌سازی (OFF)"), Command: "/approval off"},
			},
			{
				{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
			},
		})
	}
	if val == "off" || val == "false" || val == "0" || val == "غیرفعال" {
		_ = s.store.SetServerSetting(ctx, "registration_approval", "false")
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "🔓 **Registration approval disabled.**\nNew users can sign in immediately after registration.", "🔓 **تایید اجباری ثبت‌نام غیرفعال شد.**\nاز این پس کاربران جدید بلافاصله پس از ثبت‌نام وارد سیستم می‌شوند."), [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "🛡️ Enable again (ON)", "🛡️ فعال‌سازی مجدد (ON)"), Command: "/approval on"},
				{Text: botlocale.Text(ctx, "👥 Users", "👥 فهرست کاربران"), Command: "/users"},
			},
			{
				{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
			},
		})
	}
	return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "Usage: `/approval on` or `/approval off`", "نحوه استفاده: `/approval on` یا `/approval off`"), [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "🛡️ Enable (ON)", "🛡️ فعال‌سازی (ON)"), Command: "/approval on"},
			{Text: botlocale.Text(ctx, "🔓 Disable (OFF)", "🔓 غیرفعال‌سازی (OFF)"), Command: "/approval off"},
		},
	})
}

func (s *Service) handleMaintenanceSettingCommand(ctx context.Context, convID, arg string) (*models.Message, error) {
	val := strings.ToLower(arg)
	if val == "on" || val == "true" || val == "1" || val == "فعال" {
		_ = s.store.SetServerSetting(ctx, "maintenance_mode", "true")
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "🚧 **Maintenance mode enabled.**\nOnly the server owner has access.", "🚧 **حالت تعمیرات سرور فعال شد.**\nتنها مدیر سرور دسترسی خواهد داشت."), [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "✅ Disable maintenance mode", "✅ غیرفعال‌سازی تعمیرات (OFF)"), Command: "/maintenance off"},
				{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
			},
		})
	}
	if val == "off" || val == "false" || val == "0" || val == "غیرفعال" {
		_ = s.store.SetServerSetting(ctx, "maintenance_mode", "false")
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "🟢 **Maintenance mode disabled.**\nNormal user access restored.", "🟢 **حالت تعمیرات سرور غیرفعال شد.**\nدسترسی تمام کاربران به صورت عادی برقرار است."), [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "🚧 Enable maintenance (ON)", "🚧 فعال‌سازی تعمیرات (ON)"), Command: "/maintenance on"},
				{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
			},
		})
	}
	return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "Usage: `/maintenance on` or `/maintenance off`", "نحوه استفاده: `/maintenance on` یا `/maintenance off`"), [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "🚧 Enable (ON)", "🚧 فعال‌سازی (ON)"), Command: "/maintenance on"},
			{Text: botlocale.Text(ctx, "✅ Disable (OFF)", "✅ غیرفعال‌سازی (OFF)"), Command: "/maintenance off"},
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

func formatDuration(ctx context.Context, d time.Duration) string {
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
		parts = append(parts, fmt.Sprintf(botlocale.Text(ctx, "%d days", "%d روز"), days))
	}
	if hours > 0 {
		parts = append(parts, fmt.Sprintf(botlocale.Text(ctx, "%d hours", "%d ساعت"), hours))
	}
	if mins > 0 {
		parts = append(parts, fmt.Sprintf(botlocale.Text(ctx, "%d minutes", "%d دقیقه"), mins))
	}
	parts = append(parts, fmt.Sprintf(botlocale.Text(ctx, "%d seconds", "%d ثانیه"), secs))
	return strings.Join(parts, " ")
}

// ---------------------------------------------------------------------
// Database Backup Handler
// ---------------------------------------------------------------------

func (s *Service) handleBackupCommand(ctx context.Context, convID string) (*models.Message, error) {
	now := time.Now().UTC()
	filename := fmt.Sprintf("backup_senora_%s%s", now.Format("20060102_150405.000000000"), s.store.BackupFileExtension())
	backupPath := filepath.Join(storage.PrivateBackupDirectory(), filename)

	if err := s.store.BackupDatabase(ctx, backupPath); err != nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Database backup failed: ", "❌ خطا در تهیه نسخه پشتیبان پایگاه داده: ")+err.Error(), nil)
	}

	fi, err := os.Stat(backupPath)
	sizeStr := botlocale.Text(ctx, "Unknown", "نامشخص")
	if err == nil {
		sizeMB := float64(fi.Size()) / (1024 * 1024)
		if sizeMB < 0.1 {
			sizeStr = fmt.Sprintf("%.2f KB", float64(fi.Size())/1024)
		} else {
			sizeStr = fmt.Sprintf("%.2f MB", sizeMB)
		}
	}

	downloadPath := fmt.Sprintf("/api/v1/admin/backup/download?file=%s", filename)

	text := fmt.Sprintf(botlocale.Text(ctx, "💾 **Database backup created.**\n", "💾 **پشتیبان‌گیری کامل از پایگاه داده با موفقیت انجام شد!**\n")+
		"━━━━━━━━━━━━━━━━━━━\n"+
		botlocale.Text(ctx, "📁 **Filename:** `%s`\n", "📁 **نام فایل:** `%s`\n")+
		botlocale.Text(ctx, "📦 **Size:** %s\n", "📦 **حجم فایل:** %s\n")+
		botlocale.Text(ctx, "📍 **Private server path:** `%s`\n", "📍 **مسیر ذخیره در سرور:** `%s`\n")+
		botlocale.Text(ctx, "⏰ **Created:** %s\n", "⏰ **زمان ایجاد:** %s\n")+
		"━━━━━━━━━━━━━━━━━━━\n"+
		botlocale.Text(ctx, "A consistent database copy was saved privately. Verify restoration in a test database.\n", "نسخهٔ سازگار دیتابیس در پوشهٔ خصوصی ذخیره شد. برای اطمینان از بازیابی، آن را در دیتابیس آزمایشی بررسی کنید.\n")+
		botlocale.Text(ctx, "Download using this endpoint:\n", "جهت دانلود مستقیم فایل، می‌توانید از مسیر زیر استفاده فرمایید:\n")+
		"`%s`", filename, sizeStr, backupPath, now.Format("2006-01-02 15:04:05 UTC"), downloadPath)

	buttons := [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "📥 Download backup", "📥 دانلود مستقیم فایل بکاپ"), Command: downloadPath, Action: "download"},
			{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
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

	filePath, err := storage.ResolveBackup(targetFile)
	fi, statErr := os.Stat(filePath)
	if err == nil {
		err = statErr
	}

	if err != nil || targetFile == "." || targetFile == "" {
		entries, _ := os.ReadDir(storage.PrivateBackupDirectory())
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
			filePath, _ = storage.ResolveBackup(targetFile)
			fi, _ = os.Stat(filePath)
		} else {
			return s.handleBackupCommand(ctx, convID)
		}
	}

	sizeStr := botlocale.Text(ctx, "Unknown", "نامشخص")
	if fi != nil {
		sizeMB := float64(fi.Size()) / (1024 * 1024)
		if sizeMB < 0.1 {
			sizeStr = fmt.Sprintf("%.2f KB", float64(fi.Size())/1024)
		} else {
			sizeStr = fmt.Sprintf("%.2f MB", sizeMB)
		}
	}

	downloadPath := fmt.Sprintf("/api/v1/admin/backup/download?file=%s", targetFile)
	text := fmt.Sprintf(botlocale.Text(ctx, "📥 **Database backup ready:**\n", "📥 **فایل پشتیبان پایگاه داده آماده دانلود است:**\n")+
		"━━━━━━━━━━━━━━━━━━━\n"+
		botlocale.Text(ctx, "📁 **Filename:** `%s`\n", "📁 **نام فایل:** `%s`\n")+
		botlocale.Text(ctx, "📦 **Size:** %s\n", "📦 **حجم فایل:** %s\n")+
		botlocale.Text(ctx, "📍 **Path:** `%s`\n", "📍 **مسیر:** `%s`\n")+
		"━━━━━━━━━━━━━━━━━━━\n"+
		botlocale.Text(ctx, "Use the button below to download:", "جهت دانلود مستقیم، روی دکمه زیر کلیک فرمایید:"), targetFile, sizeStr, filePath)

	buttons := [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "📥 Download file", "📥 دانلود مستقیم فایل"), Command: downloadPath, Action: "download"},
			{Text: botlocale.Text(ctx, "💾 Create another backup", "💾 تهیه بکاپ جدید"), Command: "/backup"},
		},
	}
	return s.SendBotMessage(ctx, convID, text, buttons)
}

// ---------------------------------------------------------------------
// Dynamic Server Config Handlers
// ---------------------------------------------------------------------

func (s *Service) handleAutoBanCommand(ctx context.Context, convID, arg string) (*models.Message, error) {
	val := strings.ToLower(arg)
	if val == "on" || val == "true" || val == "1" || val == "فعال" {
		_ = s.store.SetServerSetting(ctx, "autoban_enabled", "true")
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "🛡️ **Automatic bans enabled.**\nIPs with repeated failed registration/login attempts will be blocked.", "🛡️ **سیستم مسدودسازی خودکار (Auto-Ban) فعال شد.**\nآی‌پی‌هایی که تلاش‌های مکرر ناموفق (ثبت‌نام/ورود) داشته باشند به صورت خودکار مسدود خواهند شد."), [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "🚫 Review blocked IPs", "🚫 بررسی آی‌پی‌های مسدود"), Command: "/bannedips"},
				{Text: botlocale.Text(ctx, "🔓 Disable (OFF)", "🔓 غیرفعال‌سازی (OFF)"), Command: "/autoban off"},
			},
			{
				{Text: botlocale.Text(ctx, "⚙️ Change failure threshold", "⚙️ تغییر آستانه خطا"), Command: "/setlimit 5"},
				{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
			},
		})
	}
	if val == "off" || val == "false" || val == "0" || val == "غیرفعال" {
		_ = s.store.SetServerSetting(ctx, "autoban_enabled", "false")
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "🔓 **Automatic bans disabled.**", "🔓 **سیستم مسدودسازی خودکار (Auto-Ban) غیرفعال شد.**"), [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "🛡️ Enable again (ON)", "🛡️ فعال‌سازی مجدد (ON)"), Command: "/autoban on"},
				{Text: botlocale.Text(ctx, "🚫 Blocked IPs", "🚫 آی‌پی‌های مسدود"), Command: "/bannedips"},
			},
		})
	}
	curr, _ := s.store.GetServerSetting(ctx, "autoban_enabled", "true")
	return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "🛡️ Automatic bans: **%s**\nChoose an option:", "🛡️ وضعیت فعلی سیستم مسدودسازی خودکار: **%s**\nجهت تغییر روی دکمه‌های زیر کلیک کنید:"), curr), [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "🛡️ Enable (ON)", "🛡️ فعال‌سازی (ON)"), Command: "/autoban on"},
			{Text: botlocale.Text(ctx, "🔓 Disable (OFF)", "🔓 غیرفعال‌سازی (OFF)"), Command: "/autoban off"},
		},
	})
}

func (s *Service) handleSetLimitCommand(ctx context.Context, convID, arg string) (*models.Message, error) {
	trimmed := strings.TrimSpace(arg)
	if trimmed == "" {
		curr, _ := s.store.GetServerSetting(ctx, "autoban_threshold", "5")
		return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "⚙️ Current threshold: **%s failed attempts per minute**\nChoose an option:", "⚙️ آستانه مجاز فعلی: **%s تلاش ناموفق در دقیقه**\nجهت تغییر روی گزینه‌های زیر کلیک کنید:"), curr), [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "⚡ 3 failures per minute", "⚡ ۳ خطا در دقیقه"), Command: "/setlimit 3"},
				{Text: botlocale.Text(ctx, "⚡ 5 failures per minute", "⚡ ۵ خطا در دقیقه"), Command: "/setlimit 5"},
				{Text: botlocale.Text(ctx, "⚡ 10 failures per minute", "⚡ ۱۰ خطا در دقیقه"), Command: "/setlimit 10"},
			},
		})
	}
	var num int
	if _, err := fmt.Sscanf(trimmed, "%d", &num); err != nil || num < 2 || num > 100 {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ Enter a number from 2 to 100, for example `/setlimit 5`.", "⚠️ لطفاً یک عدد معتبر بین 2 تا 100 وارد کنید. مثال: `/setlimit 5`"), [][]BotActionButton{
			{
				{Text: botlocale.Text(ctx, "⚡ 3 failures", "⚡ ۳ خطا"), Command: "/setlimit 3"},
				{Text: botlocale.Text(ctx, "⚡ 5 failures", "⚡ ۵ خطا"), Command: "/setlimit 5"},
				{Text: botlocale.Text(ctx, "⚡ 10 failures", "⚡ ۱۰ خطا"), Command: "/setlimit 10"},
			},
		})
	}

	_ = s.store.SetServerSetting(ctx, "autoban_threshold", fmt.Sprintf("%d", num))
	return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "✅ **Automatic ban threshold set to %d failed attempts per minute.**", "✅ **آستانه مسدودسازی خودکار به %d تلاش ناموفق در دقیقه تغییر یافت.**"), num), [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "🛡️ Automatic ban status", "🛡️ وضعیت Auto-Ban"), Command: "/autoban"},
			{Text: botlocale.Text(ctx, "🚫 Blocked IPs", "🚫 آی‌پی‌های مسدود"), Command: "/bannedips"},
			{Text: botlocale.Text(ctx, "📊 Server statistics", "📊 آمار سرور"), Command: "/stats"},
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

	report := fmt.Sprintf(botlocale.Text(ctx, "💓 **SENORA server pulse**\n━━━━━━━━━━━━━━━━━━━━\n👥 **Total users:** %d\n🧠 **RAM usage:** %d MB\n💾 **Database size:** %s\n⏱️ **Server status:** Running 🟢\n🕒 **Report time:** %s", "💓 **گزارش نبض سرور SENORA (Daily Pulse)**\n━━━━━━━━━━━━━━━━━━━━\n👥 **کل کاربران سیستم:** %d نفر\n🧠 **مصرف حافظه RAM:** %d MB\n💾 **حجم پایگاه‌داده دیسک:** %s\n⏱️ **وضعیت سرور:** فعال، آنلاین و پایدار 🟢\n🕒 **زمان گزارش:** %s\n\nتمامی سوکت‌ها، اتصالات WebRTC و پیام‌رسانی رمزنگاری‌شده E2EE در اوج سلامت عملیاتی هستند."),
		totalUsers,
		allocMB,
		dbSizeStr,
		time.Now().Format("2006-01-02 15:04:05"),
	)

	buttons := [][]BotActionButton{
		{
			{Text: botlocale.Text(ctx, "📊 Full server statistics", "📊 آمار کامل سرور"), Command: "/stats"},
			{Text: botlocale.Text(ctx, "🧹 Clean temporary files", "🧹 پاکسازی حافظه"), Command: "/cleanup"},
		},
		{
			{Text: botlocale.Text(ctx, "💾 Get backup", "💾 دریافت بکاپ"), Command: "/backup"},
			{Text: botlocale.Text(ctx, "🛡️ Automatic ban status", "🛡️ وضعیت اتوبن"), Command: "/autoban"},
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
						_, _ = s.handlePulseCommand(botlocale.WithUser(ctx, s.store, owner.ID), conv.ID)

						// Automated Daily Database Backup
						autoBackup, _ := s.store.GetServerSetting(ctx, "autobackup_enabled", "true")
						if autoBackup == "true" {
							_, _ = s.handleBackupCommand(botlocale.WithUser(ctx, s.store, owner.ID), conv.ID)
						}
					}
				}
			}
		}
	}()
}

func (s *Service) handleStorageCommand(ctx context.Context, convID string, parts []string) (*models.Message, error) {
	if s.fileStore == nil {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ Cloud storage management is not initialized.", "⚠️ ماژول مدیریت فضای ذخیره‌سازی ابری هنوز مقداردهی نشده است."), nil)
	}

	if len(parts) > 1 && (parts[1] == "analytics" || parts[1] == "تحلیل" || parts[1] == "آمار" || parts[1] == "breakdown") {
		analytics, aErr := s.store.GetStorageAnalytics(ctx)
		if aErr != nil {
			return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "❌ Could not load storage statistics.", "❌ خطا در بازیابی آمار و تحلیل فضای مصرفی دیتابیس."), nil)
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

		text := fmt.Sprintf(botlocale.Text(ctx, "📈 **Media storage analytics**\n\n📦 **Total media:** %s (%d files)\n\n🖼️ **Images**\n• Files: %d\n• Size: %s\n\n🎬 **Videos**\n• Files: %d\n• Size: %s\n\n🎙️ **Voice and audio**\n• Files: %d\n• Size: %s\n\n📁 **Documents and other files**\n• Files: %d\n• Size: %s\n\n☁️ **Storage locations**\n• Arvan S3: %s (%d files)\n• Local server: %s (%d files)", "📈 **تحلیل مصرف فضای ذخیره‌سازی رسانه‌ها (Storage Analytics)**\n\n📦 **کل حجم مصرفی رسانه‌ها:** %s (%d فایل ثبت‌شده)\n\n🖼️ **تصاویر و عکس‌ها (Images):**\n• تعداد: %d فایل\n• حجم کل: %s\n\n🎬 **ویدیوها و فیلم‌ها (Videos):**\n• تعداد: %d فایل\n• حجم کل: %s\n\n🎙️ **ویس‌ها و فایل‌های صوتی (Voice & Audio):**\n• تعداد: %d فایل\n• حجم کل: %s\n\n📁 **اسناد، گیف‌ها و سایر فایل‌ها (Documents & Others):**\n• تعداد: %d فایل\n• حجم کل: %s\n\n☁️ **تفکیک زیرساخت فیزیکی:**\n• ذخیره‌سازی ابری آروان S3: %s (%d فایل)\n• ذخیره‌ساز محلی سرور: %s (%d فایل)"),
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
				{Text: botlocale.Text(ctx, "☁️ Arvan S3 health", "☁️ وضعیت سلامت آروان S3"), Command: "/storage"},
				{Text: botlocale.Text(ctx, "🔄 Test connection", "🔄 تست پروب اتصال"), Command: "/storage probe"},
			},
			{
				{Text: botlocale.Text(ctx, "🧹 Clean temporary files", "🧹 پاکسازی کش و فایل‌های زائد"), Command: "/cleanup"},
				{Text: botlocale.Text(ctx, "💾 Database backup", "💾 نسخه پشتیبان دیتابیس"), Command: "/backup"},
			},
		}
		return s.SendBotMessage(ctx, convID, text, buttons)
	}

	if len(parts) > 1 && (parts[1] == "probe" || parts[1] == "test" || parts[1] == "تست") {
		_ = s.fileStore.ProbeHealth(ctx)
	}

	status := s.fileStore.GetStatus()

	engineLabel := botlocale.Text(ctx, "🟢 ArvanCloud S3", "🟢 ابر آروان (ArvanCloud S3 - مالتی‌زون ایران مرکز ۱)")
	if status.ActiveEngine == "local_fallback" {
		engineLabel = botlocale.Text(ctx, "🟡 Local server storage (fallback)", "🟡 ذخیره‌ساز محلی سرور (Local Server Fallback)")
	}

	healthStatus := botlocale.Text(ctx, "🟢 Online", "🟢 آنلاین و عملیاتی")
	if !status.S3Healthy {
		healthStatus = botlocale.Text(ctx, "🔴 Unreachable (automatic fallback active)", "🔴 غیرقابل دسترس (حالت Failover خودکار فعال است)")
	}

	lastProbeStr := botlocale.Text(ctx, "Not checked yet", "هنوز تستی انجام نشده")
	if status.LastProbeTime != nil {
		lastProbeStr = status.LastProbeTime.Local().Format("15:04:05")
	}

	errDetail := ""
	if status.LastError != "" {
		errDetail = fmt.Sprintf(botlocale.Text(ctx, "\n⚠️ **Last status/error:** `%s`", "\n⚠️ **آخرین پیام/خطا:** `%s`"), status.LastError)
	}

	text := fmt.Sprintf(botlocale.Text(ctx, "☁️ **Storage status**\n\n🔹 **Active backend:** %s\n🔹 **Arvan S3 health:** %s\n🔹 **Bucket:** ", "☁️ **وضعیت زیرساخت ذخیره‌سازی ابری (Storage Status)**\n\n🔹 **موتور فعال فعلی:** %s\n🔹 **وضعیت سلامت Arvan S3:** %s\n🔹 **صندوقچه (Bucket):** ")+"`%s`"+botlocale.Text(ctx, "\n🔹 **Region:** ", "\n🔹 **منطقه (Region):** ")+"`%s`"+botlocale.Text(ctx, " (Multi-Zone)\n🔹 **Endpoint:** ", " (ایران مرکز ۱ - Multi-Zone)\n🔹 **اندپوینت (Endpoint):** ")+"`%s`"+botlocale.Text(ctx, "\n🔹 **Latency:** %d ms\n🔹 **Last automatic check:** %s\n🔹 **Cloud uploads:** %d files\n🔹 **Local uploads:** %d files\n🔹 **Automatic failovers:** %d%s\n\n💡 When S3 is unreachable, uploads use local storage. When S3 recovers, new uploads use S3 again.", "\n🔹 **تاخیر پینگ:** %d میلی‌ثانیه\n🔹 **آخرین بررسی خودکار:** %s\n🔹 **کل آپلودهای ابری آروان:** %d فایل\n🔹 **کل آپلودهای لوکال سرور:** %d فایل\n🔹 **سوئیچ‌های خودکار Failover:** %d بار%s\n\n💡 *پایداری تضمین‌شده:* در صورت قطع ارتباط با آروان، فایل‌ها فوراً روی دیسک محلی سرور ذخیره می‌شوند و به محض اتصال مجدد، سیستم به صورت خودکار به آروان بازمی‌گردد."),
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
			{Text: botlocale.Text(ctx, "📈 Storage analytics", "📈 تحلیل فضای مصرفی"), Command: "/storage analytics"},
			{Text: botlocale.Text(ctx, "🔄 Probe Arvan connection", "🔄 تست و پروب اتصال آروان"), Command: "/storage probe"},
		},
		{
			{Text: botlocale.Text(ctx, "🧹 Clean cache and temporary files", "🧹 پاکسازی حافظه و کش"), Command: "/cleanup"},
			{Text: botlocale.Text(ctx, "💾 Back up now", "💾 نسخه پشتیبان فوری"), Command: "/backup"},
		},
	}

	return s.SendBotMessage(ctx, convID, text, buttons)
}

func (s *Service) handleResetPasswordCommand(ctx context.Context, convID, identifier, newPassword string) (*models.Message, error) {
	if len(newPassword) < 6 {
		return s.SendBotMessage(ctx, convID, botlocale.Text(ctx, "⚠️ New passwords must contain at least 6 characters.", "⚠️ خطا: رمز عبور جدید باید حداقل ۶ کاراکتر باشد."), nil)
	}

	cleanUser := strings.TrimPrefix(identifier, "@")
	user, err := s.store.GetUserByUsername(ctx, cleanUser)
	if err != nil || user == nil {
		user, err = s.store.GetUserByID(ctx, identifier)
		if err != nil || user == nil {
			return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "❌ No user with ID or username `%s` was found.", "❌ کاربر با شناسه یا نام کاربری `%s` در پایگاه داده یافت نشد."), identifier), nil)
		}
	}

	// Hash password with Argon2id using standard production parameters
	newHash, err := auth.HashPassword(newPassword, nil)
	if err != nil {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "❌ Argon2id password hashing failed: %v", "❌ خطا در رمزنگاری پسورد با Argon2id: %v"), err), nil)
	}

	if err := s.store.UpdateUserPassword(ctx, user.ID, newHash); err != nil {
		return s.SendBotMessage(ctx, convID, fmt.Sprintf(botlocale.Text(ctx, "❌ Could not save password: %v", "❌ خطا در ذخیره‌سازی رمز عبور در دیتابیس: %v"), err), nil)
	}

	msg := fmt.Sprintf(botlocale.Text(ctx, "🔑 **User password updated.**\n\n", "🔑 **رمز عبور کاربر با موفقیت در دیتابیس تغییر یافت!**\n\n")+
		botlocale.Text(ctx, "👤 **User:** @%s (%s)\n", "👤 **کاربر:** @%s (%s)\n")+
		botlocale.Text(ctx, "🔒 **New password:** `%s`\n\n", "🔒 **رمز عبور جدید:** `%s`\n\n")+
		botlocale.Text(ctx, "Share this password privately with the user. They can sign in and change it in Settings.", "💡 می‌توانید این رمز جدید را به کاربر اعلام نمایید تا بتواند فوراً وارد حساب کاربری خود شود. کاربر همچنین می‌تواند پس از ورود، از بخش تنظیمات رمز دلخواه دیگری را تنظیم کند."),
		user.Username, user.DisplayName, newPassword)

	return s.SendBotMessage(ctx, convID, msg, nil)
}
