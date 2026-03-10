# AGENTS.md

## Project Overview

WhatsApp Cloud API emulator for local development — browser-based WhatsApp Web UI with SQLite message persistence. Node.js, Express, vanilla JS frontend, no build step.

## Dev Environment

- Prerequisites: Node.js 18+
- Setup: `npm install`
- Start full stack: `npm run ui` (ports 3000, 4004, 4005)

## Commands

- Full stack (UI + proxy + emulator): `npm run ui`
- Standalone emulator (no UI): `npm run start`
- Send test message: `npm run simulate -- --from <phone> --name <name> --port <port>`

No test suite, linter, or build step exists.

## Architecture

Three HTTP servers in a single process (`src/server.mjs`):

| Port | Role |
|------|------|
| 3000 | UI server: static files, REST API, WebSocket |
| 4004 | Proxy: intercepts bot messages, persists to SQLite, WS broadcast |
| 4005 | Internal `@whatsapp-cloudapi/emulator` (not exposed) |

**Message flow:** Browser → UI REST API → Proxy → Emulator → Backend webhook → Proxy intercepts response → SQLite + WS broadcast → Browser

The proxy sits between the backend and the third-party emulator library to intercept bot messages without modifying the library.

| Path | Purpose |
|------|---------|
| `src/server.mjs` | Main entry: three servers, REST endpoints, WebSocket, `extractBotMessage()` |
| `src/config.mjs` | YAML config loader, env var overrides, `phoneToSessionId()` |
| `src/store.mjs` | `MessageStore`: SQLite WAL mode, session-partitioned, INSERT OR IGNORE dedup |
| `src/emulator.mjs` | Standalone emulator runner (no UI) |
| `src/simulate.mjs` | CLI tool for sending test messages |
| `src/ui/` | Single-page chat app (vanilla JS + CSS) |
| `config.yaml` | Default config (all values overridable via env vars) |
| `data/` | Gitignored; SQLite auto-creates `data/messages.db` on first run |

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

YAML defaults in `config.yaml`, overridden by env vars:

| Config Key | Env Var | Default |
|------------|---------|---------|
| `user.phone` | `USER_PHONE` | `+1234567890` |
| `user.name` | `USER_NAME` | `You` |
| `bot.name` | `BOT_NAME` | `Bot` |
| `bot.phone_number_id` | `WHATSAPP_PHONE_NUMBER_ID` | `15551234567` |
| `server.ui_port` | `UI_PORT` | `3000` |
| `server.emulator_port` | `EMULATOR_PORT` | `4004` |
| `webhook.url` | `WEBHOOK_URL` | `http://localhost:8000/api/whatsapp/webhook` |
| `storage.db_path` | `DB_PATH` | `data/messages.db` |

## Key Patterns

- **WebSocket** — Server→Client only (types: `config`, `user_message`, `bot_message`, `typing`, `status`, `error`). Client uses REST for all actions.
- **Message types** — `extractBotMessage()` maps Cloud API format to UI format: text, interactive, template, image, reaction
- **SQLite schema** — Single `messages` table, `role` CHECK (`user`/`assistant`), `metadata` column stores full message JSON
- **Deduplication** — `INSERT OR IGNORE` on message ID primary key

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
- Add a build step or frontend framework to the UI
