import type { z } from 'zod';
import { config } from '../../config/unifiedConfig.js';
import { ServiceUnavailableError, ValidationError } from '../../utils/errors.js';

/**
 * ONE way to call Meta's Graph API from the commerce plane.
 *
 * Every call goes through here so three things are true in one place rather than in each caller:
 *
 *  1. **The response is PARSED, never asserted.** Graph is a remote service whose shapes change on
 *     Meta's schedule. A cast would turn a renamed field into a confident `undefined` several frames
 *     away from the request that caused it; a zod parse fails at the call, naming the path.
 *  2. **Meta's error body is surfaced verbatim.** "(#132000) Number of parameters does not match the
 *     expected number of params" is the single most useful sentence a client can be shown when a
 *     template send fails, and it exists only inside Meta's response.
 *  3. **A disabled integration REFUSES.** With no commerce Meta app there is no Graph version to call
 *     and no app secret to verify webhooks with, so there is nothing to degrade to.
 */

/** What every Graph call needs, plus whichever of body and query it uses. */
export interface GraphCall {
  readonly path: string;
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly query?: Readonly<Record<string, string>>;
  /** Sent as a JSON body. Template creation is the only thing here that needs one. */
  readonly body?: unknown;
  readonly accessToken: string;
}

/**
 * Call Graph and validate what comes back.
 *
 * The token is passed per call rather than held anywhere: in the commerce plane it belongs to one
 * organization, is read from the vault at the moment of use, and must not outlive the operation.
 */
export async function graphRequest<S extends z.ZodTypeAny>(
  call: GraphCall,
  schema: S,
): Promise<z.infer<S>> {
  const meta = config.metaCommerce;
  if (!meta.enabled) {
    throw new ServiceUnavailableError('The commerce Meta integration is not configured.');
  }

  const url = new URL(`${meta.graphBaseUrl}/${meta.graphVersion}/${call.path}`);
  for (const [key, value] of Object.entries(call.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: call.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${call.accessToken}`,
      ...(call.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    // Meta's error body says which permission is missing or which id was rejected — the single most
    // useful thing a client can be told when a call fails, so it is not swallowed.
    throw new ValidationError('Validation failed', [
      { field: 'meta', message: `Meta rejected the request (${response.status}): ${text}` },
    ]);
  }

  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`Unexpected response shape from Meta at ${call.path}: ${text}`);
  }
  return parsed.data;
}

/**
 * Pull the human-readable reason out of a failure raised by {@link graphRequest}.
 *
 * `ValidationError.message` is the fixed string 'Validation failed' by convention — the real text
 * lives in `details`. Reading `.message` would replace Meta's actual explanation with a phrase that
 * tells the client nothing, which is exactly what an error-detail field exists to prevent.
 */
export function describeGraphFailure(error: unknown): string {
  if (error instanceof ValidationError && error.details.length > 0) {
    return error.details.map((d) => d.message).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}
