import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Click-to-WhatsApp opt-in links — the third door into the audience, and the only one where the
 * consent is created by the customer rather than asserted by the business.
 *
 * The two doors that already exist both rest on the organization's word. A member typing a contact
 * in is vouching for them; an imported row carries whatever provenance the file claimed. This one
 * does not need to be believed: the customer sends a sentence from their own WhatsApp account saying
 * what they agree to, and Meta keeps a copy of it. That is the same class of evidence as a keyword
 * opt-out, which is the strongest thing in the consent regime.
 *
 * Why a token rather than Meta's `referral` block: `referral` is attached only to messages that began
 * at an AD or a Facebook post, and carries `ctwa_clid`, `source_id`, `source_url`. A link a business
 * prints on a receipt or drops in its website footer is neither — it produces an ordinary text
 * message with no referral at all. The one field that survives an arbitrary `wa.me` link is the
 * PREFILLED TEXT, so the provenance has to ride in there. Both mechanisms are read on the inbound
 * path; this table is the half that works without buying an ad.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  /**
   * The number to open a chat with, in E.164.
   *
   * `display_name` already usually holds Meta's `display_phone_number`, but only usually — it falls
   * back to the WABA name and then to the WABA id when Meta reports no number, so it is a label, not
   * an address. Building a `wa.me` URL out of it would mean stripping non-digits from a string that
   * is sometimes a business name, which is precisely the kind of guess that produces a link opening
   * a chat with a stranger. A separate column that is either a number or NULL cannot do that.
   */
  await db.schema
    .alterTable('channel_accounts')
    .addColumn('display_phone_number', 'varchar(32)')
    .execute();

  await db.schema
    .createTable('commerce_optin_links')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('channel_account_id', 'uuid', (col) =>
      col.notNull().references('channel_accounts.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    /**
     * The number the link opens, snapshotted at mint time rather than joined at read time.
     *
     * A QR sticker on a box cannot be recalled. If the organization reconnects and Meta reports a
     * different number, the printed code still opens a chat with the old one, and a link whose URL
     * silently changed underneath it would show the operator an address their customers are not
     * using. The snapshot is what was published; the channel row is what is current.
     */
    .addColumn('phone_e164', 'varchar(24)', (col) => col.notNull())
    .addColumn('purpose', 'varchar(32)', (col) =>
      col.notNull().check(sql`purpose in ('service', 'marketing')`),
    )
    /**
     * The whole message the customer will send, token included, exactly as it will arrive.
     *
     * Stored rather than recomposed from a phrase at read time, because this string is what people
     * agreed to. Rebuilding it later from parts means a change to the formatting code silently
     * rewrites the wording of consents already gathered.
     */
    .addColumn('prefill_text', 'text', (col) => col.notNull())
    /**
     * The marker inside `prefill_text` that identifies this link on the way back.
     *
     * Globally unique, not per-org: the inbound path matches a token against a message body before it
     * knows which link was meant, and a token that could belong to two organizations would resolve to
     * whichever row was found first — recording one business's opt-in against another's link.
     */
    .addColumn('token', 'varchar(32)', (col) => col.notNull().unique())
    .addColumn('status', 'varchar(16)', (col) =>
      col.notNull().defaultTo('active').check(sql`status in ('active', 'disabled')`),
    )
    .addColumn('created_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('disabled_at', 'timestamptz')
    // A disabled link keeps its row forever: the consents it gathered point at it, and deleting it
    // would orphan the answer to "where did this permission come from?".
    .addCheckConstraint(
      'ck_commerce_optin_links_disabled_consistent',
      sql`(status = 'active' and disabled_at is null) or (status = 'disabled' and disabled_at is not null)`,
    )
    // One name per organization, so the label on a poster is unambiguous when a complaint cites it.
    .addUniqueConstraint('uq_commerce_optin_links_org_name', ['org_id', 'name'])
    .execute();

  await db.schema
    .createIndex('idx_commerce_optin_links_org')
    .on('commerce_optin_links')
    .columns(['org_id', 'created_at'])
    .execute();

  /**
   * Which link produced a consent, as a relation rather than a substring of `evidence`.
   *
   * `evidence` will also name the link in words — it has to, because it is the human-readable proof —
   * but counting opt-ins by pattern-matching free text is the kind of query that quietly returns the
   * wrong number the first time someone names a link "Spring" and another "Spring sale". A nullable
   * FK answers it exactly and costs one column.
   *
   * Adding a column does not violate the append-only trigger on this table: that trigger rejects
   * UPDATE and DELETE of ROWS. No existing row is rewritten here — they simply get a NULL, which is
   * the truth about them.
   */
  await db.schema
    .alterTable('commerce_contact_consents')
    .addColumn('optin_link_id', 'uuid', (col) =>
      col.references('commerce_optin_links.id').onDelete('set null'),
    )
    .execute();

  await db.schema
    .createIndex('idx_commerce_consents_optin_link')
    .on('commerce_contact_consents')
    .column('optin_link_id')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('commerce_contact_consents').dropColumn('optin_link_id').execute();
  await db.schema.dropTable('commerce_optin_links').execute();
  await db.schema.alterTable('channel_accounts').dropColumn('display_phone_number').execute();
}
