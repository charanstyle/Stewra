import type { Project } from '@stewra/shared-types';

process.env['RUNNER_ENABLED'] = 'true';
process.env['RUNNER_DOWNLOAD_URL'] = 'https://downloads.example.test/stewra-runner';
process.env['RUNNER_MIN_VERSION'] = '0.2.0';
process.env['RUNNER_LATEST_VERSION'] = '0.2.0';

const { looksLikeRunnerIntent, normalizeName, isClarifyingAsk, lastAssistantTurn, userNamedDevice } =
  await import('../services/runnerIntentService.js');

/**
 * The keyword gate in front of the runner classifier. It is the cheapest thing in the pipeline and the
 * one that, before projects existed, let "start a session on Truetalk" fall through to the ordinary
 * agent — none of `start`, `session`, `Truetalk` was a runner word. Now the person's own project names
 * and aliases are part of the gate, matched the way a transcriber would mangle them.
 */
function project(name: string, aliases: string[] = []): Project {
  return {
    id: `id-${name}`,
    orgId: 'org',
    name,
    slug: name.toLowerCase(),
    repoName: name,
    gitRemote: null,
    githubOwner: null,
    githubRepo: null,
    defaultBranch: 'main',
    aliases,
    description: '',
    createdBy: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const PROJECTS = [project('Truetalk'), project('LookedTwice', ['RankRise', 'rank']), project('MyMoneyWorthy')];

describe('the runner intent gate', () => {
  it('passes the generic runner words, including the ones the old regex missed', () => {
    for (const text of [
      'start a session on the mac mini',
      'run lint on that project',
      'commit what you have',
      'what\'s running?',
      'is the MacBook up?',
      'push it',
    ]) {
      expect(looksLikeRunnerIntent(text, []), text).toBe(true);
    }
  });

  it('passes a project named as written, spoken with a space, or by an alias', () => {
    expect(looksLikeRunnerIntent('start a session on Truetalk and fix the failing test', PROJECTS)).toBe(true);
    expect(looksLikeRunnerIntent('start a session on true talk', PROJECTS)).toBe(true);
    expect(looksLikeRunnerIntent('fix the build on looked twice', PROJECTS)).toBe(true);
    expect(looksLikeRunnerIntent('fix the build on RankRise', PROJECTS)).toBe(true);
    expect(looksLikeRunnerIntent('my money worthy needs a new logo', PROJECTS)).toBe(true);
  });

  it('does not pass ordinary chatter, and ignores aliases too short to be safe', () => {
    expect(looksLikeRunnerIntent('what time is my dentist appointment?', PROJECTS)).toBe(false);
    expect(looksLikeRunnerIntent('thanks, that was helpful', PROJECTS)).toBe(false);
    // Without the length floor the alias "rank" would fire here — "frank" contains it.
    expect(looksLikeRunnerIntent('call frank back', [project('LookedTwice', ['ra'])])).toBe(false);
  });

  it('normalizes the way a transcriber mangles a name', () => {
    expect(normalizeName('True Talk')).toBe('truetalk');
    expect(normalizeName('My-Money Worthy!')).toBe('mymoneyworthy');
  });
});

describe('recognizing Stewra\'s own clarifying questions', () => {
  // The exact sentences `resolve` produces. Answering one ("on the Mac mini") must be read as the original
  // request with the blank filled in — there is no proposal to confirm, and "There's nothing waiting to
  // start right now." was the bug this guards against.
  it('matches the three which-machine / which-project / which-checkout asks', () => {
    expect(
      isClarifyingAsk('LookedTwice is ready on more than one machine — MacBook Pro or Mac mini. Which one?'),
    ).toBe(true);
    expect(isClarifyingAsk('Which project — Stewra, Truetalk? Or name a machine: Mac mini.')).toBe(true);
    expect(isClarifyingAsk('Which checkout on Mac mini — rank or rank-v2?')).toBe(true);
  });

  it('does not match proposals, refusals, or ordinary replies', () => {
    expect(isClarifyingAsk("There's nothing waiting to start right now.")).toBe(false);
    expect(isClarifyingAsk('I\'ll run the test suite on LookedTwice on the Mac mini — shall I start?')).toBe(false);
    expect(isClarifyingAsk(null)).toBe(false);
  });

  it('accepts a machine only when the user\'s words name it', () => {
    expect(userNamedDevice('on the Mac mini', 'Mac mini')).toBe(true);
    expect(userNamedDevice('run it on the mini please', 'Mac mini')).toBe(true);
    expect(userNamedDevice('use the macbook', 'MacBook Pro')).toBe(true);
    // A repeated request with no machine in it — the case the model was seen guessing on.
    expect(userNamedDevice('start a session on Truetalk and fix the failing test', 'Mac mini')).toBe(false);
    expect(userNamedDevice('start a session on Truetalk and fix the failing test', 'MacBook Pro')).toBe(false);
    // "pro" and "mac" alone are too short to count.
    expect(userNamedDevice('make it a proper fix', 'MacBook Pro')).toBe(false);
    expect(userNamedDevice('', 'Mac mini')).toBe(false);
  });

  it('finds the latest Stewra line, skipping the user\'s own turns', () => {
    const history = [
      { role: 'assistant' as const, content: 'Hello' },
      { role: 'assistant' as const, content: ' Which checkout on Mac mini — a or b? ' },
      { role: 'user' as const, content: 'on the Mac mini' },
    ];
    expect(lastAssistantTurn(history)).toBe('Which checkout on Mac mini — a or b?');
    expect(lastAssistantTurn([{ role: 'user' as const, content: 'hi' }])).toBeNull();
  });
});
