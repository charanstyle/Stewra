import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { whatsappController } from '../controllers/whatsappController';
import { whatsappPersonalController } from '../controllers/whatsappPersonalController';
import { whatsappEmailApprovalController } from '../controllers/whatsappEmailApprovalController';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuth } from '../middleware/requireAuth';
import { requireEmailVerification } from '../middleware/requireEmailVerification';

const router = Router();

/**
 * Channel linking — how a user attaches an outside messaging surface to their Stewra thread.
 *
 * Gated on a VERIFIED email, like the data connections: binding a phone number to an account is a
 * security-relevant act, and we don't do those for an unconfirmed account owner.
 */
const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

// Mint a single-use link code + wa.me deep link. The user sends the code from their own WhatsApp,
// which proves they hold both the session and the phone.
router.post('/whatsapp/link', requireAuth, verified, (req, res) => {
  void whatsappController.startLink(req, res);
});

router.get('/whatsapp', requireAuth, (req, res) => {
  void whatsappController.status(req, res);
});

// Revocable at any time (build-plan principle 7).
router.delete('/whatsapp', requireAuth, (req, res) => {
  void whatsappController.unlink(req, res);
});

/**
 * ── The EXPERIMENTAL companion-device channel (`whatsapp_personal`) ────────────────────────────────
 *
 * A separate, opt-in, off-by-default channel where the user links their OWN WhatsApp account via the
 * Stewra Bridge app on their own computer. Unofficial, against WhatsApp's terms, and the account can be
 * permanently banned — hence the typed consent below, and hence `WHATSAPP_PERSONAL_ENABLED` defaulting
 * to false. Nothing on these routes ever connects to WhatsApp; the server's role is authentication,
 * queueing, and storage (build-plan principle 7).
 */
router.get('/whatsapp-personal', requireAuth, (req, res) => {
  void whatsappPersonalController.status(req, res);
});

// The typed acknowledgement. Verified server-side against the shared constant — there is no "confirmed"
// boolean to send, because a client asserting that the user agreed is not evidence that they did.
router.post('/whatsapp-personal/consent', requireAuth, verified, (req, res) => {
  void whatsappPersonalController.consent(req, res);
});

// Mint the single-use code the user types into the bridge app. Refuses without a current consent.
router.post('/whatsapp-personal/pair', requireAuth, verified, (req, res) => {
  void whatsappPersonalController.startPairing(req, res);
});

// Called by the BRIDGE APP, which holds no user session — the single-use pairing code is the credential.
// Deliberately NOT behind requireAuth: a desktop app carrying the user's access token would hold the
// whole account, when all it needs is permission to relay WhatsApp messages.
//
// It is therefore the only guessable, unauthenticated way to obtain a token that speaks for a user, so
// it is the one route that must count attempts. 60/minute is ~600 guesses per code lifetime against a
// ~594-million code space, while real pairing volume is a handful per day across all users.
router.post(
  '/whatsapp-personal/bridge-token',
  rateLimit({ key: 'bridge-token-claim', windowSeconds: 60, max: 60 }),
  (req, res) => {
    void whatsappPersonalController.claimToken(req, res);
  },
);

// Instant revocation — the reason a bridge token is a database row and not a JWT.
router.delete('/whatsapp-personal/devices/:id', requireAuth, (req, res) => {
  void whatsappPersonalController.revokeDevice(req, res);
});

/**
 * ── Approve-to-send email over WhatsApp (`whatsapp_email_approval`) ─────────────────────────────────
 *
 * A per-user opt-in, off by default, letting the user ask Stewra to send email from WhatsApp. It never
 * sends on its own: Stewra drafts the mail and the user approves it on a signed-in surface. Because email
 * is irreversible and a WhatsApp identity is a weaker factor than a login, turning the opt-in ON requires
 * the account password (re-verified server-side, in the service). Turning it OFF removes a capability and
 * needs no password. Verified email required to change it, like the other channel-binding acts above.
 */
router.get('/whatsapp-email-approval', requireAuth, (req, res) => {
  void whatsappEmailApprovalController.status(req, res);
});

router.post('/whatsapp-email-approval', requireAuth, verified, (req, res) => {
  void whatsappEmailApprovalController.set(req, res);
});

export default router;
