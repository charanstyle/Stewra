import type { UUID } from '../common/base';
import type {
  ContactInvite,
  ContactInviteWithUsers,
  ContactWithUser,
  PublicUser,
} from '../models/contact';

/** Search Stewra users by email or display name (to add as a contact). */
export interface SearchUsersRequest {
  readonly query: string;
}
export interface SearchUsersResponse {
  readonly users: ReadonlyArray<PublicUser>;
}

/** The caller's active + blocked contacts, each joined with the other user's public profile. */
export interface ListContactsResponse {
  readonly contacts: ReadonlyArray<ContactWithUser>;
}

/** Invite someone to connect by email. If they already have a Stewra account it resolves to them. */
export interface SendInviteRequest {
  readonly inviteeEmail: string;
}
export interface SendInviteResponse {
  readonly invite: ContactInvite;
}

/**
 * Invites the caller sent and invites addressed to the caller's account, each joined with both
 * parties' public profiles so the UI can name the inviter/invitee instead of showing a raw email.
 */
export interface ListInvitesResponse {
  readonly sent: ReadonlyArray<ContactInviteWithUsers>;
  readonly received: ReadonlyArray<ContactInviteWithUsers>;
}

/** Accept or decline a pending invite addressed to the caller. Accept creates reciprocal contacts. */
export interface RespondInviteRequest {
  readonly action: 'accept' | 'decline';
}
export interface RespondInviteResponse {
  readonly invite: ContactInvite;
  /** The new contact when accepted; null when declined. */
  readonly contact: ContactWithUser | null;
}

/** Block or unblock a contact (flips the owner→contact edge's status). */
export interface BlockContactRequest {
  readonly contactUserId: UUID;
  readonly block: boolean;
}
export interface BlockContactResponse {
  readonly contact: ContactWithUser;
}
