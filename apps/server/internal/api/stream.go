package api

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"senora/server/internal/auth"
	"senora/server/internal/events"
	"senora/server/internal/filestore"
	"senora/server/internal/models"
)

var (
	watchPartyLock     sync.RWMutex
	activeWatchParties = make(map[string]*models.WatchPartySession)
)

type createMediaShareReq struct {
	AttachmentID   string `json:"attachment_id"`
	Password       string `json:"password,omitempty"`
	ExpiresInHours int    `json:"expires_in_hours,omitempty"`
	MaxDownloads   int    `json:"max_downloads,omitempty"`
}

type watchPartyActionReq struct {
	Action       string  `json:"action"` // "start", "sync", "reaction", "end"
	MediaURL     string  `json:"media_url,omitempty"`
	MediaTitle   string  `json:"media_title,omitempty"`
	State        string  `json:"state,omitempty"` // "playing", "paused", "seeking"
	CurrentTime  float64 `json:"current_time,omitempty"`
	PlaybackRate float64 `json:"playback_rate,omitempty"`
	Emoji        string  `json:"emoji,omitempty"`
}

// ---------------------------------------------------------------------
// Media Shares Handlers
// ---------------------------------------------------------------------

// handleCreateMediaShare generates a public shareable stream/watch link for an attachment.
func (r *Router) handleCreateMediaShare(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if user == nil {
		r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required")
		return
	}

	var body createMediaShareReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "INVALID_BODY", "Invalid JSON payload")
		return
	}

	if body.AttachmentID == "" {
		r.writeError(w, http.StatusBadRequest, "MISSING_ATTACHMENT", "attachment_id is required")
		return
	}

	att, err := r.store.GetAttachmentByID(req.Context(), body.AttachmentID)
	if err != nil || att == nil {
		// Fallback: check if body.AttachmentID was passed as message ID
		if msg, mErr := r.store.GetMessageByID(req.Context(), body.AttachmentID); mErr == nil && msg != nil {
			var parsed struct {
				Attachment struct {
					ID string `json:"id"`
				} `json:"attachment"`
				AttachmentMeta struct {
					ID string `json:"id"`
				} `json:"attachmentMeta"`
			}
			if jErr := json.Unmarshal([]byte(msg.Ciphertext), &parsed); jErr == nil {
				attID := parsed.Attachment.ID
				if attID == "" {
					attID = parsed.AttachmentMeta.ID
				}
				if attID != "" {
					att, _ = r.store.GetAttachmentByID(req.Context(), attID)
				}
			}
		}
	}
	if att == nil {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Attachment not found")
		return
	}

	if b, ok := req.Context().Value(botContextKey).(*models.ManagedBot); ok && !r.store.BotCanReadAttachment(req.Context(), b, att.ID) {
		r.writeError(w, 403, "FORBIDDEN", "Attachment is not visible to this bot")
		return
	}
	if err := r.convs.ValidateMembership(req.Context(), att.ConversationID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not authorized to share this media")
		return
	}

	if att.IsViewOnce || r.store.AuthorizeAttachmentDownload(req.Context(), att.ID, user.ID, false) != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Deleted or view-once media cannot be shared publicly")
		return
	}

	var pwdHash string
	if strings.TrimSpace(body.Password) != "" {
		h, err := auth.HashPassword(strings.TrimSpace(body.Password), nil)
		if err != nil {
			r.writeError(w, http.StatusInternalServerError, "HASH_FAILED", "Failed to secure password")
			return
		}
		pwdHash = h
	}

	var expiresAt *time.Time
	if body.ExpiresInHours > 0 {
		exp := time.Now().UTC().Add(time.Duration(body.ExpiresInHours) * time.Hour)
		expiresAt = &exp
	}

	shareID := "sh_" + strings.ReplaceAll(uuid.New().String(), "-", "")[:12]
	share := &models.MediaShare{
		ID:           shareID,
		MessageID:    att.ID,
		FilePath:     att.StoragePath,
		FileName:     att.Filename,
		FileSize:     att.SizeBytes,
		MimeType:     att.ContentType,
		CreatorID:    user.ID,
		CreatorName:  user.DisplayName,
		PasswordHash: pwdHash,
		HasPassword:  pwdHash != "",
		ExpiresAt:    expiresAt,
		MaxDownloads: body.MaxDownloads,
		CreatedAt:    time.Now().UTC(),
		ShareURL:     "/watch/" + shareID,
		StreamURL:    "/api/v1/s/" + shareID,
		WatchURL:     "/watch/" + shareID,
	}

	if err := r.store.CreateMediaShare(req.Context(), share); err != nil {
		r.writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "Failed to create share link")
		return
	}

	r.writeJSON(w, http.StatusCreated, map[string]interface{}{
		"share": share,
	})
}

// handleGetMediaShare retrieves public metadata for a media share.
func (r *Router) handleGetMediaShare(w http.ResponseWriter, req *http.Request) {
	id := req.PathValue("id")
	if id == "" {
		r.writeError(w, http.StatusBadRequest, "MISSING_ID", "Share ID required")
		return
	}

	share, err := r.store.GetMediaShareByID(req.Context(), id)
	if err != nil || share == nil || !r.mediaShareSourceAvailable(req, share) {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Media share not found")
		return
	}

	if share.ExpiresAt != nil && !share.ExpiresAt.IsZero() && share.ExpiresAt.Year() > 1970 && time.Now().UTC().After(*share.ExpiresAt) {
		r.writeError(w, http.StatusGone, "EXPIRED", "This share link has expired")
		return
	}

	share.ShareURL = "/watch/" + share.ID
	share.StreamURL = "/s/" + share.ID
	share.WatchURL = "/watch/" + share.ID

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"share": share,
	})
}

// handleDeleteMediaShare allows creator or owner to revoke a share.
func (r *Router) handleDeleteMediaShare(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if user == nil {
		r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required")
		return
	}

	id := req.PathValue("id")
	share, err := r.store.GetMediaShareByID(req.Context(), id)
	if err != nil || share == nil || !r.mediaShareSourceAvailable(req, share) {
		r.writeError(w, http.StatusNotFound, "NOT_FOUND", "Share not found")
		return
	}

	isOwner, _ := r.store.IsUserOwner(req.Context(), user.ID)
	if share.CreatorID != user.ID && !isOwner {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Only creator or server owner can revoke this share")
		return
	}

	if err := r.store.DeleteMediaShare(req.Context(), id); err != nil {
		r.writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "Failed to delete share")
		return
	}

	r.writeJSON(w, http.StatusOK, map[string]string{
		"message": "Share deleted successfully",
	})
}

// handlePublicStreamDownload serves the media with RFC 7233 Byte-Range streaming & direct download.
func (r *Router) handlePublicStreamDownload(w http.ResponseWriter, req *http.Request) {
	w = streamWriter(w)
	id := req.PathValue("id")
	if id == "" {
		http.NotFound(w, req)
		return
	}

	share, err := r.store.GetMediaShareByID(req.Context(), id)
	if err != nil || share == nil || !r.mediaShareSourceAvailable(req, share) {
		http.NotFound(w, req)
		return
	}

	// Expiration check
	if share.ExpiresAt != nil && !share.ExpiresAt.IsZero() && share.ExpiresAt.Year() > 1970 && time.Now().UTC().After(*share.ExpiresAt) {
		http.Error(w, "Share link expired", http.StatusGone)
		return
	}

	// Max downloads limit check
	if share.MaxDownloads > 0 && share.DownloadCount >= share.MaxDownloads {
		http.Error(w, "Maximum download limit reached for this link", http.StatusForbidden)
		return
	}

	// Password check
	if share.HasPassword {
		providedPwd := req.URL.Query().Get("pwd")
		if providedPwd == "" {
			providedPwd = req.Header.Get("X-Media-Password")
		}
		if providedPwd == "" {
			http.Error(w, "Password required for this media", http.StatusUnauthorized)
			return
		}
		match, err := auth.ComparePassword(providedPwd, share.PasswordHash)
		if err != nil || !match {
			http.Error(w, "Invalid password", http.StatusUnauthorized)
			return
		}
	}

	if wantsMediaIndex(req) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		att, err := r.store.GetAttachmentByID(req.Context(), share.MessageID)
		if err != nil || att == nil {
			r.writeError(w, 422, "INDEX_UNAVAILABLE", "This legacy share cannot be indexed")
			return
		}
		r.serveMediaIndex(w, req, att)
		return
	}
	isDownload := req.URL.Query().Get("download") == "true"
	if isDownload {
		_ = r.store.IncrementMediaShareDownloads(req.Context(), share.ID)
	} else {
		_ = r.store.IncrementMediaShareViews(req.Context(), share.ID)
	}

	cleanFilename := filepath.Base(share.FileName)
	if cleanFilename == "" || cleanFilename == "." {
		cleanFilename = "media"
	}

	escapedFilename := url.PathEscape(cleanFilename)
	asciiFallback := strings.Map(func(rn rune) rune {
		if rn > 127 || rn == '"' || rn == '\\' || rn == '/' {
			return '_'
		}
		return rn
	}, cleanFilename)
	if asciiFallback == "" {
		asciiFallback = "media"
	}

	contentType := mediaContentType(share.MimeType, cleanFilename)
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	req = mediaRangeRequest(req, share.FileSize, contentType)
	disposition := "inline"
	if isDownload || !safeInlineType(contentType) {
		disposition = "attachment"
	}

	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Range, Content-Type, Authorization, X-Media-Password")
	if req.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`%s; filename="%s"; filename*=UTF-8''%s`, disposition, asciiFallback, escapedFilename))

	// Attempt local file opening
	var file *os.File
	var openErr error
	if share.FilePath != "" && !filestore.IsS3URL(share.FilePath) {
		file, openErr = os.Open(share.FilePath)
	}
	if file == nil {
		attBase := filepath.Base(share.FilePath)
		candidatePaths := []string{
			share.FilePath,
			filepath.Join(getUploadsDir(), "attachments", attBase),
			filepath.Join(getUploadsDir(), attBase),
			filepath.Join("uploads", "attachments", attBase),
			filepath.Join("uploads", attBase),
			filepath.Join("./uploads", "attachments", attBase),
			filepath.Join("./uploads", attBase),
			filepath.Join("/var/www/senora/uploads", "attachments", attBase),
			filepath.Join("/var/www/senora/uploads", attBase),
		}
		for _, p := range candidatePaths {
			if p == "" {
				continue
			}
			file, openErr = os.Open(p)
			if openErr == nil {
				break
			}
		}
	}

	// Also check attachment record by MessageID / attachment ID
	if file == nil && share.MessageID != "" {
		if att, _ := r.store.GetAttachmentByID(req.Context(), share.MessageID); att != nil {
			if att.StoragePath != "" && !filestore.IsS3URL(att.StoragePath) {
				file, _ = os.Open(att.StoragePath)
			}
			if file == nil {
				attBase := filepath.Base(att.StoragePath)
				for _, p := range []string{
					filepath.Join(getUploadsDir(), "attachments", attBase),
					filepath.Join(getUploadsDir(), attBase),
					filepath.Join("uploads", "attachments", attBase),
					filepath.Join("uploads", attBase),
				} {
					if f, err := os.Open(p); err == nil {
						file = f
						break
					}
				}
			}
			// If on S3
			if file == nil && (att.StorageType == "arvan_s3" || filestore.IsS3URL(att.PublicURL) || filestore.IsS3URL(att.StoragePath)) {
				s3URL := att.PublicURL
				if s3URL == "" || !filestore.IsS3URL(s3URL) {
					s3URL = att.StoragePath
				}
				if filestore.IsS3URL(s3URL) {
					var s3Resp *http.Response
					var s3Err error
					if r.fileStore != nil {
						s3Resp, s3Err = r.fileStore.StreamS3ObjectMethod(req.Context(), req.Method, s3URL, req.Header.Get("Range"))
					} else {
						s3Req, _ := http.NewRequestWithContext(req.Context(), "GET", s3URL, nil)
						if rangeHdr := req.Header.Get("Range"); rangeHdr != "" {
							s3Req.Header.Set("Range", rangeHdr)
						}
						s3Resp, s3Err = http.DefaultClient.Do(s3Req)
					}
					if s3Err == nil && writeMediaUpstream(w, req, s3Resp) {
						return
					}

					if s3Resp != nil {
						s3Resp.Body.Close()
					}
				}
			}
		}
	}

	if file != nil {
		defer file.Close()
		stat, _ := file.Stat()
		modTime := share.CreatedAt
		if stat != nil {
			modTime = stat.ModTime()
		}
		// RFC 7233 partial content handling and zero-disk seek streaming
		http.ServeContent(w, req, cleanFilename, modTime, file)
		return
	}

	// Direct S3 fallback uses the configured signed streaming transport.
	if filestore.IsS3URL(share.FilePath) && r.fileStore != nil {
		response, err := r.fileStore.StreamS3ObjectMethod(req.Context(), req.Method, share.FilePath, req.Header.Get("Range"))
		if err == nil && writeMediaUpstream(w, req, response) {
			return
		}
	}

	http.Error(w, "Media content unavailable", http.StatusNotFound)
}

// handlePublicWatchPlayer renders the standalone web player inspired by FileStreamBot.
func (r *Router) handlePublicWatchPlayer(w http.ResponseWriter, req *http.Request) {
	id := req.PathValue("id")
	if id == "" {
		http.NotFound(w, req)
		return
	}

	share, err := r.store.GetMediaShareByID(req.Context(), id)
	if err != nil || share == nil || !r.mediaShareSourceAvailable(req, share) {
		http.NotFound(w, req)
		return
	}

	if share.ExpiresAt != nil && !share.ExpiresAt.IsZero() && share.ExpiresAt.Year() > 1970 && time.Now().UTC().After(*share.ExpiresAt) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusGone)
		w.Write([]byte(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Expired - SENORA Stream</title><style>body{background:#0b0f19;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style></head><body><div style="text-align:center;padding:2rem;background:#1e293b;border-radius:1rem;border:1px solid #334155;"><h2>⚠️ لینک منقضی شده است</h2><p>This stream link has expired or reached its limit.</p><a href="/" style="color:#38bdf8;text-decoration:none;">Go to SENORA</a></div></body></html>`))
		return
	}

	if r.frontendDir != "" {
		http.ServeFile(w, req, filepath.Join(r.frontendDir, "index.html"))
		return
	}
	providedPwd := req.URL.Query().Get("pwd")
	passwordRequired := share.HasPassword
	passwordValid := false

	if passwordRequired && providedPwd != "" {
		match, err := auth.ComparePassword(providedPwd, share.PasswordHash)
		if err == nil && match {
			passwordValid = true
		}
	}

	safeTitle := html.EscapeString(share.FileName)
	streamURL := "/s/" + share.ID
	if passwordValid && providedPwd != "" {
		streamURL += "?pwd=" + url.QueryEscape(providedPwd)
	}
	downloadURL := streamURL
	if strings.Contains(downloadURL, "?") {
		downloadURL += "&download=true"
	} else {
		downloadURL += "?download=true"
	}

	sizeMB := fmt.Sprintf("%.2f MB", float64(share.FileSize)/(1024*1024))
	isVideo := strings.HasPrefix(share.MimeType, "video/")
	isAudio := strings.HasPrefix(share.MimeType, "audio/")

	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	// If password required and not provided/valid, display glassmorphism password prompt
	if passwordRequired && !passwordValid {
		htmlDoc := fmt.Sprintf(`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>ورود رمز عبور | %s</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;700&display=swap" rel="stylesheet">
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Vazirmatn', -apple-system, BlinkMacSystemFont, sans-serif; }
		body {
			background: radial-gradient(circle at 50%% 20%%, #1e1b4b 0%%, #0f172a 60%%, #020617 100%%);
			color: #f8fafc;
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 1rem;
		}
		.card {
			background: rgba(30, 41, 59, 0.7);
			backdrop-filter: blur(16px);
			-webkit-backdrop-filter: blur(16px);
			border: 1px solid rgba(255, 255, 255, 0.1);
			border-radius: 1.5rem;
			padding: 2.5rem;
			max-width: 420px;
			width: 100%%;
			box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
			text-align: center;
		}
		.icon { font-size: 3rem; margin-bottom: 1rem; }
		h1 { font-size: 1.35rem; font-weight: 700; margin-bottom: 0.5rem; color: #fff; }
		p { color: #94a3b8; font-size: 0.95rem; margin-bottom: 1.5rem; line-height: 1.5; }
		input {
			width: 100%%;
			padding: 0.85rem 1rem;
			background: rgba(15, 23, 42, 0.8);
			border: 1px solid rgba(255, 255, 255, 0.15);
			border-radius: 0.75rem;
			color: #fff;
			font-size: 1rem;
			margin-bottom: 1.25rem;
			outline: none;
			transition: border-color 0.2s;
			text-align: center;
		}
		input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.3); }
		button {
			width: 100%%;
			padding: 0.85rem;
			background: linear-gradient(135deg, #6366f1, #3b82f6);
			border: none;
			border-radius: 0.75rem;
			color: #fff;
			font-size: 1rem;
			font-weight: 600;
			cursor: pointer;
			transition: transform 0.1s, opacity 0.2s;
		}
		button:hover { opacity: 0.95; }
		button:active { transform: scale(0.98); }
		.error-msg { color: #f87171; font-size: 0.85rem; margin-top: 1rem; display: %s; }
	</style>
</head>
<body>
	<div class="card">
		<div class="icon">🔒</div>
		<h1>فایل محافظت‌شده</h1>
		<p>برای تماشا و استریم <strong>%s</strong> رمز عبور را وارد کنید.</p>
		<form method="GET">
			<input type="password" name="pwd" placeholder="رمز عبور را وارد کنید..." required autofocus />
			<button type="submit">ورود و تماشا</button>
		</form>
		<div class="error-msg">رمز عبور وارد شده نادرست است!</div>
	</div>
</body>
</html>`, safeTitle, func() string {
			if providedPwd != "" {
				return "block"
			}
			return "none"
		}(), safeTitle)
		w.Write([]byte(htmlDoc))
		return
	}

	// Render Full Feature Web Player
	mediaTag := ""
	if isVideo {
		mediaTag = fmt.Sprintf(`<video id="player" playsinline controls preload="metadata" poster="">
			<source src="%s" type="%s">
			مرورگر شما از پخش ویدیو پشتیبانی نمی‌کند.
		</video>`, streamURL, html.EscapeString(share.MimeType))
	} else if isAudio {
		mediaTag = fmt.Sprintf(`<div class="audio-wrap">
			<div class="audio-art">🎵</div>
			<audio id="player" controls preload="metadata">
				<source src="%s" type="%s">
				مرورگر شما از پخش صدا پشتیبانی نمی‌کند.
			</audio>
		</div>`, streamURL, html.EscapeString(share.MimeType))
	} else {
		mediaTag = fmt.Sprintf(`<div class="file-wrap">
			<div class="file-icon">📁</div>
			<p>این فایل برای پیش‌نمایش در مرورگر مناسب نیست اما می‌توانید آن را دانلود کنید.</p>
		</div>`)
	}

	htmlPage := fmt.Sprintf(`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>%s | SENORA Dark Player</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap" rel="stylesheet">
	<style>
		:root {
			--bg-base: #090d16;
			--card-bg: rgba(22, 30, 49, 0.75);
			--border-subtle: rgba(255, 255, 255, 0.08);
			--primary: #6366f1;
			--primary-hover: #4f46e5;
			--accent: #38bdf8;
		}
		* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Vazirmatn', -apple-system, BlinkMacSystemFont, sans-serif; }
		body {
			background-color: var(--bg-base);
			background-image: 
				radial-gradient(at 0%% 0%%, rgba(99, 102, 241, 0.12) 0px, transparent 50%%),
				radial-gradient(at 100%% 100%%, rgba(56, 189, 248, 0.1) 0px, transparent 50%%);
			color: #f1f5f9;
			min-height: 100vh;
			display: flex;
			flex-direction: column;
		}
		header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1rem 1.75rem;
			border-bottom: 1px solid var(--border-subtle);
			background: rgba(11, 15, 25, 0.8);
			backdrop-filter: blur(12px);
			position: sticky;
			top: 0;
			z-index: 50;
		}
		.brand {
			display: flex;
			align-items: center;
			gap: 0.75rem;
			text-decoration: none;
			color: #fff;
			font-weight: 700;
			font-size: 1.15rem;
		}
		.brand-badge {
			background: linear-gradient(135deg, #6366f1, #3b82f6);
			padding: 0.25rem 0.6rem;
			border-radius: 0.5rem;
			font-size: 0.75rem;
			font-weight: 600;
		}
		.header-actions {
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}
		.btn {
			display: inline-flex;
			align-items: center;
			gap: 0.5rem;
			padding: 0.5rem 1rem;
			border-radius: 0.65rem;
			font-size: 0.875rem;
			font-weight: 600;
			text-decoration: none;
			cursor: pointer;
			transition: all 0.2s;
			border: 1px solid transparent;
		}
		.btn-primary {
			background: linear-gradient(135deg, #6366f1, #3b82f6);
			color: #fff;
		}
		.btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
		.btn-ghost {
			background: rgba(255, 255, 255, 0.05);
			color: #cbd5e1;
			border: 1px solid var(--border-subtle);
		}
		.btn-ghost:hover {
			background: rgba(255, 255, 255, 0.1);
			color: #fff;
		}
		main {
			flex: 1;
			max-width: 1200px;
			width: 100%%;
			margin: 0 auto;
			padding: 1.5rem;
			display: flex;
			flex-direction: column;
			gap: 1.5rem;
		}
		.player-container {
			background: #000;
			border-radius: 1.25rem;
			overflow: hidden;
			position: relative;
			border: 1px solid var(--border-subtle);
			box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.8);
			max-height: 75vh;
			display: flex;
			align-items: center;
			justify-content: center;
		}
		video {
			width: 100%%;
			height: auto;
			max-height: 75vh;
			display: block;
			outline: none;
		}
		.audio-wrap, .file-wrap {
			padding: 4rem 2rem;
			text-align: center;
			width: 100%%;
		}
		.audio-art, .file-icon {
			font-size: 4rem;
			margin-bottom: 1.5rem;
		}
		audio { width: 100%%; max-width: 500px; outline: none; }
		.meta-card {
			background: var(--card-bg);
			border: 1px solid var(--border-subtle);
			backdrop-filter: blur(16px);
			border-radius: 1.25rem;
			padding: 1.5rem 1.75rem;
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			justify-content: space-between;
			gap: 1.25rem;
		}
		.file-info {
			display: flex;
			flex-direction: column;
			gap: 0.4rem;
		}
		.file-title {
			font-size: 1.25rem;
			font-weight: 700;
			color: #fff;
			word-break: break-all;
		}
		.file-stats {
			display: flex;
			align-items: center;
			gap: 1rem;
			font-size: 0.85rem;
			color: #94a3b8;
		}
		.stat-pill {
			background: rgba(255, 255, 255, 0.06);
			padding: 0.2rem 0.6rem;
			border-radius: 9999px;
			border: 1px solid rgba(255, 255, 255, 0.05);
		}
		.quick-controls {
			display: flex;
			align-items: center;
			gap: 0.75rem;
			flex-wrap: wrap;
		}
		.speed-select {
			background: rgba(15, 23, 42, 0.8);
			border: 1px solid var(--border-subtle);
			color: #fff;
			padding: 0.5rem 0.75rem;
			border-radius: 0.65rem;
			font-size: 0.85rem;
			cursor: pointer;
			outline: none;
		}
		.shortcut-hint {
			font-size: 0.75rem;
			color: #64748b;
			margin-top: 0.5rem;
			line-height: 1.6;
		}
		kbd {
			background: rgba(255, 255, 255, 0.1);
			border: 1px solid rgba(255, 255, 255, 0.15);
			border-radius: 0.3rem;
			padding: 0.1rem 0.35rem;
			font-family: monospace;
			font-size: 0.75rem;
			color: #cbd5e1;
		}
		.toast {
			position: fixed;
			bottom: 2rem;
			right: 2rem;
			background: #1e293b;
			color: #38bdf8;
			padding: 0.75rem 1.25rem;
			border-radius: 0.75rem;
			border: 1px solid #334155;
			box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
			font-size: 0.9rem;
			opacity: 0;
			pointer-events: none;
			transition: opacity 0.3s, transform 0.3s;
			transform: translateY(10px);
			z-index: 100;
		}
		.toast.show { opacity: 1; transform: translateY(0); }
	</style>
</head>
<body>
	<header>
		<a href="/" class="brand">
			<span>⚡ SENORA Web Player</span>
			<span class="brand-badge">RFC 7233 Stream</span>
		</a>
		<div class="header-actions">
			<button class="btn btn-ghost" onclick="copyStreamURL()">📋 کپی لینک مستقیم</button>
			<a href="%s" class="btn btn-primary" download>⬇️ دانلود (%s)</a>
		</div>
	</header>

	<main>
		<div class="player-container" id="playerWrap">
			%s
		</div>

		<div class="meta-card">
			<div class="file-info">
				<h2 class="file-title">%s</h2>
				<div class="file-stats">
					<span class="stat-pill">حجم: %s</span>
					<span class="stat-pill">نوع: %s</span>
					<span class="stat-pill">بازدیدها: %d</span>
					<span class="stat-pill">دانلودها: %d</span>
				</div>
				<div class="shortcut-hint">
					کلیدهای میانبر: <kbd>Space</kbd> توقف/پخش | <kbd>←</kbd> <kbd>→</kbd> ۱۰ ثانیه پرش | <kbd>↑</kbd> <kbd>↓</kbd> بلندی صدا | <kbd>F</kbd> تمام‌صفحه | <kbd>M</kbd> بی‌صدا
				</div>
			</div>

			<div class="quick-controls">
				<label style="font-size:0.85rem;color:#94a3b8;">سرعت:</label>
				<select class="speed-select" id="speedSelect" onchange="changeSpeed(this.value)">
					<option value="0.5">0.5x</option>
					<option value="0.75">0.75x</option>
					<option value="1.0" selected>1.0x (عادی)</option>
					<option value="1.25">1.25x</option>
					<option value="1.5">1.5x</option>
					<option value="2.0">2.0x</option>
				</select>
				<button class="btn btn-ghost" onclick="togglePiP()" id="pipBtn" style="display:none;">📺 تصویر در تصویر</button>
				<button class="btn btn-ghost" onclick="toggleFullscreen()">⛶ تمام صفحه</button>
			</div>
		</div>
	</main>

	<div class="toast" id="toast">لینک مستقیم استریم کپی شد!</div>

	<script>
		const player = document.getElementById('player');
		const speedSelect = document.getElementById('speedSelect');
		const pipBtn = document.getElementById('pipBtn');
		const toast = document.getElementById('toast');

		if (player && player.tagName === 'VIDEO' && document.pictureInPictureEnabled) {
			pipBtn.style.display = 'inline-flex';
		}

		function changeSpeed(val) {
			if (player) {
				player.playbackRate = parseFloat(val);
			}
		}

		async function togglePiP() {
			if (!player) return;
			try {
				if (document.pictureInPictureElement) {
					await document.exitPictureInPicture();
				} else {
					await player.requestPictureInPicture();
				}
			} catch (e) {
				console.error("PiP error:", e);
			}
		}

		function toggleFullscreen() {
			const wrap = document.getElementById('playerWrap');
			if (!document.fullscreenElement) {
				(wrap || player).requestFullscreen().catch(err => console.error(err));
			} else {
				document.exitFullscreen().catch(err => console.error(err));
			}
		}

		function copyStreamURL() {
			const fullUrl = window.location.origin + '%s';
			navigator.clipboard.writeText(fullUrl).then(() => {
				showToast('لینک مستقیم استریم کپی شد!');
			}).catch(() => {
				showToast('کپی لینک ناموفق بود.');
			});
		}

		function showToast(msg) {
			toast.textContent = msg;
			toast.classList.add('show');
			setTimeout(() => toast.classList.remove('show'), 2500);
		}

		// Keyboard controls
		window.addEventListener('keydown', (e) => {
			if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
			if (!player) return;

			if (e.code === 'Space') {
				e.preventDefault();
				if (player.paused) player.play(); else player.pause();
			} else if (e.code === 'ArrowRight') {
				player.currentTime = Math.min(player.duration || 0, player.currentTime + 10);
			} else if (e.code === 'ArrowLeft') {
				player.currentTime = Math.max(0, player.currentTime - 10);
			} else if (e.code === 'ArrowUp') {
				e.preventDefault();
				player.volume = Math.min(1, player.volume + 0.1);
			} else if (e.code === 'ArrowDown') {
				e.preventDefault();
				player.volume = Math.max(0, player.volume - 0.1);
			} else if (e.code === 'KeyF') {
				toggleFullscreen();
			} else if (e.code === 'KeyM') {
				player.muted = !player.muted;
			}
		});
	</script>
</body>
</html>`,
		safeTitle,
		downloadURL,
		sizeMB,
		mediaTag,
		safeTitle,
		sizeMB,
		html.EscapeString(share.MimeType),
		share.ViewsCount,
		share.DownloadCount,
		streamURL,
	)

	w.Write([]byte(htmlPage))
}

// ---------------------------------------------------------------------
// Watch Party Handlers (سینما پارتی همزمان)
// ---------------------------------------------------------------------

// handleGetWatchParty returns active session for a conversation.
func (r *Router) handleGetWatchParty(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if user == nil {
		r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required")
		return
	}

	convID := req.PathValue("id")
	if err := r.convs.ValidateMembership(req.Context(), convID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a conversation member")
		return
	}

	watchPartyLock.RLock()
	session, exists := activeWatchParties[convID]
	watchPartyLock.RUnlock()

	if !exists || session == nil {
		r.writeJSON(w, http.StatusOK, map[string]interface{}{
			"active":  false,
			"session": nil,
		})
		return
	}

	// Calculate extrapolated current time if playing
	currTime := session.CurrentTime
	if session.State == "playing" && !session.LastSyncedAt.IsZero() {
		elapsed := time.Since(session.LastSyncedAt).Seconds()
		currTime += elapsed * session.PlaybackRate
	}

	r.writeJSON(w, http.StatusOK, map[string]interface{}{
		"active": true,
		"session": map[string]interface{}{
			"conversation_id": session.ConversationID,
			"media_url":       session.MediaURL,
			"media_title":     session.MediaTitle,
			"leader_id":       session.LeaderID,
			"leader_name":     session.LeaderName,
			"state":           session.State,
			"current_time":    currTime,
			"playback_rate":   session.PlaybackRate,
			"last_synced_at":  session.LastSyncedAt,
		},
	})
}

// handleWatchPartyAction handles real-time sync actions (start, sync, reaction, end).
func (r *Router) handleWatchPartyAction(w http.ResponseWriter, req *http.Request) {
	user := getUserFromContext(req.Context())
	if user == nil {
		r.writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required")
		return
	}

	convID := req.PathValue("id")
	if err := r.convs.ValidateMembership(req.Context(), convID, user.ID); err != nil {
		r.writeError(w, http.StatusForbidden, "FORBIDDEN", "Not a conversation member")
		return
	}

	var body watchPartyActionReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		r.writeError(w, http.StatusBadRequest, "INVALID_BODY", "Invalid JSON payload")
		return
	}

	switch body.Action {
	case "start":
		if body.MediaURL == "" {
			r.writeError(w, http.StatusBadRequest, "MISSING_URL", "media_url is required")
			return
		}
		// Shared session metadata never carries the creator's account token.
		// Every viewer authorizes attachment/playlist/range requests themselves.
		if strings.HasPrefix(body.MediaURL, "/api/v1/attachments/") {
			if source, err := url.Parse(body.MediaURL); err == nil {
				query := source.Query()
				query.Del("auth")
				query.Del("token")
				source.RawQuery = query.Encode()
				body.MediaURL = source.String()
			}
		}
		if body.PlaybackRate <= 0 {
			body.PlaybackRate = 1.0
		}
		session := &models.WatchPartySession{
			ConversationID: convID,
			MediaURL:       body.MediaURL,
			MediaTitle:     body.MediaTitle,
			LeaderID:       user.ID,
			LeaderName:     user.DisplayName,
			State:          "playing",
			CurrentTime:    body.CurrentTime,
			PlaybackRate:   body.PlaybackRate,
			LastSyncedAt:   time.Now().UTC(),
		}
		watchPartyLock.Lock()
		activeWatchParties[convID] = session
		watchPartyLock.Unlock()

		payload, _ := json.Marshal(map[string]interface{}{
			"conversation_id": convID,
			"session":         session,
			"started_by":      user.ID,
			"starter_name":    user.DisplayName,
		})
		r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
			V:       1,
			Type:    "watch_party.start",
			Payload: payload,
		})

		r.writeJSON(w, http.StatusOK, map[string]interface{}{
			"session": session,
		})

	case "sync":
		watchPartyLock.Lock()
		session, exists := activeWatchParties[convID]
		if !exists || session == nil {
			// Auto create or re-init if not exists
			session = &models.WatchPartySession{
				ConversationID: convID,
				MediaURL:       body.MediaURL,
				MediaTitle:     body.MediaTitle,
				LeaderID:       user.ID,
				LeaderName:     user.DisplayName,
				State:          body.State,
				CurrentTime:    body.CurrentTime,
				PlaybackRate:   body.PlaybackRate,
				LastSyncedAt:   time.Now().UTC(),
			}
			activeWatchParties[convID] = session
		} else {
			if body.State != "" {
				session.State = body.State
			}
			if body.CurrentTime >= 0 {
				session.CurrentTime = body.CurrentTime
			}
			if body.PlaybackRate > 0 {
				session.PlaybackRate = body.PlaybackRate
			}
			session.LastSyncedAt = time.Now().UTC()
		}
		watchPartyLock.Unlock()

		payload, _ := json.Marshal(map[string]interface{}{
			"conversation_id": convID,
			"state":           session.State,
			"current_time":    session.CurrentTime,
			"playback_rate":   session.PlaybackRate,
			"sender_id":       user.ID,
			"sender_name":     user.DisplayName,
			"synced_at":       session.LastSyncedAt.UnixMilli(),
		})
		r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
			V:       1,
			Type:    "watch_party.sync",
			Payload: payload,
		})

		r.writeJSON(w, http.StatusOK, map[string]interface{}{
			"status": "synced",
		})

	case "reaction":
		if body.Emoji == "" {
			body.Emoji = "❤️"
		}
		payload, _ := json.Marshal(map[string]interface{}{
			"conversation_id": convID,
			"emoji":           body.Emoji,
			"sender_id":       user.ID,
			"sender_name":     user.DisplayName,
			"timestamp":       time.Now().UnixMilli(),
		})
		r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
			V:       1,
			Type:    "watch_party.reaction",
			Payload: payload,
		})

		r.writeJSON(w, http.StatusOK, map[string]string{
			"status": "reaction_sent",
		})

	case "end":
		watchPartyLock.Lock()
		delete(activeWatchParties, convID)
		watchPartyLock.Unlock()

		payload, _ := json.Marshal(map[string]interface{}{
			"conversation_id": convID,
			"ended_by":        user.ID,
			"ended_by_name":   user.DisplayName,
		})
		r.hub.BroadcastToConversation(convID, events.ClientEnvelope{
			V:       1,
			Type:    "watch_party.end",
			Payload: payload,
		})

		r.writeJSON(w, http.StatusOK, map[string]string{
			"status": "ended",
		})

	default:
		r.writeError(w, http.StatusBadRequest, "UNKNOWN_ACTION", "Unknown watch party action")
	}
}

// Legacy file-only shares remain readable; attachment-backed shares follow
// revocation and their creator must retain access to a live reference.
func (r *Router) mediaShareSourceAvailable(req *http.Request, share *models.MediaShare) bool {
	if share == nil {
		return false
	}
	if !strings.HasPrefix(share.MessageID, "att_") {
		return true
	}
	att, err := r.store.GetAttachmentByID(req.Context(), share.MessageID)
	if err != nil || att.IsViewOnce {
		return false
	}
	return r.store.AuthorizeAttachmentDownload(req.Context(), att.ID, share.CreatorID, false) == nil
}
