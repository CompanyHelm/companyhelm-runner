import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

const require = createRequire(import.meta.url);
const { config } = require("../../dist/config.js");
const { runCodexDeviceCodeAuth } = require("../../dist/commands/sdk/codex/auth.js");
const { initDb } = require("../../dist/state/db.js");
const { agentSdks } = require("../../dist/state/schema.js");

const MANUAL_TEST_FLAG = "COMPANYHELM_RUN_MANUAL_DEVICE_AUTH_TEST";
const DEFAULT_DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const MANUAL_TEST_TIMEOUT_MS = 15 * 60_000;
const isCiOrPrEnvironment = Boolean(
  process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.BUILDKITE ||
    process.env.GITHUB_EVENT_NAME === "pull_request" ||
    (process.env.BUILDKITE_PULL_REQUEST && process.env.BUILDKITE_PULL_REQUEST !== "false"),
);
const runManualDeviceAuthTest = process.env[MANUAL_TEST_FLAG] === "1" && !isCiOrPrEnvironment;

const manualDeviceAuthTest = runManualDeviceAuthTest ? test : test.skip;

manualDeviceAuthTest(
  "manual system: Codex device auth completes in the real runtime container",
  async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-manual-device-auth-"));
    const configDirectory = path.join(homeDirectory, ".config", "companyhelm");

    await mkdir(configDirectory, { recursive: true });

    try {
      const cfg = config.parse({ config_directory: configDirectory });
      const observedDeviceCodes: string[] = [];

      const authDestinationPath = await runCodexDeviceCodeAuth(
        cfg,
        async (deviceCode: string) => {
          observedDeviceCodes.push(deviceCode);
          process.stdout.write(
            [
              "",
              "Manual Codex device auth test",
              `Open: ${DEFAULT_DEVICE_AUTH_URL}`,
              `Code: ${deviceCode}`,
              "Waiting for authentication to complete in the browser...",
              "",
            ].join("\n"),
          );
        },
        {
          logInfo: (message: string) => {
            process.stdout.write(`[device-auth-test] ${message}\n`);
          },
          logSuccess: (message: string) => {
            process.stdout.write(`[device-auth-test] ${message}\n`);
          },
        },
      );

      assert.equal(observedDeviceCodes.length > 0, true, "expected the real login flow to emit a device code");

      const authFileContents = await readFile(authDestinationPath, "utf8");
      assert.equal(authFileContents.trim().length > 0, true, "expected Codex auth.json to be copied back to the host");

      const { db, client } = await initDb(cfg.state_db_path);
      try {
        const codexSdk = await db.select().from(agentSdks).where(eq(agentSdks.name, "codex")).get();
        assert.deepEqual(codexSdk, {
          name: "codex",
          authentication: "dedicated",
          status: "configured",
        });
      } finally {
        client.close();
      }
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  },
  MANUAL_TEST_TIMEOUT_MS,
);
