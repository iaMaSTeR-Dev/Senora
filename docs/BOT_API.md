# SENORA Native Bot API

This API is independent of Telegram. Run bot programs in any language on your own
machine or server. Bot logic is not restricted to predefined server commands.
The endpoints below are implemented; Telegram method compatibility is not claimed.

## Create a bot

Every approved, non-banned account can open **Create and manage bots · BotFather**
in the sidebar menu, or open `@botfather`. Send `/newbot`, a display name, then a
unique ASCII username ending in `bot` (6–31 characters). The private conversation
returns the bot identity and an `snb_…` API key. Keep that conversation and key private.
BotFather conversations use normal server-readable messaging, not E2EE.

Built-in BotFather, Master Bot and downloader responses default to English. They
follow the account's language preference in Settings → Language (English/Persian).
Templates are localized before inserting names or user content. Custom bot programs
choose the language of their own messages; SENORA does not rewrite that content.

Commands: `/mybots`, `/manage @username`, `/token @username` (rotate and revoke the
old key), `/setname`, `/setdescription`, `/setprivacy @username on|off`,
`/setcommands @username [{"command":"start","description":"Start"}]`, `/disable`,
`/api`, `/cancel`. Disabling invalidates access and preserves message history;
this release does not reactivate disabled identities. Creating a bot never requires
server-owner permissions. Existing accounts with the reserved name are not overwritten.

Other users can open the bot's exact `@username` and send `/start`. Group owners can
add the bot's user ID like another member. A bot cannot initiate unsolicited chats
with arbitrary users. It must be a member of the target conversation.

## Authentication and delivery

Send `Authorization: Bot API_KEY` or `X-Bot-Token: API_KEY` to `/api/v1/bot/*`.
`Bearer API_KEY` is also accepted there. Keys cannot access human/admin session APIs.
Keys are randomly generated and hashed in the bot registry; only creation/rotation
responses and the private BotFather issuance message contain the raw key.
Use HTTPS in production. Never put a bot key in a URL.

`GET /api/v1/bot/me` returns `id`, `user_id`, `owner_id`, `username`, `name`,
`description`, `privacy_mode`, `enabled`, `commands`, `webhook_url`,
`webhook_failures`, `last_error`, `created_at`. It never returns the key/hash or webhook secret.

`GET /api/v1/bot/updates?offset=0&limit=100&timeout=30` returns:

```json
{"updates":[{"update_id":123,"type":"message.created","data":{"message":{"id":"msg_example","conversation_id":"cnv_example","sender_id":"usr_example","ciphertext":"{\"text\":\"Hello\"}","nonce":"normal"}},"created_at":"2026-01-01T00:00:00Z"}]}
```

Message payloads in normal chats may be JSON or raw text. Parse JSON when possible.
Events include `message.created`, `message.updated`, `message.deleted` and
`callback_query`. Callback `data` contains `id`, `from_id`, `conversation_id`,
`message_id`, `data`. Queue IDs are monotonically increasing and may have gaps.
Only advance `offset` to the last successfully processed ID + 1: sending an offset
acknowledges and deletes older events. Poll timeout is 0–50 seconds, batch size 1–100.
Polling and webhooks are mutually exclusive (HTTP 409). Events survive restarts.
Unacknowledged events expire after seven days; callbacks may be answered for five minutes.

For webhooks, use the bot key:

```http
PUT /api/v1/bot/webhook
Authorization: Bot API_KEY
Content-Type: application/json

{"url":"https://your-bot.example/senora","secret":"replace-with-a-random-secret-at-least-16-characters"}
```

The server sends each event JSON with `X-Senora-Bot-Secret`. Validate that secret,
return a 2xx status only after successful processing, and deduplicate by `update_id`.
Delivery is at least once; failures remain queued with exponential retry up to
256 seconds. Each request has a 12-second deadline. Redirects and private network
destinations are rejected. `PUT` with `{"url":""}` disables the webhook and allows
polling. The dispatcher sends one pending event per eligible bot per cycle; network
latency and the sequential worker affect throughput. This is not an unlimited-throughput service.

## Messages and buttons

```http
POST /api/v1/bot/messages
Authorization: Bot API_KEY
Content-Type: application/json

{"conversation_id":"cnv_example","text":"Choose an action","idempotency_key":"order-123-reply","buttons":[[{"text":"Confirm","callback_data":"confirm:123"},{"text":"Website","url":"https://example.com"}]]}
```

Returns the committed message with HTTP 201. Optional fields: `reply_to_id`,
`topic_id`, `attachment_id`, `poll_id`. A repeated idempotency key in the same chat
does not create a second message. Reuse the same key on network retries.
Text limit: 32,000 Unicode characters, subject to the message service's 64 KiB
serialized payload limit. At most 20 rows × 8 buttons; callback data at most 128 bytes.
Each button has text and exactly one HTTP(S) URL or callback value.

`PATCH /bot/messages/{message_id}` accepts the same body with `conversation_id`:
edits the bot's own message text/keyboard. Existing attachments are preserved;
changing an attachment requires a new message.
`DELETE /bot/messages/{message_id}?conversation_id=...` removes a message according
to conversation permissions. `POST /bot/forward` accepts `conversation_id`,
`message_id`, optional `idempotency_key`, and copies a visible normal message.

`POST /bot/callbacks/{callback_id}/answer` accepts
`{"text":"Done","show_alert":true}`. Answers are delivered to the clicking user
through the normal WebSocket/replay channel. Forged button values, another bot's
callbacks, duplicate answers and expired callbacks are rejected.

## Files

`POST /bot/attachments`: multipart fields `conversation_id` and `file`.
Bot uploads are plaintext and only allowed in normal conversations. The response
is an attachment object; send its `id` as `attachment_id` in `/bot/messages`.
Photos, video, audio and arbitrary documents use this same upload endpoint.
The multipart part's Content-Type determines the media rendering type.

`GET /bot/attachments/{attachment_id}` streams accessible files and supports HTTP
Range. Files remain subject to message visibility and view-once restrictions.
`POST /bot/media/share` accepts `attachment_id` and the existing media-share settings;
`DELETE /bot/media/share/{share_id}` revokes an owned share.
Upload capacity follows `MAX_UPLOAD_BYTES` (default 500 MiB) and free disk space;
multipart overhead counts toward the request limit. No full-file RAM buffering is needed.

## Conversation features

All paths below start with `/api/v1/bot`:

| Method | Path | Action |
| --- | --- | --- |
| GET | `/conversations` | Joined conversations |
| GET | `/conversations/{id}` | Conversation metadata |
| GET | `/conversations/{id}/members` | Members |
| GET | `/conversations/{id}/messages?before_id=...&limit=50` | Visible history, filtered by bot privacy |
| POST | `/conversations/{id}/typing` | Typing event |
| POST | `/conversations/{id}/leave` | Leave |
| POST | `/conversations/{id}/read` | Mark read, existing read-state body |
| POST | `/conversations/{id}/messages/{msgId}/reactions` | Existing reaction body |
| GET/POST | `/conversations/{id}/topics` | List/create forum topics |
| POST | `/conversations/{id}/polls` | Create poll |
| GET | `/conversations/{id}/polls/{pollId}` | Read poll |
| POST | `/conversations/{id}/polls/{pollId}/close` | Close own poll |
| GET/POST | `/conversations/{id}/pins` | List/add pins |
| DELETE | `/conversations/{id}/pins/{msgId}` | Remove pin |
| PATCH | `/conversations/{id}` | Update conversation |
| GET/POST | `/conversations/{id}/invites` | List/create invites |
| DELETE | `/conversations/{id}/invites/{code}` | Revoke invite |
| DELETE | `/conversations/{id}/members/{userId}` | Remove member |
| PUT | `/conversations/{id}/members/{userId}/role` | Change member role |

Administrative operations require the bot to be a conversation administrator or
owner, with the underlying handler's additional restrictions. These reuse the
normal SENORA bodies documented in `PROTOCOL.md` and the web API client. Channel
publishing requires an administrator role. Privacy-enabled group bots receive
commands, mentions and replies to the bot; disable privacy to receive all normal
group messages. Message/attachment reads and forwarding enforce the same visibility.
Server bots cannot join E2EE conversations or receive private whispers. Bot-to-bot
message updates are suppressed to prevent feedback loops.

Request bodies for the conversation operations:

| Operation | JSON body |
| --- | --- |
| Typing, leave, close poll | `{}` |
| Mark read | `{"message_id":"msg_example"}`; omit ID to mark the conversation read |
| Reaction | `{"emoji":"👍"}`; the same reaction toggles it |
| Create topic | `{"title":"Support","icon":"💬","color":"#24a1de"}` |
| Add pin | `{"message_id":"msg_example"}` |
| Update conversation | `{"title":"New title","description":"Description","avatar_url":""}` |
| Create invite | `{"max_uses":10,"expires_in_hours":24}`; zero means no limit |
| Change member role | `{"role":"admin"}` or `{"role":"member"}` |
| Create poll | `{"question":"Continue?","options":["Yes","No"],"is_anonymous":true,"allows_multiple":false,"is_quiz":false}` |

Quiz polls additionally accept zero-based `correct_option` and `explanation`.
Creating a poll returns its ID; post a message with `poll_id` to display it in chat.
In privacy-enabled groups a bot can retrieve its own polls; reading other members'
poll results requires privacy to be disabled.

This release has no Telegram inline-query/payment/games compatibility layer,
and does not expose every human WebSocket event (such as poll-vote changes) through
the bot queue. Poll results can be retrieved through the poll API. The implemented
message/callback API supports custom workflows without running bot code on SENORA.

## Owner management API

These endpoints use the **human owner's session Bearer token**, not the bot key:
`GET/POST /api/v1/bots`, `GET/PATCH/DELETE /api/v1/bots/{bot_id}`,
`POST /api/v1/bots/{bot_id}/token`, `PUT /api/v1/bots/{bot_id}/webhook`,
`POST /api/v1/botfather/open`. Creation body: `username`, `name`.
PATCH accepts `name`, `description`, `privacy_mode`, `commands`; omitted fields
retain their previous values. DELETE disables, preserving historical data.

## Runnable Python examples

The repository includes `echo_bot.py` and `webhook_bot.py` (source: `examples/bots/`).

```bash
export SENORA_BASE_URL='https://your-senora.example'
read -rsp 'Bot API key: ' SENORA_BOT_TOKEN; echo
export SENORA_BOT_TOKEN
python3 echo_bot.py
```

The polling example handles messages and buttons, checkpoints acknowledged IDs,
and uses stable outbound idempotency keys. To use webhooks, stop polling, set
`SENORA_WEBHOOK_SECRET`, run `webhook_bot.py` behind an HTTPS reverse proxy and
register its public URL. Keep its SQLite deduplication state persistent.
