import { z } from 'zod';
import { config } from '../config/unifiedConfig.js';

/**
 * The Plaid adapter (control plane). Mirrors `googleOAuthService` in role — consent start, token
 * exchange, minimized fetchers, revoke, and the "is this terminal?" predicate — and the Stripe
 * provider in mechanics: plain fetch against a per-deploy base URL (test stand-in friendly), zod
 * parsing of every response, no SDK. The long-lived access token is handled only transiently here;
 * it lives in the vault and never appears in a log, a row, or a response.
 *
 * Amounts: Plaid sends decimal numbers; we convert to bigint MICROS exactly once, here, rounding at
 * micro precision (far below any real currency's smallest unit). Positive = money leaving the
 * account, Plaid's own sign convention, preserved unchanged.
 */

/** A JSON-serializable request body — what every Plaid endpoint accepts. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

/** Plaid's structured error body — kept so callers can tell terminal auth loss from a blip. */
export class PlaidApiError extends Error {
  constructor(
    readonly errorType: string,
    readonly errorCode: string,
    message: string,
  ) {
    super(`plaid: ${errorType}/${errorCode}: ${message}`);
    this.name = 'PlaidApiError';
  }
}

/**
 * Error codes that mean the Item's grant is gone and no retry will fix it — the user must
 * reconnect. The analogue of `isGoogleAuthError`: the sync fails fast and the connection is
 * flipped to `revoked` so the UI says so plainly.
 */
const TERMINAL_ITEM_ERROR_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'INVALID_ACCESS_TOKEN',
  'ITEM_NOT_FOUND',
  'ACCESS_NOT_GRANTED',
  'ITEM_LOCKED',
]);

export function isPlaidAuthError(error: unknown): boolean {
  return error instanceof PlaidApiError && TERMINAL_ITEM_ERROR_CODES.has(error.errorCode);
}

const errorBodySchema = z.object({
  error_type: z.string(),
  error_code: z.string(),
  error_message: z.string(),
});

/** Narrow the config or refuse: every entry point below requires an enabled aggregator. */
function plaidConfig(): Extract<typeof config.moneyAggregator, { enabled: true }> {
  const money = config.moneyAggregator;
  if (!money.enabled) {
    throw new Error('plaid: MONEY_AGGREGATOR_ENABLED is false — no aggregator is configured');
  }
  return money;
}

/**
 * One Plaid POST. Credentials ride in the body per Plaid's convention. A non-2xx with Plaid's
 * structured error body becomes a PlaidApiError (so terminal codes are recognizable); anything
 * else — network failure, malformed body — throws as-is and is treated as transient by callers.
 */
async function plaidRequest<S extends z.ZodTypeAny>(
  path: string,
  body: { readonly [key: string]: JsonValue },
  schema: S,
): Promise<z.infer<S>> {
  const money = plaidConfig();
  const response = await fetch(`${money.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: money.clientId, secret: money.secret, ...body }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsedError = errorBodySchema.safeParse(payload);
    if (parsedError.success) {
      throw new PlaidApiError(
        parsedError.data.error_type,
        parsedError.data.error_code,
        parsedError.data.error_message,
      );
    }
    throw new Error(`plaid: ${path} failed with HTTP ${response.status}`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`plaid: ${path} returned an unexpected shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Convert Plaid's decimal amount to bigint micros. Exact for every real-world amount (doubles are
 * exact integers up to 2^53; micros of ~$9 billion). Null stays null — never invented. */
export function toMicros(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

const linkTokenSchema = z.object({ link_token: z.string().min(1) });

/** Create the short-lived token that opens Plaid Link on the client. */
export async function createLinkToken(userId: string): Promise<string> {
  const money = plaidConfig();
  const data = await plaidRequest(
    '/link/token/create',
    {
      user: { client_user_id: userId },
      client_name: 'Stewra',
      products: [...money.products],
      country_codes: [...money.countryCodes],
      language: 'en',
    },
    linkTokenSchema,
  );
  return data.link_token;
}

const exchangeSchema = z.object({
  access_token: z.string().min(1),
  item_id: z.string().min(1),
});

/** Exchange Link's one-time public token for the long-lived access token + the Item's id. */
export async function exchangePublicToken(
  publicToken: string,
): Promise<{ accessToken: string; itemId: string }> {
  const data = await plaidRequest(
    '/item/public_token/exchange',
    { public_token: publicToken },
    exchangeSchema,
  );
  return { accessToken: data.access_token, itemId: data.item_id };
}

const accountsSchema = z.object({
  accounts: z.array(
    z.object({
      account_id: z.string().min(1),
      name: z.string().default(''),
      type: z.string().default(''),
      subtype: z.string().nullable().default(null),
      mask: z.string().nullable().default(null),
      balances: z.object({
        available: z.number().nullable(),
        current: z.number().nullable(),
        iso_currency_code: z.string().nullable(),
      }),
    }),
  ),
});

/** A minimized account snapshot — already reduced to what the money store persists. */
export interface PlaidAccount {
  readonly accountId: string;
  readonly name: string;
  readonly type: string;
  readonly subtype: string;
  readonly mask: string;
  readonly isoCurrencyCode: string | null;
  readonly availableMicros: bigint | null;
  readonly currentMicros: bigint | null;
}

/** Current accounts + live balances for an Item. */
export async function fetchAccounts(accessToken: string): Promise<ReadonlyArray<PlaidAccount>> {
  const data = await plaidRequest(
    '/accounts/balance/get',
    { access_token: accessToken },
    accountsSchema,
  );
  return data.accounts.map((a) => ({
    accountId: a.account_id,
    name: a.name,
    type: a.type,
    subtype: a.subtype ?? '',
    mask: a.mask ?? '',
    isoCurrencyCode: a.balances.iso_currency_code,
    availableMicros: a.balances.available === null ? null : toMicros(a.balances.available),
    currentMicros: a.balances.current === null ? null : toMicros(a.balances.current),
  }));
}

const syncTransactionSchema = z.object({
  transaction_id: z.string().min(1),
  account_id: z.string().min(1),
  // merchant_name is Plaid's cleaned merchant; name is the raw descriptor. Prefer the clean one.
  name: z.string().default(''),
  merchant_name: z.string().nullable().default(null),
  personal_finance_category: z.object({ primary: z.string() }).nullable().default(null),
  amount: z.number(),
  iso_currency_code: z.string().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pending: z.boolean(),
});

const transactionsSyncSchema = z.object({
  added: z.array(syncTransactionSchema),
  modified: z.array(syncTransactionSchema),
  removed: z.array(z.object({ transaction_id: z.string().min(1) })),
  next_cursor: z.string(),
  has_more: z.boolean(),
});

/** A minimized transaction — merchant + category + amount + date, nothing else crosses. */
export interface PlaidTransaction {
  readonly transactionId: string;
  readonly accountId: string;
  readonly merchant: string;
  readonly category: string;
  readonly amountMicros: bigint;
  readonly isoCurrencyCode: string | null;
  readonly postedAt: string;
  readonly pending: boolean;
}

export interface TransactionsSyncPage {
  readonly added: ReadonlyArray<PlaidTransaction>;
  readonly modified: ReadonlyArray<PlaidTransaction>;
  readonly removedIds: ReadonlyArray<string>;
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

function toTransaction(t: z.infer<typeof syncTransactionSchema>): PlaidTransaction {
  return {
    transactionId: t.transaction_id,
    accountId: t.account_id,
    merchant: t.merchant_name ?? t.name,
    category: t.personal_finance_category?.primary ?? '',
    amountMicros: toMicros(t.amount),
    isoCurrencyCode: t.iso_currency_code,
    postedAt: t.date,
    pending: t.pending,
  };
}

/** One page of /transactions/sync. Callers loop on `hasMore`, persisting the cursor each page. */
export async function transactionsSync(
  accessToken: string,
  cursor: string | null,
): Promise<TransactionsSyncPage> {
  const data = await plaidRequest(
    '/transactions/sync',
    { access_token: accessToken, ...(cursor === null ? {} : { cursor }) },
    transactionsSyncSchema,
  );
  return {
    added: data.added.map(toTransaction),
    modified: data.modified.map(toTransaction),
    removedIds: data.removed.map((r) => r.transaction_id),
    nextCursor: data.next_cursor,
    hasMore: data.has_more,
  };
}

/** Sever the Item at Plaid (their side of a disconnect). Returns whether Plaid acknowledged it —
 * callers treat a failure as best-effort, exactly like revoking a Google refresh token. */
export async function removeItem(accessToken: string): Promise<boolean> {
  try {
    await plaidRequest('/item/remove', { access_token: accessToken }, z.object({}).passthrough());
    return true;
  } catch (error) {
    // An Item Plaid no longer knows is already severed — that is the outcome we wanted.
    if (isPlaidAuthError(error)) {
      return true;
    }
    return false;
  }
}
