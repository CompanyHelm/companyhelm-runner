import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { type Config } from "../../../config.js";
import { getHostInfo } from "../../../service/host.js";
import { initDb } from "../../../state/db.js";
import { agentSdks } from "../../../state/schema.js";
import { expandHome } from "../../../utils/path.js";

export type CodexAuthMode = "dedicated" | "host";

export type CodexAuthOption = {
  value: CodexAuthMode;
  label: string;
  hint?: string;
};

export type SetCodexHostAuthDependencies = {
  getHostInfoFn: typeof getHostInfo;
  initDbFn: typeof initDb;
};

export type DedicatedCodexAuthDependencies = {
  logInfo: (message: string) => void;
  logSuccess: (message: string) => void;
  spawnCommand: typeof spawn;
  spawnSyncCommand: typeof spawnSync;
};

export type UseDedicatedCodexAuthDependencies = DedicatedCodexAuthDependencies & {
  initDbFn: typeof initDb;
};

export const defaultSetCodexHostAuthDependencies: SetCodexHostAuthDependencies = {
  getHostInfoFn: getHostInfo,
  initDbFn: initDb,
};

export const defaultUseDedicatedCodexAuthDependencies: UseDedicatedCodexAuthDependencies = {
  initDbFn: initDb,
  logInfo: console.log,
  logSuccess: console.log,
  spawnCommand: spawn,
  spawnSyncCommand: spawnSync,
};

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function buildDockerMissingError(): Error {
  return new Error("Docker is not installed or not available on PATH. Install Docker and retry.");
}

export function ensureDockerAvailable(spawnSyncCommand: typeof spawnSync): void {
  const result = spawnSyncCommand("docker", ["--version"], { stdio: "ignore" });
  if (isErrnoException(result.error) && result.error.code === "ENOENT") {
    throw buildDockerMissingError();
  }
}

export function listCodexStartupAuthOptions(
  cfg: Config,
  getHostInfoFn: typeof getHostInfo = getHostInfo,
): CodexAuthOption[] {
  const options: CodexAuthOption[] = [
    {
      value: "dedicated",
      label: "Dedicated",
      hint: "recommended -- runs Codex login inside a container",
    },
  ];

  const hostInfo = getHostInfoFn(cfg.codex.codex_auth_path);
  if (hostInfo.codexAuthExists) {
    options.push({
      value: "host",
      label: "Host",
      hint: `reuse existing credentials from ${cfg.codex.codex_auth_path}`,
    });
  }

  return options;
}

export async function setCodexHostAuthInDb(db: any): Promise<void> {
  const existingSdk = await db.select().from(agentSdks).where(eq(agentSdks.name, "codex")).get();
  if (existingSdk) {
    await db
      .update(agentSdks)
      .set({ authentication: "host" })
      .where(eq(agentSdks.name, "codex"));
    return;
  }

  await db.insert(agentSdks).values({ name: "codex", authentication: "host" });
}

export async function setCodexDedicatedAuthInDb(db: any): Promise<void> {
  const existingSdk = await db.select().from(agentSdks).where(eq(agentSdks.name, "codex")).get();
  if (existingSdk) {
    await db
      .update(agentSdks)
      .set({ authentication: "dedicated" })
      .where(eq(agentSdks.name, "codex"));
    return;
  }

  await db.insert(agentSdks).values({ name: "codex", authentication: "dedicated" });
}

export async function runSetCodexHostAuth(
  cfg: Config,
  overrides: Partial<SetCodexHostAuthDependencies> = {},
): Promise<string> {
  const deps: SetCodexHostAuthDependencies = { ...defaultSetCodexHostAuthDependencies, ...overrides };
  const authPath = expandHome(cfg.codex.codex_auth_path);
  const hostInfo = deps.getHostInfoFn(cfg.codex.codex_auth_path);

  if (!hostInfo.codexAuthExists) {
    throw new Error(`Codex host auth file not found at ${authPath}.`);
  }

  const { db, client } = await deps.initDbFn(cfg.state_db_path);
  try {
    await setCodexHostAuthInDb(db);
  } finally {
    client.close();
  }

  return authPath;
}

export async function runDedicatedCodexAuth(
  cfg: Config,
  db: any,
  deps: DedicatedCodexAuthDependencies,
): Promise<string> {
  ensureDockerAvailable(deps.spawnSyncCommand);
  const port = cfg.codex.codex_auth_port;
  const socatPort = port + 1;
  const containerName = `companyhelm-codex-auth-${Date.now()}`;

  deps.logInfo("Starting Codex login inside a container...");
  deps.logInfo("A browser URL will appear -- open it to complete authentication.");

  const configDir = expandHome(cfg.config_directory);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const destPath = join(configDir, cfg.codex.codex_auth_file_path);

  let authCopied = false;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let poll: NodeJS.Timeout | undefined;

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (poll) {
        clearInterval(poll);
      }
      deps.spawnSyncCommand("docker", ["rm", "-f", containerName], { stdio: "ignore" });
      reject(error);
    };

    const resolveOnce = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (poll) {
        clearInterval(poll);
      }
      resolve();
    };

    const child = deps.spawnCommand(
      "docker",
      [
        "run",
        "-it",
        "--name",
        containerName,
        "-p",
        `${port}:${socatPort}`,
        "--entrypoint",
        "bash",
        cfg.runtime_image,
        "-c",
        `source "$NVM_DIR/nvm.sh"; socat TCP-LISTEN:${socatPort},fork,bind=0.0.0.0,reuseaddr TCP:127.0.0.1:${port} 2>/dev/null & codex`,
      ],
      { stdio: "inherit" },
    );

    child.on("error", (error) => {
      if (isErrnoException(error) && error.code === "ENOENT") {
        rejectOnce(buildDockerMissingError());
        return;
      }

      rejectOnce(new Error(`Failed to start Codex login container: ${error.message}`));
    });

    poll = setInterval(() => {
      if (settled) {
        return;
      }
      const check = deps.spawnSyncCommand("docker", ["exec", containerName, "sh", "-c", `test -f ${cfg.codex.codex_auth_path}`], {
        stdio: "ignore",
      });

      if (check.status === 0) {
        const resolveResult = deps.spawnSyncCommand(
          "docker",
          ["exec", containerName, "sh", "-c", `echo ${cfg.codex.codex_auth_path}`],
          {
            encoding: "utf-8",
          },
        );
        const containerAuthAbsPath = resolveResult.stdout.trim();

        const cpResult = deps.spawnSyncCommand("docker", ["cp", `${containerName}:${containerAuthAbsPath}`, destPath], {
          stdio: "ignore",
        });

        if (cpResult.status !== 0) {
          rejectOnce(new Error("Failed to extract auth file from container."));
          return;
        }

        authCopied = true;
        deps.spawnSyncCommand("docker", ["rm", "-f", containerName], { stdio: "ignore" });
        resolveOnce();
      }
    }, 1000);

    child.on("exit", () => {
      if (!authCopied) {
        rejectOnce(new Error("Codex login failed or was cancelled."));
      }
    });
  });

  await setCodexDedicatedAuthInDb(db);
  deps.logSuccess(`Codex auth saved to ${destPath}`);
  return destPath;
}

export async function runUseDedicatedCodexAuth(
  cfg: Config,
  overrides: Partial<UseDedicatedCodexAuthDependencies> = {},
): Promise<string> {
  const deps: UseDedicatedCodexAuthDependencies = { ...defaultUseDedicatedCodexAuthDependencies, ...overrides };
  const { db, client } = await deps.initDbFn(cfg.state_db_path);

  try {
    return await runDedicatedCodexAuth(cfg, db, deps);
  } finally {
    client.close();
  }
}
