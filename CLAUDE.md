# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **See also:** [`AGENTS.md`](AGENTS.md) — vendor-neutral agent instructions (read by Codex, Copilot, Gemini CLI, Cursor, Aider). It extends this file with:
> - **Code style examples** — ESM import patterns, session ID derivation snippets
> - **Configuration defaults table** — all config keys, env vars, and default values
> - **Boundaries** — three-tier rules: Always Do / Ask First / Never Do
> - **Dev environment** — prerequisites and setup commands
>
> A subdirectory-scoped [`src/ui/AGENTS.md`](src/ui/AGENTS.md) covers UI-specific conventions (inline JS, no framework, WebSocket receive-only pattern).

## What This Is

A self-contained WhatsApp Cloud API emulator for local development. Provides a browser-based WhatsApp Web-like UI with SQLite message persistence. No build step, no frontend framework — vanilla JS throughout.

## Commands

- `npm run ui` — Start full stack (UI + proxy + emulator) on ports 3000/4004/4005
- `npm run start` — Start standalone emulator (no UI)
- `npm run simulate` — CLI tool to send test messages (`--from <phone> --name <name> --port <port>`)

No test suite, linter, or build step exists.

## Architecture

Three HTTP servers run in a single Node.js process (`src/server.mjs`):

| Port | Role |
|------|------|
| 3000 (UI_PORT) | Express: serves static UI, REST API, WebSocket |
| 4004 (EMULATOR_PORT) | Express proxy: intercepts bot messages, persists to SQLite, broadcasts via WS |
| 4005 (EMULATOR_PORT+1) | Internal `@whatsapp-cloudapi/emulator` instance (not exposed) |

**Message flow:** Browser → UI server REST → Proxy → Emulator → Backend webhook → Proxy intercepts response → SQLite + WS broadcast → Browser

The proxy pattern is the key design choice — it sits between the backend and the third-party emulator library to intercept bot messages without modifying the library.

## Key Source Files

- `src/server.mjs` — Main entry: wires up all three servers, REST endpoints, WebSocket, `extractBotMessage()` message-type mapper
- `src/config.mjs` — YAML config loader with env var overrides, `phoneToSessionId()` for deterministic UUID from phone
- `src/store.mjs` — `MessageStore` class: SQLite with WAL mode, session-partitioned messages, INSERT OR IGNORE dedup
- `src/ui/index.html` — Single-page chat app (vanilla JS, embedded in HTML)
- `src/ui/styles.css` — WhatsApp dark theme CSS variables
- `config.yaml` — Default configuration (all values overridable via env vars)
- `DESIGN_AND_IMPL.md` — Detailed internal architecture reference

## Configuration

YAML defaults in `config.yaml`, overridden by env vars:
- `USER_PHONE`, `USER_NAME`, `BOT_NAME`, `WHATSAPP_PHONE_NUMBER_ID`
- `UI_PORT`, `EMULATOR_PORT`, `WEBHOOK_URL`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_WEBHOOK_SECRET`
- `DB_PATH`, `CONFIG_PATH`

## Key Patterns

- **ESM only** — All files use `.mjs` extension and ES module imports
- **Session IDs** — Derived deterministically from phone number via SHA-256 → UUID format
- **WebSocket protocol** — Server→Client only (types: `config`, `user_message`, `bot_message`, `typing`, `status`, `error`). Client uses REST for all actions.
- **Message types** — `extractBotMessage()` in `server.mjs` maps Cloud API format to UI format (text, interactive, template, image, reaction)
- **SQLite schema** — Single `messages` table with `role` CHECK constraint (`user`/`assistant`), `metadata` column stores full message JSON
- **Data directory** — `data/` is gitignored; SQLite auto-creates `data/messages.db` on first run
