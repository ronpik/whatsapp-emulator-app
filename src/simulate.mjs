/**
 * Simulate an incoming WhatsApp text message.
 *
 * Usage:
 *   node src/simulate.mjs "Hello from WhatsApp!"
 *   node src/simulate.mjs "Hi there" --from +1234567890 --name "Test User"
 */

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help")) {
  console.log(`
Usage: node src/simulate.mjs <message> [options]

Options:
  --from <number>   Sender phone number (default: +1234567890)
  --name <name>     Sender display name (default: Test User)
  --port <port>     Emulator port (default: 4004)
  --help            Show this help message

Examples:
  node src/simulate.mjs "Hello!"
  node src/simulate.mjs "Hi" --from +9725551234 --name "Ron"
  npm run simulate -- "Hello from WhatsApp!"
`);
  process.exit(0);
}

// Parse arguments
let message = "";
let from = "+1234567890";
let name = "Test User";
let port = process.env.EMULATOR_PORT || "4004";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from" && args[i + 1]) {
    from = args[++i];
  } else if (args[i] === "--name" && args[i + 1]) {
    name = args[++i];
  } else if (args[i] === "--port" && args[i + 1]) {
    port = args[++i];
  } else if (!args[i].startsWith("--")) {
    message = args[i];
  }
}

if (!message) {
  console.error("Error: message text is required");
  process.exit(1);
}

const url = `http://localhost:${port}/debug/messages/send-text`;
const body = { from, name, message };

console.log(`Sending simulated message to emulator...`);
console.log(`  From: ${name} (${from})`);
console.log(`  Message: "${message}"`);
console.log(`  URL: ${url}`);
console.log();

try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (response.ok) {
    console.log("Message sent successfully!");
    console.log("Response:", JSON.stringify(data, null, 2));
  } else {
    console.error(`Error ${response.status}:`, data);
  }
} catch (error) {
  console.error("Failed to connect to emulator:", error.message);
  console.error("Make sure the emulator is running: npm start");
}
