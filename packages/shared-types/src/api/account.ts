/**
 * Account deletion — the contract behind Settings → Delete account, and behind the public
 * deletion page Google Play's Data safety form requires.
 *
 * Two calls, not one. `GET /users/me/deletion-preview` states the consequences; `DELETE /users/me`
 * performs them. Splitting them is the point: several of the consequences are things the user
 * cannot see from anywhere in the app — that an organization is about to be destroyed because
 * they are its last member, or that a store subscription will keep charging them after their
 * account is gone — and a confirmation dialog that cannot name them is not informed consent.
 */

/** Something that stops deletion, with copy the client shows verbatim. */
export interface AccountDeletionBlocker {
  /**
   * Why deletion is refused. Only one case today: the user is the sole owner of an organization
   * that still has other members. It is a named union rather than a bare string so a client can
   * branch (e.g. deep-link to the members screen) without parsing prose.
   */
  readonly kind: 'sole_owner';
  readonly orgName: string;
  /** Plain-language explanation including what to do about it. Safe to render as-is. */
  readonly detail: string;
}

/** What deleting this account would do. Everything here is read-only — nothing is destroyed yet. */
export interface AccountDeletionPreview {
  /** Echoed back so the confirmation screen can show which account is about to go. */
  readonly email: string;
  /** Non-empty means deletion is refused; each entry says why and how to clear it. */
  readonly blockers: ReadonlyArray<AccountDeletionBlocker>;
  /**
   * Organizations that will be **destroyed with all their data**, because this user is their only
   * member and nobody else could ever reach them again. Named, never counted — "1 organization"
   * is not something a person can check.
   */
  readonly orgsToDelete: ReadonlyArray<string>;
  /** Organizations that survive; the user simply stops being a member. */
  readonly orgsToLeave: ReadonlyArray<string>;
  /**
   * Active App Store / Google Play subscriptions attached to the organizations above.
   *
   * These CANNOT be cancelled from here, by anyone: the store owns the subscription and only the
   * store can stop it. Deleting the account removes our record and nothing else, so the user keeps
   * being charged unless they cancel in the store themselves. Surfacing it is the only remedy
   * available, which is exactly why it is in the preview rather than a support article.
   */
  readonly storeSubscriptions: ReadonlyArray<string>;
}

/** One third-party grant we tried to sever, and whether that company confirmed it. */
export interface AccountDeletionRevocation {
  /** Human-readable target, e.g. "Google account a@b.com" or "Hosted runner container". */
  readonly target: string;
  /**
   * True only when the provider acknowledged. False means the local record is gone but the grant
   * may still be live at their end — reported honestly rather than assumed, so the user knows to
   * check that provider's own security settings.
   */
  readonly confirmed: boolean;
  /** Why it could not be confirmed. Null when it was. */
  readonly detail: string | null;
}

/** The outcome of a completed deletion. Returned once; the session is dead immediately after. */
export interface AccountDeletionResult {
  readonly deleted: true;
  /** Encrypted secrets removed from the vault — tokens and vaulted addresses no cascade reaches. */
  readonly vaultSecretsDeleted: number;
  /** Files erased from disk: voice notes, images, avatars. */
  readonly mediaFilesDeleted: number;
  readonly orgsDeleted: number;
  readonly revocations: ReadonlyArray<AccountDeletionRevocation>;
}

/**
 * Deleting an account requires the password again, even though the caller already holds a valid
 * session. A stolen or borrowed phone should not be able to destroy someone's account and every
 * message in it; this is the same re-authentication gate the approve-to-send-email toggle uses.
 */
export interface DeleteAccountRequest {
  readonly password: string;
}

export interface GetAccountDeletionPreviewResponse {
  readonly preview: AccountDeletionPreview;
}

export interface DeleteAccountResponse {
  readonly result: AccountDeletionResult;
}
