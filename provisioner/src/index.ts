import { loadConfig } from './config.js';
import { DockerClient } from './dockerClient.js';
import { createProvisionerApi } from './api.js';

/**
 * Boot: configuration first (refusing to start on a bad env is the feature — see config.ts), then a
 * proof the Docker socket actually answers, then the API. A provisioner that comes up without its
 * daemon would accept requests and fail them all; better to crash at boot where the operator looks.
 */
const config = loadConfig();
const docker = new DockerClient(config.dockerSocket);

const { Version } = await docker.version();

const server = createProvisionerApi(config, docker);
server.listen(config.port, '0.0.0.0', () => {
  // stdout is this service's log sink (docker logs / journald on the host).
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'provisioner listening',
      port: config.port,
      image: config.image,
      network: config.network,
      dockerVersion: Version,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void docker.close().then(() => process.exit(0));
    });
  });
}
