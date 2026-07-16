import { chooseModelProvider } from '../agent-host/modelProvider.js';

/**
 * Pure selection logic: the local Claude CLI is preferred whenever it's runnable; every API provider
 * is a fallback used only when the CLI isn't there. No process spawn — availability is injected.
 */
describe('chooseModelProvider (CLI preferred, API providers are fallback)', () => {
  it('prefers the CLI when it is runnable and the preference is on', () => {
    for (const fallbackProvider of ['anthropic', 'openai', 'gemini', 'grok'] as const) {
      expect(
        chooseModelProvider({ preferClaudeCli: true, cliAvailable: true, fallbackProvider }),
      ).toBe('claude_cli');
    }
  });

  it('falls back to the configured API provider when the CLI is not runnable', () => {
    expect(
      chooseModelProvider({ preferClaudeCli: true, cliAvailable: false, fallbackProvider: 'anthropic' }),
    ).toBe('anthropic');
    expect(
      chooseModelProvider({ preferClaudeCli: true, cliAvailable: false, fallbackProvider: 'openai' }),
    ).toBe('openai');
  });

  it('honours an API fallback verbatim even when the CLI IS available but the preference is off', () => {
    expect(
      chooseModelProvider({ preferClaudeCli: false, cliAvailable: true, fallbackProvider: 'anthropic' }),
    ).toBe('anthropic');
  });

  it('uses the CLI when it is the explicit choice and runnable, regardless of the preference flag', () => {
    expect(
      chooseModelProvider({ preferClaudeCli: false, cliAvailable: true, fallbackProvider: 'claude_cli' }),
    ).toBe('claude_cli');
  });

  it('fails loud when the CLI is the only provider but is not runnable', () => {
    expect(() =>
      chooseModelProvider({ preferClaudeCli: true, cliAvailable: false, fallbackProvider: 'claude_cli' }),
    ).toThrow(/not runnable/i);
    // Same outcome with the preference off — an explicit CLI choice that can't run must not degrade silently.
    expect(() =>
      chooseModelProvider({ preferClaudeCli: false, cliAvailable: false, fallbackProvider: 'claude_cli' }),
    ).toThrow(/not runnable/i);
  });
});
