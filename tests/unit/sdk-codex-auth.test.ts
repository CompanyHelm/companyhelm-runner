import assert from "node:assert/strict";
import { ensureCodexRunnerStartState, extractCodexDeviceCodeFromOutput } from "../../dist/commands/sdk/codex/auth.js";
import { runSdkCodexUseDedicatedAuthCommand } from "../../dist/commands/sdk/codex/use-dedicated-auth.js";
import { runSdkCodexUseHostAuthCommand } from "../../dist/commands/sdk/codex/use-host-auth.js";

test("sdk codex use-host-auth updates an existing Codex SDK to host auth", async () => {
  const updateCalls: Array<{ authentication: string; status: string }> = [];
  const whereCalls: string[] = [];
  const closeCalls: string[] = [];

  await runSdkCodexUseHostAuthCommand(
    {
      state_db_path: "/tmp/companyhelm-test.db",
      config_directory: "/tmp/companyhelm-config",
      codex: {
        codex_auth_port: 1455,
        codex_auth_file_path: "codex-auth.json",
        codex_auth_path: "/tmp/.codex/auth.json",
      },
    } as any,
    {
      getHostInfoFn: () => ({
        uid: 1000,
        gid: 1000,
        home: "/tmp",
        codexAuthExists: true,
      }),
      initDbFn: async () => ({
        db: {
          select() {
            return {
              from() {
                return {
                  where() {
                    return {
                      get: async () => ({ name: "codex", authentication: "dedicated" }),
                    };
                  },
                };
              },
            };
          },
          update() {
            return {
              set(values: { authentication: string; status: string }) {
                updateCalls.push(values);
                return {
                  where() {
                    whereCalls.push("updated");
                    return Promise.resolve();
                  },
                };
              },
            };
          },
        },
        client: {
          close() {
            closeCalls.push("closed");
          },
        },
      }) as any,
    },
  );

  assert.deepEqual(updateCalls, [{ authentication: "host", status: "configured" }]);
  assert.deepEqual(whereCalls, ["updated"]);
  assert.deepEqual(closeCalls, ["closed"]);
});

test("sdk codex use-host-auth errors clearly when the host auth file does not exist", async () => {
  await assert.rejects(
    runSdkCodexUseHostAuthCommand(
      {
        state_db_path: "/tmp/companyhelm-test.db",
        config_directory: "/tmp/companyhelm-config",
        codex: {
          codex_auth_port: 1455,
          codex_auth_file_path: "codex-auth.json",
          codex_auth_path: "~/missing-auth.json",
        },
      } as any,
      {
        getHostInfoFn: () => ({
          uid: 1000,
          gid: 1000,
          home: "/tmp",
          codexAuthExists: false,
        }),
      },
    ),
    /Codex host auth file not found at .*missing-auth\.json\./,
  );
});

test("sdk codex use-dedicated-auth returns a friendly docker error when docker is unavailable", async () => {
  await assert.rejects(
    runSdkCodexUseDedicatedAuthCommand(
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
        initDbFn: async () => ({
          db: {},
          client: {
            close() {
              return undefined;
            },
          },
        }) as any,
        logInfo: () => undefined,
        logSuccess: () => undefined,
        spawnCommand: (() => ({
          on() {
            return undefined;
          },
        })) as any,
        spawnSyncCommand: (() => ({
          status: null,
          signal: null,
          output: [],
          pid: 0,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }),
        })) as any,
      },
    ),
    /Docker is not installed or not available on PATH\. Install Docker and retry\./,
  );
});

test("ensureCodexRunnerStartState auto-detects host auth and marks Codex configured", async () => {
  const updateCalls: Array<{ authentication: string; status: string }> = [];
  const loggedMessages: string[] = [];

  await ensureCodexRunnerStartState(
    {
      state_db_path: "/tmp/companyhelm-test.db",
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
        home: "/tmp",
        codexAuthExists: true,
      }),
      initDbFn: async () => ({
        db: {
          select() {
            return {
              from() {
                return {
                  where() {
                    return {
                      get: async () => ({ name: "codex", authentication: "unauthenticated", status: "unconfigured" }),
                    };
                  },
                };
              },
            };
          },
          update() {
            return {
              set(values: { authentication: string; status: string }) {
                updateCalls.push(values);
                return {
                  where() {
                    return Promise.resolve();
                  },
                };
              },
            };
          },
        },
        client: { close() {} },
      }) as any,
      logInfo: (message: string) => {
        loggedMessages.push(message);
      },
    },
  );

  assert.deepEqual(updateCalls, [{ authentication: "host", status: "configured" }]);
  assert.match(loggedMessages[0] ?? "", /host auth/i);
});

test("ensureCodexRunnerStartState preserves existing dedicated auth when requested", async () => {
  const updateCalls: Array<{ authentication: string; status: string }> = [];
  const insertCalls: Array<{ name: string; authentication: string; status: string }> = [];

  await ensureCodexRunnerStartState(
    {
      state_db_path: "/tmp/companyhelm-test.db",
      config_directory: "/tmp/companyhelm-config",
      codex: {
        codex_auth_port: 1455,
        codex_auth_file_path: "codex-auth.json",
        codex_auth_path: "/home/agent/.codex/auth.json",
      },
    } as any,
    {
      useDedicatedAuth: true,
      getHostInfoFn: () => ({
        uid: 1000,
        gid: 1000,
        home: "/tmp",
        codexAuthExists: true,
      }),
      initDbFn: async () => ({
        db: {
          select() {
            return {
              from() {
                return {
                  where() {
                    return {
                      get: async () => ({ name: "codex", authentication: "dedicated", status: "configured" }),
                    };
                  },
                };
              },
            };
          },
          update() {
            return {
              set(values: { authentication: string; status: string }) {
                updateCalls.push(values);
                return {
                  where() {
                    return Promise.resolve();
                  },
                };
              },
            };
          },
          insert() {
            return {
              values(values: { name: string; authentication: string; status: string }) {
                insertCalls.push(values);
                return Promise.resolve();
              },
            };
          },
        },
        client: { close() {} },
      }) as any,
      logInfo: () => undefined,
    },
  );

  assert.deepEqual(updateCalls, []);
  assert.deepEqual(insertCalls, []);
});

test("ensureCodexRunnerStartState marks Codex unconfigured when dedicated auth is requested without existing dedicated setup", async () => {
  const updateCalls: Array<{ authentication: string; status: string }> = [];

  await ensureCodexRunnerStartState(
    {
      state_db_path: "/tmp/companyhelm-test.db",
      config_directory: "/tmp/companyhelm-config",
      codex: {
        codex_auth_port: 1455,
        codex_auth_file_path: "codex-auth.json",
        codex_auth_path: "/home/agent/.codex/auth.json",
      },
    } as any,
    {
      useDedicatedAuth: true,
      getHostInfoFn: () => ({
        uid: 1000,
        gid: 1000,
        home: "/tmp",
        codexAuthExists: true,
      }),
      initDbFn: async () => ({
        db: {
          select() {
            return {
              from() {
                return {
                  where() {
                    return {
                      get: async () => ({ name: "codex", authentication: "host", status: "configured" }),
                    };
                  },
                };
              },
            };
          },
          update() {
            return {
              set(values: { authentication: string; status: string }) {
                updateCalls.push(values);
                return {
                  where() {
                    return Promise.resolve();
                  },
                };
              },
            };
          },
        },
        client: { close() {} },
      }) as any,
      logInfo: () => undefined,
    },
  );

  assert.deepEqual(updateCalls, [{ authentication: "unauthenticated", status: "unconfigured" }]);
});

test("extractCodexDeviceCodeFromOutput reads the one-time device code from Codex login output", () => {
  const output = `
Welcome to Codex [v0.110.0]

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   R2OU-ZVJKU
`;

  assert.equal(extractCodexDeviceCodeFromOutput(output), "R2OU-ZVJKU");
});

test("extractCodexDeviceCodeFromOutput handles ANSI-colored Codex login output", () => {
  const output = `
Welcome to Codex [v\u001b[90m0.110.0\u001b[0m]
\u001b[90mOpenAI's command-line coding agent\u001b[0m

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m
   \u001b[94mR3YV-AJ0YQ\u001b[0m
`;

  assert.equal(extractCodexDeviceCodeFromOutput(output), "R3YV-AJ0YQ");
});
