import type { RunnerSessionStatus } from '@stewra/shared-types';

/**
 * Stewra's voice on the conversational surfaces (WhatsApp and the chat thread) — the words of a superb
 * executive assistant: calm, warm, plain English. Lead with what happened or what will happen, then the
 * one thing the person needs to do, and stop. Never an id, a status code or a stack of parentheses.
 *
 * The runner speaks in machine strings because the API and the fleet page read them; this module is
 * where those strings are said in words before they reach a person. The known ones get a sentence. An
 * unknown one is passed through verbatim, because an unexplained failure is worse than an ugly one —
 * this is translation, never a swallow.
 */

/** "qa-macos, qa-linux and Mac mini" — the way a person lists things. */
export function listInWords(names: ReadonlyArray<string>, conjunction: 'and' | 'or' = 'and'): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`;
}

/** A session status, as a person would say it. */
export function statusInWords(status: RunnerSessionStatus): string {
  switch (status) {
    case 'starting':
      return 'just starting';
    case 'running':
      return 'in progress';
    case 'awaiting-permission':
      return 'waiting for your OK';
    case 'completed':
      return 'finished';
    case 'failed':
      return "didn't finish";
    case 'cancelled':
      return 'stopped';
  }
}

/**
 * The runner's done-summary, in words. Today it is `stopReason: <reason>` from the agent protocol:
 * `end_turn` is the ordinary ending and is not worth a sentence; anything else means the agent stopped
 * early and the person should hear so. A summary in prose already is returned as it is.
 */
export function summaryInWords(summary: string | null | undefined): string {
  if (summary === undefined || summary === null) return '';
  const text = summary.trim();
  if (text.length === 0) return '';
  const stop = /^stopReason:\s*(\S+)$/.exec(text);
  if (stop === null) return text;
  const reason = stop[1] ?? '';
  if (reason === 'end_turn') return '';
  if (reason === 'max_tokens') return 'It ran out of room before it could finish, so the work may be incomplete.';
  if (reason === 'refusal') return 'The coding agent declined to do that.';
  return `It stopped early (${reason.replace(/_/g, ' ')}).`;
}

/**
 * A runner error, in words. The runner's failures are `code: detail` strings so the control surface can
 * branch on them; a person should hear the reason, not the code.
 */
export function errorInWords(error: string): string {
  const text = error.trim();
  const coded = /^([a-z_]+):\s*(.*)$/s.exec(text);
  const code = coded?.[1] ?? text;
  switch (code) {
    case 'no_remote':
      return "that folder isn't linked to a remote repository, so there's nowhere to push to";
    case 'gh_missing':
      return "the GitHub CLI isn't installed on that machine, and I need it to open a pull request";
    case 'unknown_session':
      return 'that machine no longer has the finished work — it may have been restarted since';
    case 'runner_wake_timeout':
      return 'your cloud runner is taking longer than usual to wake up';
    case 'device_offline':
      return "that machine isn't reachable at the moment";
    default:
      return text;
  }
}

/** "21 Aug, 10:05" — when a machine was last heard from, said briefly. */
export function lastSeenInWords(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
