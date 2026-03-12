import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { type Config } from "../../../config.js";
import { getHostInfo } from "../../../service/host.js";
import { initDb } from "../../../state/db.js";
import { agentSdks } from "../../../state/schema.js";
import { expandHome } from "../../../utils/path.js";

export type CodexAuthMode = "dedicated" | "host";
export type CodexAuthentication = "unauthenticated" | "host" | "dedicated" | "api-key";
export type CodexConfigurationStatus = "unconfigured" | "configured";

export type CodexAuthOption = {
  value: CodexAuthMode;
  label: string;
  hint?: string;
};

export type SetCodexHostAuthDependencies = {
  getHostInfoFn: typeof getHostInfo;
  initDbFn: typeof initDb;
};

export type EnsureCodexRunnerStartStateDependencies = SetCodexHostAuthDependencies & {
  logInfo: (message: string) => void;
  useDedicatedAuth?: boolean;
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

export const defaultEnsureCodexRunnerStartStateDependencies: EnsureCodexRunnerStartStateDependencies = {
  ...defaultSetCodexHostAuthDependencies,
  logInfo: () => undefined,
  useDedicatedAuth: false,
};

export const defaultUseDedicatedCodexAuthDependencies: UseDedicatedCodexAuthDependencies = {
  initDbFn: initDb,
  logInfo: console.log,
  logSuccess: console.log,
  spawnCommand: spawn,
  spawnSyncCommand: spawnSync,
};

type ContainerizedCodexLoginOptions = {
  containerName: string;
  dockerArgs: string[];
  onOutput?: (output: string) => void;
};

function resolveContainerPath(pathValue: string, containerHome: string): string {
  if (pathValue === "~") {
    return containerHome;
  }
  if (pathValue.startsWith("~/")) {
    return `${containerHome}${pathValue.slice(1)}`;
  }
  return pathValue;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildCodexLoginShellCommand(cfg: Config, loginCommand: string): string {
  const hostInfo = getHostInfo(cfg.codex.codex_auth_path);
  const containerAuthPath = resolveContainerPath(cfg.codex.codex_auth_path, cfg.agent_home_directory);

  return [
    `AGENT_USER=${shellQuote(cfg.agent_user)}`,
    `AGENT_HOME=${shellQuote(cfg.agent_home_directory)}`,
    `AGENT_UID=${shellQuote(String(hostInfo.uid))}`,
    `AGENT_GID=${shellQuote(String(hostInfo.gid))}`,
    `CODEX_AUTH_PATH=${shellQuote(containerAuthPath)}`,
    `CODEX_LOGIN_COMMAND=${shellQuote(`source "$NVM_DIR/nvm.sh"; ${loginCommand}`)}`,
    'EXISTING_UID_USER=""',
    'if getent passwd "$AGENT_UID" >/dev/null 2>&1; then',
    '  EXISTING_UID_USER="$(getent passwd "$AGENT_UID" | cut -d: -f1)"',
    '  AGENT_USER="$EXISTING_UID_USER"',
    'fi',
    'AGENT_GROUP="$AGENT_USER"',
    'if getent group "$AGENT_GID" >/dev/null 2>&1; then',
    '  AGENT_GROUP="$(getent group "$AGENT_GID" | cut -d: -f1)"',
    'elif getent group "$AGENT_USER" >/dev/null 2>&1; then',
    '  groupmod -g "$AGENT_GID" "$AGENT_USER"',
    '  AGENT_GROUP="$AGENT_USER"',
    'else',
    '  groupadd -g "$AGENT_GID" "$AGENT_USER"',
    '  AGENT_GROUP="$AGENT_USER"',
    'fi',
    'if id -u "$AGENT_USER" >/dev/null 2>&1; then',
    '  usermod -u "$AGENT_UID" -g "$AGENT_GROUP" -d "$AGENT_HOME" -s /bin/bash "$AGENT_USER" || true',
    'else',
    '  useradd -m -d "$AGENT_HOME" -u "$AGENT_UID" -g "$AGENT_GROUP" -s /bin/bash "$AGENT_USER"',
    'fi',
    'mkdir -p "$AGENT_HOME" "$(dirname "$CODEX_AUTH_PATH")"',
    'chown -R "$AGENT_UID:$AGENT_GID" "$AGENT_HOME" "$(dirname "$CODEX_AUTH_PATH")" || true',
    'export HOME="$AGENT_HOME"',
    'exec sudo -n -E -H -u "$AGENT_USER" bash -lc "$CODEX_LOGIN_COMMAND"',
  ].join("\n");
}

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

export function extractCodexDeviceCodeFromOutput(output: string): string | null {
  const normalizedOutput = output.replace(/\u001b\[[0-9;]*m/g, "");
  const match = normalizedOutput.match(/Enter this one-time code[\s\S]*?\n\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s*(?:\n|$)/i);
  return match?.[1]?.trim() ?? null;
}

async function runContainerizedCodexLogin(
  cfg: Config,
  deps: DedicatedCodexAuthDependencies,
  options: ContainerizedCodexLoginOptions,
): Promise<string> {
  ensureDockerAvailable(deps.spawnSyncCommand);
  const configDir = expandHome(cfg.config_directory);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const destPath = join(configDir, cfg.codex.codex_auth_file_path);
  const containerAuthPath = resolveContainerPath(cfg.codex.codex_auth_path, cfg.agent_home_directory);

  let authCopied = false;
  let combinedOutput = "";

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let poll: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (poll) {
        clearInterval(poll);
      }
      deps.spawnSyncCommand("docker", ["rm", "-f", options.containerName], { stdio: "ignore" });
    };

    const tryCopyAuthFile = (): boolean => {
      const check = deps.spawnSyncCommand("docker", ["exec", options.containerName, "sh", "-c", `test -f ${containerAuthPath}`], {
        stdio: "ignore",
      });
      if (check.status !== 0) {
        return false;
      }

      const cpResult = deps.spawnSyncCommand("docker", ["cp", `${options.containerName}:${containerAuthPath}`, destPath], {
        stdio: "ignore",
      });
      if (cpResult.status !== 0) {
        return false;
      }

      authCopied = true;
      cleanup();
      return true;
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const child = deps.spawnCommand("docker", options.dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      combinedOutput += text;
      options.onOutput?.(combinedOutput);
    };

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);

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
      if (tryCopyAuthFile()) {
        resolveOnce();
      }
    }, 1000);

    child.on("exit", () => {
      if (authCopied) {
        resolveOnce();
        return;
      }
      if (tryCopyAuthFile()) {
        resolveOnce();
        return;
      }
      rejectOnce(new Error(`Codex login failed or was cancelled.${combinedOutput.trim().length > 0 ? ` Output: ${combinedOutput.trim()}` : ""}`));
    });
  });

  return destPath;
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

async function upsertCodexSdkState(
  db: any,
  authentication: CodexAuthentication,
  status: CodexConfigurationStatus,
): Promise<void> {
  const existingSdk = await db.select().from(agentSdks).where(eq(agentSdks.name, "codex")).get();
  if (existingSdk) {
    await db
      .update(agentSdks)
      .set({ authentication, status })
      .where(eq(agentSdks.name, "codex"));
    return;
  }

  await db.insert(agentSdks).values({ name: "codex", authentication, status });
}

export async function setCodexHostAuthInDb(db: any): Promise<void> {
  await upsertCodexSdkState(db, "host", "configured");
}

export async function setCodexDedicatedAuthInDb(db: any): Promise<void> {
  await upsertCodexSdkState(db, "dedicated", "configured");
}

export async function setCodexApiKeyAuthInDb(db: any): Promise<void> {
  await upsertCodexSdkState(db, "api-key", "configured");
}

export async function setCodexUnconfiguredInDb(db: any): Promise<void> {
  await upsertCodexSdkState(db, "unauthenticated", "unconfigured");
}

export async function ensureCodexRunnerStartState(
  cfg: Config,
  overrides: Partial<EnsureCodexRunnerStartStateDependencies> = {},
): Promise<void> {
  const deps: EnsureCodexRunnerStartStateDependencies = {
    ...defaultEnsureCodexRunnerStartStateDependencies,
    ...overrides,
  };
  const { db, client } = await deps.initDbFn(cfg.state_db_path);

  try {
    const existingSdk = await db.select().from(agentSdks).where(eq(agentSdks.name, "codex")).get();
    if (deps.useDedicatedAuth) {
      if (existingSdk?.authentication === "dedicated" && existingSdk.status === "configured") {
        return;
      }
      await setCodexUnconfiguredInDb(db);
      return;
    }

    const hostInfo = deps.getHostInfoFn(cfg.codex.codex_auth_path);
    if (hostInfo.codexAuthExists) {
      deps.logInfo(`Detected Codex host auth at ${expandHome(cfg.codex.codex_auth_path)}; using host auth automatically.`);
      await setCodexHostAuthInDb(db);
      return;
    }

    await setCodexUnconfiguredInDb(db);
  } finally {
    client.close();
  }
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
  const containerName = `companyhelm-codex-auth-${Date.now()}`;
  const loginCommand = buildCodexLoginShellCommand(cfg, "codex login --device-auth");

  deps.logInfo("Starting Codex login inside a container...");
  deps.logInfo("A browser URL and device code will appear -- open it to complete authentication.");
  const destPath = await runContainerizedCodexLogin(cfg, deps, {
    containerName,
    dockerArgs: [
      "run",
      "--name",
      containerName,
      "--entrypoint",
      "bash",
      cfg.runtime_image,
      "-lc",
      loginCommand,
    ],
  });

  await setCodexDedicatedAuthInDb(db);
  deps.logSuccess(`Codex auth saved to ${destPath}`);
  return destPath;
}

export async function runCodexApiKeyAuth(
  cfg: Config,
  apiKey: string,
  overrides: Partial<UseDedicatedCodexAuthDependencies> = {},
): Promise<string> {
  const deps: UseDedicatedCodexAuthDependencies = { ...defaultUseDedicatedCodexAuthDependencies, ...overrides };
  const { db, client } = await deps.initDbFn(cfg.state_db_path);

  try {
    deps.logInfo("Starting Codex API key login inside a container...");
    const containerName = `companyhelm-codex-auth-${Date.now()}`;
    const loginCommand = buildCodexLoginShellCommand(cfg, 'printf \'%s\\n\' "$CODEX_API_KEY" | codex login --with-api-key');
    const destPath = await runContainerizedCodexLogin(cfg, deps, {
      containerName,
      dockerArgs: [
        "run",
        "--name",
        containerName,
        "-e",
        `CODEX_API_KEY=${apiKey}`,
        "--entrypoint",
        "bash",
        cfg.runtime_image,
        "-lc",
        loginCommand,
      ],
    });
    await setCodexApiKeyAuthInDb(db);
    deps.logSuccess(`Codex auth saved to ${destPath}`);
    return destPath;
  } finally {
    client.close();
  }
}

export async function runCodexDeviceCodeAuth(
  cfg: Config,
  onDeviceCode: (deviceCode: string) => Promise<void> | void,
  overrides: Partial<UseDedicatedCodexAuthDependencies> = {},
): Promise<string> {
  const deps: UseDedicatedCodexAuthDependencies = { ...defaultUseDedicatedCodexAuthDependencies, ...overrides };
  const { db, client } = await deps.initDbFn(cfg.state_db_path);

  try {
    let emittedDeviceCode: string | null = null;
    let onDeviceCodePromise: Promise<void> = Promise.resolve();
    deps.logInfo("Starting Codex device login inside a container...");
    const containerName = `companyhelm-codex-auth-${Date.now()}`;
    const loginCommand = buildCodexLoginShellCommand(cfg, "codex login --device-auth");
    const destPath = await runContainerizedCodexLogin(cfg, deps, {
      containerName,
      dockerArgs: [
        "run",
        "--name",
        containerName,
        "--entrypoint",
        "bash",
        cfg.runtime_image,
        "-lc",
        loginCommand,
      ],
      onOutput: (output) => {
        const deviceCode = extractCodexDeviceCodeFromOutput(output);
        if (!deviceCode || emittedDeviceCode === deviceCode) {
          return;
        }
        emittedDeviceCode = deviceCode;
        onDeviceCodePromise = Promise.resolve(onDeviceCode(deviceCode));
      },
    });
    await onDeviceCodePromise;
    await setCodexDedicatedAuthInDb(db);
    deps.logSuccess(`Codex auth saved to ${destPath}`);
    return destPath;
  } finally {
    client.close();
  }
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
