import {
  DockerRuntime,
  resolveLocalDockerConnection,
  type FixedProgram,
  type LocalDockerOptions,
  type RuntimeInputs
} from "../kernel/docker-runtime.js";

/** Trusted host seam only. Worker/project data never chooses Docker options or programs. */
export class ProjectDockerRuntime {
  readonly connection;
  private readonly runtime: DockerRuntime;
  constructor(options: LocalDockerOptions & { home: string; timeoutMs?: number }) {
    if (Object.keys(options).some((key) => !["home", "timeoutMs", "dockerEndpoint", "dockerContext"].includes(key)))
      throw new Error("BUILD_DOCKER_CONNECTION");
    this.connection = resolveLocalDockerConnection({
      ...(options.dockerEndpoint === undefined ? {} : { dockerEndpoint: options.dockerEndpoint }),
      ...(options.dockerContext === undefined ? {} : { dockerContext: options.dockerContext })
    });
    this.runtime = new DockerRuntime(options.timeoutMs, { connection: this.connection, home: options.home });
  }
  inspectImage(reference: string, deadline?: number) {
    return this.runtime.inspectImage(reference, deadline);
  }
  policyHash(image: string) {
    return this.runtime.policyHash(image);
  }
  argumentMetadata() {
    return this.runtime.argumentMetadata();
  }
  withContainer<T>(
    image: string,
    inputs: RuntimeInputs,
    body: (container: {
      readonly id: string;
      readonly actual: unknown;
      runFixed: (program: FixedProgram, input?: string) => ReturnType<DockerRuntime["runFixed"]>;
      invocation: (program: FixedProgram) => ReturnType<DockerRuntime["invocation"]>;
    }) => Promise<T>,
    deadline?: number
  ): Promise<T> {
    return this.runtime.withContainer(
      image,
      inputs,
      async (id, actual) => {
        let active = true;
        const assertActive = () => {
          if (!active) throw new Error("BUILD_DOCKER_CONTAINER_CLOSED");
        };
        try {
          return await body(
            Object.freeze({
              id,
              actual,
              runFixed: (program: FixedProgram, input?: string) => {
                assertActive();
                return this.runtime.runFixed(id, program, input, deadline);
              },
              invocation: (program: FixedProgram) => {
                assertActive();
                return this.runtime.invocation(id, program, deadline);
              }
            })
          );
        } finally {
          active = false;
        }
      },
      deadline
    );
  }
}
