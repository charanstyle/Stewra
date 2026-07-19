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
