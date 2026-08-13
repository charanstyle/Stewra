import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The operator-loaded price list — what Meta charges per message, as data, because Meta publishes
 * its rates as a spreadsheet with no API.
 *
 * Two tables, and the split is the versioning model. A rate card is ONE operator load of that
 * spreadsheet for ONE currency: the operator downloads Meta's sheet, loads it, and the load is
 * immutable from that moment. The rates hang off the card. When Meta changes its prices, the
 * operator loads a new card and the old one is closed by stamping `effective_to` — never edited,
 * never deleted — so the question "what was the price on March 3rd?" keeps its answer forever.
 * A message is rated against the card that was live when it was priced, and the resolved amount is
 * additionally snapshotted onto the message's own cost row (migration 051), so a rate correction
 * writes new rows rather than silently re-rating a closed invoice.
 *
 * There is deliberately NO fallback row — no "default" country, no wildcard category. A message to
 * a country the card does not list yields `unrated_no_rate`, a counted, visible gap on the cost
 * report, not a guessed number on an invoice. Client-facing pricing is pass-through: these are
 * Meta's prices, and the platform's own revenue is the flat platform fee, never a markup hidden in
 * this table.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('commerce_rate_cards')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    /**
     * ISO 4217, uppercase. One card prices one currency because Meta publishes one sheet per
     * billing currency — a WABA is billed in exactly one, and mixing currencies on one card would
     * let a lookup return an amount whose unit is ambiguous.
     */
    .addColumn('currency', 'varchar(3)', (col) => col.notNull().check(sql`currency ~ '^[A-Z]{3}$'`))
    /** When these prices start applying. Chosen by the operator from Meta's own announcement. */
    .addColumn('effective_from', 'timestamptz', (col) => col.notNull())
    /**
     * When they stop — NULL while this is the live card. Stamped (once, by trigger below) when a
     * successor is loaded, always to the successor's `effective_from`, so the timeline has no gap
     * and no overlap.
     */
    .addColumn('effective_to', 'timestamptz')
    /**
     * Where the numbers came from — the URL or filename of Meta's sheet and its published date.
     * Required, because a disputed invoice line is settled by pointing at Meta's document, and a
     * card that cannot say which document it transcribed cannot settle anything.
     */
    .addColumn('source_note', 'text', (col) => col.notNull())
    .addColumn('loaded_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'ck_commerce_rate_cards_window_ordered',
      sql`effective_to is null or effective_to > effective_from`,
    )
    .execute();

  // Exactly one live card per currency. Partial unique rather than an application-side check
  // because two concurrent loads must not BOTH become the open card — one of them has to lose at
  // the database, not at a code path that both already passed.
  await sql`
    CREATE UNIQUE INDEX uq_commerce_rate_cards_live_per_currency
    ON commerce_rate_cards (currency)
    WHERE effective_to IS NULL;
  `.execute(db);

  // Resolution by date scans a currency's timeline; keep that lookup on an index.
  await db.schema
    .createIndex('idx_commerce_rate_cards_currency_from')
    .on('commerce_rate_cards')
    .columns(['currency', 'effective_from'])
    .execute();

  /**
   * A card is immutable except for the single transition that closes it: `effective_to` NULL → a
   * value, everything else byte-identical. DELETE is never permitted — rated messages will point
   * at these rows, and a deleted card turns every one of them into an amount with no provenance.
   * Enforced in the database for the same reason `audit_log` and `commerce_contact_consents` are:
   * a rule living only in the repository is one careless `.updateTable()` away from gone.
   */
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_rate_cards_close_only()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commerce_rate_cards is append-only: DELETE is not permitted';
      END IF;
      IF OLD.effective_to IS NOT NULL
         OR NEW.effective_to IS NULL
         OR NEW.id IS DISTINCT FROM OLD.id
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
         OR NEW.source_note IS DISTINCT FROM OLD.source_note
         OR NEW.loaded_by_user_id IS DISTINCT FROM OLD.loaded_by_user_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'commerce_rate_cards rows may only be closed (effective_to NULL -> value); load a new card instead of editing this one';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_commerce_rate_cards_close_only
    BEFORE UPDATE OR DELETE ON commerce_rate_cards
    FOR EACH ROW EXECUTE FUNCTION stewra_commerce_rate_cards_close_only();
  `.execute(db);

  await db.schema
    .createTable('commerce_message_rates')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // RESTRICT rather than CASCADE, and the trigger above makes it unreachable anyway: a card can
    // never be deleted, so its rates can never be orphaned. The FK action documents the intent.
    .addColumn('rate_card_id', 'uuid', (col) =>
      col.notNull().references('commerce_rate_cards.id').onDelete('restrict'),
    )
    /**
     * ITU E.164 calling code, digits only, exactly as `callingCodes.countryCallingCode` returns it.
     * Meta prices per recipient country and the calling code is the country as a phone number
     * states it — no separate ISO country column that could disagree with the number.
     */
    .addColumn('country_calling_code', 'varchar(3)', (col) =>
      col.notNull().check(sql`country_calling_code ~ '^[0-9]{1,3}$'`),
    )
    /**
     * The closed union from shared-types' MESSAGE_PRICING_CATEGORIES. All five members are
     * loadable — `service` and `referral_conversion` are free TODAY, but service is announced
     * billable from 2026-10-01 and the check must not need a migration on the day Meta's sheet
     * grows the column. A category Meta invents later arrives as `pricingCategory: null` on the
     * message and rates as `unrated_no_category`; it cannot be priced here until the union learns
     * its name, which is the correct refusal.
     */
    .addColumn('pricing_category', 'varchar(32)', (col) =>
      col
        .notNull()
        .check(
          sql`pricing_category in ('marketing', 'utility', 'authentication', 'service', 'referral_conversion')`,
        ),
    )
    /**
     * Micros of the card's currency (1_000_000 = 1 unit), bigint end to end. Meta quotes prices
     * like $0.0025; floats multiplied over a 40k-recipient broadcast drift, integers do not.
     * Zero is a legal price — Meta's sheet really does list some combinations at 0.
     */
    .addColumn('amount_micros', 'bigint', (col) => col.notNull().check(sql`amount_micros >= 0`))
    /**
     * What the amount buys. `per_message` is Meta's model since 2025-07-01; `per_conversation`
     * remains real because service messages stay conversation-priced until 2026-10-01, and the
     * rater must know whether the second message in a conversation costs the amount again or 0.
     */
    .addColumn('unit', 'varchar(16)', (col) =>
      col.notNull().check(sql`unit in ('per_message', 'per_conversation')`),
    )
    // One answer per lookup. A (card, country, category) that appeared twice would make the rater
    // pick a row by accident of ordering — the exact class of quiet wrongness this schema exists
    // to make impossible.
    .addUniqueConstraint('uq_commerce_message_rates_lookup', [
      'rate_card_id',
      'country_calling_code',
      'pricing_category',
    ])
    .execute();

  await db.schema
    .createIndex('idx_commerce_message_rates_card')
    .on('commerce_message_rates')
    .column('rate_card_id')
    .execute();

  // Rates are fully append-only: they are loaded with their card and share its immutability. A
  // wrong number is corrected by loading a corrected card, which leaves the wrong one visible as
  // what invoices of its era were actually computed from.
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_message_rates_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'commerce_message_rates is append-only: % is not permitted; load a corrected rate card instead', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_commerce_message_rates_append_only
    BEFORE UPDATE OR DELETE ON commerce_message_rates
    FOR EACH ROW EXECUTE FUNCTION stewra_commerce_message_rates_append_only();
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_commerce_message_rates_append_only ON commerce_message_rates;`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS stewra_commerce_message_rates_append_only();`.execute(db);
  await db.schema.dropTable('commerce_message_rates').execute();
  await sql`DROP TRIGGER IF EXISTS trg_commerce_rate_cards_close_only ON commerce_rate_cards;`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS stewra_commerce_rate_cards_close_only();`.execute(db);
  await db.schema.dropTable('commerce_rate_cards').execute();
}
