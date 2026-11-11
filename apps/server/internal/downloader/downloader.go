package downloader

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"senora/server/internal/botlocale"
	"senora/server/internal/conversations"
	"senora/server/internal/events"
	"senora/server/internal/filestore"
	"senora/server/internal/messages"
	"senora/server/internal/models"
	"senora/server/internal/netguard"
	"senora/server/internal/storage"
)

// DownloadRequest represents a parsed /dl command.
type DownloadRequest struct {
	TargetURL    string
	ProxyTrusted bool
	ProxyURL     string
	Quality      string // default "720"
}

// ProxyTestResult holds the health check report of a proxy.
type ProxyTestResult struct {
	ProxyURL     string        `json:"proxy_url"`
	Healthy      bool          `json:"healthy"`
	TCPReachable bool          `json:"tcp_reachable"`
	Latency      time.Duration `json:"latency"`
	HTTPStatus   string        `json:"http_status"`
	HTTPSStatus  string        `json:"https_status"`
	PublicIP     string        `json:"public_ip"`
	Country      string        `json:"country,omitempty"`
	CountryCode  string        `json:"country_code,omitempty"`
	City         string        `json:"city,omitempty"`
	ISP          string        `json:"isp,omitempty"`
	ErrorMessage string        `json:"error_message,omitempty"`
}

// Service manages video download operations, proxy health checks, and chat integrations.
type Service struct {
	// HTTPClient is an explicitly supplied trusted transport for embedded use.
	// A nil client uses the public-network guard and the external downloader.
	HTTPClient *http.Client
	store      storage.Store
	fileStore  *filestore.StorageManager
	msgs       *messages.Service
	convs      *conversations.Service
	hub        *events.Hub
	sem        chan struct{} // limits concurrent downloads to protect server memory/CPU
}

// NewService creates a new downloader service instance.
func NewService(
	store storage.Store,
	fs *filestore.StorageManager,
	msgs *messages.Service,
	convs *conversations.Service,
	hub *events.Hub,
) *Service {
	return &Service{
		store:     store,
		fileStore: fs,
		msgs:      msgs,
		convs:     convs,
		hub:       hub,
		sem:       make(chan struct{}, 1), // one active job reserves disk space for download and merging
	}
}

// cleanURLToken removes markdown wrappers like [text](url), enclosing brackets [url], <url>, quotes, and trailing slashes.
func cleanURLToken(token string) string {
	s := strings.TrimSpace(token)
	// Markdown link: [text](target_url) -> target_url
	if strings.HasPrefix(s, "[") && strings.Contains(s, "](") && strings.HasSuffix(s, ")") {
		idx := strings.Index(s, "](")
		s = s[idx+2 : len(s)-1]
	}
	// Strip enclosing brackets: [url] -> url, <url> -> url, "url" -> url
	s = strings.Trim(s, "[]()<>{}\"'`")
	s = strings.TrimSpace(s)
	return s
}

// ExtractText extracts plain text from either JSON payload or raw string.
func ExtractText(ciphertext string) string {
	trimmed := strings.TrimSpace(ciphertext)
	if strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}") {
		var payload struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal([]byte(trimmed), &payload); err == nil && payload.Text != "" {
			return strings.TrimSpace(payload.Text)
		}
	}
	return trimmed
}

// IsDownloadCommand checks whether the message is a video download request.
func (s *Service) IsDownloadCommand(ciphertext string) bool {
	txt := ExtractText(ciphertext)
	fields := strings.Fields(txt)
	if len(fields) == 0 {
		return false
	}
	first := strings.ToLower(fields[0])
	if first == "/dl" || first == "/download" || first == "/ytdlp" || first == "/updatedl" || first == "/dl-update" ||
		strings.HasPrefix(txt, "دانلود ویدیو") || strings.HasPrefix(txt, "دانلود ") ||
		strings.HasPrefix(txt, "آپدیت دانلودر") || strings.HasPrefix(txt, "بروزرسانی دانلودر") {
		return true
	}
	return false
}

// IsProxyTestCommand checks whether the message is a proxy test command.
func (s *Service) IsProxyTestCommand(ciphertext string) bool {
	txt := ExtractText(ciphertext)
	fields := strings.Fields(txt)
	if len(fields) == 0 {
		return false
	}
	first := strings.ToLower(fields[0])
	if first == "/proxy" || first == "/testproxy" || first == "/checkproxy" ||
		first == "proxy" || strings.HasPrefix(txt, "تست پروکسی") || strings.HasPrefix(txt, "بررسی پروکسی") {
		return true
	}
	return false
}

// IsSyncS3Command checks whether the message is a request to migrate/sync files to ArvanCloud S3.
func (s *Service) IsSyncS3Command(ciphertext string) bool {
	txt := ExtractText(ciphertext)
	fields := strings.Fields(txt)
	if len(fields) == 0 {
		return false
	}
	first := strings.ToLower(fields[0])
	if first == "/sync_s3" || first == "/sync-s3" || first == "/migrate_s3" || first == "/migrate-s3" ||
		first == "/arvan" || first == "/s3sync" || strings.HasPrefix(txt, "انتقال به آروان") || strings.HasPrefix(txt, "سینک آروان") {
		return true
	}
	return false
}

// ParseDownloadCommand parses the command arguments: /dl [link] [proxy] [quality]
func ParseDownloadCommand(rawText string) (*DownloadRequest, error) {
	txt := ExtractText(rawText)
	fields := strings.Fields(txt)
	if len(fields) == 0 {
		return nil, errors.New("empty command")
	}

	first := strings.ToLower(fields[0])
	var args []string
	if first == "/dl" || first == "/download" {
		args = fields[1:]
	} else if strings.HasPrefix(first, "دانلود") {
		if len(fields) > 1 && (fields[1] == "ویدیو" || fields[1] == "ویدئو" || fields[1] == "فیلم") {
			args = fields[2:]
		} else {
			args = fields[1:]
		}
	} else {
		return nil, errors.New("not a download command")
	}

	if len(args) == 0 {
		return nil, errors.New("missing_url")
	}

	req := &DownloadRequest{
		Quality: "720", // Default 720p quality
	}

	for _, rawArg := range args {
		argTrim := cleanURLToken(rawArg)
		if argTrim == "" {
			continue
		}
		lower := strings.ToLower(argTrim)

		// 1. SOCKS proxy check
		if strings.HasPrefix(lower, "socks5://") || strings.HasPrefix(lower, "socks5h://") || strings.HasPrefix(lower, "socks4://") {
			req.ProxyURL = strings.TrimRight(argTrim, "/")
			continue
		}

		// 2. HTTP/HTTPS check
		if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
			if req.TargetURL == "" {
				req.TargetURL = argTrim
			} else if req.ProxyURL == "" {
				req.ProxyURL = strings.TrimRight(argTrim, "/")
			}
			continue
		}

		// 3. Quality specifiers (e.g. 1080, 720, 480, 360, 240, 1080p, audio, mp3, best)
		if _, err := strconv.Atoi(lower); err == nil && len(lower) <= 4 {
			req.Quality = lower
			continue
		}
		if lower == "1080p" || lower == "720p" || lower == "480p" || lower == "360p" {
			req.Quality = strings.TrimSuffix(lower, "p")
			continue
		}
		if lower == "audio" || lower == "mp3" || lower == "best" {
			req.Quality = lower
			continue
		}

		// 4. Proxy without scheme (e.g. 127.0.0.1:10808 or user:pass@host:port)
		if strings.Contains(argTrim, ":") && req.ProxyURL == "" {
			req.ProxyURL = "http://" + strings.TrimRight(argTrim, "/")
			continue
		}

		// 5. Fallback for URL if not set yet
		if req.TargetURL == "" {
			req.TargetURL = argTrim
		}
	}

	if req.TargetURL == "" {
		return nil, errors.New("missing_url")
	}

	return req, nil
}

// TestProxy evaluates the health, latency, HTTP, and HTTPS capabilities of a proxy.
func (s *Service) TestProxy(ctx context.Context, proxyRaw string) *ProxyTestResult {
	proxyClean := cleanURLToken(proxyRaw)
	if proxyClean == "" {
		if defProxy, err := s.store.GetServerSetting(ctx, "default_downloader_proxy", ""); err == nil && defProxy != "" {
			proxyClean = defProxy
		} else if envProxy := os.Getenv("ALL_PROXY"); envProxy != "" {
			proxyClean = envProxy
		} else if envProxy := os.Getenv("HTTPS_PROXY"); envProxy != "" {
			proxyClean = envProxy
		} else if envProxy := os.Getenv("HTTP_PROXY"); envProxy != "" {
			proxyClean = envProxy
		}
	}

	if proxyClean == "" {
		return &ProxyTestResult{
			Healthy:      false,
			ErrorMessage: botlocale.Text(ctx, "No proxy address supplied.\nUsage:\n`/proxy <proxy_url>`\nExample:\n`/testproxy http://user:pass@ip:port`", "آدرس پروکسی مشخص نشده است.\nنحوه استفاده:\n`/proxy [آدرس_پروکسی]`\nیا تست با دستور:\n`/testproxy http://user:pass@ip:port`"),
		}
	}

	if !strings.Contains(proxyClean, "://") {
		proxyClean = "http://" + proxyClean
	}
	proxyClean = strings.TrimRight(proxyClean, "/")

	res := &ProxyTestResult{
		ProxyURL: proxyClean,
	}

	parsedProxy, err := url.Parse(proxyClean)
	if err != nil {
		res.ErrorMessage = botlocale.Text(ctx, "Invalid proxy URL: ", "فرمت آدرس پروکسی نامعتبر است: ") + err.Error()
		return res
	}

	// 1. TCP connection check to proxy host:port
	hostPort := parsedProxy.Host
	if !strings.Contains(hostPort, ":") {
		if strings.HasPrefix(parsedProxy.Scheme, "socks") {
			hostPort += ":1080"
		} else {
			hostPort += ":8080"
		}
	}

	tcpStart := time.Now()
	conn, err := net.DialTimeout("tcp", hostPort, 5*time.Second)
	if err != nil {
		res.ErrorMessage = fmt.Sprintf(botlocale.Text(ctx, "TCP connection to proxy failed (closed port or unreachable server): %v", "ارتباط TCP با سرور پروکسی برقرار نشد (پورت بسته است یا سرور در دسترس نیست): %v"), err)
		return res
	}
	res.TCPReachable = true
	res.Latency = time.Since(tcpStart)
	_ = conn.Close()

	// 2. HTTP connectivity test (http://api.ipify.org)
	transport := &http.Transport{
		Proxy:               http.ProxyURL(parsedProxy),
		TLSHandshakeTimeout: 8 * time.Second,
		DisableKeepAlives:   true,
	}
	httpClient := &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
	}

	httpReq, _ := http.NewRequestWithContext(ctx, "GET", "http://api.ipify.org", nil)
	httpReq.Header.Set("User-Agent", "SENORA-ProxyChecker/1.0")
	httpResp, httpErr := httpClient.Do(httpReq)
	if httpErr == nil {
		defer httpResp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(httpResp.Body, 1024))
		ip := strings.TrimSpace(string(body))
		res.HTTPStatus = fmt.Sprintf("OK (%d)", httpResp.StatusCode)
		if net.ParseIP(ip) != nil {
			res.PublicIP = ip
		}
	} else {
		res.HTTPStatus = fmt.Sprintf(botlocale.Text(ctx, "Error: %v", "خطا: %v"), httpErr)
	}

	// 3. HTTPS / CONNECT tunnel test (https://api.ipify.org)
	httpsReq, _ := http.NewRequestWithContext(ctx, "GET", "https://api.ipify.org", nil)
	httpsReq.Header.Set("User-Agent", "SENORA-ProxyChecker/1.0")
	httpsResp, httpsErr := httpClient.Do(httpsReq)
	if httpsErr == nil {
		defer httpsResp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(httpsResp.Body, 1024))
		ip := strings.TrimSpace(string(body))
		res.HTTPSStatus = fmt.Sprintf("OK (%d)", httpsResp.StatusCode)
		if res.PublicIP == "" && net.ParseIP(ip) != nil {
			res.PublicIP = ip
		}
		res.Healthy = true
	} else {
		res.HTTPSStatus = fmt.Sprintf(botlocale.Text(ctx, "HTTPS tunnel failed: %v", "خطا در برقراری تونل امن HTTPS: %v"), httpsErr)
	}

	// 4. GeoIP lookup for country, city, and ISP detection
	if res.PublicIP != "" {
		geoReq, _ := http.NewRequestWithContext(ctx, "GET", "http://ip-api.com/json/"+res.PublicIP, nil)
		geoClient := &http.Client{Timeout: 3 * time.Second}
		if geoResp, geoErr := geoClient.Do(geoReq); geoErr == nil {
			defer geoResp.Body.Close()
			var geoData struct {
				Country     string `json:"country"`
				CountryCode string `json:"countryCode"`
				City        string `json:"city"`
				ISP         string `json:"isp"`
			}
			if err := json.NewDecoder(geoResp.Body).Decode(&geoData); err == nil && geoData.Country != "" {
				res.Country = geoData.Country
				res.CountryCode = geoData.CountryCode
				res.City = geoData.City
				res.ISP = geoData.ISP
			}
		}
	}

	return res
}

// HandleProxyTest runs proxy diagnostics and reports results in Persian.
func (s *Service) HandleProxyTest(ctx context.Context, convID, senderID, rawCommand, replyToMsgID string) {
	ctx = botlocale.WithUser(ctx, s.store, senderID)
	if owner, err := s.store.IsUserOwner(ctx, senderID); err != nil || !owner {
		s.editOrSendError(ctx, convID, senderID, nil, botlocale.Text(ctx, "This operation is available only to the server owner.", "این عملیات فقط برای مالک سرور مجاز است."))
		return
	}
	txt := ExtractText(rawCommand)
	fields := strings.Fields(txt)
	var proxyArg string
	for _, f := range fields[1:] {
		fClean := cleanURLToken(f)
		if strings.HasPrefix(strings.ToLower(fClean), "http://") ||
			strings.HasPrefix(strings.ToLower(fClean), "https://") ||
			strings.HasPrefix(strings.ToLower(fClean), "socks") ||
			strings.Contains(fClean, ":") {
			proxyArg = fClean
			break
		}
	}

	// Send initial checking message
	statusMsg, _ := s.sendTextMessage(ctx, convID, senderID, botlocale.Text(ctx, "🔍 **Testing proxy connectivity...**\nPlease wait.", "🔍 **در حال تست و بررسی اتصال پروکسی...**\nلطفاً چند لحظه شکیبا باشید."), replyToMsgID)

	res := s.TestProxy(ctx, proxyArg)

	var report string
	if res.Healthy {
		geoText := ""
		if res.Country != "" {
			geoText = fmt.Sprintf(botlocale.Text(ctx, "• 🌍 Location: `%s - %s (%s)`\n• 🏢 Datacenter / ISP: `%s`\n", "• 🌍 موقعیت سرور: `%s - %s (%s)`\n• 🏢 دیتاسنتر / ISP: `%s`\n"),
				res.Country, res.City, res.CountryCode, res.ISP)
		}
		turkeyWarn := ""
		if strings.EqualFold(res.CountryCode, "TR") {
			turkeyWarn = botlocale.Text(ctx, "\n⚠️ Access to some websites may be restricted by the proxy network or region. Check the network if the requested website is unreachable.\n", "\n⚠️ **توجه درباره موقعیت ترکیه:** در کشور ترکیه سایت‌های بزرگسالان (PornHub و ...) طبق قوانین دولتی BTK مسدود هستند. برای دانلود از یوتیوب یا سایر سایت‌ها مناسب است، اما برای PornHub باید از پروکسی کشورهای اروپایی (آلمان، هلند، فرانسه و ...) استفاده کنید.\n")
		}
		report = fmt.Sprintf(botlocale.Text(ctx, "🟢 **Proxy test successful.**\n\n", "🟢 **تست پروکسی: موفق و کاملاً فعال!**\n\n")+
			botlocale.Text(ctx, "• 🛡️ Proxy: `%s`\n", "• 🛡️ آدرس پروکسی: `%s`\n")+
			botlocale.Text(ctx, "• ⚡ Latency: `%d ms`\n", "• ⚡ زمان پاسخ (Ping): `%d میلی‌ثانیه`\n")+
			botlocale.Text(ctx, "• 🌐 Outbound IP: `%s`\n", "• 🌐 آی‌پی خروجی: `%s`\n")+
			"%s"+
			botlocale.Text(ctx, "• 🔒 HTTPS: ✅ (%s)\n", "• 🔒 پشتیبانی از HTTPS: ✅ موفق (%s)\n")+
			botlocale.Text(ctx, "• 📡 HTTP: ✅ (%s)\n", "• 📡 پروتکل HTTP: ✅ موفق (%s)\n")+
			"%s\n"+
			botlocale.Text(ctx, "💡 Use this proxy to download media:\n`/dl <url> %s`", "💡 *نتیجه:* این پروکسی سالم است و می‌توانید با دستور زیر ویدیو دانلود کنید:\n`/dl [لینک] %s`"),
			res.ProxyURL, res.Latency.Milliseconds(), res.PublicIP, geoText, res.HTTPSStatus, res.HTTPStatus, turkeyWarn, res.ProxyURL)
	} else if res.TCPReachable {
		report = fmt.Sprintf(botlocale.Text(ctx, "🟡 **Proxy partially available (HTTPS unsupported).**\n\n", "🟡 **هشدار: پروکسی نیمه‌فعال است (عدم پشتیبانی از HTTPS)!**\n\n")+
			botlocale.Text(ctx, "• 🛡️ Proxy: `%s`\n", "• 🛡️ آدرس پروکسی: `%s`\n")+
			botlocale.Text(ctx, "• ⚡ TCP latency: `%d ms`\n", "• ⚡ زمان پاسخ TCP: `%d میلی‌ثانیه`\n")+
			botlocale.Text(ctx, "• 🌐 HTTP IP: `%s`\n", "• 🌐 آی‌پی HTTP: `%s`\n")+
			botlocale.Text(ctx, "• 📡 HTTP request: %s\n", "• 📡 درخواست HTTP: %s\n")+
			botlocale.Text(ctx, "• ❌ HTTPS request: %s\n\n", "• ❌ درخواست HTTPS: %s\n\n")+
			botlocale.Text(ctx, "⚠️ This proxy supports HTTP requests but cannot establish an HTTPS CONNECT tunnel, or port 443 is blocked.\n\n", "⚠️ **دلیل خطا:** این پروکسی به درخواست‌های ساده HTTP پاسخ می‌دهد، اما قابلیت تونل امن HTTPS (CONNECT) را پشتیبانی نمی‌کند یا دسترسی به پورت ۴۴۳ را مسدود کرده است.\n\n")+
			botlocale.Text(ctx, "💡 Most video websites use HTTPS. Use a SOCKS5 proxy or an HTTP proxy that supports HTTPS CONNECT.", "💡 *راه حل:* از آنجا که یوتیوب، اینستاگرام، توییتر و اکثر سایت‌ها از HTTPS استفاده می‌کنند، برای دانلود ویدیو به یک پروکسی با پشتیبانی کامل از HTTPS یا پروکسی **SOCKS5** نیاز دارید."),
			res.ProxyURL, res.Latency.Milliseconds(), res.PublicIP, res.HTTPStatus, res.HTTPSStatus)
	} else {
		report = fmt.Sprintf(botlocale.Text(ctx, "🔴 **Proxy unavailable.**\n\n", "🔴 **تست پروکسی: ناموفق و غیرقابل دسترس!**\n\n")+
			botlocale.Text(ctx, "• 🛡️ Address: `%s`\n", "• 🛡️ آدرس ورودی: `%s`\n")+
			botlocale.Text(ctx, "• ❌ Error: `%s`\n\n", "• ❌ علت خطا: `%s`\n\n")+
			botlocale.Text(ctx, "💡 Check the proxy IP, port, username and password.", "💡 لطفاً از صحت IP، پورت و اطلاعات احراز هویت (یوزرنیم و پسورد) پروکسی اطمینان حاصل کنید."),
			res.ProxyURL, res.ErrorMessage)
	}

	if statusMsg != nil {
		s.editOrSendError(ctx, convID, senderID, statusMsg, report)
	} else {
		_, _ = s.sendTextMessage(ctx, convID, senderID, report, replyToMsgID)
	}
}

// HandleDownload performs the entire download lifecycle asynchronously.
func (s *Service) HandleDownload(ctx context.Context, convID, senderID, rawCommand, replyToMsgID string) {
	ctx = botlocale.WithUser(ctx, s.store, senderID)
	txt := ExtractText(rawCommand)
	fields := strings.Fields(txt)
	if (len(fields) > 1 && (strings.ToLower(fields[1]) == "update" || strings.ToLower(fields[1]) == "آپدیت")) ||
		strings.Contains(txt, "/updatedl") || strings.Contains(txt, "/dl-update") || strings.Contains(txt, "آپدیت دانلودر") {
		s.HandleUpdateYtDlp(ctx, convID, senderID, replyToMsgID)
		return
	}

	req, err := ParseDownloadCommand(rawCommand)
	if err != nil {
		if err.Error() == "missing_url" {
			helpText := botlocale.Text(ctx, "📥 **SENORA media downloader**\n\n", "📥 **راهنمای دانلود ویدیو (SENORADownloader)**\n\n") +
				botlocale.Text(ctx, "🔹 **Usage:**\n", "🔹 **فرمت دستور:**\n") +
				botlocale.Text(ctx, "`/dl <url> [proxy] [quality]`\n\n", "`/dl [لینک] [پروکسی]`\n\n") +
				botlocale.Text(ctx, "📌 **Examples:**\n", "📌 **مثال‌ها:**\n") +
				"• `/dl https://youtu.be/dQw4w9WgXcQ`\n" +
				"• `/dl https://youtu.be/dQw4w9WgXcQ socks5://127.0.0.1:10808`\n" +
				"• `/dl https://instagram.com/reel/xxxx http://127.0.0.1:8080 720`\n\n" +
				botlocale.Text(ctx, "⚙️ **Default quality:** 720p. Options include 1080, 480, 360 or audio.\n", "⚙️ **کیفیت پیش‌فرض:** 720p (قابل تغییر به 1080، 480، 360 یا audio)\n") +
				botlocale.Text(ctx, "🌐 Supports sites handled by yt-dlp and direct video URLs.\n", "🌐 پشتیبانی کامل از یوتیوب، اینستاگرام، توییتر (X)، تیک‌تاک و تمام لینک‌های مستقیم ویدیو.\n") +
				botlocale.Text(ctx, "🔍 Test proxy: `/proxy <proxy_url>`\n", "🔍 بررسی سلامت پروکسی: `/proxy [آدرس_پروکسی]`\n") +
				botlocale.Text(ctx, "🔄 Update downloader: `/dl update`", "🔄 آپدیت هسته موتور دانلودر: `/dl update`")
			_, _ = s.sendTextMessage(ctx, convID, senderID, helpText, replyToMsgID)
		}
		return
	}

	// Fallback to server default proxy or environment proxy if none was provided
	if req.ProxyURL == "" {
		req.ProxyTrusted = true
		if defProxy, err := s.store.GetServerSetting(ctx, "default_downloader_proxy", ""); err == nil && defProxy != "" {
			req.ProxyURL = defProxy
		} else if envProxy := os.Getenv("ALL_PROXY"); envProxy != "" {
			req.ProxyURL = envProxy
		} else if envProxy := os.Getenv("HTTPS_PROXY"); envProxy != "" {
			req.ProxyURL = envProxy
		} else if envProxy := os.Getenv("HTTP_PROXY"); envProxy != "" {
			req.ProxyURL = envProxy
		}
	}

	if req.ProxyURL != "" && !req.ProxyTrusted {
		proxyURL, err := url.Parse(req.ProxyURL)
		if err != nil || proxyURL.Hostname() == "" {
			s.editOrSendError(ctx, convID, senderID, nil, botlocale.Text(ctx, "Invalid proxy address.", "آدرس پراکسی معتبر نیست."))
			return
		}
		proxyURL.Scheme = "http"
		proxyURL.User = nil
		if err = netguard.ValidateURL(ctx, proxyURL.String()); err != nil {
			s.editOrSendError(ctx, convID, senderID, nil, botlocale.Text(ctx, "The proxy must be on the public network.", "پراکسی باید در شبکهٔ عمومی باشد."))
			return
		}
	}
	// 1. Post initial progress status message
	proxyDisplay := botlocale.Text(ctx, "Direct (no proxy)", "مستقیم (بدون پروکسی)")
	if req.ProxyURL != "" {
		proxyDisplay = req.ProxyURL
	}
	progressText := fmt.Sprintf(botlocale.Text(ctx, "⏳ **Downloading and processing media...**\n🔗 URL: `%s`\n⚙️ Quality: `%sp`\n🛡️ Proxy: `%s`\n\nPlease wait...", "⏳ **در حال دریافت و پردازش ویدیو...**\n🔗 لینک: `%s`\n⚙️ کیفیت: `%sp`\n🛡️ پروکسی: `%s`\n\nلطفاً چند لحظه شکیبا باشید..."),
		req.TargetURL, req.Quality, proxyDisplay)

	progressMsg, _ := s.sendTextMessage(ctx, convID, senderID, progressText, replyToMsgID)

	// 2. Health check proxy if specified
	if req.ProxyURL != "" {
		pTest := s.TestProxy(ctx, req.ProxyURL)
		if !pTest.TCPReachable {
			errorMsg := fmt.Sprintf(botlocale.Text(ctx, "❌ **Proxy server unavailable.**\n\n", "❌ **خطای پروکسی: سرور پروکسی در دسترس نیست!**\n\n")+
				botlocale.Text(ctx, "• 🛡️ Proxy: `%s`\n", "• 🛡️ آدرس پروکسی: `%s`\n")+
				botlocale.Text(ctx, "• ❌ Error: `%s`\n\n", "• ❌ علت خطا: `%s`\n\n")+
				botlocale.Text(ctx, "💡 Check the address/port or test it with:\n`/proxy %s`", "💡 لطفاً از صحت آدرس و پورت پروکسی اطمینان حاصل کرده یا با دستور زیر پروکسی را تست کنید:\n`/proxy %s`"),
				req.ProxyURL, pTest.ErrorMessage, req.ProxyURL)
			s.editOrSendError(ctx, convID, senderID, progressMsg, errorMsg)
			return
		}
		if !pTest.Healthy {
			errorMsg := fmt.Sprintf(botlocale.Text(ctx, "⚠️ **Proxy does not support HTTPS.**\n\n", "⚠️ **خطای پروکسی: عدم پشتیبانی از پروتکل امن HTTPS!**\n\n")+
				botlocale.Text(ctx, "• 🛡️ Proxy: `%s`\n", "• 🛡️ آدرس پروکسی: `%s`\n")+
				botlocale.Text(ctx, "• ⚡ TCP latency: `%d ms`\n", "• ⚡ پینگ TCP: `%d میلی‌ثانیه`\n")+
				botlocale.Text(ctx, "• 🌐 HTTP: `%s`\n", "• 🌐 وضعیت HTTP: `%s`\n")+
				botlocale.Text(ctx, "• ❌ HTTPS: `%s`\n\n", "• ❌ وضعیت HTTPS: `%s`\n\n")+
				botlocale.Text(ctx, "⚠️ The proxy cannot establish an HTTPS CONNECT tunnel, or port 443 is blocked.\n", "⚠️ **دلیل خطا:** این پروکسی به درخواست‌های ساده HTTP پاسخ می‌دهد، اما قابلیت تونل امن HTTPS (CONNECT) را پشتیبانی نمی‌کند یا دسترسی به پورت ۴۴۳ بسته است.\n")+
				botlocale.Text(ctx, "Most video sites require HTTPS, so this proxy cannot download from them.\n\n", "از آنجا که یوتیوب، اینستاگرام، توییتر و اکثر سایت‌های ویدیویی همگی با HTTPS کار می‌کنند، این پروکسی قادر به دانلود ویدیو نخواهد بود.\n\n")+
				botlocale.Text(ctx, "💡 Use a SOCKS5 proxy or an HTTP proxy with HTTPS CONNECT support.", "💡 **راه حل:** لطفاً از یک پروکسی **SOCKS5** یا پروکسی HTTP با قابلیت کامل HTTPS استفاده نمایید."),
				req.ProxyURL, pTest.Latency.Milliseconds(), pTest.HTTPStatus, pTest.HTTPSStatus)
			s.editOrSendError(ctx, convID, senderID, progressMsg, errorMsg)
			return
		}
	}

	// 3. Concurrency limiting (wait if 2 downloads already active)
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return
	case <-time.After(3 * time.Minute):
		s.editOrSendError(ctx, convID, senderID, progressMsg, botlocale.Text(ctx, "The download queue is busy. Try again in a few minutes.", "صف پردازش دانلود شلوغ است. لطفاً چند دقیقه دیگر مجدداً تلاش کنید."))
		return
	}

	// 4. Execute download
	filePath, title, dlErr := s.downloadVideo(ctx, req)
	if dlErr != nil {
		errorMsg := fmt.Sprintf(botlocale.Text(ctx, "❌ **Media download failed:**\n`%s`", "❌ **خطا در دانلود ویدیو:**\n`%s`"), dlErr.Error())
		urlLower := strings.ToLower(req.TargetURL)
		isAdult := strings.Contains(urlLower, "pornhub") || strings.Contains(urlLower, "xvideos") || strings.Contains(urlLower, "xnxx")
		errStr := dlErr.Error()
		isBlocked := strings.Contains(errStr, "410") || strings.Contains(errStr, "Gone") ||
			strings.Contains(errStr, "403") || strings.Contains(errStr, "Forbidden") ||
			strings.Contains(errStr, "SSL_connect") || strings.Contains(errStr, "Connection closed abruptly")

		if isAdult && isBlocked {
			errorMsg += botlocale.Text(ctx, "\n\n⚠️ **Possible regional or network restriction:**\n", "\n\n⚠️ **علت خطا (مسدودیت منطقه‌ای سایت PornHub):**\n") +
				botlocale.Text(ctx, "• The requested website may be blocked by the network or region.\n", "• سایت PornHub در کشور ترکیه (و داخل ایران) توسط رگولاتوری دولتی به طور کامل فیلتر و مسدود است.\n") +
				botlocale.Text(ctx, "• A proxy connection can also be rejected by the website. HTTP 403/410 can have several causes.\n\n", "• اگر پروکسی شما دارای آی‌پی خروجی ترکیه (TR) باشد، فایروال ترکیه اتصال را قطع کرده یا ارور 410/403 برمی‌گرداند.\n\n") +
				botlocale.Text(ctx, "💡 Check access to the requested website from your proxy network:\n", "💡 **راه حل:** برای دانلود از PornHub، حتماً از یک پروکسی با لوکیشن **آلمان (Germany)، هلند (Netherlands)، فرانسه (France) یا آمریکا (USA)** استفاده نمایید:\n") +
				botlocale.Text(ctx, "`/dl <url> <proxy_url> 720`\n\n", "`/dl [لینک] [پروکسی_اروپا_یا_آمریکا] 720`\n\n") +
				botlocale.Text(ctx, "🔄 Send `/dl update` to update the downloader.", "🔄 برای بروزرسانی موتور دانلودر به آخرین نسخه نایتلی، دستور `/dl update` را ارسال کنید.")
		} else if strings.Contains(errStr, "410") || strings.Contains(errStr, "Gone") {
			errorMsg += botlocale.Text(ctx, "\n\n💡 **HTTP 410 Gone:** The media may be unavailable, or the website extractor may need updating.\n\nUpdate the downloader with:\n`/dl update`", "\n\n💡 **راهنمای رفع خطای 410 Gone:** این خطا نشان‌دهنده تغییرات اخیر ساختار سایت و نیاز به بروزرسانی هسته yt-dlp روی سرور است.\n\n🔄 **راه حل خودکار:**\nکافیست در همین چت دستور زیر را ارسال کنید تا هسته دانلودر خودکار آپدیت شود:\n`/dl update`")
		} else {
			errorMsg += botlocale.Text(ctx, "\n\n💡 Check the media URL and proxy:\n`/dl <url> [proxy]`", "\n\n💡 راهنما: ممکن است لینک فیلتر شده باشد یا نیاز به پروکسی معتبر داشته باشد:\n`/dl [لینک] [پروکسی]`")
		}
		s.editOrSendError(ctx, convID, senderID, progressMsg, errorMsg)
		return
	}
	defer os.RemoveAll(filepath.Dir(filePath))
	ext := strings.ToLower(filepath.Ext(filePath))
	if ext == "" {
		ext = ".mp4"
	}
	contentType := "video/mp4"
	if ext == ".webm" {
		contentType = "video/webm"
	} else if ext == ".mov" {
		contentType = "video/quicktime"
	} else if ext == ".mkv" {
		contentType = "video/x-matroska"
	} else if ext == ".mp3" {
		contentType = "audio/mpeg"
	}

	attID := "att_" + uuid.New().String()
	savedFile, sErr := s.fileStore.MoveFile(ctx, "attachments", attID+ext, contentType, filePath)
	if sErr != nil {
		_ = os.Remove(filePath)
		s.editOrSendError(ctx, convID, senderID, progressMsg, botlocale.Text(ctx, "Could not save media on the server: ", "خطا در ذخیره‌سازی فایل در سرور: ")+sErr.Error())
		return
	}

	// 6. Create attachment record in database
	cleanTitle := title
	if cleanTitle == "" {
		cleanTitle = botlocale.Text(ctx, "Downloaded media", "ویدیو دانلودی")
	}
	att := &models.Attachment{
		ID:             attID,
		ConversationID: convID,
		UploaderID:     senderID,
		Filename:       cleanTitle + ext,
		ContentType:    contentType,
		SizeBytes:      savedFile.SizeBytes,
		StoragePath:    savedFile.StoragePath,
		IsEncrypted:    false,
		IsViewOnce:     false,
		StorageType:    savedFile.StorageType,
		PublicURL:      savedFile.PublicURL,
	}
	if err := s.store.CreateAttachment(ctx, att); err != nil {
		_ = s.fileStore.DiscardNewFile(context.WithoutCancel(ctx), savedFile)
		s.editOrSendError(ctx, convID, senderID, progressMsg, botlocale.Text(ctx, "Could not register media in the database: ", "خطا در ثبت رسانه در پایگاه داده: ")+err.Error())
		return
	}

	// 7. Send video attachment directly into the conversation
	isVideo := !strings.HasPrefix(contentType, "audio/")
	isVoice := strings.HasPrefix(contentType, "audio/")

	attPayload := map[string]interface{}{
		"id":          att.ID,
		"filename":    att.Filename,
		"contentType": att.ContentType,
		"sizeBytes":   att.SizeBytes,
		"isVideo":     isVideo,
		"isVoice":     isVoice,
		"storagePath": att.StoragePath,
		"publicUrl":   att.PublicURL,
	}

	caption := fmt.Sprintf(botlocale.Text(ctx, "🎬 **%s**\n📊 Quality: %sp | Size: %s\n🔗 Source: %s", "🎬 **%s**\n📊 کیفیت: %sp | حجم: %s\n🔗 منبع: %s"),
		cleanTitle, req.Quality, formatSize(savedFile.SizeBytes), req.TargetURL)

	msgPayload := map[string]interface{}{
		"text":           caption,
		"type":           "attachment",
		"attachment":     attPayload,
		"attachmentMeta": attPayload,
	}
	payloadBytes, _ := json.Marshal(msgPayload)

	effectiveSender := senderID
	if isBot, _ := s.store.IsMember(ctx, convID, "usr_senoramasterbot"); isBot {
		effectiveSender = "usr_senoramasterbot"
	}

	_, sendErr := s.msgs.SubmitMessage(ctx, messages.SubmitMessageParams{
		ConversationID: convID,
		SenderID:       effectiveSender,
		Ciphertext:     string(payloadBytes),
		Nonce:          "normal",
		ReplyToID:      replyToMsgID,
	})

	if sendErr != nil {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		if deleted, err := s.store.DeleteUnreferencedAttachment(cleanupCtx, att.ID); err == nil && deleted {
			_ = s.fileStore.DiscardNewFile(cleanupCtx, savedFile)
		}
		s.editOrSendError(ctx, convID, senderID, progressMsg, "Could not publish downloaded media: "+sendErr.Error())
		return
	}

	// 8. Clean up the temporary "in progress" status message
	if progressMsg != nil {
		_ = s.msgs.DeleteMessageForEveryone(ctx, convID, progressMsg.ID, effectiveSender)
	}
}

// HandleUpdateYtDlp updates the yt-dlp binary to the latest version and notifies the user.
func (s *Service) HandleUpdateYtDlp(ctx context.Context, convID, senderID, replyToMsgID string) {
	ctx = botlocale.WithUser(ctx, s.store, senderID)
	if owner, err := s.store.IsUserOwner(ctx, senderID); err != nil || !owner {
		s.editOrSendError(ctx, convID, senderID, nil, botlocale.Text(ctx, "This operation is available only to the server owner.", "این عملیات فقط برای مالک سرور مجاز است."))
		return
	}
	statusMsg, _ := s.sendTextMessage(ctx, convID, senderID, botlocale.Text(ctx, "🔄 **Checking for an official yt-dlp update...**\nPlease wait.", "🔄 **در حال بررسی و آپدیت خودکار موتور yt-dlp به آخرین نسخه رسمی...**\nلطفاً چند لحظه شکیبا باشید."), replyToMsgID)

	ver, err := s.UpdateYtDlp(ctx)
	if err != nil {
		s.editOrSendError(ctx, convID, senderID, statusMsg, fmt.Sprintf(botlocale.Text(ctx, "❌ **Downloader update failed:**\n`%s`\n\n💡 On the server, run:\n`sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp`", "❌ **خطا در آپدیت خودکار:**\n`%s`\n\n💡 پیشنهاد: در ترمینال سرور دستور زیر را اجرا فرمایید:\n`sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp`"), err.Error()))
		return
	}

	report := fmt.Sprintf(botlocale.Text(ctx, "✅ **yt-dlp updated successfully.**\n\n", "✅ **موتور yt-dlp با موفقیت به آخرین نسخه به‌روزرسانی شد!**\n\n")+
		botlocale.Text(ctx, "• 📌 Active version: `%s`\n", "• 📌 نسخه جدید فعال: `%s`\n")+
		botlocale.Text(ctx, "• 🌐 The latest extractor updates are now installed.\n\n", "• 🌐 تمام تغییرات ساختاری سایت‌ها (از جمله خطای 410 سایت PornHub) برطرف شد.\n\n")+
		botlocale.Text(ctx, "Try the download again with `/dl <url> [proxy]`.", "اکنون می‌توانید مجدداً دستور `/dl [لینک] [پروکسی]` را ارسال فرمایید."), ver)
	s.editOrSendError(ctx, convID, senderID, statusMsg, report)
}

// UpdateYtDlp downloads or updates to the latest official yt-dlp release.
func (s *Service) UpdateYtDlp(ctx context.Context) (string, error) {
	ytdlpBin, hasYtDlp := findYtDlp()

	// 1. Try running yt-dlp --update-to nightly first if binary exists
	if hasYtDlp {
		binParts := strings.Fields(ytdlpBin)
		upCmd := exec.CommandContext(ctx, binParts[0], "--update-to", "nightly")
		upOut, upErr := upCmd.CombinedOutput()
		upStr := string(upOut)
		if upErr == nil && (strings.Contains(upStr, "Updated") || strings.Contains(upStr, "up to date") || strings.Contains(upStr, "Latest version")) {
			verCmd := exec.CommandContext(ctx, binParts[0], "--version")
			verOut, _ := verCmd.Output()
			return strings.TrimSpace(string(verOut)), nil
		}
		// Fallback to standard -U
		upCmd2 := exec.CommandContext(ctx, binParts[0], "-U")
		upOut2, upErr2 := upCmd2.CombinedOutput()
		if upErr2 == nil && (strings.Contains(string(upOut2), "Updated") || strings.Contains(string(upOut2), "up to date")) {
			verCmd := exec.CommandContext(ctx, binParts[0], "--version")
			verOut, _ := verCmd.Output()
			return strings.TrimSpace(string(verOut)), nil
		}
	}

	// 2. Direct download latest Nightly binary from GitHub releases (contains latest extractor fixes & curl_cffi)
	downloadURL := "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux"
	if runtime.GOOS == "windows" {
		downloadURL = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe"
	}
	httpReq, err := http.NewRequestWithContext(ctx, "GET", downloadURL, nil)
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("User-Agent", "Mozilla/5.0 (SENORA Server Updater)")

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf(botlocale.Text(ctx, "Could not connect to GitHub: %v", "خطا در اتصال به گیت‌هاب: %v"), err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf(botlocale.Text(ctx, "GitHub returned HTTP %d", "سرور گیت‌هاب پاسخ %d داد"), resp.StatusCode)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil || len(bodyBytes) < 1000000 {
		return "", fmt.Errorf(botlocale.Text(ctx, "Incomplete GitHub download (%d bytes)", "فایل دریافتی از گیت‌هاب ناقص است (%d بایت)"), len(bodyBytes))
	}

	targetCandidates := []string{
		"/usr/local/bin/yt-dlp",
		"/usr/bin/yt-dlp",
		"./yt-dlp",
		filepath.Join(os.TempDir(), "yt-dlp"),
	}

	var updatedPath string
	var writeErr error

	for _, target := range targetCandidates {
		tmpFile := target + ".new"
		out, err := os.OpenFile(tmpFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
		if err != nil {
			writeErr = err
			continue
		}
		_, cErr := out.Write(bodyBytes)
		out.Close()
		if cErr != nil {
			_ = os.Remove(tmpFile)
			writeErr = cErr
			continue
		}
		_ = os.Chmod(tmpFile, 0755)
		if err := os.Rename(tmpFile, target); err != nil {
			_ = os.Remove(target)
			if err := os.Rename(tmpFile, target); err != nil {
				_ = os.Remove(tmpFile)
				writeErr = err
				continue
			}
		}
		_ = os.Chmod(target, 0755)

		// Test whether this target is executable
		verCmd := exec.CommandContext(ctx, target, "--version")
		verOut, verErr := verCmd.Output()
		if verErr == nil && len(verOut) > 0 {
			updatedPath = target
			ver := strings.TrimSpace(string(verOut))
			return fmt.Sprintf(botlocale.Text(ctx, "%s (path: %s)", "%s (در مسیر %s)"), ver, updatedPath), nil
		}
		updatedPath = target
	}

	if updatedPath == "" {
		return "", fmt.Errorf(botlocale.Text(ctx, "Cannot write to the system installation paths: %v", "عدم دسترسی برای نوشتن فایل در مسیرهای سیستمی: %v"), writeErr)
	}

	return botlocale.Text(ctx, "Latest official release (GitHub)", "آخرین نسخه رسمی (GitHub)"), nil
}

// downloadVideo tries yt-dlp first, then falls back to direct streaming HTTP download.
func (s *Service) downloadVideo(ctx context.Context, req *DownloadRequest) (filePath string, title string, err error) {
	if err := netguard.ValidateURL(ctx, req.TargetURL); err != nil {
		return "", "", err
	}
	client := s.HTTPClient
	proxyAddress := ""
	if client == nil {
		var closeProxy func()
		proxyAddress, closeProxy, err = netguard.StartProxy(ctx, req.ProxyURL, req.ProxyTrusted)
		if err != nil {
			return "", "", err
		}
		defer closeProxy()
		u, _ := url.Parse(proxyAddress)
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = http.ProxyURL(u)
		client = &http.Client{Transport: transport, Timeout: 15 * time.Minute}
		defer transport.CloseIdleConnections()
	}
	tempRoot := filepath.Join(s.fileStore.GetUploadsDir(), "temp")
	if err = os.MkdirAll(tempRoot, 0700); err != nil {
		return "", "", err
	}
	cleanupDownloadWorkspaces(tempRoot, time.Now())
	limit, reserve, budgetErr := downloadBudget(tempRoot)
	if budgetErr != nil {
		return "", "", budgetErr
	}
	tempDir, err := os.MkdirTemp(tempRoot, "senora-dl-")
	if err != nil {
		return "", "", err
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(tempDir)
		}
	}()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	stopped := make(chan error, 1)
	go monitorDownload(ctx, cancel, tempDir, limit, reserve, stopped)
	defer func() {
		select {
		case reason := <-stopped:
			err = reason
		default:
		}
	}()
	fileUUID := uuid.New().String()[:8]

	ytdlpBin, hasYtDlp := findYtDlp()
	var ytdlpErr string

	if hasYtDlp && s.HTTPClient == nil {
		outputPattern := filepath.Join(tempDir, fmt.Sprintf("senoradl_%s_%%(title).50s.%%(ext)s", fileUUID))
		args := []string{
			"--no-simulate",
			"--no-playlist",
			"--max-filesize", strconv.FormatInt(limit, 10),
			"--no-cache-dir",
			"--paths", "temp:" + tempDir,
			"--no-warnings",
			"--hls-prefer-native",
			"--downloader", "native",
			"--socket-timeout", "30",
			"--retries", "3",
			"--print", "title:%(title)s",
		}

		if req.Quality == "audio" || req.Quality == "mp3" {
			args = append(args, "-x", "--audio-format", "mp3")
		} else {
			height := 720
			if h, err := strconv.Atoi(req.Quality); err == nil && h > 0 {
				height = h
			}
			args = append(args,
				"-f", fmt.Sprintf("bestvideo[ext=mp4][vcodec^=avc1][height<=%d]+bestaudio[ext=m4a]/best[ext=mp4][height<=%d]/best[height<=%d]", height, height, height),
				"--merge-output-format", "mp4",
				"--postprocessor-args", "ffmpeg:-movflags +faststart",
			)
		}

		if proxyAddress != "" {
			args = append(args, "--proxy", proxyAddress)
		}

		args = append(args, "-o", outputPattern, req.TargetURL)

		downloadCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
		defer cancel()

		var cmd *exec.Cmd
		binParts := strings.Fields(ytdlpBin)
		if len(binParts) > 1 {
			cmd = exec.CommandContext(downloadCtx, binParts[0], append(binParts[1:], args...)...)
		} else {
			cmd = exec.CommandContext(downloadCtx, ytdlpBin, args...)
		}

		cmd.Env = append(os.Environ(), "HTTP_PROXY="+proxyAddress, "HTTPS_PROXY="+proxyAddress, "ALL_PROXY="+proxyAddress, "http_proxy="+proxyAddress, "https_proxy="+proxyAddress, "NO_PROXY=", "no_proxy=")
		ownProcessTree(cmd)
		var output boundedOutput
		cmd.Stdout = &output
		cmd.Stderr = &output
		cmdErr := cmd.Run()
		outStr := string(output.data)

		// Parse title from stdout if present
		for _, line := range strings.Split(outStr, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "title:") {
				title = strings.TrimSpace(strings.TrimPrefix(line, "title:"))
				break
			}
		}

		// Check for generated file matching prefix
		matches, _ := filepath.Glob(filepath.Join(tempDir, fmt.Sprintf("senoradl_%s_*", fileUUID)))
		if cmdErr == nil {
			for _, candidate := range matches {
				ext := strings.ToLower(filepath.Ext(candidate))
				info, statErr := os.Stat(candidate)
				if statErr != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > limit {
					continue
				}
				if ext != ".mp4" && ext != ".webm" && ext != ".mkv" && ext != ".mov" && ext != ".mp3" && ext != ".m4a" && ext != ".ogg" {
					continue
				}
				filePath = candidate
				break
			}
		}
		if filePath != "" {
			if title == "" {
				base := filepath.Base(filePath)
				base = strings.TrimPrefix(base, fmt.Sprintf("senoradl_%s_", fileUUID))
				title = strings.TrimSuffix(base, filepath.Ext(base))
			}
			return filePath, title, nil
		}

		// Extract concise error from yt-dlp output
		for _, line := range strings.Split(outStr, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "ERROR:") || strings.Contains(line, "ProxyError") || strings.Contains(line, "HTTP Error") {
				ytdlpErr = line
				break
			}
		}
		if ytdlpErr == "" && len(outStr) > 0 {
			lines := strings.Split(strings.TrimSpace(outStr), "\n")
			for i := len(lines) - 1; i >= 0; i-- {
				l := strings.TrimSpace(lines[i])
				if l != "" && !strings.HasPrefix(l, "title:") && !strings.HasPrefix(l, "[") {
					ytdlpErr = l
					break
				}
			}
		}

		log.Printf("[SENORADownloader] yt-dlp execution failed (%v: %s), testing direct HTTP fallback for: %s", cmdErr, outStr, req.TargetURL)
	}

	// Fallback: Direct HTTP Streaming Downloader
	directPattern := filepath.Join(tempDir, fmt.Sprintf("senoradl_%s_direct.mp4", fileUUID))
	savedPath, dErr := downloadDirectHTTPBounded(ctx, req.TargetURL, req.ProxyURL, directPattern, limit, client)
	if dErr == nil {
		title = filepath.Base(savedPath)
		title = strings.TrimSuffix(title, filepath.Ext(title))
		title = strings.TrimPrefix(title, fmt.Sprintf("senoradl_%s_", fileUUID))
		if title == "direct" || title == "" {
			title = botlocale.Text(ctx, "Downloaded media", "ویدیو دانلودی")
		}
		return savedPath, title, nil
	}

	if !hasYtDlp {
		return "", "", fmt.Errorf(botlocale.Text(ctx, "yt-dlp is not installed and direct download failed: %v\n\nInstall yt-dlp on Linux:\nsudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp", "ابزار yt-dlp روی سرور نصب نیست و دانلود مستقیم نیز با خطا مواجه شد: %v\n\nنحوه نصب yt-dlp در سرور لینوکس:\nsudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp"), dErr)
	}

	if ytdlpErr != "" {
		return "", "", fmt.Errorf(botlocale.Text(ctx, "yt-dlp failed:\n%s\n\nDirect download failed: %v", "خطای موتور yt-dlp:\n%s\n\nخطای دانلود مستقیم: %v"), ytdlpErr, dErr)
	}

	return "", "", fmt.Errorf(botlocale.Text(ctx, "Download failed: %v (check network access and proxy settings)", "دانلود ناموفق بود: %v (در صورت فیلتر بودن لینک، حتماً از پروکسی معتبر استفاده کنید)"), dErr)
}

// downloadDirectHTTP streams a file directly from a URL to disk with optional proxy.
func downloadDirectHTTP(ctx context.Context, targetURL, proxyURL, outputPath string, trustedClients ...*http.Client) (string, error) {
	return downloadDirectHTTPBounded(ctx, targetURL, proxyURL, outputPath, positiveEnv("SENORA_DL_MAX_FILE_BYTES", 500<<20), trustedClients...)
}

func downloadDirectHTTPBounded(ctx context.Context, targetURL, proxyURL, outputPath string, maxBytes int64, trustedClients ...*http.Client) (string, error) {
	client := netguard.Client(15 * time.Minute)
	if proxyURL != "" && (len(trustedClients) == 0 || trustedClients[0] == nil) {
		address, closeProxy, err := netguard.StartProxy(ctx, proxyURL, false)
		if err != nil {
			return "", err
		}
		defer closeProxy()
		u, _ := url.Parse(address)
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = http.ProxyURL(u)
		defer transport.CloseIdleConnections()
		client = &http.Client{Transport: transport, Timeout: 15 * time.Minute}
	}
	if len(trustedClients) > 0 && trustedClients[0] != nil {
		client = trustedClients[0]
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
	httpReq.Header.Set("Accept", "*/*")
	httpReq.Header.Set("Accept-Language", "en-US,en;q=0.9")

	resp, err := client.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP error %d: %s", resp.StatusCode, resp.Status)
	}

	// Detect proper extension from Content-Type or URL
	ext := ".mp4"
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(ct, "webm") {
		ext = ".webm"
	} else if strings.Contains(ct, "quicktime") {
		ext = ".mov"
	} else if strings.Contains(ct, "matroska") || strings.Contains(ct, "mkv") {
		ext = ".mkv"
	} else if strings.Contains(ct, "audio/mpeg") || strings.Contains(ct, "mp3") {
		ext = ".mp3"
	} else {
		u, _ := url.Parse(targetURL)
		if u != nil {
			urlExt := filepath.Ext(u.Path)
			if urlExt != "" && len(urlExt) <= 5 {
				ext = urlExt
			}
		}
	}

	if resp.ContentLength > maxBytes {
		return "", fmt.Errorf("media exceeds the available download budget (%d bytes)", maxBytes)
	}
	finalPath := strings.TrimSuffix(outputPath, filepath.Ext(outputPath)) + ext
	out, err := os.Create(finalPath)
	if err != nil {
		return "", err
	}
	success := false
	defer func() {
		out.Close()
		if !success {
			_ = os.Remove(finalPath)
		}
	}()

	// Stream safely to disk using the admitted byte budget
	limitReader := io.LimitReader(resp.Body, maxBytes+1)
	written, err := io.Copy(out, limitReader)
	if err != nil {
		_ = os.Remove(finalPath)
		return "", err
	}
	if written > maxBytes {
		return "", fmt.Errorf("media exceeds the available download budget (%d bytes)", maxBytes)
	}
	if written == 0 {
		return "", errors.New("empty media response")
	}

	if err := out.Close(); err != nil {
		return "", err
	}
	success = true
	return finalPath, nil
}

// findYtDlp locates the yt-dlp binary or python module.
func findYtDlp() (string, bool) {
	// 1. Explicitly prioritize /usr/local/bin and local/temp paths (latest releases)
	priorityCandidates := []string{
		"/usr/local/bin/yt-dlp",
		"./yt-dlp",
		filepath.Join(os.TempDir(), "yt-dlp"),
		"/tmp/yt-dlp",
		"/var/www/yt-dlp",
		"/var/www/senora/yt-dlp",
		"C:\\yt-dlp.exe",
		"./yt-dlp.exe",
	}
	for _, c := range priorityCandidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c, true
		}
	}

	// 2. Fall back to system PATH
	if p, err := exec.LookPath("yt-dlp"); err == nil {
		return p, true
	}

	// 3. Fall back to standard distribution and user local bin locations
	fallbackCandidates := []string{
		"/usr/bin/yt-dlp",
		"/bin/yt-dlp",
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		fallbackCandidates = append(fallbackCandidates, filepath.Join(home, ".local", "bin", "yt-dlp"))
	}
	for _, c := range fallbackCandidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c, true
		}
	}

	// 4. Python module fallbacks
	if p, err := exec.LookPath("python3"); err == nil {
		cmd := exec.Command(p, "-m", "yt_dlp", "--version")
		if err := cmd.Run(); err == nil {
			return "python3 -m yt_dlp", true
		}
	}
	if p, err := exec.LookPath("python"); err == nil {
		cmd := exec.Command(p, "-m", "yt_dlp", "--version")
		if err := cmd.Run(); err == nil {
			return "python -m yt_dlp", true
		}
	}
	return "", false
}

func (s *Service) sendTextMessage(ctx context.Context, convID, senderID, text, replyToID string) (*models.Message, error) {
	payload, _ := json.Marshal(map[string]string{"text": text})
	effectiveSender := senderID
	if isBot, _ := s.store.IsMember(ctx, convID, "usr_senoramasterbot"); isBot {
		effectiveSender = "usr_senoramasterbot"
	}
	return s.msgs.SubmitMessage(ctx, messages.SubmitMessageParams{
		ConversationID: convID,
		SenderID:       effectiveSender,
		Ciphertext:     string(payload),
		Nonce:          "normal",
		ReplyToID:      replyToID,
	})
}

func (s *Service) editOrSendError(ctx context.Context, convID, senderID string, progressMsg *models.Message, errorText string) {
	effectiveSender := senderID
	if isBot, _ := s.store.IsMember(ctx, convID, "usr_senoramasterbot"); isBot {
		effectiveSender = "usr_senoramasterbot"
	}
	if progressMsg != nil {
		errPayload, _ := json.Marshal(map[string]string{"text": errorText})
		_ = s.msgs.EditMessage(ctx, convID, progressMsg.ID, effectiveSender, string(errPayload))
		return
	}
	_, _ = s.sendTextMessage(ctx, convID, effectiveSender, errorText, "")
}

func formatSize(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%d B", bytes)
	} else if bytes < 1024*1024 {
		return fmt.Sprintf("%.1f KB", float64(bytes)/1024.0)
	} else if bytes < 1024*1024*1024 {
		return fmt.Sprintf("%.2f MB", float64(bytes)/(1024.0*1024.0))
	} else {
		return fmt.Sprintf("%.2f GB", float64(bytes)/(1024.0*1024.0*1024.0))
	}
}

// HandleSyncS3 migrates all local files to ArvanCloud S3 and reports status in chat.
func (s *Service) HandleSyncS3(ctx context.Context, convID, senderID, ciphertext, replyToMsgID string) {
	ctx = botlocale.WithUser(ctx, s.store, senderID)
	if owner, err := s.store.IsUserOwner(ctx, senderID); err != nil || !owner {
		s.editOrSendError(ctx, convID, senderID, nil, botlocale.Text(ctx, "Only the server owner may migrate files.", "فقط مالک سرور اجازهٔ انتقال فایل‌ها را دارد."))
		return
	}
	if s.fileStore == nil {
		s.editOrSendError(ctx, convID, senderID, nil, botlocale.Text(ctx, "❌ File storage service is unavailable.", "❌ خطای سیستمی: سرویس فایل استور فعال نیست."))
		return
	}

	progressText := botlocale.Text(ctx, "🚀 **Starting transfer to configured ArvanCloud S3 storage...**\n\n", "🚀 **شروع انتقال و سینک فایل‌ها به فضای ابری آروان (ArvanCloud S3)...**\n\n") +
		botlocale.Text(ctx, "⏳ Checking bucket connectivity and transferring local media...\n", "⏳ در حال بررسی ارتباط با باکت آروان و انتقال فایل‌های محلی سرور...\n") +
		botlocale.Text(ctx, "Please wait. This operation runs in the background.", "لطفاً صبور باشید، این عملیات بدون قطعی و در پس‌زمینه اجرا می‌شود.")
	progressMsg, _ := s.sendTextMessage(ctx, convID, senderID, progressText, replyToMsgID)

	report, err := s.fileStore.MigrateLocalFilesToS3(ctx, s.store)
	if err != nil {
		errorMsg := fmt.Sprintf(botlocale.Text(ctx, "❌ **Cloud connection or transfer failed:**\n`%s`\n\n", "❌ **خطا در اتصال یا انتقال به فضای ابری آروان:**\n`%s`\n\n")+
			botlocale.Text(ctx, "💡 Check these environment variables in the service configuration:\n", "💡 **راهنما:** لطفاً بررسی فرمایید متغیرهای محیطی زیر در سرویس تنظیم شده باشند:\n")+
			"• `ARVAN_S3_ACCESS_KEY`\n"+
			"• `ARVAN_S3_SECRET_KEY`\n"+
			"• `ARVAN_S3_BUCKET`\n"+
			"• `ARVAN_S3_ENDPOINT`\n"+
			"• `ARVAN_S3_REGION`\n\n"+
			botlocale.Text(ctx, "Update the existing service configuration, restart it, and send `/sync_s3` again.", "پس از تنظیم مشخصات در `/etc/systemd/system/senora.service` و ریستارت سرویس، مجدداً دستور `/sync_s3` را ارسال کنید."), err.Error())
		s.editOrSendError(ctx, convID, senderID, progressMsg, errorMsg)
		return
	}

	successMsg := fmt.Sprintf(botlocale.Text(ctx, "✅ **S3 synchronization completed.**\n\n", "✅ **همگام‌سازی با فضای ابری آروان با موفقیت کامل انجام شد!** 🎉\n\n")+
		botlocale.Text(ctx, "📊 **Transfer report:**\n", "📊 **گزارش انتقال و بهینه‌سازی دیسک:**\n")+
		botlocale.Text(ctx, "• 📦 Files transferred: **%d**\n", "• 📦 تعداد فایل‌های منتقل‌شده به آروان: **%d** فایل\n")+
		botlocale.Text(ctx, "• 💾 Local disk space freed: **%s**\n", "• 💾 فضای آزاد شده از هارد سرور: **%s**\n")+
		botlocale.Text(ctx, "• ⏭️ Unchanged/existing files: **%d**\n", "• ⏭️ فایل‌های بدون تغییر / قبلی: **%d**\n")+
		botlocale.Text(ctx, "• ⏱️ Duration: **%s**\n\n", "• ⏱️ زمان پردازش: **%s**\n\n")+
		botlocale.Text(ctx, "🌐 Migrated media is served from cloud storage. Existing chat messages are preserved.", "🌐 **توجه:** تمام ویدیوها و فایل‌ها اکنون مستقیماً از کلاد آروان استریم و پخش می‌شوند و هیچ فایلی از چت حذف نشده است. هارد سرور اکنون آزاد و سبک شد."),
		report.MigratedCount, formatSize(report.BytesFreed), report.SkippedCount, report.Duration.Round(time.Millisecond))

	if len(report.Errors) > 0 {
		successMsg += fmt.Sprintf(botlocale.Text(ctx, "\n\n⚠️ Transfer errors: %d", "\n\n⚠️ تعداد خطاهای جزیی: %d"), len(report.Errors))
	}

	s.editOrSendError(ctx, convID, senderID, progressMsg, successMsg)
}
