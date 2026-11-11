package filestore

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// DiscardNewFile is only for an upload that failed before becoming referenced.
func (sm *StorageManager) DiscardNewFile(ctx context.Context, f SavedFileInfo) error {
	if f.StorageType == "arvan_s3" {
		if f.Key == "" || strings.Contains(f.Key, "..") {
			return fmt.Errorf("invalid new object key")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodDelete, strings.TrimSuffix(sm.cfg.Endpoint, "/")+"/"+sm.cfg.Bucket+"/"+f.Key, nil)
		if err != nil {
			return err
		}
		sm.signRequest(req, nil)
		res, err := sm.httpClient.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != 404 && (res.StatusCode < 200 || res.StatusCode >= 300) {
			return fmt.Errorf("object cleanup status %d", res.StatusCode)
		}
		return nil
	}
	root, err := filepath.Abs(sm.cfg.LocalUploadsDir)
	if err != nil {
		return err
	}
	path, err := filepath.Abs(f.StoragePath)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("file outside managed uploads")
	}
	return os.Remove(path)
}
