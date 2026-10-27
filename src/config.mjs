import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";
import yaml from "js-yaml";

/**
 * Derive a deterministic session ID from a phone number.
 * Produces a UUID-v4-shaped string so it looks natural in logs/DBs.
 */
function phoneToSessionId(phone) {
  const hex = createHash("sha256").update(phone).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16), // version nibble
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Backend health paths, from a YAML list or a comma-separated string (env var).
 * Each is trimmed and given a leading slash; falls back to the defaults if none are left.
 */
function parseHealthPaths(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(",");
  const paths = items.map((p) => String(p).trim()).filter(Boolean).map((p) => (p.startsWith("/") ? p : `/${p}`));
  return paths.length ? paths : ["/health", "/api/health"];
}

/**
 * Flow JSON files by flow_id: the YAML `flows:` map, with FLOWS
 * (`id=path,id=path`) overriding it per id. Paths resolve from CWD.
 */
function loadFlows(fileFlows, envFlows) {
  const entries = Object.entries(fileFlows && typeof fileFlows === "object" ? fileFlows : {});
  for (const pair of (envFlows || "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) entries.push([pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()]);
  }
  const flows = new Map();
  for (const [id, path] of entries) {
    if (id && typeof path === "string" && path) flows.set(id, resolve(process.cwd(), path));
  }
  return flows;
}

/**
 * Load config from YAML, with env-var overrides.
 * Accepts an optional path; defaults to wa-emulator-config.yaml in CWD.
 */
export function loadConfig(configPath) {
  const cfgFile = configPath || process.env.CONFIG_PATH || resolve(process.cwd(), "wa-emulator-config.yaml");
  let file = {};
  if (existsSync(cfgFile)) {
    file = yaml.load(readFileSync(cfgFile, "utf8")) || {};
    console.log(`[config] Loaded ${cfgFile}`);
  } else {
    console.log(`[config] No config file at ${cfgFile}, using defaults + env`);
  }

  const user = file.user || {};
  const bot = file.bot || {};
  const server = file.server || {};
  const webhook = file.webhook || {};
  const storage = file.storage || {};

  const userPhone = process.env.USER_PHONE || user.phone || "+1234567890";
  const dbPath = resolve(process.cwd(), process.env.DB_PATH || storage.db_path || "data/messages.db");

  const config = {
    userPhone,
    userName: process.env.USER_NAME || user.name || "You",
    botName: process.env.BOT_NAME || bot.name || "Bot",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || bot.phone_number_id || "15551234567",

    sessionId: file.session_id || phoneToSessionId(userPhone),

    uiPort: parseInt(process.env.UI_PORT || server.ui_port || "3000"),
    emulatorPort: parseInt(process.env.EMULATOR_PORT || server.emulator_port || "4004"),

    webhookUrl: process.env.WEBHOOK_URL || webhook.url || "http://localhost:8000/api/whatsapp/webhook",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || webhook.verify_token || "test-verify-token",
    appSecret: process.env.WHATSAPP_WEBHOOK_SECRET || webhook.app_secret || undefined,
    resetSessionUrl: process.env.RESET_SESSION_URL || webhook.reset_session_url || undefined,
    // Probed on the webhook URL's origin, in order, to tell whether the backend is up
    healthPaths: parseHealthPaths(process.env.HEALTH_PATHS || webhook.health_paths),

    dbPath,
    // Files the bot sends are kept next to the database unless told otherwise
    mediaDir: resolve(process.cwd(), process.env.MEDIA_DIR || storage.media_dir || join(dirname(dbPath), "media")),
    mediaMaxBytes: parseFloat(process.env.MEDIA_MAX_MB || storage.media_max_mb || "100") * 1024 * 1024,

    // WhatsApp Flows: Meta holds a Flow's JSON by flow_id; here a file does
    flows: loadFlows(file.flows, process.env.FLOWS),
  };

  return config;
}
