import type { Kysely } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // Implicit engagement telemetry on each insight. Today only an ACTIVELY-rated insight leaves a
  // trace (insight_feedback), so an insight that is shown and silently ignored teaches nothing.
  // These two nullable timestamps capture the passive signal: `seen_at` marks the first impression,
  // `dismissed_at` marks the user closing it without rating. One row per insight keeps this
  // low-volume — no separate events table; the append-only audit log stays the behavioral stream
  // (a `view`/`dismiss` action lands there too). Both null until the client reports the event; a
  // dismiss-without-rating becomes a WEAK negative reward on the rules recall used (see
  // processMemoryService.reinforceForImplicitSignal). Only derived signal — no email content.
  await db.schema
    .alterTable('agent_insights')
    .addColumn('seen_at', 'timestamptz')
    .addColumn('dismissed_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('agent_insights')
    .dropColumn('seen_at')
    .dropColumn('dismissed_at')
    .execute();
}
