# Build Plan: A Trust-First Personal Assistant

> **What this is:** A working plan for a personal-assistant product whose entire
> differentiator is that people actually feel safe handing it their life. It leads
> with *advice* (money + time), not autonomous action. It is born sandboxed,
> read-first, transparent, and with zero security knobs. Autonomy is something the
> user grows into, never the default.
>
> **Who it's for:** You — a solo experienced dev — to hand piece-by-piece to Claude Code.
>
> **The one-sentence product:** *An assistant that reads your money and your calendar,
> tells you the true cost of your choices, can't do anything irreversible by surprise,
> runs only on sanctioned revocable connections, and earns the right to act over time.*

---

## 0. The non-negotiable principles (read this before any code)

These are the spine. Every architectural decision traces back to one of them. If a
feature violates one of these, it doesn't ship — that restraint *is* the product.

1. **The model is never a trusted enforcement point.** The LLM proposes; deterministic
   code outside the model's reach decides whether anything happens. The agent can never
   widen its own permissions, raise its own limits, or bypass a confirmation — not even
   if it "decides it should." (This is the CrowdStrike-incident lesson, baked into the architecture.)
2. **Read-first, act-later.** v1 observes and advises. It cannot take consequential
   action at all. Autonomy unlocks per-user, gradually, after trust is built.
3. **Irreversible = always gated.** Anything that sends, spends, deletes, or commits hits
   a confirmation wall enforced outside the agent. The agent cannot remove that wall.
4. **Everything is legible.** Every action and every data access is visible in a
   plain-language activity log. The user can always answer "what is this doing with my life?"
5. **Smallest blast radius by default.** New users start read-only, minimal scopes,
   zero spend authority, default-deny egress. The user loosens it; the product never
   pre-loosens it for them.
6. **Zero security knobs.** Safety is the default, not a configuration. No permission
   matrices. One plain-language consent decision at a time, in context.
7. **Sanctioned, revocable connections only — and gray-market NEVER on our servers.** Email
   (Gmail/Graph), Calendar (Google/Microsoft), banking (via aggregator). The default and
   recommended WhatsApp path is Meta's official Cloud API: the user messages Stewra's business
   number and no user account is ever at risk.

   A companion-device client (Baileys-style) is permitted **only** under all of these, together:
   it is **experimental and opt-in**, gated behind a **typed** acknowledgement that the user's
   WhatsApp account can be permanently banned; it is **revocable** from the user's own phone; and
   **it runs on the user's own machine — never on Stewra's servers.** That last clause is
   load-bearing, not a slogan. Hosting the sessions ourselves would mean (a) holding live,
   unscoped WhatsApp credentials for every user, and (b) pairing N unrelated accounts from one
   datacenter IP — which is precisely the shape of a spam farm and makes *our* users likelier to
   be banned than if they'd self-hosted. We do not build detection evasion. iMessage remains a gap.

---

## 1. Scope of v1

### In scope (the "advisor" release)
- **Money:** connect bank/cards (read-only via aggregator). Surface spending patterns,
  upcoming low-balance warnings, unusual charges, subscription creep.
- **Time:** connect calendar (read-only). Surface conflicts, overcommitment, the
  *opportunity cost* of accepting things ("this invite is your only free evening this week,
  and you have a deadline Thursday").
- **The judgment layer** that ties the two together — the actual differentiator. Not
  "you spent $X" (every app does that) but "at this rate you'll be short before payday"
  and "saying yes here costs you the time you set aside for Y."
- **The transparency log** — plain-language record of everything read and every insight produced.
- **Web app** (primary surface, does the heavy lifting) + **thin iOS/Android apps**
  (display insights, push *your own* alerts, capture quick input, collect confirmations later).

### Explicitly NOT in scope for v1
- Any outbound action (no sending email, no moving money, no accepting invites). That's the *point*.
- WhatsApp / iMessage / any messaging surface without a sanctioned API.
- Multi-user / team / enterprise anything.
- A configuration UI for permissions.

### The deliberate sequencing (your trust ladder — build in this order, ship at Stage 1)
- **Stage 1 — Observe & advise (v1):** read-only, no actions. ~80% of the felt value, ~0 catastrophic risk.
- **Stage 2 — Propose reversible actions:** drafts a reply, proposes a calendar block, suggests a budget move — human taps yes. (Post-v1.)
- **Stage 3 — Autonomous low-stakes, per trusted user:** only after trust, only reversible, always logged. (Later.)
- Money/irreversible autonomy is the *last* thing, for the most trusting users, never a default.

---

## 2. Architecture (the shape that makes the promise true)

Two planes, kept physically separate. This is the whole security model.

```
┌─────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE  (deterministic, NOT promptable, the user's side) │
│  - Identity & per-user scopes                                    │
│  - Policy engine: is THIS action, by THIS user, allowed now?     │
│  - Credential vault: holds connection tokens; agent never sees   │
│    raw tokens                                                     │
│  - Confirmation gate: irreversible actions stop here (Stage 2+)  │
│  - Immutable audit log (append-only)                             │
└───────────────▲─────────────────────────────────┬───────────────┘
                │ "may I read calendar X?"         │ scoped result only
                │ (broker request)                 │ (never raw creds)
┌───────────────┴─────────────────────────────────▼───────────────┐
│  DATA PLANE  (the agent — untrusted, replaceable)                │
│  - LLM reasoning loop (the judgment layer)                       │
│  - Runs in an ephemeral sandbox, default-deny egress             │
│  - Asks the broker for every data read; gets back only what      │
│    policy allows                                                 │
│  - Produces insights + (later) PROPOSED actions — never executes │
└─────────────────────────────────────────────────────────────────┘
```

**Why this shape:** the agent holds no credentials, can reach no resource directly, and
cannot act. Even if it's prompt-injected by a malicious email it reads, the worst case is
"it produces a bad *suggestion*" — which a human sees and ignores — because it has no path
to execute anything. That containment is what lets you honestly say "safe to give this access to."

### Component responsibilities

| Component | Owns | Key rule |
|---|---|---|
| **Connection service** | OAuth flows to Google/Microsoft/aggregator; stores tokens in vault | Tokens never leave the vault; agent gets data, not keys |
| **Broker** | Every data request from the agent passes through here | Default-deny; returns only policy-permitted, minimized data |
| **Policy engine** | Per-user, per-action allow/deny decisions | Deterministic; agent cannot modify policy |
| **Agent runtime** | LLM loop, the judgment layer | Sandboxed, ephemeral, no egress except to the broker + model API |
| **Audit log** | Append-only record of reads + insights + (later) actions | Immutable; surfaced to user as plain-language activity feed |
| **Confirmation gate** | (Stage 2+) holds irreversible actions for human yes | Lives outside agent; agent cannot bypass or auto-approve |
| **Web app + mobile apps** | UI; consent prompts; alerts; confirmations | Sensitive data/tokens stay server-side, not on device |

---

## 3. Tech stack (suggested defaults — all standard, Claude-Code-friendly)

Pick what you're fastest in; these are sane defaults, not requirements.

- **Backend:** TypeScript (Node) or Python. One service to start — don't microservice prematurely.
  Keep the *planes* as clean module boundaries even inside a monolith.
- **Datastore:** Postgres (user data, insights, audit log). Audit log = append-only table,
  no UPDATE/DELETE grants for the app role.
- **Secrets/vault:** A real secret manager for connection tokens (cloud KMS / Vault / managed
  secrets). **Never** tokens in app DB rows in plaintext, never in logs.
- **Agent sandbox:** containerized, ephemeral per-run, **default-deny egress** with an allowlist
  of exactly: your broker + the model API endpoint. Nothing else. (For v1's read-only advisor
  this can be a hardened container; reach for microVM-grade isolation — gVisor/Firecracker-style —
  before you ever let the agent run untrusted code or go multi-tenant at scale.)
- **Model:** any capable model via API; keep it swappable behind one interface (don't hardcode a vendor).
- **Web app:** Next.js / React (or your preference).
- **Mobile:** React Native or Flutter for one codebase across iOS+Android. The mobile app is
  **thin** — it talks to your backend, displays insights, fires push notifications, and (later)
  shows confirmation prompts. It does NOT hold connection tokens or do account integrations on-device.
- **Integrations (v1):**
  - Google: Gmail API + Google Calendar API (OAuth, read-only scopes).
  - Microsoft Graph (mail + calendar) — add after Google works.
  - Banking: an aggregator (e.g. Plaid-class) — read-only transactions + balances. Budget for
    per-user cost; this is the one integration with real unit economics.

> **Before you build the banking piece, verify current aggregator coverage, pricing, and
> available scopes for your region — these change, and they drive your cost model.**

---

## 4. Build order — concrete tickets you can hand to Claude Code

Each milestone is shippable/testable on its own. Do them in order; don't skip ahead to actions.

### Milestone 0 — Skeleton & the two planes (1st)
- [ ] Repo, backend service, Postgres, auth (users can sign up / log in).
- [ ] Stub the **broker** interface and the **agent runtime** as separate modules with a hard
      boundary — even though there's little logic yet. Establishing the seam now is the whole game.
- [ ] Append-only **audit log** table + a write helper. Every later feature writes to it.
- [ ] Secret manager wired up; a vault read/write helper. No plaintext tokens anywhere.

### Milestone 1 — Calendar, read-only, end-to-end (prove the spine)
- [ ] Google OAuth, **read-only calendar scope**, plain-language consent screen
      ("Allow it to read your calendar? Yes/No" — not a scope list).
- [ ] Store the token in the vault; connection service can fetch events server-side.
- [ ] Agent requests events **through the broker** (not directly). Broker enforces
      "this user, read calendar, allowed" and returns minimized event data.
- [ ] First insight: detect calendar conflicts + "free evening" / overcommitment.
- [ ] Every read + every insight lands in the audit log and renders in a **plain-language
      activity feed** in the web app.
- [ ] **Test the containment:** confirm the agent module literally cannot fetch a token or
      hit Google directly — only via broker. This test is the product's core promise in code form.

### Milestone 2 — Money, read-only (the other half of the wedge)
- [ ] Aggregator integration: connect bank/cards, read-only, plain-language consent.
- [ ] Tokens to vault; transactions + balances fetched server-side, exposed to agent via broker.
- [ ] Insights: low-balance projection ("at this rate, short before payday"), unusual charge,
      subscription creep.
- [ ] Same audit-log + activity-feed treatment.

### Milestone 3 — The judgment layer (the actual differentiator)
- [ ] Cross-domain reasoning: combine money + time into *tradeoff* insights
      ("accepting this costs your only free evening AND you have a deadline Thursday";
      "this purchase pattern + this upcoming bill = tight before payday").
- [ ] Tune tone: honest about tradeoffs **without nagging**. An assistant that constantly
      scolds gets uninstalled. Warm, surfaced at the right moment, not a firehose.
- [ ] Frame money guidance as informational, not professional financial advice (and say so).

### Milestone 4 — Mobile apps (thin clients)
- [ ] React Native/Flutter app: log in, view insights, view the activity feed.
- [ ] **Your own** push notifications ("heads up — low balance trending", "calendar conflict
      tomorrow"). Note: these are alerts *you* generate from source data — you are NOT reading
      other apps' notifications (impossible on iOS, fragile on Android, and not needed since you
      have the source data directly).
- [ ] Quick input capture (voice/text) that routes to the backend.

### Milestone 5 — Trust & control surfaces (what makes risk-averse users relax)
- [ ] **One-tap disconnect** for any connection, plus a clear statement that they can also
      revoke from their Google/bank settings independently of your app (escape hatch they control).
- [ ] **Global pause** ("stop everything") — instant, obvious.
- [ ] Onboarding that's useful at **one** connection (solves cold-start: don't demand all
      accounts on day one; be valuable with just the calendar, earn the next connection).

### --- v1 ships here. Everything below is the trust ladder, post-launch. ---

### Milestone 6 — Stage 2: propose reversible actions (only after v1 trust)
- [ ] Agent can *draft* (a reply, a calendar block, a budget tweak) but **execute nothing**.
- [ ] **Confirmation gate**, enforced outside the agent: the action sits pending until the
      human taps yes in the app. Build this so the agent has no code path to self-approve.
- [ ] Audit log records proposed → approved/rejected → executed.

### Milestone 7+ — Stage 3: gradual, gated autonomy
- [ ] Per-user opt-in, low-stakes + reversible only, always logged, hard caps.
- [ ] Money/irreversible autonomy is last, opt-in, heavily gated, for the most trusting users.

---

## 5. Security checklist (Claude Code should enforce these as it builds)

- [ ] Agent runtime has **no credentials** and **no direct network egress** except broker + model API.
- [ ] Every resource access goes **through the broker**; default-deny; data minimized to the task.
- [ ] Connection tokens live **only** in the vault; never in app DB plaintext, never in logs,
      never sent to the device.
- [ ] Policy decisions are **deterministic code**, not model output. Agent cannot read or write policy.
- [ ] Audit log is **append-only** (DB role lacks UPDATE/DELETE on it).
- [ ] (Stage 2+) Confirmation gate is **outside** the agent; no self-approval path exists.
- [ ] Per-user scopes; one user's data/agent run can never reach another's (matters more as you scale —
      that's when you move from container to microVM-grade isolation).
- [ ] Treat **all** fetched content (emails, transaction memos) as **untrusted input** — it can carry
      prompt injection. The architecture already contains the damage (agent can't act), but never let
      fetched text be treated as instructions.
- [ ] Plain-language consent per connection; no raw scope lists shown to users.
- [ ] Secrets out of the repo; `.env` patterns; rotateable keys.

---

## 6. The traps to avoid (learned the hard way by others)

- **Don't lead with autonomy.** OpenClaw already has capability; your edge is *trust*. Shipping
  "it does everything for you" on day one reintroduces exactly the fear that's your opportunity.
  One wrong autonomous action = uninstall. Wrong *advice* = "hmm, not quite." Advise first.
- **Don't host the gray market.** WhatsApp-Web/Baileys-style automation violates ToS and can get
  *your users* banned. The sanctioned Cloud API is the default path. If a companion-device channel
  ever ships, it ships under principle 7: experimental, opt-in, typed-consent-gated, and running on
  the **user's own machine** — so the ban risk is theirs to accept and their credentials never touch
  our infrastructure. Never run it on our servers, and never build evasion. (Re-check the EU DMA
  interoperability situation yearly — it *may* open a sanctioned path eventually.)
- **Don't build a permission UI.** The moment safety looks like config, you lose the common-man user.
  Safe-by-default, one plain decision at a time.
- **Don't read other apps' notifications.** Impossible on iOS, fragile on Android, unnecessary —
  you have the *source* data (the bank API, the calendar API) which is cleaner than any notification.
- **Don't nag.** The judgment layer must be welcome counsel, not a guilt machine.
- **Don't store sensitive data on the device.** Heavy lifting + tokens stay server-side.
- **Don't over-engineer infra before validating the wedge.** Monolith with clean plane boundaries
  beats premature microVMs/microservices for a read-only advisor. Add isolation strength as you add
  the ability to act and as you scale tenants.

---

## 7. What to verify before/while building (things that drift)

- Current banking-aggregator coverage, **per-user pricing**, and read-only scopes for your region
  (drives your unit economics).
- Google / Microsoft current OAuth scope names and verification requirements for mail/calendar read.
- iOS & Android current rules for background processing and push you'll rely on for alerts.
- Whether any sanctioned WhatsApp interoperability path has opened (DMA) — only if/when it does
  is it back on the table.

---

## 8. First thing to tell Claude Code

> "Set up Milestone 0 and Milestone 1 from this plan: a backend with user auth, an append-only
> audit log, a secret vault helper, and — critically — a **broker** module and an **agent runtime**
> module with a hard boundary between them, where the agent can only access data by asking the
> broker and never holds credentials or hits external APIs directly. Then implement read-only Google
> Calendar: OAuth with a plain-language consent screen, token stored in the vault, events fetched
> server-side, exposed to the agent only through the broker, producing a 'calendar conflict / free
> evening' insight that's written to the audit log and shown in a plain-language activity feed.
> Include a test proving the agent module cannot fetch the token or reach Google directly."

That single ticket builds and *proves* the trust architecture end-to-end on the smallest possible
surface. Everything after it is repetition of the same safe pattern across more data sources and,
eventually, carefully-gated actions.
