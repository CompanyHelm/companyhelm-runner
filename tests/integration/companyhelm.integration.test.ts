import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { create } from "@bufbuild/protobuf";
import * as grpc from "@grpc/grpc-js";
import { createClient } from "@libsql/client";
import { vi } from "vitest";
import Dockerode from "dockerode";
import { eq } from "drizzle-orm";

const require = createRequire(import.meta.url);
const {
  ClientMessageSchema,
  GithubInstallationAccessTokenResponseSchema: GetGithubInstallationAccessTokenForRunnerResponseSchema,
  GithubInstallationSchema: GithubInstallationForRunnerSchema,
  ItemStatus,
  ItemType,
  ListGithubInstallationsResponseSchema: ListGithubInstallationsForRunnerResponseSchema,
  RegisterRunnerRequestSchema,
  RegisterRunnerResponseSchema,
  ServerMessageSchema,
  ThreadMcpAuthType,
  ThreadStatus,
  TurnStatus,
} = require("@companyhelm/protos");
const { runRootCommand } = require("../../dist/commands/root.js");
const {
  CompanyhelmApiClient,
  createAgentRunnerControlServiceDefinition,
} = require("../../dist/service/companyhelm_api_client.js");
const { config } = require("../../dist/config.js");
const { AppServerService } = require("../../dist/service/app_server.js");
const threadLifecycle = require("../../dist/service/thread_lifecycle.js");
const { initDb } = require("../../dist/state/db.js");
const { agentSdks, daemonState, llmModels, threadUserMessageRequestStore, threads } = require("../../dist/state/schema.js");
const { isProcessRunning } = require("../../dist/utils/process.js");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_HOME_ROOT = process.env.COMPANYHELM_TEST_HOME_ROOT
  ? path.resolve(process.env.COMPANYHELM_TEST_HOME_ROOT)
  : tmpdir();
const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");
const DRIZZLE_DIRECTORY = path.join(REPOSITORY_ROOT, "drizzle");
const DRIZZLE_JOURNAL_PATH = path.join(DRIZZLE_DIRECTORY, "meta", "_journal.json");

async function makeTemporaryHomeDirectory(prefix: string, homeRoot: string = TEST_HOME_ROOT): Promise<string> {
  const tempRoot = path.join(homeRoot, ".tmp-companyhelm-tests");
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(path.join(tempRoot, prefix));
}

function resolveDefaultConfigDirectory(homeDirectory: string): string {
  return path.join(homeDirectory, ".config", "companyhelm");
}

function resolveDefaultStateDbPath(homeDirectory: string): string {
  return path.join(resolveDefaultConfigDirectory(homeDirectory), "state.db");
}

async function executeSqlStatements(client: ReturnType<typeof createClient>, sql: string): Promise<void> {
  for (const statement of sql.split("--> statement-breakpoint").map((segment) => segment.trim()).filter(Boolean)) {
    await client.execute(statement);
  }
}

async function seedLegacyMigratedDatabase(
  stateDbPath: string,
  appliedTags: string[],
  seedRows: (client: ReturnType<typeof createClient>) => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(stateDbPath), { recursive: true });
  const journal = JSON.parse(await readFile(DRIZZLE_JOURNAL_PATH, "utf8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const client = createClient({ url: `file:${stateDbPath}` });

  try {
    for (const tag of appliedTags) {
      const migrationSql = await readFile(path.join(DRIZZLE_DIRECTORY, `${tag}.sql`), "utf8");
      await executeSqlStatements(client, migrationSql);
    }

    await client.execute(
      'CREATE TABLE "__drizzle_migrations" (\n\t\t\tid SERIAL PRIMARY KEY,\n\t\t\thash text NOT NULL,\n\t\t\tcreated_at numeric\n\t\t)',
    );

    for (const tag of appliedTags) {
      const journalEntry = journal.entries.find((entry) => entry.tag === tag);
      assert.ok(journalEntry, `missing drizzle journal entry for migration '${tag}'`);
      const migrationSql = await readFile(path.join(DRIZZLE_DIRECTORY, `${tag}.sql`), "utf8");
      const hash = createHash("sha256").update(migrationSql).digest("hex");
      await client.execute(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('${hash}', ${journalEntry.when})`,
      );
    }

    await seedRows(client);
  } finally {
    client.close();
  }
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 15_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitFor<T>(predicate: () => Promise<T | null>, timeoutMs = 15_000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

function startFakeServer(
  pathPrefix: string,
  implementation: grpc.UntypedServiceImplementation,
  bindAddress = "127.0.0.1:0",
): Promise<{ server: grpc.Server; port: number }> {
  const server = new grpc.Server();
  server.addService(createAgentRunnerControlServiceDefinition(pathPrefix), implementation);

  return new Promise((resolve, reject) => {
    server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      server.start();
      resolve({ server, port });
    });
  });
}

function shutdownServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => {
    server.tryShutdown(() => {
      resolve();
    });
  });
}

function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const candidate = net.createServer();
    candidate.on("error", reject);
    candidate.listen(0, "127.0.0.1", () => {
      const address = candidate.address();
      if (!address || typeof address === "string") {
        candidate.close(() => reject(new Error("failed to reserve local port")));
        return;
      }

      const { port } = address;
      candidate.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

interface SeedStateDatabaseOptions {
  modelName?: string;
  reasoningLevels?: string[];
}

interface SeedExistingThreadOptions {
  threadId: string;
  sdkThreadId?: string | null;
  currentSdkTurnId?: string | null;
  isCurrentTurnRunning?: boolean;
  status?: "pending" | "ready" | "deleting";
  runtimeContainer?: string;
  dindContainer?: string | null;
  workspace?: string;
  homeDirectory?: string;
  uid?: number;
  gid?: number;
}

async function seedStateDatabase(homeDirectory: string, options?: SeedStateDatabaseOptions): Promise<void> {
  const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
  const { db, client } = await initDb(stateDbPath);

  try {
    await db.insert(agentSdks).values({
      name: "codex",
      authentication: "host",
      status: "configured",
    });

    await db.insert(llmModels).values({
      name: options?.modelName ?? "gpt-5.3-codex",
      sdkName: "codex",
      reasoningLevels: options?.reasoningLevels ?? ["high"],
    });
  } finally {
    client.close();
  }
}

async function seedExistingThread(homeDirectory: string, options: SeedExistingThreadOptions): Promise<void> {
  const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
  const workspace = options.workspace
    ?? path.join(resolveDefaultConfigDirectory(homeDirectory), "workspaces", `thread-${options.threadId}`);
  await mkdir(workspace, { recursive: true });

  const { db, client } = await initDb(stateDbPath);
  try {
    await db.insert(threads).values({
      id: options.threadId,
      sdkThreadId: options.sdkThreadId ?? null,
      cliSecret: null,
      model: "gpt-5.3-codex",
      reasoningLevel: "high",
      additionalModelInstructions: null,
      status: options.status ?? "ready",
      currentSdkTurnId: options.currentSdkTurnId ?? null,
      isCurrentTurnRunning: options.isCurrentTurnRunning ?? false,
      workspace,
      runtimeContainer: options.runtimeContainer ?? `companyhelm-runtime-thread-${options.threadId}`,
      dindContainer: options.dindContainer ?? `companyhelm-dind-thread-${options.threadId}`,
      homeDirectory: options.homeDirectory ?? "/home/agent",
      uid: options.uid ?? process.getuid(),
      gid: options.gid ?? process.getgid(),
    });
  } finally {
    client.close();
  }
}

async function seedStateDatabaseWithoutModels(
  homeDirectory: string,
  authentication: "host" | "dedicated" = "host",
): Promise<void> {
  const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
  const { db, client } = await initDb(stateDbPath);

  try {
    await db.insert(agentSdks).values({
      name: "codex",
      authentication,
      status: "configured",
    });
  } finally {
    client.close();
  }
}

async function writeHostAuthFile(homeDirectory: string): Promise<void> {
  const authDirectory = path.join(homeDirectory, ".codex");
  await mkdir(authDirectory, { recursive: true });
  await writeFile(path.join(authDirectory, "auth.json"), "{}", "utf8");
}

function isDockerNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const statusCode = "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined;
  if (statusCode === 404) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /No such container/i.test(message);
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    const docker = new Dockerode();
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

async function containerExists(docker: Dockerode, name: string): Promise<boolean> {
  try {
    await docker.getContainer(name).inspect();
    return true;
  } catch (error: unknown) {
    if (isDockerNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function volumeExists(docker: Dockerode, name: string): Promise<boolean> {
  try {
    await docker.getVolume(name).inspect();
    return true;
  } catch (error: unknown) {
    if (isDockerNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function forceRemoveContainerIfExists(docker: Dockerode, name: string): Promise<void> {
  try {
    await docker.getContainer(name).remove({ force: true });
  } catch (error: unknown) {
    if (isDockerNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

async function forceRemoveVolumeIfExists(docker: Dockerode, name: string): Promise<void> {
  try {
    await docker.getVolume(name).remove();
  } catch (error: unknown) {
    if (isDockerNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

async function supportsRealThreadContainerLifecycle(): Promise<boolean> {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const threadId = `preflight-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const names = threadLifecycle.buildThreadContainerNames(threadId);
  const containerService = new threadLifecycle.ThreadContainerService();
  const runtimeImage = config.parse({}).runtime_image;

  try {
    await containerService.createThreadContainers({
      dindImage: "docker:29-dind-rootless",
      runtimeImage,
      names,
      mounts: [],
      user: {
        uid,
        gid,
        agentUser: "agent",
        agentHomeDirectory: "/home/agent",
      },
    });
    return true;
  } catch {
    return false;
  } finally {
    await containerService.forceRemoveContainer(names.runtime).catch(() => undefined);
    await containerService.forceRemoveContainer(names.dind).catch(() => undefined);
  }
}

function resolveSupportedHostDockerPath(): string | null {
  const dockerHost = process.env.DOCKER_HOST?.trim();
  if (dockerHost && (dockerHost.startsWith("unix:///") || /^tcp:\/\/localhost:\d+$/.test(dockerHost))) {
    return dockerHost;
  }

  if (existsSync("/var/run/docker.sock")) {
    return "unix:///var/run/docker.sock";
  }

  const runtimeDirectory = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDirectory) {
    const socketPath = path.join(runtimeDirectory, "docker.sock");
    if (existsSync(socketPath)) {
      return `unix://${socketPath}`;
    }
  }

  return null;
}

test("ThreadContainerService renames existing runtime uid identity to agent without moving the old home", async () => {
  if (!(await isDockerAvailable())) {
    return;
  }

  const hostDockerPath = resolveSupportedHostDockerPath();
  if (!hostDockerPath) {
    return;
  }

  const threadId = `identity-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const names = threadLifecycle.buildThreadContainerNames(threadId);
  const containerService = new threadLifecycle.ThreadContainerService();
  const runtimeImage = config.parse({}).runtime_image;
  const runtimeUser = {
    uid: 1000,
    gid: 1000,
    agentUser: "agent",
    agentHomeDirectory: "/home/agent",
  };

  try {
    await containerService.createThreadContainers({
      dindImage: "docker:29-dind-rootless",
      runtimeImage,
      names,
      mounts: [],
      user: runtimeUser,
      useHostDockerRuntime: true,
      hostDockerPath,
    });
    await containerService.ensureContainerRunning(names.runtime);
    await containerService.ensureRuntimeContainerIdentity(names.runtime, runtimeUser);
    await containerService.ensureRuntimeContainerIdentity(names.runtime, runtimeUser);

    const rootCheck = spawnSync(
      "docker",
      [
        "exec",
        "-u",
        "0",
        names.runtime,
        "bash",
        "-lc",
        [
          'set -euo pipefail',
          'test "$(getent passwd 1000 | cut -d: -f1)" = "agent"',
          'test "$(getent passwd agent | cut -d: -f6)" = "/home/agent"',
          'test "$(getent group 1000 | cut -d: -f1)" = "agent"',
          'test -d /home/agent',
        ].join("; "),
      ],
      { encoding: "utf8" },
    );
    assert.equal(rootCheck.status, 0, rootCheck.stderr || rootCheck.stdout);

    const agentCheck = spawnSync(
      "docker",
      ["exec", "-u", "agent", names.runtime, "bash", "-lc", 'test "$(id -un)" = "agent"; test "$HOME" = "/home/agent"'],
      { encoding: "utf8" },
    );
    assert.equal(agentCheck.status, 0, agentCheck.stderr || agentCheck.stdout);
  } finally {
    await containerService.forceRemoveContainer(names.runtime).catch(() => undefined);
  }
});

test("CompanyhelmApiClient registers first and streams messages both directions", async () => {
  let registerRequest: any = null;
  let channelOpenedBeforeRegister = false;
  let receivedClientMessage: any = null;

  let resolveClientMessage: (() => void) | null = null;
  const receivedClientMessagePromise = new Promise<void>((resolve) => {
    resolveClientMessage = resolve;
  });

  let server: grpc.Server | undefined;
  let client: CompanyhelmApiClient | undefined;

  try {
    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        registerRequest = call.request;
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        if (!registerRequest) {
          channelOpenedBeforeRegister = true;
        }

        call.write(
          create(ServerMessageSchema, {
            request: {
              case: "createThreadRequest",
              value: {
                threadId: "thread-1",
                model: "gpt-5.3-codex",
              },
            },
          }),
        );

        call.on("data", (message) => {
          receivedClientMessage = message;
          resolveClientMessage?.();
          call.end();
        });
      },
    });

    server = started.server;
    client = new CompanyhelmApiClient({ apiUrl: `127.0.0.1:${started.port}/grpc` });

    const channel = await client.connect(
      create(RegisterRunnerRequestSchema, {
        agentSdks: [
          {
            name: "codex",
            models: [{ name: "gpt-5.3-codex", reasoning: ["high"] }],
          },
        ],
      }),
    );

    const firstServerMessage = await channel.nextMessage();
    assert.equal(firstServerMessage?.request.case, "createThreadRequest");
    assert.equal(firstServerMessage?.request.value.threadId, "thread-1");

    await channel.send(
      create(ClientMessageSchema, {
        payload: {
          case: "requestError",
          value: {
            errorMessage: "ack",
          },
        },
      }),
    );

    await receivedClientMessagePromise;
    channel.closeWrite();

    assert.equal(channelOpenedBeforeRegister, false);
    assert.equal(registerRequest?.agentSdks?.[0]?.name, "codex");
    assert.equal(receivedClientMessage?.payload?.case, "requestError");
    assert.equal(receivedClientMessage?.payload?.value?.errorMessage, "ack");
  } finally {
    client?.close();
    if (server) {
      await shutdownServer(server);
    }
  }
});

test("CompanyhelmApiClient rejects when controlChannel closes before metadata or a first message", async () => {
  let server: grpc.Server | undefined;
  let client: CompanyhelmApiClient | undefined;

  try {
    const started = await startFakeServer("/grpc", {
      registerRunner(_call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        call.end();
      },
    });

    server = started.server;
    client = new CompanyhelmApiClient({ apiUrl: `127.0.0.1:${started.port}/grpc` });

    const channel = await client.connect(
      create(RegisterRunnerRequestSchema, {
        agentSdks: [
          {
            name: "codex",
            models: [{ name: "gpt-5.3-codex", reasoning: ["high"] }],
          },
        ],
      }),
    );

    await assert.rejects(channel.waitForOpen(1_000), /closed before becoming usable/);
  } finally {
    client?.close();
    if (server) {
      await shutdownServer(server);
    }
  }
});

test("companyhelm root command forwards --secret as authorization metadata", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-secret-header-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after secret header validation");
  const nativeSetTimeout = global.setTimeout;
  let shouldStopAfterValidation = false;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  const secret = "7Rj8DjutkQTB_1SmyNpuizXh6SdyApPvBligVouPuRs";
  let registerAuthorizationHeaders: string[] = [];
  let controlChannelAuthorizationHeaders: string[] = [];

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        registerAuthorizationHeaders = call.metadata.get("authorization").map((value) => String(value));
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        controlChannelAuthorizationHeaders = call.metadata.get("authorization").map((value) => String(value));
        shouldStopAfterValidation = true;
        call.sendMetadata(new grpc.Metadata());
        call.end();
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        daemon: true,
        secret,
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after validating authorization headers",
    );

    assert.deepEqual(registerAuthorizationHeaders, [`Bearer ${secret}`]);
    assert.deepEqual(controlChannelAuthorizationHeaders, [`Bearer ${secret}`]);
  } finally {
    reconnectDelaySpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command registers codex as unconfigured when no auth is configured", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-register-unconfigured-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after unconfigured registration validation");
  let shouldStopAfterValidation = false;
  const nativeSetTimeout = global.setTimeout;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  try {
    process.env.HOME = homeDirectory;

    let registerRequest: any = null;
    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        registerRequest = call.request;
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        shouldStopAfterValidation = true;
        call.sendMetadata(new grpc.Metadata());
        call.end();
      },
    });
    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after unconfigured registration validation",
    );

    assert.equal(registerRequest?.agentSdks?.[0]?.name, "codex");
    assert.equal(registerRequest?.agentSdks?.[0]?.status, 1);
    assert.deepEqual(registerRequest?.agentSdks?.[0]?.models ?? [], []);
  } finally {
    reconnectDelaySpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command registers codex as error when configured model refresh fails", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-register-error-status-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after error registration validation");
  let shouldStopAfterValidation = false;
  const nativeSetTimeout = global.setTimeout;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabaseWithoutModels(homeDirectory, "dedicated");

    let registerRequest: any = null;
    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        registerRequest = call.request;
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        shouldStopAfterValidation = true;
        call.sendMetadata(new grpc.Metadata());
        call.end();
      },
    });
    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
        useDedicatedAuth: true,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after error registration validation",
    );

    assert.equal(registerRequest?.agentSdks?.[0]?.name, "codex");
    assert.equal(registerRequest?.agentSdks?.[0]?.status, 3);
    assert.match(String(registerRequest?.agentSdks?.[0]?.errorMessage ?? ""), /Failed to refresh codex models/i);
  } finally {
    reconnectDelaySpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm daemon mode detaches and prevents a second daemon from claiming the same state db", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-daemon-detach-");
  const previousHome = process.env.HOME;
  let server: grpc.Server | null = null;
  const controlCalls: Array<grpc.ServerWritableStream<any, any>> = [];
  let daemonPid: number | null = null;

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);

    const started = await startFakeServer("/grpc", {
      registerRunner(_call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        controlCalls.push(call);
        call.sendMetadata(new grpc.Metadata());
      },
    });
    server = started.server;

    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const daemonArgs = [cliEntryPoint, "runner", "start", "-d", "--server-url", `127.0.0.1:${started.port}/grpc`];
    const stateDbPath = resolveDefaultStateDbPath(homeDirectory);

    const startResult = await waitForExit(
      spawn(process.execPath, daemonArgs, {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.equal(startResult.code, 0, `daemon launcher failed. stdout:\n${startResult.stdout}\nstderr:\n${startResult.stderr}`);

    const row = await waitFor(async () => {
      const { db, client } = await initDb(stateDbPath);
      try {
        const result = await db.select().from(daemonState).all();
        const current = result[0];
        if (!current?.pid || !isProcessRunning(current.pid)) {
          return null;
        }
        return current;
      } finally {
        client.close();
      }
    });

    daemonPid = row.pid;
    assert.ok(daemonPid, "expected daemon pid to be stored");
    assert.match(startResult.stdout, new RegExp(`pid ${daemonPid}`));

    const secondResult = await waitForExit(
      spawn(process.execPath, daemonArgs, {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.notEqual(secondResult.code, 0, "second daemon launcher unexpectedly succeeded");
    assert.match(
      `${secondResult.stdout}\n${secondResult.stderr}`,
      new RegExp(`Another companyhelm daemon is already running with pid ${daemonPid}`),
    );
    assert.doesNotMatch(secondResult.stderr, /dist\/commands\/root\.js|at ChildProcess|Node\.js v/i);
  } finally {
    if (daemonPid && isProcessRunning(daemonPid)) {
      process.kill(daemonPid);
      await waitFor(async () => (isProcessRunning(daemonPid!) ? null : true), 15_000);
    }
    for (const call of controlCalls) {
      call.end();
    }
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm status reports daemon liveness, pid, and log directory", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-daemon-status-");
  const previousHome = process.env.HOME;
  let server: grpc.Server | null = null;
  const controlCalls: Array<grpc.ServerWritableStream<any, any>> = [];
  let daemonPid: number | null = null;

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);

    const started = await startFakeServer("/grpc", {
      registerRunner(_call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        controlCalls.push(call);
        call.sendMetadata(new grpc.Metadata());
      },
    });
    server = started.server;

    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const daemonArgs = [cliEntryPoint, "runner", "start", "-d", "--server-url", `127.0.0.1:${started.port}/grpc`];
    const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
    const logDirectory = resolveDefaultConfigDirectory(homeDirectory);

    await waitForExit(
      spawn(process.execPath, daemonArgs, {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    const row = await waitFor(async () => {
      const { db, client } = await initDb(stateDbPath);
      try {
        const result = await db.select().from(daemonState).all();
        const current = result[0];
        if (!current?.pid || !isProcessRunning(current.pid)) {
          return null;
        }
        return current;
      } finally {
        client.close();
      }
    });
    daemonPid = row.pid;

    const runningStatus = await waitForExit(
      spawn(process.execPath, [cliEntryPoint, "status", "--state-db-path", stateDbPath], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.equal(runningStatus.code, 0, `status command failed. stdout:\n${runningStatus.stdout}\nstderr:\n${runningStatus.stderr}`);
    assert.match(runningStatus.stdout, /Daemon: running/);
    assert.match(runningStatus.stdout, new RegExp(`PID: ${daemonPid}`));
    assert.match(runningStatus.stdout, new RegExp(`Log directory: ${logDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    process.kill(daemonPid);
    await waitFor(async () => (isProcessRunning(daemonPid!) ? null : true), 15_000);

    const stoppedStatus = await waitForExit(
      spawn(process.execPath, [cliEntryPoint, "status", "--state-db-path", stateDbPath], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.equal(stoppedStatus.code, 0, `status command failed after stop. stdout:\n${stoppedStatus.stdout}\nstderr:\n${stoppedStatus.stderr}`);
    assert.match(stoppedStatus.stdout, /Daemon: not running/);
    assert.match(stoppedStatus.stdout, /PID: none/);
    daemonPid = null;
  } finally {
    if (daemonPid && isProcessRunning(daemonPid)) {
      process.kill(daemonPid);
      await waitFor(async () => (isProcessRunning(daemonPid!) ? null : true), 15_000);
    }
    for (const call of controlCalls) {
      call.end();
    }
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm runner stop terminates the recorded daemon process", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-runner-stop-");
  const previousHome = process.env.HOME;
  let server: grpc.Server | null = null;
  const controlCalls: Array<grpc.ServerWritableStream<any, any>> = [];
  let daemonPid: number | null = null;

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);

    const started = await startFakeServer("/grpc", {
      registerRunner(_call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        controlCalls.push(call);
        call.sendMetadata(new grpc.Metadata());
      },
    });
    server = started.server;

    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const daemonArgs = [cliEntryPoint, "runner", "start", "-d", "--server-url", `127.0.0.1:${started.port}/grpc`];
    const stateDbPath = resolveDefaultStateDbPath(homeDirectory);

    await waitForExit(
      spawn(process.execPath, daemonArgs, {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    const row = await waitFor(async () => {
      const { db, client } = await initDb(stateDbPath);
      try {
        const result = await db.select().from(daemonState).all();
        const current = result[0];
        if (!current?.pid || !isProcessRunning(current.pid)) {
          return null;
        }
        return current;
      } finally {
        client.close();
      }
    });
    daemonPid = row.pid;

    const stopResult = await waitForExit(
      spawn(process.execPath, [cliEntryPoint, "runner", "stop", "--state-db-path", stateDbPath], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.equal(stopResult.code, 0, `runner stop failed. stdout:\n${stopResult.stdout}\nstderr:\n${stopResult.stderr}`);
    assert.match(stopResult.stdout, new RegExp(`CompanyHelm runner stopped \\(pid ${daemonPid}\\)`));
    await waitFor(async () => (daemonPid && !isProcessRunning(daemonPid) ? true : null), 15_000);

    const { db, client } = await initDb(stateDbPath);
    try {
      const result = await db.select().from(daemonState).all();
      assert.equal(result[0]?.pid ?? null, null);
    } finally {
      client.close();
    }

    daemonPid = null;
  } finally {
    if (daemonPid && isProcessRunning(daemonPid)) {
      process.kill(daemonPid);
      await waitFor(async () => (isProcessRunning(daemonPid!) ? null : true), 15_000);
    }
    for (const call of controlCalls) {
      call.end();
    }
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm shell exposes interactive DB inspection commands", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-shell-db-");

  try {
    const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
    const { db, client } = await initDb(stateDbPath);
    try {
      await db.insert(threads).values({
        id: "thread-shell",
        sdkThreadId: "sdk-thread-shell",
        cliSecret: "shell-secret",
        model: "gpt-5",
        reasoningLevel: "high",
        additionalModelInstructions: "Inspect only",
        status: "ready",
        currentSdkTurnId: "turn-shell",
        isCurrentTurnRunning: true,
        workspace: "/tmp/thread-shell",
        runtimeContainer: "companyhelm-runtime-thread-shell",
        dindContainer: "companyhelm-dind-thread-shell",
        homeDirectory: "/home/agent",
        uid: 1000,
        gid: 1000,
      });
      await db.insert(daemonState).values({
        id: "runner",
        pid: 4242,
        logPath: "/tmp/companyhelm-runner.log",
        startedAt: "2026-03-11T18:00:00.000Z",
        updatedAt: "2026-03-11T18:05:00.000Z",
      });
      await db.insert(agentSdks).values({
        name: "codex",
        authentication: "host",
        status: "configured",
      });
      await db.insert(llmModels).values({
        name: "gpt-5.3-codex",
        sdkName: "codex",
        reasoningLevels: ["high"],
      });
      await db.insert(threadUserMessageRequestStore).values({
        threadId: "thread-shell",
        sdkTurnId: "turn-shell",
        requestId: "request-shell",
        sdkItemId: "item-shell",
      });
    } finally {
      client.close();
    }

    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const child = spawn(process.execPath, [cliEntryPoint, "shell"], {
      cwd: repositoryRoot,
      env: { ...process.env, HOME: homeDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.write("list threads\n");
    child.stdin.write("list sdks\n");
    child.stdin.write("list models\n");
    child.stdin.write("list requests\n");
    child.stdin.write("list daemon\n");
    child.stdin.write("thread status thread-shell\n");
    child.stdin.write("list containers\n");
    child.stdin.write("show daemon\n");
    child.stdin.write("exit\n");
    child.stdin.end();

    const result = await waitForExit(child);

    assert.equal(result.code, 0, `CLI failed. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stderr.trim(), "");
    assert.match(result.stdout, /State DB: .*state\.db/);
    assert.match(result.stdout, /Available commands:/);
    assert.match(result.stdout, /Threads:/);
    assert.match(result.stdout, /Agent SDKs:/);
    assert.match(result.stdout, /"name": "codex"/);
    assert.match(result.stdout, /LLM models:/);
    assert.match(result.stdout, /"sdkName": "codex"/);
    assert.match(result.stdout, /Thread user message request store:/);
    assert.match(result.stdout, /"requestId": "request-shell"/);
    assert.match(result.stdout, /Daemon state table:/);
    assert.match(result.stdout, /thread docker <id>/);
    assert.match(result.stdout, /"id": "thread-shell"/);
    assert.match(result.stdout, /"status": "ready"/);
    assert.match(result.stdout, /"sdkThreadId": "sdk-thread-shell"/);
    assert.match(result.stdout, /Containers:/);
    assert.match(result.stdout, /"runtimeContainer": "companyhelm-runtime-thread-shell"/);
    assert.match(result.stdout, /"dindContainer": "companyhelm-dind-thread-shell"/);
    assert.match(result.stdout, /Daemon state:/);
    assert.match(result.stdout, /"pid": 4242/);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm sdk codex use-host-auth prints a friendly error when the host auth file is missing", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-sdk-codex-host-auth-missing-");

  try {
    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const result = await waitForExit(
      spawn(process.execPath, [cliEntryPoint, "sdk", "codex", "use-host-auth"], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.notEqual(result.code, 0, `CLI unexpectedly succeeded. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /Codex host auth file not found at .*auth\.json\./);
    assert.doesNotMatch(result.stderr, /at runSdkCodexSetHostAuthCommand|Node\.js v|dist\/commands\//);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("initDb reconciles legacy threads.sdk_id column to sdk_thread_id", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-legacy-sdk-id-");

  try {
    const stateDbPath = resolveDefaultStateDbPath(homeDirectory);

    {
      const { client } = await initDb(stateDbPath);
      try {
        await client.execute("ALTER TABLE threads RENAME COLUMN sdk_thread_id TO sdk_id");
      } finally {
        client.close();
      }
    }

    {
      const { client } = await initDb(stateDbPath);
      try {
        const pragma = await client.execute("PRAGMA table_info('threads')");
        const columnNames = new Set(pragma.rows.map((row: any) => String(row.name ?? "")));

        assert.equal(columnNames.has("sdk_thread_id"), true, "expected compatibility reconciliation to add sdk_thread_id");
        assert.equal(columnNames.has("sdk_id"), false, "expected legacy sdk_id column to be renamed");
      } finally {
        client.close();
      }
    }
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("initDb migrates legacy threads and agent_sdks rows before status columns existed", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-legacy-status-columns-");

  try {
    const stateDbPath = resolveDefaultStateDbPath(homeDirectory);

    await seedLegacyMigratedDatabase(
      stateDbPath,
      ["0000_nice_stepford_cuckoos", "0001_third_vermin"],
      async (client) => {
        await client.execute("INSERT INTO agent_sdks (name, authentication) VALUES ('codex', 'host')");
        await client.execute("INSERT INTO agents (id, name, sdk) VALUES ('agent-codex', 'Codex', 'codex')");
        await client.execute(`
          INSERT INTO threads (
            id,
            agent_id,
            model,
            reasoning_level,
            workspace,
            runtime_container,
            dind_container,
            home_directory,
            uid,
            gid
          ) VALUES (
            'thread-legacy-status',
            'agent-codex',
            'gpt-5-codex',
            'medium',
            '/tmp/companyhelm/thread-legacy-status',
            'runtime-thread-legacy-status',
            'dind-thread-legacy-status',
            '/home/agent',
            1000,
            1000
          )
        `);
      },
    );

    const { db, client } = await initDb(stateDbPath);
    try {
      const [sdk] = await db.select().from(agentSdks).where(eq(agentSdks.name, "codex")).limit(1);
      const [thread] = await db.select().from(threads).where(eq(threads.id, "thread-legacy-status")).limit(1);

      assert.equal(sdk?.status, "configured");
      assert.equal(thread?.status, "ready");
    } finally {
      client.close();
    }
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command connects to API and triggers registration flow", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-integration-");
  let server: grpc.Server | undefined;
  const staleModelName = "hardcoded-stale-model";
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after registration flow validation");
  let shouldStopAfterValidation = false;
  const nativeSetTimeout = global.setTimeout;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory, { modelName: staleModelName, reasoningLevels: ["high"] });

    let registerRequest: any = null;
    let controlChannelOpened = false;
    let channelOpenedBeforeRegister = false;

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        registerRequest = call.request;
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        controlChannelOpened = true;
        if (!registerRequest) {
          channelOpenedBeforeRegister = true;
        }
        shouldStopAfterValidation = true;
        call.sendMetadata(new grpc.Metadata());
        call.end();
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after registration flow validation",
    );

    assert.equal(controlChannelOpened, true);
    assert.equal(channelOpenedBeforeRegister, false);
    assert.equal(registerRequest?.agentSdks?.[0]?.name, "codex");
    const codexModels = registerRequest?.agentSdks?.[0]?.models ?? [];
    assert.ok(Array.isArray(codexModels));
    assert.equal(
      codexModels.some((model: { name: string }) => model.name === staleModelName),
      false,
      "runner registration should not reuse stale hardcoded models from local state",
    );
  } finally {
    reconnectDelaySpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command retries until server becomes available", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-retry-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after retry validation");
  let shouldStopAfterValidation = false;
  const nativeSetTimeout = global.setTimeout;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);

    const port = await reserveFreePort();
    let registerRequests = 0;
    let controlChannelOpened = false;

    const serverStartPromise = new Promise<void>((resolve, reject) => {
      setTimeout(async () => {
        try {
          const started = await startFakeServer(
            "/grpc",
            {
              registerRunner(call, callback) {
                registerRequests += 1;
                callback(null, create(RegisterRunnerResponseSchema, {}));
              },
              controlChannel(call) {
                controlChannelOpened = true;
                shouldStopAfterValidation = true;
                call.sendMetadata(new grpc.Metadata());
                call.end();
              },
            },
            `127.0.0.1:${port}`,
          );

          server = started.server;
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 1_500);
    });

    const rootCommandPromise = assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after retry validation",
    );
    await serverStartPromise;
    await rootCommandPromise;

    assert.equal(controlChannelOpened, true);
    assert.equal(registerRequests, 1);
  } finally {
    reconnectDelaySpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command fails fast on unauthenticated API errors", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-unauthenticated-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  let registerRequests = 0;

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);

    const started = await startFakeServer("/grpc", {
      registerRunner(_call, callback) {
        registerRequests += 1;
        callback(Object.assign(new Error("Missing authorization header."), {
          code: grpc.status.UNAUTHENTICATED,
          details: "Missing authorization header.",
        }));
      },
    });
    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      /Provide --secret <secret> to authenticate\./,
    );

    assert.equal(registerRequests, 1);
  } finally {
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command returns requestError for createThreadRequest when model is not configured", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-create-thread-unconfigured-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after missing-model thread create validation");
  let shouldStopAfterValidation = false;
  const createThreadContainersSpy = vi.spyOn(
    threadLifecycle.ThreadContainerService.prototype,
    "createThreadContainers",
  );
  const nativeSetTimeout = global.setTimeout;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);
    await writeHostAuthFile(homeDirectory);

    let receivedClientUpdate: any = null;
    const requestId = "request-missing-model-create-thread";

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        const createThreadMessage = create(
          ServerMessageSchema,
          {
            requestId,
            request: {
                case: "createThreadRequest",
                value: {
                threadId: "thread-unconfigured",
                model: "gpt-5.3-missing-model",
                },
              },
            },
        );
        call.write(
          createThreadMessage,
        );

        call.on("data", (message) => {
          receivedClientUpdate = message;
          shouldStopAfterValidation = true;
          call.end();
        });
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after missing-model thread create validation",
    );

    assert.ok(receivedClientUpdate, "expected CLI to send response for createThreadRequest");
    assert.equal(receivedClientUpdate.payload.case, "requestError");
    assert.equal(receivedClientUpdate.requestId, requestId);
    assert.match(receivedClientUpdate.payload.value.errorMessage, /not configured/i);
    assert.match(receivedClientUpdate.payload.value.errorMessage, /gpt-5\.3-missing-model/i);
    assert.equal(createThreadContainersSpy.mock.calls.length, 0);
  } finally {
    reconnectDelaySpy.mockRestore();
    createThreadContainersSpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command returns threadUpdate deleted for deleteThreadRequest when thread does not exist", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-delete-thread-missing-thread-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after missing-thread delete validation");
  let shouldStopAfterValidation = false;
  const nativeSetTimeout = global.setTimeout;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout, ...args);
  }) as typeof global.setTimeout);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);

    let receivedRequestError: any = null;
    let receivedDeleteRequestId: string | null = null;
    let receivedDeletedThreadUpdate = false;
    const requestId = "request-missing-delete-thread";

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        const deleteThreadMessage = create(ServerMessageSchema, {
            requestId,
            request: {
              case: "deleteThreadRequest",
              value: {
                threadId: "thread-missing-delete",
              },
            },
          });
        call.write(deleteThreadMessage);

        call.on("data", (message) => {
          if (message.payload.case === "requestError") {
            receivedRequestError = message;
            call.end();
            return;
          }

          if (
            message.payload.case === "threadUpdate" &&
            message.payload.value.threadId === "thread-missing-delete" &&
            message.payload.value.status === ThreadStatus.DELETED
          ) {
            receivedDeleteRequestId = message.requestId ?? null;
            receivedDeletedThreadUpdate = true;
            shouldStopAfterValidation = true;
            call.end();
          }
        });
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after missing-thread delete validation",
    );

    assert.equal(receivedRequestError, null, "did not expect requestError for missing thread delete");
    assert.equal(receivedDeletedThreadUpdate, true, "expected deleted update for missing thread delete");
    assert.equal(receivedDeleteRequestId, requestId, "expected deleted update to preserve request id");
    assert.equal(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "Delete requested for missing thread 'thread-missing-delete'. Treating as deleted.",
        ),
      ),
      true,
      "expected warning log for missing thread delete",
    );
  } finally {
    reconnectDelaySpy.mockRestore();
    warnSpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command writes synced GitHub installations payload and CLI instructions into thread workspace", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-thread-github-installations-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after github installation sync validation");
  const nativeSetTimeout = global.setTimeout;
  let shouldStopAfterValidation = false;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  const createThreadContainersSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
    .mockImplementation(async () => undefined);
  const ensureContainerRunningSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureContainerRunning")
    .mockImplementation(async () => undefined);
  const waitForContainerRunningSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "waitForContainerRunning")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerIdentitySpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerIdentity")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerGitConfigSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerGitConfig")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerToolingSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerTooling")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerBashrcSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerBashrc")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerCodexConfigSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerCodexConfig")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerAgentCliConfigSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerAgentCliConfig")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerThreadGitSkillsSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerThreadGitSkills")
    .mockImplementation(async () => undefined);
  const appServerStartSpy = vi.spyOn(AppServerService.prototype, "start").mockImplementation(async () => undefined);
  const startThreadWithResponseSpy = vi
    .spyOn(AppServerService.prototype, "startThreadWithResponse")
    .mockImplementation(async () => ({
      id: "github-installations-thread-start",
      result: {
        thread: {
          id: "sdk-thread-github-installations",
          path: "/workspace/rollouts/github-installations.json",
        },
      },
    }));

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);
    await writeHostAuthFile(homeDirectory);

    let receivedRequestError: any = null;
    let createdThreadId: string | null = null;

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      listGithubInstallationsForRunner(_call, callback) {
        callback(
          null,
          create(ListGithubInstallationsForRunnerResponseSchema, {
            installations: [
              create(GithubInstallationForRunnerSchema, {
                installationId: BigInt(112102565),
              }),
            ],
          }),
        );
      },
      getGithubInstallationAccessTokenForRunner(call, callback) {
        callback(
          null,
          create(GetGithubInstallationAccessTokenForRunnerResponseSchema, {
            installationId: call.request.installationId,
            accessToken: "ghs_test_installation_token",
            accessTokenExpiresUnixTimeMs: BigInt(1767142800000),
            repositories: ["acme/backend", "acme/frontend"],
          }),
        );
      },
      controlChannel(call) {
        call.write(
          create(ServerMessageSchema, {
            request: {
              case: "createThreadRequest",
              value: {
                threadId: "thread-github-installations",
                model: "gpt-5.3-codex",
                reasoningLevel: "high",
                cliSecret: "thread-secret-github-installations",
                gitSkillPackages: [
                  {
                    repositoryUrl: "https://github.com/obra/superpowers.git",
                    commitReference: "main",
                    skills: [
                      { directoryPath: "skills/brainstorming" },
                      { directoryPath: "skills/systematic-debugging" },
                    ],
                  },
                ],
              },
            },
          }),
        );

        call.on("data", (message) => {
          if (message.payload.case === "requestError") {
            receivedRequestError = message;
            call.end();
            return;
          }

          if (
            message.payload.case === "threadUpdate" &&
            message.payload.value.status === ThreadStatus.READY
          ) {
            createdThreadId = message.payload.value.threadId;
            shouldStopAfterValidation = true;
            call.end();
          }
        });
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after github installation sync validation",
    );

    assert.equal(receivedRequestError, null, "did not expect requestError during createThread flow");
    assert.ok(createdThreadId, "expected thread to be created");

    const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
    const { db, client } = await initDb(stateDbPath);
    let agentsMdContents = "";
    let installationsPayload: Record<string, unknown> | null = null;
    let threadGitSkillsPayload: Record<string, unknown> | null = null;
    let threadAgentCliPayload: Record<string, unknown> | null = null;
    try {
      const [threadRow] = await db.select().from(threads).where(eq(threads.id, createdThreadId!)).limit(1);
      assert.ok(threadRow, "expected thread row to exist");
      assert.equal(threadRow?.cliSecret, "thread-secret-github-installations");
      const agentsPath = path.join(threadRow!.workspace, "AGENTS.md");
      assert.equal(existsSync(agentsPath), true, "expected AGENTS.md to be created in thread workspace");
      agentsMdContents = await readFile(agentsPath, "utf8");

      const installationsPath = path.join(threadRow!.workspace, ".companyhelm", "installations.json");
      assert.equal(existsSync(installationsPath), true, "expected installations.json to be created in thread workspace");
      installationsPayload = JSON.parse(await readFile(installationsPath, "utf8")) as Record<string, unknown>;

      const threadGitSkillsPath = path.join(threadRow!.workspace, ".companyhelm", "thread-git-skills.json");
      assert.equal(existsSync(threadGitSkillsPath), true, "expected thread git skills config to be created in thread workspace");
      threadGitSkillsPayload = JSON.parse(await readFile(threadGitSkillsPath, "utf8")) as Record<string, unknown>;

      const threadAgentCliPath = path.join(threadRow!.workspace, ".companyhelm", "thread-agent-cli.json");
      assert.equal(existsSync(threadAgentCliPath), true, "expected thread agent CLI config to be created in thread workspace");
      threadAgentCliPayload = JSON.parse(await readFile(threadAgentCliPath, "utf8")) as Record<string, unknown>;
    } finally {
      client.close();
    }

    assert.equal(agentsMdContents.includes("## GitHub Installations"), true);
    assert.equal(agentsMdContents.includes("list-installations"), true);
    assert.equal(agentsMdContents.includes("gh-use-installation"), true);
    assert.ok(installationsPayload, "expected installations payload to be parsed");
    const syncedAt = String((installationsPayload as Record<string, unknown>).synced_at ?? "");
    assert.equal(syncedAt.length > 0, true);
    const rawInstallations = (installationsPayload as Record<string, unknown>).installations;
    assert.equal(Array.isArray(rawInstallations), true);
    const installations = (rawInstallations as Array<Record<string, unknown>>);
    assert.equal(installations.length, 1);
    assert.deepEqual(installations[0], {
      installation_id: "112102565",
      access_token: "ghs_test_installation_token",
      access_token_expires_unix_time_ms: "1767142800000",
      access_token_expiration: new Date(1767142800000).toISOString(),
      repositories: ["acme/backend", "acme/frontend"],
    });

    assert.ok(threadGitSkillsPayload, "expected thread git skills payload to be parsed");
    const rawThreadGitSkillPackages = (threadGitSkillsPayload as Record<string, unknown>).packages;
    assert.equal(Array.isArray(rawThreadGitSkillPackages), true);
    const threadGitSkillPackages = rawThreadGitSkillPackages as Array<Record<string, unknown>>;
    assert.equal(threadGitSkillPackages.length, 1);
    assert.equal(threadGitSkillPackages[0].repositoryUrl, "https://github.com/obra/superpowers.git");
    assert.equal(threadGitSkillPackages[0].commitReference, "main");
    assert.equal(
      typeof threadGitSkillPackages[0].checkoutDirectoryName === "string" &&
        String(threadGitSkillPackages[0].checkoutDirectoryName).length > 0,
      true,
      "expected checkoutDirectoryName to be set",
    );
    const rawThreadGitSkills = threadGitSkillPackages[0].skills;
    assert.equal(Array.isArray(rawThreadGitSkills), true);
    const threadGitSkills = rawThreadGitSkills as Array<Record<string, unknown>>;
    assert.deepEqual(
      threadGitSkills.map((skill) => skill.directoryPath),
      ["skills/brainstorming", "skills/systematic-debugging"],
    );
    assert.deepEqual(
      threadGitSkills.map((skill) => skill.linkName),
      ["brainstorming", "systematic-debugging"],
    );
    assert.ok(threadAgentCliPayload, "expected thread agent CLI payload to be parsed");
    assert.equal(threadAgentCliPayload.agent_api_url, "https://api.companyhelm.com:50052");
    assert.equal(threadAgentCliPayload.token, "thread-secret-github-installations");
  } finally {
    reconnectDelaySpy.mockRestore();
    createThreadContainersSpy.mockRestore();
    ensureContainerRunningSpy.mockRestore();
    waitForContainerRunningSpy.mockRestore();
    ensureRuntimeContainerIdentitySpy.mockRestore();
    ensureRuntimeContainerGitConfigSpy.mockRestore();
    ensureRuntimeContainerToolingSpy.mockRestore();
    ensureRuntimeContainerBashrcSpy.mockRestore();
    ensureRuntimeContainerCodexConfigSpy.mockRestore();
    ensureRuntimeContainerAgentCliConfigSpy.mockRestore();
    ensureRuntimeContainerThreadGitSkillsSpy.mockRestore();
    appServerStartSpy.mockRestore();
    startThreadWithResponseSpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command echoes app-server thread/start response id on thread READY updates", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-create-thread-request-id-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after create-thread request id validation");
  const nativeSetTimeout = global.setTimeout;
  let shouldStopAfterValidation = false;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  const createThreadContainersSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
    .mockImplementation(async () => undefined);
  const ensureContainerRunningSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureContainerRunning")
    .mockImplementation(async () => undefined);
  const waitForContainerRunningSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "waitForContainerRunning")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerIdentitySpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerIdentity")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerGitConfigSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerGitConfig")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerToolingSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerTooling")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerBashrcSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerBashrc")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerCodexConfigSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerCodexConfig")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerAgentCliConfigSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerAgentCliConfig")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerThreadGitSkillsSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerThreadGitSkills")
    .mockImplementation(async () => undefined);
  const appServerStartSpy = vi.spyOn(AppServerService.prototype, "start").mockImplementation(async () => undefined);
  const startThreadWithResponseSpy = vi
    .spyOn(AppServerService.prototype, "startThreadWithResponse")
    .mockImplementation(async (_params: any, requestId?: string | number) => ({
      id: requestId ?? "unexpected-missing-request-id",
      result: {
        thread: {
          id: "sdk-thread-request-id-1",
          path: "/workspace/rollouts/request-id-thread.json",
        },
      },
    }));

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);
    await writeHostAuthFile(homeDirectory);

    const requestId = "request-create-thread-1";
    let receivedReadyUpdate: any = null;
    let receivedRequestError: any = null;

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        const createThreadMessage = create(
          ServerMessageSchema,
          {
            requestId,
            request: {
              case: "createThreadRequest",
              value: {
                threadId: "thread-request-id",
                model: "gpt-5.3-codex",
                reasoningLevel: "high",
                cliSecret: "thread-secret-request-id",
              },
            },
          },
        );
        call.write(createThreadMessage);

        call.on("data", (message) => {
          if (message.payload.case === "requestError") {
            receivedRequestError = message;
            call.end();
            return;
          }

          if (
            message.payload.case === "threadUpdate" &&
            message.payload.value.status === ThreadStatus.READY
          ) {
            receivedReadyUpdate = message;
            shouldStopAfterValidation = true;
            call.end();
          }
        });
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after create-thread request id validation",
    );

    assert.equal(receivedRequestError, null, "did not expect requestError during createThread request-id flow");
    assert.ok(receivedReadyUpdate, "expected thread READY update");
    assert.equal(receivedReadyUpdate.requestId, requestId);
    assert.equal(startThreadWithResponseSpy.mock.calls.length, 1, "expected one app-server thread/start call");
    assert.equal(startThreadWithResponseSpy.mock.calls[0]?.[1], requestId, "expected request id to be forwarded to app-server");
    assert.equal(appServerStartSpy.mock.calls.length >= 1, true, "expected app-server session start during thread creation");
    assert.equal(createThreadContainersSpy.mock.calls.length, 1, "expected thread containers to be created once");
  } finally {
    reconnectDelaySpy.mockRestore();
    createThreadContainersSpy.mockRestore();
    ensureContainerRunningSpy.mockRestore();
    waitForContainerRunningSpy.mockRestore();
    ensureRuntimeContainerIdentitySpy.mockRestore();
    ensureRuntimeContainerGitConfigSpy.mockRestore();
    ensureRuntimeContainerToolingSpy.mockRestore();
    ensureRuntimeContainerBashrcSpy.mockRestore();
    ensureRuntimeContainerCodexConfigSpy.mockRestore();
    ensureRuntimeContainerAgentCliConfigSpy.mockRestore();
    ensureRuntimeContainerThreadGitSkillsSpy.mockRestore();
    appServerStartSpy.mockRestore();
    startThreadWithResponseSpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command handles full lifecycle: create thread and delete thread", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-thread-lifecycle-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after lifecycle validation");
  const nativeSetTimeout = global.setTimeout;
  let shouldStopAfterValidation = false;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);
  const activeContainerNames = new Set<string>();
  const activeVolumeNames = new Set<string>();

  const createThreadContainersSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
    .mockImplementation(async (options) => {
      activeContainerNames.add(options.names.runtime);
      activeContainerNames.add(options.names.dind);
      activeVolumeNames.add(options.names.home);
      activeVolumeNames.add(options.names.tmp);
    });
  const ensureContainerRunningSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureContainerRunning")
    .mockImplementation(async () => undefined);
  const waitForContainerRunningSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "waitForContainerRunning")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerIdentitySpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerIdentity")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerGitConfigSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerGitConfig")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerToolingSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerTooling")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerBashrcSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerBashrc")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerCodexConfigSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerCodexConfig")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerAgentCliConfigSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerAgentCliConfig")
    .mockImplementation(async () => undefined);
  const ensureRuntimeContainerThreadGitSkillsSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerThreadGitSkills")
    .mockImplementation(async () => undefined);
  const appServerStartSpy = vi.spyOn(AppServerService.prototype, "start").mockImplementation(async () => undefined);
  const startThreadWithResponseSpy = vi
    .spyOn(AppServerService.prototype, "startThreadWithResponse")
    .mockImplementation(async () => ({
      id: "lifecycle-thread-start",
      result: {
        thread: {
          id: "sdk-thread-lifecycle",
          path: "/workspace/rollouts/lifecycle.json",
        },
      },
    }));
  const forceRemoveContainerSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "forceRemoveContainer")
    .mockImplementation(async (name) => {
      activeContainerNames.delete(name);
    });
  const forceRemoveVolumeSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "forceRemoveVolume")
    .mockImplementation(async (name) => {
      activeVolumeNames.delete(name);
    });

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);
    await writeHostAuthFile(homeDirectory);

    let receivedRequestError: any = null;
    let createdThreadId: string | null = null;
    let sentDeleteThreadRequest = false;
    let runtimeContainerPresentAtReady: boolean | null = null;
    let dindContainerPresentAtReady: boolean | null = null;
    let homeVolumePresentAtReady: boolean | null = null;
    let tmpVolumePresentAtReady: boolean | null = null;
    let runtimeContainerPresentAfterThreadDelete: boolean | null = null;
    let dindContainerPresentAfterThreadDelete: boolean | null = null;
    let homeVolumePresentAfterThreadDelete: boolean | null = null;
    let tmpVolumePresentAfterThreadDelete: boolean | null = null;
    let threadWorkspacePath: string | null = null;
    let expectedThreadWorkspacePath: string | null = null;
    let threadWorkspacePresentAtReady: boolean | null = null;

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        call.write(
          create(ServerMessageSchema, {
            request: {
              case: "createThreadRequest",
              value: {
                threadId: "thread-for-lifecycle",
                model: "gpt-5.3-codex",
                reasoningLevel: "high",
              },
            },
          }),
        );

        call.on("data", (message) => {
          if (message.payload.case === "requestError") {
            receivedRequestError = message;
            call.end();
            return;
          }

          if (
            !sentDeleteThreadRequest &&
            message.payload.case === "threadUpdate" &&
            message.payload.value.status === ThreadStatus.READY
          ) {
            createdThreadId = message.payload.value.threadId;
            const expectedRuntimeContainer = `companyhelm-runtime-thread-${createdThreadId}`;
            const expectedDindContainer = `companyhelm-dind-thread-${createdThreadId}`;
            const expectedHomeVolume = `companyhelm-home-thread-${createdThreadId}`;
            const expectedTmpVolume = `companyhelm-tmp-thread-${createdThreadId}`;
            runtimeContainerPresentAtReady = activeContainerNames.has(expectedRuntimeContainer);
            dindContainerPresentAtReady = activeContainerNames.has(expectedDindContainer);
            homeVolumePresentAtReady = activeVolumeNames.has(expectedHomeVolume);
            tmpVolumePresentAtReady = activeVolumeNames.has(expectedTmpVolume);

            const createOptions = createThreadContainersSpy.mock.calls[0]?.[0];
            threadWorkspacePath = createOptions?.mounts?.[0]?.Source ?? null;
            expectedThreadWorkspacePath = threadLifecycle.resolveThreadDirectory(
              path.join(homeDirectory, ".config", "companyhelm"),
              "workspaces",
              createdThreadId,
            );
            threadWorkspacePresentAtReady = threadWorkspacePath ? existsSync(threadWorkspacePath) : false;

            sentDeleteThreadRequest = true;
            call.write(
              create(ServerMessageSchema, {
                request: {
                  case: "deleteThreadRequest",
                  value: {
                    threadId: createdThreadId,
                  },
                },
              }),
            );
            return;
          }

          if (
            message.payload.case === "threadUpdate" &&
            message.payload.value.status === ThreadStatus.DELETED &&
            message.payload.value.threadId === createdThreadId
          ) {
            if (createdThreadId) {
              runtimeContainerPresentAfterThreadDelete = activeContainerNames.has(`companyhelm-runtime-thread-${createdThreadId}`);
              dindContainerPresentAfterThreadDelete = activeContainerNames.has(`companyhelm-dind-thread-${createdThreadId}`);
              homeVolumePresentAfterThreadDelete = activeVolumeNames.has(`companyhelm-home-thread-${createdThreadId}`);
              tmpVolumePresentAfterThreadDelete = activeVolumeNames.has(`companyhelm-tmp-thread-${createdThreadId}`);
            }
            shouldStopAfterValidation = true;
            call.end();
          }
        });
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after first validated lifecycle flow",
    );

    assert.equal(receivedRequestError, null, "did not expect requestError during lifecycle flow");
    assert.ok(createdThreadId, "expected thread id from thread ready update");
    assert.equal(runtimeContainerPresentAtReady, true, "expected runtime container to exist when thread is ready");
    assert.equal(dindContainerPresentAtReady, true, "expected dind container to exist when thread is ready");
    assert.equal(homeVolumePresentAtReady, true, "expected thread home volume to exist when thread is ready");
    assert.equal(tmpVolumePresentAtReady, true, "expected thread tmp volume to exist when thread is ready");
    assert.equal(runtimeContainerPresentAfterThreadDelete, false, "expected runtime container to be removed after deleteThreadRequest");
    assert.equal(dindContainerPresentAfterThreadDelete, false, "expected dind container to be removed after deleteThreadRequest");
    assert.equal(homeVolumePresentAfterThreadDelete, false, "expected thread home volume to be removed after deleteThreadRequest");
    assert.equal(tmpVolumePresentAfterThreadDelete, false, "expected thread tmp volume to be removed after deleteThreadRequest");
    assert.equal(threadWorkspacePresentAtReady, true, "expected thread workspace directory to exist when thread is ready");
    assert.equal(activeContainerNames.size, 0, "expected no remaining active containers at end of lifecycle flow");
    assert.equal(activeVolumeNames.size, 0, "expected no remaining active thread home/tmp volumes at end of lifecycle flow");

    const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
    const { db, client } = await initDb(stateDbPath);
    try {
      const storedThreads = await db.select().from(threads).all();
      assert.equal(
        storedThreads.some((thread) => thread.id === createdThreadId),
        false,
        "expected lifecycle thread to be removed",
      );
    } finally {
      client.close();
    }

    assert.equal(createThreadContainersSpy.mock.calls.length, 1);
    assert.equal(forceRemoveContainerSpy.mock.calls.length, 2);
    const createOptions = createThreadContainersSpy.mock.calls[0][0];
    assert.equal(createOptions.names.runtime, `companyhelm-runtime-thread-${createdThreadId}`);
    assert.equal(createOptions.names.dind, `companyhelm-dind-thread-${createdThreadId}`);
    assert.equal(createOptions.names.home, `companyhelm-home-thread-${createdThreadId}`);
    assert.equal(createOptions.names.tmp, `companyhelm-tmp-thread-${createdThreadId}`);
    assert.equal(createOptions.mounts[0]?.Target, "/workspace");
    assert.equal(createOptions.mounts[0]?.Source, threadWorkspacePath);
    const homeVolumeMount = createOptions.mounts.find(
      (mount: { Type?: string; Source?: string; Target?: string }) =>
        mount.Type === "volume" && mount.Source === `companyhelm-home-thread-${createdThreadId}`,
    );
    assert.equal(homeVolumeMount?.Target, "/home/agent");
    const tmpVolumeMount = createOptions.mounts.find(
      (mount: { Type?: string; Source?: string; Target?: string }) =>
        mount.Type === "volume" && mount.Source === `companyhelm-tmp-thread-${createdThreadId}`,
    );
    assert.equal(tmpVolumeMount?.Target, "/tmp");
    assert.equal(threadWorkspacePath, expectedThreadWorkspacePath, "expected workspace path to include thread segmentation");
    assert.equal(threadWorkspacePath ? existsSync(threadWorkspacePath) : false, false, "expected thread workspace directory to be removed");

    const removedContainerNames = forceRemoveContainerSpy.mock.calls.map((call) => call[0]);
    assert.deepEqual(removedContainerNames, [
      `companyhelm-runtime-thread-${createdThreadId}`,
      `companyhelm-dind-thread-${createdThreadId}`,
    ]);
    const removedVolumeNames = forceRemoveVolumeSpy.mock.calls.map((call) => call[0]);
    assert.deepEqual(removedVolumeNames, [
      `companyhelm-home-thread-${createdThreadId}`,
      `companyhelm-tmp-thread-${createdThreadId}`,
    ]);
  } finally {
    reconnectDelaySpy.mockRestore();
    createThreadContainersSpy.mockRestore();
    ensureContainerRunningSpy.mockRestore();
    waitForContainerRunningSpy.mockRestore();
    ensureRuntimeContainerIdentitySpy.mockRestore();
    ensureRuntimeContainerGitConfigSpy.mockRestore();
    ensureRuntimeContainerToolingSpy.mockRestore();
    ensureRuntimeContainerBashrcSpy.mockRestore();
    ensureRuntimeContainerCodexConfigSpy.mockRestore();
    ensureRuntimeContainerAgentCliConfigSpy.mockRestore();
    ensureRuntimeContainerThreadGitSkillsSpy.mockRestore();
    appServerStartSpy.mockRestore();
    startThreadWithResponseSpy.mockRestore();
    forceRemoveContainerSpy.mockRestore();
    forceRemoveVolumeSpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test(
  "companyhelm root command resumes user-message threads using persisted rollout path after stop/start cycle",
  async () => {
    const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-user-message-resume-");
    let server: grpc.Server | undefined;
    const previousHome = process.env.HOME;
    const reconnectStopError = new Error("stop root command after user-message resume validation");
    const nativeSetTimeout = global.setTimeout;
    let shouldStopAfterValidation = false;
    const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
      if (shouldStopAfterValidation && timeout === 1_000) {
        throw reconnectStopError;
      }
      return nativeSetTimeout(handler, timeout as any, ...args);
    }) as typeof global.setTimeout);

    const rolloutPath = "/workspace/rollouts/saved-thread-rollout.json";
    const additionalModelInstructions = "  Ask for explicit assumptions before coding.  ";
    const normalizedAdditionalModelInstructions = "Ask for explicit assumptions before coding.";
    let createdThreadId: string | null = null;
    let receivedRequestError: any = null;
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const createThreadContainersSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
      .mockImplementation(async () => undefined);
    const ensureContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureContainerRunning")
      .mockImplementation(async () => undefined);
    const waitForContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "waitForContainerRunning")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerIdentitySpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerIdentity")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerGitConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerGitConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerToolingSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerTooling")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerBashrcSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerBashrc")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerCodexConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerCodexConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerAgentCliConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerAgentCliConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerThreadGitSkillsSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerThreadGitSkills")
      .mockImplementation(async () => undefined);
    const stopContainerSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "stopContainer")
      .mockImplementation(async () => undefined);

    const appServerStartSpy = vi.spyOn(AppServerService.prototype, "start").mockImplementation(async () => undefined);
    const appServerStopSpy = vi.spyOn(AppServerService.prototype, "stop").mockImplementation(async () => undefined);
    const startThreadWithResponseSpy = vi
      .spyOn(AppServerService.prototype, "startThreadWithResponse")
      .mockImplementation(async () => ({
        id: "bootstrap-thread-start",
        result: {
          thread: { id: "sdk-thread-1", path: rolloutPath },
        },
      }));
    const startThreadSpy = vi.spyOn(AppServerService.prototype, "startThread").mockImplementation(async () => {
      return { thread: { id: "unexpected-sdk-thread", path: "/workspace/rollouts/unexpected.json" } };
    });
    const resumeThreadSpy = vi.spyOn(AppServerService.prototype, "resumeThread").mockImplementation(async () => {
      return { thread: { id: "sdk-thread-1", path: rolloutPath } };
    });
    let turnCounter = 0;
    const startTurnSpy = vi.spyOn(AppServerService.prototype, "startTurn").mockImplementation(async () => {
      turnCounter += 1;
      return { turn: { id: `sdk-turn-${turnCounter}` } };
    });
    const waitForTurnCompletionSpy = vi
      .spyOn(AppServerService.prototype, "waitForTurnCompletion")
      .mockImplementation(async (threadId: string, turnId: string, onNotification?: (notification: any) => Promise<void> | void) => {
        const text = `assistant response for ${turnId}`;
        const item = {
          id: `${turnId}-agent-item`,
          type: "agentMessage",
          text,
        };

        await onNotification?.({
          method: "thread/name/updated",
          params: {
            threadId,
            threadName: `thread title for ${turnId}`,
          },
        });
        await onNotification?.({
          method: "item/started",
          params: {
            threadId,
            turnId,
            item,
          },
        });
        await onNotification?.({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item,
          },
        });
        return "completed";
      });

    try {
      process.env.HOME = homeDirectory;
      await seedStateDatabase(homeDirectory);
      await writeHostAuthFile(homeDirectory);

      let sentFirstUserMessageRequest = false;
      let sentSecondUserMessageRequest = false;
      let completedTurns = 0;
      const completedAgentResponses: Array<{ itemId: string; text: string }> = [];
      const receivedThreadNameUpdates: Array<{ threadId: string; threadName?: string }> = [];

      const started = await startFakeServer("/grpc", {
        registerRunner(call, callback) {
          callback(null, create(RegisterRunnerResponseSchema, {}));
        },
        controlChannel(call) {
          call.write(
            create(ServerMessageSchema, {
              request: {
                case: "createThreadRequest",
                value: {
                  threadId: "thread-user-message",
                  model: "gpt-5.3-codex",
                  cliSecret: "thread-secret-user-message",
                  additionalModelInstructions,
                  gitSkillPackages: [
                    {
                      repositoryUrl: "https://github.com/obra/superpowers.git",
                      commitReference: "main",
                      skills: [
                        { directoryPath: "skills/brainstorming" },
                        { directoryPath: "skills/systematic-debugging" },
                      ],
                    },
                  ],
                  mcpServers: [
                    {
                      serverId: "mcp-context7",
                      name: "context7",
                      transportConfig: {
                        case: "streamableHttp",
                        value: {
                          url: "https://mcp.context7.com/mcp",
                          authType: ThreadMcpAuthType.BEARER_TOKEN,
                          bearerToken: "context7-token",
                          headers: [{ key: "X-Team", value: "companyhelm" }],
                        },
                      },
                    },
                  ],
                },
              },
            }),
          );

          call.on("data", (message) => {
            if (message.payload.case === "requestError") {
              receivedRequestError = message;
              call.end();
              return;
            }

            if (message.payload.case === "threadNameUpdate") {
              receivedThreadNameUpdates.push({
                threadId: message.payload.value.threadId,
                threadName: message.payload.value.threadName,
              });
              return;
            }

            if (
              message.payload.case === "itemUpdate" &&
              message.payload.value.itemType === ItemType.AGENT_MESSAGE &&
              message.payload.value.status === ItemStatus.COMPLETED
            ) {
              completedAgentResponses.push({
                itemId: message.payload.value.sdkItemId,
                text: message.payload.value.text ?? "",
              });
              return;
            }

            if (
              !sentFirstUserMessageRequest &&
              message.payload.case === "threadUpdate" &&
              message.payload.value.status === ThreadStatus.READY
            ) {
              createdThreadId = message.payload.value.threadId;
              sentFirstUserMessageRequest = true;
              call.write(
                create(ServerMessageSchema, {
                  request: {
                    case: "createUserMessageRequest",
                    value: {
                      threadId: createdThreadId,
                      text: "first message",
                      allowSteer: false,
                    },
                  },
                }),
              );
              return;
            }

            if (message.payload.case === "turnUpdate" && message.payload.value.status === TurnStatus.COMPLETED) {
              completedTurns += 1;
              if (completedTurns === 1 && !sentSecondUserMessageRequest) {
                sentSecondUserMessageRequest = true;
                call.write(
                  create(ServerMessageSchema, {
                    request: {
                      case: "createUserMessageRequest",
                      value: {
                        threadId: createdThreadId!,
                        text: "second message",
                        allowSteer: false,
                      },
                    },
                  }),
                );
                return;
              }

              if (completedTurns >= 2) {
                shouldStopAfterValidation = true;
                call.end();
              }
            }
          });
        },
      });

      server = started.server;

      await assert.rejects(
        runRootCommand({
          serverUrl: `127.0.0.1:${started.port}/grpc`,
          logLevel: "DEBUG",
        }),
        (error: unknown) => error === reconnectStopError,
        "expected root command to stop after validating user-message resume flow",
      );

      assert.equal(receivedRequestError, null, "did not expect requestError for repeated user messages");
      assert.ok(createdThreadId, "expected thread id for user message flow");
      assert.equal(createThreadContainersSpy.mock.calls.length, 1);
      assert.equal(startThreadWithResponseSpy.mock.calls.length, 1, "expected create-thread bootstrap to create sdk thread once");
      assert.equal(startThreadSpy.mock.calls.length, 0, "expected first user message to reuse bootstrapped sdk thread");
      assert.equal(resumeThreadSpy.mock.calls.length, 0, "expected warm app-server session to avoid resume calls");
      assert.equal(appServerStartSpy.mock.calls.length >= 1, true, "expected app-server to start for user message flow");
      assert.equal(appServerStopSpy.mock.calls.length >= 1, true, "expected app-server to stop during command shutdown");
      assert.equal(startTurnSpy.mock.calls.length, 2, "expected one turn per user message");
      assert.equal(startThreadWithResponseSpy.mock.calls[0]?.[0]?.approvalPolicy, "never", "expected yolo approval on thread/start");
      assert.equal(startThreadWithResponseSpy.mock.calls[0]?.[0]?.sandbox, "danger-full-access", "expected yolo sandbox on thread/start");
      assert.equal(
        startThreadWithResponseSpy.mock.calls[0]?.[0]?.developerInstructions,
        normalizedAdditionalModelInstructions,
        "expected additional model instructions to be sent as thread/start developerInstructions",
      );
      assert.equal(
        debugSpy.mock.calls.some(
          (call) =>
            String(call[0]).includes("Starting app-server thread") &&
            String(call[0]).includes(normalizedAdditionalModelInstructions),
        ),
        true,
        "expected debug logs to include thread/start developer instructions",
      );

      const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
      const { db, client } = await initDb(stateDbPath);
      try {
        const [threadRow] = await db.select().from(threads).where(eq(threads.id, createdThreadId!)).limit(1);
        assert.equal(threadRow?.sdkThreadId, "sdk-thread-1", "expected create-thread bootstrap to persist sdk thread id");
      } finally {
        client.close();
      }

      assert.equal(startTurnSpy.mock.calls[0]?.[0]?.threadId, "sdk-thread-1", "expected first user message to reuse bootstrapped sdk thread id");
      for (const [params] of startTurnSpy.mock.calls) {
        assert.equal(params.approvalPolicy, "never", "expected yolo approval on turn/start");
        assert.deepEqual(params.sandboxPolicy, { type: "dangerFullAccess" }, "expected yolo sandbox on turn/start");
      }
      assert.equal(waitForTurnCompletionSpy.mock.calls.length, 2, "expected turn completion wait per user message");
      assert.equal(completedAgentResponses.length, 2, "expected one completed agent response item per user message");
      assert.deepEqual(
        completedAgentResponses.map((response) => response.itemId),
        ["sdk-turn-1-agent-item", "sdk-turn-2-agent-item"],
        "expected agent response item updates for both turns",
      );
      assert.deepEqual(
        completedAgentResponses.map((response) => response.text),
        ["assistant response for sdk-turn-1", "assistant response for sdk-turn-2"],
        "expected agent response text for both turns",
      );
      assert.deepEqual(
        receivedThreadNameUpdates,
        [
          { threadId: createdThreadId!, threadName: "thread title for sdk-turn-1" },
          { threadId: createdThreadId!, threadName: "thread title for sdk-turn-2" },
        ],
        "expected threadNameUpdate payloads for thread/name/updated notifications",
      );

      const expectedRuntimeContainer = `companyhelm-runtime-thread-${createdThreadId}`;
      const expectedDindContainer = `companyhelm-dind-thread-${createdThreadId}`;
      const stoppedContainerNames = stopContainerSpy.mock.calls.map((call) => call[0]);
      assert.deepEqual(stoppedContainerNames, [expectedRuntimeContainer, expectedDindContainer]);
      assert.equal(ensureContainerRunningSpy.mock.calls.length, 6, "expected dind/runtime ensure during create-thread bootstrap and each message");
      assert.equal(waitForContainerRunningSpy.mock.calls.length, 0, "expected no explicit dind wait in runtime ready helper");
      assert.equal(ensureRuntimeContainerIdentitySpy.mock.calls.length, 3, "expected runtime identity bootstrap during create-thread bootstrap and each message");
      assert.equal(ensureRuntimeContainerGitConfigSpy.mock.calls.length, 3, "expected runtime git config bootstrap during create-thread bootstrap and each message");
      assert.equal(ensureRuntimeContainerToolingSpy.mock.calls.length, 3, "expected runtime tooling bootstrap during create-thread bootstrap and each message");
      assert.equal(ensureRuntimeContainerBashrcSpy.mock.calls.length, 3, "expected runtime bashrc bootstrap during create-thread bootstrap and each message");
      assert.equal(
        ensureRuntimeContainerCodexConfigSpy.mock.calls.length,
        1,
        "expected Codex config.toml write only before first app-server startup",
      );
      assert.equal(
        ensureRuntimeContainerAgentCliConfigSpy.mock.calls.length,
        3,
        "expected companyhelm-agent config writes during create-thread bootstrap and each user message when thread secret exists",
      );
      const firstAgentCliConfig = ensureRuntimeContainerAgentCliConfigSpy.mock.calls[0]?.[2];
      assert.equal(firstAgentCliConfig?.agent_api_url, "https://api.companyhelm.com:50052");
      assert.equal(firstAgentCliConfig?.token, "thread-secret-user-message");
      const codexConfigToml = String(ensureRuntimeContainerCodexConfigSpy.mock.calls[0]?.[2] ?? "");
      assert.equal(codexConfigToml.includes("[mcp_servers.\"context7\"]"), true, "expected context7 MCP table in config");
      assert.equal(codexConfigToml.includes("url = \"https://mcp.context7.com/mcp\""), true, "expected context7 MCP URL in config");
      assert.equal(codexConfigToml.includes("bearer_token_env_var = \"COMPANYHELM_MCP_TOKEN_CONTEXT7\""), true, "expected bearer token env var wiring in config");
      assert.equal(
        /http_headers = \{ (\"X-Team\"|X-Team) = \"companyhelm\" \}/.test(codexConfigToml),
        true,
        "expected custom headers in MCP config",
      );
      assert.equal(
        ensureRuntimeContainerThreadGitSkillsSpy.mock.calls.length,
        3,
        "expected runtime thread git skill provisioning during create-thread bootstrap and each message",
      );
      assert.equal(
        ensureRuntimeContainerThreadGitSkillsSpy.mock.calls[0]?.[2]?.cloneRootDirectory,
        "/skills",
        "expected default thread git skills clone root",
      );
      assert.deepEqual(
        ensureRuntimeContainerThreadGitSkillsSpy.mock.calls[0]?.[2]?.packages?.[0]?.skills?.map((skill: any) => skill.linkName),
        ["brainstorming", "systematic-debugging"],
        "expected thread git skill link names to be derived from directory paths",
      );
    } finally {
      reconnectDelaySpy.mockRestore();
      createThreadContainersSpy.mockRestore();
      ensureContainerRunningSpy.mockRestore();
      waitForContainerRunningSpy.mockRestore();
      ensureRuntimeContainerIdentitySpy.mockRestore();
      ensureRuntimeContainerGitConfigSpy.mockRestore();
      ensureRuntimeContainerToolingSpy.mockRestore();
      ensureRuntimeContainerBashrcSpy.mockRestore();
      ensureRuntimeContainerCodexConfigSpy.mockRestore();
      ensureRuntimeContainerAgentCliConfigSpy.mockRestore();
      ensureRuntimeContainerThreadGitSkillsSpy.mockRestore();
      stopContainerSpy.mockRestore();
      appServerStartSpy.mockRestore();
      appServerStopSpy.mockRestore();
      startThreadWithResponseSpy.mockRestore();
      startThreadSpy.mockRestore();
      resumeThreadSpy.mockRestore();
      startTurnSpy.mockRestore();
      waitForTurnCompletionSpy.mockRestore();
      debugSpy.mockRestore();

      if (server) {
        await shutdownServer(server);
      }

      process.env.HOME = previousHome;
      await rm(homeDirectory, { recursive: true, force: true });
    }
  },
  180_000,
);

test(
  "companyhelm root command clears stale running state after a post-accept turn failure",
  async () => {
    const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-user-message-post-accept-failure-");
    let server: grpc.Server | undefined;
    const previousHome = process.env.HOME;
    const reconnectStopError = new Error("stop root command after post-accept failure validation");
    const nativeSetTimeout = global.setTimeout;
    let shouldStopAfterValidation = false;
    const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
      if (shouldStopAfterValidation && timeout === 1_000) {
        throw reconnectStopError;
      }
      return nativeSetTimeout(handler, timeout as any, ...args);
    }) as typeof global.setTimeout);

    const remoteCompactError =
      "Error running remote compact task: stream disconnected before completion: " +
      "error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)";
    let createdThreadId: string | null = null;
    const receivedRequestErrors: string[] = [];

    const createThreadContainersSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
      .mockImplementation(async () => undefined);
    const ensureContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureContainerRunning")
      .mockImplementation(async () => undefined);
    const waitForContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "waitForContainerRunning")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerIdentitySpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerIdentity")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerGitConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerGitConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerToolingSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerTooling")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerBashrcSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerBashrc")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerCodexConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerCodexConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerAgentCliConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerAgentCliConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerThreadGitSkillsSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerThreadGitSkills")
      .mockImplementation(async () => undefined);
    const stopContainerSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "stopContainer")
      .mockImplementation(async () => undefined);

    const appServerStartSpy = vi.spyOn(AppServerService.prototype, "start").mockImplementation(async () => undefined);
    const appServerStopSpy = vi.spyOn(AppServerService.prototype, "stop").mockImplementation(async () => undefined);
    const startThreadWithResponseSpy = vi
      .spyOn(AppServerService.prototype, "startThreadWithResponse")
      .mockImplementation(async () => ({
        id: "bootstrap-thread-start-post-accept-failure",
        result: {
          thread: { id: "sdk-thread-post-accept-failure", path: "/workspace/rollouts/post-accept-failure.json" },
        },
      }));
    const startThreadSpy = vi.spyOn(AppServerService.prototype, "startThread").mockImplementation(async () => {
      return {
        thread: {
          id: "unexpected-sdk-thread-post-accept-failure",
          path: "/workspace/rollouts/unexpected-post-accept-failure.json",
        },
      };
    });
    const resumeThreadSpy = vi.spyOn(AppServerService.prototype, "resumeThread").mockImplementation(async () => {
      return { thread: { id: "sdk-thread-post-accept-failure", path: "/workspace/rollouts/post-accept-failure.json" } };
    });
    let turnCounter = 0;
    const startTurnSpy = vi.spyOn(AppServerService.prototype, "startTurn").mockImplementation(async () => {
      turnCounter += 1;
      return { turn: { id: `sdk-turn-post-accept-failure-${turnCounter}` } };
    });
    const waitForTurnCompletionSpy = vi
      .spyOn(AppServerService.prototype, "waitForTurnCompletion")
      .mockImplementation(async (threadId: string, turnId: string, onNotification?: (notification: any) => Promise<void> | void) => {
        if (turnId === "sdk-turn-post-accept-failure-1") {
          throw new Error(remoteCompactError);
        }

        const item = {
          id: `${turnId}-agent-item`,
          type: "agentMessage",
          text: `assistant response for ${turnId}`,
        };

        await onNotification?.({
          method: "item/started",
          params: {
            threadId,
            turnId,
            item,
          },
        });
        await onNotification?.({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item,
          },
        });
        return "completed";
      });

    try {
      process.env.HOME = homeDirectory;
      await seedStateDatabase(homeDirectory);
      await writeHostAuthFile(homeDirectory);

      let sentFirstUserMessageRequest = false;
      let sentSecondUserMessageRequest = false;
      let completedTurns = 0;

      const started = await startFakeServer("/grpc", {
        registerRunner(call, callback) {
          callback(null, create(RegisterRunnerResponseSchema, {}));
        },
        controlChannel(call) {
          call.write(
            create(ServerMessageSchema, {
              request: {
                case: "createThreadRequest",
                value: {
                  threadId: "thread-post-accept-failure",
                  model: "gpt-5.3-codex",
                },
              },
            }),
          );

          call.on("data", (message) => {
            if (message.payload.case === "requestError") {
              receivedRequestErrors.push(message.payload.value.errorMessage);
              if (receivedRequestErrors.length === 1) {
                sentSecondUserMessageRequest = true;
                call.write(
                  create(ServerMessageSchema, {
                    request: {
                      case: "createUserMessageRequest",
                      value: {
                        threadId: createdThreadId!,
                        text: "follow-up message after compaction failure",
                        allowSteer: false,
                      },
                    },
                  }),
                );
                return;
              }

              shouldStopAfterValidation = true;
              call.end();
              return;
            }

            if (
              !sentFirstUserMessageRequest &&
              message.payload.case === "threadUpdate" &&
              message.payload.value.status === ThreadStatus.READY
            ) {
              createdThreadId = message.payload.value.threadId;
              sentFirstUserMessageRequest = true;
              call.write(
                create(ServerMessageSchema, {
                  request: {
                    case: "createUserMessageRequest",
                    value: {
                      threadId: createdThreadId,
                      text: "message that will fail during compaction",
                      allowSteer: false,
                    },
                  },
                }),
              );
              return;
            }

            if (message.payload.case === "turnUpdate" && message.payload.value.status === TurnStatus.COMPLETED) {
              completedTurns += 1;
              if (sentSecondUserMessageRequest && completedTurns >= 1) {
                shouldStopAfterValidation = true;
                call.end();
              }
            }
          });
        },
      });

      server = started.server;

      await assert.rejects(
        runRootCommand({
          serverUrl: `127.0.0.1:${started.port}/grpc`,
          logLevel: "DEBUG",
        }),
        (error: unknown) => error === reconnectStopError,
        "expected root command to stop after validating post-accept failure recovery",
      );

      assert.ok(createdThreadId, "expected thread id for post-accept failure flow");
      assert.deepEqual(
        receivedRequestErrors,
        [remoteCompactError],
        "expected only the original compaction failure requestError",
      );
      assert.equal(startTurnSpy.mock.calls.length, 2, "expected follow-up message to create a new turn");
      assert.equal(waitForTurnCompletionSpy.mock.calls.length, 2, "expected turn completion wait for failed and follow-up turns");
      assert.equal(resumeThreadSpy.mock.calls.length, 1, "expected failed warm session to be resumed for follow-up message");
      assert.equal(createThreadContainersSpy.mock.calls.length, 1, "expected thread containers to be created once");
      assert.equal(appServerStartSpy.mock.calls.length >= 1, true, "expected app-server to start for post-accept failure flow");
      assert.equal(appServerStopSpy.mock.calls.length >= 1, true, "expected app-server to stop after post-accept failure flow");

      const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
      const { db, client } = await initDb(stateDbPath);
      try {
        const [threadRow] = await db.select().from(threads).where(eq(threads.id, createdThreadId!)).limit(1);
        assert.equal(
          threadRow?.sdkThreadId,
          "sdk-thread-post-accept-failure",
          "expected sdk thread id to stay persisted after compaction failure recovery",
        );
        assert.equal(
          threadRow?.isCurrentTurnRunning,
          false,
          "expected runner-local thread state to be cleared after the follow-up turn completes",
        );
      } finally {
        client.close();
      }
    } finally {
      reconnectDelaySpy.mockRestore();
      createThreadContainersSpy.mockRestore();
      ensureContainerRunningSpy.mockRestore();
      waitForContainerRunningSpy.mockRestore();
      ensureRuntimeContainerIdentitySpy.mockRestore();
      ensureRuntimeContainerGitConfigSpy.mockRestore();
      ensureRuntimeContainerToolingSpy.mockRestore();
      ensureRuntimeContainerBashrcSpy.mockRestore();
      ensureRuntimeContainerCodexConfigSpy.mockRestore();
      ensureRuntimeContainerAgentCliConfigSpy.mockRestore();
      ensureRuntimeContainerThreadGitSkillsSpy.mockRestore();
      stopContainerSpy.mockRestore();
      appServerStartSpy.mockRestore();
      appServerStopSpy.mockRestore();
      startThreadWithResponseSpy.mockRestore();
      startThreadSpy.mockRestore();
      resumeThreadSpy.mockRestore();
      startTurnSpy.mockRestore();
      waitForTurnCompletionSpy.mockRestore();

      if (server) {
        await shutdownServer(server);
      }

      process.env.HOME = previousHome;
      await rm(homeDirectory, { recursive: true, force: true });
    }
  },
  180_000,
);

test(
  "companyhelm root command clears stale running state at startup when the runtime container is stopped",
  async () => {
    const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-runner-user-message-stale-startup-");
    let server: grpc.Server | undefined;
    const previousHome = process.env.HOME;
    const reconnectStopError = new Error("stop root command after stale startup validation");
    const nativeSetTimeout = global.setTimeout;
    let shouldStopAfterValidation = false;
    let receivedRequestError: string | null = null;
    const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
      if (shouldStopAfterValidation && timeout === 1_000) {
        throw reconnectStopError;
      }
      return nativeSetTimeout(handler, timeout as any, ...args);
    }) as typeof global.setTimeout);

    const createThreadContainersSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
      .mockImplementation(async () => undefined);
    const ensureContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureContainerRunning")
      .mockImplementation(async () => undefined);
    const waitForContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "waitForContainerRunning")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerIdentitySpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerIdentity")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerGitConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerGitConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerToolingSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerTooling")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerBashrcSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerBashrc")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerCodexConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerCodexConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerAgentCliConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerAgentCliConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerThreadGitSkillsSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerThreadGitSkills")
      .mockImplementation(async () => undefined);
    const isContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "isContainerRunning")
      .mockImplementation(async () => false);
    const stopContainerSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "stopContainer")
      .mockImplementation(async () => undefined);

    const appServerStartSpy = vi.spyOn(AppServerService.prototype, "start").mockImplementation(async () => undefined);
    const appServerStopSpy = vi.spyOn(AppServerService.prototype, "stop").mockImplementation(async () => undefined);
    const resumeThreadSpy = vi.spyOn(AppServerService.prototype, "resumeThread").mockImplementation(async () => ({
      thread: {
        id: "sdk-thread-stale-startup",
        path: "/workspace/rollouts/stale-startup.json",
        turns: [],
      },
    } as any));
    const startTurnSpy = vi.spyOn(AppServerService.prototype, "startTurn").mockImplementation(async () => ({
      turn: { id: "sdk-turn-after-startup-heal" },
    }));
    const waitForTurnCompletionSpy = vi
      .spyOn(AppServerService.prototype, "waitForTurnCompletion")
      .mockImplementation(async () => "completed");

    try {
      process.env.HOME = homeDirectory;
      await seedStateDatabase(homeDirectory);
      await writeHostAuthFile(homeDirectory);
      await seedExistingThread(homeDirectory, {
        threadId: "thread-stale-startup",
        sdkThreadId: "sdk-thread-stale-startup",
        currentSdkTurnId: "sdk-turn-stale-startup",
        isCurrentTurnRunning: true,
      });

      const started = await startFakeServer("/grpc", {
        registerRunner(call, callback) {
          callback(null, create(RegisterRunnerResponseSchema, {}));
        },
        controlChannel(call) {
          call.write(
            create(ServerMessageSchema, {
              request: {
                case: "createUserMessageRequest",
                value: {
                  threadId: "thread-stale-startup",
                  text: "message after stale startup cleanup",
                  allowSteer: false,
                },
              },
            }),
          );

          call.on("data", (message) => {
            if (message.payload.case === "requestError") {
              receivedRequestError = message.payload.value.errorMessage;
              shouldStopAfterValidation = true;
              call.end();
              return;
            }

            if (message.payload.case === "turnUpdate" && message.payload.value.status === TurnStatus.COMPLETED) {
              shouldStopAfterValidation = true;
              call.end();
            }
          });
        },
      });

      server = started.server;

      await assert.rejects(
        runRootCommand({
          serverUrl: `127.0.0.1:${started.port}/grpc`,
        }),
        (error: unknown) => error === reconnectStopError,
        "expected root command to stop after validating stale startup cleanup",
      );

      assert.equal(receivedRequestError, null, "did not expect stale running state to reject the user message");
      assert.equal(isContainerRunningSpy.mock.calls.length >= 1, true, "expected startup reconciliation to inspect runtime state");
      assert.equal(resumeThreadSpy.mock.calls.length, 1, "expected only the normal execution resume after startup cleanup");
      assert.equal(startTurnSpy.mock.calls.length, 1, "expected a fresh turn after startup cleanup");

      const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
      const { db, client } = await initDb(stateDbPath);
      try {
        const [threadRow] = await db.select().from(threads).where(eq(threads.id, "thread-stale-startup")).limit(1);
        assert.equal(threadRow?.isCurrentTurnRunning, false, "expected startup cleanup to clear stale running state");
        assert.equal(threadRow?.currentSdkTurnId, "sdk-turn-after-startup-heal", "expected the new turn id to replace the stale turn id");
      } finally {
        client.close();
      }
    } finally {
      reconnectDelaySpy.mockRestore();
      createThreadContainersSpy.mockRestore();
      ensureContainerRunningSpy.mockRestore();
      waitForContainerRunningSpy.mockRestore();
      ensureRuntimeContainerIdentitySpy.mockRestore();
      ensureRuntimeContainerGitConfigSpy.mockRestore();
      ensureRuntimeContainerToolingSpy.mockRestore();
      ensureRuntimeContainerBashrcSpy.mockRestore();
      ensureRuntimeContainerCodexConfigSpy.mockRestore();
      ensureRuntimeContainerAgentCliConfigSpy.mockRestore();
      ensureRuntimeContainerThreadGitSkillsSpy.mockRestore();
      isContainerRunningSpy.mockRestore();
      stopContainerSpy.mockRestore();
      appServerStartSpy.mockRestore();
      appServerStopSpy.mockRestore();
      resumeThreadSpy.mockRestore();
      startTurnSpy.mockRestore();
      waitForTurnCompletionSpy.mockRestore();

      if (server) {
        await shutdownServer(server);
      }

      process.env.HOME = previousHome;
      await rm(homeDirectory, { recursive: true, force: true });
    }
  },
  180_000,
);

test(
  "companyhelm root command lazily clears stale running state when the SDK turn is no longer in progress",
  async () => {
    const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-runner-user-message-stale-lazy-");
    let server: grpc.Server | undefined;
    const previousHome = process.env.HOME;
    const reconnectStopError = new Error("stop root command after stale lazy validation");
    const nativeSetTimeout = global.setTimeout;
    let shouldStopAfterValidation = false;
    let receivedRequestError: string | null = null;
    const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
      if (shouldStopAfterValidation && timeout === 1_000) {
        throw reconnectStopError;
      }
      return nativeSetTimeout(handler, timeout as any, ...args);
    }) as typeof global.setTimeout);

    const createThreadContainersSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
      .mockImplementation(async () => undefined);
    const ensureContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureContainerRunning")
      .mockImplementation(async () => undefined);
    const waitForContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "waitForContainerRunning")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerIdentitySpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerIdentity")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerGitConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerGitConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerToolingSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerTooling")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerBashrcSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerBashrc")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerCodexConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerCodexConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerAgentCliConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerAgentCliConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerThreadGitSkillsSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerThreadGitSkills")
      .mockImplementation(async () => undefined);
    const isContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "isContainerRunning")
      .mockImplementation(async () => true);
    const stopContainerSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "stopContainer")
      .mockImplementation(async () => undefined);

    const appServerStartSpy = vi.spyOn(AppServerService.prototype, "start").mockImplementation(async () => undefined);
    const appServerStopSpy = vi.spyOn(AppServerService.prototype, "stop").mockImplementation(async () => undefined);
    const resumeThreadSpy = vi.spyOn(AppServerService.prototype, "resumeThread").mockImplementation(async () => ({
      thread: {
        id: "sdk-thread-stale-lazy",
        path: "/workspace/rollouts/stale-lazy.json",
        turns: [
          {
            id: "sdk-turn-stale-lazy",
            status: "completed",
            items: [],
            error: null,
          },
        ],
      },
    } as any));
    const startTurnSpy = vi.spyOn(AppServerService.prototype, "startTurn").mockImplementation(async () => ({
      turn: { id: "sdk-turn-after-lazy-heal" },
    }));
    const waitForTurnCompletionSpy = vi
      .spyOn(AppServerService.prototype, "waitForTurnCompletion")
      .mockImplementation(async () => "completed");

    try {
      process.env.HOME = homeDirectory;
      await seedStateDatabase(homeDirectory);
      await writeHostAuthFile(homeDirectory);
      await seedExistingThread(homeDirectory, {
        threadId: "thread-stale-lazy",
        sdkThreadId: "sdk-thread-stale-lazy",
        currentSdkTurnId: "sdk-turn-stale-lazy",
        isCurrentTurnRunning: true,
      });

      const started = await startFakeServer("/grpc", {
        registerRunner(call, callback) {
          callback(null, create(RegisterRunnerResponseSchema, {}));
        },
        controlChannel(call) {
          call.write(
            create(ServerMessageSchema, {
              request: {
                case: "createUserMessageRequest",
                value: {
                  threadId: "thread-stale-lazy",
                  text: "message after lazy stale cleanup",
                  allowSteer: false,
                },
              },
            }),
          );

          call.on("data", (message) => {
            if (message.payload.case === "requestError") {
              receivedRequestError = message.payload.value.errorMessage;
              shouldStopAfterValidation = true;
              call.end();
              return;
            }

            if (message.payload.case === "turnUpdate" && message.payload.value.status === TurnStatus.COMPLETED) {
              shouldStopAfterValidation = true;
              call.end();
            }
          });
        },
      });

      server = started.server;

      await assert.rejects(
        runRootCommand({
          serverUrl: `127.0.0.1:${started.port}/grpc`,
        }),
        (error: unknown) => error === reconnectStopError,
        "expected root command to stop after validating lazy stale cleanup",
      );

      assert.equal(receivedRequestError, null, "did not expect stale running state to reject the user message");
      assert.equal(isContainerRunningSpy.mock.calls.length >= 1, true, "expected stale-state check to inspect runtime state");
      assert.equal(resumeThreadSpy.mock.calls.length, 1, "expected lazy stale-state recovery to resume the SDK thread");
      assert.equal(startTurnSpy.mock.calls.length, 1, "expected a fresh turn after lazy stale cleanup");

      const stateDbPath = resolveDefaultStateDbPath(homeDirectory);
      const { db, client } = await initDb(stateDbPath);
      try {
        const [threadRow] = await db.select().from(threads).where(eq(threads.id, "thread-stale-lazy")).limit(1);
        assert.equal(threadRow?.isCurrentTurnRunning, false, "expected lazy cleanup to clear stale running state");
        assert.equal(threadRow?.currentSdkTurnId, "sdk-turn-after-lazy-heal", "expected the new turn id to replace the stale turn id");
      } finally {
        client.close();
      }
    } finally {
      reconnectDelaySpy.mockRestore();
      createThreadContainersSpy.mockRestore();
      ensureContainerRunningSpy.mockRestore();
      waitForContainerRunningSpy.mockRestore();
      ensureRuntimeContainerIdentitySpy.mockRestore();
      ensureRuntimeContainerGitConfigSpy.mockRestore();
      ensureRuntimeContainerToolingSpy.mockRestore();
      ensureRuntimeContainerBashrcSpy.mockRestore();
      ensureRuntimeContainerCodexConfigSpy.mockRestore();
      ensureRuntimeContainerAgentCliConfigSpy.mockRestore();
      ensureRuntimeContainerThreadGitSkillsSpy.mockRestore();
      isContainerRunningSpy.mockRestore();
      stopContainerSpy.mockRestore();
      appServerStartSpy.mockRestore();
      appServerStopSpy.mockRestore();
      resumeThreadSpy.mockRestore();
      startTurnSpy.mockRestore();
      waitForTurnCompletionSpy.mockRestore();

      if (server) {
        await shutdownServer(server);
      }

      process.env.HOME = previousHome;
      await rm(homeDirectory, { recursive: true, force: true });
    }
  },
  180_000,
);

test(
  "companyhelm root command steers a running turn without adding a second completion waiter",
  async () => {
    const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-user-message-steer-");
    let server: grpc.Server | undefined;
    const previousHome = process.env.HOME;
    const reconnectStopError = new Error("stop root command after steering validation");
    const nativeSetTimeout = global.setTimeout;
    let shouldStopAfterValidation = false;
    const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
      if (shouldStopAfterValidation && timeout === 1_000) {
        throw reconnectStopError;
      }
      return nativeSetTimeout(handler, timeout as any, ...args);
    }) as typeof global.setTimeout);

    let createdThreadId: string | null = null;
    let receivedRequestError: any = null;

    const createThreadContainersSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
      .mockImplementation(async () => undefined);
    const ensureContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureContainerRunning")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerIdentitySpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerIdentity")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerGitConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerGitConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerToolingSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerTooling")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerBashrcSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerBashrc")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerCodexConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerCodexConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerAgentCliConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerAgentCliConfig")
      .mockImplementation(async () => undefined);
    const isContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "isContainerRunning")
      .mockImplementation(async () => true);
    const stopContainerSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "stopContainer")
      .mockImplementation(async () => undefined);

    const appServerStartSpy = vi.spyOn(AppServerService.prototype, "start").mockImplementation(async () => undefined);
    const appServerStopSpy = vi.spyOn(AppServerService.prototype, "stop").mockImplementation(async () => undefined);
    const startThreadWithResponseSpy = vi
      .spyOn(AppServerService.prototype, "startThreadWithResponse")
      .mockImplementation(async () => ({
        id: "steer-thread-start",
        result: {
          thread: { id: "sdk-thread-steer", path: "/workspace/rollouts/steer.json" },
        },
      }));
    const startThreadSpy = vi.spyOn(AppServerService.prototype, "startThread").mockImplementation(async () => {
      return { thread: { id: "unexpected-sdk-thread-steer", path: "/workspace/rollouts/unexpected-steer.json" } };
    });
    const startTurnSpy = vi.spyOn(AppServerService.prototype, "startTurn").mockImplementation(async () => {
      return { turn: { id: "sdk-turn-steer-1" } };
    });
    const steerTurnSpy = vi.spyOn(AppServerService.prototype, "steerTurn").mockImplementation(async () => {
      return { turnId: "sdk-turn-steer-shadow" };
    });

    let completeTurn: (() => void) | null = null;
    const waitForTurnCompletionSpy = vi
      .spyOn(AppServerService.prototype, "waitForTurnCompletion")
      .mockImplementation(async (threadId: string, turnId: string, onNotification?: (notification: any) => Promise<void> | void) => {
        const item = {
          id: `${turnId}-agent-item`,
          type: "agentMessage",
          text: "steered response",
        };
        await onNotification?.({
          method: "item/started",
          params: {
            threadId,
            turnId,
            item,
          },
        });
        await onNotification?.({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item,
          },
        });

        return await new Promise<"completed">((resolve) => {
          completeTurn = () => resolve("completed");
        });
      });

    try {
      process.env.HOME = homeDirectory;
      await seedStateDatabase(homeDirectory);
      await writeHostAuthFile(homeDirectory);

      let sentFirstUserMessageRequest = false;
      let sentSteerRequest = false;
      let runningUpdateCount = 0;
      const runningTurnIds: string[] = [];
      const completedTurnIds: string[] = [];

      const started = await startFakeServer("/grpc", {
        registerRunner(call, callback) {
          callback(null, create(RegisterRunnerResponseSchema, {}));
        },
        controlChannel(call) {
          call.write(
            create(ServerMessageSchema, {
              request: {
                case: "createThreadRequest",
                value: {
                  threadId: "thread-steer",
                  model: "gpt-5.3-codex",
                },
              },
            }),
          );

          call.on("data", (message) => {
            if (message.payload.case === "requestError") {
              receivedRequestError = message;
              call.end();
              return;
            }

            if (
              !sentFirstUserMessageRequest &&
              message.payload.case === "threadUpdate" &&
              message.payload.value.status === ThreadStatus.READY
            ) {
              createdThreadId = message.payload.value.threadId;
              sentFirstUserMessageRequest = true;
              call.write(
                create(ServerMessageSchema, {
                  request: {
                    case: "createUserMessageRequest",
                    value: {
                      threadId: createdThreadId,
                      text: "first message",
                      allowSteer: false,
                    },
                  },
                }),
              );
              return;
            }

            if (message.payload.case === "turnUpdate" && message.payload.value.status === TurnStatus.RUNNING) {
              runningUpdateCount += 1;
              runningTurnIds.push(message.payload.value.sdkTurnId);
              if (!sentSteerRequest) {
                sentSteerRequest = true;
                call.write(
                  create(ServerMessageSchema, {
                    request: {
                      case: "createUserMessageRequest",
                      value: {
                        threadId: createdThreadId!,
                        text: "steer message",
                        allowSteer: true,
                      },
                    },
                  }),
                );

                setTimeout(() => {
                  if (completeTurn) {
                    completeTurn();
                    completeTurn = null;
                  }
                }, 200);
                return;
              }

              if (completeTurn) {
                completeTurn();
                completeTurn = null;
              }
              return;
            }

            if (message.payload.case === "turnUpdate" && message.payload.value.status === TurnStatus.COMPLETED) {
              completedTurnIds.push(message.payload.value.sdkTurnId);
              shouldStopAfterValidation = true;
              call.end();
            }
          });
        },
      });

      server = started.server;

      await assert.rejects(
        runRootCommand({
          serverUrl: `127.0.0.1:${started.port}/grpc`,
        }),
        (error: unknown) => error === reconnectStopError,
        "expected root command to stop after validating steering flow",
      );

      assert.equal(receivedRequestError, null, "did not expect requestError while steering running turn");
      assert.ok(createdThreadId, "expected thread id for steering flow");
      assert.equal(createThreadContainersSpy.mock.calls.length, 1);
      assert.equal(appServerStartSpy.mock.calls.length >= 1, true, "expected app-server session start");
      assert.equal(appServerStopSpy.mock.calls.length >= 1, true, "expected app-server session stop on shutdown");
      assert.equal(startThreadWithResponseSpy.mock.calls.length, 1, "expected one sdk thread bootstrap during create-thread");
      assert.equal(startThreadSpy.mock.calls.length, 0, "expected no extra thread/start during steer flow");
      assert.equal(startTurnSpy.mock.calls.length, 1, "expected only initial turn/start call");
      assert.equal(startThreadWithResponseSpy.mock.calls[0]?.[0]?.approvalPolicy, "never", "expected yolo approval on thread/start");
      assert.equal(startThreadWithResponseSpy.mock.calls[0]?.[0]?.sandbox, "danger-full-access", "expected yolo sandbox on thread/start");
      assert.equal(startTurnSpy.mock.calls[0]?.[0]?.approvalPolicy, "never", "expected yolo approval on turn/start");
      assert.deepEqual(startTurnSpy.mock.calls[0]?.[0]?.sandboxPolicy, { type: "dangerFullAccess" }, "expected yolo sandbox on turn/start");
      assert.equal(steerTurnSpy.mock.calls.length, 1, "expected turn/steer for second user message");
      assert.equal(waitForTurnCompletionSpy.mock.calls.length, 1, "expected single completion waiter for running turn");
      assert.equal(runningUpdateCount, 2, "expected running updates for initial turn start and steer");
      assert.deepEqual(
        runningTurnIds,
        ["sdk-turn-steer-1", "sdk-turn-steer-1"],
        "expected steer updates to reuse the active running turn id",
      );
      assert.deepEqual(
        completedTurnIds,
        ["sdk-turn-steer-1"],
        "expected completion updates to target the original running turn",
      );
      assert.equal(ensureContainerRunningSpy.mock.calls.length, 6, "expected runtime readiness during create-thread bootstrap and both messages");
      assert.equal(ensureRuntimeContainerIdentitySpy.mock.calls.length, 3, "expected identity bootstrap during create-thread bootstrap and per message");
      assert.equal(ensureRuntimeContainerGitConfigSpy.mock.calls.length, 3, "expected git config bootstrap during create-thread bootstrap and per message");
      assert.equal(ensureRuntimeContainerToolingSpy.mock.calls.length, 3, "expected tooling bootstrap during create-thread bootstrap and per message");
      assert.equal(ensureRuntimeContainerBashrcSpy.mock.calls.length, 3, "expected bashrc bootstrap during create-thread bootstrap and per message");
      assert.equal(
        ensureRuntimeContainerCodexConfigSpy.mock.calls.length,
        1,
        "expected Codex config.toml write only before first app-server startup",
      );
      assert.equal(
        ensureRuntimeContainerAgentCliConfigSpy.mock.calls.length,
        0,
        "expected no companyhelm-agent config writes when thread secret is missing",
      );
      assert.equal(stopContainerSpy.mock.calls.length, 2, "expected runtime+dind stop on daemon shutdown");
    } finally {
      reconnectDelaySpy.mockRestore();
      createThreadContainersSpy.mockRestore();
      ensureContainerRunningSpy.mockRestore();
      ensureRuntimeContainerIdentitySpy.mockRestore();
      ensureRuntimeContainerGitConfigSpy.mockRestore();
      ensureRuntimeContainerToolingSpy.mockRestore();
      ensureRuntimeContainerBashrcSpy.mockRestore();
      ensureRuntimeContainerCodexConfigSpy.mockRestore();
      ensureRuntimeContainerAgentCliConfigSpy.mockRestore();
      isContainerRunningSpy.mockRestore();
      stopContainerSpy.mockRestore();
      appServerStartSpy.mockRestore();
      appServerStopSpy.mockRestore();
      startThreadWithResponseSpy.mockRestore();
      startThreadSpy.mockRestore();
      startTurnSpy.mockRestore();
      steerTurnSpy.mockRestore();
      waitForTurnCompletionSpy.mockRestore();

      if (server) {
        await shutdownServer(server);
      }

      process.env.HOME = previousHome;
      await rm(homeDirectory, { recursive: true, force: true });
    }
  },
  180_000,
);
