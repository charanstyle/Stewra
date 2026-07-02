import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

/**
 * Widen `process_memory.reward_score` from `integer` to `double precision`.
 *
 * The column accrues the raw signed reward that shaped a rule (010). Explicit feedback rewards are
 * whole numbers (a rating maps to -2..+2), so an integer sufficed — until the IMPLICIT dismiss signal
 * (012) introduced a deliberately fractional half-weight reward (config `implicitDismissReward`,
 * e.g. -0.5) so a silent dismiss discounts a rule by less than an explicit "poor". Adding -0.5 to an
 * integer column throws `invalid input syntax for type integer`, so the accumulator must hold
 * fractions. `double precision` (float8, NOT `numeric`) is used so node-postgres returns a JS number,
 * keeping the `reward_score: number` type and the `ORDER BY reward_score` recall sort intact.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    ALTER TABLE process_memory
      ALTER COLUMN reward_score TYPE double precision,
      ALTER COLUMN reward_score SET DEFAULT 0
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // Round back to the nearest whole reward on the way down (fractional history is lost, as an
  // integer column can't represent it — acceptable for a rollback).
  await sql`
    ALTER TABLE process_memory
      ALTER COLUMN reward_score TYPE integer USING round(reward_score),
      ALTER COLUMN reward_score SET DEFAULT 0
  `.execute(db);
}
