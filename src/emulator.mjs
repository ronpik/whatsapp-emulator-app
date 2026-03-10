import { WhatsAppEmulator } from "@whatsapp-cloudapi/emulator";

const config = {
  businessPhoneNumberId:
    process.env.WHATSAPP_PHONE_NUMBER_ID || "15551234567",
  port: parseInt(process.env.EMULATOR_PORT || "4004"),
  webhook: {
    url:
      process.env.WEBHOOK_URL || "http://localhost:8000/api/whatsapp/webhook",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "test-verify-token",
    appSecret: process.env.WHATSAPP_WEBHOOK_SECRET || undefined,
    timeout: 5000,
  },
};

const emulator = new WhatsAppEmulator(config);

await emulator.start();

console.log(`
╔══════════════════════════════════════════════════════════╗
║          WhatsApp Cloud API Emulator Running             ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Emulator URL:    http://localhost:${config.port}                ║
║  Webhook target:  ${config.webhook.url}  ║
║  Phone Number ID: ${config.businessPhoneNumberId.padEnd(37)}║
║                                                          ║
║  Simulate a message:                                     ║
║    npm run simulate -- "Hello from WhatsApp!"            ║
║                                                          ║
║  Or via curl:                                            ║
║    curl -X POST http://localhost:${config.port}/debug/messages/send-text \\  ║
║      -H "Content-Type: application/json" \\               ║
║      -d '{"from":"+1234567890","message":"Hi"}'          ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);

// Keep the process running
process.on("SIGINT", async () => {
  console.log("\nShutting down emulator...");
  await emulator.stop();
  process.exit(0);
});
