/**
 * Pure model-provider selection — no I/O, no process spawn, no config import — so it is unit-testable
 * in isolation. The host (`modelClient`) probes the CLI's availability and feeds the result in here.
 */

/** The concrete model providers the host can build a client for (`anthropic` last, per the config). */
export type ModelProvider = 'claude_cli' | 'openai' | 'gemini' | 'grok' | 'anthropic';

/**
 * Decide the EFFECTIVE provider: the local Claude CLI is preferred whenever it's runnable (it uses the
 * operator's Claude Code subscription — no API key, no per-token cost), and every API provider is a
 * fallback used only when the CLI isn't there.
 *
 *  - prefer on + CLI runnable               → `claude_cli`
 *  - fallback is `claude_cli`, runnable      → `claude_cli` (explicit CLI choice, prefer off)
 *  - fallback is `claude_cli`, NOT runnable  → throw: the operator asked for the CLI and it's absent,
 *    with no API fallback configured — fail loud rather than silently degrade.
 *  - otherwise                               → the configured API fallback (`anthropic` last)
 */
export function chooseModelProvider(opts: {
  preferClaudeCli: boolean;
  cliAvailable: boolean;
  fallbackProvider: ModelProvider;
}): ModelProvider {
  if (opts.preferClaudeCli && opts.cliAvailable) {
    return 'claude_cli';
  }
  if (opts.fallbackProvider === 'claude_cli') {
    if (!opts.cliAvailable) {
      throw new Error(
        'The Claude CLI is the configured provider but is not runnable on this host, and no fallback ' +
          'API provider is set. Install/authenticate the Claude CLI, or set MODEL_PROVIDER to an API ' +
          'provider (openai|gemini|grok|anthropic) with its API key + MODEL_ID.',
      );
    }
    return 'claude_cli';
  }
  return opts.fallbackProvider;
}
