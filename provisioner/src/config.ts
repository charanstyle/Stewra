import { z } from 'zod';

/**
 * Provisioner configuration — every value that names a target or a safety cap is REQUIRED, with no
 * default. A provisioner that guesses its Docker socket, its image, or its resource limits is a
 * provisioner that can silently create unbounded containers from the wrong image on the wrong
 * network; refusing to start is the feature.
 */
/**
 * A required numeric setting. The string check comes FIRST on purpose: `z.coerce.number()` turns an
 * absent value into NaN before `required_error` can fire, so an unset cap would report "Expected
 * number, received nan" — which reads like a typo in the value rather than a setting nobody wrote.
 * The operator has to be told WHICH setting is missing, by name.
 */
const requiredPositiveInt = (name: string) =>
  z
    .string({ required_error: `${name} is not set` })
    .min(1, `${name} is not set`)
    .pipe(z.coerce.number().int().positive());

const envSchema = z.object({
  /**
   * Bearer token the backend must present. ≥32 characters because this token is the entire
   * authentication story between the backend and the process holding the Docker socket.
   */
  PROVISIONER_TOKEN: z
    .string({ required_error: 'PROVISIONER_TOKEN is not set' })
    .min(32, 'PROVISIONER_TOKEN must be at least 32 characters'),

  /** Path to the Docker Engine socket. A target — named explicitly, never guessed. */
  DOCKER_SOCKET: z.string({ required_error: 'DOCKER_SOCKET is not set' }).min(1),

  /**
   * The EXACT image (repository:tag) every runner container is created from. Requests must name it
   * verbatim — the API rejects anything else, so a compromised backend cannot ask this service to
   * run an arbitrary image with the runner template's volumes attached.
   */
  RUNNER_IMAGE: z
    .string({ required_error: 'RUNNER_IMAGE is not set' })
    .regex(/^[a-z0-9][a-z0-9._\-/]*:[A-Za-z0-9._-]+$/, 'RUNNER_IMAGE must be an exact repository:tag'),

  /** The isolated Docker network runner containers attach to (see deploy/hosted-runner/). */
  RUNNER_NETWORK: z.string({ required_error: 'RUNNER_NETWORK is not set' }).min(1),

  /** Hard memory cap per runner container, in bytes. Also the swap cap — hosted runners get no swap. */
  RUNNER_MEMORY_BYTES: requiredPositiveInt('RUNNER_MEMORY_BYTES'),

  /** CPU cap per runner container, in Docker NanoCpus (1e9 = one full CPU). */
  RUNNER_NANO_CPUS: requiredPositiveInt('RUNNER_NANO_CPUS'),

  /** Process-count cap per runner container — the fork-bomb lid. */
  RUNNER_PIDS_LIMIT: requiredPositiveInt('RUNNER_PIDS_LIMIT'),

  /** Listen port. A behaviour knob (the service is only reachable on the internal compose network). */
  PROVISIONER_PORT: z.coerce.number().int().min(1).max(65535).default(3050),
});

export interface ProvisionerConfig {
  readonly token: string;
  readonly dockerSocket: string;
  readonly image: string;
  readonly network: string;
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  readonly port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProvisionerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Provisioner configuration invalid — ${details}`);
  }
  return {
    token: parsed.data.PROVISIONER_TOKEN,
    dockerSocket: parsed.data.DOCKER_SOCKET,
    image: parsed.data.RUNNER_IMAGE,
    network: parsed.data.RUNNER_NETWORK,
    memoryBytes: parsed.data.RUNNER_MEMORY_BYTES,
    nanoCpus: parsed.data.RUNNER_NANO_CPUS,
    pidsLimit: parsed.data.RUNNER_PIDS_LIMIT,
    port: parsed.data.PROVISIONER_PORT,
  };
}
