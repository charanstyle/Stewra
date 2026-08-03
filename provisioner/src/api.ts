import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { z } from 'zod';
import { RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import type { ProvisionerConfig } from './config.js';
import { DockerError } from './dockerClient.js';
import type { ContainerInspect, DockerClient } from './dockerClient.js';
import {
  MANAGED_LABEL,
  containerName,
  dataVolumeName,
  homeVolumeName,
  runnerContainerSpec,
} from './template.js';
import { packTar } from './tar.js';

/**
 * The provisioner's HTTP surface — the ONLY way anything reaches the Docker socket. Small on purpose:
 * a fixed set of verbs over containers the template defines, guarded by a bearer token and zod
 * schemas that reject anything the contract doesn't name BEFORE any Docker call happens.
 *
 * Requests and responses are logged as method/path/status only. Bodies are NEVER logged: the
 * credentials endpoint carries provider secrets, and one stray log line would put a user's Claude
 * token in the journal of the host.
 */

/** Runner device ids are backend-minted UUIDs; anything else never reaches a container name. */
const deviceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'deviceId must be a UUID');

/**
 * Env keys the backend may set on a runner container. STEWRA_* runner knobs and the API target only —
 * no PATH, no LD_PRELOAD, no NODE_OPTIONS; an env-injection into the backend must die here.
 */
const ENV_KEY_PATTERN = /^STEWRA_(API_URL|API_PREFIX|RUNNER_[A-Z0-9_]+)$/;

const createSchema = z.object({
  deviceId: deviceIdSchema,
  /** Must STRICTLY equal the configured image tag — declared here so the mismatch is a 400, not a mystery. */
  image: z.string().min(1),
  env: z
    .record(z.string().max(4096).regex(/^[^\n\r]*$/, 'env values must be single-line'))
    .refine(
      (env) => Object.keys(env).every((key) => ENV_KEY_PATTERN.test(key)),
      (env) => ({
        message: `env keys not allowed: ${Object.keys(env)
          .filter((key) => !ENV_KEY_PATTERN.test(key))
          .join(', ')}`,
      }),
    ),
});

const credentialSchema = z.object({
  /** The provider secret, verbatim. Transits this request and the tar body — never disk, never logs. */
  secret: z.string().min(1).max(65536),
});

const slotSchema = z.enum(RUNNER_HARNESS_IDS);

/** The uid/gid the runner image creates its user with (see runner/Dockerfile) — volumes must match. */
const RUNNER_UID = 10001;

const MAX_BODY_BYTES = 256 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(buf);
  }
  if (total === 0) throw new HttpError(400, 'request body required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/** What the backend sees of a runner container. */
function view(inspect: ContainerInspect): {
  deviceId: string;
  containerName: string;
  status: string;
  startedAt: string;
} {
  return {
    deviceId: inspect.Config.Labels['stewra.device_id'] ?? '',
    containerName: inspect.Name.replace(/^\//, ''),
    status: inspect.State.Status,
    startedAt: inspect.State.StartedAt,
  };
}

export function createProvisionerApi(
  config: ProvisionerConfig,
  docker: DockerClient,
): Server {
  const tokenDigest = createHash('sha256').update(config.token).digest();

  function assertAuthorized(req: IncomingMessage): void {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    // Compare digests, not strings: constant-time, and length differences don't throw.
    const presentedDigest = createHash('sha256').update(presented).digest();
    if (!timingSafeEqual(tokenDigest, presentedDigest)) {
      throw new HttpError(401, 'missing or invalid provisioner token');
    }
  }

  async function inspectOr404(deviceId: string): Promise<ContainerInspect> {
    const inspect = await docker.inspectContainer(containerName(deviceId));
    if (inspect === null) throw new HttpError(404, `no runner container for device ${deviceId}`);
    return inspect;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://provisioner.internal');
    const method = req.method ?? 'GET';

    if (url.pathname === '/healthz' && method === 'GET') {
      // Unauthenticated liveness for the compose healthcheck; it reveals reachability and daemon
      // version, nothing about containers. Failing when Docker is down is the point of the probe.
      const { Version } = await docker.version();
      sendJson(res, 200, { ok: true, dockerVersion: Version });
      return;
    }

    assertAuthorized(req);

    if (url.pathname === '/v1/runners' && method === 'POST') {
      const body = createSchema.parse(await readJsonBody(req));
      if (body.image !== config.image) {
        throw new HttpError(
          400,
          `image mismatch: this provisioner only creates ${config.image} (request named ${body.image})`,
        );
      }
      await docker.createContainer(
        containerName(body.deviceId),
        runnerContainerSpec(body.deviceId, body.env, config),
      );
      sendJson(res, 201, view(await inspectOr404(body.deviceId)));
      return;
    }

    if (url.pathname === '/v1/runners' && method === 'GET') {
      const containers = await docker.listContainers(MANAGED_LABEL);
      sendJson(res, 200, {
        runners: containers.map((c) => ({
          deviceId: c.Labels['stewra.device_id'] ?? '',
          containerName: (c.Names[0] ?? '').replace(/^\//, ''),
          status: c.State,
        })),
      });
      return;
    }

    const runnerMatch = /^\/v1\/runners\/([^/]+)$/.exec(url.pathname);
    if (runnerMatch !== null) {
      const deviceId = deviceIdSchema.parse(decodeURIComponent(runnerMatch[1] ?? ''));
      if (method === 'GET') {
        sendJson(res, 200, view(await inspectOr404(deviceId)));
        return;
      }
      if (method === 'DELETE') {
        await inspectOr404(deviceId); // 404 for a device that never existed, not a silent no-op
        await docker.removeContainer(containerName(deviceId));
        if (url.searchParams.get('removeVolumes') === 'true') {
          await docker.removeVolume(homeVolumeName(deviceId));
          await docker.removeVolume(dataVolumeName(deviceId));
        }
        res.writeHead(204);
        res.end();
        return;
      }
    }

    const actionMatch = /^\/v1\/runners\/([^/]+)\/(start|stop)$/.exec(url.pathname);
    if (actionMatch !== null && method === 'POST') {
      const deviceId = deviceIdSchema.parse(decodeURIComponent(actionMatch[1] ?? ''));
      await inspectOr404(deviceId);
      if (actionMatch[2] === 'start') {
        await docker.startContainer(containerName(deviceId));
      } else {
        await docker.stopContainer(containerName(deviceId));
      }
      sendJson(res, 200, view(await inspectOr404(deviceId)));
      return;
    }

    const credentialMatch = /^\/v1\/runners\/([^/]+)\/credentials\/([^/]+)$/.exec(url.pathname);
    if (credentialMatch !== null && method === 'PUT') {
      const deviceId = deviceIdSchema.parse(decodeURIComponent(credentialMatch[1] ?? ''));
      const slot = slotSchema.parse(decodeURIComponent(credentialMatch[2] ?? ''));
      const body = credentialSchema.parse(await readJsonBody(req));
      await inspectOr404(deviceId);
      // Written through Docker's archive API onto the home VOLUME: never argv, never container env,
      // so it appears in neither `docker inspect` nor `ps`. Mode 0600, owned by the runner user.
      const archive = packTar([
        { name: '.stewra-runner/', mode: 0o700, uid: RUNNER_UID, gid: RUNNER_UID },
        { name: '.stewra-runner/credentials/', mode: 0o700, uid: RUNNER_UID, gid: RUNNER_UID },
        {
          name: `.stewra-runner/credentials/${slot}`,
          content: Buffer.from(body.secret, 'utf8'),
          mode: 0o600,
          uid: RUNNER_UID,
          gid: RUNNER_UID,
        },
      ]);
      await docker.putArchive(containerName(deviceId), '/home/runner', archive);
      res.writeHead(204);
      res.end();
      return;
    }

    throw new HttpError(404, `no route: ${method} ${url.pathname}`);
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { message: error.message } });
      } else if (error instanceof z.ZodError) {
        const details = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        sendJson(res, 400, { error: { message: `invalid request: ${details}` } });
      } else if (error instanceof DockerError) {
        // Docker's own complaint, verbatim status where it maps cleanly (409 name conflict), 502
        // otherwise — the daemon failing is an upstream failure, not a bad request.
        const status = error.status === 409 ? 409 : 502;
        sendJson(res, status, { error: { message: error.message } });
      } else {
        sendJson(res, 500, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      }
      // The provisioner's only log sink is stdout/stderr, and this line carries method/path/status,
      // never a body — the credentials route's payload must never reach a log.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'request failed',
          method: req.method,
          path: req.url?.split('?')[0],
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });
}
