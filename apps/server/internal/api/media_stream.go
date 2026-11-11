package api

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Large transfers have an inactivity deadline, not a deadline for the entire
// movie. ResponseController preserves native Range/HEAD behavior in ServeContent.
type mediaResponseWriter struct{ http.ResponseWriter }

func (w mediaResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w mediaResponseWriter) Write(p []byte) (int, error) {
	_ = http.NewResponseController(w.ResponseWriter).SetWriteDeadline(time.Now().Add(45 * time.Second))
	return w.ResponseWriter.Write(p)
}
func streamWriter(w http.ResponseWriter) http.ResponseWriter {
	// Nginx must forward chunks instead of spooling a large upstream response to
	// its proxy temp directory on a nearly full server disk.
	w.Header().Set("X-Accel-Buffering", "no")
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(45 * time.Second))
	return mediaResponseWriter{w}
}

const mediaRangeBytes int64 = 8 << 20

func mediaContentType(value, filename string) string {
	if value != "" && value != "application/octet-stream" {
		return value
	}
	lower := strings.ToLower(filename)
	for extension, kind := range map[string]string{".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav"} {
		if strings.HasSuffix(lower, extension) {
			return kind
		}
	}
	if value == "" {
		return "application/octet-stream"
	}
	return value
}

// A 206 response may send a subset of the requested range (RFC 9110 §15.3.7).
// Keep browser open-ended reads bounded; explicit downloads retain full ranges.
func mediaRangeRequest(req *http.Request, size int64, contentType string) *http.Request {
	// The MSE transmuxer consumes incrementally and cancels when its bounded
	// playback buffer is full. Truncating resumed requests looks like end-of-file
	// to its FetchStreamLoader and would stop long TS movies after one chunk.
	if req.Method != http.MethodGet || req.URL.Query().Get("download") == "true" || req.URL.Query().Get("stream") == "continuous" || req.URL.Query().Get("stream") == "hls" ||
		!(strings.HasPrefix(contentType, "video/") || strings.HasPrefix(contentType, "audio/")) {
		return req
	}
	value := req.Header.Get("Range")
	if !strings.HasPrefix(value, "bytes=") || strings.Contains(value, ",") {
		return req
	}
	parts := strings.SplitN(strings.TrimPrefix(value, "bytes="), "-", 2)
	if len(parts) != 2 {
		return req
	}
	replacement := ""
	if parts[0] == "" {
		suffix, err := strconv.ParseInt(parts[1], 10, 64)
		if err == nil && suffix > mediaRangeBytes {
			replacement = fmt.Sprintf("bytes=-%d", mediaRangeBytes)
		}
	} else {
		start, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil || start < 0 || start > int64(^uint64(0)>>1)-mediaRangeBytes {
			return req
		}
		end := start + mediaRangeBytes - 1
		if size > 0 && end >= size {
			end = size - 1
		}
		if parts[1] != "" {
			requested, err := strconv.ParseInt(parts[1], 10, 64)
			if err != nil || requested < start || requested <= end {
				return req
			}
		}
		if end >= start {
			replacement = fmt.Sprintf("bytes=%d-%d", start, end)
		}
	}
	if replacement == "" || replacement == value {
		return req
	}
	copy := req.Clone(req.Context())
	copy.Header.Set("Range", replacement)
	return copy
}

// Validate the upstream range before committing response headers. Never turn a
// Range-ignoring origin's 1 GB response into a full-file proxy download.
func writeMediaUpstream(w http.ResponseWriter, req *http.Request, res *http.Response) bool {
	if res == nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != 200 && res.StatusCode != 206 && res.StatusCode != 416 {
		return false
	}
	if req.Method == http.MethodGet && req.Header.Get("Range") != "" && res.StatusCode == 200 {
		http.Error(w, "Storage does not support the requested byte range", http.StatusBadGateway)
		return true
	}
	if res.StatusCode == 206 {
		var start, end, total int64
		if _, err := fmt.Sscanf(res.Header.Get("Content-Range"), "bytes %d-%d/%d", &start, &end, &total); err != nil || start < 0 || end < start || total <= end ||
			(res.ContentLength >= 0 && res.ContentLength != end-start+1) {
			http.Error(w, "Invalid storage byte-range response", http.StatusBadGateway)
			return true
		}
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	}
	for _, name := range []string{"Content-Range", "Content-Length", "ETag", "Last-Modified"} {
		if value := res.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(res.StatusCode)
	if req.Method != http.MethodHead {
		_, _ = io.Copy(w, res.Body)
	}
	return true
}

type uploadBody struct {
	io.ReadCloser
	controller *http.ResponseController
}

func (b uploadBody) Read(p []byte) (int, error) {
	_ = b.controller.SetReadDeadline(time.Now().Add(45 * time.Second))
	return b.ReadCloser.Read(p)
}
