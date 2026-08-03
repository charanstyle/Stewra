// Optional DB-backed provisioning for the destructive-but-reversible lifecycle tests — the
// Today nudge actions (snooze/dismiss/draft/chat) and the Memory delete. Those exercise UI that
// only appears when the account actually has an open nudge / a deletable memory, and User A's
// real data is fully triaged (every needs-reply nudge already snoozed/dismissed/done, no learned
// memories), so without provisioning they skip.
//
// Enabled ONLY when `E2E_DATABASE_URL` is set (config.databaseUrl) — a direct connection to the
// same Postgres the API writes. It is the same store the app itself mutates, so nothing here is a
// mock: it stages real rows, the UI drives the real API against them, and everything is undone:
//   • Nudges: a few of A's already-acted-on needs_reply nudges are flipped to `open`, snapshotted,
//     and restored to their exact prior (status, snoozed_until) in afterAll — the user's triage
//     state is left identical. (The action tests still write honest audit_log rows, which are
//     append-only by design and intentionally NOT rewritten.)
//     Re-opening alone is not enough, and that mattered: A's inbox had NO acted-on needs_reply rows
//     to re-open, so eight Today tests skipped while E2E_DATABASE_URL was set — a suite reporting
//     green having asserted almost nothing about the page it exists to cover. `seedNeedsReplyNudges`
//     covers that case by hanging a correctly-shaped nudge on a real thread; both are cleaned up.
//   • Memory: one throwaway row is inserted, targeted by the delete test, and any leftover is swept.
//
// Without E2E_DATABASE_URL, `dbEnabled` is false, the helpers no-op, and the dependent tests skip
// with a message pointing here — so the minimal "just emails+passwords" run still works unchanged.
import pg from 'pg';
import { config } from './config.mjs';

/** True when a seeding DB connection is configured. Gate every helper call on this. */
export const dbEnabled = config.databaseUrl.length > 0;

/** A distinctive label so the throwaway memory can never be confused with a real learned one. */
export const THROWAWAY_MEMORY_LABEL = 'E2E throwaway memory — safe to delete';

async function withClient(fn) {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function userIdByEmail(client, email) {
  const r = await client.query('select id from users where email = $1', [email]);
  if (r.rows.length === 0) {
    throw new Error(`[seed] no user for ${email}`);
  }
  return r.rows[0].id;
}

/**
 * Insert one throwaway memory for `email` and return its id. Shaped like a real feedback-derived
 * memory (kind 'gmail', rating 'excellent') so it renders and matches the "gmail" source filter.
 */
export async function seedThrowawayMemory(email) {
  return withClient(async (c) => {
    const uid = await userIdByEmail(c, email);
    const r = await c.query(
      `INSERT INTO agent_memory
         (user_id, label, kind, purpose, purpose_norm, exemplar, guidance, rating, reward_score, source, visible)
       VALUES ($1, $2, 'gmail', $3, $3, $4, $5, 'excellent', 3, 'feedback', true)
       RETURNING id`,
      [
        uid,
        THROWAWAY_MEMORY_LABEL,
        'exercise the memory delete UI in the e2e suite',
        'A disposable exemplar the delete test removes; never real learned data.',
        'Safe to delete — created and torn down by the e2e suite.',
      ],
    );
    return r.rows[0].id;
  });
}

/** Remove any leftover throwaway memories for `email` (idempotent afterAll sweep). */
export async function cleanupThrowawayMemories(email) {
  if (!dbEnabled) {
    return;
  }
  await withClient(async (c) => {
    const uid = await userIdByEmail(c, email);
    await c.query('DELETE FROM agent_memory WHERE user_id = $1 AND label = $2', [
      uid,
      THROWAWAY_MEMORY_LABEL,
    ]);
  });
}

/**
 * Surface up to `k` of A's already-triaged needs_reply nudges (real threads + a reply_email option,
 * so "Draft a reply" works) by flipping them to `open`. Returns a snapshot for restoreNudges().
 */
export async function openNeedsReplyNudges(email, k) {
  return withClient(async (c) => {
    const uid = await userIdByEmail(c, email);
    const sel = await c.query(
      `SELECT id, status, snoozed_until
         FROM suggestions
        WHERE user_id = $1 AND kind = 'needs_reply' AND jsonb_array_length(options) > 0
          AND status IN ('snoozed', 'dismissed', 'done')
        ORDER BY updated_at DESC
        LIMIT $2`,
      [uid, k],
    );
    const snapshot = sel.rows.map((r) => ({
      id: r.id,
      status: r.status,
      snoozedUntil: r.snoozed_until,
    }));
    for (const s of snapshot) {
      await c.query(
        `UPDATE suggestions SET status = 'open', snoozed_until = NULL, updated_at = now() WHERE id = $1`,
        [s.id],
      );
    }
    return snapshot;
  });
}

/**
 * The dedup-key prefix every seeded nudge carries. Distinct from the app's own `needs_reply:<id>`
 * so cleanup can delete by exact prefix and can never touch a nudge the briefing service created.
 */
export const SEEDED_NUDGE_PREFIX = 'e2e:needs_reply:';

/**
 * Thrown when the account has no email thread to hang a nudge on. Distinct from a generic failure
 * because it means something specific and actionable — "this account has no Gmail data" — which the
 * caller reports as a named, counted precondition rather than as a broken seed.
 */
export class NoSeedableThreadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoSeedableThreadError';
  }
}

/**
 * Insert up to `k` open needs_reply nudges for `email`, each pointing at one of the user's REAL
 * email threads, and return their ids.
 *
 * Why real threads and not a fully synthetic row: `POST /home/suggestions/:id/draft` resolves the
 * option's `threadId` through `emailThreadRepository.findByIdForUser` and drafts from the thread's
 * actual messages. A made-up thread id would make the draft test fail with "Email thread not found"
 * — a red test that says nothing about the product, which is worse than the skip it replaced.
 *
 * Threads that already carry an open nudge are excluded, so seeding never duplicates what the
 * briefing service is already surfacing, and the row is shaped exactly like `briefingService`'s
 * (`upsertNudges`): same title form, same single `reply_email` option.
 */
export async function seedNeedsReplyNudges(email, k) {
  return withClient(async (c) => {
    const uid = await userIdByEmail(c, email);
    const threads = await c.query(
      `SELECT t.id, t.subject
         FROM email_threads t
        WHERE t.user_id = $1
          AND EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id)
          AND NOT EXISTS (
                SELECT 1 FROM suggestions s
                 WHERE s.user_id = t.user_id
                   AND s.status = 'open'
                   AND s.dedup_key IN ('needs_reply:' || t.id::text, $3 || t.id::text)
              )
        ORDER BY t.last_message_at DESC NULLS LAST
        LIMIT $2`,
      [uid, k, SEEDED_NUDGE_PREFIX],
    );
    if (threads.rows.length === 0) {
      throw new NoSeedableThreadError(
        `${email} has no email thread with messages, so no needs_reply nudge can be provisioned. ` +
          `The Today action tests (expand/draft/snooze/dismiss/chat) therefore cannot run at all — ` +
          `a "Draft a reply" that points at no thread would fail for a reason that says nothing ` +
          `about the product. Fix by connecting Gmail for this QA account and running ` +
          `POST /home/recompute; the tests then exercise real threads.`,
      );
    }

    const ids = [];
    for (const t of threads.rows) {
      const label = t.subject || '(no subject)';
      const r = await c.query(
        `INSERT INTO suggestions (user_id, dedup_key, kind, title, rationale, source_refs, options, status)
         VALUES ($1, $2, 'needs_reply', $3, $4, $5::jsonb, $6::jsonb, 'open')
         RETURNING id`,
        [
          uid,
          `${SEEDED_NUDGE_PREFIX}${t.id}`,
          `Reply to "${label}"`,
          "They're waiting on your reply — the last message in this thread was theirs.",
          JSON.stringify([{ kind: 'email_thread', ref: t.id, label }]),
          JSON.stringify([
            {
              id: `draft:${t.id}`,
              label: 'Draft a reply',
              action: { type: 'reply_email', targetRefs: { threadId: t.id } },
            },
          ]),
        ],
      );
      ids.push(r.rows[0].id);
    }
    return ids;
  });
}

/**
 * Delete every seeded nudge for `email`, by prefix rather than by the returned ids — a run that
 * dies between INSERT and the id landing in the caller's array would otherwise leave a nudge in a
 * real user's Today list forever. Idempotent.
 */
export async function cleanupSeededNudges(email) {
  if (!dbEnabled) {
    return;
  }
  await withClient(async (c) => {
    const uid = await userIdByEmail(c, email);
    await c.query('DELETE FROM suggestions WHERE user_id = $1 AND dedup_key LIKE $2', [
      uid,
      `${SEEDED_NUDGE_PREFIX}%`,
    ]);
  });
}

/** Restore each snapshotted nudge to its exact prior (status, snoozed_until). */
export async function restoreNudges(snapshot) {
  if (!dbEnabled || !Array.isArray(snapshot) || snapshot.length === 0) {
    return;
  }
  await withClient(async (c) => {
    for (const s of snapshot) {
      await c.query(
        `UPDATE suggestions SET status = $2, snoozed_until = $3, updated_at = now() WHERE id = $1`,
        [s.id, s.status, s.snoozedUntil],
      );
    }
  });
}
