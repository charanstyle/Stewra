// The install's Telnyx inbox, read as the owner: the SMS codes other services (WhatsApp, 2FA) text to
// the e2e numbers. Production only — the webhook is registered against www.stewra.com.
import { config } from './config.mjs';
import { loginViaApi } from './lib.mjs';

const API = config.apiUrl;

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`[e2e] ${name} is not set in .env.e2e`);
  return value.trim();
}

/** @returns {Promise<Array<{from: string, to: string, text: string, receivedAt: string, providerMessageId: string}>>} */
export async function listInboundSms(number) {
  const { accessToken } = await loginViaApi(required('E2E_OWNER_EMAIL'), required('E2E_OWNER_PASSWORD'));
  const res = await fetch(`${API}/platform/telnyx/inbound/${encodeURIComponent(number)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok || json?.success !== true) {
    throw new Error(`[e2e] inbox read for ${number} failed (HTTP ${res.status}): ${JSON.stringify(json)}`);
  }
  return json.data.messages;
}

/**
 * Wait for a text matching `pattern` to arrive on `number`, newer than `after` (ISO), and return the
 * first capture group (the code). Throws after `timeoutMs` — a code that never comes is a failure.
 */
export async function waitForSmsCode(number, pattern, { after, timeoutMs = 120_000, intervalMs = 3_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = await listInboundSms(number);
    const hit = messages
      .filter((m) => m.receivedAt > after)
      .map((m) => pattern.exec(m.text))
      .find((match) => match !== null);
    if (hit) return hit[1];
    if (Date.now() >= deadline) throw new Error(`[e2e] no SMS matching ${pattern} on ${number} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
