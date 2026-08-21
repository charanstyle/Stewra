# Website E2E suite

End-to-end tests that drive the **real Stewra website** in headless Chromium with the
real [`@playwright/test`](https://playwright.dev/) runner. They seed **two authenticated
user sessions** at once, so they can exercise flows a single-device test can't — most
importantly two-party WebRTC calls (User A calls User B, both ends assert `Connected`).

One exception lives in [`commerce/`](#the-commerce-suite--commerce-its-own-config-and-its-own-stack),
which boots its own local stack because the commerce plane isn't deployed and its connect flow can't
be run against production.

This is the web counterpart to [`frontend/e2e/`](../../frontend/e2e/) (Maestro, one
device). Because auth lives in `localStorage["stewra.tokens"]` (per-origin, shared across
tabs), the two users can't coexist in one browser context — every test gets its own
context per user (`ctxA`/`ctxB`), seeded before its first navigation.

## Prerequisites

- **Node 18+** and this folder's deps: `npm install` (its `postinstall` runs
  `playwright install chromium`).
- **Two email-verified QA users who are contacts of each other**, identified by
  **email + password** (no pasted tokens — the suite logs in via the real API once per
  worker and mints fresh short-lived tokens itself). A `direct` conversation can only be
  created between contacts, and every page sits behind email verification.
- For call tests: **no phone/emulator signed in as either QA user.** Incoming calls fan
  out to every logged-in device; a signed-in device collides with the browser↔browser
  handshake (`setRemoteDescription… wrong state: stable`). Sign mobile devices out first
  with [`frontend/e2e/scripts/reset-devices.sh`](../../frontend/e2e/scripts/reset-devices.sh).

## Configuration (never hardcoded)

`config.mjs` reads from environment variables **or** the single untracked repo-root
[`.env.e2e`](../../.env.e2e.example) (shared with the Maestro mobile suite) — env wins.
Required values throw loudly if missing, so a run can't silently target the wrong host or
authenticate as the wrong user.

| Variable | Required | Meaning |
| --- | --- | --- |
| `E2E_WEB_URL` | ✅ | Site under test, e.g. `https://www.stewra.com`. |
| `E2E_API_URL` | — | API base. Defaults to `${E2E_WEB_URL}/api` (nginx strips `/api` in prod). |
| `E2E_AUDIO_FILE` | — | 16 kHz mono WAV fed to WebRTC as fake mic input, so speech-to-text yields a real transcript. |
| `E2E_USER_A_EMAIL` / `E2E_USER_A_PASSWORD` | ✅ | User A's login credentials. |
| `E2E_USER_B_EMAIL` / `E2E_USER_B_PASSWORD` | ✅ | User B's login credentials. |
| `E2E_SIGNUP_MAILBOX` | — | Real mailbox whose maildir holds the emailed verification codes. Setting it enables the UI sign-up test; leaving it unset skips that test. Plus-addressed per run (`qa@x.com` → `qa+signup<rand>@x.com`), so one mailbox covers unlimited sign-ups. |
| `E2E_SIGNUP_SSH_HOST` | ⚠️ | ssh host running the mail server's Docker daemon. **Required once `E2E_SIGNUP_MAILBOX` is set** — never defaulted, so a half-configured run fails loudly instead of ssh-ing somewhere unintended. |
| `E2E_SIGNUP_IMAP_CONTAINER` | ⚠️ | Container whose `/mail/<mailbox>/` maildir is read via `docker exec`. Same rule as above. |
| `TELNYX_E2E_NUMBERS` | — | The install's own test numbers (comma-separated E.164). Texts sent to them are delivered by Telnyx to the production webhook and read back with `sms.mjs` (`waitForSmsCode`) as the install owner — the SMS twin of the mailbox above, for services that verify by text. These are VoIP-class numbers: consumer WhatsApp refuses them, so WhatsApp identities come from real SIMs. |
| `E2E_OWNER_EMAIL` / `E2E_OWNER_PASSWORD` | ⚠️ | Install-admin login that `sms.mjs` reads the inbox with (`GET /platform/telnyx/inbound/<number>` is `requireInstallAdmin`). Required once `TELNYX_E2E_NUMBERS` is set. |
| `E2E_WHATSAPP_NUMBER_A` | — | QA user A's WhatsApp identity (E.164): a real SIM in a lab phone, because WhatsApp refuses the Telnyx numbers. The WhatsApp pass is manual and phone-driven: the bridge is linked by **pairing code** (not QR — the phone is reached over adb, not pointed at a screen) and the self-chat is driven with `adb shell input`/`uiautomator dump`; long replies are read from screenshots, not the accessibility dump. |

```bash
cp ../../.env.e2e.example ../../.env.e2e   # repo-root, gitignored — fill in real values
```

Each worker calls `/auth/login` once for A and once for B (`loginAll()` in `lib.mjs`) and
ensures their direct conversation exists, before any test in that worker runs — see the
worker-scoped `session` fixture in `fixtures.ts`.

## Run

```bash
npm run test:e2e           # headless, both projects (desktop + mobile viewport)
npm run test:e2e:headed    # same, with a visible browser
npm run test:e2e:ui        # Playwright's interactive UI mode
npm run test:e2e:report    # open the last HTML report
npm run type-check:e2e     # tsc --noEmit over the whole e2e/ folder
```

`playwright.config.ts` runs two projects against every spec in `tests/`:

| Project | Viewport | What it covers |
| --- | --- | --- |
| `desktop-chromium` | 1180×860 | The primary desktop experience. |
| `mobile-chromium` | Pixel 7 emulation | The responsive pass — the mobile-web viewport RN-app users also hit on the web. |

`workers: 1` and `retries: 1` are intentional: the two QA sessions are shared, real
production accounts (there is no separate dev DB), so tests must not race each other.
Fake-media launch args (`--use-fake-device-for-media-stream`,
`--use-fake-ui-for-media-stream`, plus `E2E_AUDIO_FILE` if set) make WebRTC + voice work
headless with no real hardware.

Results land in `.artifacts/` (gitignored): `report/` for the HTML report (`npm run
test:e2e:report` opens it), `results.json`, traces/videos/screenshots on failure, and raw
`test-results/`.

## What each spec covers

| Spec | Ported from | What it checks |
| --- | --- | --- |
| `tests/auth.spec.ts` | `full.mjs` §1 (auth) | Unauthenticated redirect to `/login`, login page rendering, register-mode Name field, per-user session validity, sign-out. |
| `tests/nav.spec.ts` | `full.mjs` §1 (nav) | Home→messaging reachability, AppNav click-through, Activity↔Memory round-trip, unknown-route→`/today` catch-all. |
| `tests/chats.spec.ts` | `full.mjs` §2 | Conversation list rendering, "New chat"→Contacts, live presence dot + unread badge. |
| `tests/chat.spec.ts` | `full.mjs` §3 | Opening a conversation by row click, bidirectional live text (Send button + Enter-to-send), typing indicator, message timestamps, Back navigation. |
| `tests/calls.spec.ts` | `full.mjs` §4, `calls.audio.mjs`, `calls.video.mjs` | Full audio call (ring→answer→connect→mute→hang up→inline markers), decline flow, full video call (+ camera toggle), and N-attempt fresh-context connect-reliability probes for both kinds. |
| `tests/stewra.spec.ts` | `full.mjs` §5 | Text→assistant reply on `/stewra`, hold-to-talk voice→transcribed turn. |
| `tests/contacts.spec.ts` | `full.mjs` §6 | People search, contacts list + invite form, invite-by-email, Block↔Unblock, Message-from-row deep link. |
| `tests/activity.spec.ts` | `full.mjs` §7 | Home cards, Google-connect consent modal (cancelled, never completes real OAuth), Gmail-window save, writing-style toggle, insight generation + feedback. |
| `tests/memory.spec.ts` | `full.mjs` §8 | Memory page render/search/filter, Edit→Cancel, Hide↔Use-for-recall toggle. |
| `tests/gaps.spec.ts` | `full.mjs` §9 | By-design product gaps, asserted as real (hard) checks: no call buttons on the Stewra thread, no mic on the human composer. |
| `tests/today.spec.ts` | `today.mjs` | The proactive `/today` home: greeting, briefing card vs. backend truth, nudge list vs. backend suggestions, expand/draft/snooze/dismiss/chat-about-this, AppNav order, console-error-free navigation. |
| `tests/runner.spec.ts` | Phase 5 control surface | The in-chat "Run coding agent" card: ask Stewra (in the Stewra thread) to run a coding agent on one of your machines → the intent classifier proposes → the card renders → **Start** dispatches a real session. Auto-discovers an online runner via `GET /runner/devices` and **skips** if none is paired/online — no synthetic runner. |

## The runner's machines — QA virtual machines, paired through the screens

`runner.spec.ts` and `fleet.spec.ts` need a machine **paired to QA user A**, online, with a harness and
a git checkout. The real Macs belong to the business account, so the QA account has two disposable
guests of its own: `qa-linux` (Debian 13 under KVM/libvirt on stewra-server) and `qa-macos` (macOS
under Tart on the Mac mini, kept alive by `com.stewra.qa-macos` launchd). Each runs `stewra-runner`
0.2.0 as a service, has `claude-agent-acp` on PATH, a throwaway `~/work/e2e-sandbox` repo, and its
Claude login in `~/.stewra-runner/credentials/claude-code` (never in an env var, never in this repo).

They were paired the way a customer pairs a laptop — sign in, `/fleet`, "Pair a machine", copy the
command. `qa-runner-pair.mjs` does exactly that and nothing else:

```bash
node qa-runner-pair.mjs A     # prints CODE=STEWRA-…, minted in A's active org
# then, inside the guest:  STEWRA_API_URL=https://www.stewra.com stewra-runner pair STEWRA-…
```

`structure.mjs` is the same idea for the business account (org, projects, bindings). Neither
touches the API directly; if a step cannot be done from a screen, the script cannot do it either.

## The commerce suite — `commerce/`, its own config and its own stack

Everything above drives **production**. The commerce plane can't: it isn't deployed, and connecting a
channel means completing Meta's Embedded Signup against a real WhatsApp Business Account owned by a
real business — not something a test may do to production, ever.

So `playwright.commerce.config.ts` boots its own stack instead:

```bash
npm run test:e2e:commerce
```

No `.env.e2e` needed — the database and secrets come from `backend/.env.test`, and a missing one
throws rather than being defaulted into a run that targets the wrong machine. `commerce/stack.mjs`
starts a real Graph stub process, then the **real backend** (`npx tsx src/index.ts`) pointed at it,
then the **real website** (`npx vite --strictPort`) pointed at that backend, on OS-assigned ports
published to the workers via `process.env`. The Meta app secret and webhook verify token are minted
per run with `randomBytes`, so a spec can sign an inbound webhook for real.

Only Meta is replaced, and only at the network boundary — no application code is mocked. The stub
(`commerce/graphStub.mjs`) takes instructions at `POST /__stub/state` and records every call, so a
spec can assert what did and did **not** reach Meta.

The four tests cover: a fresh org's empty state, a `CONNECTED` number (never registered) and its
disconnect, a `PENDING` number refused without a PIN then registered with one, and a signed inbound
webhook routing to the right org's inbox with a reply going back out. Full detail, including why the
webhook assertions must poll, is in [`TESTING.md`](../../TESTING.md).

`commerce/billing.spec.ts` runs on the same stack and covers the money page: an org on no plan, a
web subscriber whose $149 invoice is issued by the **real** billing sweep and close job, and an App
Store subscriber who is shown neither a card form nor an offline-payment note and is never invoiced
at all. The stack turns the hourly sweep down to two seconds via `COMMERCE_BILLING_SWEEP_MS` —
which changes when it runs, never what it does; every step it drives is idempotent.

**Untested seam:** the Embedded Signup dialog itself. `metaEmbeddedSignup.ts` loads Meta's SDK from
`connect.facebook.net`, unreachable from a test; the specs connect through the real API instead.

## The Stripe suite — `commerce/*.stripe.ts`, real test mode, credentials required

```bash
npm run test:e2e:stripe
```

Same stack, separate config, one difference: this suite needs real Stripe **test-mode** keys in
`backend/.env.test` (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`), and
`commerce/stripeGlobalSetup.mjs` refuses to start without them.

It is separate precisely because of that. The commerce suite provisions everything it needs, which
is what lets CI run it at `E2E_MAX_SKIPS=0`; a suite that cannot always run would either break that
budget or hide behind a skip. Card entry cannot be provisioned: the field is an iframe served by
`js.stripe.com` and confirmed by Stripe's own script against the publishable key, so — unlike Meta's
Graph — there is no network boundary at which Stripe can be replaced, and unlike the server's calls
there is no `STRIPE_API_BASE_URL` that moves the browser somewhere else. A `4242` card in test mode
is not a compromise here; it is the only honest way to prove a customer can put a card on file.

What it drives: a card typed into Stripe's iframe → the real SetupIntent → the server re-reading
from Stripe what that setup attached → a $149 invoice issued and then **collected without anyone
pressing anything**, plus a replace-card pass proving a paid invoice is never charged twice.

The server's half of Stripe — idempotency keys on the wire, two racing collectors, declines, webhook
signatures over raw bytes — is covered without credentials by `backend/src/tests/commercePayments.test.ts`
against a scripted stand-in.

## Safety: destructive / external-OAuth flows are skipped, not omitted

A few flows are real product features but unsafe to fully exercise against a live account
with `workers: 1` accounts. These use `test.skip(condition, reason)` (visible in the report
as **skipped**, not passed or failed) with the original safety reasoning preserved:

- **Email sign-up / verification** (`auth.spec.ts`) — fully implemented and driven through
  the UI (register → read the emailed 6-digit code from the real mailbox → `/verify-email`
  → `/today`), but gated on `E2E_SIGNUP_MAILBOX`. It is not free to run: `audit_log`
  references `users` with `ON DELETE SET NULL` and the append-only trigger rejects that
  `UPDATE`, so a signed-up account **cannot be deleted** and every run leaves one behind.
- **Completing Google OAuth** (`activity.spec.ts`) — the in-page consent modal is opened
  and asserted, then cancelled with "Not now" rather than following the real external
  Google redirect.
- **Delete memory** (`memory.spec.ts`) — runs for real, but only against a throwaway memory
  the suite seeds itself (`seed.mjs`, gated on `E2E_DATABASE_URL`), targeted by its
  distinctive label so genuinely learned data is never touched. Without a DB URL the seed
  is skipped and so is the delete — run `npm run test:e2e:seeded` (see `with-prod-db.sh`)
  to supply one without writing the password anywhere.

## `data-testid` contract

Some checks now target stable `data-testid` attributes instead of hashed CSS-module class
substrings (`[class*="…"]`). See [`TESTIDS.md`](./TESTIDS.md) for the full registry and
which `website/src` component owns each one.
