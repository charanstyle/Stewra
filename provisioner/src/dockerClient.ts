import { Agent, request } from 'undici';
import { z } from 'zod';

/**
 * A thin, typed door to the Docker Engine API over its unix socket. Deliberately NOT dockerode: the
 * provisioner speaks to exactly one daemon, uses a dozen endpoints, and the security review surface
 * of this file should be its whole dependency story.
 *
 * Every response is from another process — parsed with a schema, never cast. Every unexpected status
 * is a thrown error carrying the daemon's own message: a provisioner that swallows a Docker error and
 * reports success is how orphaned containers are born.
 */
export class DockerError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`docker ${method} ${path} failed: ${status} ${body.slice(0, 500)}`);
    this.name = 'DockerError';
  }
}

const versionSchema = z.object({ Version: z.string() });

/** The slice of `GET /containers/{id}/json` the provisioner reads. */
const inspectSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  State: z.object({ Status: z.string(), StartedAt: z.string() }),
  Config: z.object({ Image: z.string(), Labels: z.record(z.string()) }),
  HostConfig: z.object({
    CapDrop: z.array(z.string()).nullable(),
    SecurityOpt: z.array(z.string()).nullable(),
    Memory: z.number(),
    MemorySwap: z.number(),
    NanoCpus: z.number(),
    PidsLimit: z.number().nullable(),
    NetworkMode: z.string(),
    Binds: z.array(z.string()).nullable(),
    RestartPolicy: z.object({ Name: z.string() }),
  }),
});
export type ContainerInspect = z.infer<typeof inspectSchema>;

/** The slice of `GET /containers/json` the provisioner reads. */
const summarySchema = z.object({
  Id: z.string(),
  Names: z.array(z.string()),
  State: z.string(),
  Status: z.string(),
  Labels: z.record(z.string()),
});
export type ContainerSummary = z.infer<typeof summarySchema>;

export class DockerClient {
  private readonly agent: Agent;

  constructor(socketPath: string) {
    this.agent = new Agent({ connect: { socketPath } });
  }

  /**
   * One request to the daemon. `expect` lists the statuses the CALLER declared it can interpret;
   * anything else throws with the daemon's message.
   */
  private async call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { body?: unknown; rawBody?: Buffer; expect: readonly number[] },
  ): Promise<{ status: number; body: Buffer }> {
    const headers: Record<string, string> = {};
    let body: string | Buffer | null = null;
    if (opts.rawBody !== undefined) {
      headers['content-type'] = 'application/x-tar';
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    // The host segment is ignored on a unix socket, but the URL must parse.
    const response = await request(`http://docker${path}`, {
      dispatcher: this.agent,
      method,
      headers,
      body,
    });
    const payload = Buffer.from(await response.body.arrayBuffer());
    if (!opts.expect.includes(response.statusCode)) {
      throw new DockerError(response.statusCode, method, path, payload.toString('utf8'));
    }
    return { status: response.statusCode, body: payload };
  }

  /** Daemon liveness + version, for /healthz. */
  async version(): Promise<{ Version: string }> {
    const { body } = await this.call('GET', '/version', { expect: [200] });
    return versionSchema.parse(JSON.parse(body.toString('utf8')));
  }

  async createContainer(name: string, spec: object): Promise<void> {
    await this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, {
      body: spec,
      expect: [201],
    });
  }

  /** Inspect by name. Null when the container does not exist — absence is a normal answer here. */
  async inspectContainer(name: string): Promise<ContainerInspect | null> {
    const { status, body } = await this.call('GET', `/containers/${encodeURIComponent(name)}/json`, {
      expect: [200, 404],
    });
    return status === 404 ? null : inspectSchema.parse(JSON.parse(body.toString('utf8')));
  }

  async listContainers(labelFilter: string): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [labelFilter] }));
    const { body } = await this.call('GET', `/containers/json?all=1&filters=${filters}`, {
      expect: [200],
    });
    return z.array(summarySchema).parse(JSON.parse(body.toString('utf8')));
  }

  async startContainer(name: string): Promise<void> {
    // 304 = already started: the state the caller wanted, reached earlier.
    await this.call('POST', `/containers/${encodeURIComponent(name)}/start`, { expect: [204, 304] });
  }

  async stopContainer(name: string): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(name)}/stop`, { expect: [204, 304] });
  }

  /** Force-remove: also kills a running container. 404 is fine — gone is what we wanted. */
  async removeContainer(name: string): Promise<void> {
    await this.call('DELETE', `/containers/${encodeURIComponent(name)}?force=true`, {
      expect: [204, 404],
    });
  }

  /** Remove a NAMED volume. 404 is fine; 409 (still in use) is not — that is a caller-ordering bug. */
  async removeVolume(name: string): Promise<void> {
    await this.call('DELETE', `/volumes/${encodeURIComponent(name)}`, { expect: [204, 404] });
  }

  async volumeExists(name: string): Promise<boolean> {
    const { status } = await this.call('GET', `/volumes/${encodeURIComponent(name)}`, {
      expect: [200, 404],
    });
    return status === 200;
  }

  /**
   * Pull an image (`repository:tag`). The daemon streams progress and ends the response when the pull
   * completes, so awaiting the body IS awaiting the pull. Used by the test suite to guarantee its
   * image; production images are built on the host, never pulled here.
   */
  async pullImage(ref: string): Promise<void> {
    const [repository, tag] = ref.split(':');
    if (repository === undefined || tag === undefined) {
      throw new Error(`pullImage needs repository:tag, got ${ref}`);
    }
    await this.call(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(tag)}`,
      { expect: [200] },
    );
  }

  /** Extract a tar archive into a container's filesystem — Docker's only "write a file" primitive. */
  async putArchive(name: string, destinationPath: string, archive: Buffer): Promise<void> {
    const path = `/containers/${encodeURIComponent(name)}/archive?path=${encodeURIComponent(destinationPath)}`;
    await this.call('PUT', path, { rawBody: archive, expect: [200] });
  }

  /** Fetch a path from a container's filesystem as a tar archive (used by the test readback). */
  async getArchive(name: string, sourcePath: string): Promise<Buffer> {
    const path = `/containers/${encodeURIComponent(name)}/archive?path=${encodeURIComponent(sourcePath)}`;
    const { body } = await this.call('GET', path, { expect: [200] });
    return body;
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
