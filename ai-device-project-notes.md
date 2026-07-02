# AI Device Project — Working Notes

*A dedicated handheld terminal for **Stewra** — a cloud AI-agent backend.*

---

## 1. The Vision (as it evolved)

The idea started as "a handheld device whose sole function is to run AI" and sharpened, through discussion, into something much more specific and defensible:

**A purpose-built physical device that acts as the front door to Stewra — a personal AI-agent backend in the cloud — where all your accounts, integrations, and memory live — so the AI can do what a phone does (and more) without living inside Apple's or Google's ecosystem.**

The device is a thin, stateless terminal. The intelligence, credentials, and memory live in Stewra (the backend). Lose the device, get another, log in — everything is still there because nothing important was ever on the device.

### The core strategic question the product must answer
> **What does someone do on this that they wouldn't just pull out their phone for?**

The two strongest answers:
- **Off-grid capability** — tiered WiFi / LTE / satellite connectivity a phone-app competitor can't easily match.
- **Focus** — a single-purpose, no-feed, no-notification, no-app-switching device.

The differentiator is **NOT** "escapes Apple and Google" (users don't feel that pain enough to give up their apps). It is **"the AI does the jobs so well you don't miss the apps."**

---

## 2. Architecture (the key decision)

Move the hard part off the device and into Stewra (the backend).

```
[ Device: thin terminal ]
   capture voice/text  →  render response
            |
            |  one endpoint
            v
[ Stewra — Cloud Backend — the real "user" ]
   • Integration layer  (APIs where they exist; sanctioned access where they don't)
   • Memory layer       (who you are, preferences, history, context)
   • Orchestration layer(the agent: turns "get me home" into a sequence of calls)
   • Identity/auth vault (all logins, encrypted, isolated)
```

Why this is the right call:
- Device stays cheap, simple, replaceable — **no secrets worth stealing on it.**
- Integrations maintained in ONE place, not shipped to firmware.
- Memory/context centralized, so the assistant actually knows you across everything.

---

## 3. Build Stewra on an existing backend pattern: OpenClaw

**Stewra** is the name for our backend — the product we're building. It is built *on* OpenClaw (the existing open-source framework below), not from scratch. What we planned to build largely **already exists** as open-source software — this de-risks the thesis and means Stewra is mostly a *build-on*, not a *build-from-scratch*.

**OpenClaw** (MIT-licensed, commercially usable; most-adopted self-hosted agent framework, 380k+ GitHub stars as of mid-2026; creator joined OpenAI to lead personal-agents, project now an independent foundation with OpenAI backing) provides:
- 23+ messaging channel adapters (WhatsApp, Telegram, Signal, iMessage, WeChat, Slack, etc.)
- A skills registry (ClawHub, 700+ integrations: Gmail, Spotify, calendar, GitHub…)
- Persistent memory across sessions
- A heartbeat scheduler (agent wakes ~every 30 min for briefings / monitoring)
- Browser control to drive sites that have no API
- Model-agnostic orchestration

**What this means:** the four-layer backend Stewra needs is already implemented and battle-tested by OpenClaw. The thing that does **NOT** yet exist — and is therefore the actual product — is a **clean, dedicated hardware terminal purpose-built for a backend like Stewra.** Today OpenClaw is accessed by messaging your own agent or via phone/Mac companion apps. **The white space is the device.**

### How Stewra cracks the two hardest walls
- **Messaging wall:** channel adapters act as a *client* (e.g. Baileys for WhatsApp), sidestepping the "no personal API" problem that killed every independent phone OS.
- **No-API-app wall:** browser automation navigates sites and fills forms like a human.

Both are imperfect (ToS grey areas; browser automation is fragile) but they are a *working* answer where there previously was none.

---

## 4. The App-Replacement Map (the 10 categories)

An app is just a delivery mechanism for a *job*. The agent has to do the job, not the app. Feasibility verdicts as of 2026:

| # | Category | Dominant apps (worldwide) | Agent-feasibility |
|---|----------|---------------------------|-------------------|
| 1 | Messaging | WhatsApp, Messenger, Telegram, WeChat, iMessage, Signal | **RED** — hardest. Walled gardens, no personal APIs. #1 phone job. Channel adapters help but are grey-area. |
| 2 | Social media | Facebook, Instagram, TikTok, X, Snapchat, YouTube | Mostly not agent-replaceable *and you don't want to* — keep as web views. |
| 3 | AI assistant | ChatGPT (#1 app worldwide), Gemini, Claude | **This IS your device.** Free win. |
| 4 | Navigation / maps | Google Maps, Waze, Apple Maps | **GREEN** — mature APIs. One of your best. |
| 5 | Payments / banking | PayPal, Venmo, Cash App, Alipay/WeChat Pay, bank apps | **PARTIAL + special rules** (see §5). Hardest to earn trust on. |
| 6 | Ride-hailing / delivery | Uber, Lyft, DoorDash, Grab, Didi, Bolt | **GREEN** — flagship agent use case. Prioritize. |
| 7 | Email | Gmail, Outlook, Apple Mail | **GREEN** — open protocols (IMAP/SMTP), AI triage already excellent. |
| 8 | Web / search / browser | Chrome, Safari, Google Search | **GREEN** — native + agentic browser. |
| 9 | Media / entertainment | YouTube, Spotify, Netflix | **PARTIAL** — Spotify playback API works; video needs their apps/DRM. |
| 10 | Commerce / shopping | Amazon, Temu, Taobao | **PARTIAL-to-YES** — simple orders via API/agentic checkout. |

### The strategy that falls out
- **GREEN (launch capabilities):** AI assistant, maps, email, web/search, ride-hailing. Genuinely useful "get something done" jobs. This is a real device on its own.
- **YELLOW (ship what works, web-view the rest):** payments (read-only), media, shopping.
- **RED (walls, not yet):** messaging, social.

**Reframe:** don't fight to replace the app people love (WhatsApp). Win the jobs where apps are friction and an agent is faster. Messaging becomes a pragmatic compatibility layer, not the thing you must beat.

---

## 5. The Banking Firewall (non-negotiable)

**No channel adapters / browser automation / stored credentials for banking. Ever.**

Why it's disqualifying:
1. **Illegal / breaks contract** — automating bank logins violates ToS and computer-fraud statutes. Bank bans = fraud liability + frozen funds, not just a lost account.
2. **Liability shifts to you** — holding credentials and moving money makes you an unlicensed money-services operation (money-transmitter licensing, KYC/AML). If the AI errs, the loss is real money and it's on you.
3. **Maximum blast radius** — bank credentials in Stewra (your one backend) = the highest-value hack target imaginable. One breach empties accounts.

### The sanctioned path
Core principle: **never hold credentials or move money yourself — delegate to a licensed intermediary via tokenized, revocable, read-scoped access.**

- **Open Banking / bank APIs** — regulated token-based access (EU/UK: PSD2 → PSD3/FIDA; US: aggregator-driven). OAuth-style tokens, not passwords, scoped to user consent.
- **Aggregators as intermediary** — Plaid, Yodlee/Envestnet, Tink, TrueLayer, MX. They hold the regulatory + security burden; you get a clean API + token. (Note: production access usually requires being a registered entity with a real security posture, signed agreements, sometimes review — this is a "form the company, do it properly" piece, not a weekend hack.)
- **Split read vs. write hard:**
  - **Read-only (safe, high-value 80%):** balances, "did my paycheck land," spending summaries. Do this via aggregator tokens.
  - **Money movement (heavy regime):** either don't do it at first, or route through a licensed payment provider where the user authenticates *directly with their bank* per transaction and Stewra never sees a credential.
- **In-store NFC tap-to-pay:** don't. Locked to Apple/Google secure elements + hardware certification. Leave to phone/card.

### The bright line in the integration layer
- **Green rail** (client adapters / browser automation acceptable): email, maps, rides, search, media, messaging channels — low-stakes, reversible.
- **Red rail** (sanctioned APIs only, tokenized, mostly read-only, never store credentials, ideally isolated infrastructure): anything financial. Consent + authentication go **direct to the bank/aggregator**; Stewra receives only a revocable token.

Product framing: *"Your AI can see all your finances in one place and answer any question about your money"* (safe, read-only) — NOT *"your AI logs into your bank and moves money"* (lawsuit + breach headline).

---

## 6. Hardware Spec (the device)

Two levels — start at Level 1. **There is no custom chip involved; everything is off-the-shelf silicon.** Fabricating an actual chip = a foundry (TSMC/Samsung/etc.), millions in NRE, 12–18 months, huge MOQs — wrong tool, ignore it.

### Level 1 — Prototype (start here)
No fabrication. Assemble off-the-shelf boards on a desk.

| Part | Pick | Notes |
|------|------|-------|
| Compute | Raspberry Pi 5 (4GB) | Thin client — plenty of power. |
| Display | Official 5" DSI touch display (or Waveshare 4.3"/5" DSI capacitive) | DSI ribbon > HDMI for handheld. Capacitive (finger), not resistive. Touchscreen = the text-input surface via on-screen keyboard. |
| Mic | USB mic (prototype) → INMP441 I2S MEMS (embedded) | Push-to-talk paired with a momentary GPIO button. |
| Input button | Momentary GPIO button | Hold-to-talk → record while pressed → transcribe on release. |
| Connectivity | Built-in WiFi + LTE HAT (Sixfab / Waveshare SIM7600 or Quectel-based) | See §7 for the tiered stack. |
| Power | LiPo + UPS/power HAT | Budget extra battery for satellite mode (higher TX power). |
| Speaker (optional) | MAX98357A I2S amp + small speaker | Only if adding spoken replies (TTS). |

### Level 2 — Custom PCB (a real integrated product, later)
You fab a **board**, not a chip, using existing chips on it. Send Gerbers + BOM to a PCB assembly house: **JLCPCB, PCBWay, MacroFab (US), Seeed Studio.** A few hundred to a few thousand dollars for a small run. Build it around a **Raspberry Pi Compute Module 5** (or a Qualcomm SoM if you want integrated cellular + NPU).

### UI design tension to solve
Screen real estate on a 4–5" panel: the on-screen keyboard eats ~half the height. Design the chat view to collapse gracefully — keyboard up = compact log + input; keyboard down = full-height conversation. Get this right and the small screen feels intentional, not cramped.

---

## 7. Connectivity: Tiered WiFi / LTE / Satellite

The three options collapse into one automatic tiered stack (managed by `NetworkManager` + `ModemManager`):

1. **WiFi** (built-in) — when available; free, fastest. Includes phone tethering.
2. **LTE** via cellular modem + data SIM — everyday mobile coverage.
3. **Satellite (direct-to-cell)** — automatic fallback beyond towers, via the *same* LTE modem on a supporting carrier.

### Key facts about direct-to-cell (mid-2026)
- T-Mobile/Starlink "T-Satellite" is live: SMS/location since mid-2025; limited app-based data (WhatsApp, Maps, weather) since ~Oct 2025; voice + broader data rolling out through 2026.
- Each satellite carries an **LTE eNodeB** and presents as a **standard LTE signal** — **no special hardware, app, or SIM** on compatible **3GPP Release 10+ LTE** phones/modems. You don't build "Starlink support"; you put in an LTE modem on a direct-to-cell carrier and satellite is an invisible extra layer.
- **Starlink dish = NOT handheld** (40–100W, needs Dishy). "Starlink for a handheld" means "LTE modem on a direct-to-cell carrier," not a dish.

### Critical architecture consequence for voice
Direct-to-cell data is **low-bandwidth, high-latency** — tuned for text-sized payloads. Text chat is near-ideal. **Cloud voice-to-text over satellite will be rough** (raw audio is heavy). → **Run STT locally** (`whisper.cpp`) so only the tiny transcript + reply cross the satellite link. This single decision makes the device actually usable off-grid.

### Flags to confirm
- Satellite TX draws more power than tower connection — size the battery for it.
- T-Satellite is oriented around phones/eSIM + carrier plans; SIM/plan eligibility for a **DIY LTE-module device** (vs a certified handset) can be fuzzy — **confirm before committing hardware.**

---

## 8. Software Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| OS | Raspberry Pi OS (Lite for kiosk / Desktop for windowed) | Debian ARM. Boot straight into the app in kiosk mode for an appliance feel. |
| Connectivity mgr | `NetworkManager` + `ModemManager` | Auto WiFi↔LTE tiering; satellite invisible at this layer. |
| Voice-to-text | **`whisper.cpp`** (base/small model), local | Runs near-real-time on Pi 5. **Keeps voice working off-grid** — no audio leaves the device, only transcript goes to Stewra. Audio capture via `sounddevice`/ALSA. |
| AI brain | Stewra (cloud backend, built on OpenClaw) via Anthropic Messages API `/v1/messages` | Stateless API: send history + new message, **stream** the response token-by-token (matters over LTE/satellite). |
| UI | Fullscreen local web app in kiosk-mode Chromium (Flask/FastAPI + HTML/JS) | Best chat UI + on-screen keyboard for least effort. Native LVGL alt for product-grade embedded feel later. |
| TTS (optional) | **Piper** (local neural TTS) | Natural, runs on Pi, keeps round-trip local like whisper.cpp. |

### The three input paths converge on one chat view
1. **Type** — tap field → on-screen keyboard → send.
2. **Speak** — hold push-to-talk → talk → release → `whisper.cpp` transcribes → text into field (edit or auto-send).
3. **See** — streamed reply renders token-by-token in the chat log.

Flow: button → `sounddevice` records → `whisper.cpp` transcribes locally → transcript appended to history → streaming request to Stewra over active network → tokens stream back → render → (optional) Piper speaks.

Everything above is free/open-source except the cloud API calls. **The whole software stack can run on a plain Pi 5 on your desk (no LTE, no custom board) to validate the experience first.**

---

## 9. The Competitive Landscape (mid-2026)

- **Rabbit R1** — closest existing match: 2.88" touchscreen, push-to-talk, 4G LTE, all-day battery. Its lesson: hardware wasn't the problem — the "Large Action Model replaces apps" reliability was, and "why not just use my phone" was unanswered. **Worth buying one to feel what works.**
- **OpenAI / Jony Ive (io) device** — big-money entrant, leans **screenless**, reportedly won't ship before **Feb 2027**, wrestling personality/privacy/compute. Your screen-first bet *diverges* from where they're betting.
- **Razer AVA** — desktop hologram tethered to Windows PC. Not handheld.
- **Wearables** (Plaud NotePin, Bee, Omi, Limitless) — went screenless/voice-only, mostly recording/transcription.
- **Smart glasses** (Ray-Ban Meta, etc.) — fastest-growing, deliberately display-free.

**The pattern:** almost everyone with money is *fleeing the screen* (glasses, pendants, pins). Going the other way — a small screen you can **text on and read from** — is a real, defensible differentiation for people who want to read/type rather than talk in public or wear a camera.

---

## 10. The Three Walls (honest risks)

1. **Apps / ecosystem** — killer of every phone-replacement predecessor. The AI-agent-replaces-apps bet is the only credible way through, and it's newly plausible in 2026 but still unproven at daily-driver reliability.
2. **Cellular certification** — real calls on carrier networks need FCC certification + carrier approval. Expensive, slow, non-negotiable. (Big reason hobbyist phones stay hobbyist.)
3. **Trust for critical functions** — 911, banking, 2FA. High bar for a small player. **Security is the entire product's survival, not a feature** — Stewra concentrates all accounts + memory + credentials in one backend, i.e. the highest-value hack target imaginable. (Cf. OpenClaw called "a security nightmare"; a related platform leaked its whole backend via a DB misconfig days after launch.)

---

## 11. Recommended Next Steps

**Prove the thesis before spending on hardware.** The thing to prototype first is the *agent*, not the device.

1. **Stand up Stewra** — an OpenClaw-based backend on a cheap VPS. Wire in a few GREEN integrations (email + maps + one messaging channel). Point a phone/laptop at it. Feel whether it does what you want.
2. **Validate the agent** — can it reliably do the top GREEN jobs (ride, navigate, triage inbox, search, remind) driving real APIs/web sessions? If yes on a plain phone/laptop, you have a product. If not, no hardware saves it.
3. **Design the security / consent model** — device→Stewra auth; contain the "all credentials in one place" risk (per-integration scoping, on-device confirmation for sensitive actions, blast-radius limits); build the **green-rail / red-rail banking firewall in from the start** (§5).
4. **Then** build the terminal — run the full software stack (§8) on a desk Pi 5, then add LTE + custom board (Level 2).

### Open decisions to make
- [ ] Local STT (`whisper.cpp`) confirmed as default (needed for off-grid voice)?
- [ ] Which GREEN integrations for the first Stewra prototype?
- [ ] Carrier + SIM/plan eligibility for a DIY LTE module (confirm before hardware).
- [ ] Entity formation timing (needed for banking aggregator production access).
- [ ] Security architecture owner / review before any credential touches Stewra.

---

*Notes compiled from project discussion. Facts about products, apps, and satellite/agent platforms reflect mid-2026 sources and should be re-verified as the space moves fast.*
