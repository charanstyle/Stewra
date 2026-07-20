import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { RUNNER_CLIENT_EVENTS, RUNNER_HARNESS_IDS, RUNNER_SERVER_EVENTS } from '@stewra/shared-types';
import type { RunnerHelloPayload, RunnerWorkspace } from '@stewra/shared-types';
import { z } from 'zod';
import type { RunnerConfig } from '../config.js';
import { SessionManager } from './sessionManager.js';

const claimResponseSchema = z.object({
  data: z.object({
    token: z.string().min(1),
    device: z.object({ id: z.string(), name: z.string() }),
  }),
});

/**
 * Instructions arrive from OUR server, but they still cross the network into a code-executing process, so
 * they are parsed, never trusted: a malformed frame must produce a clean rejection, not a spawned harness
 * with a garbage cwd.
 */
const startSessionSchema = z.object({
  sessionId: z.string().min(1).max(128),
  harness: z.enum(RUNNER_HARNESS_IDS),
  workspaceId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(100_000),
});
const promptSchema = z.object({
  sessionId: z.string().min(1).max(128),
  text: z.string().min(1).max(100_000),
});
const permissionDecisionSchema = z.object({
  sessionId: z.string().min(1).max(128),
  promptId: z.string().min(1).max(128),
  optionId: z.string().min(1).max(256),
});
const cancelSchema = z.object({ sessionId: z.string().min(1).max(128) });
const pushSchema = z.object({ sessionId: z.string().min(1).max(128) });
const openPrSchema = z.object({
  sessionId: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  body: z.string().max(16_000),
});

export interface RunnerClientEvents {
  /** The user revoked THIS device from the web app. Wipe the token and stop. */
  onRevoked(): void;
  onConnected(): void;
  onDisconnected(): void;
}

/**
 * The runner's link to Stewra: an OUTBOUND socket the runner holds open. Nothing reaches into the user's
 * machine — it dials out and receives instructions down the same connection, which is exactly why it works
 * behind NAT with no port forwarding, on a laptop or a cloud VM alike.
 *
 * It carries two things: capability reporting (`runner:hello`) and the session lifecycle. Server→runner
 * session events (start/prompt/permission-decision/cancel) are handed to a `SessionManager`, whose streamed
 * output (updates, done, permission requests) is emitted straight back up this socket.
 */
export class StewraRunnerClient {
  private socket: Socket | null = null;
  private sessions: SessionManager | null = null;
  /** The last-reported workspaces, so a session's `workspaceId` resolves to a real path on this machine. */
  private workspaces: readonly RunnerWorkspace[] = [];

  constructor(private readonly config: RunnerConfig) {}

  /**
   * Trade the one-time pairing code for this device's long-lived token.
   *
   * Unauthenticated by design: the runner has no user session and must never be given one. Handing a
   * code-executing process the user's access token would hand it the whole account, when all it needs is
   * permission to run sessions — permission the user can take back with one click.
   */
  async claimToken(code: string, deviceName: string, os: string): Promise<string> {
    const response = await fetch(`${this.config.apiBaseUrl}${this.config.apiPrefix}/runner/runner-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName, appVersion: this.config.appVersion, os }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message =
        typeof body === 'object' && body !== null && typeof Reflect.get(body, 'message') === 'string'
          ? String(Reflect.get(body, 'message'))
          : 'Stewra rejected that pairing code.';
      throw new Error(message);
    }

    const parsed = claimResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Stewra returned a response this runner did not understand.');
    return parsed.data.data.token;
  }

  /**
   * Open the `/runner` namespace with this device's token, re-announce capabilities on every connect, and
   * wire the session lifecycle. `helloProvider` is called each time so a runner that gains/loses a harness
   * or workspace while running reports the truth after a reconnect. Reconnection is Socket.IO's problem.
   */
  connect(token: string, helloProvider: () => Promise<RunnerHelloPayload>, events: RunnerClientEvents): void {
    const socket = io(`${this.config.apiBaseUrl}/runner`, {
      // The backend's Socket.IO mount lives under the configured prefix (prod: `/api/socket.io` behind the
      // proxy; a raw backend: `/socket.io`). Derived from config so the runner isn't pinned to the proxy.
      path: `${this.config.apiPrefix}/socket.io`,
      auth: { token },
      transports: ['websocket'],
    });
    this.socket = socket;
    this.sessions = new SessionManager(
      {
        update: (payload) => socket.emit(RUNNER_CLIENT_EVENTS.SESSION_UPDATE, payload),
        done: (payload) => socket.emit(RUNNER_CLIENT_EVENTS.SESSION_DONE, payload),
        permission: (payload) => socket.emit(RUNNER_CLIENT_EVENTS.PERMISSION_REQUEST, payload),
      },
      (workspaceId) => this.workspaces.find((w) => w.id === workspaceId),
    );

    socket.on('connect', () => {
      console.error('Stewra Runner: connected to Stewra.');
      events.onConnected();
      void helloProvider()
        .then((hello) => {
          this.workspaces = hello.workspaces;
          socket.emit(RUNNER_CLIENT_EVENTS.HELLO, hello);
        })
        .catch((error: unknown) => {
          console.error(
            'Stewra Runner: failed to build capability report:',
            error instanceof Error ? error.message : String(error),
          );
        });
    });
    socket.on('disconnect', (reason) => {
      console.error(`Stewra Runner: disconnected from Stewra (${reason}).`);
      events.onDisconnected();
    });
    // Without this, a rejected token (or an unreachable server) retries forever with nothing on screen.
    socket.on('connect_error', (error: Error) => {
      console.error('Stewra Runner: could not connect to Stewra:', error.message);
    });

    this.registerSessionHandlers(socket);

    socket.on(RUNNER_SERVER_EVENTS.REVOKED, () => {
      void this.sessions?.disposeAll();
      events.onRevoked();
    });
  }

  private registerSessionHandlers(socket: Socket): void {
    // START_SESSION is acked so the server learns immediately whether the machine took the job.
    socket.on(RUNNER_SERVER_EVENTS.START_SESSION, (raw: unknown, ack?: (response: unknown) => void) => {
      const parsed = startSessionSchema.safeParse(raw);
      if (!parsed.success) {
        ack?.({ accepted: false, error: 'malformed_payload' });
        return;
      }
      void (this.sessions?.start(parsed.data) ?? Promise.resolve({ accepted: false, error: 'not_ready' }))
        .then((result) => ack?.(result))
        .catch((error: unknown) => ack?.({ accepted: false, error: messageOf(error) }));
    });

    socket.on(RUNNER_SERVER_EVENTS.PROMPT, (raw: unknown) => {
      const parsed = promptSchema.safeParse(raw);
      if (parsed.success) void this.sessions?.prompt(parsed.data);
    });

    socket.on(RUNNER_SERVER_EVENTS.PERMISSION_DECISION, (raw: unknown) => {
      const parsed = permissionDecisionSchema.safeParse(raw);
      if (parsed.success) this.sessions?.decide(parsed.data);
    });

    socket.on(RUNNER_SERVER_EVENTS.CANCEL, (raw: unknown) => {
      const parsed = cancelSchema.safeParse(raw);
      if (parsed.success) void this.sessions?.cancel(parsed.data);
    });

    // Git follow-through is acked, so the server (and the user watching) learns the pushed ref / PR URL — or
    // a specific failure — synchronously, rather than inferring it from a later stream event.
    socket.on(RUNNER_SERVER_EVENTS.PUSH, (raw: unknown, ack?: (response: unknown) => void) => {
      const parsed = pushSchema.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'malformed_payload' });
        return;
      }
      void (this.sessions?.push(parsed.data) ?? Promise.resolve({ ok: false, error: 'not_ready' }))
        .then((result) => ack?.(result))
        .catch((error: unknown) => ack?.({ ok: false, error: messageOf(error) }));
    });

    socket.on(RUNNER_SERVER_EVENTS.OPEN_PR, (raw: unknown, ack?: (response: unknown) => void) => {
      const parsed = openPrSchema.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'malformed_payload' });
        return;
      }
      void (this.sessions?.openPr(parsed.data) ?? Promise.resolve({ ok: false, error: 'not_ready' }))
        .then((result) => ack?.(result))
        .catch((error: unknown) => ack?.({ ok: false, error: messageOf(error) }));
    });
  }

  disconnect(): void {
    void this.sessions?.disposeAll();
    this.socket?.disconnect();
    this.socket = null;
    this.sessions = null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
