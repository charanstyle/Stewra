import { z } from 'zod';
import type { ChannelAccount } from '@stewra/shared-types';
import type { ChannelAccountMeta } from '../../database/types.js';
import {
  channelAccountRepository,
  toChannelAccount,
} from '../repositories/channelAccountRepository.js';
import type { GraphCall } from './metaGraph.js';
import { describeGraphFailure, graphRequest } from './metaGraph.js';
import { config } from '../../config/unifiedConfig.js';
import { vault } from '../../control-plane/vault/vault.js';
import { ServiceUnavailableError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Meta EMBEDDED SIGNUP — how a client connects their OWN WhatsApp Business Account.
 *
 * This is the piece that makes the product self-serve. Today's personal-assistant channel has one
 * phone number for the whole install, configured in env; here every organization brings its own,
 * grants Stewra permission through Meta's dialog, and the resulting token is stored per-organization
 * in the vault.
 *
 * The browser's half of the flow returns only a short-lived authorization CODE. Everything after
 * that happens here, server-side, because the exchange needs the app secret — and because the WABA
 * id the code resolves to must be read from Meta rather than accepted from the client. A client that
 * could name its own WABA id could claim one it does not own; `debug_token` is what makes the claim
 * checkable, and it is the reason this service does not take an `externalAccountId` parameter.
 */

/** `POST /oauth/access_token` — the business token the rest of the flow is performed with. */
const tokenExchangeSchema = z.object({ access_token: z.string().min(1) });

/**
 * `GET /debug_token` — the authoritative statement of what the grant actually covers.
 *
 * `granular_scopes` is where Meta reports WHICH WhatsApp Business Accounts the user granted, as
 * `target_ids` under the `whatsapp_business_management` scope. This is the only trustworthy source
 * for the WABA id.
 */
const debugTokenSchema = z.object({
  data: z.object({
    granular_scopes: z
      .array(z.object({ scope: z.string(), target_ids: z.array(z.string()).optional() }))
      .optional(),
    /**
     * Unix seconds at which the credential dies, or 0 for one that never does.
     *
     * Not decorative. The only Meta login configuration that grants the full WhatsApp management
     * permission set issues a token expiring in 60 days, so for every account connected through the
     * current configuration this is a real deadline with a real consequence — and `debug_token` is
     * the only place Meta states it. Reading it here costs nothing: the call is already being made
     * to find out which WABA was granted.
     */
    expires_at: z.number().optional(),
  }),
});

/**
 * What Meta's `expires_at` actually means, in one place.
 *
 * Three different answers collapse into "no expiry": the field absent, 0, and a negative number. All
 * three are recorded as null rather than as a date, because null is the honest statement "this
 * credential does not expire" and any date we invented would eventually make the sweep either
 * renew a permanent token forever or declare a live one dead.
 */
function toExpiryDate(expiresAt: number | undefined): Date | null {
  if (expiresAt === undefined || expiresAt <= 0) return null;
  return new Date(expiresAt * 1000);
}

/** A credential and the deadline Meta puts on it. */
export interface TokenLifetime {
  readonly token: string;
  /** Null when Meta reports no expiry. */
  readonly expiresAt: Date | null;
}

/** `GET /{waba-id}` — display metadata for the connected account. */
const wabaSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  currency: z.string().optional(),
});

/**
 * `GET /{waba-id}/phone_numbers` — the sending identities under the account.
 *
 * `status` is what decides whether a registration PIN is needed. Meta reports `CONNECTED` for a
 * number already registered to this app, and something else (`PENDING`, `MIGRATED`, `FLAGGED`, …)
 * for one that is not. Asking every client for a PIN they may not need — and may not have to hand —
 * would turn the common reconnect case into a dead end.
 */
const phoneNumbersSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_phone_number: z.string().optional(),
      verified_name: z.string().optional(),
      quality_rating: z.string().optional(),
      status: z.string().optional(),
    }),
  ),
});

/** Meta reports this for a number already registered to the calling app. */
const REGISTERED_STATUS = 'CONNECTED';

class MetaEmbeddedSignupService {
  /**
   * What the browser needs to open the signup dialog. The app secret is deliberately not in it: only
   * the app id and the configuration id are meant to be public, and the exchange happens here.
   */
  publicConfig(): { appId: string; configId: string; graphVersion: string } {
    const meta = config.metaCommerce;
    if (!meta.enabled) {
      throw new ServiceUnavailableError('Connecting a WhatsApp account is not enabled on this install.');
    }
    return { appId: meta.appId, configId: meta.configId, graphVersion: meta.graphVersion };
  }

  /**
   * Graph, with this service's own refusal message when the integration is off.
   *
   * The request itself lives in `metaGraph.ts`, shared with template management — one place that
   * parses Meta's responses rather than asserts them, and one place that surfaces Meta's error body
   * verbatim. The wrapper survives only for the wording: a client who clicked Connect should be told
   * that connecting is not enabled, not that an integration they have never heard of is unconfigured.
   */
  private async graph<S extends z.ZodTypeAny>(call: GraphCall, schema: S): Promise<z.infer<S>> {
    if (!config.metaCommerce.enabled) {
      throw new ServiceUnavailableError('Connecting a WhatsApp account is not enabled on this install.');
    }
    return graphRequest(call, schema);
  }

  /**
   * Complete the connect: exchange the code, discover the WABA and its number, subscribe the app to
   * that WABA's webhooks, vault the token, and record the account.
   *
   * Ordering is deliberate, and each position is load-bearing:
   *
   *  - A missing PIN is caught FIRST, before anything irreversible. The commonest failure is a client
   *    who does not have their number's PIN to hand, and that must cost them nothing.
   *  - The webhook subscription is made BEFORE the row is written, so a stored account is always one
   *    that will actually receive inbound messages; a subscription without a row merely delivers
   *    events for a WABA nobody claims, and that path already drops them with a warning.
   *  - Registration happens LAST, after the row exists. A rejected PIN then leaves a channel that
   *    receives but cannot send, labelled with Meta's own reason — which is recoverable — instead of
   *    throwing the whole grant away and making them run Embedded Signup again.
   */
  async connect(params: {
    orgId: string;
    code: string;
    pin: string | undefined;
  }): Promise<ChannelAccount> {
    const meta = config.metaCommerce;
    if (!meta.enabled) {
      throw new ServiceUnavailableError('Connecting a WhatsApp account is not enabled on this install.');
    }

    // The code is exchanged with the APP's own credentials, so this call carries no bearer token of
    // its own — the client_secret in the query is the authentication.
    const exchanged = await this.graph(
      {
        path: 'oauth/access_token',
        accessToken: `${meta.appId}|${meta.appSecret}`,
        query: {
          client_id: meta.appId,
          client_secret: meta.appSecret,
          code: params.code,
        },
      },
      tokenExchangeSchema,
    );
    const businessToken = exchanged.access_token;

    const { wabaId, expiresAt } = await this.readGrant(businessToken);
    const waba = await this.graph(
      { path: wabaId, accessToken: businessToken, query: { fields: 'id,name,currency' } },
      wabaSchema,
    );
    const numbers = await this.graph(
      {
        path: `${wabaId}/phone_numbers`,
        accessToken: businessToken,
        query: { fields: 'id,display_phone_number,verified_name,quality_rating,status' },
      },
      phoneNumbersSchema,
    );

    const number = numbers.data[0];
    if (number === undefined) {
      throw new ValidationError('Validation failed', [
        {
          field: 'phoneNumber',
          message:
            'That WhatsApp Business Account has no phone number yet. Add one in Meta Business ' +
            'Manager, then connect again.',
        },
      ]);
    }

    // A number Meta already reports as CONNECTED is registered to this app and needs no PIN. Asking
    // for one anyway would block every reconnect behind a secret the client may no longer have.
    const needsRegistration = number.status !== REGISTERED_STATUS;
    if (needsRegistration && params.pin === undefined) {
      // Refused HERE, before the webhook subscription and before anything is vaulted, so a client
      // who simply does not have the PIN to hand loses nothing and can retry.
      throw new ValidationError('Validation failed', [
        {
          field: 'pin',
          message:
            'This number needs its six-digit two-step verification PIN to be registered for ' +
            'sending. Find it in WhatsApp Manager under Two-step verification, then connect again.',
        },
      ]);
    }

    // Subscribe THIS app to the WABA's webhooks. Without it Meta has been granted permission but
    // still delivers nothing, and the client would see a connected channel that never receives a
    // message — the silent half-failure this ordering exists to prevent.
    await this.graph(
      { path: `${wabaId}/subscribed_apps`, method: 'POST', accessToken: businessToken },
      z.object({ success: z.boolean().optional() }),
    );

    const credentialRef = await vault.put(businessToken);
    // The WABA's billing currency selects the rate card its messages are billed from (migration
    // 051). Normalized to the uppercase ISO shape the column checks; anything else — including
    // Meta reporting nothing — is stored honestly as null, and those messages surface on the cost
    // report under `unrated_no_currency` instead of being billed under a guessed currency.
    const reportedCurrency = waba.currency?.trim().toUpperCase() ?? null;
    const billingCurrency =
      reportedCurrency !== null && /^[A-Z]{3}$/.test(reportedCurrency) ? reportedCurrency : null;
    if (billingCurrency === null) {
      logger.warn('meta commerce: WABA reported no usable billing currency', {
        orgId: params.orgId,
        wabaId,
        reported: waba.currency ?? null,
      });
    }
    const accountMeta: ChannelAccountMeta = {
      ...(waba.name === undefined ? {} : { businessId: waba.id }),
      ...(number.verified_name === undefined ? {} : { verifiedName: number.verified_name }),
      ...(number.quality_rating === undefined ? {} : { qualityRating: number.quality_rating }),
    };

    let connected: Awaited<ReturnType<typeof channelAccountRepository.upsert>>;
    try {
      connected = await channelAccountRepository.upsert({
        orgId: params.orgId,
        platform: 'whatsapp_cloud',
        externalAccountId: wabaId,
        phoneNumberId: number.id,
        billingCurrency,
        displayName: number.display_phone_number ?? waba.name ?? wabaId,
        // The same value as `displayName` in the common case, and deliberately NOT the fallback
        // chain. Anything that points AT this number — a `wa.me` opt-in link, a printed QR — needs
        // digits Meta actually gave us; a WABA name that happens to contain some would open a chat
        // with a stranger. Null is the honest answer when Meta reported no number.
        displayPhoneNumber: number.display_phone_number ?? null,
        credentialRef,
        credentialExpiresAt: expiresAt,
        meta: accountMeta,
      });
    } catch (error) {
      // The row was not written, so nothing references this secret. Leaving it would be an orphaned
      // credential at rest — worse than the failure the client is about to be shown.
      await vault.delete(credentialRef).catch((cleanupError: unknown) => {
        logger.error('commerce: failed to remove an orphaned credential after a failed connect', {
          orgId: params.orgId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
      throw error;
    }

    // A reconnect supersedes the old token. Dead credentials are not kept at rest.
    if (connected.supersededCredentialRef !== null) {
      await vault.delete(connected.supersededCredentialRef);
    }

    if (needsRegistration && params.pin !== undefined) {
      await this.registerNumber({
        channelAccountId: connected.account.id,
        phoneNumberId: number.id,
        pin: params.pin,
        businessToken,
      });
    }

    return toChannelAccount(connected.account);
  }

  /**
   * Register the number for Cloud API sending. Without this Meta accepts the connection but refuses
   * every send, so a channel that skipped it would look healthy and be inert.
   *
   * A rejected PIN does NOT roll the connection back. The row stays, marked `error` with Meta's own
   * words, which means: inbound keeps arriving (the business still sees its customers), the channel
   * list shows exactly what is wrong, and the fix is re-running connect with the right PIN rather
   * than re-running Meta's whole authorization dialog. `channelAccountService.resolve` already
   * refuses to build a sender for a non-active account, so nothing can send in the meantime.
   *
   * The PIN itself is used once and never stored. It belongs to the client's number, not to us, and
   * a stored 2FA PIN is a liability with no corresponding benefit — registration is not repeated on
   * a normal reconnect, because Meta reports the number as CONNECTED by then.
   */
  private async registerNumber(params: {
    channelAccountId: string;
    phoneNumberId: string;
    pin: string;
    businessToken: string;
  }): Promise<void> {
    try {
      await this.graph(
        {
          path: `${params.phoneNumberId}/register`,
          method: 'POST',
          accessToken: params.businessToken,
          query: { messaging_product: 'whatsapp', pin: params.pin },
        },
        z.object({ success: z.boolean().optional() }),
      );
    } catch (error) {
      const detail =
        'This number is connected for receiving but is not registered for sending. Meta rejected ' +
        `the registration PIN: ${describeGraphFailure(error)}`;
      await channelAccountRepository.markError(params.channelAccountId, detail);
      logger.warn('commerce: phone number registration rejected', {
        channelAccountId: params.channelAccountId,
        error: detail,
      });
      throw new ValidationError('Validation failed', [{ field: 'pin', message: detail }]);
    }
  }

  /**
   * Ask Meta for a fresh credential in place of one that is about to expire.
   *
   * `grant_type=fb_exchange_token` is the only renewal Meta exposes that does not put the client
   * back through the authorization dialog. What it will do with a 60-day Embedded Signup token is
   * NOT something this code assumes: the result is re-read through `debug_token` and the new expiry
   * is reported as fact, whatever it turns out to be. If Meta hands back the same deadline, the
   * caller sees that it did not move and asks the client to reconnect — which is the outcome the
   * whole expiry path is built around, not a fallback bolted on afterwards.
   *
   * Throws on refusal. A renewal that failed is information the caller needs; the old token is still
   * valid until its deadline, so there is nothing to paper over and no reason to invent a result.
   */
  async extendCredential(currentToken: string): Promise<TokenLifetime> {
    const meta = config.metaCommerce;
    if (!meta.enabled) {
      throw new ServiceUnavailableError('Connecting a WhatsApp account is not enabled on this install.');
    }

    const exchanged = await this.graph(
      {
        path: 'oauth/access_token',
        accessToken: currentToken,
        query: {
          grant_type: 'fb_exchange_token',
          client_id: meta.appId,
          client_secret: meta.appSecret,
          fb_exchange_token: currentToken,
        },
      },
      tokenExchangeSchema,
    );

    // Read the NEW token's expiry from Meta rather than assuming the exchange bought 60 more days.
    // This is the same discipline as `readGrant`: what Meta says about a credential is the only
    // trustworthy statement about it, and the difference between the two dates is precisely what
    // decides whether the client has to be asked to reconnect.
    const described = await this.graph(
      {
        path: 'debug_token',
        accessToken: exchanged.access_token,
        query: { input_token: exchanged.access_token },
      },
      debugTokenSchema,
    );

    return { token: exchanged.access_token, expiresAt: toExpiryDate(described.data.expires_at) };
  }

  /**
   * Which WhatsApp Business Account the user actually granted, according to Meta.
   *
   * Read from `granular_scopes` rather than taken from the client. A single grant covering several
   * WABAs is refused rather than resolved by picking the first: choosing on the client's behalf
   * means connecting a business they did not mean to connect, and there is no way to tell from here
   * which one they wanted.
   *
   * Returns the credential's expiry alongside it, because the same response carries both.
   * Asking twice for something Meta has already said is how the two answers end up
   * disagreeing.
   */
  private async readGrant(
    businessToken: string,
  ): Promise<{ wabaId: string; expiresAt: Date | null }> {
    const meta = config.metaCommerce;
    if (!meta.enabled) {
      throw new ServiceUnavailableError('Connecting a WhatsApp account is not enabled on this install.');
    }
    const debug = await this.graph(
      {
        path: 'debug_token',
        accessToken: `${meta.appId}|${meta.appSecret}`,
        query: { input_token: businessToken },
      },
      debugTokenSchema,
    );

    const targets =
      debug.data.granular_scopes?.find((s) => s.scope === 'whatsapp_business_management')
        ?.target_ids ?? [];

    if (targets.length === 0) {
      throw new ValidationError('Validation failed', [
        {
          field: 'code',
          message:
            'That authorization did not include a WhatsApp Business Account. Run the connect flow ' +
            'again and grant access to the business you want to message from.',
        },
      ]);
    }
    if (targets.length > 1) {
      throw new ValidationError('Validation failed', [
        {
          field: 'code',
          message:
            'That authorization covers more than one WhatsApp Business Account. Connect them one ' +
            'at a time so the right business is linked.',
        },
      ]);
    }
    // Length is exactly 1 here, so this index is real; the check above is what makes it so.
    const [wabaId] = targets;
    if (wabaId === undefined) throw new Error('unreachable: granted WABA list changed size');
    return { wabaId, expiresAt: toExpiryDate(debug.data.expires_at) };
  }
}

export const metaEmbeddedSignupService = new MetaEmbeddedSignupService();
