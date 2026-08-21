# testID registry

Canonical list of `testID`s the Maestro flows in `flows/*.yaml` depend on. This is the
selector contract between the app (`frontend/src/**`) and the E2E suite — if you rename
or remove one of these on the app side, update the matching flow in the same change.

Convention: kebab-case `<screen-or-area>-<element>`.

| id | Component | Marks |
| --- | --- | --- |
| `login-email-input` | `src/screens/auth/LoginScreen.tsx` | Email `TextInput` on the sign-in screen |
| `login-password-input` | `src/screens/auth/LoginScreen.tsx` (via `src/components/PasswordInput.tsx`) | Password `TextInput` on the sign-in screen — passed down as a prop through `PasswordInput`'s `TextInputProps` passthrough, not hardcoded inside the shared component |
| `password-visibility-toggle` | `src/components/PasswordInput.tsx` | The eye icon show/hide toggle. Fixed id on the shared component itself — only one `PasswordInput` is ever visible on screen at a time, so it's safe to reuse across Login/Register/ResetPassword |
| `login-submit` | `src/screens/auth/LoginScreen.tsx` | "Sign in" submit button |
| `tab-chats` | `src/navigation/MainTabs.tsx` | Bottom-tab button for the Chats tab (via `tabBarButtonTestID`, the React Navigation v7 bottom-tabs option — v6's `tabBarTestID` was renamed) |
| `chat-row-<n>` | `src/screens/chat/ChatListScreen.tsx` | Conversation row at position `n` (0-based) in the Chats list. Position, not identity: the suite can't know a conversation id or a contact's display name up front. `chat-row-0` is the most recently active thread, which is where a message just sent or received lands |
| `conversation-input` | `src/screens/chat/ConversationScreen.tsx` | Text message composer `TextInput` |
| `conversation-send` | `src/screens/chat/ConversationScreen.tsx` | "Send" button (only rendered while the composer has text) |
| `composer-record` | `src/screens/chat/ConversationScreen.tsx` | Hold-to-record voice message button (only rendered while the composer is empty) |
| `call-start-voice` | `src/screens/chat/ConversationScreen.tsx` | "Start voice call" header button on a conversation |
| `call-start-video` | `src/screens/chat/ConversationScreen.tsx` | "Start video call" header button on a conversation |
| `call-mute` | `src/screens/call/CallScreen.tsx` | Mute/unmute microphone control |
| `call-stop-video` | `src/screens/call/CallScreen.tsx` | Stop/start video control (video calls only) |
| `call-speaker` | `src/screens/call/CallScreen.tsx` | Speaker on/off toggle |
| `call-end` | `src/screens/call/CallScreen.tsx` | End call / decline-incoming control |
| `logout-btn` | `src/components/LogoutButton.tsx` | Header "Log out" control on the authenticated tabs |
| `runner-session-card` | `src/components/chat/ProposedRunnerSessionCard.tsx` | The in-chat "Run coding agent" card Stewra renders when it proposes a runner session on one of the user's machines. Its presence gates the runner flow — absent means no runner online / not proposed |
| `runner-session-start` | `src/components/chat/ProposedRunnerSessionCard.tsx` | Start (or "Try again" after a failed start) button — taps the confirm-gated `POST /messages/:id/confirm-runner-session` |
| `runner-session-cancel` | `src/components/chat/ProposedRunnerSessionCard.tsx` | Cancel (or "Dismiss" after a failed start) button |
| `runner-session-busy` | `src/components/chat/ProposedRunnerSessionCard.tsx` | The `ActivityIndicator` shown while a confirm request for this proposal is in flight (both buttons removed) |
| `runner-session-status` | `src/components/chat/ProposedRunnerSessionCard.tsx` | The collapsed terminal-status line for a resolved (`sent`/`cancelled`) proposal, e.g. "Started on <machine>" |
| `tab-today` | `src/navigation/MainTabs.tsx` | Bottom-tab button for the Today tab (via `tabBarButtonTestID`) |
| `today-briefing` | `src/components/today/BriefingCard.tsx` | The briefing summary card at the top of Today (absent until a briefing exists) |
| `today-nudge` | `src/components/today/NudgeCard.tsx` | One proactive nudge card in the "Needs your attention" stack (repeats; not positional) |
| `today-insight` | `src/components/today/InsightGlance.tsx` | The generated insight summary box (absent until a glance is requested) |
| `today-recompute` | `src/screens/today/TodayScreen.tsx` | The "Refresh" button that runs the server-side sync + briefing rebuild |
| `activity-row` | `src/screens/settings/ActivityScreen.tsx` | One activity-feed entry (repeats; not positional) |
| `settings-connection-row` | `src/components/settings/ConnectionsCard.tsx` | One connected-source row in Settings → Connections (repeats) |
| `settings-connect-google` | `src/components/settings/ConnectionsCard.tsx` | The "Connect a Google account" button (opens the consent alert, then the browser) |
| `settings-pause-switch` | `src/screens/settings/SettingsScreen.tsx` | The global "Pause Stewra" kill switch |
| `settings-activity-link` | `src/screens/settings/SettingsScreen.tsx` | The Settings row that pushes the Activity screen |
| `settings-delete-account` | `src/components/settings/DeleteAccountCard.tsx` | Opens the deletion sheet. Does NOT delete anything — it fetches the server's preview first, so a flow must then assert on the sheet rather than on a signed-out app |
| `delete-account-password` | `src/components/settings/DeleteAccountCard.tsx` | Password re-entry inside the sheet. Not mounted when a blocker is present (a sole owner is shown the reason instead of a way to proceed) |
| `delete-account-confirm` | `src/components/settings/DeleteAccountCard.tsx` | **Irreversible.** Deletes the account for real — no staging, no undo. Any flow using it must create its own throwaway account first; pointing it at a shared QA account destroys the suite |
| `delete-account-cancel` | `src/components/settings/DeleteAccountCard.tsx` | Closes the sheet, changing nothing. The safe half of the pair |
| `delete-blocker` | `src/components/settings/DeleteAccountCard.tsx` | One reason deletion is refused (repeats). Present ⇒ the confirm button is absent by construction |
| `create-org-name` | `src/screens/commerce/CommerceScreen.tsx` | Business-name `TextInput` in the Commerce tab's "No business yet" state. Only mounted when the account belongs to no organization, and only after `GET /orgs` has answered — the screen shows a spinner until then, so a flow must wait rather than assume the branch |
| `create-org` | `src/screens/commerce/CommerceScreen.tsx` | The "Create business" button beneath it. Disabled while the name is blank or the request is in flight, so its presence does not imply it is tappable |
| `open-subscription` | `src/screens/commerce/CommerceScreen.tsx` | The "Subscription and billing" row that pushes the Subscription screen |
| `subscription-screen` | `src/screens/commerce/SubscriptionScreen.tsx` | The Subscription screen's scroll container — presence only means it mounted, so flows assert on the plan card below as well |
| `subscription-plan-card` | `src/screens/commerce/SubscriptionScreen.tsx` | The "Your plan" card, rendered once `GET /orgs/:orgId/billing` has answered |
| `subscription-price` | `src/screens/commerce/SubscriptionScreen.tsx` | The store's localized price. Absent unless the store returned the product — which needs a StoreKit config (iOS) or an internal-track build with a license tester (Android), so no simulator flow can rely on it |
| `subscribe-button` | `src/screens/commerce/SubscriptionScreen.tsx` | Starts the store's purchase sheet. Same availability caveat as the price |
| `restore-purchases` | `src/screens/commerce/SubscriptionScreen.tsx` | Re-claims a subscription this store account already owns. Required by App Review; gated on the admin role |
| `store-subscription-status` | `src/screens/commerce/SubscriptionScreen.tsx` | What the store says about the subscription, in plain words. Absent until one has been claimed |
| `subscription-error` / `subscription-notice` | `src/screens/commerce/SubscriptionScreen.tsx` | The screen's failure and success lines |
| `today-onboarding` | `src/components/today/OnboardingCard.tsx` | The cold-start card on Today (shown while the user has no connections, or none of the value computed yet) |
| `onboarding-connect-google` | `src/components/today/OnboardingCard.tsx` | The onboarding "Connect Google Calendar" button (consent alert, then browser) |

## Conventions for flows

- Interactions (`tapOn`, `inputText`) use `id:` selectors wherever a testID exists above.
- `assertVisible` keeps targeting human-readable screen text (e.g. `"Chats"`, `"Sign in"`,
  the echoed message body) for transition assertions — those prove real navigation and
  real data round-tripping, not just that a node with the right id is mounted.
- Screens/elements not in this table (e.g. contact names, message bodies) are targeted by
  visible text since they're user-generated/dynamic content, not fixed UI chrome.
- **Text selectors are whole-string regexes, and iOS composes labels.** Any RN view that is an
  accessibility element (`accessibilityRole`, `accessible`, or an `accessibilityLabel`) collapses
  its children into ONE element on iOS whose label is every child's text joined with ", " — a chat
  row reads `QW, QA Web B, unread-probe 5165x3, 1`. Android exposes the children separately, so
  `text: "QA Web B"` passes there and fails on iOS with a misleading "Element not found" against a
  row plainly visible on screen. Wrap any selector that names part of a composed row in `.*`:
  `text: ".*${CONTACT_NAME}.*"`, and add `index: 0` when several rows can match.
- Avoid `text: ".*"` with `index: 0` as a "first thing on screen" selector. On iOS the root
  application element carries an `accessibilityText` of its own ("Stewra"), so it matches first and
  the tap lands in the middle of the screen. Use a positional testID (`chat-row-0`) instead.
