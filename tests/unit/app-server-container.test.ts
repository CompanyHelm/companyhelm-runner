import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AppServerContainerService } from "../../dist/service/docker/app_server_container.js";

function callEnsureImageAvailable(service: AppServerContainerService, image: string): Promise<void> {
  return (service as unknown as { ensureImageAvailable: (imageName: string) => Promise<void> }).ensureImageAvailable(image);
}

test("AppServerContainerService skips pull when runtime image already exists", async () => {
  let pullCalled = false;
  const reportedMessages: string[] = [];

  const fakeDocker = {
    getImage() {
      return {
        async inspect() {
          return {};
        },
      };
    },
    pull(_image: string, _callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void) {
      pullCalled = true;
    },
  };

  const service = new AppServerContainerService({
    docker: fakeDocker as any,
    imageStatusReporter: (message) => reportedMessages.push(message),
  });

  await callEnsureImageAvailable(service, "companyhelm/runner:latest");

  assert.equal(pullCalled, false);
  assert.deepEqual(reportedMessages, []);
});

test("AppServerContainerService pulls missing runtime image before app-server startup", async () => {
  const reportedMessages: string[] = [];
  const pulledImages: string[] = [];

  const fakeDocker = {
    getImage(_image: string) {
      return {
        async inspect() {
          throw { statusCode: 404, message: "No such image" };
        },
      };
    },
    pull(image: string, callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void) {
      pulledImages.push(image);
      callback(null, {} as NodeJS.ReadableStream);
    },
    modem: {
      followProgress(
        _stream: NodeJS.ReadableStream,
        onFinished: (error: Error | null) => void,
        onProgress?: (event: unknown) => void,
      ) {
        onProgress?.({ status: "Pulling from companyhelm/runner" });
        onProgress?.({
          id: "layer-1",
          progressDetail: {
            current: 10,
            total: 100,
          },
        });
        onProgress?.({
          id: "layer-1",
          progressDetail: {
            current: 100,
            total: 100,
          },
        });
        onFinished(null);
      },
    },
  };

  const service = new AppServerContainerService({
    docker: fakeDocker as any,
    imageStatusReporter: (message) => reportedMessages.push(message),
  });

  await callEnsureImageAvailable(service, "companyhelm/runner:latest");

  assert.deepEqual(pulledImages, ["companyhelm/runner:latest"]);
  assert.deepEqual(reportedMessages, [
    "Docker image 'companyhelm/runner:latest' not found locally. Pulling remotely.",
    "Pulling Docker image 'companyhelm/runner:latest': Pulling from companyhelm/runner",
    "Pulling Docker image 'companyhelm/runner:latest': 10%",
    "Pulling Docker image 'companyhelm/runner:latest': 100%",
    "Docker image 'companyhelm/runner:latest' is ready.",
  ]);
});

test("AppServerContainerService reports launch progress when starting the runner container", async () => {
  const reportedMessages: string[] = [];
  const spawnedCommands: Array<{ command: string; args: string[] }> = [];
  const fakeDocker = {
    getImage() {
      return {
        async inspect() {
          return {};
        },
      };
    },
  };

  class FakeChildProcess extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    stdin = {
      write() {
        return true;
      },
    };
    killed = false;

    kill() {
      this.killed = true;
      setImmediate(() => {
        this.emit("exit", 0);
      });
      return true;
    }
  }

  const childProcess = require("node:child_process") as typeof import("node:child_process");
  const configModule = require("../../dist/config.js") as typeof import("../../dist/config.js");
  const dbModule = require("../../dist/state/db.js") as typeof import("../../dist/state/db.js");
  const hostModule = require("../../dist/service/host.js") as typeof import("../../dist/service/host.js");

  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const originalParse = configModule.config.parse;
  const originalInitDb = dbModule.initDb;
  const originalGetHostInfo = hostModule.getHostInfo;
  const originalDateNow = Date.now;

  Date.now = () => 1_700_000_000_000;
  childProcess.spawn = (((command: string, args: string[]) => {
    spawnedCommands.push({ command, args });
    return new FakeChildProcess();
  }) as unknown) as typeof childProcess.spawn;
  childProcess.spawnSync = (() => ({ status: 0, signal: null, error: undefined })) as typeof childProcess.spawnSync;
  configModule.config.parse = (() => ({
    state_db_path: "/tmp/companyhelm-test.db",
    runtime_image: "companyhelm/runner:latest",
    agent_home_directory: "/home/agent",
    agent_user: "agent",
    config_directory: "/tmp/companyhelm-config",
    codex: {
      codex_auth_path: "/home/agent/.codex/auth.json",
      codex_auth_file_path: "codex-auth.json",
    },
  })) as typeof configModule.config.parse;
  dbModule.initDb = (async () => ({
    db: {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async get() {
                    return { name: "codex", authentication: "host" };
                  },
                };
              },
            };
          },
        };
      },
    },
    client: {
      close() {
        return undefined;
      },
    },
  })) as typeof dbModule.initDb;
  hostModule.getHostInfo = (() => ({
    uid: 1000,
    gid: 1000,
    codexAuthExists: true,
  })) as typeof hostModule.getHostInfo;

  try {
    const service = new AppServerContainerService({
      docker: fakeDocker as any,
      imageStatusReporter: (message) => reportedMessages.push(message),
    });

    await service.start();
    await service.stop();
  } finally {
    Date.now = originalDateNow;
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
    configModule.config.parse = originalParse;
    dbModule.initDb = originalInitDb;
    hostModule.getHostInfo = originalGetHostInfo;
  }

  assert.deepEqual(reportedMessages, [
    "Launching Docker container from image 'companyhelm/runner:latest'.",
    "Waiting for app-server to initialize in Docker container 'companyhelm-codex-app-server-1700000000000'.",
  ]);
  assert.equal(spawnedCommands.length, 1);
  assert.equal(spawnedCommands[0]?.command, "docker");
  const bootstrapScript = spawnedCommands[0]?.args.at(-1) ?? "";
  assert.match(bootstrapScript, /getent passwd "\$AGENT_UID"/);
  assert.match(bootstrapScript, /AGENT_USER="\$EXISTING_UID_USER"/);
  assert.match(bootstrapScript, /usermod -u "\$AGENT_UID" -g "\$AGENT_GROUP" -d "\$AGENT_HOME" -s \/bin\/bash "\$AGENT_USER"/);
});

test("AppServerContainerService includes exit details when the app-server container dies before initialize", async () => {
  const fakeDocker = {
    getImage() {
      return {
        async inspect() {
          return {};
        },
      };
    },
  };

  class ExitingChildProcess extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    stdin = {
      write() {
        return true;
      },
    };
    killed = false;

    constructor() {
      super();
      setImmediate(() => {
        this.stderr.emit("data", Buffer.from("bootstrap failed\n"));
        this.emit("exit", 17, null);
      });
    }

    kill() {
      this.killed = true;
      return true;
    }
  }

  const childProcess = require("node:child_process") as typeof import("node:child_process");
  const configModule = require("../../dist/config.js") as typeof import("../../dist/config.js");
  const dbModule = require("../../dist/state/db.js") as typeof import("../../dist/state/db.js");
  const hostModule = require("../../dist/service/host.js") as typeof import("../../dist/service/host.js");

  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const originalParse = configModule.config.parse;
  const originalInitDb = dbModule.initDb;
  const originalGetHostInfo = hostModule.getHostInfo;

  childProcess.spawn = (() => new ExitingChildProcess()) as typeof childProcess.spawn;
  childProcess.spawnSync = (() => ({ status: 0, signal: null, error: undefined })) as typeof childProcess.spawnSync;
  configModule.config.parse = (() => ({
    state_db_path: "/tmp/companyhelm-test.db",
    runtime_image: "companyhelm/runner:latest",
    agent_home_directory: "/home/agent",
    agent_user: "agent",
    config_directory: "/tmp/companyhelm-config",
    codex: {
      codex_auth_path: "/home/agent/.codex/auth.json",
      codex_auth_file_path: "codex-auth.json",
    },
  })) as typeof configModule.config.parse;
  dbModule.initDb = (async () => ({
    db: {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async get() {
                    return { name: "codex", authentication: "dedicated" };
                  },
                };
              },
            };
          },
        };
      },
    },
    client: {
      close() {
        return undefined;
      },
    },
  })) as typeof dbModule.initDb;
  hostModule.getHostInfo = (() => ({
    uid: 1000,
    gid: 1000,
    codexAuthExists: true,
  })) as typeof hostModule.getHostInfo;

  try {
    const service = new AppServerContainerService({
      docker: fakeDocker as any,
    });

    await service.start();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      (service as unknown as { sendRaw: (payload: string) => Promise<void> }).sendRaw("{}\n"),
      /App server container is not running \(container companyhelm-codex-app-server-.*exit code 17, stderr: bootstrap failed\)/,
    );
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
    configModule.config.parse = originalParse;
    dbModule.initDb = originalInitDb;
    hostModule.getHostInfo = originalGetHostInfo;
  }
});
