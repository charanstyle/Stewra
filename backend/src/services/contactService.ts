import { randomBytes } from 'node:crypto';
import type {
  ContactInvite,
  ContactInviteWithUsers,
  ContactWithUser,
  PublicUser,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig';
import { contactRepository } from '../repositories/contactRepository';
import { userRepository, toPublicUser } from '../repositories/userRepository';
import { emailService } from './emailService';
import { logger } from '../utils/logger';
import * as Sentry from '@sentry/node';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../utils/errors';

const SEARCH_LIMIT = 20;

/**
 * Contacts + invites. A contact is a RECIPROCAL relationship (both directed edges active); being
 * contacts is the gate that lets two users DM or call each other. Invites travel by email with an
 * opaque token and, when accepted, create both edges at once.
 */
class ContactService {
  /** Search other users to add (by email or display name). Never returns the caller. */
  async search(userId: string, query: string): Promise<PublicUser[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    return userRepository.search(trimmed, userId, SEARCH_LIMIT);
  }

  /** The caller's contact list (active + blocked), each joined with the other user's public profile. */
  async list(userId: string): Promise<ContactWithUser[]> {
    const edges = await contactRepository.listForOwner(userId);
    if (edges.length === 0) return [];
    const users = await userRepository.findPublicByIds(edges.map((e) => e.contactUserId));
    const byId = new Map(users.map((u) => [u.id, u]));
    const result: ContactWithUser[] = [];
    for (const edge of edges) {
      const user = byId.get(edge.contactUserId);
      if (user) result.push({ contact: edge, user });
    }
    return result;
  }

  /** Whether two users may DM / call each other (reciprocal, neither blocked). */
  async canContact(a: string, b: string): Promise<boolean> {
    return contactRepository.canContact(a, b);
  }

  /**
   * Invite someone by email to connect. If that email already belongs to a Stewra user the invite is
   * resolved to their account (so it shows in their received list); otherwise it waits for them to
   * sign up. Sends the invite email with the accept link. Rejects self-invites, existing contacts, and
   * duplicate pending invites.
   */
  async invite(userId: string, inviteeEmailRaw: string): Promise<ContactInvite> {
    const inviteeEmail = inviteeEmailRaw.trim().toLowerCase();
    const inviter = await userRepository.findById(userId);
    if (inviter === undefined) throw new NotFoundError('Inviter not found');
    if (inviteeEmail === inviter.email.toLowerCase()) {
      throw new ValidationError('You cannot invite yourself');
    }

    const invitee = await userRepository.findByEmail(inviteeEmail);
    if (invitee !== undefined) {
      const existingEdge = await contactRepository.getEdge(userId, invitee.id);
      if (existingEdge !== undefined && existingEdge.status === 'active') {
        throw new ConflictError('You are already connected with this person');
      }
    }

    const pending = await contactRepository.findPendingByInviterAndEmail(userId, inviteeEmail);
    if (pending !== undefined) {
      throw new ConflictError('An invite to this email is already pending');
    }

    const token = randomBytes(32).toString('hex');
    const invite = await contactRepository.createInvite({
      inviterId: userId,
      inviteeEmail,
      inviteeUserId: invitee?.id ?? null,
      token,
    });

    // The email is best-effort: a delivery hiccup must not roll back a stored invite the invitee can
    // still accept in-app. Capture the failure for triage rather than failing the request.
    try {
      const inviteUrl = `${config.web.appUrl}/invite/${token}`;
      await emailService.sendContactInvite(inviteeEmail, inviter.display_name, inviteUrl);
    } catch (error) {
      Sentry.captureException(error);
      logger.error('Contact invite email failed', { inviteId: invite.id });
    }

    return invite;
  }

  /**
   * Invites the caller sent and invites addressed to the caller's account, each hydrated with the
   * inviter's (and, when resolved, the invitee's) public profile so the client can name the other
   * party rather than echo a raw email — a received invite should read "<inviter> invited you".
   */
  async listInvites(
    userId: string,
  ): Promise<{ sent: ContactInviteWithUsers[]; received: ContactInviteWithUsers[] }> {
    const [sent, received] = await Promise.all([
      contactRepository.listSent(userId),
      contactRepository.listReceived(userId),
    ]);

    // Batch-resolve every party we need across both directions in a single lookup.
    const ids = new Set<string>();
    for (const inv of [...sent, ...received]) {
      ids.add(inv.inviterId);
      if (inv.inviteeUserId) ids.add(inv.inviteeUserId);
    }
    const users = await userRepository.findPublicByIds([...ids]);
    const byId = new Map(users.map((u) => [u.id, u]));

    // The inviter is always a real user; drop any invite whose inviter vanished (shouldn't happen).
    const hydrate = (inv: ContactInvite): ContactInviteWithUsers | null => {
      const inviter = byId.get(inv.inviterId);
      if (inviter === undefined) return null;
      const invitee = inv.inviteeUserId ? byId.get(inv.inviteeUserId) ?? null : null;
      return { invite: inv, inviter, invitee };
    };
    const keep = (x: ContactInviteWithUsers | null): x is ContactInviteWithUsers => x !== null;

    return {
      sent: sent.map(hydrate).filter(keep),
      received: received.map(hydrate).filter(keep),
    };
  }

  /**
   * Accept or decline a pending invite addressed to the caller. Accepting creates both contact edges
   * and returns the new contact joined with the inviter's profile; declining returns a null contact.
   */
  async respondInvite(
    userId: string,
    inviteId: string,
    action: 'accept' | 'decline',
  ): Promise<{ invite: ContactInvite; contact: ContactWithUser | null }> {
    const invite = await contactRepository.findInviteById(inviteId);
    if (invite === undefined) throw new NotFoundError('Invite not found');
    if (invite.inviteeUserId !== userId) {
      throw new ForbiddenError('This invite is not addressed to you');
    }
    if (invite.status !== 'pending') {
      throw new ConflictError('This invite has already been responded to');
    }

    if (action === 'decline') {
      const updated = await contactRepository.setInviteStatus(inviteId, 'declined');
      return { invite: updated ?? invite, contact: null };
    }

    await contactRepository.createReciprocal(invite.inviterId, userId);
    const updated = await contactRepository.setInviteStatus(inviteId, 'accepted');
    const edge = await contactRepository.getEdge(userId, invite.inviterId);
    const inviterUser = await userRepository.findById(invite.inviterId);
    const contact: ContactWithUser | null =
      edge !== undefined && inviterUser !== undefined
        ? { contact: edge, user: toPublicUser(inviterUser) }
        : null;
    return { invite: updated ?? invite, contact };
  }

  /** Block or unblock a contact (flips the caller→contact edge between active and blocked). */
  async setBlocked(
    userId: string,
    contactUserId: string,
    block: boolean,
  ): Promise<ContactWithUser> {
    const edge = await contactRepository.getEdge(userId, contactUserId);
    if (edge === undefined) throw new NotFoundError('Contact not found');
    const updated = await contactRepository.setStatus(
      userId,
      contactUserId,
      block ? 'blocked' : 'active',
    );
    if (updated === undefined) throw new NotFoundError('Contact not found');
    const user = await userRepository.findById(contactUserId);
    if (user === undefined) throw new NotFoundError('Contact user not found');
    return { contact: updated, user: toPublicUser(user) };
  }
}

export const contactService = new ContactService();
