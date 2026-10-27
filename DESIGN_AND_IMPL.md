# Design & Implementation Guide

Internal reference for developers working on the `whatsapp-emulator-ui` package. Covers architecture decisions, how the pieces fit together, the underlying emulator library, and what you need to know to modify or extend this code.

---

## Table of Contents

- [Purpose & Goals](#purpose--goals)
- [Architecture Overview](#architecture-overview)
- [Process & Port Layout](#process--port-layout)
- [Message Flow Diagrams](#message-flow-diagrams)
- [The Underlying Emulator Library](#the-underlying-emulator-library)
- [Our Integration Layer](#our-integration-layer)
- [WhatsApp Flows & Interactive Replies](#whatsapp-flows--interactive-replies)
- [Configuration System](#configuration-system)
- [Message Persistence](#message-persistence)
- [WebSocket Protocol](#websocket-protocol)
- [UI Message Format](#ui-message-format)
- [File Reference](#file-reference)
- [Design Decisions & Rationale](#design-decisions--rationale)
- [Known Limitations & Future Work](#known-limitations--future-work)

---

## Purpose & Goals

This package is a **self-contained WhatsApp Cloud API emulator** for local development. It exists so developers can:

1. Test WhatsApp bot integrations without a Meta Business account or phone number
2. See bot responses in a real-time browser UI that mimics WhatsApp Web
3. Persist conversations locally so they survive page refresh and restarts
4. Work with **any** backend — the only requirement is that the backend speaks the WhatsApp Cloud API

The package is designed to be general-purpose: not coupled to any specific backend implementation.

---

## Architecture Overview

The system has three servers running in a single Node.js process, plus a browser client:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Node.js Process                             │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐    │
│  │  UI Server   │   │    Proxy     │   │    Emulator       │    │
│  │  (Express)   │   │  (Express)   │   │ (@whatsapp-cloud  │    │
│  │  :3000       │   │  :4004       │   │  api/emulator)    │    │
│  │              │   │              │   │  :4005            │    │
│  │  - Static UI │   │  - Intercept │   │                   │    │
│  │  - REST API  │   │    bot msgs  │   │  - Cloud API      │    │
│  │  - WebSocket │   │  - Forward   │   │    endpoints      │    │
│  │  - History   │   │    to emu    │   │  - Webhook firing  │    │
│  │  - Replies   │   │  - Persist   │   │  - Debug endpoints │    │
│  └──────┬───────┘   └──────┬───────┘   └──────────────────┘    │
│         │                  │                                    │
│         │           ┌──────┴───────┐                            │
│         │           │   SQLite     │                            │
│         │           │  (store.mjs) │                            │
│         │           └──────────────┘                            │
│         │                                                       │
└─────────┼───────────────────────────────────────────────────────┘
          │ WebSocket
          │
    ┌─────┴──────┐         ┌─────────────────┐
    │  Browser   │         │  Your Backend   │
    │  (UI)      │         │  (any language)  │
    │  :3000     │         │  :8000           │
    └────────────┘         └─────────────────┘
```

---

## Process & Port Layout

Three ports, one process:

| Port | Server | Role |
|------|--------|------|
| `:3000` (UI_PORT) | UI Server | Serves the browser UI, WebSocket, REST API for sending messages and fetching history; posts button, list and Flow replies to the backend webhook itself |
| `:4004` (EMULATOR_PORT) | Proxy | **The port your backend should target.** Intercepts outbound bot messages, forwards them to the real emulator, then persists them and broadcasts to the UI with the `wamid` the emulator returned |
| `:4005` (EMULATOR_PORT+1) | Internal Emulator | The actual `@whatsapp-cloudapi/emulator` instance. Never exposed to the backend directly |

The proxy sits on the "public" emulator port so the backend doesn't know it exists. This is how we intercept bot messages without modifying the emulator library.

---

## Message Flow Diagrams

### User sends a message (from browser)

Typed text only; button, list and Flow answers take [the reply path](#user-answers-a-button-list-or-flow).

```
Browser                UI Server :3000           Proxy :4004              Emulator :4005          Backend :8000
  │                        │                        │                        │                       │
  │  POST /api/send        │                        │                        │                       │
  │  {message: "Hi"}       │                        │                        │                       │
  │───────────────────────>│                        │                        │                       │
  │                        │                        │                        │                       │
  │                        │  POST /debug/messages/ │                        │                       │
  │                        │  send-text             │                        │                       │
  │                        │───────────────────────>│                        │                       │
  │                        │                        │  forward to :4005      │                       │
  │                        │                        │───────────────────────>│                       │
  │                        │                        │                        │                       │
  │                        │                        │                        │  POST /api/whatsapp/  │
  │                        │                        │                        │  webhook              │
  │                        │                        │                        │  (webhook payload)    │
  │                        │                        │                        │──────────────────────>│
  │                        │                        │                        │                       │
  │                        │  WS: user_message      │                        │                       │
  │  <─────────────────────│                        │                        │                       │
  │                        │  store.save(user msg)  │                        │                       │
  │                        │                        │                        │                       │
```

### Bot sends a response

```
Backend :8000          Proxy :4004              Emulator :4005          UI Server :3000         Browser
  │                        │                        │                       │                      │
  │  POST /v24.0/{id}/     │                        │                       │                      │
  │  messages              │                        │                       │                      │
  │  {type:"text",         │                        │                       │                      │
  │   text:{body:"Hello"}} │                        │                       │                      │
  │───────────────────────>│                        │                       │                      │
  │                        │                        │                       │                      │
  │                        │  extractBotMessage()   │                       │                      │
  │                        │  attachMedia()         │                       │                      │
  │                        │                        │                       │                      │
  │                        │  forward to :4005      │                       │                      │
  │                        │───────────────────────>│                       │                      │
  │                        │  {messages:[{id:       │                       │                      │
  │                        │   "wamid..."}]}        │                       │                      │
  │                        │<───────────────────────│                       │                      │
  │                        │                        │                       │                      │
  │                        │  botMessage.wamid = id │                       │                      │
  │                        │  WS broadcast ─────────┼──────────────────────>│                      │
  │                        │  store.save(bot msg)   │                       │  WS: bot_message     │
  │                        │                        │                       │─────────────────────>│
  │                        │                        │                       │                      │
  │  response {messages:   │                        │                       │                      │
  │  <─────────────────────│  [{id:"wamid..."}]}    │                       │                      │
  │                        │                        │                       │                      │
  │                        │  WS: status "sent"     │                       │                      │
  │                        │  (after 200ms)  ───────┼──────────────────────>│  WS: status ✓       │
  │                        │  WS: status "delivered"│                       │─────────────────────>│
  │                        │  (after 800ms)  ───────┼──────────────────────>│  WS: status ✓✓      │
  │                        │                        │                       │─────────────────────>│
```

The bot message is broadcast and saved only once the emulator has answered, so it carries `wamid` (`messages[0].id`), the id the backend keeps for it and the one a reply's `context.id` must carry. If the emulator rejects the message or can't be reached, it is still shown, without `wamid`.

### User answers a button, list or Flow

```
Browser                UI Server :3000                     Backend :8000
  │                        │                                   │
  │  click a button, list  │                                   │
  │  row, or a Flow Footer │                                   │
  │  with `complete`       │                                   │
  │                        │                                   │
  │  POST /api/send-       │                                   │
  │  interactive  or       │                                   │
  │  POST /api/send-flow-  │                                   │
  │  reply                 │                                   │
  │───────────────────────>│                                   │
  │                        │  userMsg.id = newWamid()          │
  │  WS: user_message      │  store.save(userMsg)              │
  │<───────────────────────│                                   │
  │                        │  POST webhook.url (background)    │
  │                        │  Meta envelope, context.id =      │
  │                        │  answered msg's wamid,            │
  │                        │  X-Hub-Signature-256 (app_secret) │
  │                        │──────────────────────────────────>│
  │  WS: message_update    │  Flow only: store.update(msg with │
  │  (Flow button disabled)│  flow.completed)                  │
  │<───────────────────────│                                   │
  │  {messageId}           │                                   │
  │<───────────────────────│                                   │
  │                        │  (the backend runs its turn and   │
  │                        │   may send messages via :4004)    │
  │                        │  2xx                              │
  │                        │<──────────────────────────────────│
  │  WS: status            │                                   │
  │  "delivered" (✓✓)      │                                   │
  │<───────────────────────│                                   │
```

If the webhook is unreachable, answers non-2xx or takes over 5 minutes: WS `error` `{message, replyTo}` instead of `delivered` (the bubble keeps one tick), and a Flow message is written back without `completed` and broadcast again (`message_update`), so it can be submitted once more. See [WhatsApp Flows & Interactive Replies](#whatsapp-flows--interactive-replies).

### History load on page open

```
Browser                UI Server :3000           SQLite
  │                        │                        │
  │  WS connect            │                        │
  │───────────────────────>│                        │
  │                        │                        │
  │  WS: config            │                        │
  │  <─────────────────────│                        │
  │                        │                        │
  │  GET /api/history      │                        │
  │───────────────────────>│                        │
  │                        │  getHistory(sessionId) │
  │                        │───────────────────────>│
  │                        │  <─────────────────────│
  │  {session_id, messages}│                        │
  │  <─────────────────────│                        │
  │                        │                        │
  │  render all messages   │                        │
```

---

## The Underlying Emulator Library

We use [`@whatsapp-cloudapi/emulator`](https://github.com/ericvera/whatsapp-cloudapi) v4.0.0 — an open-source TypeScript library that emulates Meta's WhatsApp Cloud API.

### What it provides

The library is a drop-in replacement for `graph.facebook.com`. It:

- Exposes the same REST endpoints as the real Cloud API (`POST /:version/:phoneNumberId/messages`, media upload, etc.)
- Fires webhook events to your configured URL in the exact same format as Meta
- Simulates delivery statuses (sent → delivered → read)
- Validates message payloads (API version, phone number ID, media IDs, CTA URLs)
- Provides debug endpoints for simulating inbound messages

### Constructor & lifecycle

```javascript
import { WhatsAppEmulator } from "@whatsapp-cloudapi/emulator";

const emulator = new WhatsAppEmulator({
  businessPhoneNumberId: "15551234567",   // required
  port: 4005,                              // default: auto
  host: "localhost",                       // default: localhost
  delay: 0,                               // simulate network delay (ms)
  webhook: {
    url: "http://localhost:8000/api/whatsapp/webhook",  // required
    verifyToken: "test-verify-token",                    // required
    appSecret: "optional-hmac-secret",                   // adds X-Hub-Signature-256
    timeout: 5000,                                       // webhook call timeout (ms)
  },
  log: {
    level: "normal",  // "quiet" | "normal" | "verbose"
  },
});

await emulator.start();  // starts Express server
await emulator.stop();   // graceful shutdown
```

### Cloud API endpoints (served by the emulator)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/:version/:phoneNumberId/messages` | Send outbound message (text, interactive, template, image, reaction) |
| `POST` | `/:version/:phoneNumberId/media` | Upload media (the proxy intercepts this; see [Media storage](#media-storage)) |
| `GET`  | `/webhook` | Webhook subscription verification (hub.mode=subscribe) |

### Debug endpoints (for testing)

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/debug/health` | Health check → `{status: "ok"}` |
| `POST` | `/debug/messages/send-text` | Simulate inbound text message |
| `POST` | `/debug/messages/send-interactive` | Simulate inbound button/list reply (not used by the UI, see [Why replies bypass the library](#why-replies-bypass-the-library)) |
| `GET`  | `/debug/media/list` | List uploaded media files |
| `POST` | `/debug/media/expire/:id` | Expire a specific media file |
| `POST` | `/debug/media/expire/all` | Expire all media |

### Debug endpoint payloads

**Send text** (`POST /debug/messages/send-text`):
```json
{
  "from": "+17871234567",
  "message": "Hello!",
  "name": "John Doe"
}
```

**Send interactive** (`POST /debug/messages/send-interactive`):
```json
{
  "from": "17871234567",
  "interactive_type": "button_reply",
  "button_id": "btn_1",
  "button_title": "Yes",
  "name": "John"
}
```

### Webhook payload format

The emulator fires webhooks in Meta's standard format. Example for an inbound text message:

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "15551234567",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "15551234567",
          "phone_number_id": "15551234567"
        },
        "contacts": [{
          "wa_id": "1234567890",
          "profile": { "name": "Test User" }
        }],
        "messages": [{
          "id": "mock_incoming_1710000000000_abc123",
          "from": "1234567890",
          "timestamp": "1710000000",
          "type": "text",
          "text": { "body": "Hello!" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

Note: the `from` field is the phone number **without** the `+` prefix.

If `appSecret` is configured, the webhook includes `X-Hub-Signature-256: sha256={hmac}` computed from the raw JSON body.

---

## Our Integration Layer

### Why a proxy?

The emulator library is a black box — we can't hook into its internals to intercept bot messages. The proxy pattern lets us:

1. **Intercept** outbound bot messages before they reach the emulator
2. **Extract** message content into a UI-friendly format
3. **Persist** messages to SQLite
4. **Broadcast** to the browser via WebSocket
5. **Forward** the original request to the emulator unchanged

The backend sets `WHATSAPP_API_BASE_URL_OVERRIDE=http://localhost:4004` (proxy), not `:4005` (emulator). It doesn't know the proxy exists.

### The `extractBotMessage()` function

Located in `server.mjs`. This is the translator between WhatsApp Cloud API message format and our internal UI message format. It handles:

| Cloud API `body.type` | UI `msgType` | Key fields extracted |
|----------------------|--------------|---------------------|
| `text` | `text` | `text.body` |
| `interactive` (button) | `interactive` | `body`, `header`, `footer`, `buttons[]` |
| `interactive` (list) | `interactive` | `body`, `listButton`, `listSections[]` |
| `interactive` (cta_url) | `interactive` | `ctaUrl`, `ctaText` |
| `interactive` (flow) | `interactive` | `body`, `header`, `footer`, `flow: {id, token, cta, action, screen, data, mode, messageVersion}` (see [Flow messages](#flow-messages)) |
| `template` | `template` | `templateName`, `components[]` |
| `image` | `image` | `imageUrl`, `caption` |
| `video` / `audio` / `document` / `sticker` | same | `caption` |
| `reaction` | `reaction` | `emoji`, `reactedMessageId` |

If the type is unrecognized, it falls back to `text` with the raw JSON body as content.

Messages that carry a file get a `media` field added afterwards by `attachMedia()` (see [Media storage](#media-storage)). Once the emulator answers, the proxy adds `wamid` = `messages[0].id`.

### Media storage

**Files:** `src/media.mjs` (`MediaStore`), wiring in `src/server.mjs`.

Files the bot sends are written to `data/media/` (next to the database; `storage.media_dir` / `MEDIA_DIR` to change), flat, as `<mediaId>.<original name>`. The id is everything before the first dot, so the in-memory id → file index is rebuilt from the directory listing on startup — no extra table or manifest. Names are sanitized (no path parts or reserved characters); a missing extension is added from the MIME type.

There are two ways a bot sends a file, and the proxy handles both:

| Bot request | What the proxy does |
|-------------|---------------------|
| `POST /:version/:phoneNumberId/media` (multipart) | Parses the body with the built-in `Request.formData()` (no multipart dependency), passes the file to the internal emulator to get an id, stores the bytes under that id. |
| Message with `{image\|video\|audio\|document\|sticker: {id}}` | Looks the id up in the store. |
| Message with `{... {link}}` | Downloads the link (10 s timeout, size capped) and stores it under a new id. |

The emulator library keeps only metadata for an upload (the bytes are discarded) and rejects anything but JPEG/PNG up to 5 MB. So the proxy forwards each upload to the library first: if it accepts, its id is used (the library validates `image.id` on send, and its `/debug/media/*` endpoints keep working); if it answers with a `ValidationError` (file type or size only), the proxy accepts the file itself under a generated `media_<hex>` id. Version / phone number errors are passed through unchanged. For `image` messages sent by link, the downloaded copy is registered with the library the same way, because the library otherwise rejects images without an id.

`attachMedia()` runs before the message is broadcast and stored: it sets `message.media = {kind, id, fileName, mimeType, size, link?}` on success, or `{kind, link?, error}` when the file can't be obtained (the message still shows). It also covers the header media of interactive and template messages. `media` is persisted in the message's `metadata` JSON, so history renders files without any schema change.

The UI loads bytes from `GET /api/media/:id` (Range requests work, so audio/video can seek). Images, audio, video, PDF and plain text are served inline; anything else, including HTML and SVG, is sent as an attachment with `nosniff`, since the files come from whatever the bot sends and are served from the UI's origin.

### Request classification in the proxy

The proxy distinguishes three types of `POST /:version/:phoneNumberId/messages`:

| Type | Detection | Action |
|------|-----------|--------|
| **Actual message** | Not mark-as-read, not typing indicator | Extract, forward, then persist + broadcast with `wamid` |
| **Mark as read** | `body.status === "read" && body.message_id` | Broadcast read status, forward |
| **Typing indicator** | `body.type === "text" && !body.text` | Broadcast typing event, forward |

---

## WhatsApp Flows & Interactive Replies

**Files:** `src/webhook.mjs` (envelope, signature, POST), `sendReply()` and the `/api/send-interactive`, `/api/send-flow-reply`, `/api/flows/:flowId` handlers in `src/server.mjs`, and the "WhatsApp Flows" section of `src/ui/index.html`.

### Why replies bypass the library

Button and list replies used to go through the library's `POST /debug/messages/send-interactive`. That never worked: the UI sent `type`, `reply_id`, `reply_title`, while the library expects `interactive_type`, `button_id` / `button_title` or `list_item_id` / `list_item_title` / `list_item_description`, so every reply was rejected with 400. Fixing the field names would not have been enough:

- the library has no `nfm_reply`, the inbound message a submitted Flow produces, and
- its `WebhookService` puts no `context` on inbound messages, while a backend that ties an answer to the message it sent checks `context.id` against the `wamid` it got back.

So the UI server posts every interactive reply to `webhook.url` itself (`postInbound()` in `src/webhook.mjs`), in the envelope the library's `WebhookService` builds, which is Meta's. Typed text still goes through the library's `/debug/messages/send-text` (see [User sends a message](#user-sends-a-message-from-browser)), without `context`.

### What the backend receives

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "15551234567",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "15551234567", "phone_number_id": "15551234567" },
        "contacts": [{ "wa_id": "1234567890", "profile": { "name": "You" } }],
        "messages": [{
          "context": { "from": "15551234567", "id": "wamid.<the Flow message's wamid>" },
          "from": "1234567890",
          "id": "wamid.<new>",
          "timestamp": "1761562800",
          "type": "interactive",
          "interactive": {
            "type": "nfm_reply",
            "nfm_reply": { "name": "flow", "body": "Sent", "response_json": "{\"flow_token\":\"...\",\"date\":\"2026-11-03\"}" }
          }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

| Field | Value |
|-------|-------|
| `entry[].id`, `metadata.phone_number_id` | The library's business phone number id (`bot.phone_number_id`) |
| `metadata.display_phone_number`, `context.from` | The library's display number: `1555` + the last 7 digits of the phone number id |
| `contacts[0]` | `{wa_id: user.phone without "+", profile: {name: user.name}}` |
| `messages[0].id` | `newWamid()`: `"wamid."` + 24 random bytes in base64. The user's bubble has the same id, so the backend's mark-as-read (`message_id`) matches it |
| `messages[0].timestamp` | Unix seconds, as a string |
| `messages[0].context` | `{from, id: <wamid of the answered message>}`, only when that message has a `wamid`. Left out rather than guessed |
| `messages[0].interactive` | `{type: "button_reply", button_reply: {id, title}}`, `{type: "list_reply", list_reply: {id, title, description?}}` or `{type: "nfm_reply", nfm_reply: {name: "flow", body: "Sent", response_json}}` |

When `webhook.app_secret` / `WHATSAPP_WEBHOOK_SECRET` is set, the request carries `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`, as the library's own webhooks do.

### Reply path (`sendReply()`)

1. The user's bubble goes out first (`user_message` broadcast + `store.save()`), as WhatsApp shows a reply at once.
2. The envelope is posted in the background and the REST call answers `{messageId}` without waiting: a backend may run its whole turn (LLM calls, outbound messages through the proxy) inside the webhook request. The timeout is 5 minutes (`WEBHOOK_TIMEOUT_MS`).
3. A 2xx answer → WS `status` `delivered` for the bubble.
4. Unreachable, non-2xx or timed out → `[webhook] ...` on the console and WS `error` `{message, replyTo}` (`replyTo` = UI id of the answered message; the UI re-enables that message's buttons). The bubble keeps one tick. For a Flow, the `completed` mark is undone (see [Flow messages](#flow-messages)).

Delivery failures are reported over the WebSocket, not as an HTTP error, because the REST call has already answered. There is no backend health check before a reply (unlike `/api/send`).

### REST endpoints

| Endpoint | Body | Answers |
|----------|------|---------|
| `POST /api/send-interactive` | `{type: "button_reply"\|"list_reply", reply_id, reply_title, reply_description?, message_id}`. `message_id` is the UI id of the message answered; `reply_title` defaults to `reply_id`; `reply_description` is sent for list replies only | `{messageId}`; 400 for another `type` or no `reply_id` |
| `POST /api/send-flow-reply` | `{message_id, response}`. `response` is an object, sent as `{flow_token, ...response}` (`flow_token` added unless present), or a string, sent verbatim as `response_json` | `{messageId}`; 404 when `message_id` isn't a stored Flow message; 409 once submitted (`completed` is set at submit, so also while a submission is in flight); 400 when `response` is neither |
| `GET /api/flows/:flowId` | — | The Flow JSON from the file `cfg.flows` maps the id to, read at every call; 404 when unmapped; 500 when the file can't be read or parsed |

### Flow messages

`extractBotMessage()` keeps everything needed to open and answer a Flow, also after a reload:

```javascript
flow: {
  id,              // action.parameters.flow_id ?? flow_name
  token,           // flow_token
  cta,             // flow_cta
  action,          // flow_action, default "navigate"
  screen, data,    // flow_action_payload
  mode,            // mode: "draft" | "published" (default)
  messageVersion,  // flow_message_version
  completed,       // set once submitted: {at, replyId}
}
```

It is stored with the message's `wamid` in the `metadata` JSON (no schema change). On submit, `/api/send-flow-reply` saves the user's `flow_reply` message (via `sendReply()`), then `store.update()`s the Flow message with `flow.completed` and broadcasts `message_update`, which re-draws it with its button disabled. If delivery fails, the original message is written back and broadcast again, so the Flow can be submitted once more. A Flow message saved before the emulator kept `flow` shows a disabled button.

### The Flow sheet (UI)

Opening a Flow fetches `GET /api/flows/:id`:

- **Flow JSON with screens** — the screen named in `flow.screen` opens, or the first (with a notice when the named one isn't in the JSON), with `flow.data` as its data. With `flow_action: "data_exchange"` the data would come from the Flow endpoint, so the screen's `__example__` values are used instead, with a notice. A screen whose declared `data` keys the message didn't send gets a warning.
- **404, unreadable, or no `screens`** — the sheet opens in JSON mode: the message's `flow_action_payload` (`{screen, data}`) and an editor pre-filled with `{"flow_token": ...}`, sent verbatim as `response_json`.

`mode: "draft"` shows a Draft badge on the Flow's button and in the sheet's header.

Screens are a stack of frames `{id, data, form, ui, errors, seen, warnings}`: `navigate` pushes the target screen with the resolved `payload` as its data, ‹ pops. References `${data.x}`, `${form.x}` and `${screen.<ID>.form.x}` / `${screen.<ID>.data.x}` are resolved in component properties, screen titles and action payloads; a string that is a single reference keeps the value's type (arrays, booleans, objects). A string in backticks is a nested expression (Flow JSON 6.0+), e.g. `` `${form.age} >= 18` ``: `evalExpression()` parses it, never `eval`s it — references, `'strings'`, numbers, `true` / `false` / `null`, `!`, unary `-`, `* / %`, `+ -`, comparisons, `== !=`, `&&`, `||`, parentheses, and juxtaposition to join strings. An expression it can't read is `undefined`, with a console warning.

| Component | Supported |
|-----------|-----------|
| TextHeading, TextSubheading, TextBody, TextCaption, RichText | `markdown` (bold, italic, strikethrough, links; always on for RichText), `font-weight`, `strikethrough` |
| TextInput, TextArea | `label`, `helper-text`, `init-value`, `required`; TextInput `input-type`, `min-chars` / `max-chars` (default 80), `pattern`, `error-message`; TextArea `max-length` (default 600) |
| Dropdown, RadioButtonsGroup, CheckboxGroup, ChipsSelector | `data-source`, `init-value`, `required`, `on-select-action` / `on-unselect-action`, also per option (Flow JSON 6.0+); CheckboxGroup / ChipsSelector `min-selected-items` / `max-selected-items` |
| OptIn | `required`, `on-select-action` / `on-unselect-action`; `on-click-action` as a "Read more" link |
| DatePicker | A date field that opens a month view |
| CalendarPicker | An always-shown month view; `mode: "range"` gives `{"start-date", "end-date"}`, with `min-days` / `max-days` |
| Footer | `label`, `left-caption` / `center-caption` / `right-caption`, `enabled`; `on-click-action` `navigate`, `complete`, `update_data` or `open_url` |
| EmbeddedLink, Image | Image `src` as base64 |
| Form | A transparent container that applies `init-values` (older Flow JSON) |
| If, Switch | If renders `then` or `else` by its `condition` (an expression, with or without backticks); Switch renders `cases[value]` |
| Anything else (NavigationList, PhotoPicker, DocumentPicker, ...) | A labelled placeholder, "`<type>`: not rendered by the emulator" |

A component with `visible: false` is skipped; an input without a `name` is a placeholder. Every input registers a `missing()` check, and the Footer stays disabled while a `required` one is empty; other checks (length, input type, pattern, selection counts) run on the Footer click. A `navigate` Footer also waits until its payload has a value for each key the next screen declares in its `data`. A Footer whose action is `data_exchange` (or any action not listed above) is disabled, with a note; a `data_exchange` from another trigger shows an error. `complete` sends `{flow_token, ...payload}` with the payload resolved. Escape closes the sheet; it also closes when its Flow is submitted or the session is reset.

The `{ }` header button switches a mapped Flow to JSON mode, pre-filled with `flow_token` and the current screen's `complete` payload, to send anything: a wrong `flow_token`, a date never offered, a missing field.

**Calendar.** A month view starting on the locale's first weekday (`Intl.Locale` week info, otherwise Sunday). A day can't be picked when it is before `min-date`, after `max-date`, in `unavailable-dates`, or its weekday (`Mon` ... `Sun`) isn't in `include-days`; the month arrows stop at `min-date` / `max-date`.

**Dates.** Values are `"YYYY-MM-DD"` with no time zone, built from year/month/day (`isoDate()`), never with `toISOString()`: a local midnight converted to UTC is the previous day east of Greenwich (Israel is UTC+2/+3). A `DatePicker` in Flow JSON before 5.0 stores a timestamp in ms (noon UTC of the day) instead; `toIsoDate()` reads both forms.

**Direction.** The sheet takes the direction of the first letter in the start screen's title, texts and string data (`rtl` for Hebrew, Arabic and other right-to-left scripts). A right-to-left sheet with Hebrew or Arabic text also sets the locale (`he-IL` / `ar`) for month and weekday names; otherwise the browser's locale is used. Each text node also has `dir="auto"`.

### What a backend should check

A backend typically accepts a Flow answer only when `flow_token` is the one it sent, the values are ones it offered (a date from its list, say), and `context.id`, when present, is the `wamid` it got back for the Flow message. The emulator meets all three when the Flow message went through the proxy; the `{ }` toggle breaks any of them on purpose.

---

## Configuration System

**File:** `src/config.mjs`

Three-layer config resolution: **defaults → YAML → env vars** (env wins).

```
Hardcoded defaults
       ↑ overridden by
config.yaml values
       ↑ overridden by
Environment variables
```

### Session ID derivation

The session ID determines which SQLite message history is loaded. Two modes:

1. **Explicit:** Set `session_id` in `config.yaml` — useful for pinning to a specific conversation
2. **Derived (default):** `SHA-256(phone_number)` formatted as a UUID-v4-shaped string

The derivation is deterministic: same phone → same session ID → same history. Implemented in `phoneToSessionId()`.

```javascript
// "+1234567890" always maps to "422ce82c-6fc1-424a-c878-042f7d055653"
function phoneToSessionId(phone) {
  const hex = createHash("sha256").update(phone).digest("hex");
  return [hex.slice(0,8), hex.slice(8,12), "4"+hex.slice(13,16),
          hex.slice(16,20), hex.slice(20,32)].join("-");
}
```

### Flows map

`loadFlows()` builds `cfg.flows`, a `Map` from flow id to an absolute file path:

1. the YAML `flows:` map (`flow_id` or `flow_name` → Flow JSON path), then
2. `FLOWS="id=path,id=path"`, which overrides it per id.

Paths resolve from CWD, like the DB and media paths. At startup each mapping is logged as `[flows] <id> → <path>`, with `(file not found)` when the file is missing. The file itself is read by `GET /api/flows/:flowId` on every open, so an edited Flow JSON applies without a restart. A path never comes from a request: the endpoint only looks the id up in `cfg.flows`.

```yaml
flows:
  my-flow-id: "flows/my_flow.json"
```

### Backend health paths

`webhook.health_paths` (env `HEALTH_PATHS`; a YAML list or a comma-separated string, default `/health,/api/health`): the paths `/api/send` tries on the origin of `webhook.url` before forwarding a typed message; the first 2xx counts as up. When none answers, the message is shown and saved but not forwarded, and the UI gets an `error`.

---

## Message Persistence

**File:** `src/store.mjs`

### SQLite schema

```sql
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,       -- message ID (e.g., "user_1710000000000", "wamid.<base64>" for replies, or "bot_1710000000000_abc123")
  session_id  TEXT NOT NULL,          -- links to config session
  role        TEXT NOT NULL,          -- "user" or "assistant"
  content     TEXT NOT NULL,          -- plain text content (for queries)
  msg_type    TEXT NOT NULL,          -- "text", "interactive", "template", "image", "reaction", "flow_reply", ...
  metadata    TEXT,                   -- full UI message object as JSON (for lossless restore)
  created_at  TEXT NOT NULL           -- ISO 8601 timestamp
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);
```

### Why store `metadata` (full JSON)?

The `content` column holds plain text for human readability and queryability. But interactive messages have buttons, headers, footers, etc. that would be lost. The `metadata` column stores the **complete UI message object** as JSON, so on history load the UI can restore messages exactly as they appeared — buttons, formatting, and all.

### Write path

Messages are persisted at two points in `server.mjs`:

1. **User messages** — in the `/api/send` handler, and in `sendReply()` (for `/api/send-interactive` and `/api/send-flow-reply`) before the reply is posted to the webhook; after broadcast
2. **Bot messages** — in the proxy's `POST /:version/:phoneNumberId/messages` handler, when `extractBotMessage()` returns a message, once the emulator has answered (with `wamid`)

Both call `store.save(cfg.sessionId, uiMessage)`. Duplicates are silently ignored (`INSERT OR IGNORE`).

**Updates** — `store.update(cfg.sessionId, uiMessage)` replaces a saved message's `content` and `metadata`: the Flow message when it is submitted (`flow.completed`), and again, restored, if the answer was not delivered. `store.get(sessionId, id)` reads one message back (the answered message's `wamid`, a Flow's `flow`).

### Read path

`GET /api/history` calls `store.getHistory(cfg.sessionId)` which returns all messages ordered by `created_at ASC`. The UI deserializes the `metadata` JSON back into the original message object with a `_history: true` flag to disable interactive buttons. A Flow's button is the exception: it stays usable until `flow.completed` is set.

### Configuration

- **WAL mode** enabled for concurrent read/write safety
- **Prepared statements** for insert/select/get/update/delete — created once, reused
- DB path configurable via `storage.db_path` in YAML or `DB_PATH` env var
- Directory auto-created on startup

---

## WebSocket Protocol

The UI server sends JSON messages over WebSocket. Each has a `type` field:

| Type | Direction | Payload | When |
|------|-----------|---------|------|
| `config` | server → client | `{userName, botName, userPhone, sessionId}` | On connection |
| `user_message` | server → client | `{message: {id, from:"user", text, timestamp}}` | User sends a message |
| `bot_message` | server → client | `{message: {id, from:"bot", msgType, wamid?, ...}}` | Bot responds (after the emulator answered) |
| `message_update` | server → client | `{message}` | A message already shown must be re-drawn, e.g. a Flow once submitted (`flow.completed`), or reopened after a failed delivery |
| `typing` | server → client | `{from: "bot"}` | Bot sends typing indicator |
| `status` | server → client | `{messageId, status, timestamp}` | Delivery status update (sent/delivered/read); `delivered` for a reply once the webhook answered 2xx |
| `error` | server → client | `{message: "...", replyTo?}` | Backend unreachable or other error; `replyTo` = UI id of the answered message when a reply wasn't delivered (its buttons become usable again) |
| `session_reset` | server → client | `{}` | Session reset (`POST /api/reset-session`): the UI clears the chat |

The client only sends standard WebSocket frames (no custom protocol) — all user actions go through REST (`/api/send`, `/api/send-interactive`, `/api/send-flow-reply`).

---

## UI Message Format

The internal message format used throughout the UI and stored in SQLite metadata:

```javascript
// Base fields (all messages)
{
  id: "user_1710000000000" | "wamid.<base64>" /* replies */ | "bot_1710000000000_abc123",
  from: "user" | "bot",
  msgType: "text" | "interactive" | "template" | "image" | "video" | "audio" | "document" | "sticker" | "reaction" | "flow_reply",
  timestamp: 1710000000000,  // ms since epoch
  media: { kind, id, fileName, mimeType, size, link? } | { kind, link?, error },  // bot messages that carry a file
  wamid: "wamid...",  // bot messages: the id the emulator returned (messages[0].id), a reply's context.id
  status: "sent" | "delivered" | "read",  // user messages only
  _history: true,  // present on messages loaded from SQLite
}

// Text message
{ ...base, msgType: "text", text: "Hello" }

// Interactive message (from bot)
{
  ...base, msgType: "interactive",
  interactiveType: "button" | "list" | "cta_url" | "flow",
  body: "Choose an option",
  header: "Welcome",         // optional
  footer: "Powered by Bot",  // optional
  buttons: [{id, title}],    // button type only
  listButton: "Select",      // list type only
  listSections: [...],       // list type only
  ctaUrl: "https://...",     // cta_url type only
  ctaText: "Open",           // cta_url type
  flow: {                    // flow type only
    id, token, cta, action, screen, data, mode, messageVersion,
    completed: { at, replyId },  // once submitted
  },
}

// Template message (from bot)
{ ...base, msgType: "template", templateName: "...", components: [...] }

// Image message (from bot)
{ ...base, msgType: "image", imageUrl: "...", caption: "..." }

// Reaction (from bot)
{ ...base, msgType: "reaction", emoji: "👍", reactedMessageId: "..." }

// User interactive reply (id: "wamid.<base64>")
{
  ...base, from: "user", msgType: "text",
  text: "Button Title",
  interactiveReply: { type: "button_reply"|"list_reply", reply_id, reply_title }
}

// User's Flow answer (id: "wamid.<base64>")
{
  ...base, from: "user", msgType: "flow_reply",
  text: "Sent",
  flowReply: { messageId /* the Flow message's UI id */, cta, responseJson /* string, as sent */ }
}
```

---

## File Reference

### Tier 1 — Core (read these first)

| File | Lines | What it does |
|------|-------|-------------|
| `src/server.mjs` | ~790 | **Main entry point.** Creates all three servers (UI, proxy, emulator), wires up WebSocket broadcasting, REST API endpoints, message persistence, and the proxy interception logic, plus `sendReply()` (button/list/Flow replies) and `GET /api/flows/:flowId`. This is where everything comes together. |
| `src/webhook.mjs` | ~75 | **Reply delivery.** `inboundInteractive()` builds the inbound message (`context` when the answered `wamid` is known), `postInbound()` posts it in Meta's envelope with `X-Hub-Signature-256` (5 min timeout), `newWamid()` makes reply ids. |
| `config.yaml` | ~42 | **Default configuration.** All settings in one place: phone numbers, ports, webhook URL, storage path, a commented `flows:` example. Comments show corresponding env var overrides. |
| `src/config.mjs` | ~87 | **Config loader.** Reads YAML, applies env-var overrides, derives session ID from phone, builds the `flows` map (`loadFlows()`). Pure function, no side effects beyond a log line. |
| `src/store.mjs` | ~115 | **SQLite message store.** `MessageStore` class with `save()`, `getHistory()`, `get()`, `update()`, `clearSession()`. Uses prepared statements and WAL mode. Stores full UI message objects in metadata column. |
| `src/media.mjs` | ~200 | **Media file store.** `MediaStore` writes files to `data/media/` and indexes them by id; also `readMultipart()` (upload parsing) and `downloadLink()` (fetch a media link). |

### Tier 2 — UI

| File | Lines | What it does |
|------|-------|-------------|
| `src/ui/index.html` | ~1890 | **Single-page chat app.** Vanilla JS (no framework). Handles WebSocket connection, message rendering (text, interactive, template, image, video, audio, document, sticker, reaction, Flow reply), history loading, typing indicator, delivery ticks, interactive button/list click handling, and the Flow sheet ("WhatsApp Flows" section: Flow JSON rendering, calendar, JSON mode). |
| `src/ui/styles.css` | ~1185 | **WhatsApp dark theme.** CSS for the chat UI — message bubbles, ticks, typing indicator, interactive buttons, list picker overlay, Flow sheet and calendar, RTL support. |

### Tier 3 — Standalone Tools

| File | Lines | What it does |
|------|-------|-------------|
| `src/emulator.mjs` | ~45 | **Standalone emulator** (no UI, no proxy, no persistence). Used by `npm start`. Useful when you only need the Cloud API emulation without the browser UI. |
| `src/simulate.mjs` | ~85 | **CLI message sender.** Parses `--from`, `--name`, `--port` flags and sends a `POST /debug/messages/send-text` to the emulator. Used by `npm run simulate`. |

### Tier 4 — Config & Metadata

| File | What it does |
|------|-------------|
| `package.json` | Dependencies: `@whatsapp-cloudapi/emulator`, `better-sqlite3`, `js-yaml`, `express`, `ws`. Scripts: `start`, `ui`, `simulate`. |
| `.gitignore` | Ignores `node_modules/` and `data/` (SQLite files). |
| `README.md` | User-facing documentation: quick start, config reference, integration guide. |

### Generated at runtime

| Path | What it is |
|------|-----------|
| `data/messages.db` | SQLite database. Auto-created on first run. Git-ignored. |
| `data/messages.db-wal` | WAL journal file. |
| `data/messages.db-shm` | Shared memory file for WAL. |
| `data/media/` | Files the bot sent, as `<media id>.<file name>`. Created on startup. Git-ignored. |

---

## Design Decisions & Rationale

### Why a proxy instead of modifying the emulator?

The `@whatsapp-cloudapi/emulator` is a third-party npm package. We treat it as a black box:
- No forking or patching — we stay on mainline updates
- The proxy pattern is a clean architectural boundary
- If the emulator library changes its internals, our proxy continues to work as long as the HTTP interface is stable

### Why SQLite instead of a JSON file?

- **Concurrent safety** — WAL mode handles simultaneous reads and writes without corruption
- **Query capability** — can filter by session, role, time range
- **Performance** — prepared statements, indexed lookups, no need to parse the entire file on every read
- **Durability** — crash-safe writes, unlike a JSON file that can be partially written

### Why store the full message object in metadata?

Interactive messages have rich structure (buttons, list sections, headers, footers) that would require a complex relational schema to normalize. Storing the full JSON in `metadata` means:
- Lossless round-trip: what you see before restart = what you see after
- Simple schema: one table, one column for the structured data
- The `content` column still holds plain text for grep-ability

### Why derive session ID from phone number?

- **Deterministic** — same phone always gets the same session, no external state needed
- **No coordination** — doesn't depend on a backend or external service
- **Override-able** — `session_id` in config.yaml for when you need to pin a specific session

### Why vanilla JS in the UI (no React/Vue/etc.)?

- **Zero build step** — edit HTML, refresh browser
- **Single file** — everything in `index.html`, easy to understand
- **No dependencies** — no node_modules in the browser, no bundler config
- **Good enough** — it's a dev tool, not a production app

### Why post replies to the webhook directly?

The library's inbound simulation has no `nfm_reply` and no `context`, and its field names never matched what the UI sent. Building the envelope in `src/webhook.mjs` (the same shape as the library's `WebhookService`) keeps the library untouched while giving the backend what WhatsApp sends: `context.id`, Flow answers, signed requests. See [Why replies bypass the library](#why-replies-bypass-the-library).

### Why save bot messages after the emulator answers?

The `wamid` the emulator returns is the id the backend keeps for its message, and the only id a reply's `context.id` can carry. Saving first would store the message without it, and a Flow answered from history would arrive without `context`.

### Why Flow JSON from local files?

Meta keeps a Flow's JSON by `flow_id`; a backend only sends the id. A `flows:` map to files the developer already has (often in the backend's repo) needs no Meta account, and reading the file at every open makes editing a Flow a refresh, not a restart.

### Why three servers in one process?

- **Simplicity** — one `npm run ui` command starts everything
- **Shared state** — the WebSocket client set and config are shared across servers without IPC
- **Port coordination** — the proxy needs to know the emulator port; co-location makes this trivial

---

## Known Limitations & Future Work

### Current limitations

- **Single user** — the UI assumes one phone number per session. Multiple concurrent users would share the same WebSocket broadcast.
- **Bot → user media only** — files the bot sends are stored and shown; the user can't attach files from the UI.
- **Media is never deleted** — files in `data/media/` stay after a session reset or history clear.
- **No message editing/deletion** — the Cloud API supports these, but the UI doesn't.
- **Template rendering is basic** — templates show parameter values but not the actual template layout.
- **History buttons are disabled** — interactive buttons loaded from history can't be clicked (by design — they represent past state). Flow buttons are the exception: a Flow can be answered from history until it is submitted.
- **No Flow endpoint calls** — `data_exchange` (as `flow_action` or as a component action) is never sent to a Flow endpoint: screens that expect it show their `__example__` data, and a Footer that calls it is disabled. Answer such Flows with the `{ }` JSON mode.
- **Partial Flow components** — components outside the supported list (NavigationList, PhotoPicker, DocumentPicker, ...) show as labelled placeholders. Nested expressions cover references, literals and operators only. The Flow JSON is not validated against Meta's schema.
- **Text replies have no `context`** — typed messages still go through the library's `/debug/messages/send-text`, which puts no `context` on them (quoted replies aren't emulated).
- **Reply delivery is not retried** — a reply the webhook didn't take is reported in the chat once; WhatsApp would retry. A failed Flow can be submitted again by hand.

### Planned future work

- **Configurable webhook and debug endpoints** — use `config.yaml` to configure webhook URL and backend debug endpoints, making the package fully backend-agnostic
- **Backend history fetch** — optional mode to load history from a backend debug endpoint instead of (or in addition to) SQLite
- **Multi-session support** — switch between sessions/phone numbers in the UI