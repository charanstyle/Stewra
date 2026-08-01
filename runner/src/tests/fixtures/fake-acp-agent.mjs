#!/usr/bin/env node
// A scripted ACP agent for acpClient.test.ts: ndjson JSON-RPC over stdio, scenario picked by argv.
//
// The tests point the runner at this file via STEWRA_RUNNER_ACP_GEMINI_CLI="node <this file> <scenario>",
// which exercises the REAL AcpSession — spawn, protocol negotiation, the update mapping table, the
// permission round-trip — against a subprocess whose behaviour the test fully controls. Nothing here
// touches the network.
//
// Scenarios:
//   happy       one prompt turn that streams every update kind AcpSession maps (and two it must drop),
//               then stops with end_turn.
//   permission  the prompt turn asks the client for permission (three options) and echoes the outcome
//               back as an agent message before stopping. Kinds must come from ACP's enum — the
//               client SDK validates the request at the connection layer and rejects unknown kinds
//               before AcpSession ever sees them (which is why toPermissionKind's unknown-kind
//               fallback is defence in depth, not a wire-reachable path on SDK 1.2.1).
//   hang        the prompt turn never answers until session/cancel arrives, then stops with cancelled.
//   edit        the prompt turn WRITES A REAL FILE in its cwd (the session worktree) — the way a real
//               agent produces work — streams one normal and one oversized message, then stops. Lets
//               sessionManager tests exercise the real diff/commit/push pipeline end to end.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const scenario = process.argv[2] ?? 'happy';

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

let nextOutboundId = 1000;
const awaitingResponse = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextOutboundId;
    nextOutboundId += 1;
    awaitingResponse.set(id, resolve);
    write({ jsonrpc: '2.0', id, method, params });
  });

/** Set by the `hang` scenario: answering the held-open prompt turn. */
let finishHeldTurn = null;

async function handle(message) {
  switch (message.method) {
    case 'initialize':
      respond(message.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      return;
    case 'session/new':
      respond(message.id, { sessionId: 'fake-session-1' });
      return;
    case 'session/prompt': {
      const sessionId = message.params.sessionId;
      const update = (u) => notify('session/update', { sessionId, update: u });

      if (scenario === 'permission') {
        const result = await request('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: 'tool-1', title: 'Run a shell command' },
          options: [
            { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
          ],
        });
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `outcome:${JSON.stringify(result.outcome)}` },
        });
        respond(message.id, {
          stopReason: result.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn',
        });
        return;
      }

      if (scenario === 'hang') {
        finishHeldTurn = () => respond(message.id, { stopReason: 'cancelled' });
        return;
      }

      if (scenario === 'edit') {
        writeFileSync(join(process.cwd(), 'agent-output.txt'), 'made by the scripted agent\n');
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrote agent-output.txt' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B'.repeat(9000) } });
        respond(message.id, { stopReason: 'end_turn' });
        return;
      }

      // happy: the full mapping table, including two frames AcpSession must NOT surface.
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from the agent' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '', mimeType: 'image/png' } });
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read file', status: 'pending' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', title: 'Read file' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-2', status: 'completed' });
      update({ sessionUpdate: 'plan', entries: [] });
      respond(message.id, { stopReason: 'end_turn' });
      return;
    }
    case 'session/cancel':
      if (finishHeldTurn !== null) {
        finishHeldTurn();
        finishHeldTurn = null;
      }
      return;
    default:
      // Anything unexpected gets an empty result rather than a hang, so a test failure stays readable.
      if (message.id !== undefined) respond(message.id, {});
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method === undefined) {
    const resolve = awaitingResponse.get(message.id);
    awaitingResponse.delete(message.id);
    if (resolve !== undefined) resolve(message.result);
    return;
  }
  void handle(message);
});
