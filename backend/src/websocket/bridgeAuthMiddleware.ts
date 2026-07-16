import type { ExtendedError } from 'socket.io';
import { whatsappPersonalService } from '../services/whatsappPersonalService.js';
import { logger } from '../utils/logger.js';
import type { BridgeHandshakeSocketLike } from './bridgeTypes.js';

/**
 * Handshake auth for the `/bridge` namespace.
 *
 * A bridge presents a DEVICE token, never a user's access token, and this middleware is the reason those
 * two can't be confused: it resolves the token through `bridgeDeviceRepository` (a database lookup by
 * hash), not through `authService.verifyToken` (a JWT signature check). A user's JWT therefore fails here
 * — there is no row for it — and a bridge token fails on the main namespace, because it isn't a JWT.
 * The separation is structural rather than a check somebody has to remember to write.
 *
 * The lookup also means revocation is instant: the user hits Revoke, the row is deleted, and the very
 * next connect (or reconnect) from that machine is refused.
 */
export function bridgeAuthMiddleware(
  socket: BridgeHandshakeSocketLike,
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
    next(new Error('Missing bridge token'));
    return;
  }

  void whatsappPersonalService
    .authenticateBridge(token)
    .then((identity) => {
      if (identity === null) {
        // Unknown, revoked, or the channel is switched off entirely — all indistinguishable to the caller.
        logger.debug('bridge auth rejected', { socketId: socket.id });
        next(new Error('Invalid or revoked bridge token'));
        return;
      }
      socket.data.userId = identity.userId;
      socket.data.deviceId = identity.deviceId;
      next();
    })
    .catch((error: unknown) => {
      logger.error('bridge auth failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      next(new Error('Bridge authentication failed'));
    });
}
