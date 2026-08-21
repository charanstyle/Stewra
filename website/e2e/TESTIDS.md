# Website E2E `data-testid` registry

Canonical contract between `website/src/**` components and `website/e2e/tests/**` specs.
Every `data-testid` used by a Playwright spec MUST be listed here, and every id listed here
MUST exist in the component it names. If you rename or remove one, update both sides in the
same change (mirrors the intent of the Maestro suite's testID discipline on mobile).

| `data-testid` | Component | Element | Marks |
| --- | --- | --- | --- |
| `app-nav` | `src/components/AppNav/AppNav.tsx` | `<header className={styles.nav}>` | Sentinel present on every authenticated page. Specs probe it via `uiHasTestids(page)` to detect whether the running build carries this testid contract; if absent (e.g. prod not yet redeployed), testid-dependent specs `test.skip(...)` with a "deploy website first" message instead of timing out on a missing selector. |
| `presence-dot` | `src/app/chats/ChatsPage.tsx` | `<span className={styles.onlineDot}>` inside a chats-list row's avatar | The small online-presence dot shown on a conversation row when that 1:1 peer is currently connected. Replaces the old `[class*="onlineDot"]` substring selector. |
| `unread-badge` | `src/app/chats/ChatsPage.tsx` | `<span className={styles.unread}>` inside a chats-list row | The unread-count badge on a conversation row. Replaces the old `[class*="unread"]` substring selector. |
| `stewra-turn` | `src/app/stewra/StewraPage.tsx` (`Turn` component) | `<div className={styles.stewraTurn}>` | One assistant (Stewra) turn in the `/stewra` thread. Replaces the old `[class*="stewraTurn"]` substring selector. |
| `stewra-user-turn` | `src/app/stewra/StewraPage.tsx` (`Turn` component) | `<div className={styles.userTurn}>` | One user turn (typed or transcribed voice) in the `/stewra` thread. Replaces the old `[class*="userTurn"]` substring selector. |
| `message-timestamp` | `src/app/chats/ConversationPage.tsx` (`MessageBubble` component) | `<span className={styles.bubbleTime}>` inside a message bubble | The per-message timestamp (+ read/delivery indicator for own messages) in a 1:1 conversation. Info-only in specs — presence is logged, never asserted as a hard failure, matching the original check's diagnostic intent. Replaces the old `[class*="time"], [class*="stamp"]` substring selector. |
| `runner-session-card` | `src/components/chat/ProposedRunnerSessionCard.tsx` | the card root `<div>` | The in-chat "Run coding agent" confirmation card Stewra renders when it proposes a runner session. Also carries `data-status` (`pending`/`sent`/`cancelled`/`failed`) so a spec can assert the lifecycle transition without scraping button labels. Its presence gates the runner spec: absent = no runner online / not proposed, so the spec `test.skip(...)`s. |
| `runner-session-start` | `src/components/chat/ProposedRunnerSessionCard.tsx` | the primary `<button>` | Start (or, after a failed start, "Try again"). Clicking it calls the confirm-gated `POST /messages/:id/confirm-runner-session` — the trusted executor; Stewra can never start a session itself. |
| `runner-session-cancel` | `src/components/chat/ProposedRunnerSessionCard.tsx` | the secondary `<button>` | Cancel (or, after a failed start, "Dismiss") the proposal. |
| `runner-session-busy` | `src/components/chat/ProposedRunnerSessionCard.tsx` | the "Starting…" `<span>` | Shown while a confirm request for this proposal is in flight (both buttons removed). Lets a spec wait out the round-trip. |
| `runner-session-status` | `src/components/chat/ProposedRunnerSessionCard.tsx` | the terminal-status `<p>` | The collapsed status line for a resolved (`sent`/`cancelled`) proposal, e.g. "Started on <machine>". |
| `settings-delete-account` | `src/app/settings/SettingsPage.tsx` | the "Delete account" `<button>` in Danger zone | Opens the deletion sheet. Deletes nothing by itself — it fetches the server's preview first, so a spec asserts on the sheet, not on a signed-out app. Mirrors the mobile id of the same name. |
| `delete-account-password` | `src/app/settings/SettingsPage.tsx` | the password `<input>` inside the sheet | Password re-entry. Rendered only when the preview reports no blockers, so its appearance doubles as "the preview arrived and this account may proceed". |
| `register-account-kind` | `src/app/login/LoginPage.tsx` | the Individual / Business `<div role="radiogroup">` | Shown only in "Create account" mode. The Amazon-seller question: which kind of account is being made. `Individual` is preselected; every signup sends the choice explicitly. |
| `register-kind-individual` / `register-kind-business` | `src/app/login/LoginPage.tsx` | the two `<button role="radio">`s | Pick the account kind. Choosing Business reveals `register-company-name`. |
| `register-company-name` | `src/app/login/LoginPage.tsx` | the company-name `<input>` | Rendered only for Business. Its presence is the assertion that the kind control worked. |
| `org-convert` | `src/app/commerce/CommercePage.tsx` | the convert row inside "Organizations" | Rendered only when the selected org is the caller's `individual` org and they own it. Absent for a business org — so asserting its absence after conversion is the proof the kind flipped. |
| `org-convert-name` / `org-convert-submit` | `src/app/commerce/CommercePage.tsx` | the company-name `<input>` and "Convert to a business organization" `<button>` | One-way. After it, the org accepts invites and `org-convert` disappears. |
| `fleet-org-select` | `src/app/fleet/FleetPage.tsx` | the organization `<select>` | Which org the fleet page shows. Its value is the `orgId` every call on the page is scoped by; `tests/fleet.spec.ts` reads it to clean up in the same tenant. |
| `fleet-pair` / `fleet-pair-code` | `src/app/fleet/FleetPage.tsx` | the "Pair a machine" `<button>`; the code block it reveals | Mints an org pairing code. The block names the org the machine will join. |
| `fleet-device-row` / `fleet-device-environment` / `fleet-device-rescan` | `src/app/fleet/FleetPage.tsx` | one machine `<li>`; its development/production `<select>`; its Rescan `<button>` | The machines list. Rescan asks the runner to re-read its workspace roots — the unmount/remount path — and is disabled while the machine is offline. |
| `fleet-project-create` / `fleet-project-form` / `fleet-project-name` / `fleet-project-repo` / `fleet-project-aliases` / `fleet-project-save` | `src/app/fleet/FleetPage.tsx`, `src/app/fleet/ProjectForm.tsx` | the "New project" `<button>`; the inline form and its inputs/save | Create or edit a project. The name is typed, never derived. |
| `fleet-matrix` / `fleet-project-row` / `fleet-cell` | `src/app/fleet/FleetMatrix.tsx` | the `<table>`; one project `<tr>` (also carries `data-project-name`); one project × machine cell `<div>` | The cell carries `data-state` ∈ `ready` / `stale` / `offline` / `unbound` — the four states, never resolved by substitution. A spec asserts the attribute, not button labels. |
| `fleet-run-here` / `fleet-run-project` / `fleet-bind` / `fleet-rescan` | `src/app/fleet/FleetMatrix.tsx` | the per-cell / per-row action `<button>`s | `fleet-run-here` exists only in a `ready` cell, `fleet-rescan` only in a `stale` one, `fleet-bind` only in an `unbound` one — so presence is the state assertion too. |
| `fleet-bind-dialog` / `fleet-bind-workspace` / `fleet-bind-save` | `src/app/fleet/BindDialog.tsx` | the inline dialog; its checkout `<select>`; its Bind `<button>` | Offers only checkouts the machine has REPORTED and not already bound; nothing here accepts a typed path. |
| `fleet-launcher` / `fleet-launcher-choice` / `fleet-launcher-harness` / `fleet-launcher-prompt` / `fleet-launcher-confirm` / `fleet-launcher-start` | `src/app/fleet/SessionLauncher.tsx` | the inline launcher and its parts | `fleet-launcher-choice` renders only after the server answered 409 `CHOICE_REQUIRED` — the "which machine?" question. `fleet-launcher-confirm` renders only for a `production` machine and must equal its name. |
| `fleet-sessions` / `fleet-session-row` / `fleet-permission` | `src/app/fleet/RunnerSessions.tsx` | the sessions card; one session `<li>`; the permission gate | The workbench the matrix's "Run here" lands in. |
| `delete-account-confirm` | `src/app/settings/SettingsPage.tsx` | the "Delete forever" `<button>` | **Irreversible.** Destroys the account for real — no grace period, no restore. Any spec touching it must register its own throwaway account first (`tests/accountDeletion.spec.ts` does); aimed at a shared QA account it would end the rest of the suite. |

## Conventions

- Ids are kebab-case, scoped to what they mark (not to the CSS Module class name).
- Only added to the outermost element the old class-substring selector actually matched —
  no restyling, no behavior changes.
- The `ConversationPage.tsx` header also renders an `onlineDot` span (1:1 peer presence next to
  the conversation title). It intentionally does NOT carry `presence-dot` — the old selector
  `[class*="onlineDot"]` in the ported check specifically targeted the **chats-list row** dot
  (asserted while on `/chats`), not the in-thread header dot. If a spec ever needs the header
  dot too, give it its own distinct id (e.g. `conversation-presence-dot`) rather than reusing
  `presence-dot`, so a single locator can't accidentally match both.
