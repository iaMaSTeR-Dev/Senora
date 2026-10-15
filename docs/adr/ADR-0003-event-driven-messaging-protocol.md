# ADR-0003: Event-Driven Messaging and Transactional Outbox Protocol

## Status
Accepted

## Context
Real-time messaging requires reliable delivery, duplicate prevention, and clean recovery after network disconnects without relying on distributed message brokers like Kafka or Redis in the initial self-hosted release.

## Decision
1. **Transactional Outbox**:
   - Every message insertion or mutation atomically inserts a row into the `event_outbox` table with an autoincrementing monotonic integer `id`.
2. **WebSocket Gateway**:
   - Clients maintain an authenticated WebSocket connection (`/api/v1/ws`).
   - Server subscribes clients to their authorized conversation events.
3. **Cursor-Based Catch-Up**:
   - When a client reconnects, it sends `sync.request` with `last_event_id`.
   - The server replays missed events starting at `last_event_id + 1` up to the latest sequence.
4. **Idempotency**:
   - Every message creation request accepts an `idempotency_key` (UUID). Re-submitting the same key returns the existing message without side effects.

## Consequences
- Guaranteed message ordering within user scope.
- Zero lost messages during client network drops.
- Minimal operational footprint: single database handles both storage and event persistence.
