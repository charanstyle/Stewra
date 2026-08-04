import { describe, it, expect } from 'vitest';
import { RUNNER_CREDENTIAL_FORMS, runnerCredentialProblem } from '@stewra/shared-types';

/**
 * The form check that stands between a pasted provider login and a container.
 *
 * This is the ONLY place the check is cheap to make: `hostedRunnerController` runs it on the request
 * body, and the runner runs it again at spawn (`harnessCommand.ts`). Both read this one function, so
 * the two cannot disagree about what a valid Claude Code login looks like.
 *
 * The values below are structurally realistic but authenticate as nothing — the point is the SHAPE.
 */

// A well-formed value of each accepted Claude form. Bodies are nonsense; only the prefix is load-bearing.
const OAUTH_LOGIN = 'sk-ant-oat01-notarealtokenjustshapedlikeone';
const API_KEY_LOGIN = 'sk-ant-api03-notarealkeyjustshapedlikeone';

describe('runnerCredentialProblem', () => {
  it('accepts both documented Claude Code forms', () => {
    // Both are legitimate user choices — a subscription token and a metered API key — and rejecting
    // either would lock a paying user out of the harness they actually have.
    expect(runnerCredentialProblem('claude-code', OAUTH_LOGIN)).toBeNull();
    expect(runnerCredentialProblem('claude-code', API_KEY_LOGIN)).toBeNull();
  });

  it('rejects a credential of no recognised form, naming what to paste instead', () => {
    const problem = runnerCredentialProblem('claude-code', 'ghp_this-is-a-github-token-not-an-anthropic-one');

    expect(problem).not.toBeNull();
    // Naming both forms is the entire value of failing early: "invalid credential" would leave the
    // user to guess which of their several tokens was wanted.
    expect(problem).toContain('sk-ant-oat');
    expect(problem).toContain('sk-ant-api');
  });

  it('rejects a credential with surrounding whitespace rather than silently trimming it', () => {
    // Trimming for them would hide that the copy was sloppy, and the same sloppy copy pasted into a
    // field that does NOT trim (a shell, an env file) would then fail for a reason they have already
    // been taught to ignore.
    expect(runnerCredentialProblem('claude-code', `  ${OAUTH_LOGIN}`)).toContain('whitespace');
    expect(runnerCredentialProblem('claude-code', `${OAUTH_LOGIN}\n`)).toContain('whitespace');
  });

  it('rejects a credential that was clearly truncated or line-wrapped mid-paste', () => {
    // A terminal-wrapped token arrives with a newline in the MIDDLE. It has the right prefix, so a
    // prefix-only check would pass it, and the container would then fail to authenticate.
    const wrapped = `${OAUTH_LOGIN.slice(0, 20)}\n${OAUTH_LOGIN.slice(20)}`;

    expect(runnerCredentialProblem('claude-code', wrapped)).toContain('line break');
  });

  it('accepts any non-empty form for a harness whose credential shape is not documented', () => {
    // Deliberate: asserting a shape we are unsure of would reject a VALID key at the paste field,
    // which is worse than accepting a bad one and surfacing it at session start. Guard the intent —
    // if someone later adds a form for these, this test should be updated, not silently pass.
    expect(RUNNER_CREDENTIAL_FORMS['gemini-cli']).toBeUndefined();
    expect(RUNNER_CREDENTIAL_FORMS['codex']).toBeUndefined();
    expect(runnerCredentialProblem('gemini-cli', 'AIzaSyNotARealGoogleApiKey')).toBeNull();
  });

  it('still rejects a whitespace-damaged paste for an undocumented harness', () => {
    // The prefix check is harness-specific; the "was this copied whole?" check is not.
    expect(runnerCredentialProblem('gemini-cli', 'AIza notarealkey')).toContain('line break');
  });
});
