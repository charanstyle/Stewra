import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  Agent,
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type {
  RunnerHarnessId,
  RunnerPermissionKind,
  RunnerPermissionOption,
  RunnerUpdateKind,
} from '@stewra/shared-types';
import { harnessCommand, harnessEnv } from './harnessCommand.js';

/** One streamed increment the harness produced, already mapped from ACP to Stewra's update vocabulary. */
export interface AcpUpdate {
  readonly kind: RunnerUpdateKind;
  readonly text?: string;
  readonly tool?: string;
}

/** A permission gate the harness hit, mapped to Stewra's option shape. */
export interface AcpPermissionPrompt {
  readonly title: string;
  readonly detail: string;
  readonly options: readonly RunnerPermissionOption[];
}

export interface AcpCallbacks {
  /** Called for every streamed increment (agent text, tool call, plan, …). */
  onUpdate(update: AcpUpdate): void;
  /**
   * Called when the harness needs authorisation. Resolve with the chosen option's `id` (the ACP optionId),
   * or null to cancel the request. The runner relays this to the server and waits for the user's answer.
   */
  onPermission(prompt: AcpPermissionPrompt): Promise<string | null>;
}

/** ACP's four permission kinds are already Stewra's `RunnerPermissionKind`; this just narrows the string. */
function toPermissionKind(kind: string): RunnerPermissionKind {
  switch (kind) {
    case 'allow_once':
    case 'allow_always':
    case 'reject_once':
    case 'reject_always':
      return kind;
    default:
      // An unknown kind from a newer agent: treat as a one-shot allow so the UI can still render the option,
      // rather than crash on an unexpected enum. The label still tells the user what it is.
      return 'allow_once';
  }
}

/** Pull display text out of an ACP ContentBlock, which is only textual for `type: 'text'`. */
function contentText(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  if (!('type' in content) || !('text' in content)) return undefined;
  const { type, text } = content;
  if (type === 'text' && typeof text === 'string') return text;
  return undefined;
}

/**
 * Hosts ONE coding session by speaking ACP to a harness subprocess (Claude Code / Codex / Gemini) over
 * stdio. It spawns the adapter, negotiates the protocol, opens a session rooted in `cwd` (the session's
 * isolated git worktree), runs prompt turns, and translates the harness's streamed ACP notifications into
 * Stewra updates + permission prompts via the callbacks. Nothing here reaches the network — the runner's
 * socket layer owns that; this class only knows the local subprocess.
 */
export class AcpSession {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private connection: Agent | null = null;
  private acpSessionId: string | null = null;

  constructor(
    private readonly harness: RunnerHarnessId,
    private readonly cwd: string,
    private readonly callbacks: AcpCallbacks,
  ) {}

  /** Spawn the harness, initialize the protocol, and open a session in the worktree. */
  async start(): Promise<void> {
    const { command, args } = harnessCommand(this.harness);
    const child = spawn(command, [...args], {
      cwd: this.cwd,
      env: harnessEnv(this.harness),
      // stdin+stdout carry ACP; stderr is inherited so a harness crash is visible in the runner's logs.
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child = child;

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const connection = new ClientSideConnection(() => this.buildClient(), stream);
    this.connection = connection;

    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'stewra-runner', version: '0.1.0' },
    });

    // cwd must be absolute (ACP requirement); the worktree path always is. mcpServers is required but empty.
    const session = await connection.newSession({ cwd: this.cwd, mcpServers: [] });
    this.acpSessionId = session.sessionId;
  }

  /** Run one prompt turn and resolve with the ACP stop reason (`end_turn`, `cancelled`, …). */
  async prompt(text: string): Promise<string> {
    if (this.connection === null || this.acpSessionId === null) {
      throw new Error('AcpSession.prompt called before start()');
    }
    const result = await this.connection.prompt({
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text }],
    });
    return result.stopReason;
  }

  /** Ask the harness to abort the current turn. It still returns from `prompt` with `stopReason: cancelled`. */
  async cancel(): Promise<void> {
    if (this.connection === null || this.acpSessionId === null) return;
    await this.connection.cancel({ sessionId: this.acpSessionId });
  }

  /** Kill the subprocess and drop references. Safe to call more than once. */
  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.connection = null;
    this.acpSessionId = null;
  }

  /** The client half of ACP: how this runner answers the harness's notifications and requests. */
  private buildClient(): Client {
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        this.handleUpdate(params);
      },
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => this.handlePermission(params),
    };
  }

  private handleUpdate(params: SessionNotification): void {
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(update.content);
        if (text !== undefined) this.callbacks.onUpdate({ kind: 'agent-message', text });
        return;
      }
      case 'agent_thought_chunk': {
        const text = contentText(update.content);
        if (text !== undefined) this.callbacks.onUpdate({ kind: 'agent-thought', text });
        return;
      }
      case 'tool_call': {
        this.callbacks.onUpdate({ kind: 'tool-call', tool: update.title, text: update.title });
        return;
      }
      case 'tool_call_update': {
        // Only surface a completed tool call as a result; intermediate "running" ticks would be noise.
        if (update.status === 'completed') {
          const title = update.title;
          this.callbacks.onUpdate(
            title !== null && title !== undefined
              ? { kind: 'tool-result', text: title }
              : { kind: 'tool-result' },
          );
        }
        return;
      }
      case 'plan': {
        this.callbacks.onUpdate({ kind: 'status', text: 'updated plan' });
        return;
      }
      default:
        // Other update kinds (available_commands, mode/config, usage) aren't shown in Stewra's stream.
        return;
    }
  }

  private async handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const options: RunnerPermissionOption[] = params.options.map((option) => ({
      id: option.optionId,
      label: option.name,
      kind: toPermissionKind(option.kind),
    }));
    const title = params.toolCall.title ?? 'Permission required';

    const chosen = await this.callbacks.onPermission({ title, detail: title, options });
    if (chosen === null) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: chosen } };
  }
}
