# ADR-0004: Database Architecture and Dual-Driver Storage Adapter

## Status
Accepted

## Context
Production deployments use PostgreSQL 16 for ACID compliance, JSONB queries, and high concurrency. However, automated testing and local CI environments must be capable of executing rapidly and reliably even if a Docker daemon or external PostgreSQL instance is temporarily unavailable or restricted.

## Decision
1. **Repository Abstraction (`internal/storage`)**:
   - Define a domain `Store` interface covering all data operations (`CreateUser`, `GetUserByUsername`, `CreateConversation`, `AddMessage`, `GetOutboxEventsAfter`, etc.).
2. **PostgreSQL Driver**:
   - Production implementation targeting standard PostgreSQL 16 via `github.com/lib/pq` or `pgx`.
3. **Pure-Go SQLite Test Driver**:
   - CGO-free pure Go SQLite driver (`modernc.org/sqlite`) for lightning-fast, zero-dependency in-memory and local test suites.
   - Dual-tested schema ensures queries use standard SQL syntax compatible across both drivers.

## Consequences
- 100% reproducible, zero-friction automated tests run in seconds on any developer machine without requiring background services or containers.
- Production container deployments run robustly on PostgreSQL 16.
