package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func PrivateBackupDirectory() string {
	if configured := os.Getenv("SENORA_BACKUP_DIR"); configured != "" {
		return configured
	}
	if runtime.GOOS == "linux" {
		return "/var/lib/senora/backups"
	}
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "SENORA", "backups")
}

func (s *SQLStore) BackupFileExtension() string {
	if s.driverName == "postgres" {
		return ".dump"
	}
	return ".db"
}

func IsBackupFilename(name string) bool {
	if strings.ContainsAny(name, "/\\") || name != filepath.Base(name) {
		return false
	}
	if !strings.HasPrefix(name, "backup_senora_") {
		return false
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".db", ".sql", ".dump":
		return true
	}
	return false
}

func ResolveBackup(name string) (string, error) {
	if !IsBackupFilename(name) {
		return "", errors.New("invalid backup filename")
	}
	for _, directory := range []string{PrivateBackupDirectory(), "backups"} {
		path := filepath.Join(directory, name)
		if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() {
			return path, nil
		}
	}
	return "", os.ErrNotExist
}

// BackupDatabase publishes a complete snapshot only after the producer, sync and
// close have succeeded. A failed run leaves any previous backup intact.
func (s *SQLStore) BackupDatabase(ctx context.Context, destPath string) error {
	if strings.TrimSpace(destPath) == "" {
		return errors.New("backup destination is required")
	}
	if info, err := os.Lstat(destPath); err == nil && !info.Mode().IsRegular() {
		return errors.New("backup destination must be a regular file")
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destPath), ".senora-snapshot-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err = tmp.Close(); err != nil {
		return err
	}
	if s.driverName == "postgres" {
		err = s.backupPostgres(ctx, name)
	} else {
		// VACUUM INTO supplies a consistent SQLite snapshot including committed WAL.
		if err = os.Remove(name); err == nil {
			err = s.dumpSQLiteTables(ctx, name)
		}
	}
	if err != nil {
		return err
	}
	f, err := os.OpenFile(name, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err = f.Chmod(0600); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	info, err := os.Stat(name)
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		return errors.New("backup producer returned an empty file")
	}
	return os.Rename(name, destPath)
}

func (s *SQLStore) backupPostgres(ctx context.Context, destPath string) error {
	u, err := url.Parse(s.dataSourceName)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return errors.New("PostgreSQL backups require a PostgreSQL connection URI")
	}
	environment := os.Environ()
	if u.User != nil {
		if password, ok := u.User.Password(); ok {
			environment = append(environment, "PGPASSWORD="+password)
		}
		u.User = url.User(u.User.Username())
	}
	query := u.Query()
	if password := query.Get("password"); password != "" {
		environment = append(environment, "PGPASSWORD="+password)
		query.Del("password")
		u.RawQuery = query.Encode()
	}
	command := exec.CommandContext(ctx, "pg_dump", "--no-password", "--format=custom", "--no-owner", "--no-acl", "--dbname", u.String())
	command.Env = environment
	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	command.Stdout = f
	// Do not include tool stderr or the connection URI in user-visible errors.
	err = command.Run()
	syncErr := f.Sync()
	closeErr := f.Close()
	if err != nil {
		return fmt.Errorf("pg_dump could not complete a consistent PostgreSQL backup: %w", err)
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func (s *SQLStore) dumpSQLiteTables(ctx context.Context, destPath string) error {
	// The old INSERT-only fallback was not a restorable database and ignored write
	// errors. Use the native snapshot producer instead; never copy a live DB file.
	clean := strings.ReplaceAll(filepath.ToSlash(destPath), "'", "''")
	if _, err := s.db.ExecContext(ctx, "VACUUM INTO '"+clean+"'"); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(destPath)+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	var integrity string
	if err = db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil {
		return err
	}
	if integrity != "ok" {
		return errors.New("snapshot integrity check failed")
	}
	return nil
}
