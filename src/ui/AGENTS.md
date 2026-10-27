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
- Message types rendered: text, interactive (buttons/lists/CTA/Flow), template, image, video, audio, document, sticker, reaction, and the user's Flow answer (`msgType: "flow_reply"`)
- Flows: the "WhatsApp Flows" section of `index.html` renders Flow JSON in a sheet. Each screen re-renders from its frame (`flow.stack`) on every change except typing, which only updates `frame.form` and the Footer — re-rendering on input would drop focus and swallow a Footer click. Add a component to `FLOW_COMPONENTS` (and to `INPUT_COMPONENTS` if it has a `name`); unknown types fall back to `unsupported()`. A Flow button is shown even for history messages, disabled once `msg.flow.completed`
- Flow fields register `{name, missing, validate}` with `registerField()`; `updateFooterState()` keeps the Footer disabled while any `missing()` (required), and `validateFields()` runs on the Footer click. References: `${data.*}`, `${form.*}`, `${screen.<ID>.form|data.*}` (`resolveRefs()`; a string that is one whole reference keeps the value's type). A string in backticks is a nested expression, parsed by `evalExpression()` — never `eval` or `new Function`; `If` uses it for `condition`, `Switch` picks `cases[value]`
- Flow dates: `"YYYY-MM-DD"` from `isoDate(y, m, d)` / `parseIsoDate()`, never `toISOString()` (a local midnight in UTC is the day before in Israel). `DatePicker` in Flow JSON < 5.0 stores a timestamp in ms instead (`legacyDates()`); `toIsoDate()` reads both
- Flow sheet direction: `flow.dir` is the direction of the first letter in the start screen's title, texts and string data, or the CTA and body for an unmapped Flow (`textDirection()`); an `rtl` sheet with Hebrew/Arabic text sets `flow.locale` (`he-IL` / `ar`) for month and weekday names, otherwise the browser's locale is used; text nodes use `textEl()` (`dir="auto"`)
- The `{ }` header button (`toggleJsonMode()`) answers a mapped Flow with raw JSON, pre-filled with `flow_token` and the current `complete` payload; an unmapped Flow (404 from `/api/flows/:id`) opens in that mode with `flow_action_payload` shown. Raw JSON goes to `/api/send-flow-reply` as a string, sent verbatim
- `sendInteractiveReply()` resolves `false` only when the REST call fails (the buttons are re-enabled); a failed delivery to the backend arrives later as a WS `error` whose `replyTo` re-enables the answered message's buttons
- `message_update` replaces a message already shown (`updateMessage()` re-builds its row via `buildMessageRow()`)
- Files: any message may carry `msg.media`, rendered by `renderMedia()` above the text (inline preview for image/sticker/video/audio, file card with download for documents or when a preview fails). Bytes come from `GET /api/media/:id`, never over the WebSocket. Previews size themselves after load, so `renderMedia()` calls `scrollToBottom()` on `load` / `loadedmetadata`
- The UI connects to WebSocket on the same host/port it was served from (UI_PORT)
