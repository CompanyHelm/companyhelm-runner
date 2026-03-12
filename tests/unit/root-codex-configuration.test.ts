import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create } from "@bufbuild/protobuf";

const require = createRequire(import.meta.url);
const { CodexAuthType, ServerMessageSchema } = require("@companyhelm/protos");

const { runCommandLoop } = require("../../dist/commands/root.js");
const authModule = require("../../dist/commands/sdk/codex/auth.js");
const refreshModelsModule = require("../../dist/service/sdk/refresh_models.js");
const { initDb } = require("../../dist/state/db.js");
const { agentSdks, llmModels } = require("../../dist/state/schema.js");

function createSingleMessageCommandChannel(message: unknown): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      yield message;
    },
  };
}

test("runCommandLoop sends device code and ready sdk update for Codex device auth requests", async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-runner-root-auth-"));
  const stateDbPath = path.join(tempDirectory, "state.db");
  const sentMessages: any[] = [];

  const originalRunCodexDeviceCodeAuth = authModule.runCodexDeviceCodeAuth;
  const originalRefreshSdkModels = refreshModelsModule.refreshSdkModels;

  authModule.runCodexDeviceCodeAuth = async (cfg: any, onDeviceCode: (deviceCode: string) => Promise<void>) => {
    await onDeviceCode("R2OU-ZVJKU");
    const { db, client } = await initDb(cfg.state_db_path);
    try {
      await db.insert(agentSdks).values({ name: "codex", authentication: "dedicated", status: "configured" });
      await db.insert(llmModels).values({ name: "gpt-5.3-codex", sdkName: "codex", reasoningLevels: ["high"] });
    } finally {
      client.close();
    }
    return "/tmp/codex-auth.json";
  };
  refreshModelsModule.refreshSdkModels = async () => [{ sdk: "codex", modelCount: 1 }];

  try {
    await runCommandLoop(
      {
        state_db_path: stateDbPath,
        config_directory: tempDirectory,
        codex: {
          codex_auth_port: 1455,
          codex_auth_file_path: "codex-auth.json",
          codex_auth_path: "/home/agent/.codex/auth.json",
        },
      } as any,
      createSingleMessageCommandChannel(
        Object.assign(
          create(ServerMessageSchema, {
            request: {
              case: "codexConfigurationRequest",
              value: { authType: CodexAuthType.DEVICE_CODE },
            },
          }),
          { requestId: "req-device" },
        ),
      ) as any,
      {
        async send(message: any) {
          sentMessages.push(message);
        },
      },
      {} as any,
      undefined,
      { info() {}, warn() {}, debug() {} } as any,
    );
  } finally {
    authModule.runCodexDeviceCodeAuth = originalRunCodexDeviceCodeAuth;
    refreshModelsModule.refreshSdkModels = originalRefreshSdkModels;
    await rm(tempDirectory, { recursive: true, force: true });
  }

  assert.equal(sentMessages[0]?.payload?.case, "codexDeviceCode");
  assert.equal(sentMessages[0]?.payload?.value?.deviceCode, "R2OU-ZVJKU");
  assert.equal(sentMessages[1]?.payload?.case, "agentSdkUpdate");
  assert.equal(sentMessages[1]?.payload?.value?.status, 2);
  assert.deepEqual(
    sentMessages[1]?.payload?.value?.models?.map((model: any) => ({ name: model.name, reasoning: model.reasoning })),
    [{ name: "gpt-5.3-codex", reasoning: ["high"] }],
  );
});

test("runCommandLoop sends ready sdk update for Codex API key auth requests", async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-runner-root-api-key-"));
  const stateDbPath = path.join(tempDirectory, "state.db");
  const sentMessages: any[] = [];

  const originalRunCodexApiKeyAuth = authModule.runCodexApiKeyAuth;
  const originalRefreshSdkModels = refreshModelsModule.refreshSdkModels;

  authModule.runCodexApiKeyAuth = async (cfg: any, apiKey: string) => {
    assert.equal(apiKey, "sk-live-test");
    const { db, client } = await initDb(cfg.state_db_path);
    try {
      await db.insert(agentSdks).values({ name: "codex", authentication: "api-key", status: "configured" });
      await db.insert(llmModels).values({ name: "gpt-5.3-codex", sdkName: "codex", reasoningLevels: ["high"] });
    } finally {
      client.close();
    }
    return "/tmp/codex-auth.json";
  };
  refreshModelsModule.refreshSdkModels = async () => [{ sdk: "codex", modelCount: 1 }];

  try {
    await runCommandLoop(
      {
        state_db_path: stateDbPath,
        config_directory: tempDirectory,
        codex: {
          codex_auth_port: 1455,
          codex_auth_file_path: "codex-auth.json",
          codex_auth_path: "/home/agent/.codex/auth.json",
        },
      } as any,
      createSingleMessageCommandChannel(
        Object.assign(
          create(ServerMessageSchema, {
            request: {
              case: "codexConfigurationRequest",
              value: { authType: CodexAuthType.API_KEY, codexApiKey: "sk-live-test" },
            },
          }),
          { requestId: "req-api-key" },
        ),
      ) as any,
      {
        async send(message: any) {
          sentMessages.push(message);
        },
      },
      {} as any,
      undefined,
      { info() {}, warn() {}, debug() {} } as any,
    );
  } finally {
    authModule.runCodexApiKeyAuth = originalRunCodexApiKeyAuth;
    refreshModelsModule.refreshSdkModels = originalRefreshSdkModels;
    await rm(tempDirectory, { recursive: true, force: true });
  }

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.payload?.case, "agentSdkUpdate");
  assert.equal(sentMessages[0]?.payload?.value?.status, 2);
  assert.deepEqual(
    sentMessages[0]?.payload?.value?.models?.map((model: any) => ({ name: model.name, reasoning: model.reasoning })),
    [{ name: "gpt-5.3-codex", reasoning: ["high"] }],
  );
});

test("runCommandLoop skips model refresh and sends unconfigured sdk update when Codex auth does not configure the sdk", async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-runner-root-unconfigured-"));
  const stateDbPath = path.join(tempDirectory, "state.db");
  const sentMessages: any[] = [];
  let refreshCalls = 0;

  const originalRunCodexApiKeyAuth = authModule.runCodexApiKeyAuth;
  const originalRefreshSdkModels = refreshModelsModule.refreshSdkModels;

  authModule.runCodexApiKeyAuth = async (_cfg: any, apiKey: string) => {
    assert.equal(apiKey, "sk-live-test");
    return "/tmp/codex-auth.json";
  };
  refreshModelsModule.refreshSdkModels = async () => {
    refreshCalls += 1;
    return [{ sdk: "codex", modelCount: 1 }];
  };

  try {
    await runCommandLoop(
      {
        state_db_path: stateDbPath,
        config_directory: tempDirectory,
        codex: {
          codex_auth_port: 1455,
          codex_auth_file_path: "codex-auth.json",
          codex_auth_path: "/home/agent/.codex/auth.json",
        },
      } as any,
      createSingleMessageCommandChannel(
        Object.assign(
          create(ServerMessageSchema, {
            request: {
              case: "codexConfigurationRequest",
              value: { authType: CodexAuthType.API_KEY, codexApiKey: "sk-live-test" },
            },
          }),
          { requestId: "req-api-key-unconfigured" },
        ),
      ) as any,
      {
        async send(message: any) {
          sentMessages.push(message);
        },
      },
      {} as any,
      undefined,
      { info() {}, warn() {}, debug() {} } as any,
    );
  } finally {
    authModule.runCodexApiKeyAuth = originalRunCodexApiKeyAuth;
    refreshModelsModule.refreshSdkModels = originalRefreshSdkModels;
    await rm(tempDirectory, { recursive: true, force: true });
  }

  assert.equal(refreshCalls, 0);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.payload?.case, "agentSdkUpdate");
  assert.equal(sentMessages[0]?.payload?.value?.status, 1);
  assert.deepEqual(sentMessages[0]?.payload?.value?.models, []);
});
