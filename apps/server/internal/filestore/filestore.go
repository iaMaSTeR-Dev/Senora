package filestore

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"senora/server/internal/models"
)

// Config holds ArvanCloud / S3 storage settings.
type Config struct {
	Endpoint        string // e.g. "https://s3.ir-central1.arvanstorage.ir"
	Bucket          string // e.g. "senora"
	Region          string // e.g. "ir-central1"
	AccessKey       string
	SecretKey       string
	PublicURL       string // e.g. "https://senora.s3.ir-central1.arvanstorage.ir"
	LocalUploadsDir string // e.g. "uploads"
}

// DefaultArvanConfig returns default settings for ArvanCloud S3 Object Storage (ایران مرکز ۱).
func DefaultArvanConfig() Config {
	endpoint := os.Getenv("ARVAN_S3_ENDPOINT")
	if endpoint == "" {
		endpoint = os.Getenv("S3_ENDPOINT")
	}
	if endpoint == "" {
		endpoint = "https://s3.ir-central1.arvanstorage.ir"
	}

	bucket := os.Getenv("ARVAN_S3_BUCKET")
	if bucket == "" {
		bucket = os.Getenv("S3_BUCKET")
	}
	if bucket == "" {
		bucket = "senora"
	}

	region := os.Getenv("ARVAN_S3_REGION")
	if region == "" {
		region = os.Getenv("S3_REGION")
	}
	if region == "" {
		region = "ir-central1"
	}

	accessKey := os.Getenv("ARVAN_S3_ACCESS_KEY")
	if accessKey == "" {
		accessKey = os.Getenv("S3_ACCESS_KEY")
	}
	if accessKey == "" {
		accessKey = "ab340fe2-5350-4ab4-83e0-52800b7c5b83"
	}

	secretKey := os.Getenv("ARVAN_S3_SECRET_KEY")
	if secretKey == "" {
		secretKey = os.Getenv("S3_SECRET_KEY")
	}
	if secretKey == "" {
		secretKey = "1ccba76b9b3cdf908fb5048a5d9dcd751bd93a797430c87f4b0c3acd75af1741"
	}

	publicURL := os.Getenv("ARVAN_S3_PUBLIC_URL")
	if publicURL == "" {
		publicURL = os.Getenv("S3_PUBLIC_URL")
	}
	if publicURL == "" {
		publicURL = fmt.Sprintf("https://%s.s3.%s.arvanstorage.ir", bucket, region)
	}

	localDir := os.Getenv("UPLOAD_DIR")
	if localDir == "" {
		localDir = "uploads"
	}

	return Config{
		Endpoint:        endpoint,
		Bucket:          bucket,
		Region:          region,
		AccessKey:       accessKey,
		SecretKey:       secretKey,
		PublicURL:       publicURL,
		LocalUploadsDir: localDir,
	}
}

// SavedFileInfo represents the result of storing a file.
type SavedFileInfo struct {
	StorageType string // "arvan_s3", "local", "local_fallback"
	Key         string // e.g. "attachments/att_123.jpg"
	StoragePath string // local filepath or S3 URL
	PublicURL   string // accessible URL for client
	SizeBytes   int64
	ContentType string
}

// StorageStatus contains diagnostic information about the storage subsystem.
type StorageStatus struct {
	ActiveEngine          string        `json:"active_engine"`           // "arvan_s3" or "local_fallback"
	S3Healthy             bool          `json:"s3_healthy"`
	S3Configured          bool          `json:"s3_configured"`
	Endpoint              string        `json:"endpoint"`
	Bucket                string        `json:"bucket"`
	Region                string        `json:"region"`
	LastProbeTime         *time.Time    `json:"last_probe_time,omitempty"`
	LastLatencyMs         int64         `json:"last_latency_ms"`
	LastError             string        `json:"last_error,omitempty"`
	TotalS3Uploads        int64         `json:"total_s3_uploads"`
	TotalLocalUploads     int64         `json:"total_local_uploads"`
	TotalFallbackSwitches int64         `json:"total_fallback_switches"`
}

// StorageManager manages dual-engine file persistence with automatic failover and recovery.
type StorageManager struct {
	cfg        Config
	httpClient *http.Client

	mu                    sync.RWMutex
	s3Healthy             bool
	lastProbe             time.Time
	lastLatency           time.Duration
	lastError             string
	activeEngine          string
	consecutiveFailures   int
	totalS3Uploads        int64
	totalLocalUploads     int64
	totalFallbackSwitches int64
}

// NewStorageManager creates a new StorageManager instance.
func NewStorageManager(cfg Config) *StorageManager {
	if cfg.LocalUploadsDir == "" {
		cfg.LocalUploadsDir = "uploads"
	}
	_ = os.MkdirAll(cfg.LocalUploadsDir, 0755)

	hasS3Keys := cfg.AccessKey != "" && cfg.SecretKey != ""
	initialEngine := "local_fallback"
	if hasS3Keys {
		initialEngine = "arvan_s3"
	}

	sm := &StorageManager{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 12 * time.Second,
		},
		s3Healthy:    hasS3Keys,
		activeEngine: initialEngine,
	}

	return sm
}

// StartBackgroundProbe initiates health probing of ArvanCloud S3 at the given interval.
func (sm *StorageManager) StartBackgroundProbe(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Second
	}

	// Immediate probe
	go func() {
		_ = sm.ProbeHealth(ctx)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = sm.ProbeHealth(ctx)
			}
		}
	}()
}

// ProbeHealth checks if ArvanCloud S3 is reachable and responsive.
func (sm *StorageManager) ProbeHealth(ctx context.Context) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.cfg.AccessKey == "" || sm.cfg.SecretKey == "" {
		sm.s3Healthy = false
		sm.activeEngine = "local_fallback"
		sm.lastError = "Arvan S3 AccessKey/SecretKey not configured"
		return fmt.Errorf("s3 credentials not set")
	}

	start := time.Now()
	probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()

	// Probe bucket endpoint
	bucketURL := fmt.Sprintf("%s/%s", strings.TrimSuffix(sm.cfg.Endpoint, "/"), sm.cfg.Bucket)
	req, err := http.NewRequestWithContext(probeCtx, http.MethodHead, bucketURL, nil)
	if err != nil {
		sm.recordFailure(err.Error())
		return err
	}

	sm.signRequest(req, []byte{})

	resp, err := sm.httpClient.Do(req)
	latency := time.Since(start)
	sm.lastProbe = time.Now()
	sm.lastLatency = latency

	if err != nil {
		sm.recordFailure(fmt.Sprintf("Probe request error: %v", err))
		return err
	}
	defer resp.Body.Close()

	// S3 returned a response: 200 OK, 403 Forbidden (authenticated server reached), or 404
	if resp.StatusCode < 500 {
		wasOffline := !sm.s3Healthy
		sm.s3Healthy = true
		sm.lastError = ""
		sm.consecutiveFailures = 0

		if wasOffline || sm.activeEngine != "arvan_s3" {
			sm.activeEngine = "arvan_s3"
			sm.totalFallbackSwitches++
			log.Printf("[FileStore] ArvanCloud S3 (%s/%s) is ONLINE (%dms). Primary storage switched to ArvanCloud S3.",
				sm.cfg.Region, sm.cfg.Bucket, latency.Milliseconds())
		}
		return nil
	}

	sm.recordFailure(fmt.Sprintf("S3 server returned HTTP status %d", resp.StatusCode))
	return fmt.Errorf("s3 status %d", resp.StatusCode)
}

func (sm *StorageManager) recordFailure(errMsg string) {
	wasOnline := sm.s3Healthy
	sm.s3Healthy = false
	sm.consecutiveFailures++
	sm.lastError = errMsg

	if wasOnline || sm.activeEngine != "local_fallback" {
		sm.activeEngine = "local_fallback"
		sm.totalFallbackSwitches++
		log.Printf("[FileStore] WARNING: Arvan S3 is UNREACHABLE (%s). Auto-failover to Local Server Storage activated.", errMsg)
	}
}

// SaveFile stores a file either on ArvanCloud S3 or local disk with automatic fallback.
// It streams data directly to local disk with io.Copy without buffering the full payload in RAM, preventing OOM crashes on large files.
func (sm *StorageManager) SaveFile(ctx context.Context, subfolder, filename, contentType string, data io.Reader, size int64) (SavedFileInfo, error) {
	cleanFilename := filepath.Base(filename)
	if cleanFilename == "" || cleanFilename == "." {
		cleanFilename = fmt.Sprintf("file_%d", time.Now().UnixNano())
	}

	destDir := sm.cfg.LocalUploadsDir
	if subfolder != "" {
		destDir = filepath.Join(destDir, subfolder)
	}
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return SavedFileInfo{}, fmt.Errorf("local storage dir failed: %w", err)
	}

	filePath := filepath.Join(destDir, cleanFilename)
	out, err := os.Create(filePath)
	if err != nil {
		return SavedFileInfo{}, fmt.Errorf("local file create failed: %w", err)
	}

	written, err := io.Copy(out, data)
	out.Close()
	if err != nil {
		_ = os.Remove(filePath)
		return SavedFileInfo{}, fmt.Errorf("failed to save data stream: %w", err)
	}

	var publicURL string
	if subfolder == "avatars" {
		publicURL = "/api/v1/attachments/avatar/" + cleanFilename
	} else if subfolder == "stickers" {
		publicURL = "/api/v1/stickers/asset/" + cleanFilename
	} else {
		publicURL = "/api/v1/attachments/" + cleanFilename
	}

	localInfo := SavedFileInfo{
		StorageType: "local_fallback",
		Key:         cleanFilename,
		StoragePath: filePath,
		PublicURL:   publicURL,
		SizeBytes:   written,
		ContentType: contentType,
	}

	s3Key := cleanFilename
	if subfolder != "" {
		s3Key = fmt.Sprintf("%s/%s", strings.Trim(subfolder, "/"), cleanFilename)
	}

	sm.mu.RLock()
	canTryS3 := sm.s3Healthy && sm.cfg.AccessKey != "" && sm.cfg.SecretKey != ""
	sm.mu.RUnlock()

	// 1. Attempt streaming upload to ArvanCloud S3 if enabled with real credentials (zero RAM buffering)
	if canTryS3 {
		s3Info, s3Err := sm.UploadFileToS3(ctx, s3Key, contentType, filePath, true)
		if s3Err == nil {
			sm.mu.Lock()
			sm.totalS3Uploads++
			sm.mu.Unlock()

			if subfolder == "avatars" {
				s3Info.PublicURL = localInfo.PublicURL
			}

			return s3Info, nil
		}

		// S3 upload failed; record failure and seamlessly fallback
		sm.mu.Lock()
		sm.recordFailure(fmt.Sprintf("Upload to S3 failed: %v", s3Err))
		sm.mu.Unlock()
		log.Printf("[FileStore] Arvan S3 upload failed (%v). Falling back to local disk storage for %s", s3Err, cleanFilename)
	}

	// 2. Local disk fallback
	sm.mu.Lock()
	sm.totalLocalUploads++
	sm.mu.Unlock()

	return localInfo, nil
}

// GetUploadsDir returns the base local uploads directory path.
func (sm *StorageManager) GetUploadsDir() string {
	if sm.cfg.LocalUploadsDir == "" {
		return "uploads"
	}
	return sm.cfg.LocalUploadsDir
}

// UploadFileToS3 streams an existing file from disk directly to ArvanCloud S3 without buffering in RAM.
// If deleteLocalAfterUpload is true and upload succeeds, it removes the local file from disk.
func (sm *StorageManager) UploadFileToS3(ctx context.Context, s3Key, contentType, localFilePath string, deleteLocalAfterUpload bool) (SavedFileInfo, error) {
	fi, err := os.Stat(localFilePath)
	if err != nil {
		return SavedFileInfo{}, err
	}

	targetURL := fmt.Sprintf("%s/%s/%s", strings.TrimSuffix(sm.cfg.Endpoint, "/"), sm.cfg.Bucket, s3Key)
	f, err := os.Open(localFilePath)
	if err != nil {
		return SavedFileInfo{}, err
	}
	defer f.Close()

	uploadCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()

	req, err := http.NewRequestWithContext(uploadCtx, http.MethodPut, targetURL, f)
	if err != nil {
		return SavedFileInfo{}, err
	}

	if contentType == "" {
		contentType = "application/octet-stream"
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("x-amz-acl", "public-read")
	req.ContentLength = fi.Size()

	sm.signRequest(req, nil) // UNSIGNED-PAYLOAD for streaming

	resp, err := sm.httpClient.Do(req)
	if err != nil {
		return SavedFileInfo{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return SavedFileInfo{}, fmt.Errorf("s3 put failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	_ = f.Close()
	if deleteLocalAfterUpload {
		_ = os.Remove(localFilePath)
	}

	publicURL := fmt.Sprintf("%s/%s", strings.TrimSuffix(sm.cfg.PublicURL, "/"), s3Key)
	return SavedFileInfo{
		StorageType: "arvan_s3",
		Key:         s3Key,
		StoragePath: publicURL,
		PublicURL:   publicURL,
		SizeBytes:   fi.Size(),
		ContentType: contentType,
	}, nil
}

// MoveFile moves an existing file into the managed storage directory (uploading to ArvanCloud S3 if active, or local storage).
func (sm *StorageManager) MoveFile(ctx context.Context, subfolder, filename, contentType, srcPath string) (SavedFileInfo, error) {
	cleanFilename := filepath.Base(filename)
	if cleanFilename == "" || cleanFilename == "." {
		cleanFilename = fmt.Sprintf("file_%d", time.Now().UnixNano())
	}

	s3Key := cleanFilename
	if subfolder != "" {
		s3Key = fmt.Sprintf("%s/%s", strings.Trim(subfolder, "/"), cleanFilename)
	}

	sm.mu.RLock()
	canTryS3 := sm.s3Healthy && sm.cfg.AccessKey != "" && sm.cfg.SecretKey != ""
	sm.mu.RUnlock()

	// 1. If ArvanCloud S3 is active, stream directly to S3 and delete local file!
	if canTryS3 {
		s3Info, s3Err := sm.UploadFileToS3(ctx, s3Key, contentType, srcPath, true)
		if s3Err == nil {
			sm.mu.Lock()
			sm.totalS3Uploads++
			sm.mu.Unlock()
			log.Printf("[FileStore] Successfully uploaded %s to ArvanCloud S3 (%s/%s) and deleted local file.", cleanFilename, sm.cfg.Region, sm.cfg.Bucket)
			return s3Info, nil
		}
		sm.mu.Lock()
		sm.recordFailure(fmt.Sprintf("Upload to S3 failed: %v", s3Err))
		sm.mu.Unlock()
		log.Printf("[FileStore] Arvan S3 upload failed (%v). Falling back to local disk storage for %s", s3Err, cleanFilename)
	}

	// 2. Local disk fallback
	destDir := sm.cfg.LocalUploadsDir
	if destDir == "" {
		destDir = "uploads"
	}
	if subfolder != "" {
		destDir = filepath.Join(destDir, subfolder)
	}
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return SavedFileInfo{}, fmt.Errorf("local storage dir failed: %w", err)
	}

	destPath := filepath.Join(destDir, cleanFilename)

	var size int64
	// Try atomic rename first (instant, 0 extra disk space on same mount)
	if err := os.Rename(srcPath, destPath); err == nil {
		if fi, sErr := os.Stat(destPath); sErr == nil {
			size = fi.Size()
		}
	} else {
		// Fallback: cross-device copy and immediate remove of source
		in, err := os.Open(srcPath)
		if err != nil {
			return SavedFileInfo{}, err
		}
		defer in.Close()

		out, err := os.Create(destPath)
		if err != nil {
			return SavedFileInfo{}, err
		}
		written, err := io.Copy(out, in)
		out.Close()
		in.Close()
		if err != nil {
			_ = os.Remove(destPath)
			return SavedFileInfo{}, err
		}
		_ = os.Remove(srcPath)
		size = written
	}

	var publicURL string
	if subfolder == "avatars" {
		publicURL = "/api/v1/attachments/avatar/" + cleanFilename
	} else if subfolder == "stickers" {
		publicURL = "/api/v1/stickers/asset/" + cleanFilename
	} else {
		publicURL = "/api/v1/attachments/" + cleanFilename
	}

	sm.mu.Lock()
	sm.totalLocalUploads++
	sm.mu.Unlock()

	return SavedFileInfo{
		StorageType: "local_fallback",
		Key:         cleanFilename,
		StoragePath: destPath,
		PublicURL:   publicURL,
		SizeBytes:   size,
		ContentType: contentType,
	}, nil
}

func (sm *StorageManager) uploadToS3(ctx context.Context, s3Key, contentType string, data []byte) (SavedFileInfo, error) {
	uploadCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	targetURL := fmt.Sprintf("%s/%s/%s", strings.TrimSuffix(sm.cfg.Endpoint, "/"), sm.cfg.Bucket, s3Key)
	req, err := http.NewRequestWithContext(uploadCtx, http.MethodPut, targetURL, bytes.NewReader(data))
	if err != nil {
		return SavedFileInfo{}, err
	}

	if contentType == "" {
		contentType = "application/octet-stream"
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("x-amz-acl", "public-read")
	req.ContentLength = int64(len(data))

	sm.signRequest(req, data)

	resp, err := sm.httpClient.Do(req)
	if err != nil {
		return SavedFileInfo{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		respBody, _ := io.ReadAll(resp.Body)
		return SavedFileInfo{}, fmt.Errorf("s3 put failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	publicURL := fmt.Sprintf("%s/%s", strings.TrimSuffix(sm.cfg.PublicURL, "/"), s3Key)
	return SavedFileInfo{
		StorageType: "arvan_s3",
		Key:         s3Key,
		StoragePath: targetURL,
		PublicURL:   publicURL,
		SizeBytes:   int64(len(data)),
		ContentType: contentType,
	}, nil
}

func (sm *StorageManager) saveToLocal(subfolder, filename, contentType string, data []byte) (SavedFileInfo, error) {
	destDir := sm.cfg.LocalUploadsDir
	if subfolder != "" {
		destDir = filepath.Join(destDir, subfolder)
	}
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return SavedFileInfo{}, err
	}

	filePath := filepath.Join(destDir, filename)
	if err := os.WriteFile(filePath, data, 0644); err != nil {
		return SavedFileInfo{}, err
	}

	var publicURL string
	if subfolder == "avatars" {
		publicURL = "/api/v1/attachments/avatar/" + filename
	} else if subfolder == "stickers" {
		publicURL = "/api/v1/stickers/asset/" + filename
	} else {
		publicURL = "/api/v1/attachments/" + filename
	}

	return SavedFileInfo{
		StorageType: "local_fallback",
		Key:         filename,
		StoragePath: filePath,
		PublicURL:   publicURL,
		SizeBytes:   int64(len(data)),
		ContentType: contentType,
	}, nil
}

// GetStatus returns the current status of the storage engine.
func (sm *StorageManager) GetStatus() StorageStatus {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	var probePtr *time.Time
	if !sm.lastProbe.IsZero() {
		p := sm.lastProbe
		probePtr = &p
	}

	return StorageStatus{
		ActiveEngine:          sm.activeEngine,
		S3Healthy:             sm.s3Healthy,
		S3Configured:          sm.cfg.AccessKey != "" && sm.cfg.SecretKey != "",
		Endpoint:              sm.cfg.Endpoint,
		Bucket:                sm.cfg.Bucket,
		Region:                sm.cfg.Region,
		LastProbeTime:         probePtr,
		LastLatencyMs:         sm.lastLatency.Milliseconds(),
		LastError:             sm.lastError,
		TotalS3Uploads:        sm.totalS3Uploads,
		TotalLocalUploads:     sm.totalLocalUploads,
		TotalFallbackSwitches: sm.totalFallbackSwitches,
	}
}

// SigV4 Implementation for S3

func (sm *StorageManager) signRequest(req *http.Request, payload []byte) {
	now := time.Now().UTC()
	dateStamp := now.Format("20060102")
	amzDate := now.Format("20060102T150405Z")

	req.Header.Set("x-amz-date", amzDate)
	if host := req.URL.Host; host != "" {
		req.Header.Set("Host", host)
	}

	payloadHash := "UNSIGNED-PAYLOAD"
	if payload != nil {
		payloadHash = sha256Hex(payload)
	}
	req.Header.Set("x-amz-content-sha256", payloadHash)

	// Canonical headers (sorted lowercase)
	signedHeaderKeys := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	if acl := req.Header.Get("x-amz-acl"); acl != "" {
		signedHeaderKeys = append(signedHeaderKeys, "x-amz-acl")
	}
	if ct := req.Header.Get("Content-Type"); ct != "" {
		signedHeaderKeys = append(signedHeaderKeys, "content-type")
	}

	// Sort headers
	for i := 0; i < len(signedHeaderKeys)-1; i++ {
		for j := i + 1; j < len(signedHeaderKeys); j++ {
			if signedHeaderKeys[i] > signedHeaderKeys[j] {
				signedHeaderKeys[i], signedHeaderKeys[j] = signedHeaderKeys[j], signedHeaderKeys[i]
			}
		}
	}

	var canonicalHeaders strings.Builder
	for _, k := range signedHeaderKeys {
		var val string
		if k == "host" {
			val = req.URL.Host
		} else {
			val = req.Header.Get(k)
		}
		canonicalHeaders.WriteString(fmt.Sprintf("%s:%s\n", k, strings.TrimSpace(val)))
	}

	signedHeaders := strings.Join(signedHeaderKeys, ";")

	// Canonical URI
	canonicalURI := req.URL.EscapedPath()
	if canonicalURI == "" {
		canonicalURI = "/"
	}

	// Canonical Query
	canonicalQuery := req.URL.Query().Encode()

	// Canonical Request
	canonicalRequest := fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%s",
		req.Method,
		canonicalURI,
		canonicalQuery,
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	)

	credentialScope := fmt.Sprintf("%s/%s/s3/aws4_request", dateStamp, sm.cfg.Region)
	stringToSign := fmt.Sprintf("AWS4-HMAC-SHA256\n%s\n%s\n%s",
		amzDate,
		credentialScope,
		sha256Hex([]byte(canonicalRequest)),
	)

	signingKey := getSignatureKey(sm.cfg.SecretKey, dateStamp, sm.cfg.Region, "s3")
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	authHeader := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		sm.cfg.AccessKey,
		credentialScope,
		signedHeaders,
		signature,
	)

	req.Header.Set("Authorization", authHeader)
}

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func hmacSHA256(key []byte, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func getSignatureKey(key string, dateStamp string, regionName string, serviceName string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+key), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(regionName))
	kService := hmacSHA256(kRegion, []byte(serviceName))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	return kSigning
}

// IsS3URL returns true if the URL or path points to an S3 object.
func IsS3URL(pathOrURL string) bool {
	return strings.HasPrefix(pathOrURL, "http://") || strings.HasPrefix(pathOrURL, "https://")
}

// StreamS3Object sends a GET request to an S3 object URL, signs it with SigV4 credentials (if configured),
// forwards Range header, and returns the *http.Response for zero-disk, zero-RAM streaming.
func (sm *StorageManager) StreamS3Object(ctx context.Context, targetURL, rangeHeader string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}

	sm.mu.RLock()
	canSign := sm.cfg.AccessKey != "" && sm.cfg.SecretKey != ""
	sm.mu.RUnlock()

	if canSign {
		sm.signRequest(req, nil)
	}

	resp, err := sm.httpClient.Do(req)
	if err != nil {
		return nil, err
	}

	// If initial attempt failed with 404 or 403, and targetURL was virtual-host style, try path-style fallback
	if (resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusForbidden) && canSign {
		u, parseErr := url.Parse(targetURL)
		if parseErr == nil && !strings.Contains(u.Path, "/"+sm.cfg.Bucket+"/") {
			_ = resp.Body.Close()
			cleanPath := strings.TrimPrefix(u.Path, "/")
			pathStyleURL := fmt.Sprintf("%s/%s/%s", strings.TrimSuffix(sm.cfg.Endpoint, "/"), sm.cfg.Bucket, cleanPath)
			retryReq, retryErr := http.NewRequestWithContext(ctx, http.MethodGet, pathStyleURL, nil)
			if retryErr == nil {
				if rangeHeader != "" {
					retryReq.Header.Set("Range", rangeHeader)
				}
				sm.signRequest(retryReq, nil)
				retryResp, retryErr2 := sm.httpClient.Do(retryReq)
				if retryErr2 == nil && (retryResp.StatusCode == http.StatusOK || retryResp.StatusCode == http.StatusPartialContent) {
					return retryResp, nil
				}
				if retryResp != nil {
					_ = retryResp.Body.Close()
				}
			}
		}
	}

	return resp, nil
}

// MigrationReport details the results of migrating local attachments to ArvanCloud S3.
type MigrationReport struct {
	TotalScanned  int           `json:"total_scanned"`
	MigratedCount int           `json:"migrated_count"`
	FailedCount   int           `json:"failed_count"`
	SkippedCount  int           `json:"skipped_count"`
	BytesFreed    int64         `json:"bytes_freed"`
	Duration      time.Duration `json:"duration"`
	Errors        []string      `json:"errors,omitempty"`
}

// StorageBackend defines the database methods needed for migration.
type StorageBackend interface {
	ListLocalAttachments(ctx context.Context) ([]*models.Attachment, error)
	UpdateAttachmentStorage(ctx context.Context, id, storageType, publicURL string) error
	GetAttachmentByID(ctx context.Context, id string) (*models.Attachment, error)
}

// MigrateLocalFilesToS3 moves all local attachments stored on the server's disk to ArvanCloud S3,
// updates the database storage references, and deletes the local files to reclaim disk space.
func (sm *StorageManager) MigrateLocalFilesToS3(ctx context.Context, store StorageBackend) (*MigrationReport, error) {
	sm.mu.RLock()
	canTryS3 := sm.cfg.AccessKey != "" && sm.cfg.SecretKey != ""
	sm.mu.RUnlock()

	if !canTryS3 {
		return nil, fmt.Errorf("مشخصات اتصال به آروان کلاد (ARVAN_S3_ACCESS_KEY و ARVAN_S3_SECRET_KEY) تنظیم نشده است")
	}

	if err := sm.ProbeHealth(ctx); err != nil {
		return nil, fmt.Errorf("فضای ابری آروان در دسترس نیست: %w", err)
	}

	startTime := time.Now()
	report := &MigrationReport{
		Errors: make([]string, 0),
	}

	localAttachments, err := store.ListLocalAttachments(ctx)
	if err != nil {
		return nil, fmt.Errorf("خطا در دریافت لیست فایل‌های محلی دیتابیس: %w", err)
	}

	report.TotalScanned = len(localAttachments)
	uploadsDir := sm.GetUploadsDir()

	for _, att := range localAttachments {
		if att == nil {
			continue
		}

		// Find file on local disk
		attBase := filepath.Base(att.StoragePath)
		candidatePaths := []string{
			att.StoragePath,
			filepath.Join(uploadsDir, "attachments", attBase),
			filepath.Join(uploadsDir, attBase),
			filepath.Join("uploads", "attachments", attBase),
			filepath.Join("uploads", attBase),
			filepath.Join("/var/www/senora/uploads", "attachments", attBase),
			filepath.Join("/var/www/senora/uploads", attBase),
		}

		var localPath string
		var fi os.FileInfo
		for _, p := range candidatePaths {
			if p == "" || IsS3URL(p) {
				continue
			}
			if stat, sErr := os.Stat(p); sErr == nil && !stat.IsDir() {
				localPath = p
				fi = stat
				break
			}
		}

		// If still not found, try finding by att.ID prefix in uploads
		if localPath == "" {
			matches, _ := filepath.Glob(filepath.Join(uploadsDir, "attachments", att.ID+"*"))
			if len(matches) == 0 {
				matches, _ = filepath.Glob(filepath.Join(uploadsDir, att.ID+"*"))
			}
			if len(matches) == 0 {
				matches, _ = filepath.Glob(filepath.Join("/var/www/senora/uploads/attachments", att.ID+"*"))
			}
			if len(matches) == 0 {
				matches, _ = filepath.Glob(filepath.Join("/var/www/senora/uploads", att.ID+"*"))
			}
			for _, m := range matches {
				if stat, sErr := os.Stat(m); sErr == nil && !stat.IsDir() {
					localPath = m
					fi = stat
					break
				}
			}
		}

		if localPath == "" {
			// If already on S3, ensure DB record is updated
			if IsS3URL(att.StoragePath) || IsS3URL(att.PublicURL) {
				s3URL := att.PublicURL
				if s3URL == "" {
					s3URL = att.StoragePath
				}
				_ = store.UpdateAttachmentStorage(ctx, att.ID, "arvan_s3", s3URL)
			}
			report.SkippedCount++
			continue
		}

		s3Key := fmt.Sprintf("attachments/%s", filepath.Base(localPath))
		contentType := att.ContentType
		if contentType == "" {
			contentType = "application/octet-stream"
		}

		s3Info, upErr := sm.UploadFileToS3(ctx, s3Key, contentType, localPath, false)
		if upErr != nil {
			report.FailedCount++
			report.Errors = append(report.Errors, fmt.Sprintf("%s: %v", att.ID, upErr))
			log.Printf("[FileStore Migration] Failed to upload %s (%s) to S3: %v", att.ID, localPath, upErr)
			continue
		}

		// Upload succeeded, update DB
		dbErr := store.UpdateAttachmentStorage(ctx, att.ID, "arvan_s3", s3Info.PublicURL)
		if dbErr != nil {
			report.FailedCount++
			report.Errors = append(report.Errors, fmt.Sprintf("DB update %s: %v", att.ID, dbErr))
			log.Printf("[FileStore Migration] Failed to update DB for %s: %v", att.ID, dbErr)
			continue
		}

		// DB updated, safely remove local file to reclaim space
		fileSize := fi.Size()
		_ = os.Remove(localPath)
		report.MigratedCount++
		report.BytesFreed += fileSize
		log.Printf("[FileStore Migration] Migrated %s (%d bytes) to ArvanCloud S3. Local file removed.", att.ID, fileSize)
	}

	// Also clean any orphan leftover .part files and temp files in uploads directory
	cleanLeftoverUploads(uploadsDir, report)
	if uploadsDir != "/var/www/senora/uploads" {
		cleanLeftoverUploads("/var/www/senora/uploads", report)
	}

	report.Duration = time.Since(startTime)
	return report, nil
}

func cleanLeftoverUploads(baseDir string, report *MigrationReport) {
	if baseDir == "" {
		return
	}
	// 1. Remove leftover *.part files
	partMatches, _ := filepath.Glob(filepath.Join(baseDir, "attachments", "*.part"))
	for _, p := range partMatches {
		if stat, err := os.Stat(p); err == nil {
			report.BytesFreed += stat.Size()
			_ = os.Remove(p)
		}
	}
	partMatchesRoot, _ := filepath.Glob(filepath.Join(baseDir, "*.part"))
	for _, p := range partMatchesRoot {
		if stat, err := os.Stat(p); err == nil {
			report.BytesFreed += stat.Size()
			_ = os.Remove(p)
		}
	}
	// 2. Clean temp folder files older than 30 minutes
	tempFiles, _ := os.ReadDir(filepath.Join(baseDir, "temp"))
	cutoff := time.Now().Add(-30 * time.Minute)
	for _, tf := range tempFiles {
		if !tf.IsDir() {
			fullPath := filepath.Join(baseDir, "temp", tf.Name())
			if info, err := tf.Info(); err == nil && info.ModTime().Before(cutoff) {
				report.BytesFreed += info.Size()
				_ = os.Remove(fullPath)
			}
		}
	}
}
