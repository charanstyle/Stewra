import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { loadConfig } from '../config.js';
import type { ProvisionerConfig } from '../config.js';
import { DockerClient } from '../dockerClient.js';
import { createProvisionerApi } from '../api.js';
import { containerName, dataVolumeName, homeVolumeName } from '../template.js';
import { extractTar } from '../tar.js';

/**
 * The provisioner against a REAL Docker Engine — containers are actually created, hardened, started,
 * stopped, and destroyed, because the claims under test ("CapDrop is ALL", "the volumes die with the
 * device", "a secret lands mode-0600 on the volume") are claims about what the DAEMON accepts and
 * produces, which no stand-in can vouch for.
 *
 * THE GATE: with no Docker socket on this machine the whole suite is skipped — loudly, with the
 * reason and the fix printed. Setting DOCKER_SOCKET explicitly disables the skip: if it is set and
 * wrong, the suite FAILS. See TESTING.md § "Provisioner suite (real Docker)".
 */

function resolveSocket(): string | null {
  const explicit = process.env['DOCKER_SOCKET'];
  if (explicit !== undefined) {
    if (!existsSync(explicit)) {
      throw new Error(
        `DOCKER_SOCKET is set to ${explicit}, which does not exist. Fix the path or unset it.`,
      );
    }
    return explicit;
  }
  for (const candidate of [
    '/var/run/docker.sock',
    // Docker Desktop on macOS.
    `${homedir()}/.docker/run/docker.sock`,
    // colima, which does NOT symlink into either path above. TESTING.md promised discovery would
    // find a colima daemon; without this entry the suite skipped on a machine that had one running,
    // which is the exact "quietly ran nothing" outcome the explicit-DOCKER_SOCKET rule exists to
    // prevent — just arrived at by discovery instead.
    `${homedir()}/.colima/default/docker.sock`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const socketPath = resolveSocket();
if (socketPath === null) {
  // This is the loud part of "loudly skipped".
  console.error(
    '\n⚠️  PROVISIONER SUITE SKIPPED — no Docker socket on this machine.\n' +
      '   These tests drive a real Docker Engine (create/start/stop/destroy hardened containers).\n' +
      '   To run them: install Docker (Desktop/colima), or set DOCKER_SOCKET to a reachable engine\n' +
      "   socket. They also run on the deploy host. See TESTING.md § 'Provisioner suite'.\n",
  );
}
const suite = socketPath === null ? describe.skip : describe;

/**
 * A real public image with a long-running default command, so start/stop have something to govern.
 * The template never overrides an image's CMD, and the runner image is not built during unit tests.
 *
 * It must also be an image that DECLARES its non-root user at build time, because CapDrop ALL denies
 * CAP_SETUID: an entrypoint that drops privilege at runtime (`setpriv`, `su-exec`, `gosu` — what
 * redis/postgres/nginx official images do) dies with "setresuid failed" the moment it starts. The
 * runner image satisfies this (`USER runner` + a direct node entrypoint, runner/Dockerfile), and
 * nginx-unprivileged is its closest public analogue — the name is the point.
 */
const TEST_IMAGE = 'nginxinc/nginx-unprivileged:alpine';
const TOKEN = 'provisioner-test-token-0123456789abcdef';

suite('the provisioner against real Docker', () => {
  let config: ProvisionerConfig;
  let docker: DockerClient;
  let server: Server;
  let baseUrl: string;
  const createdDevices: string[] = [];

  /** Drive the API the way the backend will: over real HTTP with a bearer token. */
  async function call(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string | null } = {},
  ): Promise<{ status: number; json: () => Promise<unknown> }> {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? TOKEN : opts.token;
    if (token !== null) headers['authorization'] = `Bearer ${token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? null : JSON.stringify(opts.body),
    });
    return { status: response.status, json: () => response.json() };
  }

  async function createRunner(deviceId: string): Promise<{ status: number }> {
    createdDevices.push(deviceId);
    return call('POST', '/v1/runners', {
      body: {
        deviceId,
        image: TEST_IMAGE,
        env: {
          STEWRA_API_URL: 'https://stewra.test',
          STEWRA_RUNNER_DEVICE_TOKEN: 'stwrn_test_token',
          STEWRA_RUNNER_WORKSPACE_MODE: 'backend',
        },
      },
    });
  }

  beforeAll(async () => {
    if (socketPath === null) throw new Error('unreachable: suite is skipped without a socket');
    config = loadConfig({
      PROVISIONER_TOKEN: TOKEN,
      DOCKER_SOCKET: socketPath,
      RUNNER_IMAGE: TEST_IMAGE,
      // The default bridge network — always present. The isolated prod network is created by
      // deploy/hosted-runner/create-network.sh on the host and asserted there, not here.
      RUNNER_NETWORK: 'bridge',
      RUNNER_MEMORY_BYTES: String(256 * 1024 * 1024),
      RUNNER_NANO_CPUS: String(500_000_000),
      RUNNER_PIDS_LIMIT: '128',
    });
    docker = new DockerClient(socketPath);
    await docker.pullImage(TEST_IMAGE);
    server = createProvisionerApi(config, docker);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const deviceId of createdDevices) {
      await docker.removeContainer(containerName(deviceId));
      await docker.removeVolume(homeVolumeName(deviceId));
      await docker.removeVolume(dataVolumeName(deviceId));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await docker.close();
  });

  it('refuses to load a config with a missing target or safety cap', () => {
    expect(() => loadConfig({})).toThrow(/PROVISIONER_TOKEN/);
    expect(() =>
      loadConfig({
        PROVISIONER_TOKEN: TOKEN,
        DOCKER_SOCKET: '/var/run/docker.sock',
        RUNNER_NETWORK: 'bridge',
        RUNNER_MEMORY_BYTES: '1',
        RUNNER_NANO_CPUS: '1',
        RUNNER_PIDS_LIMIT: '1',
      }),
    ).toThrow(/RUNNER_IMAGE/);
    // A floating tag is not an "exact image": the template must pin what it runs.
    expect(() =>
      loadConfig({
        PROVISIONER_TOKEN: TOKEN,
        DOCKER_SOCKET: '/var/run/docker.sock',
        RUNNER_IMAGE: 'redis',
        RUNNER_NETWORK: 'bridge',
        RUNNER_MEMORY_BYTES: '1',
        RUNNER_NANO_CPUS: '1',
        RUNNER_PIDS_LIMIT: '1',
      }),
    ).toThrow(/RUNNER_IMAGE/);
    // An ABSENT cap must be named. Coercion sees `undefined` as NaN, so the naive schema reported
    // "expected number, received nan" — which reads like a typo in a value the operator never wrote.
    expect(() => loadConfig({})).toThrow(/RUNNER_MEMORY_BYTES is not set/);
    expect(() => loadConfig({})).toThrow(/RUNNER_PIDS_LIMIT is not set/);
  });

  it('answers /healthz with the daemon version, unauthenticated', async () => {
    const response = await call('GET', '/healthz', { token: null });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; dockerVersion: string };
    expect(body.ok).toBe(true);
    expect(body.dockerVersion.length).toBeGreaterThan(0);
  });

  it('refuses every /v1 route without the exact bearer token', async () => {
    expect((await call('GET', '/v1/runners', { token: null })).status).toBe(401);
    expect((await call('GET', '/v1/runners', { token: 'wrong-token' })).status).toBe(401);
  });

  it('creates a container that is hardened EXACTLY as the template promises', async () => {
    const deviceId = randomUUID();
    const created = await createRunner(deviceId);
    expect(created.status).toBe(201);

    // Assert against the DAEMON's own record, not our request.
    const inspect = await docker.inspectContainer(containerName(deviceId));
    expect(inspect).not.toBeNull();
    if (inspect === null) throw new Error('inspect returned null after a 201');

    expect(inspect.Config.Image).toBe(TEST_IMAGE);
    expect(inspect.Config.Labels['stewra.managed']).toBe('true');
    expect(inspect.Config.Labels['stewra.device_id']).toBe(deviceId);

    expect(inspect.HostConfig.CapDrop).toEqual(['ALL']);
    expect(inspect.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(inspect.HostConfig.Memory).toBe(256 * 1024 * 1024);
    // MemorySwap EQUAL to Memory: no swap headroom at all.
    expect(inspect.HostConfig.MemorySwap).toBe(256 * 1024 * 1024);
    expect(inspect.HostConfig.NanoCpus).toBe(500_000_000);
    expect(inspect.HostConfig.PidsLimit).toBe(128);
    expect(inspect.HostConfig.RestartPolicy.Name).toBe('no');
    expect(inspect.HostConfig.NetworkMode).toBe('bridge');
    expect(inspect.HostConfig.Binds).toEqual([
      `${homeVolumeName(deviceId)}:/home/runner`,
      `${dataVolumeName(deviceId)}:/data`,
    ]);
  });

  it('rejects a request naming any other image, before any Docker call', async () => {
    const deviceId = randomUUID();
    const response = await call('POST', '/v1/runners', {
      body: { deviceId, image: 'evil/backdoor:latest', env: {} },
    });
    expect(response.status).toBe(400);
    await expect(docker.inspectContainer(containerName(deviceId))).resolves.toBeNull();
  });

  it('rejects env keys outside the allowlist — PATH and friends never reach a container', async () => {
    const deviceId = randomUUID();
    const response = await call('POST', '/v1/runners', {
      body: {
        deviceId,
        image: TEST_IMAGE,
        env: { STEWRA_API_URL: 'https://stewra.test', PATH: '/evil/bin' },
      },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('PATH');
    await expect(docker.inspectContainer(containerName(deviceId))).resolves.toBeNull();
  });

  it('rejects a device id that is not a UUID', async () => {
    const response = await call('POST', '/v1/runners', {
      body: { deviceId: '../../etc', image: TEST_IMAGE, env: {} },
    });
    expect(response.status).toBe(400);
  });

  it('answers 409 for a device that already has a container', async () => {
    const deviceId = randomUUID();
    expect((await createRunner(deviceId)).status).toBe(201);
    const again = await call('POST', '/v1/runners', {
      body: { deviceId, image: TEST_IMAGE, env: {} },
    });
    expect(again.status).toBe(409);
  });

  it('starts and stops the container, reporting the daemon state each time', async () => {
    const deviceId = randomUUID();
    await createRunner(deviceId);

    const started = await call('POST', `/v1/runners/${deviceId}/start`, {});
    expect(started.status).toBe(200);
    expect(((await started.json()) as { status: string }).status).toBe('running');

    const stopped = await call('POST', `/v1/runners/${deviceId}/stop`, {});
    expect(stopped.status).toBe(200);
    expect(((await stopped.json()) as { status: string }).status).toBe('exited');
  });

  it('writes a credential slot onto the home volume: mode 0600, runner-owned, content intact', async () => {
    const deviceId = randomUUID();
    await createRunner(deviceId);

    const secret = `sk-test-${randomUUID()}`;
    const put = await call('PUT', `/v1/runners/${deviceId}/credentials/claude-code`, {
      body: { secret },
    });
    expect(put.status).toBe(204);

    // Read it back through the daemon — the same authority that will serve it to the runner.
    const archive = await docker.getArchive(
      containerName(deviceId),
      '/home/runner/.stewra-runner/credentials/claude-code',
    );
    const entries = extractTar(archive);
    expect(entries).toHaveLength(1);
    const file = entries[0];
    if (file === undefined) throw new Error('archive readback produced no entries');
    expect(file.content.toString('utf8')).toBe(secret);
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.uid).toBe(10001);
    expect(file.gid).toBe(10001);
  });

  it('refuses a credential slot that is not a known harness', async () => {
    const deviceId = randomUUID();
    await createRunner(deviceId);
    const response = await call('PUT', `/v1/runners/${deviceId}/credentials/bash`, {
      body: { secret: 'anything' },
    });
    expect(response.status).toBe(400);
  });

  it('lists exactly the containers it manages, by label', async () => {
    const deviceId = randomUUID();
    await createRunner(deviceId);
    const response = await call('GET', '/v1/runners', {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runners: Array<{ deviceId: string }> };
    expect(body.runners.some((r) => r.deviceId === deviceId)).toBe(true);
  });

  it('destroys the container AND its volumes when asked — nothing of the user is left', async () => {
    const deviceId = randomUUID();
    await createRunner(deviceId);
    // Volumes exist only once the container has run (Docker materialises binds at start).
    await call('POST', `/v1/runners/${deviceId}/start`, {});
    await call('POST', `/v1/runners/${deviceId}/stop`, {});
    await expect(docker.volumeExists(homeVolumeName(deviceId))).resolves.toBe(true);

    const destroyed = await call('DELETE', `/v1/runners/${deviceId}?removeVolumes=true`, {});
    expect(destroyed.status).toBe(204);

    await expect(docker.inspectContainer(containerName(deviceId))).resolves.toBeNull();
    await expect(docker.volumeExists(homeVolumeName(deviceId))).resolves.toBe(false);
    await expect(docker.volumeExists(dataVolumeName(deviceId))).resolves.toBe(false);
  });

  it('answers 404 for lifecycle verbs on a device that has no container', async () => {
    const ghost = randomUUID();
    expect((await call('GET', `/v1/runners/${ghost}`, {})).status).toBe(404);
    expect((await call('POST', `/v1/runners/${ghost}/start`, {})).status).toBe(404);
    expect((await call('DELETE', `/v1/runners/${ghost}`, {})).status).toBe(404);
  });
});
