package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"nexachat/server/internal/api"
	"nexachat/server/internal/auth"
	"nexachat/server/internal/config"
	"nexachat/server/internal/conversations"
	"nexachat/server/internal/crypto"
	"nexachat/server/internal/events"
	"nexachat/server/internal/identity"
	"nexachat/server/internal/messages"
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
