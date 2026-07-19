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

## Conventions for flows

- Interactions (`tapOn`, `inputText`) use `id:` selectors wherever a testID exists above.
- `assertVisible` keeps targeting human-readable screen text (e.g. `"Chats"`, `"Sign in"`,
  the echoed message body) for transition assertions — those prove real navigation and
  real data round-tripping, not just that a node with the right id is mounted.
- Screens/elements not in this table (e.g. individual chat list rows, contact names)
  are still targeted by visible text since they're user-generated/dynamic content, not
  fixed UI chrome — a testID wouldn't be unique or meaningful there.
