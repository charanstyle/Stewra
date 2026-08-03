import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harnessEnv } from '../core/harnessCommand.js';

/**
 * Credential slots: the one path by which a user's provider login reaches a coding agent inside a
 * Stewra-hosted container.
 *
 * Real files on a real filesystem, because the thing under test IS the file read — a slot that "works"
 * against a stubbed reader would prove only that the stub returns what it was told to.
 *
 * The variable name `claude-code` maps to is not a guess: it was verified end-to-end against the real
 * `claude-agent-acp` adapter, the real Claude Agent SDK and the real `claude` CLI, by recording the
 * environment the CLI is spawned with.
 *
 * Every credential below is a syntactically-shaped fake. The PREFIX is the part under test — it is what
 * decides which variable the login lands in — so the fixtures carry real prefixes and nonsense bodies.
 */
describe('harnessEnv credential slots', () => {
  let dir: string;
  const saved = process.env['STEWRA_RUNNER_CREDENTIALS_DIR'];

  // `claude setup-token` output: spends the user's Claude subscription.
  const OAUTH_LOGIN = 'sk-ant-oat01-not-a-real-token-only-the-prefix-matters-here';
  // Anthropic console key: metered per token against the user's API account.
  const API_KEY_LOGIN = 'sk-ant-api03-not-a-real-key-only-the-prefix-matters-here';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stewra-creds-test-'));
    await mkdir(dir, { recursive: true });
    process.env['STEWRA_RUNNER_CREDENTIALS_DIR'] = dir;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env['STEWRA_RUNNER_CREDENTIALS_DIR'];
    else process.env['STEWRA_RUNNER_CREDENTIALS_DIR'] = saved;
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    delete process.env['ANTHROPIC_API_KEY'];
    await rm(dir, { recursive: true, force: true });
  });

  it('turns a claude-code slot into the variable the claude CLI authenticates with', async () => {
    await writeFile(join(dir, 'claude-code'), `${OAUTH_LOGIN}\n`);

    const env = await harnessEnv('claude-code');

    // Trailing newline stripped: a shell heredoc or an editor would add one, and the CLI would send it.
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(OAUTH_LOGIN);
  });

  it('routes a pasted API key to the API-key variable, not the OAuth one', async () => {
    // The CLI reads the two forms from different variables. Writing a key into the OAuth variable
    // authenticates as nothing, and surfaces mid-session as a generic auth failure rather than at paste.
    await writeFile(join(dir, 'claude-code'), API_KEY_LOGIN);

    const env = await harnessEnv('claude-code');

    expect(env['ANTHROPIC_API_KEY']).toBe(API_KEY_LOGIN);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('refuses a claude-code login whose form it does not recognise', async () => {
    // Defaulting into one variable or the other would spend the wrong account when it happened to work,
    // and be unexplainable when it did not. Name both accepted forms at spawn time instead.
    await writeFile(join(dir, 'claude-code'), 'pasted-the-wrong-thing-entirely');

    await expect(harnessEnv('claude-code')).rejects.toThrow(/not a recognised credential/);
  });

  it('maps each harness to its own variable, and leaves other harnesses untouched', async () => {
    await writeFile(join(dir, 'gemini-cli'), 'user-supplied-gemini-login');

    const gemini = await harnessEnv('gemini-cli');
    const claude = await harnessEnv('claude-code');

    expect(gemini['GEMINI_API_KEY']).toBe('user-supplied-gemini-login');
    // A gemini slot must not leak into a claude session — they are different users' different providers.
    expect(claude['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(claude['GEMINI_API_KEY']).toBeUndefined();
  });

  it('refuses loudly when a login is supplied for a harness it cannot pass one to', async () => {
    // `codex` is deliberately unmapped. Ignoring the slot would run the session unauthenticated and
    // surface as a confusing auth error from the agent; this names the real cause at spawn time.
    await writeFile(join(dir, 'codex'), 'user-supplied-codex-login');

    await expect(harnessEnv('codex')).rejects.toThrow(/does not know how to pass one to it/);
  });

  it('lets the slot win over an inherited variable of the same name', async () => {
    // The image, or the host, may already carry a token. On a machine Stewra runs, the login the USER
    // gave us is the authority — otherwise a stale build-time value would silently bill someone else.
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'value-baked-into-the-image';
    await writeFile(join(dir, 'claude-code'), OAUTH_LOGIN);

    const env = await harnessEnv('claude-code');

    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(OAUTH_LOGIN);
  });

  it('still strips an ambient Anthropic API key, so a subscription login is what gets spent', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'someone-elses-metered-key';
    await writeFile(join(dir, 'claude-code'), OAUTH_LOGIN);

    const env = await harnessEnv('claude-code');

    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(OAUTH_LOGIN);
  });

  it("replaces an ambient API key with the user's own, rather than stripping it too", async () => {
    // The strip exists to stop an accident of the environment being spent. A key the user pasted is a
    // stated choice, so it must survive the strip that removes the ambient one.
    process.env['ANTHROPIC_API_KEY'] = 'someone-elses-metered-key';
    await writeFile(join(dir, 'claude-code'), API_KEY_LOGIN);

    const env = await harnessEnv('claude-code');

    expect(env['ANTHROPIC_API_KEY']).toBe(API_KEY_LOGIN);
  });

  it('sets no provider variable at all when the user has supplied no login', async () => {
    // A runner provisioned without credentials must still start, clone, and report its harnesses. It
    // simply has nobody logged in yet.
    const env = await harnessEnv('claude-code');

    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect('PATH' in env).toBe(true);
  });

  it('treats an empty slot file as no login rather than an empty credential', async () => {
    // An interrupted write leaves a zero-byte file. Passing "" would make the CLI fail authentication
    // with a corrupt-looking credential instead of the honest "you have not logged in".
    await writeFile(join(dir, 'claude-code'), '   \n');

    const env = await harnessEnv('claude-code');

    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });
});
