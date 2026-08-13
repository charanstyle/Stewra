import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * What each delivered message cost in real currency — the money row BESIDE the honest counts,
 * never on top of them (`costSummary` is not touched by this migration or any code near it).
 *
 * One row per message, and only once its delivery receipt has carried a pricing block: a message
 * with no receipt has NO row here, which keeps `unpricedMessages` the single source of that count.
 * Rating is idempotent on `message_id`, so Meta's 7-day webhook retries cannot double-bill.
 *
 * The row snapshots everything the amount was computed FROM (card, per-unit rate, currency,
 * country, category) — so a later rate-card correction visibly does not change it, and a disputed
 * line can be replayed by hand. `unrated_*` states carry a NULL amount rather than a zero: an
 * unpriceable message is a discrepancy to show the operator, not a free message.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  /**
   * The WABA's billing currency, as Meta reports it on `GET /{waba-id}?fields=currency` — the
   * signup flow already fetched it and previously threw it away. A real column rather than a key
   * in `meta` jsonb, because `meta` is documented as display-only facts never to be trusted, and
   * this one is load-bearing: it selects the rate card every message is billed from. NULL means
   * Meta reported none, and messages on such an account rate as `unrated_no_currency` rather than
   * being guessed into a currency.
   */
  await db.schema
    .alterTable('channel_accounts')
    .addColumn('billing_currency', 'varchar(3)', (col) =>
      col.check(sql`billing_currency is null or billing_currency ~ '^[A-Z]{3}$'`),
    )
    .execute();

  await db.schema
    .createTable('commerce_message_costs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    // CASCADE so deleting an organization (the only path that ever deletes messages) does not
    // strand cost rows; production never deletes either.
    .addColumn('message_id', 'uuid', (col) =>
      col.notNull().references('commerce_messages.id').onDelete('cascade').unique(),
    )
    /**
     * The rating outcome. Three priced states and four honest refusals:
     *  - `rated` — billable, and the live card priced it. `amount_micros` = the rate.
     *  - `free` — Meta explicitly said not billable. Amount 0.
     *  - `rated_zero_conversation_dup` — conversation-priced (CBP), and another message in the
     *    same provider conversation already carries the charge. Amount 0, rate still snapshotted.
     *  - `unrated_no_category` — billable under a category this build cannot map.
     *  - `unrated_no_currency` — the account's WABA never reported a billing currency.
     *  - `unrated_no_country` — the recipient's number matches no assigned calling code.
     *  - `unrated_no_rate` — the live card lists no price for this (country, category).
     */
    .addColumn('state', 'varchar(40)', (col) =>
      col
        .notNull()
        .check(
          sql`state in ('rated', 'free', 'rated_zero_conversation_dup', 'unrated_no_category', 'unrated_no_currency', 'unrated_no_country', 'unrated_no_rate')`,
        ),
    )
    /** Meta's answer, copied from the receipt at rating time; NOT NULL because rating requires it. */
    .addColumn('billable', 'boolean', (col) => col.notNull())
    .addColumn('currency', 'varchar(3)')
    .addColumn('pricing_category', 'varchar(32)')
    .addColumn('country_calling_code', 'varchar(3)')
    .addColumn('provider_conversation_id', 'varchar(255)')
    /** Which card priced it. RESTRICT: a card with rated messages can never disappear (belt to the
     *  trigger's suspenders). */
    .addColumn('rate_card_id', 'uuid', (col) =>
      col.references('commerce_rate_cards.id').onDelete('restrict'),
    )
    .addColumn('unit', 'varchar(16)', (col) =>
      col.check(sql`unit is null or unit in ('per_message', 'per_conversation')`),
    )
    /** The per-unit price the card gave, snapshotted. Equal to `amount_micros` for `rated`;
     *  preserved on a conversation dup whose own amount is 0. */
    .addColumn('rate_amount_micros', 'bigint')
    /** What this message adds to the bill. NULL exactly on the unrated states. */
    .addColumn('amount_micros', 'bigint', (col) =>
      col.check(sql`amount_micros is null or amount_micros >= 0`),
    )
    /**
     * When the price was established. Billing periods cut on THIS timestamp, not the message's
     * `created_at`: a receipt arriving three days into the next month bills in the period it was
     * priced, which is what leaves closed invoices immutable.
     */
    .addColumn('priced_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // A priced state has an amount; an unrated state has none. One CHECK, both directions.
    .addCheckConstraint(
      'ck_commerce_message_costs_amount_matches_state',
      sql`(state in ('rated', 'free', 'rated_zero_conversation_dup')) = (amount_micros is not null)`,
    )
    // Anything the card priced must say which card, at what rate, in what currency, per what unit.
    .addCheckConstraint(
      'ck_commerce_message_costs_rated_has_provenance',
      sql`state not in ('rated', 'rated_zero_conversation_dup') or (rate_card_id is not null and rate_amount_micros is not null and currency is not null and unit is not null)`,
    )
    .execute();

  // Conversation pricing charges once per provider conversation: at most one `rated` row per
  // (org, conversation) under `per_conversation`. Partial unique rather than an application check,
  // because two workers rating two messages of one conversation concurrently must not both charge —
  // the loser's insert fails here and is rewritten as the zero-amount dup.
  await sql`
    CREATE UNIQUE INDEX uq_commerce_message_costs_conversation_charge
    ON commerce_message_costs (org_id, provider_conversation_id)
    WHERE state = 'rated' AND unit = 'per_conversation';
  `.execute(db);

  // The billing-period read: everything an org was priced at inside a window.
  await db.schema
    .createIndex('idx_commerce_message_costs_org_priced')
    .on('commerce_message_costs')
    .columns(['org_id', 'priced_at'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_message_costs').execute();
  await db.schema.alterTable('channel_accounts').dropColumn('billing_currency').execute();
}
