// Compatibility adapter: preserves legacy command environment, arguments and timeouts.
export {
  DockerRuntime as LegacyDockerRuntime,
  DockerUnavailable,
  validateDockerIsolation,
  run,
  docker,
  digest,
  imageReference,
  legacyIsolation as isolation
} from "../kernel/docker-runtime.js";
