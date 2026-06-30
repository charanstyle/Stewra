# Stewra — Memory & Learning Design

> **Companion to `build-plan.md`.** This spec defines how Stewra remembers things and
> learns about the user over time, in a way that makes memory a **trust feature**, not a
> trust liability.
>
> **The one principle that governs everything here:** *Memory is the user's, not the
> agent's.* The agent may read a small, scoped slice when it needs it. It never owns the
> store, never writes silently, and never decides on its own what to keep. The model
> receives only the minimum slice required for the task at hand; raw data never goes to
> the model at all.

---

## 0. What we deliberately copy — and don't — from OpenClaw / Hermes

Hermes Agent's headline feature is a "closed learning loop": the agent curates its own
memory, creates skills from experience, summarizes/searches past sessions, and builds a
deepening model of the user. OpenClaw has a simpler version (MEMORY.md / USER.md files in
the agent workspace). In both, memory lives where the agent runs and the **agent has broad,
self-directed control over its own memory**.

- **What we take:** the *value* — learning about the user across sessions so advice gets
  sharper over time; compressed episodic summaries for recall.
- **What we deliberately reject:** **agent-owned, self-curating, agent-resident memory.**
  For a trust-first product, an agent that silently decides what to remember about you,
  with you as a bystander, is exactly the dynamic that scares mass-market users. We invert
  it: the user owns the memory; the agent borrows a slice.

---

## 1. Memory tiers (separate by sensitivity — never one blob)

| Tier | Examples | Where it lives | Goes to the model? |
|---|---|---|---|
| **Raw data** | Individual transactions, calendar events, email bodies | Vault / encrypted store, server-side | **Never wholesale.** Agent works on derived facts, not raw records |
| **Derived facts / profile** | "Tends to overspend on weekends", "protects Thursday evenings", "rent hits on the 1st", "freelance income is irregular" | Encrypted store; **fully visible + editable by user** | Only the *relevant* few facts, selected per task |
| **Episodic summaries** | Compressed "what happened / what was advised" per session | Encrypted store; user-visible | Only when relevant to recall, minimized |

The **derived facts tier is the product's intelligence over time** — it's what makes
Stewra's advice get better. It is also the tier the user most needs to see and control.

---

## 2. The model sees the minimum, assembled per request (never a memory dump)

This is the "share only what the model needs" guarantee, and it's the **same brokered-access
principle from the build plan, applied to memory**. The selection of what to share is done by
**deterministic code in the control plane**, not by the model asking for whatever it wants.

```
Task arrives: "Should I flag this invite?"
        │
        ▼
[Control-plane retrieval step]  ← deterministic code, NOT the model
  - pulls ONLY the handful of derived facts relevant to THIS task
  - (e.g. "protects Thursday evenings", "deadline Thursday")
  - minimizes / redacts; never includes raw records
        │
        ▼
[Model prompt for this one turn]
  - gets those few sentences of context, nothing else
        │
        ▼
[Insight / proposed action out]
```

Why this matters three ways:
- **Privacy:** the model never receives a dump of the user's memory — just a task-scoped slice.
- **Cost/quality:** smaller, sharper context = better answers and cheaper model calls.
- **Control:** because *code* selects the slice, the user's policy (and the agent's
  non-trusted status) is enforced; the model can't request arbitrary memory.

> Implementation note: this retrieval-and-minimization step is just the **broker** doing for
> memory what it already does for raw data in the build plan — returning the permitted, minimal
> slice. Reuse that boundary; don't build a second access path.

---

## 3. Writes are proposed, not silent

Where Hermes lets the agent autonomously curate memory, Stewra makes memory writes
**visible and user-governed**:

- **Default (v1):** deterministic code extracts derived facts from data; the **model never
  writes to memory silently.** Predictable, auditable, safest for trust.
- **Model-proposed memories (allowed, but visible):** the agent may *propose* a memory
  — "Want me to remember that you protect Thursday evenings?" — surfaced to the user, never
  written silently.
- **Low-sensitivity derived facts** may auto-save **with full visibility** in the Memory
  screen (see §5), where the user can edit or delete them at any time.
- The user is **never surprised** by what Stewra knows.

> Start at the deterministic end. The model may *propose* user-visible memories only; it
> never writes silently. You can loosen this later — you cannot un-leak trust.

---

## 4. On-device vs cloud — the honest decision

The felt promise people want is "my memory is mine." The architecture (server-side broker +
server-side agent + server-side integrations) means the working memory the agent queries
**must be reachable server-side**. So pure on-device-only memory fights the architecture.
The strong, honest version:

**Store sensitive memory in the cloud, encrypted, and user-controlled — with an on-device
view for the felt control.**

- **Working copy:** encrypted, server-side, tied to the user, reachable by the broker so the
  agent can query the minimal slice. Not casually readable; never in logs in plaintext.
- **On-device role:** the thin mobile app **caches the user-facing Memory view** for display
  and lets the user edit/delete locally, syncing changes up. The user *experiences* their
  memory as living on their phone, even though the agent's working copy is in the encrypted cloud.
- **The trust promise that actually holds up** is NOT "it's on your phone" (it can't fully be).
  It is: **"It's yours — you can see all of it, edit it, export it, and delete it instantly;
  we share only the minimum slice with the AI per task; and your raw data never goes to the AI at all."**
- **Advanced (v2+, do not promise yet):** end-to-end encryption where even Stewra can't read
  the memory. Hard to reconcile with a server-side agent that must read it to function. Treat
  as a research problem, not a v1 claim.

---

## 5. User control surfaces (the "fully in control" part, made concrete)

These are the features that turn memory from a fear into a selling point. Most products hide
this; Stewra makes it visible and yours.

- [ ] **Memory screen** — plain-language list of everything Stewra has learned about the user,
      each item individually **editable and deletable**. ("Things I've learned about you.")
- [ ] **Per-item delete + global "delete everything"** — **real deletion** that propagates to
      the store (not soft-delete/hidden).
- [ ] **Export everything** — full, portable export of their data and memory (portability is
      itself a trust signal).
- [ ] **Transparency statement, surfaced in-product** — what's stored, what's shared with the
      AI per task (the minimum), and what never leaves the store (raw data).
- [ ] **Forget-on-disconnect** — when the user disconnects a source (bank/calendar), offer to
      **purge the derived memory built from it.**
- [ ] Every memory read/write also lands in the existing **audit/activity log** (build plan
      Milestone 0) so it shows in the plain-language activity feed.

---

## 6. How this slots into the existing build plan

No restructuring — memory obeys the same rules as the rest of the system:

| This spec | Maps onto build-plan |
|---|---|
| Retrieval + minimization step (§2) | The **broker** selecting the permitted minimal slice |
| Encrypted memory store (§4) | The datastore / vault from build-plan §3 |
| Memory screen, delete, export, forget-on-disconnect (§5) | **Milestone 5** trust surfaces (next to disconnect + pause) |
| Memory reads/writes logged (§5) | The append-only **audit log** from Milestone 0 |
| Deterministic extraction, model-proposed-only writes (§3) | The "model is never a trusted enforcement point" principle |

**Build order suggestion:**
1. Add the **derived-facts store** (encrypted) + extraction from already-connected data
   (calendar first, then money), once Milestones 1–2 exist.
2. Add the **brokered retrieval/minimization** step feeding the model (extends the broker).
3. Add the **Memory screen + delete + export** (Milestone 5).
4. Add **episodic summaries** + recall.
5. Add **model-proposed memories** (visible, never silent) — last, once the visible store is trusted.

---

## 7. The one decision to make early (it shapes the schema)

**How much should the model influence what gets remembered?**

- **Deterministic end (recommended start):** code extracts derived facts; the model never
  touches memory writes. Safest, most predictable, best for trust.
- **Hermes-like end:** the model proposes memories freely. Richer "learning," but more surface
  area and less predictability.

For Stewra: **start deterministic; let the model *propose* user-visible memories only, never
write silently.** Loosen later if warranted. This keeps memory a trust asset from day one.

---

## 8. One-paragraph summary to hand Claude Code

> Build memory as a **user-owned, tiered, encrypted store** that the agent can only read from
> through the broker, one minimal task-scoped slice at a time. Raw data (transactions, events,
> emails) never goes to the model — the agent reasons over **derived facts** ("protects Thursday
> evenings", "tight before payday") extracted by deterministic code. The model may **propose**
> new memories but **never writes silently**. Provide a plain-language **Memory screen** where
> the user sees, edits, and deletes everything Stewra knows, plus **export** and
> **forget-on-disconnect**. Store the working copy encrypted in the cloud (reachable by the
> server-side agent) and **cache a user-facing view on the device** so it feels like the user's
> own. Every memory access is written to the existing audit log. Reuse the existing broker and
> vault — do not build a second access path.
