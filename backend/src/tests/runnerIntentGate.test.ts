import type { Project } from '@stewra/shared-types';

process.env['RUNNER_ENABLED'] = 'true';
process.env['RUNNER_DOWNLOAD_URL'] = 'https://downloads.example.test/stewra-runner';
process.env['RUNNER_MIN_VERSION'] = '0.2.0';
process.env['RUNNER_LATEST_VERSION'] = '0.2.0';

const { looksLikeRunnerIntent, normalizeName } = await import('../services/runnerIntentService.js');

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
