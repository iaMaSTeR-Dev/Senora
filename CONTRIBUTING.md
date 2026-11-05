# Contributing to Senora

Thank you for your interest in contributing to **Senora**!

## Development Guidelines

1. **Architecture & Scope**:
   - Backend: Go 1.23+ modular monolith located in `apps/server`.
   - Frontend: React 19 + TypeScript SPA located in `apps/web`.
   - Protocol: OpenAPI 3.1 specification in `packages/protocol/openapi.yaml`.
   - Migrations: Dual-dialect SQL migrations supporting SQLite and PostgreSQL 16 in `database/migrations/`.

2. **Security & Cryptography Invariants**:
   - E2EE payloads must never be received or persisted as plaintext by the server.
   - Private keys remain exclusively within client-side IndexedDB via Web Crypto APIs.
   - Argon2id password hashing is mandatory with memory >= 64MB and iteration passes >= 3.
   - All REST handlers and WebSocket connections must enforce strict authentication and conversation membership authorization.

3. **Running Verification Locally**:
   - Backend tests:
     ```bash
     cd apps/server
     go test -v -count=1 ./...
     ```
   - Frontend tests & typecheck:
     ```bash
     cd apps/web
     npm test -- --run
     npx tsc --noEmit
     npm run build
     ```

4. **Pull Requests**:
   - Open a pull request against the `main` branch on [GitHub](https://github.com/iaMaSTeR-Dev/Senora) with a clear summary of changes and rationale.
   - Ensure all existing unit, integration, and security regression suites pass before submission.
