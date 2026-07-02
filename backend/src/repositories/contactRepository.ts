import type { Contact, ContactInvite, ContactStatus, InviteStatus } from '@stewra/shared-types';
import { db } from '../database/index';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../database/types';

interface ContactRow {
  readonly id: string;
  readonly owner_id: string;
  readonly contact_user_id: string;
  readonly status: ContactStatus;
  readonly created_at: Date;
}

interface InviteRow {
  readonly id: string;
  readonly inviter_id: string;
  readonly invitee_email: string;
  readonly invitee_user_id: string | null;
  readonly status: InviteStatus;
  readonly created_at: Date;
  readonly responded_at: Date | null;
}

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    ownerId: row.owner_id,
    contactUserId: row.contact_user_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function toInvite(row: InviteRow): ContactInvite {
  return {
    id: row.id,
    inviterId: row.inviter_id,
    inviteeEmail: row.invitee_email,
    inviteeUserId: row.invitee_user_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
  };
}

const CONTACT_COLUMNS = ['id', 'owner_id', 'contact_user_id', 'status', 'created_at'] as const;
const INVITE_COLUMNS = [
  'id',
  'inviter_id',
  'invitee_email',
  'invitee_user_id',
  'status',
  'created_at',
  'responded_at',
] as const;

export class ContactRepository {
  /** All of the owner's contact edges (active + blocked), newest first. */
  async listForOwner(ownerId: string): Promise<Contact[]> {
    const rows = await db
      .selectFrom('contacts')
      .select(CONTACT_COLUMNS)
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toContact);
  }

  /** The single owner→contact edge, if any. */
  async getEdge(ownerId: string, contactUserId: string): Promise<Contact | undefined> {
    const row = await db
      .selectFrom('contacts')
      .select(CONTACT_COLUMNS)
      .where('owner_id', '=', ownerId)
      .where('contact_user_id', '=', contactUserId)
      .executeTakeFirst();
    return row ? toContact(row) : undefined;
  }

  /**
   * Whether two users may DM / call each other: BOTH reciprocal edges exist AND neither is blocked.
   * A block sets the blocker's edge to 'blocked', which drops the active count below 2.
   */
  async canContact(a: string, b: string): Promise<boolean> {
    const rows = await db
      .selectFrom('contacts')
      .select('id')
      .where('status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb.and([eb('owner_id', '=', a), eb('contact_user_id', '=', b)]),
          eb.and([eb('owner_id', '=', b), eb('contact_user_id', '=', a)]),
        ]),
      )
      .execute();
    return rows.length === 2;
  }

  /** Create both directed edges (idempotent) inside a transaction — the reciprocal "are contacts". */
  async createReciprocal(a: string, b: string, trx?: Transaction<Database>): Promise<void> {
    const run = async (conn: Kysely<Database> | Transaction<Database>): Promise<void> => {
      await conn
        .insertInto('contacts')
        .values([
          { owner_id: a, contact_user_id: b, status: 'active' },
          { owner_id: b, contact_user_id: a, status: 'active' },
        ])
        .onConflict((oc) => oc.columns(['owner_id', 'contact_user_id']).doNothing())
        .execute();
    };
    await (trx ? run(trx) : db.transaction().execute(run));
  }

  /** Flip an owner→contact edge between active and blocked. Returns the updated edge (or undefined). */
  async setStatus(
    ownerId: string,
    contactUserId: string,
    status: ContactStatus,
  ): Promise<Contact | undefined> {
    const row = await db
      .updateTable('contacts')
      .set({ status })
      .where('owner_id', '=', ownerId)
      .where('contact_user_id', '=', contactUserId)
      .returning(CONTACT_COLUMNS)
      .executeTakeFirst();
    return row ? toContact(row) : undefined;
  }

  // ── invites ──────────────────────────────────────────────────────────────

  async createInvite(input: {
    inviterId: string;
    inviteeEmail: string;
    inviteeUserId: string | null;
    token: string;
  }): Promise<ContactInvite> {
    const row = await db
      .insertInto('contact_invites')
      .values({
        inviter_id: input.inviterId,
        invitee_email: input.inviteeEmail,
        invitee_user_id: input.inviteeUserId,
        token: input.token,
      })
      .returning(INVITE_COLUMNS)
      .executeTakeFirstOrThrow();
    return toInvite(row);
  }

  async findInviteById(id: string): Promise<ContactInvite | undefined> {
    const row = await db
      .selectFrom('contact_invites')
      .select(INVITE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toInvite(row) : undefined;
  }

  /** A still-pending invite from this inviter to this email, if one exists (dedupe guard). */
  async findPendingByInviterAndEmail(
    inviterId: string,
    inviteeEmail: string,
  ): Promise<ContactInvite | undefined> {
    const row = await db
      .selectFrom('contact_invites')
      .select(INVITE_COLUMNS)
      .where('inviter_id', '=', inviterId)
      .where('invitee_email', '=', inviteeEmail)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return row ? toInvite(row) : undefined;
  }

  async listSent(inviterId: string): Promise<ContactInvite[]> {
    const rows = await db
      .selectFrom('contact_invites')
      .select(INVITE_COLUMNS)
      .where('inviter_id', '=', inviterId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toInvite);
  }

  /** Invites addressed to this user (resolved by account), pending or resolved, newest first. */
  async listReceived(inviteeUserId: string): Promise<ContactInvite[]> {
    const rows = await db
      .selectFrom('contact_invites')
      .select(INVITE_COLUMNS)
      .where('invitee_user_id', '=', inviteeUserId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toInvite);
  }

  /** Transition an invite's status and stamp responded_at. Returns the updated invite. */
  async setInviteStatus(id: string, status: InviteStatus): Promise<ContactInvite | undefined> {
    const row = await db
      .updateTable('contact_invites')
      .set({ status, responded_at: new Date() })
      .where('id', '=', id)
      .returning(INVITE_COLUMNS)
      .executeTakeFirst();
    return row ? toInvite(row) : undefined;
  }
}

export const contactRepository = new ContactRepository();
