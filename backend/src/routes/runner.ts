import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { hostedRunnerController } from '../controllers/hostedRunnerController.js';
import { runnerController } from '../controllers/runnerController.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';
import { requireHostedRunnerDevice, requireRunnerDevice } from '../middleware/requireRunnerDevice.js';

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

// ── Hosted (cloud) runner ────────────────────────────────────────────────────────────────────────────
// The cloud-first path: Stewra provisions and runs the container itself. Provisioning creates real
// infrastructure that can execute code and holds the user's repositories, so every mutating route here
// requires a VERIFIED email — the same bar as pairing a machine, for the same reason.
//
// These are declared BEFORE the `/sessions` block only for readability; Express matches on the literal
// path, and none of these collide with `/devices/:id` or `/sessions/:id`.

router.get('/hosted', requireAuth, (req, res) => {
  void hostedRunnerController.status(req, res);
});

router.post('/hosted', requireAuth, verified, (req, res) => {
  void hostedRunnerController.provision(req, res);
});

router.post('/hosted/start', requireAuth, verified, (req, res) => {
  void hostedRunnerController.start(req, res);
});

router.post('/hosted/stop', requireAuth, verified, (req, res) => {
  void hostedRunnerController.stop(req, res);
});

// Destroys the container AND its volumes — the cloned repositories and anything uncommitted go with it.
router.delete('/hosted', requireAuth, verified, (req, res) => {
  void hostedRunnerController.destroy(req, res);
});

router.put('/hosted/credentials/:harness', requireAuth, verified, (req, res) => {
  void hostedRunnerController.updateCredential(req, res);
});

// ── Runner-facing (device token, hosted containers only) ─────────────────────────────────────────────
// Called by the RUNNER process, not a browser: authenticated by its device token, exactly like its
// socket. `requireHostedRunnerDevice` is what keeps the laptop invariant intact — a credential Stewra
// minted may reach a container Stewra runs, and never a machine it does not control.
//
// Deliberately NOT rate-limited, unlike `/runner-token` above. That limiter exists for an endpoint that
// is unauthenticated and guessable, and its bucket is GLOBAL (see middleware/rateLimit.ts) — putting an
// authenticated, per-operation endpoint behind it would let one runner in a retry loop deny every other
// user's git. The real protections here are stronger anyway: the caller must hold a live device token
// (revoking it shuts the door instantly), and `githubAppService` caches installation tokens in memory,
// so a chatty runner costs a map lookup rather than a request to GitHub.
router.post('/git-credentials', requireRunnerDevice, requireHostedRunnerDevice, (req, res) => {
  void hostedRunnerController.gitCredentials(req, res);
});

router.get('/hosted/workspaces', requireRunnerDevice, requireHostedRunnerDevice, (req, res) => {
  void hostedRunnerController.workspaces(req, res);
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

// Git follow-through on a finished session: push the isolated branch to its remote, or open a PR. Both act
// on the user's own machine (the runner does the git with the machine's credentials), so they require a
// verified email like starting a session does.
router.post('/sessions/:id/push', requireAuth, verified, (req, res) => {
  void runnerController.pushSession(req, res);
});

router.post('/sessions/:id/pr', requireAuth, verified, (req, res) => {
  void runnerController.openPr(req, res);
});

export default router;
