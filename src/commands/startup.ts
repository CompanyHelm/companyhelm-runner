import { spawn, spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import figlet from "figlet";
import { config as configSchema, type Config } from "../config.js";
import { getHostInfo } from "../service/host.js";
import { initDb } from "../state/db.js";
import { agentSdks } from "../state/schema.js";
import { refreshSdkModels } from "../service/sdk/refresh_models.js";
import { restoreInteractiveTerminalState } from "../utils/terminal.js";
import {
  defaultSetCodexHostAuthDependencies,
  ensureDockerAvailable,
  listCodexStartupAuthOptions,
  runDedicatedCodexAuth,
  setCodexHostAuthInDb,
} from "./sdk/codex/auth.js";

function banner() {
  console.log();
  console.log(figlet.textSync("CompanyHelm", { font: "Small" }));
  console.log();
}

type StartupDependencies = {
  getHostInfoFn: typeof getHostInfo;
  initDbFn: typeof initDb;
  promptApi: typeof p;
  refreshSdkModelsFn: typeof refreshSdkModels;
  spawnCommand: typeof spawn;
  spawnSyncCommand: typeof spawnSync;
};

const defaultStartupDependencies: StartupDependencies = {
  getHostInfoFn: defaultSetCodexHostAuthDependencies.getHostInfoFn,
  initDbFn: initDb,
  promptApi: p,
  refreshSdkModelsFn: refreshSdkModels,
  spawnCommand: spawn,
  spawnSyncCommand: spawnSync,
};

function exitStartup(code: number): never {
  restoreInteractiveTerminalState();
  process.exit(code);
}

async function refreshCodexModelsInStartup(deps: StartupDependencies): Promise<void> {
  ensureDockerAvailable(deps.spawnSyncCommand);
  const spinner = deps.promptApi.spinner();
  const seenStatusMessages = new Set<string>();
  spinner.start("Preparing Codex runtime image and refreshing model catalog via app-server");
  const results = await deps.refreshSdkModelsFn({
    sdk: "codex",
    imageStatusReporter: (message) => {
      if (seenStatusMessages.has(message)) {
        return;
      }
      seenStatusMessages.add(message);
      deps.promptApi.log.info(message);
    },
  });
  const count = results[0]?.modelCount ?? 0;
  spinner.stop(`Codex model catalog refreshed (${count} models).`);
}

async function selectStartupAuthMode(
  options: Array<{ value: "dedicated" | "host"; label: string; hint?: string }>,
  deps: StartupDependencies,
): Promise<"dedicated" | "host"> {
  if (options.length === 1) {
    return options[0].value;
  }

  const authMode = await deps.promptApi.select({
    message: "How would you like to authenticate Codex?",
    options,
  });

  if (deps.promptApi.isCancel(authMode)) {
    deps.promptApi.cancel("Setup cancelled.");
    exitStartup(0);
  }

  return authMode;
}

export async function startup(cfg: Config = configSchema.parse({}), overrides: Partial<StartupDependencies> = {}) {
  const deps: StartupDependencies = { ...defaultStartupDependencies, ...overrides };
  banner();

  const s = deps.promptApi.spinner();
  s.start("Initializing state database");
  const { db } = await deps.initDbFn(cfg.state_db_path);
  s.stop("State database ready.");

  const sdks = await db.select().from(agentSdks).all();
  if (sdks.length > 0) {
    deps.promptApi.log.success(`Agent SDK configured: ${sdks.map((sdk) => sdk.name).join(", ")}`);
    return;
  }

  deps.promptApi.intro("No agent SDK configured. Let's set up Codex authentication.");

  const options = listCodexStartupAuthOptions(cfg, deps.getHostInfoFn);

  try {
    const authMode = await selectStartupAuthMode(options, deps);

    if (authMode === "host") {
      await setCodexHostAuthInDb(db);
      await refreshCodexModelsInStartup(deps);
      deps.promptApi.outro("Codex SDK configured with host authentication.");
      return;
    }

    await runDedicatedCodexAuth(cfg, db, {
      logInfo: deps.promptApi.log.info,
      logSuccess: deps.promptApi.log.success,
      spawnCommand: deps.spawnCommand,
      spawnSyncCommand: deps.spawnSyncCommand,
    });
    await refreshCodexModelsInStartup(deps);
    deps.promptApi.outro("Codex login successful!");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Codex setup failed.";
    deps.promptApi.cancel(message);
    exitStartup(1);
  } finally {
    restoreInteractiveTerminalState();
  }
}
