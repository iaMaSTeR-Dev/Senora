# ADR-0001: Project Structure and Technology Stack

## Status
Accepted

## Context
NexaChat requires an independent, self-hosted messaging platform with high throughput, minimal operational complexity, low memory overhead, and strong automated testability.

## Decision
1. **Backend**: Use Go 1.23+ with standard library HTTP routing and `gorilla/websocket` for the WebSocket gateway. Go provides single-binary deployments, fast compilation, low latency, and robust concurrency primitives.
2. **Frontend**: Use React 19 with TypeScript, Vite, Tailwind CSS, TanStack Query for server state, and Zustand for UI state.
3. **Repository Structure**: Use a monorepo containing `apps/server`, `apps/web`, `packages/protocol`, `database/migrations`, and `deployments/`.

## Consequences
- Single language for backend with zero runtime dependencies.
- Frontend utilizes modern browser standards (Web Crypto API, IndexedDB).
- Clean separation of concerns between presentation, domain logic, and cryptographic primitives.
