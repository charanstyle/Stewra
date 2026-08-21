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
 * Undo `Content-Transfer-Encoding: quoted-printable`, which nodemailer applies to every body here
 * (the copy contains em dashes, so no part is plain 7-bit). Two things it fixes, both of which would
 * otherwise break a match on an accept link: soft line breaks chop long URLs at column 76, and `=`
 * itself — the character that separates `token` from its value — arrives as `=3D`.
 *
 * Byte-for-byte only for the ASCII a caller extracts (digits, URLs). A multi-byte UTF-8 character
 * comes back as its individual bytes, which is fine for matching and wrong for display; nothing here
 * displays a body.
 */
function decodeQuotedPrintable(body) {
  return body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Poll for a recent mail addressed to `address` whose decoded body matches `pattern`, and return
 * that pattern's first capture group. Throws if none arrives within `timeoutMs`.
 *
 * Reads the newest FEW matching messages rather than only the newest one: an address can hold more
 * than one recent mail (sign up, then get invited), and pinning to `head -1` would sit on the wrong
 * message until the deadline. Files arrive newest-first, so the first match is the freshest.
 */
export async function waitForMail({
  sshHost,
  imapContainer,
  mailbox,
  address,
  pattern,
  what = 'mail',
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  for (const [name, value] of Object.entries({ sshHost, imapContainer, mailbox, address, pattern })) {
    if (!value) {
      throw new Error(`[mailbox] waitForMail requires "${name}"`);
    }
  }

  const find =
    `docker exec ${imapContainer} sh -lc ` +
    `"find /mail/${mailbox}/new /mail/${mailbox}/cur -type f -mmin -${FRESH_MINUTES} ` +
    `-exec grep -l '${address}' {} + 2>/dev/null | xargs -r ls -t | head -5 | xargs -r cat"`;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let body = '';
    try {
      body = ssh(sshHost, find);
    } catch {
      // No match yet (grep exits non-zero) or a transient ssh hiccup — both just mean "retry", and `body`
      // keeps its empty initial value so the regex below simply misses and the loop goes round again.
    }
    const m = pattern.exec(decodeQuotedPrintable(body));
    if (m) {
      return m[1];
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`[mailbox] no ${what} for ${address} within ${timeoutMs}ms`);
}

/** The 6-digit code from a recent verification mail. */
export async function waitForVerificationCode(params) {
  return waitForMail({
    ...params,
    pattern: /verification code is\s*(\d{6})/i,
    what: 'verification mail',
  });
}

/**
 * The `/invites/accept?token=…` path out of a recent org-invite mail — everything after the origin,
 * so the caller opens it on the site under test rather than on whatever APP_URL the server was
 * configured with.
 */
export async function waitForInviteAcceptPath(params) {
  return waitForMail({
    ...params,
    // Stops at the first character that cannot be in a URL, which is what ends the token in both the
    // text part ("Open this link to accept: <url>\n") and the HTML one (href="<url>").
    pattern: /(\/invites\/accept\?token=[^\s"'<>]+)/,
    what: 'org-invite mail',
  });
}
