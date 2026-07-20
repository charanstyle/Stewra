import type { ExtendedError } from 'socket.io';
import { runnerService } from '../services/runnerService.js';
import { logger } from '../utils/logger.js';
import type { RunnerHandshakeSocketLike } from './runnerTypes.js';

/**
 * Handshake auth for the `/runner` namespace.
 *
 * A runner presents a DEVICE token, never a user's access token, and this middleware is why the two can't
 * be confused: it resolves the token through `runnerService.authenticateRunner` (a database lookup by
 * hash), not through `authService.verifyToken` (a JWT check). A user's JWT fails here — there is no row
 * for it — and a runner token fails on the main namespace, because it isn't a JWT. The separation is
 * structural, not a check someone has to remember.
 *
 * The lookup also makes revocation instant: the user hits Revoke, the row is deleted, and the very next
 * connect from that machine is refused.
 */
export function runnerAuthMiddleware(
  socket: RunnerHandshakeSocketLike,
  next: (err?: ExtendedError) => void,
): void {
  const fromAuth = socket.handshake.auth.token;
  const header = socket.handshake.headers.authorization;
  const fromHeader =
    typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : undefined;
  const token = typeof fromAuth === 'string' && fromAuth.length > 0 ? fromAuth : fromHeader;

  if (token === undefined || token.length === 0) {
    next(new Error('Missing runner token'));
    return;
  }

  void runnerService
    .authenticateRunner(token)
    .then((identity) => {
      if (identity === null) {
        // Unknown, revoked, or the feature is switched off — all indistinguishable to the caller.
        logger.debug('runner auth rejected', { socketId: socket.id });
        next(new Error('Invalid or revoked runner token'));
        return;
      }
      socket.data.userId = identity.userId;
      socket.data.deviceId = identity.deviceId;
      next();
    })
    .catch((error: unknown) => {
      logger.error('runner auth failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      next(new Error('Runner authentication failed'));
    });
}
