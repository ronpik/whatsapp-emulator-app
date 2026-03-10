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
│  │              │   │  - Persist   │   │  - Debug endpoints │    │
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
| `:3000` (UI_PORT) | UI Server | Serves the browser UI, WebSocket, REST API for sending messages and fetching history |
| `:4004` (EMULATOR_PORT) | Proxy | **The port your backend should target.** Intercepts outbound bot messages, persists them, broadcasts to UI, then forwards to the real emulator |
| `:4005` (EMULATOR_PORT+1) | Internal Emulator | The actual `@whatsapp-cloudapi/emulator` instance. Never exposed to the backend directly |

The proxy sits on the "public" emulator port so the backend doesn't know it exists. This is how we intercept bot messages without modifying the emulator library.

---

## Message Flow Diagrams

### User sends a message (from browser)

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
  │                        │  store.save(bot msg)   │                       │                      │
  │                        │  WS broadcast ─────────┼──────────────────────>│                      │
  │                        │                        │                       │  WS: bot_message     │
  │                        │                        │                       │─────────────────────>│
  │                        │                        │                       │                      │
  │                        │  forward to :4005      │                       │                      │
  │                        │───────────────────────>│                       │                      │
  │                        │                        │                       │                      │
  │                        │  response {messages:   │                       │                      │
  │  <─────────────────────│  [{id:"wamid..."}]}    │                       │                      │
  │                        │                        │                       │                      │
  │                        │  WS: status "sent"     │                       │                      │
  │                        │  (after 200ms)  ───────┼──────────────────────>│  WS: status ✓       │
  │                        │  WS: status "delivered"│                       │─────────────────────>│
  │                        │  (after 800ms)  ───────┼──────────────────────>│  WS: status ✓✓      │
  │                        │                        │                       │─────────────────────>│
```

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
| `POST` | `/:version/:phoneNumberId/media` | Upload media |
| `GET`  | `/webhook` | Webhook subscription verification (hub.mode=subscribe) |

### Debug endpoints (for testing)

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/debug/health` | Health check → `{status: "ok"}` |
| `POST` | `/debug/messages/send-text` | Simulate inbound text message |
| `POST` | `/debug/messages/send-interactive` | Simulate inbound button/list reply |
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

Located at `server.mjs:332`. This is the translator between WhatsApp Cloud API message format and our internal UI message format. It handles:

| Cloud API `body.type` | UI `msgType` | Key fields extracted |
|----------------------|--------------|---------------------|
| `text` | `text` | `text.body` |
| `interactive` (button) | `interactive` | `body`, `header`, `footer`, `buttons[]` |
| `interactive` (list) | `interactive` | `body`, `listButton`, `listSections[]` |
| `interactive` (cta_url) | `interactive` | `ctaUrl`, `ctaText` |
| `interactive` (flow) | `interactive` | `ctaText`, `flowAction` |
| `template` | `template` | `templateName`, `components[]` |
| `image` | `image` | `imageUrl`, `caption` |
| `reaction` | `reaction` | `emoji`, `reactedMessageId` |

If the type is unrecognized, it falls back to `text` with the raw JSON body as content.

### Request classification in the proxy

The proxy distinguishes three types of `POST /:version/:phoneNumberId/messages`:

| Type | Detection | Action |
|------|-----------|--------|
| **Actual message** | Not mark-as-read, not typing indicator | Extract, persist, broadcast, forward |
| **Mark as read** | `body.status === "read" && body.message_id` | Broadcast read status, forward |
| **Typing indicator** | `body.type === "text" && !body.text` | Broadcast typing event, forward |

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

---

## Message Persistence

**File:** `src/store.mjs`

### SQLite schema

```sql
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,       -- message ID (e.g., "user_1710000000000" or "bot_1710000000000_abc123")
  session_id  TEXT NOT NULL,          -- links to config session
  role        TEXT NOT NULL,          -- "user" or "assistant"
  content     TEXT NOT NULL,          -- plain text content (for queries)
  msg_type    TEXT NOT NULL,          -- "text", "interactive", "template", "image", "reaction"
  metadata    TEXT,                   -- full UI message object as JSON (for lossless restore)
  created_at  TEXT NOT NULL           -- ISO 8601 timestamp
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);
```

### Why store `metadata` (full JSON)?

The `content` column holds plain text for human readability and queryability. But interactive messages have buttons, headers, footers, etc. that would be lost. The `metadata` column stores the **complete UI message object** as JSON, so on history load the UI can restore messages exactly as they appeared — buttons, formatting, and all.

### Write path

Messages are persisted at two points in `server.mjs`:

1. **User messages** — in the `/api/send` and `/api/send-interactive` handlers, after broadcast
2. **Bot messages** — in the proxy's `POST /:version/:phoneNumberId/messages` handler, when `extractBotMessage()` returns a message

Both call `store.save(cfg.sessionId, uiMessage)`. Duplicates are silently ignored (`INSERT OR IGNORE`).

### Read path

`GET /api/history` calls `store.getHistory(cfg.sessionId)` which returns all messages ordered by `created_at ASC`. The UI deserializes the `metadata` JSON back into the original message object with a `_history: true` flag to disable interactive buttons.

### Configuration

- **WAL mode** enabled for concurrent read/write safety
- **Prepared statements** for insert/select/delete — created once, reused
- DB path configurable via `storage.db_path` in YAML or `DB_PATH` env var
- Directory auto-created on startup

---

## WebSocket Protocol

The UI server sends JSON messages over WebSocket. Each has a `type` field:

| Type | Direction | Payload | When |
|------|-----------|---------|------|
| `config` | server → client | `{userName, botName, userPhone, sessionId}` | On connection |
| `user_message` | server → client | `{message: {id, from:"user", text, timestamp}}` | User sends a message |
| `bot_message` | server → client | `{message: {id, from:"bot", msgType, ...}}` | Bot responds |
| `typing` | server → client | `{from: "bot"}` | Bot sends typing indicator |
| `status` | server → client | `{messageId, status, timestamp}` | Delivery status update (sent/delivered/read) |
| `error` | server → client | `{message: "..."}` | Backend unreachable or other error |

The client only sends standard WebSocket frames (no custom protocol) — all user actions go through REST (`/api/send`, `/api/send-interactive`).

---

## UI Message Format

The internal message format used throughout the UI and stored in SQLite metadata:

```javascript
// Base fields (all messages)
{
  id: "user_1710000000000" | "bot_1710000000000_abc123",
  from: "user" | "bot",
  msgType: "text" | "interactive" | "template" | "image" | "reaction",
  timestamp: 1710000000000,  // ms since epoch
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
  ctaText: "Open",           // cta_url / flow types
}

// Template message (from bot)
{ ...base, msgType: "template", templateName: "...", components: [...] }

// Image message (from bot)
{ ...base, msgType: "image", imageUrl: "...", caption: "..." }

// Reaction (from bot)
{ ...base, msgType: "reaction", emoji: "👍", reactedMessageId: "..." }

// User interactive reply
{
  ...base, from: "user", msgType: "text",
  text: "Button Title",
  interactiveReply: { type: "button_reply"|"list_reply", reply_id, reply_title }
}
```

---

## File Reference

### Tier 1 — Core (read these first)

| File | Lines | What it does |
|------|-------|-------------|
| `src/server.mjs` | ~410 | **Main entry point.** Creates all three servers (UI, proxy, emulator), wires up WebSocket broadcasting, REST API endpoints, message persistence, and the proxy interception logic. This is where everything comes together. |
| `config.yaml` | ~27 | **Default configuration.** All settings in one place: phone numbers, ports, webhook URL, storage path. Comments show corresponding env var overrides. |
| `src/config.mjs` | ~67 | **Config loader.** Reads YAML, applies env-var overrides, derives session ID from phone. Pure function, no side effects beyond a log line. |
| `src/store.mjs` | ~86 | **SQLite message store.** `MessageStore` class with `save()`, `getHistory()`, `clearSession()`. Uses prepared statements and WAL mode. Stores full UI message objects in metadata column. |

### Tier 2 — UI

| File | Lines | What it does |
|------|-------|-------------|
| `src/ui/index.html` | ~490 | **Single-page chat app.** Vanilla JS (no framework). Handles WebSocket connection, message rendering (text, interactive, template, image, reaction), history loading, typing indicator, delivery ticks, and interactive button/list click handling. |
| `src/ui/styles.css` | ~516 | **WhatsApp dark theme.** CSS for the chat UI — message bubbles, ticks, typing indicator, interactive buttons, list picker overlay, RTL support. |

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

### Why three servers in one process?

- **Simplicity** — one `npm run ui` command starts everything
- **Shared state** — the WebSocket client set and config are shared across servers without IPC
- **Port coordination** — the proxy needs to know the emulator port; co-location makes this trivial

---

## Known Limitations & Future Work

### Current limitations

- **Single user** — the UI assumes one phone number per session. Multiple concurrent users would share the same WebSocket broadcast.
- **No media rendering** — image messages show a placeholder, not the actual image.
- **No message editing/deletion** — the Cloud API supports these, but the UI doesn't.
- **Template rendering is basic** — templates show parameter values but not the actual template layout.
- **History buttons are disabled** — interactive buttons loaded from history can't be clicked (by design — they represent past state).

### Planned future work

- **Configurable webhook and debug endpoints** — use `config.yaml` to configure webhook URL and backend debug endpoints, making the package fully backend-agnostic
- **Backend history fetch** — optional mode to load history from a backend debug endpoint instead of (or in addition to) SQLite
- **Multi-session support** — switch between sessions/phone numbers in the UI
- **Media file storage** — save and display images, documents, audio