#!/usr/bin/env node
import { WhatsAppEmulator } from "@whatsapp-cloudapi/emulator";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { loadConfig } from "./config.mjs";
import { MessageStore } from "./store.mjs";
import { MediaStore, describeMedia, downloadLink, readMultipart } from "./media.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── CLI argument parsing ─────────────────────────
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`
Usage: wa-emulator [options]

Options:
  -c, --config <path>  Path to config YAML (default: wa-emulator-config.yaml in CWD)
  -h, --help           Show this help message

Examples:
  wa-emulator
  wa-emulator -c my-config.yaml
  npx whatsapp-emulator-ui -c config.yaml
`);
  process.exit(0);
}

let configPath;
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === "--config" || argv[i] === "-c") && argv[i + 1]) {
    configPath = argv[++i];
  }
}

// ─── Configuration & Storage ──────────────────────
const cfg = loadConfig(configPath);
const store = new MessageStore(cfg.dbPath);
const mediaStore = new MediaStore(cfg.mediaDir);
const MEDIA_LIMIT_MB = Number((cfg.mediaMaxBytes / 1024 / 1024).toFixed(1));
console.log(`[media] Storing files in ${cfg.mediaDir}`);

const INTERNAL_EMULATOR_PORT = cfg.emulatorPort + 1;

const emulatorConfig = {
  businessPhoneNumberId: cfg.phoneNumberId,
  port: INTERNAL_EMULATOR_PORT,
  webhook: {
    url: cfg.webhookUrl,
    verifyToken: cfg.verifyToken,
    appSecret: cfg.appSecret,
    timeout: 5000,
  },
};

// Start the emulator on the internal port
const emulator = new WhatsAppEmulator(emulatorConfig);
await emulator.start();
console.log(`Emulator running on internal port ${INTERNAL_EMULATOR_PORT}`);

// ─── WebSocket broadcast (shared by both servers) ───

const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ─── Proxy server on EMULATOR_PORT ───
// Intercepts all Cloud API requests, extracts bot messages, forwards to real emulator

const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT || "300") * 1000;

function proxySignal() {
  return PROXY_TIMEOUT_MS > 0
    ? { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) }
    : {};
}

const proxyApp = express();
proxyApp.use(express.json({ limit: "10mb" }));

// Intercept bot messages: POST /:version/:phoneNumberId/messages
proxyApp.post("/:version/:phoneNumberId/messages", async (req, res) => {
  try {
    const body = req.body;
    const { version, phoneNumberId } = req.params;

    const isMarkAsRead = body.status === "read" && body.message_id;
    const hasTypingIndicator = body.typing_indicator != null;
    const isLegacyTypingIndicator =
      body.type === "text" && !body.text && body.recipient_type === "individual";
    const isBotMessage = !isMarkAsRead && !isLegacyTypingIndicator;

    // Broadcast actual bot messages to the UI and persist
    if (isBotMessage) {
      const botMessage = extractBotMessage(body);
      if (botMessage) {
        await attachMedia(botMessage, body, {
          version,
          phoneNumberId,
          authorization: req.headers.authorization,
        });
        broadcast({ type: "bot_message", message: botMessage });
        store.save(cfg.sessionId, botMessage);
      }
    }

    if (hasTypingIndicator || isLegacyTypingIndicator) {
      broadcast({ type: "typing", from: "bot" });
    }

    if (isMarkAsRead) {
      broadcast({
        type: "status",
        messageId: body.message_id,
        status: "read",
        timestamp: Date.now(),
      });
    }

    // Forward to real emulator
    const proxyResp = await fetch(
      `http://localhost:${INTERNAL_EMULATOR_PORT}/${version}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(req.headers.authorization
            ? { Authorization: req.headers.authorization }
            : {}),
        },
        body: JSON.stringify(body),
        ...proxySignal(),
      }
    );

    let data;
    try { data = await proxyResp.json(); } catch { data = { success: true }; }

    // Broadcast delivery statuses for actual messages
    if (!isMarkAsRead && !isLegacyTypingIndicator && data.messages?.[0]) {
      const messageId = data.messages[0].id;
      setTimeout(() => {
        broadcast({ type: "status", messageId, status: "sent", timestamp: Date.now() });
      }, 200);
      setTimeout(() => {
        broadcast({ type: "status", messageId, status: "delivered", timestamp: Date.now() });
      }, 800);
    }

    res.status(proxyResp.status).json(data);
  } catch (err) {
    console.error(`[proxy] Error forwarding /${req.params.version}/${req.params.phoneNumberId}/messages:`, err.message);
    res.status(502).json({ error: "Failed to proxy to emulator", detail: err.message });
  }
});

// Intercept media uploads: POST /:version/:phoneNumberId/media
// The emulator library keeps only metadata for an upload (and only accepts
// JPEG/PNG up to 5MB), so the bytes are kept here. The library still issues
// the id whenever it accepts the file, so `image` messages keep validating.
proxyApp.post("/:version/:phoneNumberId/media", async (req, res) => {
  const { version, phoneNumberId } = req.params;
  const tooLarge = `File size exceeds ${MEDIA_LIMIT_MB}MB limit`;
  try {
    let form;
    try {
      form = await readMultipart(req, cfg.mediaMaxBytes);
    } catch (err) {
      const isSizeError = err instanceof RangeError || err.cause instanceof RangeError;
      return res.status(400).json(apiError(isSizeError ? tooLarge : err.message));
    }

    const part = form.get("file");
    if (!part || typeof part === "string") {
      return res.status(400).json(apiError("File is required for media upload"));
    }
    if (form.get("messaging_product") !== "whatsapp") {
      return res.status(400).json(apiError('messaging_product must be "whatsapp"'));
    }
    if (part.size > cfg.mediaMaxBytes) return res.status(400).json(apiError(tooLarge));

    // As on WhatsApp, the `type` field names the file's MIME type; the part's
    // own content type is only a fallback.
    const file = new File([part], part.name || "upload", { type: form.get("type") || part.type });
    const upstream = await registerWithEmulator(version, phoneNumberId, file, req.headers.authorization);
    let id = upstream.data.id;
    if (!upstream.ok) {
      // Wrong version / phone number id: answer exactly as the library did.
      // A ValidationError means it only objected to the file itself (its
      // type or size), which WhatsApp allows for documents, audio and video.
      if (upstream.data.error?.type !== "ValidationError") {
        return res.status(upstream.status).json(upstream.data);
      }
      id = mediaStore.newId();
    }

    const info = mediaStore.save({
      id,
      buffer: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      mimeType: file.type,
    });
    console.log(`[media] Stored upload ${info.file} (${info.size} bytes)`);
    res.json({ id: info.id });
  } catch (err) {
    console.error(`[proxy] Error handling /${version}/${phoneNumberId}/media:`, err.message);
    res.status(502).json({ error: "Failed to proxy to emulator", detail: err.message });
  }
});

// Forward everything else to the real emulator transparently
proxyApp.use(async (req, res) => {
  try {
    const url = `http://localhost:${INTERNAL_EMULATOR_PORT}${req.originalUrl}`;
    const fetchOptions = {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      },
      ...proxySignal(),
    };
    if (req.method !== "GET" && req.method !== "HEAD" && req.body != null) {
      fetchOptions.body = JSON.stringify(req.body);
    }
    const proxyResp = await fetch(url, fetchOptions);
    const contentType = proxyResp.headers.get("content-type") || "";
    res.status(proxyResp.status);
    if (contentType.includes("application/json")) {
      res.json(await proxyResp.json());
    } else {
      res.set("content-type", contentType);
      res.send(await proxyResp.text());
    }
  } catch (err) {
    console.error(`[proxy] Error forwarding ${req.method} ${req.originalUrl}:`, err.message);
    res.status(502).json({ error: "Proxy error", detail: err.message });
  }
});

const proxyServer = createServer(proxyApp);
proxyServer.listen(cfg.emulatorPort, () => {
  console.log(`Proxy running on port ${cfg.emulatorPort} → forwarding to emulator on ${INTERNAL_EMULATOR_PORT}`);
});

// ─── UI server on UI_PORT ───

const uiApp = express();
const uiServer = createServer(uiApp);

// WebSocket server on the UI port
const wss = new WebSocketServer({ server: uiServer });

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(
    JSON.stringify({
      type: "config",
      userName: cfg.userName,
      botName: cfg.botName,
      userPhone: cfg.userPhone,
      sessionId: cfg.sessionId,
    })
  );
  ws.on("close", () => clients.delete(ws));
});

uiApp.use(express.json());

// Serve static UI files
uiApp.use(express.static(join(__dirname, "ui")));

// Helper: check if the backend webhook is reachable.
// The health endpoint is derived from the webhook URL's origin, not from a
// fixed webhook path, so backends that mount the receiver elsewhere
// (e.g. /api/webhooks/whatsapp) still pass the check. Both common health
// paths are tried; the first 2xx wins.
const BACKEND_BASE = new URL(cfg.webhookUrl).origin;
const HEALTH_PATHS = (process.env.HEALTH_PATHS || "/health,/api/health").split(",");

async function checkBackendHealth() {
  for (const path of HEALTH_PATHS) {
    try {
      const resp = await fetch(`${BACKEND_BASE}${path.trim()}`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return true;
    } catch {
      // try the next path
    }
  }
  return false;
}

// API: Send text message from UI (calls proxy on EMULATOR_PORT)
uiApp.post("/api/send", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const backendUp = await checkBackendHealth();
  if (!backendUp) {
    const msgId = `user_${Date.now()}`;
    const userMsg = { id: msgId, from: "user", msgType: "text", text: message, timestamp: Date.now() };
    broadcast({ type: "user_message", message: userMsg });
    store.save(cfg.sessionId, userMsg);
    broadcast({
      type: "error",
      message: `Backend is not reachable at ${BACKEND_BASE}. Make sure the backend is running.`,
    });
    return res.status(503).json({ error: "Backend not reachable", backendUrl: BACKEND_BASE });
  }

  try {
    const resp = await fetch(
      `http://localhost:${cfg.emulatorPort}/debug/messages/send-text`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: cfg.userPhone, name: cfg.userName, message }),
      }
    );

    let data;
    const text = await resp.text();
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const msgId = data.messageId || `user_${Date.now()}`;
    const userMsg = { id: msgId, from: "user", msgType: "text", text: message, timestamp: Date.now() };
    broadcast({ type: "user_message", message: userMsg });
    store.save(cfg.sessionId, userMsg);

    // Message was accepted by emulator and forwarded to backend — mark as delivered
    setTimeout(() => {
      broadcast({ type: "status", messageId: msgId, status: "delivered", timestamp: Date.now() });
    }, 500);

    res.json(data);
  } catch (err) {
    broadcast({ type: "error", message: `Emulator error: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

// API: Send interactive reply from UI
uiApp.post("/api/send-interactive", async (req, res) => {
  const { type, reply_id, reply_title } = req.body;

  try {
    const resp = await fetch(
      `http://localhost:${cfg.emulatorPort}/debug/messages/send-interactive`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: cfg.userPhone,
          name: cfg.userName,
          type,
          reply_id,
          reply_title,
        }),
      }
    );
    const data = await resp.json();
    const userMsg = {
      id: data.messageId || `user_${Date.now()}`,
      from: "user",
      msgType: "text",
      text: reply_title,
      interactiveReply: { type, reply_id, reply_title },
      timestamp: Date.now(),
    };
    broadcast({ type: "user_message", message: userMsg });
    store.save(cfg.sessionId, userMsg);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Fetch chat history from local SQLite
uiApp.get("/api/history", (_req, res) => {
  try {
    const messages = store.getHistory(cfg.sessionId);
    res.json({ session_id: cfg.sessionId, messages });
  } catch (err) {
    console.error("[history] Error reading store:", err.message);
    res.json({ session_id: cfg.sessionId, messages: [] });
  }
});

// API: Clear session history
uiApp.delete("/api/history", (_req, res) => {
  store.clearSession(cfg.sessionId);
  res.json({ ok: true });
});

// API: Reset session (clear backend + local SQLite)
uiApp.post("/api/reset-session", async (_req, res) => {
  try {
    if (cfg.resetSessionUrl) {
      const resp = await fetch(cfg.resetSessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: cfg.sessionId }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        console.error(`[reset] Backend returned ${resp.status}: ${detail}`);
        return res.status(502).json({ error: "Backend reset failed", status: resp.status });
      }
    } else {
      console.warn("[reset] No resetSessionUrl configured, clearing local only");
    }
    store.clearSession(cfg.sessionId);
    broadcast({ type: "session_reset" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[reset] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: Serve a stored media file. Types a browser can show safely open inline;
// everything else (HTML, SVG, archives, ...) is sent as a download.
const INLINE_MIME = /^(image\/(jpeg|png|gif|webp)|audio\/|video\/|application\/pdf$|text\/plain$)/;

uiApp.get("/api/media/:id", (req, res) => {
  const info = mediaStore.get(req.params.id);
  if (!info) return res.status(404).json({ error: "Media not found" });

  const inline = INLINE_MIME.test(info.mimeType) && req.query.download === undefined;
  res.set({
    "Content-Type": info.mimeType,
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", info.fileName),
    "X-Content-Type-Options": "nosniff",
  });
  res.sendFile(info.file, { root: cfg.mediaDir }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).json({ error: "Media file unavailable" });
  });
});

// API: Health check
uiApp.get("/api/health", async (_req, res) => {
  try {
    const emulatorHealth = await fetch(
      `http://localhost:${cfg.emulatorPort}/debug/health`
    ).then((r) => r.ok);
    res.json({ ui: true, emulator: emulatorHealth });
  } catch {
    res.json({ ui: true, emulator: false });
  }
});

// Start UI server
uiServer.listen(cfg.uiPort, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║          WhatsApp Web UI Emulator Running                ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Web UI:        http://localhost:${String(cfg.uiPort).padEnd(29)}║
║  Emulator API:  http://localhost:${String(cfg.emulatorPort).padEnd(29)}║
║  Phone ID:      ${cfg.phoneNumberId.padEnd(41)}║
║  Session:       ${cfg.sessionId.slice(0, 36).padEnd(41)}║
║                                                          ║
║  Set your bot's env:                                     ║
║  WHATSAPP_API_BASE_URL_OVERRIDE=http://localhost:${cfg.emulatorPort}    ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);
});

function extractBotMessage(body) {
  const timestamp = Date.now();
  const base = {
    id: `bot_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
    from: "bot",
    timestamp,
  };

  if (body.type === "text" && body.text) {
    return { ...base, msgType: "text", text: body.text.body };
  }

  if (body.type === "interactive" && body.interactive) {
    const interactive = body.interactive;
    return {
      ...base,
      msgType: "interactive",
      interactiveType: interactive.type,
      body: interactive.body?.text || "",
      header: interactive.header?.text || "",
      footer: interactive.footer?.text || "",
      buttons:
        interactive.type === "button"
          ? (interactive.action?.buttons || []).map((b) => ({
              id: b.reply?.id,
              title: b.reply?.title,
            }))
          : undefined,
      listButton: interactive.action?.button,
      listSections: interactive.action?.sections,
      ctaUrl: interactive.action?.parameters?.url,
      ctaText: interactive.action?.parameters?.display_text,
      flowAction: interactive.action?.parameters?.flow_action_payload,
    };
  }

  if (body.type === "template" && body.template) {
    return {
      ...base,
      msgType: "template",
      templateName: body.template.name,
      components: body.template.components,
    };
  }

  if (body.type === "image" && body.image) {
    return {
      ...base,
      msgType: "image",
      imageUrl: body.image.link || body.image.id,
      caption: body.image.caption || "",
    };
  }

  if (["video", "audio", "document", "sticker"].includes(body.type) && body[body.type]) {
    return { ...base, msgType: body.type, caption: body[body.type].caption || "" };
  }

  if (body.type === "reaction" && body.reaction) {
    return {
      ...base,
      msgType: "reaction",
      emoji: body.reaction.emoji,
      reactedMessageId: body.reaction.message_id,
    };
  }

  return {
    ...base,
    msgType: "text",
    text: body.text?.body || JSON.stringify(body),
  };
}

// ─── Media ────────────────────────────────────────

const MEDIA_KINDS = ["image", "video", "audio", "document", "sticker"];
const LINK_DOWNLOAD_TIMEOUT_MS = 10_000;

// Same shape as the errors the emulator library returns
function apiError(message, type = "ValidationError", code = 400) {
  return { error: { message, type, code } };
}

function contentDisposition(type, fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// Where a bot payload carries a file: the message itself, or the header of an
// interactive / template message. Returns { kind, ref } with ref = { id | link, filename }.
function findMediaRef(body) {
  if (MEDIA_KINDS.includes(body.type) && body[body.type]) {
    return { kind: body.type, ref: body[body.type] };
  }
  const header = body.type === "interactive" ? body.interactive?.header : null;
  if (header && MEDIA_KINDS.includes(header.type) && header[header.type]) {
    return { kind: header.type, ref: header[header.type] };
  }
  if (body.type === "template") {
    const components = body.template?.components;
    for (const comp of Array.isArray(components) ? components : []) {
      if (comp?.type !== "header" || !Array.isArray(comp.parameters)) continue;
      const param = comp.parameters.find((p) => MEDIA_KINDS.includes(p?.type) && p[p.type]);
      if (param) return { kind: param.type, ref: param[param.type] };
    }
  }
  return null;
}

// Hand a file to the internal emulator, which issues the media id it later
// validates `image` messages against. It only accepts JPEG/PNG up to 5MB.
async function registerWithEmulator(version, phoneNumberId, file, authorization) {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("file", file, file.name);
  const resp = await fetch(
    `http://localhost:${INTERNAL_EMULATOR_PORT}/${version}/${phoneNumberId}/media`,
    {
      method: "POST",
      headers: authorization ? { Authorization: authorization } : {},
      body: form,
      ...proxySignal(),
    }
  );
  let data;
  try { data = await resp.json(); } catch { data = {}; }
  return { ok: resp.ok, status: resp.status, data };
}

// Download a media `link` into local storage, as WhatsApp would fetch it.
async function storeLinkedMedia(ref, body, { version, phoneNumberId, authorization }) {
  const download = await downloadLink(ref.link, {
    maxBytes: cfg.mediaMaxBytes,
    timeoutMs: LINK_DOWNLOAD_TIMEOUT_MS,
  });
  const info = mediaStore.save({
    buffer: download.buffer,
    fileName: ref.filename || download.fileName,
    mimeType: download.mimeType,
  });
  console.log(`[media] Fetched ${ref.link} → ${info.file} (${info.size} bytes)`);

  // The library only takes images by id, so give it this copy to validate
  // against; that lets image-by-link messages succeed like they do on WhatsApp.
  if (body.type === "image") {
    try {
      const file = new File([download.buffer], info.fileName, { type: info.mimeType });
      const upstream = await registerWithEmulator(version, phoneNumberId, file, authorization);
      if (upstream.ok) body.image.id = upstream.data.id;
    } catch (err) {
      console.error(`[media] Could not register ${info.id} with the emulator:`, err.message);
    }
  }
  return info;
}

// Resolve the file a bot message points at (uploaded id or link) to local
// storage and describe it on the UI message as `media`. Never throws: a file
// that can't be resolved is recorded in `media.error` and the message still shows.
async function attachMedia(msg, body, ctx) {
  const found = findMediaRef(body);
  if (!found) return;
  const { kind, ref } = found;

  const media = { kind };
  if (ref.link) media.link = ref.link;
  try {
    let info = ref.id ? mediaStore.get(ref.id) : null;
    if (!info && ref.link) info = await storeLinkedMedia(ref, body, ctx);
    if (info) Object.assign(media, describeMedia(info));
    else media.error = ref.id ? `Media ${ref.id} not found in local storage` : "Message has no media id or link";
  } catch (err) {
    media.error = `Could not fetch ${ref.link}: ${err.message}`;
    console.error(`[media] ${media.error}`);
  }
  if (ref.filename) media.fileName = ref.filename;
  msg.media = media;
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  store.close();
  await emulator.stop();
  proxyServer.close();
  uiServer.close();
  process.exit(0);
});
