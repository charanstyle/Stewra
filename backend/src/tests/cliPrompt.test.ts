import { renderCliPrompt } from '../agent-host/modelClient.js';

/**
 * The `claude -p` CLI takes ONE prompt on stdin, so a multi-turn conversation has to be rendered as
 * text. Rendering it without role labels is what let Stewra read its own stale replies as if the user
 * had written them — see the "I can't send emails … I don't want to keep flip-flopping" regression.
 * Pure function, real assertions, no mocks.
 */
describe('renderCliPrompt (roles survive the flattening to a single CLI prompt)', () => {
  it('passes a lone user turn through verbatim', () => {
    // The single-shot callers hand-build a complete prompt; labelling would corrupt their formatting.
    expect(renderCliPrompt([{ role: 'user', content: '- fact one\n- fact two' }])).toBe(
      '- fact one\n- fact two',
    );
  });

  it('labels every turn once the conversation is multi-turn', () => {
    expect(
      renderCliPrompt([
        { role: 'user', content: 'email bob@example.com saying hi' },
        { role: 'assistant', content: "I've prepared the draft." },
        { role: 'user', content: 'second test please' },
      ]),
    ).toBe(
      'User: email bob@example.com saying hi\n\n' +
        "Assistant: I've prepared the draft.\n\n" +
        'User: second test please',
    );
  });

  it("attributes the assistant's own past refusal to the assistant, never to the user", () => {
    // The exact regression: an unlabelled render made this line indistinguishable from user input.
    const refusal = 'I am not able to send emails or take actions on your behalf.';
    const prompt = renderCliPrompt([
      { role: 'user', content: 'send an email' },
      { role: 'assistant', content: refusal },
      { role: 'user', content: 'try again' },
    ]);
    expect(prompt).toContain(`Assistant: ${refusal}`);
    expect(prompt).not.toContain(`User: ${refusal}`);
  });

  it('labels a lone assistant turn rather than passing it off as the prompt', () => {
    expect(renderCliPrompt([{ role: 'assistant', content: 'Mars' }])).toBe('Assistant: Mars');
  });

  it('renders an empty conversation as an empty prompt', () => {
    expect(renderCliPrompt([])).toBe('');
  });
});
