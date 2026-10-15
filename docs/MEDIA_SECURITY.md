# Senora Client-Side Media Encryption Architecture

## 1. Principles

1. **Zero Plaintext on Server**: Photos, videos, voice messages, round video messages, and documents must be encrypted on the client device prior to network transmission.
2. **Standard Cryptographic Primitives**: NIST-approved AES-256-GCM authenticated encryption with 12-byte random IV and 128-bit authentication tag.
3. **Double Ratchet Key Distribution**: The media encryption key is never exposed to the server or sent in plaintext. It is encapsulated within the Signal Protocol multi-device envelope.
4. **No Nonce Reuse**: Every media file generates a fresh cryptographically random 256-bit symmetric key and a unique 12-byte initialization vector (IV) via `crypto.getRandomValues`.

---

## 2. Encryption Pipeline

$$\text{Raw File/Blob} \xrightarrow[\text{Web Crypto API}]{\text{AES-256-GCM (Random } K, IV)} \text{Ciphertext Blob} \xrightarrow{\text{Upload}} \text{Server Storage (/api/v1/attachments)}$$

### Step-by-Step Execution:
1. **Key Generation**:
   ```ts
   const key = await crypto.subtle.generateKey(
     { name: 'AES-GCM', length: 256 },
     true,
     ['encrypt', 'decrypt']
   );
   const iv = crypto.getRandomValues(new Uint8Array(12));
   ```
2. **Client-Side Encryption**:
   - The file `ArrayBuffer` is encrypted using `crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, fileBuffer)`.
   - The resulting encrypted `ArrayBuffer` contains ciphertext and the 16-byte authentication tag appended.
3. **Ciphertext Upload**:
   - The encrypted blob is posted via multipart form data to `/api/v1/attachments`.
   - The server stores the opaque encrypted bytes in `uploads/{attachment_id}` with metadata (`size_bytes`, `content_type`, `filename`, `is_encrypted: true`).
4. **Key Encapsulation in Signal Envelope**:
   - The sender exports the raw AES key as Base64.
   - The attachment metadata payload:
     ```json
     {
       "type": "attachment",
       "attachment": {
         "id": "att_12345",
         "filename": "photo.jpg",
         "contentType": "image/jpeg",
         "sizeBytes": 204800,
         "keyBase64": "...",
         "ivBase64": "...",
         "mediaType": "photo"
       }
     }
     ```
   - This JSON string is encrypted via `signalManager.encryptMultiDevice` using the recipient's Double Ratchet session.
   - Only authorized recipient devices with the private ratchet state can decrypt the key and IV.

---

## 3. Decryption Pipeline

$$\text{Server Storage} \xrightarrow{\text{GET /api/v1/attachments/id}} \text{Encrypted Blob} \xrightarrow[\text{Import Key + IV}]{\text{AES-256-GCM Decrypt}} \text{Decrypted Blob} \longrightarrow \text{Browser Memory (Object URL)}$$

1. Recipient receives Double Ratchet message and extracts `attachment` metadata containing `keyBase64` and `ivBase64`.
2. Client queries `GET /api/v1/attachments/{id}` (authorized by session token and conversation membership).
3. Client imports raw key via `crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])`.
4. Client decrypts ciphertext buffer with `iv`.
5. Authentication tag is verified. If tampered or corrupt, decryption throws `OperationError` and is rejected.
6. A temporary browser `Blob` is constructed with original MIME type and rendered via `URL.createObjectURL`. Object URLs are revoked upon modal dismissal or component unmount.

---

## 4. Threat Model & Mitigations

| Threat | Mitigation |
|---|---|
| **Compromised Storage / Malicious Sysadmin** | Server disk only contains high-entropy AES-GCM ciphertexts. Decryption keys never exist on the server. |
| **Tampered Ciphertext on Storage** | AES-GCM authentication tag verification fails immediately upon client decryption; client displays tamper warning. |
| **Unauthorized File Download** | `GET /api/v1/attachments/{id}` requires valid session token AND membership in the conversation owning the attachment. |
| **Path Traversal Attacks** | Storage paths are server-assigned UUIDs (`filepath.Join("uploads", attID)`). Client-supplied filenames are never used as disk paths. |
| **Oversized Media DoS** | Enforced 25 MB upload limit using Go `http.MaxBytesReader`. |

---

## 5. Media Policies by Conversation Security Mode (Phase 9 Track A)

### Normal Chat Media Policy
1. Normal Chat uses HTTPS/TLS transport with authenticated session verification.
2. Binary media (attachments, voice notes, video notes, GIFs) uploaded in Normal Chat are accessible to authorized conversation members.
3. Plaintext metadata and thumbnails are stored server-side to facilitate server-side search and history synchronization.

### E2EE Chat Media Policy
1. Client-Side Encryption: Media is encrypted on the client device using AES-256-GCM before transport.
2. Ephemeral Symmetric Keys: Generated per file; transmitted exclusively through the active Signal Protocol Double Ratchet session.
3. Server Blindness: The server schema persists opaque ciphertexts only. Server administrators, backups, and logs never encounter unencrypted media bytes or keys.
4. Downgrade Prevention: Conversations with `security_mode = "e2ee_active"` reject unencrypted uploads; client throws an explicit error rather than silently falling back to plaintext uploads.

---

## 6. Profile Avatar Management & Validation (Track C)

1. **Header Sniffing**: Avatar uploads enforce binary header inspection (magic numbers for PNG `\x89PNG\r\n\x1a\n`, JPEG `\xff\xd8\xff`, and WebP `RIFF....WEBP`). Client-provided `Content-Type` headers are untrusted.
2. **Dimension & Size Boundaries**: Maximum upload size is bounded to 5 MB. Image dimensions are capped to 2048x2048 pixels to mitigate pixel-flood decompression bombs.
3. **Storage Isolation**: Uploaded avatars are stored with server-generated filenames (`uploads/avatars/{user_id}_{timestamp}.png`). Filename sanitization strictly prevents path traversal.
4. **Access Control**: Mutations (`POST /api/v1/users/avatar`, `DELETE /api/v1/users/avatar`) enforce authenticated caller ownership. A user can only modify their own profile photo. Group avatar mutations enforce admin/owner role checks.
