import { errorInWords, listInWords, statusInWords, summaryInWords } from '../services/runnerVoice.js';

/**
 * The runner's machine strings, as Stewra says them to a person. Seen live on WhatsApp before this
 * existed: "Done on qa-macos (Sandbox). stopReason: end_turn" and "I couldn't push that: no_remote:
 * workspace has no "origin" remote to push to".
 */
describe("Stewra's voice for runner strings", () => {
  it('lists names the way a person would', () => {
    expect(listInWords([])).toBe('');
    expect(listInWords(['Mac mini'])).toBe('Mac mini');
    expect(listInWords(['Mac mini', 'MacBook Pro'], 'or')).toBe('Mac mini or MacBook Pro');
    expect(listInWords(['qa-macos', 'qa-linux', 'Mac mini'])).toBe('qa-macos, qa-linux and Mac mini');
  });

  it('says nothing for an ordinary ending and a sentence for an early stop', () => {
    expect(summaryInWords('stopReason: end_turn')).toBe('');
    expect(summaryInWords(null)).toBe('');
    expect(summaryInWords('  ')).toBe('');
    expect(summaryInWords('stopReason: max_tokens')).toMatch(/ran out of room/);
    expect(summaryInWords('stopReason: some_new_reason')).toBe('It stopped early (some new reason).');
    // Prose from a future runner is already words.
    expect(summaryInWords('Fixed the failing test and tidied the imports.')).toBe('Fixed the failing test and tidied the imports.');
  });

  it('turns the known error codes into reasons and passes unknown ones through untouched', () => {
    expect(errorInWords('no_remote: workspace has no "origin" remote to push to')).toMatch(/nowhere to push to/);
    expect(errorInWords('gh_missing: the GitHub CLI (gh) is not installed on this machine')).toMatch(/GitHub CLI/);
    expect(errorInWords('unknown_session')).toMatch(/no longer has the finished work/);
    expect(errorInWords('ECONNRESET while talking to the agent')).toBe('ECONNRESET while talking to the agent');
  });

  it('has a plain word for every session status', () => {
    expect(statusInWords('awaiting-permission')).toBe('waiting for your OK');
    expect(statusInWords('failed')).toBe("didn't finish");
  });
});
