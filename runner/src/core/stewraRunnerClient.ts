import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { RUNNER_CLIENT_EVENTS, RUNNER_SERVER_EVENTS } from '@stewra/shared-types';
import type { RunnerHelloPayload } from '@stewra/shared-types';
import { z } from 'zod';
import type { RunnerConfig } from '../config.js';

const claimResponseSchema = z.object({
  data: z.object({
    token: z.string().min(1),
    device: z.object({ id: z.string(), name: z.string() }),
  }),
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
 * Phase 1 is transport + registration only: connect, announce capabilities (`runner:hello`), and obey a
 * revocation. Session hosting (ACP, `runner:start-session`, streamed updates) lands in Phase 2.
 */
export class StewraRunnerClient {
  private socket: Socket | null = null;

  constructor(private readonly config: RunnerConfig) {}

  /**
   * Trade the one-time pairing code for this device's long-lived token.
   *
   * Unauthenticated by design: the runner has no user session and must never be given one. Handing a
   * code-executing process the user's access token would hand it the whole account, when all it needs is
   * permission to run sessions — permission the user can take back with one click.
   */
  async claimToken(code: string, deviceName: string, os: string): Promise<string> {
    const response = await fetch(`${this.config.apiBaseUrl}/api/runner/runner-token`, {
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
   * Open the `/runner` namespace with this device's token, and re-announce capabilities on every connect
   * (including reconnects). `helloProvider` is called each time so a runner that gains/loses a harness or
   * workspace while running reports the truth after a reconnect. Reconnection is Socket.IO's problem.
   */
  connect(token: string, helloProvider: () => Promise<RunnerHelloPayload>, events: RunnerClientEvents): void {
    const socket = io(`${this.config.apiBaseUrl}/runner`, {
      // Stewra's public surface mounts the backend under `/api`; the default `/socket.io` path would hit
      // the website, not the backend. Same as the bridge.
      path: '/api/socket.io',
      auth: { token },
      transports: ['websocket'],
    });
    this.socket = socket;

    socket.on('connect', () => {
      console.error('Stewra Runner: connected to Stewra.');
      events.onConnected();
      void helloProvider()
        .then((hello) => socket.emit(RUNNER_CLIENT_EVENTS.HELLO, hello))
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

    socket.on(RUNNER_SERVER_EVENTS.REVOKED, () => events.onRevoked());
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}
