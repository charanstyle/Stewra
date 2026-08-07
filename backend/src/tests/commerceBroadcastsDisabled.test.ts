import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';

/**
 * What a broadcast surface does when nothing is there to send it.
 *
 * `startCommerceScheduler` returns before `commerceWorker.start()` when `META_COMMERCE_ENABLED` is
 * false, and argues there that enqueue and drain must never be separable — a deploy that enqueues
 * without draining looks healthy, because every enqueue succeeds. That argument did not reach the
 * API: `create` wrote a broadcast row, enqueued its dispatch, and answered 201, so a client was told
 * their campaign was scheduled while it sat in `commerce_jobs` with no worker in the process that
 * would ever claim it. Nothing failed. Nothing sent. That is the shape this file exists to rule out.
 *
 * The env is pinned here rather than inherited: sibling commerce suites set the flag to 'true' at
 * module scope, and `process.env` outlives a module registry reset, so a file that merely declined to
 * set it would assert the opposite of its name depending on which suite ran first.
 */
process.env['META_COMMERCE_ENABLED'] = 'false';

const { broadcastService } = await import('../commerce/services/broadcastService.js');
const { NotFoundError, ServiceUnavailableError } = await import('../utils/errors.js');

/**
 * Deliberately not seeded. The refusal is the FIRST thing `create` does — before the channel account,
 * the segment, or the template are looked up — so ids that match nothing are the sharper test: if
 * these throw `NotFoundError` instead, the guard has drifted below a lookup and a disabled install is
 * once again writing rows before it refuses.
 */
function unsavedBroadcast() {
  return {
    orgId: randomUUID(),
    createdByUserId: randomUUID(),
    name: 'Spring sale',
    channelAccountId: randomUUID(),
    segmentId: randomUUID(),
    templateId: randomUUID(),
    variables: [] as readonly string[],
    scheduledFor: new Date(Date.now() + 60_000),
  };
}

describe('broadcasts, with the commerce integration disabled', () => {
  it('refuses to schedule a campaign nothing would ever dispatch', async () => {
    await expect(broadcastService.create(unsavedBroadcast())).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it('answers 503 rather than 400 — the request is fine, the install is not', async () => {
    // The distinction is not cosmetic. A 400 tells a client to change their request, which would not
    // help: this exact body succeeds unchanged the moment the operator turns the integration on.
    const error = await broadcastService.create(unsavedBroadcast()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as InstanceType<typeof ServiceUnavailableError>).statusCode).toBe(503);
  });

  it('names the flag to set, so the fix does not need a code read', async () => {
    const error = await broadcastService.create(unsavedBroadcast()).catch((e: unknown) => e);

    expect((error as Error).message).toContain('META_COMMERCE_ENABLED');
  });

  it('refuses BEFORE looking anything up, so a disabled install writes nothing', async () => {
    // Every id above is unseeded. Reaching a lookup would surface NotFoundError; reaching the insert
    // would leave a row. Getting ServiceUnavailableError proves the guard still sits above both.
    const error = await broadcastService.create(unsavedBroadcast()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).not.toBeInstanceOf(NotFoundError);
  });

  it('refuses to resume a paused broadcast onto a queue with no worker', async () => {
    // Guarded before the status transition, not after: moving a broadcast to `running` and then
    // failing to enqueue would leave a row whose name claims work is happening while nothing holds it.
    await expect(
      broadcastService.resume(randomUUID(), randomUUID()),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});
