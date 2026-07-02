import type { ISODateString, UUID } from '../common/base';

/**
 * A contact is a reciprocal relationship between two Stewra users. Being contacts is what allows a 1:1
 * conversation or a call between them (random users cannot DM or ring each other). `blocked` is a
 * one-directional suppression the owner sets; it hides the other user and stops their messages/calls.
 */
export type ContactStatus = 'active' | 'blocked';
export const CONTACT_STATUSES: ReadonlyArray<ContactStatus> = ['active', 'blocked'];

/** Lifecycle of a contact invite. `revoked` is the inviter withdrawing a still-pending invite. */
export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked';
export const INVITE_STATUSES: ReadonlyArray<InviteStatus> = [
  'pending',
  'accepted',
  'declined',
  'revoked',
];

/** A single directed contact edge (owner → contactUser). Accepting an invite creates one in each direction. */
export interface Contact {
  readonly id: UUID;
  readonly ownerId: UUID;
  readonly contactUserId: UUID;
  readonly status: ContactStatus;
  readonly createdAt: ISODateString;
}

/**
 * An invitation to connect. Sent to an email; if that email already belongs to a Stewra user,
 * `inviteeUserId` is resolved so the invite shows up in their received list. The opaque `token` that
 * travels in the invite link is a server secret and is intentionally NOT part of this client model.
 */
export interface ContactInvite {
  readonly id: UUID;
  readonly inviterId: UUID;
  readonly inviteeEmail: string;
  readonly inviteeUserId: UUID | null;
  readonly status: InviteStatus;
  readonly createdAt: ISODateString;
  readonly respondedAt: ISODateString | null;
}

/** The minimal, non-sensitive public projection of a user — safe to show in search results, contact
 * lists, and conversation participant rows. Never carries auth or preference data. */
export interface PublicUser {
  readonly id: UUID;
  readonly displayName: string;
  readonly email: string;
}

/** A contact edge joined with the other user's public profile, for rendering a contact list. */
export interface ContactWithUser {
  readonly contact: Contact;
  readonly user: PublicUser;
}
