import assert from "node:assert/strict";
import type * as p from "@clack/prompts";
import { startup } from "../../dist/commands/startup.js";

class ExitSignal extends Error {
  constructor(readonly exitCode: number) {
    super(`process.exit(${exitCode})`);
  }
}

test("startup shows a friendly error when docker is unavailable for dedicated auth", async () => {
  const cancelledMessages: string[] = [];
  const originalExit = process.exit;
  const originalConsoleLog = console.log;
  const promptApi = {
    spinner: () => ({
      start() {
        return undefined;
      },
      stop() {
        return undefined;
      },
    }),
    intro: () => undefined,
    select: async () => "dedicated",
    isCancel: () => false,
    cancel: (message: string) => {
      cancelledMessages.push(message);
    },
    outro: () => undefined,
    log: {
      info: () => undefined,
      success: () => undefined,
    },
  } as unknown as typeof p;

  const spawnSyncCommand = (() => ({
    status: null,
    signal: null,
    output: [],
    pid: 0,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }),
  })) as any;

  process.exit = (((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as unknown) as typeof process.exit;
  console.log = () => undefined;

  try {
    await assert.rejects(
      startup(
        {
          state_db_path: "/tmp/companyhelm-test.db",
          runtime_image: "companyhelm/runner:latest",
          config_directory: "/tmp/companyhelm-config",
          codex: {
            codex_auth_port: 1455,
            codex_auth_file_path: "codex-auth.json",
            codex_auth_path: "/home/agent/.codex/auth.json",
          },
        } as any,
        {
          getHostInfoFn: () => ({
            uid: 1000,
            gid: 1000,
            codexAuthExists: false,
          }),
          initDbFn: async () => ({
            db: {
              select() {
                return {
                  from() {
                    return {
                      async all() {
                        return [];
                      },
                    };
                  },
                };
              },
            },
          }),
          promptApi,
          spawnSyncCommand,
        },
      ),
      (error: unknown) => error instanceof ExitSignal && error.exitCode === 1,
    );
  } finally {
    process.exit = originalExit;
    console.log = originalConsoleLog;
  }

  assert.deepEqual(cancelledMessages, ["Docker is not installed or not available on PATH. Install Docker and retry."]);
});

test("startup skips auth selection prompt when only dedicated auth is available", async () => {
  let selectCalls = 0;
  const promptApi = {
    spinner: () => ({
      start() {
        return undefined;
      },
      stop() {
        return undefined;
      },
    }),
    intro: () => undefined,
    select: async () => {
      selectCalls += 1;
      throw new Error("select should not be called when only one auth mode is available");
    },
    isCancel: () => false,
    cancel: () => undefined,
    outro: () => undefined,
    log: {
      info: () => undefined,
      success: () => undefined,
    },
  } as unknown as typeof p;

  let refreshCalls = 0;

  await startup(
    {
      state_db_path: "/tmp/companyhelm-test.db",
      runtime_image: "companyhelm/runner:latest",
      config_directory: "/tmp/companyhelm-config",
      codex: {
        codex_auth_port: 1455,
        codex_auth_file_path: "codex-auth.json",
        codex_auth_path: "/home/agent/.codex/auth.json",
      },
    } as any,
    {
      getHostInfoFn: () => ({
        uid: 1000,
        gid: 1000,
        codexAuthExists: false,
      }),
      initDbFn: async () => ({
        db: {
          select() {
            return {
              from() {
                return {
                  where() {
                    return {
                      async get() {
                        return null;
                      },
                    };
                  },
                  async all() {
                    return [];
                  },
                };
              },
            };
          },
          insert() {
            return {
              values() {
                return Promise.resolve();
              },
            };
          },
        },
      }),
      promptApi,
      refreshSdkModelsFn: async () => {
        refreshCalls += 1;
        return [{ modelCount: 0 }];
      },
      spawnCommand: (() => ({
        on() {
          return undefined;
        },
      })) as any,
      spawnSyncCommand: (() => ({
        status: 0,
        signal: null,
        output: [],
        pid: 0,
        stdout: "/home/agent/.codex/auth.json",
        stderr: "",
      })) as any,
    },
  );

  assert.equal(selectCalls, 0);
  assert.equal(refreshCalls, 1);
});
