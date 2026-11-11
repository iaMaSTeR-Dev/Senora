package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"

	"senora/server/internal/filestore"
	"senora/server/internal/models"
)

func wantsMediaIndex(req *http.Request) bool {
	mode := req.URL.Query().Get("stream")
	return mode == "index" || mode == "playlist"
}

// Caller has already checked the session/share password, expiry, membership,
// reference revocation and view-once restrictions. No new public media route.
func (r *Router) serveMediaIndex(w http.ResponseWriter, req *http.Request, att *models.Attachment) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if att.IsEncrypted || att.IsViewOnce {
		r.writeError(w, 403, "INDEX_UNAVAILABLE", "Encrypted or view-once media cannot be indexed on the server")
		return
	}
	if att.SizeBytes <= 0 || att.SizeBytes > 16<<30 {
		r.writeError(w, 422, "INDEX_UNAVAILABLE", "Media size is not supported for indexing")
		return
	}
	key := fmt.Sprintf("%s:%d:%s:%s", att.ID, att.SizeBytes, att.StoragePath, att.PublicURL)
	status := r.seekIndexes.Get(key, att.SizeBytes, func(ctx context.Context) (io.ReadCloser, error) {
		base := filepath.Base(att.StoragePath)
		for _, path := range []string{att.StoragePath, filepath.Join(getUploadsDir(), "attachments", base), filepath.Join(getUploadsDir(), base), filepath.Join("uploads", "attachments", base), filepath.Join("uploads", base)} {
			if path != "" && !filestore.IsS3URL(path) {
				if file, err := os.Open(path); err == nil {
					if info, err := file.Stat(); err == nil && info.Mode().IsRegular() {
						return file, nil
					}
					file.Close()
				}
			}
		}
		target := att.PublicURL
		if target == "" || !filestore.IsS3URL(target) {
			target = att.StoragePath
		}
		if r.fileStore != nil && filestore.IsS3URL(target) {
			response, err := r.fileStore.StreamS3ObjectMethod(ctx, http.MethodGet, target, "")
			if err != nil {
				return nil, err
			}
			if response.StatusCode != http.StatusOK {
				response.Body.Close()
				return nil, fmt.Errorf("media source unavailable")
			}
			return response.Body, nil
		}
		return nil, fmt.Errorf("media source unavailable")
	})
	if status.Failed {
		r.writeError(w, 422, "INDEX_UNAVAILABLE", "This source could not be indexed for seeking")
		return
	}
	if status.Index == nil {
		w.Header().Set("Retry-After", "1")
		r.writeJSON(w, 202, map[string]any{"state": "indexing", "progress": float64(status.Read) / float64(att.SizeBytes)})
		return
	}
	if req.URL.Query().Get("stream") == "playlist" {
		sourceURL := *req.URL
		query := url.Values{}
		for _, name := range []string{"auth", "token", "pwd"} {
			if value := req.URL.Query().Get(name); value != "" {
				query.Set(name, value)
			}
		}
		query.Set("stream", "hls")
		sourceURL.RawQuery = query.Encode()
		source := sourceURL.RequestURI()
		if len(source) > 4096 || (len(source)+128)*len(status.Index.Segments) > 8<<20 {
			r.writeError(w, 422, "INDEX_UNAVAILABLE", "Video playlist exceeds the bounded metadata size")
			return
		}
		// Same authenticated source URL, with credentials/password retained. HLS
		// fragments are byte ranges of the original object, never new files.
		text := status.Index.Playlist(source)
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Content-Length", strconv.Itoa(len(text)))
		if req.Method != http.MethodHead {
			_, _ = io.WriteString(w, text)
		}
		return
	}
	r.writeJSON(w, 200, map[string]any{"state": "ready", "duration": status.Index.Duration, "segments": len(status.Index.Segments)})
}
