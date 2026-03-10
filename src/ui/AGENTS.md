# AGENTS.md — UI

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md) — inherits all root-level rules (ESM, boundaries, config). This file only covers what's unique to the UI layer.

Single-page WhatsApp Web clone. Vanilla JS embedded in `index.html`, no framework or build step.

## Key Files
- `index.html` — Complete chat app: HTML structure + all JavaScript logic inline
- `styles.css` — WhatsApp dark theme using CSS custom properties

## Conventions
- All JS is embedded directly in `index.html` `<script>` tags — no separate JS files
- Styling uses CSS variables defined in `styles.css` for theming
- Communication: REST calls to `/api/*` endpoints for sending; WebSocket (receive-only) for real-time updates
- No npm packages or imports — browser-native APIs only

## Gotchas
- WebSocket is server→client only. The client never sends WS messages — all actions go through REST
- Message types rendered: text, interactive (buttons/lists), template, image, reaction
- The UI connects to WebSocket on the same host/port it was served from (UI_PORT)
