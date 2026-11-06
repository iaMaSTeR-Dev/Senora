package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"senora/server/internal/api"
	"senora/server/internal/auth"
	"senora/server/internal/config"
	"senora/server/internal/conversations"
	"senora/server/internal/crypto"
	"senora/server/internal/events"
	"senora/server/internal/identity"
	"senora/server/internal/messages"
)

func main() {
	cfg, err := config.LoadFromEnv()
	if err != nil {
		log.Fatalf("[Senora Server] Configuration error: %v", err)
	}

	log.Printf("[Senora Server] Environment: %s, Database: %s (%s)", cfg.Environment, cfg.Driver, cfg.RedactedDatabaseURL())
	store, err := cfg.InitStorage()
	if err != nil {
		log.Fatalf("[Senora Server] Fatal: Failed to initialize storage: %v", err)
	}
	defer store.Close()
	log.Printf("[Senora Server] Storage initialized and migrations verified.")

	// Initialize domain services
	sessionService := auth.NewSessionService(store, 30*24*time.Hour)
	identityService := identity.NewService(store, sessionService)
	convService := conversations.NewService(store)
	hub := events.NewHub(store)
	msgService := messages.NewService(store, convService, hub)
	cryptoService := crypto.NewService(store)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Ensure default master bot and registration approval settings
	if _, err := store.GetServerSetting(ctx, "registration_approval", ""); err != nil {
		_ = store.SetServerSetting(ctx, "registration_approval", "true")
	}
	if _, err := store.GetServerSetting(ctx, "master_bot_enabled", ""); err != nil {
		_ = store.SetServerSetting(ctx, "master_bot_enabled", "true")
	}

	// Start WebSocket hub
	go hub.Run(ctx)

	// Build API router
	router := api.NewRouter(
		store,
		identityService,
		sessionService,
		convService,
		msgService,
		cryptoService,
		hub,
	)

	// Command-line flag: migration of local storage to ArvanCloud S3
	for _, arg := range os.Args[1:] {
		if arg == "--migrate-to-s3" || arg == "-migrate-to-s3" || arg == "--sync-s3" || arg == "-sync-s3" {
			log.Printf("[Senora Server] Starting local storage to ArvanCloud S3 migration...")
			report, mErr := router.FileStore().MigrateLocalFilesToS3(ctx, store)
			if mErr != nil {
				log.Fatalf("[Senora Server] Migration to ArvanCloud S3 failed: %v", mErr)
			}
			log.Printf("[Senora Server] S3 Migration Finished Successfully in %s!", report.Duration)
			log.Printf("[Senora Server] Summary: Scanned=%d, Migrated=%d, Skipped=%d, Failed=%d, Bytes Freed=%.2f MB",
				report.TotalScanned, report.MigratedCount, report.SkippedCount, report.FailedCount, float64(report.BytesFreed)/(1024*1024))
			if len(report.Errors) > 0 {
				log.Printf("[Senora Server] Warnings: %v", report.Errors)
			}
			return
		}
	}

	server := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown channel
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("[Senora Server] Listening on http://localhost:%s", cfg.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-stop
	log.Println("[Senora Server] Shutting down gracefully...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("Server shutdown warning: %v", err)
	}

	log.Println("[Senora Server] Exited.")
}
