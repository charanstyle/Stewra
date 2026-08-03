import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { githubAppController } from '../controllers/githubAppController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';

const router = Router();

/**
 * The Stewra GitHub App — click-through repository access for the hosted runner.
 *
 * Linking an installation is a security-relevant act (it decides which repositories code can be run
 * against from Stewra), so it requires a VERIFIED email — the same bar as pairing a runner or linking
 * a messaging channel.
 */
const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

router.get('/', requireAuth, (req, res) => {
  void githubAppController.status(req, res);
});

// Called by the setup page GitHub redirected back to, carrying installation_id + the signed state.
router.post('/installations', requireAuth, verified, (req, res) => {
  void githubAppController.link(req, res);
});

router.delete('/installations', requireAuth, (req, res) => {
  void githubAppController.unlink(req, res);
});

export default router;
