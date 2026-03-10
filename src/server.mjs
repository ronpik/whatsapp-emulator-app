#!/usr/bin/env node
import { WhatsAppEmulator } from "@whatsapp-cloudapi/emulator";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { loadConfig } from "./config.mjs";
import { MessageStore } from "./store.mjs";

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
    const isTypingIndicator =
      body.type === "text" && !body.text && body.recipient_type === "individual";

    // Broadcast actual bot messages to the UI and persist
    if (!isMarkAsRead && !isTypingIndicator) {
      const botMessage = extractBotMessage(body);
      if (botMessage) {
        broadcast({ type: "bot_message", message: botMessage });
        store.save(cfg.sessionId, botMessage);
      }
    }

    if (isTypingIndicator) {
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
    if (!isMarkAsRead && !isTypingIndicator && data.messages?.[0]) {
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

// Helper: check if the backend webhook is reachable
const BACKEND_BASE = cfg.webhookUrl.replace(/\/api\/whatsapp\/webhook$/, "");

async function checkBackendHealth() {
  try {
    const resp = await fetch(`${BACKEND_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
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

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  store.close();
  await emulator.stop();
  proxyServer.close();
  uiServer.close();
  process.exit(0);
});
