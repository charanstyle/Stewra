import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { runnerController } from '../controllers/runnerController.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';

const router = Router();

/**
 * The Stewra Runner — a coding-agent host on the user's OWN machine (a laptop, or a cloud VM they own).
 *
 * Pairing a runner is a security-relevant act (that machine can run code the user starts from Stewra), so
 * minting a code requires a VERIFIED email, exactly like linking a data source or a messaging channel.
 */
const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

router.get('/', requireAuth, (req, res) => {
  void runnerController.status(req, res);
});

router.get('/devices', requireAuth, (req, res) => {
  void runnerController.listDevices(req, res);
});

// Mint the single-use code the user pastes into `stewra-runner pair <code>`.
router.post('/pair', requireAuth, verified, (req, res) => {
  void runnerController.startPairing(req, res);
});

// Called by the RUNNER process, which holds no user session — the single-use pairing code is the
// credential. Deliberately NOT behind requireAuth: a process carrying the user's access token would hold
// the whole account, when all it needs is permission to run sessions the user starts.
//
// It is therefore the only guessable, unauthenticated way to obtain a token that speaks for a user, so it
// is rate-limited: 60/minute against a large code space, while real pairing volume is a handful per day.
router.post(
  '/runner-token',
  rateLimit({ key: 'runner-token-claim', windowSeconds: 60, max: 60 }),
  (req, res) => {
    void runnerController.claimToken(req, res);
  },
);

// Instant revocation — the reason a runner token is a database row and not a JWT.
router.delete('/devices/:id', requireAuth, (req, res) => {
  void runnerController.revokeDevice(req, res);
});

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────────
// A session starts a coding agent on one of the user's machines; it requires a verified email for the same
// reason pairing does. Prompt/permission/cancel act on an already-started session the user owns.

router.get('/sessions', requireAuth, (req, res) => {
  void runnerController.listSessions(req, res);
});

router.post('/sessions', requireAuth, verified, (req, res) => {
  void runnerController.startSession(req, res);
});

router.post('/sessions/:id/prompt', requireAuth, verified, (req, res) => {
  void runnerController.promptSession(req, res);
});

router.post('/sessions/:id/permission', requireAuth, verified, (req, res) => {
  void runnerController.decidePermission(req, res);
});

router.post('/sessions/:id/cancel', requireAuth, (req, res) => {
  void runnerController.cancelSession(req, res);
});

export default router;
