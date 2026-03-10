import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, "..");

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
 * Load config from YAML, with env-var overrides.
 * Accepts an optional path; defaults to <pkg-root>/config.yaml.
 */
export function loadConfig(configPath) {
  const cfgFile = configPath || process.env.CONFIG_PATH || join(PKG_ROOT, "config.yaml");
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

    dbPath: resolve(PKG_ROOT, process.env.DB_PATH || storage.db_path || "data/messages.db"),
  };

  return config;
}
