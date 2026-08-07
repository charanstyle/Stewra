import type { CommerceJobKind } from '@stewra/shared-types';
import type { JobHandler } from './types.js';
import { channelTokenRefreshHandler } from './channelTokenRefreshHandler.js';
import { templateSyncHandler } from './templateSyncHandler.js';
import { broadcastDispatchHandler } from './broadcastDispatchHandler.js';
import { broadcastSendHandler } from './broadcastSendHandler.js';

/**
 * Every job kind, mapped to the thing that runs it.
 *
 * Typed as `Record<CommerceJobKind, JobHandler>` deliberately: adding a kind to `COMMERCE_JOB_KINDS`
 * without adding a handler here stops the build. The alternative — discovering it at runtime — means
 * jobs of the new kind are enqueued successfully, claimed, and then quietly not run, which looks
 * exactly like a slow queue right up until someone reads the table.
 */
const HANDLERS: Record<CommerceJobKind, JobHandler> = {
  channel_token_refresh: channelTokenRefreshHandler,
  template_sync: templateSyncHandler,
  broadcast_dispatch: broadcastDispatchHandler,
  broadcast_send: broadcastSendHandler,
};

/**
 * The handler for a kind, or null if the row holds a kind this build does not know.
 *
 * That is reachable despite the type: `kind` is a varchar the database will accept anything in, and a
 * rollback to an older build meets jobs a newer one enqueued. Null rather than a throw so the worker
 * can put that single job out of its misery without the whole pass dying on it.
 */
export function handlerFor(kind: CommerceJobKind): JobHandler | null {
  const handler: JobHandler | undefined = HANDLERS[kind];
  if (handler === undefined) return null;
  return handler;
}
