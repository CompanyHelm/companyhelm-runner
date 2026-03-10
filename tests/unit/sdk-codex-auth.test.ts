import assert from "node:assert/strict";
import { runSdkCodexUseDedicatedAuthCommand } from "../../dist/commands/sdk/codex/use-dedicated-auth.js";
import { runSdkCodexUseHostAuthCommand } from "../../dist/commands/sdk/codex/use-host-auth.js";

test("sdk codex use-host-auth updates an existing Codex SDK to host auth", async () => {
  const updateCalls: Array<{ authentication: string }> = [];
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
              set(values: { authentication: string }) {
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

  assert.deepEqual(updateCalls, [{ authentication: "host" }]);
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
