# TEST STRATEGY & QUALITY GATES — Senora

## 1. Testing Philosophy

1. **Test-Driven & Empirical**: Tests must execute with real assertions against actual code paths.
2. **Honest Reporting**: All reports differentiate between `Passed`, `Failed`, `Blocked`, `Skipped`, and `Not run`.
3. **No Hollow Assertions**: Tests must verify both positive (happy path) and negative (tampering, unauthorized access, expired sessions) behaviors.

---

## 2. Test Pyramid & Tooling

```text
               / \
              /   \
             / E2E \       Playwright / Browser Subagent
            /-------\
           /   INT   \     Go Integration Tests (API + WS + SQL Store)
          /-----------\
         /    UNIT     \   Go Unit Tests (Argon2id, Auth, Outbox, Crypto)
        /---------------\  Vitest (Frontend Components, CryptoEngine)
```

### Layer 1: Unit Tests
- **Go Backend**:
  - `auth`: Password hashing & verification, token generation, session validity checks.
  - `messages`: Idempotency logic, payload size limits.
  - `events`: Outbox insertion, cursor pagination, event filtering.
  - `crypto`: Key package structure and public key validation.
- **Frontend**:
  - `crypto`: Web Crypto ECDH key generation, shared secret derivation, AES-GCM encryption and decryption, tamper detection.
  - `components`: Rendering of conversation list, message bubbles, composer.

### Layer 2: Integration Tests
- **REST API + Database**:
  - Register, login, create conversation, submit message, verify outbox entry.
  - Verify unauthorized user receives 403 Forbidden when accessing another user's conversation.
  - Verify duplicate submission with identical `idempotency_key` returns existing message without duplicate row.
- **WebSocket Gateway + Outbox Replay**:
  - Connect client with valid session token.
  - Submit message via REST, observe immediate broadcast on WebSocket.
  - Disconnect client, submit 3 messages, reconnect with `last_event_id`, verify all 3 missed messages are delivered in order.

### Layer 3: End-to-End & Browser Validation
- Multi-client simulation: User Alice sends encrypted message to User Bob.
- Verify Alice client encrypts with Bob's public key.
- Verify Bob client decrypts and displays message.
- Inspect database row to confirm server stores only ciphertext.

---

## 3. Automated Quality Gates

Every code iteration must satisfy:
1. `go test -v -race ./...` (Backend tests pass with zero race conditions).
2. Frontend type checking and builds succeed.
3. No secrets or plaintexts leaked in log outputs.
