import { z } from 'zod';
import { config } from '../config/unifiedConfig.js';

/**
 * The backend's one door to the provisioner — the only process on the host that holds the Docker socket.
 *
 * The asymmetry here is the whole security design. This client can ask for a container by device id and
 * hand over an allowlisted set of environment variables; it CANNOT choose the image, the mounts, the
 * capabilities, the network, or the resource caps. Those live hardcoded in the provisioner's template,
 * on the other side of an HTTP boundary, precisely because this backend parses untrusted input from the
 * internet all day. A compromise here must not become root on the host.
 *
 * Every non-2xx is an exception carrying the provisioner's own message. There is no degraded mode: a
 * provisioner that cannot be reached means Stewra does not know what is running, and pretending
 * otherwise would leave containers alive that no user can see or stop.
 */

/** What the provisioner reports about one container. `status` is Docker's own vocabulary, unmapped. */
const runnerViewSchema = z.object({
  deviceId: z.string(),
  containerName: z.string(),
  status: z.string(),
  startedAt: z.string(),
});

const runnerListSchema = z.object({
  runners: z.array(
    z.object({
      deviceId: z.string(),
      containerName: z.string(),
      status: z.string(),
    }),
  ),
});

const errorBodySchema = z.object({ error: z.object({ message: z.string() }) });

export type ProvisionerRunnerView = z.infer<typeof runnerViewSchema>;
export type ProvisionerRunnerSummary = z.infer<typeof runnerListSchema>['runners'][number];

/** A provisioner call that did not succeed. `status` is null when the request never got an answer. */
export class ProvisionerError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ProvisionerError';
  }

  /** True when the provisioner is certain no such container exists — the caller may treat it as gone. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** Requests are small and local (same host, internal network); a hung one must not hang a user's request. */
const REQUEST_TIMEOUT_MS = 30_000;

class ProvisionerClient {
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const url = `${config.hostedRunner.provisionerUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${config.hostedRunner.provisionerToken}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Unreachable, DNS-dead, or timed out. Not a 502 dressed up as a result — the caller must know
      // that the state of the host is now unknown to us.
      throw new ProvisionerError(
        null,
        `provisioner unreachable at ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    if (response.status >= 200 && response.status < 300) return { status: response.status, text };

    // The provisioner speaks a consistent error envelope; fall back to the raw body if it ever doesn't,
    // rather than swallowing the one piece of information the operator needs.
    const parsed = errorBodySchema.safeParse(safeJson(text));
    const detail = parsed.success ? parsed.data.error.message : text.slice(0, 300);
    throw new ProvisionerError(response.status, `provisioner ${method} ${path} failed (${response.status}): ${detail}`);
  }

  private async requestJson<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const { text } = await this.request(method, path, body);
    return schema.parse(safeJson(text));
  }

  /**
   * Create the container for a device. `env` is allowlisted on the provisioner side
   * (`^STEWRA_(API_URL|API_PREFIX|RUNNER_[A-Z0-9_]+)$`); anything else is a 400 before Docker is touched.
   */
  async createRunner(deviceId: string, env: Record<string, string>): Promise<ProvisionerRunnerView> {
    return this.requestJson('POST', '/v1/runners', runnerViewSchema, {
      deviceId,
      image: config.hostedRunner.image,
      env,
    });
  }

  /** Every container the provisioner manages — reconciliation's view of the truth. */
  async listRunners(): Promise<ProvisionerRunnerSummary[]> {
    const { runners } = await this.requestJson('GET', '/v1/runners', runnerListSchema);
    return runners;
  }

  async startRunner(deviceId: string): Promise<ProvisionerRunnerView> {
    return this.requestJson('POST', `/v1/runners/${encodeURIComponent(deviceId)}/start`, runnerViewSchema);
  }

  async stopRunner(deviceId: string): Promise<ProvisionerRunnerView> {
    return this.requestJson('POST', `/v1/runners/${encodeURIComponent(deviceId)}/stop`, runnerViewSchema);
  }

  /**
   * Write a provider login into the container's home volume.
   *
   * The secret travels in this request body and nowhere else: not in argv, not in the container's
   * environment, so it appears in neither `docker inspect` nor the host's process list. It is never
   * logged here, and the provisioner logs method/path/status only.
   */
  async putCredential(deviceId: string, slot: string, secret: string): Promise<void> {
    await this.request(
      'PUT',
      `/v1/runners/${encodeURIComponent(deviceId)}/credentials/${encodeURIComponent(slot)}`,
      { secret },
    );
  }

  /**
   * Destroy the container. `removeVolumes` also deletes the two named volumes — the user's cloned repos
   * and any uncommitted work in them. Only ever true on an explicit destroy, never on a rollback of a
   * provision that failed part-way (there is nothing of the user's on those volumes yet, but the habit
   * of passing it is exactly how a working runner eventually gets wiped).
   */
  async destroyRunner(deviceId: string, removeVolumes: boolean): Promise<void> {
    const query = removeVolumes ? '?removeVolumes=true' : '';
    await this.request('DELETE', `/v1/runners/${encodeURIComponent(deviceId)}${query}`);
  }

}

/** Parse a body that SHOULD be JSON, keeping the raw text usable when it isn't (e.g. a proxy's HTML 502). */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const provisionerClient = new ProvisionerClient();
