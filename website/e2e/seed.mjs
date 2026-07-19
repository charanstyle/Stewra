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
