import type { ProvisionerConfig } from './config.js';

/**
 * THE hosted-runner container template. This file is the security boundary of the whole hosted-runner
 * design: the backend (which parses untrusted internet input) can ask for a container by device id,
 * but every capability-, resource-, mount-, and network-relevant field is decided HERE, in a service
 * the backend can only reach through a four-verb HTTP API. There is deliberately no way for a request
 * to influence anything below except the device id (names/labels/volumes) and an allowlisted env.
 *
 * What the hardening buys, line by line, is annotated inline — this template is reviewed as a unit.
 */

export function containerName(deviceId: string): string {
  return `stewra-runner-${deviceId}`;
}

export function homeVolumeName(deviceId: string): string {
  return `stewra-runner-home-${deviceId}`;
}

export function dataVolumeName(deviceId: string): string {
  return `stewra-runner-data-${deviceId}`;
}

/** The label every provisioner-managed container carries — how reconciliation finds its own. */
export const MANAGED_LABEL = 'stewra.managed=true';

export function runnerContainerSpec(
  deviceId: string,
  env: Readonly<Record<string, string>>,
  config: ProvisionerConfig,
): object {
  return {
    // The image is the CONFIGURED tag, never the requested one — api.ts has already rejected any
    // request that names something else, and this line makes the check unbypassable.
    Image: config.image,
    Env: [
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      // Worktrees are created under os.tmpdir(); pointed at the data volume so they land on disk
      // that survives restarts and is bounded by the volume, not in the container's RAM-backed tmpfs.
      'TMPDIR=/data/tmp',
    ],
    Labels: {
      'stewra.managed': 'true',
      'stewra.device_id': deviceId,
    },
    HostConfig: {
      // The runner runs USER code. It gets no Linux capabilities at all — not "the default set",
      // none — and can never gain privileges it didn't start with (setuid binaries stop working).
      //
      // THE IMAGE CONTRACT this imposes: whatever RUNNER_IMAGE names must declare its non-root user
      // at BUILD time (`USER runner`) and exec its process directly. Without CAP_SETUID an entrypoint
      // that drops privilege at runtime — `setpriv`/`su-exec`/`gosu`, the standard shape of the
      // official redis/postgres/nginx images — exits immediately with "setresuid failed". The runner
      // image is built this way on purpose (runner/Dockerfile); do not swap in one that isn't.
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      // Hard caps: memory (and NO swap headroom — MemorySwap equal to Memory means swap is denied),
      // CPU, and process count (the fork-bomb lid). All three come from config, all three required.
      Memory: config.memoryBytes,
      MemorySwap: config.memoryBytes,
      NanoCpus: config.nanoCpus,
      PidsLimit: config.pidsLimit,
      // Lifecycle belongs to the backend's control plane (idle-stop, wake), not to the Docker daemon.
      RestartPolicy: { Name: 'no' },
      // The isolated runner network — created by deploy/hosted-runner/create-network.sh with
      // inter-container communication off, and fenced from the LAN by iptables-egress.sh.
      NetworkMode: config.network,
      // Exactly two writable places, both per-device named volumes: the home directory (device token,
      // credential slots, git config) and the data directory (clones, worktrees, TMPDIR).
      Binds: [
        `${homeVolumeName(deviceId)}:/home/runner`,
        `${dataVolumeName(deviceId)}:/data`,
      ],
    },
  };
}
