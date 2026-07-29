// Reads emailed verification codes out of the real Mailu mailbox.
//
// This is what lets the sign-up flow be tested through the UI rather than stubbed: the site
// emails a 6-digit code, and the only honest way to type it into /verify-email is to read the
// mail a user would read. The maildir is reachable over ssh via `docker exec`, so no IMAP
// client or app password is involved.
//
// Every target — ssh host, container, mailbox — is a required argument. Nothing is defaulted:
// a guessed host would make a misconfigured run ssh somewhere nobody named and then report the
// missing code as a product failure.
import { execFileSync } from 'node:child_process';

// Only mail this recent counts, so a stale code from an earlier run can never be picked up.
// The container ships BusyBox find, which has `-mmin` but NOT `-newermt` — hence minutes.
const FRESH_MINUTES = 5;
const POLL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Plus-address off a single real mailbox. Mailu's RECIPIENT_DELIMITER is `+`, so `qa@x.com`
 * plus tag `a1` delivers `qa+a1@x.com` into the same maildir — one mailbox, unlimited
 * distinct addresses that Stewra treats as separate users.
 */
export function plusAddress(mailbox, tag) {
  const at = mailbox.indexOf('@');
  if (at === -1) {
    throw new Error(`[mailbox] not an email address: ${mailbox}`);
  }
  return `${mailbox.slice(0, at)}+${tag}@${mailbox.slice(at + 1)}`;
}

function ssh(sshHost, script) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', sshHost, script], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Poll for a recent verification mail addressed to `address` and return its 6-digit code.
 * Throws if none arrives within `timeoutMs`.
 */
export async function waitForVerificationCode({
  sshHost,
  imapContainer,
  mailbox,
  address,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  for (const [name, value] of Object.entries({ sshHost, imapContainer, mailbox, address })) {
    if (!value) {
      throw new Error(`[mailbox] waitForVerificationCode requires "${name}"`);
    }
  }

  const find =
    `docker exec ${imapContainer} sh -lc ` +
    `"find /mail/${mailbox}/new /mail/${mailbox}/cur -type f -mmin -${FRESH_MINUTES} ` +
    `-exec grep -l '${address}' {} + 2>/dev/null | xargs -r ls -t | head -1 | xargs -r cat"`;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let body = '';
    try {
      body = ssh(sshHost, find);
    } catch {
      // No match yet (grep exits non-zero) or a transient ssh hiccup — both just mean "retry", and `body`
      // keeps its empty initial value so the regex below simply misses and the loop goes round again.
    }
    const m = /verification code is\s*(\d{6})/i.exec(body);
    if (m) {
      return m[1];
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`[mailbox] no verification mail for ${address} within ${timeoutMs}ms`);
}
