import type { OrgRole } from '@stewra/shared-types';

/**
 * How an org invite reaches its recipient's inbox.
 *
 * Same shape and same reason as `turnIntent.ts` next door: `.dependency-cruiser.cjs` forbids
 * `backend/src/commerce/` from importing `backend/src/services/`, and the SMTP transport
 * (`emailService`) lives on the personal-assistant side of that line. So the commerce plane sends
 * through this port, the composition root (`app.ts`) registers the transport-backed implementation,
 * and neither plane learns the other exists.
 *
 * Everything the email needs arrives as data — the sender formats and delivers, nothing more. In
 * particular the accept URL is BUILT BY THE CALLER: the invite token inside it is secret material
 * the commerce plane minted, and handing it over pre-assembled means the sender never has a reason
 * to hold the token apart from the one string it prints.
 */
export interface OrgInviteEmail {
  /** The invitee's address, exactly as the invite row stores it. */
  readonly to: string;
  /** Display name of the member who sent the invite. */
  readonly inviterName: string;
  /** The organization being joined. */
  readonly orgName: string;
  /** The role the invite grants on acceptance. */
  readonly role: OrgRole;
  /** Full URL the invitee follows to accept; carries the one-time token. */
  readonly acceptUrl: string;
  /** When the link stops working, so the email can say so. */
  readonly expiresAt: Date;
}

export interface OrgInviteEmailSender {
  /** Delivers the email or THROWS. A swallowed failure here strands an invitee with nothing. */
  send(email: OrgInviteEmail): Promise<void>;
}

class OrgInviteEmailRegistry {
  private sender: OrgInviteEmailSender | null = null;

  register(sender: OrgInviteEmailSender): void {
    this.sender = sender;
  }

  /** For tests that need to swap in a scripted sender. */
  reset(): void {
    this.sender = null;
  }

  /**
   * The sender, or a thrown error naming why there is none. Deliberately not a null-and-skip:
   * an invite whose email silently never left would show as `pending` forever, and the admin who
   * created it has no way to tell that from "the invitee is ignoring me".
   */
  require(): OrgInviteEmailSender {
    if (this.sender === null) {
      throw new Error(
        'No org-invite email sender is registered — the mail transport is not wired into this ' +
          'process, so an invite cannot be delivered from here.',
      );
    }
    return this.sender;
  }
}

export const orgInviteEmailRegistry = new OrgInviteEmailRegistry();
