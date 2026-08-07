import type { Selectable } from 'kysely';
import type { ConsentPurpose, OptinLink } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type { CommerceOptinLinksTable } from '../../database/types.js';

/**
 * The link as it is published — `https://wa.me/<digits>?text=<the sentence>`.
 *
 * Derived rather than stored, unlike the number and the sentence it is built from. Those two are
 * snapshots of what a customer was shown; this is just their concatenation, and keeping a fourth
 * copy of the same fact would only create somewhere for it to disagree with itself.
 *
 * `wa.me` wants the number with no '+' and no separators.
 */
function toUrl(phoneE164: string, prefillText: string): string {
  return `https://wa.me/${phoneE164.replace(/\D/g, '')}?text=${encodeURIComponent(prefillText)}`;
}

function toLink(row: Selectable<CommerceOptinLinksTable>, optInCount: number): OptinLink {
  return {
    id: row.id,
    orgId: row.org_id,
    channelAccountId: row.channel_account_id,
    name: row.name,
    purpose: row.purpose,
    prefillText: row.prefill_text,
    token: row.token,
    url: toUrl(row.phone_e164, row.prefill_text),
    status: row.status,
    optInCount,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    disabledAt: row.disabled_at?.toISOString() ?? null,
  };
}

/**
 * Opt-in links, and the consents each of them gathered.
 *
 * Every method is tenant-scoped except {@link findActiveByToken}, which cannot be, for exactly the
 * reason {@link channelAccountRepository.findByExternalAccount} cannot be: it runs on the inbound
 * path, where a customer's message is all we have and the token is the only thing in it that says
 * which organization — and which link — this belongs to. It is safe for the same reason too. The
 * token column is globally unique, so the lookup can never return an ambiguous answer, and the org id
 * it yields is then carried into every subsequent write rather than taken from the request.
 */
class OptinLinkRepository {
  async create(params: {
    orgId: string;
    channelAccountId: string;
    name: string;
    phoneE164: string;
    purpose: ConsentPurpose;
    prefillText: string;
    token: string;
    createdByUserId: string;
  }): Promise<OptinLink> {
    const row = await db
      .insertInto('commerce_optin_links')
      .values({
        org_id: params.orgId,
        channel_account_id: params.channelAccountId,
        name: params.name,
        phone_e164: params.phoneE164,
        purpose: params.purpose,
        prefill_text: params.prefillText,
        token: params.token,
        created_by_user_id: params.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // A link nobody has been shown yet has no opt-ins. Counted rather than assumed everywhere else,
    // but here the row was created microseconds ago and a query would only be able to say zero.
    return toLink(row, 0);
  }

  /**
   * Every link this organization has minted, newest first, each with its real opt-in count.
   *
   * The count is a correlated subquery on the FK rather than a stored counter. A counter is one
   * crashed handler away from claiming a link works when it has never fired, and this number is the
   * only feedback an operator gets that the sticker they printed is doing anything.
   */
  async listForOrg(orgId: string): Promise<OptinLink[]> {
    const rows = await db
      .selectFrom('commerce_optin_links')
      .selectAll('commerce_optin_links')
      .select((eb) =>
        eb
          .selectFrom('commerce_contact_consents')
          .select(({ fn }) => fn.countAll<string>().as('count'))
          .whereRef('commerce_contact_consents.optin_link_id', '=', 'commerce_optin_links.id')
          .as('opt_in_count'),
      )
      .where('org_id', '=', orgId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => toLink(row, Number(row.opt_in_count ?? 0)));
  }

  async findForOrg(orgId: string, linkId: string): Promise<OptinLink | null> {
    const row = await db
      .selectFrom('commerce_optin_links')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', linkId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const counted = await db
      .selectFrom('commerce_contact_consents')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('optin_link_id', '=', linkId)
      .executeTakeFirst();
    return toLink(row, Number(counted?.count ?? 0));
  }

  /**
   * One link by its operator-facing name, within a tenant. Backs the friendly duplicate message; the
   * unique constraint remains the actual guarantee under a race.
   */
  async findByName(orgId: string, name: string): Promise<OptinLink | null> {
    const row = await db
      .selectFrom('commerce_optin_links')
      .select('id')
      .where('org_id', '=', orgId)
      .where('name', '=', name)
      .executeTakeFirst();
    return row === undefined ? null : this.findForOrg(orgId, row.id);
  }

  /**
   * Resolve a token found in a customer's message to the link that minted it.
   *
   * `active` only. A disabled link is not an error and not a match — the sentence stays on packaging
   * long after an organization stops honouring it, and the correct behaviour then is that the message
   * arrives in the inbox as an ordinary message rather than silently recording a permission the
   * business has decided it no longer collects.
   */
  async findActiveByToken(token: string): Promise<{
    id: string;
    orgId: string;
    channelAccountId: string;
    name: string;
    purpose: ConsentPurpose;
  } | null> {
    const row = await db
      .selectFrom('commerce_optin_links')
      .select(['id', 'org_id', 'channel_account_id', 'name', 'purpose'])
      .where('token', '=', token)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          id: row.id,
          orgId: row.org_id,
          channelAccountId: row.channel_account_id,
          name: row.name,
          purpose: row.purpose,
        };
  }

  /**
   * Stop honouring a link. Returns null when there was nothing to disable, and leaves an
   * already-disabled row exactly as it was so the original `disabled_at` survives a second click.
   */
  async disable(orgId: string, linkId: string): Promise<OptinLink | null> {
    await db
      .updateTable('commerce_optin_links')
      .set({ status: 'disabled', disabled_at: new Date() })
      .where('org_id', '=', orgId)
      .where('id', '=', linkId)
      .where('status', '=', 'active')
      .execute();
    return this.findForOrg(orgId, linkId);
  }
}

export const optinLinkRepository = new OptinLinkRepository();
