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

The proxy sits between the backend and the third-party emulator library to intercept bot messages without modifying the library.

| Path | Purpose |
|------|---------|
| `src/server.mjs` | Main entry (shebang): CLI arg parsing (`-c`/`--config`, `--help`), three servers, REST, WebSocket, `extractBotMessage()`, media upload interception + `attachMedia()` |
| `src/config.mjs` | YAML config loader, env var overrides, `phoneToSessionId()`. Paths resolve from CWD |
| `src/store.mjs` | `MessageStore`: SQLite WAL mode, session-partitioned, INSERT OR IGNORE dedup |
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
| `storage.db_path` | `DB_PATH` | `data/messages.db` |
| `storage.media_dir` | `MEDIA_DIR` | `media/` next to the database |
| `storage.media_max_mb` | `MEDIA_MAX_MB` | `100` |

## Key Patterns

- **WebSocket** — Server→Client only (types: `config`, `user_message`, `bot_message`, `typing`, `status`, `error`, `session_reset`). Client uses REST for all actions.
- **Message types** — `extractBotMessage()` maps Cloud API format to UI format: text, interactive, template, image, video, audio, document, sticker, reaction
- **Media** — the proxy stores uploads (`POST .../media`, parsed with the built-in `Request.formData()`, no multer) and downloaded links in `data/media/`; `attachMedia()` sets `message.media` (`{kind, id, fileName, mimeType, size}` or `{kind, error}`), persisted inside the message's `metadata` JSON (no extra table); the UI fetches files from `GET /api/media/:id`. Interactive/template header media is attached the same way. Files survive session reset. Curl example: README → Files & Media.
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
- Add a build step or frontend framework to the UI
