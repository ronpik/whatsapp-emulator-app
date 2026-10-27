import { createHmac, randomBytes } from "crypto";

// Interactive replies (buttons, lists, Flows) are posted to the backend from
// here rather than through the emulator library: its debug endpoint has no
// `nfm_reply` and puts no `context` on inbound messages. The envelope is the
// one the library's WebhookService builds, which is Meta's.

// Long, since nothing waits on it: a backend may run its whole turn in the call
const WEBHOOK_TIMEOUT_MS = 300_000;

// Same shape as a Cloud API message id: "wamid." + base64
export function newWamid() {
  return `wamid.${randomBytes(24).toString("base64")}`;
}

function signature(body, secret) {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/**
 * One inbound message from the user, as WhatsApp delivers it.
 * `interactive` is the message's `interactive` object; `contextId`, when known,
 * is the wamid of the business message being answered.
 */
export function inboundInteractive({ id, from, displayPhoneNumber, contextId, interactive, timestamp }) {
  return {
    ...(contextId ? { context: { from: displayPhoneNumber, id: contextId } } : {}),
    from,
    id,
    timestamp: String(Math.floor(timestamp / 1000)),
    type: "interactive",
    interactive,
  };
}

/**
 * POST a message to the backend webhook in Meta's envelope, signed with
 * X-Hub-Signature-256 when an app secret is configured. Throws unless the
 * backend answers 2xx.
 */
export async function postInbound(message, { url, appSecret, phoneNumberId, displayPhoneNumber, contactName }) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: phoneNumberId,
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: displayPhoneNumber, phone_number_id: phoneNumberId },
              contacts: [{ wa_id: message.from, profile: { name: contactName } }],
              messages: [message],
            },
            field: "messages",
          },
        ],
      },
    ],
  });
  const headers = { "Content-Type": "application/json" };
  if (appSecret) headers["X-Hub-Signature-256"] = signature(body, appSecret);

  let resp;
  try {
    resp = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Webhook ${url} unreachable: ${err.cause?.code || err.message}`);
  }
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).slice(0, 200);
    throw new Error(`Webhook ${url} answered ${resp.status}${detail ? `: ${detail}` : ""}`);
  }
}
