# AGENTS.md

> **Hierarchy:** This root file covers the full project. See also [`src/ui/AGENTS.md`](src/ui/AGENTS.md) for UI-specific conventions (vanilla JS, inline scripts, WebSocket gotchas).
>
> **Claude Code users:** Claude reads `CLAUDE.md`, not this file. Both are maintained — `CLAUDE.md` covers core architecture; this file adds code style examples, configuration defaults, and agent boundaries. See `CLAUDE.md` for Claude-specific guidance.

## Project Overview

WhatsApp Cloud API emulator for local development — browser-based WhatsApp Web UI with SQLite message persistence. Node.js, Express, vanilla JS frontend, no build step.

## Dev Environment

- Prerequisites: Node.js 22+ (required by `@whatsapp-cloudapi/emulator`; the media code uses the built-in `File` / `FormData`)
- Setup: `npm install`
- Start full stack: `npm run ui` (ports 3000, 4004, 4005)

## Commands

- Run via npx: `npx whatsapp-emulator-ui`
- Run globally: `wa-emulator`
- Custom config: `wa-emulator -c my-config.yaml`
- CLI help: `wa-emulator --help`
- Full stack from repo: `npm run ui`
- Standalone emulator (no UI): `npm run start`
- Send test message: `npm run simulate -- --from <phone> --name <name> --port <port>`
- Throwaway instance beside a running one: `UI_PORT=3100 EMULATOR_PORT=4104 DB_PATH=/tmp/wa/messages.db npm run ui` (the internal emulator takes `EMULATOR_PORT+1`)

No test suite, linter, or build step exists.

## Architecture

Three HTTP servers in a single process (`src/server.mjs`):

| Port | Role |
|------|------|
| 3000 | UI server: static files, REST API, WebSocket |
| 4004 | Proxy: intercepts bot messages and media uploads, persists to SQLite and `data/media/`, WS broadcast |
| 4005 | Internal `@whatsapp-cloudapi/emulator` (not exposed) |

**Message flow:** Browser → UI REST API → Proxy → Emulator → Backend webhook → Proxy intercepts response → SQLite + WS broadcast → Browser

**Reply flow** (button, list, Flow answers): Browser → UI REST API → SQLite + WS broadcast → `sendReply()` → Backend webhook directly (not via the library)

The proxy sits between the backend and the third-party emulator library to intercept bot messages without modifying the library.

| Path | Purpose |
|------|---------|
| `src/server.mjs` | Main entry (shebang): CLI arg parsing (`-c`/`--config`, `--help`), three servers, REST, WebSocket, `extractBotMessage()`, media upload interception + `attachMedia()`, `sendReply()` for button/list/Flow answers, `GET /api/flows/:flowId` |
| `src/webhook.mjs` | Posts the user's interactive replies to the backend webhook in Meta's envelope (`context`, `X-Hub-Signature-256`); `newWamid()` |
| `src/config.mjs` | YAML config loader, env var overrides, `phoneToSessionId()`, `flows` map. Paths resolve from CWD |
| `src/store.mjs` | `MessageStore`: SQLite WAL mode, session-partitioned, INSERT OR IGNORE dedup; `get()` / `update()` one message |
| `src/media.mjs` | `MediaStore` (files in `data/media/` as `<mediaId>.<name>`), multipart upload parsing, media link download |
| `src/emulator.mjs` | Standalone emulator runner (no UI) |
| `src/simulate.mjs` | CLI tool for sending test messages |
| `src/ui/` | Single-page chat app (vanilla JS + CSS) |
| `config.yaml` | Reference config template (bundled in npm package) |
| `data/` | Gitignored; SQLite auto-creates `data/messages.db` in CWD on first run; files the bot sends are saved in `data/media/` |

## Code Style

ESM only — all files use `.mjs` extension and ES module imports:

```js
// Always use ESM imports, never require()
import express from "express";
import { loadConfig } from "./config.mjs";
```

Session IDs derived deterministically from phone number via SHA-256 → UUID format:

```js
const hex = createHash("sha256").update(phone).digest("hex");
// Returns UUID-shaped string: xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx
```

## Configuration

Default config file: `wa-emulator-config.yaml` in CWD (override with `-c`/`--config` or `CONFIG_PATH` env var).

YAML values overridden by env vars:

| Config Key | Env Var | Default |
|------------|---------|---------|
| `user.phone` | `USER_PHONE` | `+1234567890` |
| `user.name` | `USER_NAME` | `You` |
| `bot.name` | `BOT_NAME` | `Bot` |
| `bot.phone_number_id` | `WHATSAPP_PHONE_NUMBER_ID` | `15551234567` |
| `server.ui_port` | `UI_PORT` | `3000` |
| `server.emulator_port` | `EMULATOR_PORT` | `4004` |
| `webhook.url` | `WEBHOOK_URL` | `http://localhost:8000/api/whatsapp/webhook` |
| `webhook.reset_session_url` | `RESET_SESSION_URL` | _(none)_ |
| `webhook.health_paths` | `HEALTH_PATHS` (comma-separated) | `["/health", "/api/health"]` |
| `storage.db_path` | `DB_PATH` | `data/messages.db` |
| `storage.media_dir` | `MEDIA_DIR` | `media/` next to the database |
| `storage.media_max_mb` | `MEDIA_MAX_MB` | `100` |
| `flows.<flow_id>` | `FLOWS` (`id=path,id=path`, per id over the YAML) | _(none)_ — Flow JSON file per flow_id (or flow_name) |

Flow JSON paths resolve from CWD and are read at every open, so edits apply without a restart. Startup logs each mapping (`[flows] <id> → <path>`) and flags a missing file. A Flow message whose `flow_id` has no mapping gets a one-time `[flows] No Flow JSON configured…` warning; on a miss the config file is re-read (`readFlows()`), so a mapping added while running applies on the next open.

## Key Patterns

- **WebSocket** — Server→Client only (types: `config`, `user_message`, `bot_message`, `message_update`, `typing`, `status`, `error`, `session_reset`). Client uses REST for all actions.
- **Message types** — `extractBotMessage()` maps Cloud API format to UI format: text, interactive (button, list, cta_url, flow), template, image, video, audio, document, sticker, reaction. Bot messages are saved after the library answers, with `wamid` = the id the backend got back (`messages[0].id`). The user's Flow answer is `msgType: "flow_reply"` with `flowReply: {messageId, cta, responseJson}`
- **Interactive replies** — `POST /api/send-interactive` (button/list) and `POST /api/send-flow-reply` show the user's bubble, then `sendReply()` posts to `webhook.url` in the background with `context.id` = the answered message's `wamid` (left out when unknown). Body: `{type: "button_reply"|"list_reply", reply_id, reply_title, reply_description?, message_id}` (the library's debug endpoint expects other field names, so replies through it failed with 400). Reply ids are `wamid.<base64>` (`newWamid()`). Delivered → `status` `delivered`; failure → `error` WS message with `replyTo` (the UI re-enables that message's buttons), the bubble keeps one tick, and a Flow's `completed` mark is undone so it can be answered again
- **Flows** — interactive `flow` messages keep `flow: {id, token, cta, action, screen, data, mode, messageVersion, completed?: {at, replyId}}` in metadata. The UI renders the Flow JSON from `GET /api/flows/:flowId` (file per `flows:` config, read at every open); unmapped Flows are answered with a raw JSON editor. The answer goes out as `nfm_reply` with `response_json` = the `complete` payload + `flow_token` (`POST /api/send-flow-reply {message_id, response}`: object → `flow_token` added unless present, string → verbatim; 404 unknown message, 409 once submitted)
- **Media** — the proxy stores uploads (`POST .../media`, parsed with the built-in `Request.formData()`, no multer) and downloaded links in `data/media/`; `attachMedia()` sets `message.media` (`{kind, id, fileName, mimeType, size}` or `{kind, error}`), persisted inside the message's `metadata` JSON (no extra table); the UI fetches files from `GET /api/media/:id`. Interactive/template header media is attached the same way. Files survive session reset. Curl example: README → Files & Media.
- **Backend health gate** — `POST /api/send` first runs `checkBackendHealth()`: it probes the origin of `webhook.url` plus each `webhook.health_paths` entry (first 2xx wins). If none answers, the user message is still saved and shown, an `error` is broadcast, and the request returns 503. Derive the probe URL from the origin, never by editing the webhook path.
- **SQLite schema** — Single `messages` table, `role` CHECK (`user`/`assistant`), `metadata` column stores full message JSON
- **Deduplication** — `INSERT OR IGNORE` on message ID primary key

## npm Package

Published as `whatsapp-emulator-ui` (unscoped). Bin entries: `wa-emulator` (server), `wa-simulate` (CLI). Package includes: `src/`, `config.yaml`, `README.md`. Config and DB paths resolve relative to CWD so the package works when installed into `node_modules/`.

## Boundaries

### Always Do
- Use `.mjs` extension for all new JS files
- Use ES module imports (`import`), never `require()`
- Keep the UI as vanilla JS — no frameworks or bundlers
- Persist messages through `MessageStore`, not in-memory
- Send interactive replies with `sendReply()` (`src/webhook.mjs`) — the library's `/debug/messages/send-interactive` has no `nfm_reply` and no `context`
- Build Flow dates (`YYYY-MM-DD`) from year/month/day, never with `toISOString()` (a local midnight in UTC is the previous day east of Greenwich)

### Ask First
- Adding new npm dependencies
- Changing the proxy interception pattern in `server.mjs`
- Modifying the SQLite schema in `store.mjs`
- Changing default ports or config structure

### Never Do
- Commit `data/` directory or SQLite database files
- Commit secrets, API keys, or webhook tokens
- Modify the `@whatsapp-cloudapi/emulator` library directly — use the proxy pattern instead
- Build media file paths from request input or serve HTML/SVG inline — look files up with `MediaStore.get(id)` and keep the `INLINE_MIME` allowlist in `server.mjs`
- Read Flow JSON from a path given in a request — only from the `cfg.flows` map (`GET /api/flows/:flowId` looks the id up there)
- Run Flow expressions (`If` conditions, backtick `` `${form.age} >= 18` `` values) with `eval` / `new Function` — use the `evalExpression()` parser in `src/ui/index.html`
- Add a build step or frontend framework to the UI
