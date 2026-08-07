import type { CommerceJob, CommerceJobKind } from '@stewra/shared-types';

/**
 * What a handler says happened.
 *
 * Three outcomes, and the difference between the last two is the whole reason this is a return value
 * rather than a boolean:
 *
 *   `done`   — the work is finished.
 *   `retry`  — it failed, and trying again later might work. Meta returned a 500; the database was
 *              restarting; a rate limit was hit.
 *   `failed` — it failed, and trying again cannot help. The contact is on the suppression list, the
 *              channel was disconnected, the payload does not parse.
 *
 * A handler that cannot distinguish these should THROW rather than guess. An unhandled exception is
 * treated as `retry`, because "we do not know what went wrong" is not grounds for giving up — and
 * the attempt ceiling stops that from meaning forever.
 *
 * The reverse default would be worse in both directions: giving up on an unknown error silently
 * drops work a client was promised, and retrying something the consent gate refused is another
 * attempt to message a person who asked to be left alone.
 */
export type JobOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'retry'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * One kind of background work.
 *
 * `handle` is given the whole job, not just the payload, because attempt count and age change what a
 * handler should reasonably do — a send on its last attempt may want to record a different reason
 * than the same send on its first.
 *
 * **Handlers must be idempotent.** A job whose lease expires mid-flight is claimed again by another
 * worker, and a handler that had already sent a message when its process died will be asked to send
 * it a second time. There is no way for the queue to know how far a handler got, so the handler is
 * the only place this can be solved: check for the provider message id, the existing row, the
 * already-rotated credential, before doing the thing again.
 */
export interface JobHandler {
  readonly kind: CommerceJobKind;
  handle(job: CommerceJob): Promise<JobOutcome>;
}
