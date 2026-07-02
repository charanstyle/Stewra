import type { ExtendedError } from 'socket.io';
import { authService } from '../services/authService';
import { logger } from '../utils/logger';
import type { AppSocket } from './types';

/**
 * Socket.IO handshake auth. Reads the access token from `handshake.auth.token` (the idiomatic client
 * path) or a `Bearer` Authorization header, verifies it through the SAME `authService.verifyToken`
 * the REST middleware uses (claim `{ sub, type:'access' }`), and pins `socket.data.userId`. A missing
 * or invalid token rejects the connection — there is no anonymous socket.
 */
export function socketAuthMiddleware(socket: AppSocket, next: (err?: ExtendedError) => void): void {
  const fromAuth = socket.handshake.auth?.['token'];
  const header = socket.handshake.headers.authorization;
  const fromHeader =
    typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : undefined;
  const token = typeof fromAuth === 'string' && fromAuth.length > 0 ? fromAuth : fromHeader;

  if (token === undefined || token.length === 0) {
    next(new Error('Missing authentication token'));
    return;
  }

  try {
    socket.data.userId = authService.verifyToken(token, 'access');
    next();
  } catch {
    // Do not leak whether the token was malformed vs expired.
    logger.debug('socket auth rejected', { socketId: socket.id });
    next(new Error('Invalid or expired token'));
  }
}
