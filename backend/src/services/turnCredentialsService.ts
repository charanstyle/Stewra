import crypto from 'crypto';
import type { TurnCredentialsResponse } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig';

/**
 * Mints ephemeral TURN credentials for the coturn running in `use-auth-secret` (RFC 5766 REST) mode on
 * the shared `home` host, under Stewra's OWN realm + static-auth-secret (distinct from the TrueTalk and
 * RankRise realms that coexist on the same coturn). coturn validates the credential as:
 *
 *   username   = "<unix-expiry>:<userId>"
 *   credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
 *
 * The static secret is shared only between this backend and coturn — clients never see it; they receive
 * a short-lived username/credential pair that expires after `turnCredTtlSeconds`.
 *
 * No public STUN fallback is emitted: calls force-relay through our own TURN so connectivity is
 * guaranteed and observable. If TURN is misconfigured the call fails loud rather than silently degrading
 * to a direct path that may not traverse NAT.
 */
export class TurnCredentialsService {
  generate(userId: string): TurnCredentialsResponse {
    const ttlSeconds = config.calls.turnCredTtlSeconds;
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
    const username = `${expiry}:${userId}`;
    const credential = crypto
      .createHmac('sha1', config.calls.turnSecret)
      .update(username)
      .digest('base64');

    return {
      iceServers: [
        {
          urls: config.calls.turnUrls,
          username,
          credential,
        },
      ],
      ttlSeconds,
    };
  }
}

export const turnCredentialsService = new TurnCredentialsService();
