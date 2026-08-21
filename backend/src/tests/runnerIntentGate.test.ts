import type { Project } from '@stewra/shared-types';

process.env['RUNNER_ENABLED'] = 'true';
process.env['RUNNER_DOWNLOAD_URL'] = 'https://downloads.example.test/stewra-runner';
process.env['RUNNER_MIN_VERSION'] = '0.2.0';
process.env['RUNNER_LATEST_VERSION'] = '0.2.0';

const {
  looksLikeRunnerIntent,
  normalizeName,
  isClarifyingAsk,
  lastAssistantTurn,
  userNamedDevice,
  openExchangeUserText,
  turnReachesClassifier,
} = await import('../services/runnerIntentService.js');

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

  it('passes the plurals and participles people actually say', () => {
    // Both of these were asked on WhatsApp and both failed the gate: `\bmachine\b` does not match
    // "machines" and `\brun\b` does not match "running". The turn never reached the fleet, the ordinary
    // agent answered instead, and — with no fleet in front of it — described machines that do not exist.
    for (const text of [
      'Which machines do I have right now',
      'What is running on the Mac mini right now?',
      'are my laptops online',
      'which projects are set up',
      'how many sessions are there',
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
  it('matches the which-machine / which-project / which-folder asks', () => {
    expect(
      isClarifyingAsk('LookedTwice is set up on MacBook Pro and Mac mini — which would you like me to use?'),
    ).toBe(true);
    expect(isClarifyingAsk('Which project is this for — Stewra or Truetalk? Or just tell me the machine: Mac mini.')).toBe(true);
    expect(isClarifyingAsk('Which machine would you like — Mac mini or MacBook Pro?')).toBe(true);
    expect(isClarifyingAsk('Which folder on Mac mini — rank or rank-v2?')).toBe(true);
  });

  it('does not match proposals, refusals, or ordinary replies', () => {
    expect(isClarifyingAsk("There's nothing waiting on a go-ahead from you at the moment.")).toBe(false);
    expect(isClarifyingAsk('Just to confirm: the test suite on LookedTwice, using Mac mini. Shall I go ahead?')).toBe(false);
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

  it('keeps a machine named earlier in the same open exchange, but not one from a finished request', () => {
    // Pass 6 on WhatsApp: "Which one?" → "on qa-macos" → "What command?" → "npm run lint". The machine
    // was named in the middle piece and must still count for the last one.
    const open = [
      { role: 'user' as const, content: 'run the linter on Sandbox' },
      { role: 'assistant' as const, content: 'Sandbox is set up on qa-macos and qa-linux — which would you like me to use?' },
      { role: 'user' as const, content: 'on qa-macos' },
      { role: 'assistant' as const, content: 'What command should I run for the linter — npm run lint or something else?' },
    ];
    expect(userNamedDevice(openExchangeUserText(open, 'npm run lint'), 'qa-macos')).toBe(true);
    expect(userNamedDevice(openExchangeUserText(open, 'npm run lint'), 'qa-linux')).toBe(false);

    // A statement from Stewra (a proposal) closes the exchange: the earlier "on qa-macos" is not carried
    // into a fresh request, so `resolve` will ask again rather than silently reuse it.
    const closed = [
      ...open,
      { role: 'user' as const, content: 'npm run lint' },
      { role: 'assistant' as const, content: 'Just to confirm: "npm run lint" on Sandbox, using qa-macos. Shall I go ahead?' },
      { role: 'user' as const, content: 'no' },
      { role: 'assistant' as const, content: "Understood — I'll leave it." },
    ];
    expect(userNamedDevice(openExchangeUserText(closed, 'run the tests on Sandbox'), 'qa-macos')).toBe(false);
    expect(openExchangeUserText([], 'on the mini')).toBe('on the mini');
  });

  it('lets the answer to Stewra\'s own question through the gate even with no runner word in it', () => {
    // "on qa-macos" is meaningful only because of the "Which one?" before it. Seen live on WhatsApp:
    // the gate returned null and the ordinary agent replied that it had no tool to target a machine.
    const asked = [
      { role: 'user' as const, content: 'run npm run lint on Sandbox' },
      { role: 'assistant' as const, content: 'Sandbox is set up on qa-macos and qa-linux — which would you like me to use?' },
    ];
    const base = { latestUserText: 'on qa-macos', projects: [project('Sandbox')], hasPendingProposal: false, hasPendingPermission: false };
    expect(turnReachesClassifier({ ...base, history: asked })).toBe(true);
    // The same words after an ordinary reply do not: nothing is being answered.
    expect(turnReachesClassifier({ ...base, history: [{ role: 'assistant' as const, content: "Nothing's running at the moment." }] })).toBe(false);
    expect(turnReachesClassifier({ ...base, history: [] })).toBe(false);
    // A pending proposal or permission keeps a bare "yes" meaningful, as before.
    expect(turnReachesClassifier({ ...base, latestUserText: 'yes', history: [], hasPendingProposal: true })).toBe(true);
    expect(turnReachesClassifier({ ...base, latestUserText: 'yes', history: [], hasPendingPermission: true })).toBe(true);
  });

  it('finds the latest Stewra line, skipping the user\'s own turns', () => {
    const history = [
      { role: 'assistant' as const, content: 'Hello' },
      { role: 'assistant' as const, content: ' Which folder on Mac mini — a or b? ' },
      { role: 'user' as const, content: 'on the Mac mini' },
    ];
    expect(lastAssistantTurn(history)).toBe('Which folder on Mac mini — a or b?');
    expect(lastAssistantTurn([{ role: 'user' as const, content: 'hi' }])).toBeNull();
  });
});
