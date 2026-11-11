package downloader

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"senora/server/internal/diskguard"
)

var errDiskBudget = errors.New("download stopped to preserve free disk space; choose lower quality or configure external storage")

func positiveEnv(name string, fallback int64) int64 {
	value, err := strconv.ParseInt(os.Getenv(name), 10, 64)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func downloadBudget(path string) (limit, reserve int64, err error) {
	reserve = positiveEnv("SENORA_DISK_RESERVE_BYTES", 256<<20)
	limit = positiveEnv("SENORA_DL_MAX_FILE_BYTES", 500<<20)
	available, err := diskguard.FreeBytes(path)
	if err != nil {
		return 0, reserve, err
	}
	if available <= uint64(reserve) {
		return 0, reserve, errDiskBudget
	}
	// yt-dlp may retain both tracks while creating its merged output.
	room := (int64(available) - reserve) / 3
	if room < limit {
		limit = room
	}
	if limit < 1<<20 {
		return 0, reserve, errDiskBudget
	}
	return limit, reserve, nil
}

func directoryBytes(path string) (int64, error) {
	var total int64
	err := filepath.WalkDir(path, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	return total, err
}

func monitorDownload(ctx context.Context, cancel context.CancelFunc, path string, limit, reserve int64, stopped chan<- error) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			free, err := diskguard.FreeBytes(path)
			size, sizeErr := directoryBytes(path)
			if err != nil || sizeErr != nil || free < uint64(reserve) || size > limit*2 {
				select {
				case stopped <- errDiskBudget:
				default:
				}
				cancel()
				return
			}
			now := time.Now()
			_ = os.Chtimes(path, now, now)
		}
	}
}

// Only abandoned downloader workspaces are removed. Persisted attachments and
// unrelated uploads are never cache eviction candidates.
func cleanupDownloadWorkspaces(path string, now time.Time) {
	entries, _ := os.ReadDir(path)
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < 24*time.Hour {
			continue
		}
		owned := entry.IsDir() && strings.HasPrefix(entry.Name(), "senora-dl-")
		legacyPartial := !entry.IsDir() && strings.HasPrefix(entry.Name(), "senoradl_") && (strings.HasSuffix(entry.Name(), ".part") || strings.HasSuffix(entry.Name(), ".ytdl"))
		if owned || legacyPartial {
			_ = os.RemoveAll(filepath.Join(path, entry.Name()))
		}
	}
}

type boundedOutput struct{ data []byte }

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	const max = 64 << 10
	if len(p) >= max {
		b.data = append(b.data[:0], p[len(p)-max:]...)
		return n, nil
	}
	if len(b.data)+len(p) > max {
		b.data = b.data[len(b.data)+len(p)-max:]
	}
	b.data = append(b.data, p...)
	return n, nil
}
