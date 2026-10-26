# WhatsApp Emulator

A self-contained WhatsApp Cloud API emulator for local development. It simulates the full WhatsApp Business API message flow — webhook delivery, outbound responses, delivery statuses — so your backend doesn't know it's not talking to Meta.

Comes with a browser-based WhatsApp Web UI and built-in SQLite message persistence, so conversations survive restarts.

## Architecture

```
[Browser :3000]  ←── WebSocket ──→  [UI Server :3000]
                                         |
[Your Backend]  ──POST /v24.0/.../messages──→ [Proxy :4004] ──→ [Emulator :4005]
                                         |
                                    intercepts messages,
                                    persists to SQLite,
                                    pushes to browser via WS
```

The proxy on `:4004` sits between your backend and the real emulator on `:4005`. It intercepts bot responses to display them in the UI and store them locally. Your backend only needs `WHATSAPP_API_BASE_URL_OVERRIDE=http://localhost:4004`.

## Quick Start

```bash
# Install
npm install

# Start the Web UI (includes emulator + proxy)
npm run ui
```

Open **http://localhost:3000** and start chatting. Make sure your backend is running and pointed at the emulator (see [Backend Integration](#backend-integration)).

## Configuration

All settings live in `config.yaml` at the package root. Environment variables override the YAML values.

```yaml
user:
  phone: "+1234567890"              # env: USER_PHONE
  name: "You"                       # env: USER_NAME

bot:
  name: "Bot"                       # env: BOT_NAME
  phone_number_id: "15551234567"    # env: WHATSAPP_PHONE_NUMBER_ID

# Optional: explicit session ID. If omitted, derived from user.phone.
# session_id: "my-custom-session-id"

server:
  ui_port: 3000                     # env: UI_PORT
  emulator_port: 4004               # env: EMULATOR_PORT

webhook:
  url: "http://localhost:8000/api/whatsapp/webhook"   # env: WEBHOOK_URL
  verify_token: "test-verify-token"                   # env: WHATSAPP_VERIFY_TOKEN
  # app_secret: "optional"                            # env: WHATSAPP_WEBHOOK_SECRET

storage:
  db_path: "data/messages.db"       # env: DB_PATH (relative to CWD)
  # media_dir: "data/media"         # env: MEDIA_DIR (default: "media" next to the database)
  # media_max_mb: 100               # env: MEDIA_MAX_MB
```

You can also point to a different config file:

```bash
CONFIG_PATH=./my-config.yaml npm run ui
```

### Session ID

Each session gets its own message history in SQLite. The session ID is determined by:

1. **Explicit** `session_id` in `config.yaml` — use this to pin a session across phone number changes.
2. **Derived** — if omitted, a deterministic UUID is generated from `user.phone` via SHA-256. Same phone always maps to the same session.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run ui` | Start the Web UI with emulator, proxy, and SQLite persistence |
| `npm start` | Start the emulator only (no UI, no persistence) |
| `npm run simulate -- "Hello"` | Send a text message to the emulator from the CLI |

### Simulate Options

```bash
# Default sender
npm run simulate -- "Hello from WhatsApp!"

# Custom sender
npm run simulate -- "Hi there" --from +9725551234 --name "Ron"

# Via curl
curl -X POST http://localhost:4004/debug/messages/send-text \
  -H "Content-Type: application/json" \
  -d '{"from": "+1234567890", "name": "Test User", "message": "Hello!"}'
```

## Backend Integration

Set these environment variables in your backend to point it at the emulator instead of Meta's API:

```bash
export WHATSAPP_API_BASE_URL_OVERRIDE=http://localhost:4004
export WHATSAPP_PHONE_NUMBER_ID=15551234567
export WHATSAPP_ACCESS_TOKEN=test-token        # any string, emulator doesn't validate
export WHATSAPP_VERIFY_TOKEN=test-verify-token  # must match config.yaml
```

The emulator stands in for `graph.facebook.com`. Your backend code requires zero changes — only the base URL differs.

### Example: Two-Terminal Setup

```bash
# Terminal 1: Emulator + UI
npm run ui

# Terminal 2: Your backend
export WHATSAPP_API_BASE_URL_OVERRIDE=http://localhost:4004
export WHATSAPP_PHONE_NUMBER_ID=15551234567
export WHATSAPP_ACCESS_TOKEN=test-token
export WHATSAPP_VERIFY_TOKEN=test-verify-token
# start your backend however you normally do
```

Open http://localhost:3000, type a message, and watch the round-trip.

## Message Persistence

Messages are stored in a local SQLite database (`data/messages.db` by default) as they flow through the proxy:

- **User messages** — stored when sent from the UI
- **Bot messages** — stored when intercepted from your backend's response

On page refresh or restart, the UI loads the full conversation history from SQLite.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/history` | Fetch all messages for the current session |
| `DELETE` | `/api/history` | Clear the current session's message history |
| `GET` | `/api/media/:id` | Fetch a stored file (add `?download=1` to force a download) |
| `POST` | `/api/send` | Send a text message (used by the UI) |
| `POST` | `/api/send-interactive` | Send an interactive reply (used by the UI) |
| `GET` | `/api/health` | Health check for UI and emulator |

### Storage Location

The SQLite database is created at `data/messages.db` relative to the current working directory. The `data/` directory is git-ignored. To change the path:

```yaml
# config.yaml
storage:
  db_path: "/tmp/whatsapp-emulator/messages.db"
```

Or via env: `DB_PATH=/tmp/wa.db npm run ui`

## Files & Media

Files your backend sends — images, documents, audio, video, stickers — are saved to disk and shown in the chat. Both Cloud API ways of sending media work:

- **Upload, then send by id** — `POST /v24.0/<phone-number-id>/media` (multipart), then a message that references the returned id. The file is kept under that id.
- **Send by link** — `"document": {"link": "https://..."}`. The emulator downloads the link when the message arrives (10s timeout) and keeps a copy.

```bash
# Upload a file, then send it as a document
ID=$(curl -s http://localhost:4004/v24.0/15551234567/media \
  -F messaging_product=whatsapp -F type=application/pdf -F file=@report.pdf | jq -r .id)

curl -s http://localhost:4004/v24.0/15551234567/messages -H "Content-Type: application/json" -d '{
  "messaging_product": "whatsapp", "to": "1234567890", "type": "document",
  "document": {"id": "'"$ID"'", "filename": "report.pdf", "caption": "Q3 report"}
}'
```

**Where files go:** `data/media/`, next to the SQLite database (or `storage.media_dir`), named `<media id>.<original file name>`. They stay until you delete them — resetting the session clears the messages, not the files. `GET /api/media/<id>` serves any stored file.

**How they're shown:** images and stickers inline (click to open full size), video and audio with a player, documents as a file card with a download button. Media in the header of an interactive or template message appears above its text. If a file can't be obtained (unknown media id, failed download) the message shows what went wrong instead.

**Limits:** files up to `media_max_mb` (100 by default) are accepted, of any type. `image` messages still need a JPEG or PNG up to 5 MB, as on WhatsApp.

## Web UI Features

- WhatsApp Web dark theme
- Real-time messages via WebSocket
- Interactive button messages (clickable)
- Interactive list messages (picker UI)
- CTA URL buttons
- Template message rendering
- Images, stickers, video, audio and documents rendered in the chat, stored locally
- Typing indicator with auto-hide
- Delivery status ticks (✓ sent, ✓✓ delivered, ✓✓ read)
- Emoji reactions
- RTL text support (auto-detected)
- Message history persistence across restarts
- History messages render without interactive controls (buttons are display-only)

## Project Structure

```
whatsapp-emulator-ui/
├── config.yaml          # Emulator configuration
├── package.json
├── src/
│   ├── server.mjs       # Main entry: UI server, proxy, WebSocket, persistence
│   ├── config.mjs       # YAML config loader with env-var overrides
│   ├── store.mjs        # SQLite message store (better-sqlite3)
│   ├── media.mjs        # Local file store for media, upload parsing, link download
│   ├── emulator.mjs     # Standalone emulator (no UI)
│   ├── simulate.mjs     # CLI message sender
│   └── ui/
│       ├── index.html   # WhatsApp Web UI (single-page app)
│       └── styles.css   # Dark theme styles
└── data/                # SQLite database + received files (git-ignored)
    ├── messages.db
    └── media/           # Files the bot sent, as <media id>.<file name>
```

## Troubleshooting

### Port conflicts

The emulator uses three ports: UI (3000), proxy (4004), internal emulator (4005). If any are in use:

```bash
# Check what's using the port
lsof -i :4004

# Use different ports
UI_PORT=3001 EMULATOR_PORT=4006 npm run ui
```

### Backend not receiving webhooks

- Verify `webhook.url` in `config.yaml` points to your backend
- Check that your backend is running and `/api/whatsapp/webhook` is reachable
- Ensure `verify_token` matches between config and backend

### Backend responses not reaching the emulator

- Set `WHATSAPP_API_BASE_URL_OVERRIDE=http://localhost:4004` (the **proxy** port, not 4005)
- Ensure `WHATSAPP_PHONE_NUMBER_ID` matches `bot.phone_number_id` in config

### Messages not persisting

- Check that `data/` directory is writable
- Look for SQLite errors in the console output
- Verify the session ID is stable (check the banner output on startup)

### ESM errors

Requires Node.js 22+. The emulator package is ESM-only.