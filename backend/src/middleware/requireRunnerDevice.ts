import type { NextFunction, Request, Response } from 'express';
import { runnerService } from '../services/runnerService.js';
import { AuthenticationError, ForbiddenError } from '../utils/errors.js';

/**
 * Authenticate a REST request made BY A RUNNER, using its device token.
 *
 * The REST mirror of `runnerAuthMiddleware` (which does this for the `/runner` socket namespace), and it
 * resolves the token through exactly the same `runnerService.authenticateRunner`, so revocation behaves
 * identically on both surfaces: the row is gone, the token resolves to nothing, every door shuts at once.
 *
 * It sets `req.runnerDevice`, never `req.userId`. A runner is not the user — it is a process the user
 * authorised to run coding agents — and a route protected by `requireAuth` must never be satisfiable by
 * a device token just because both middlewares happened to fill the same property.
 */
export function requireRunnerDevice(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) {
    next(new AuthenticationError('Missing or malformed runner device token'));
    return;
  }
  const token = header.slice('Bearer '.length).trim();

  void runnerService
    .authenticateRunner(token)
    .then((device) => {
      if (device === null) {
        // A revoked device and a forged token are indistinguishable here, which is the intended
        // behaviour: revocation deletes the row, so there is nothing left to tell them apart.
        next(new AuthenticationError('That runner device token is not valid'));
        return;
      }
      req.runnerDevice = device;
      next();
    })
    .catch((error: unknown) => {
      next(error);
    });
}

/**
 * Require that the authenticated runner is one STEWRA HOSTS.
 *
 * This is the laptop invariant, enforced: the endpoints behind this hand out credentials Stewra minted
 * (a GitHub installation token) and repository lists derived from the user's App installation. Those may
 * only ever reach a container Stewra created and controls. A paired laptop does its own git with its own
 * credentials — Stewra has never seen them and must never supply a substitute.
 *
 * Use AFTER `requireRunnerDevice`.
 */
export function requireHostedRunnerDevice(req: Request, _res: Response, next: NextFunction): void {
  const device = req.runnerDevice;
  if (device === undefined) {
    next(new Error('requireRunnerDevice middleware missing'));
    return;
  }
  if (device.kind !== 'hosted') {
    next(
      new ForbiddenError(
        'This endpoint is only available to Stewra-hosted runners; a runner on your own machine uses its own credentials',
      ),
    );
    return;
  }
  next();
}
