import { create } from "@bufbuild/protobuf";
import {
  AgentSdkStatus,
  CodexAuthType,
  ItemStatus,
  ItemType,
  ClientMessageSchema,
  ThreadStatus,
  TurnStatus,
  type CreateThreadRequest,
  type CreateUserMessageRequest,
  type DeleteThreadRequest,
  type InterruptTurnRequest,
  type ClientMessage,
  type AgentSdk,
  type RegisterRunnerRequest,
  RegisterRunnerRequestSchema,
} from "@companyhelm/protos";
import { and, eq } from "drizzle-orm";
import * as grpc from "@grpc/grpc-js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as configSchema, type Config } from "../config.js";
import {
  CompanyhelmApiClient,
  type CompanyhelmApiCallOptions,
  type CompanyhelmCommandChannel,
} from "../service/companyhelm_api_client.js";
import {
  BufferedClientMessageSender,
  type ClientMessageSink,
} from "../service/buffered_client_message_sender.js";
import { getHostInfo } from "../service/host.js";
import { formatSdkModelRefreshFailure, refreshSdkModels } from "../service/sdk/refresh_models.js";
import { AppServerService } from "../service/app_server.js";
import { RuntimeContainerAppServerTransport } from "../service/docker/runtime_app_server_exec.js";
import { ensureThreadRuntimeReady } from "../service/thread_runtime.js";
import {
  loadThreadMessageExecutionState,
  updateThreadTurnState as updateThreadTurnStateInDb,
  type ThreadMessageExecutionState,
} from "../service/thread_turn_state.js";
import {
  assignPendingUserMessageRequestIdForItem,
  clearPendingUserMessageRequestIdsForTurn,
  consumePendingUserMessageRequestIdForItem,
  enqueuePendingUserMessageRequestIdForTurn,
  removePendingUserMessageRequestIdForTurn,
} from "../service/thread_user_message_request_store.js";
import {
  buildSharedThreadMounts,
  buildThreadContainerNames,
  resolveThreadDirectory,
  resolveThreadsRootDirectory,
  ThreadContainerService,
  type RuntimeAgentCliConfig,
  type ThreadAuthMode,
  type ThreadGitSkillConfig,
  type ThreadGitSkillPackageConfig,
} from "../service/thread_lifecycle.js";
import type { ReasoningEffort } from "../generated/codex-app-server/ReasoningEffort.js";
import type { ServerNotification } from "../generated/codex-app-server/ServerNotification.js";
import type { ThreadItem } from "../generated/codex-app-server/v2/ThreadItem.js";
import type { AskForApproval } from "../generated/codex-app-server/v2/AskForApproval.js";
import type { SandboxMode } from "../generated/codex-app-server/v2/SandboxMode.js";
import type { SandboxPolicy } from "../generated/codex-app-server/v2/SandboxPolicy.js";
import type { ThreadResumeParams } from "../generated/codex-app-server/v2/ThreadResumeParams.js";
import type { ThreadStartParams } from "../generated/codex-app-server/v2/ThreadStartParams.js";
import type { TurnStartParams } from "../generated/codex-app-server/v2/TurnStartParams.js";
import type { TurnSteerParams } from "../generated/codex-app-server/v2/TurnSteerParams.js";
import type { UserInput } from "../generated/codex-app-server/v2/UserInput.js";
import { claimCurrentDaemonState, clearCurrentDaemonState } from "../state/daemon_state.js";
import { initDb } from "../state/db.js";
import { agentSdks, llmModels, threads } from "../state/schema.js";
import { DAEMON_CHILD_ENV, DAEMON_LOG_PATH_ENV, resolveDaemonLogPath } from "../utils/daemon.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { expandHome } from "../utils/path.js";
import { containsCtrlCInterruptInput, restoreInteractiveTerminalState } from "../utils/terminal.js";
import { DaemonStartupWatchdog } from "../utils/daemon_startup_watchdog.js";
import { ThreadMetadataStore } from "../provisioning/host_provisioning/thread_metadata_store.js";
import {
  resolveThreadWorkspaceDirectory,
  ThreadWorkspaceProvisioner,
} from "../provisioning/host_provisioning/thread_workspace_provisioner.js";
import { buildCodexDeveloperInstructions } from "../provisioning/runtime_provisioning/system_prompt.js";
import { ensureRunnerStartupPreflight } from "../preflight/entrypoints.js";
import type { RunnerStartCommandOptions } from "./runner/common.js";
import {
  ensureCodexRunnerStartState,
  runCodexApiKeyAuth,
  runCodexDeviceCodeAuth,
} from "./sdk/codex/auth.js";

export type RootCommandOptions = RunnerStartCommandOptions;

const COMMAND_CHANNEL_CONNECT_RETRY_DELAY_MS = 1_000;
const COMMAND_CHANNEL_OPEN_TIMEOUT_MS = 5_000;
const TURN_COMPLETION_TIMEOUT_MS = 2 * 60 * 60_000;
const GITHUB_INSTALLATIONS_SYNC_INTERVAL_MS = 5 * 60_000;
const GITHUB_INSTALLATIONS_MIN_SYNC_INTERVAL_MS = 30_000;
const GITHUB_INSTALLATIONS_REFRESH_WINDOW_MS = 15 * 60_000;
const WORKSPACE_INSTALLATIONS_DIRECTORY = ".companyhelm";
const WORKSPACE_INSTALLATIONS_FILENAME = "installations.json";
const THREAD_GIT_SKILLS_CONFIG_FILENAME = "thread-git-skills.json";
const THREAD_MCP_CONFIG_FILENAME = "thread-mcp.json";
const THREAD_AGENT_CLI_CONFIG_FILENAME = "thread-agent-cli.json";
const THREAD_MCP_BEARER_TOKEN_ENV_PREFIX = "COMPANYHELM_MCP_TOKEN_";
const THREAD_MCP_AUTH_TYPE_BEARER_TOKEN = 2;
const THREAD_MCP_STARTUP_TIMEOUT_SECONDS = 60;
const YOLO_APPROVAL_POLICY: AskForApproval = "never";
const YOLO_SANDBOX_MODE: SandboxMode = "danger-full-access";
const YOLO_SANDBOX_POLICY: SandboxPolicy = { type: "dangerFullAccess" };
const DOCKER_INTERNAL_HOSTNAME = "host.docker.internal";
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
const DAEMON_STARTUP_TIMEOUT_MS = 60_000;

class RootCommandInterruptedError extends Error {
  constructor(message = "Root command interrupted.") {
    super(message);
    this.name = "RootCommandInterruptedError";
  }
}

interface ThreadAppServerSession {
  runtimeContainer: string;
  appServer: AppServerService;
  appServerEnv: Record<string, string>;
  sdkThreadId: string | null;
  rolloutPath: string | null;
  started: boolean;
}

interface RuntimeGithubInstallation {
  installationId: string;
  accessToken: string;
  accessTokenExpiresUnixTimeMs: string;
  accessTokenExpiration: string;
  repositories: string[];
}

interface WorkspaceGithubInstallationsPayload {
  synced_at: string;
  installations: Array<{
    installation_id: string;
    access_token: string;
    access_token_expires_unix_time_ms: string;
    access_token_expiration: string;
    repositories: string[];
  }>;
}

interface TrackedThreadRuntimeTarget {
  threadId: string;
  runtimeContainer: string;
  homeDirectory: string;
  uid: number;
  gid: number;
}

interface RootCommandRuntimeOptions {
  onDaemonReady?: () => void;
  onDaemonProgress?: (message: string) => void;
}

interface ThreadMcpHeaderConfig {
  key: string;
  value: string;
}

interface ThreadMcpServerConfig {
  name: string;
  transport: "stdio" | "streamable_http";
  command?: string;
  args: string[];
  envVars: ThreadMcpHeaderConfig[];
  url?: string;
  authType: "none" | "bearer_token";
  bearerToken?: string | null;
  headers: ThreadMcpHeaderConfig[];
}

interface ThreadCodexMcpSetup {
  configToml: string;
  appServerEnv: Record<string, string>;
}

interface RunnerRegistrationSdk {
  name: string;
  status: number;
  errorMessage?: string;
  models: Array<{ name: string; reasoning: string[] }>;
}

const threadAppServerSessions = new Map<string, ThreadAppServerSession>();
const threadRolloutPaths = new Map<string, string>();

function rememberThreadRolloutPath(threadId: string, rolloutPath: string | null | undefined): void {
  if (rolloutPath && rolloutPath.trim().length > 0) {
    threadRolloutPaths.set(threadId, rolloutPath);
  }
}

async function getOrCreateThreadAppServerSession(
  threadId: string,
  runtimeContainer: string,
  appServerEnv: Record<string, string>,
  clientName: string,
  logger: Logger,
): Promise<ThreadAppServerSession> {
  const existingSession = threadAppServerSessions.get(threadId);
  if (existingSession && existingSession.runtimeContainer === runtimeContainer) {
    return existingSession;
  }

  if (existingSession && existingSession.runtimeContainer !== runtimeContainer) {
    await stopThreadAppServerSession(threadId);
  }

  const appServer = new AppServerService(
    new RuntimeContainerAppServerTransport(runtimeContainer, undefined, appServerEnv),
    clientName,
    logger,
    () => ({
      threadId,
      sdkThreadId: threadAppServerSessions.get(threadId)?.sdkThreadId ?? null,
    }),
  );
  const newSession: ThreadAppServerSession = {
    runtimeContainer,
    appServer,
    appServerEnv,
    sdkThreadId: null,
    rolloutPath: threadRolloutPaths.get(threadId) ?? null,
    started: false,
  };

  threadAppServerSessions.set(threadId, newSession);
  return newSession;
}

async function ensureThreadAppServerSessionStarted(session: ThreadAppServerSession): Promise<void> {
  if (session.started) {
    return;
  }

  await session.appServer.start();
  session.started = true;
}

async function stopThreadAppServerSession(threadId: string): Promise<void> {
  const session = threadAppServerSessions.get(threadId);
  if (!session) {
    return;
  }

  threadAppServerSessions.delete(threadId);
  if (!session.started) {
    return;
  }

  await session.appServer.stop().catch(() => undefined);
  session.started = false;
}

async function stopAllThreadAppServerSessions(): Promise<void> {
  const threadIds = [...threadAppServerSessions.keys()];
  for (const threadId of threadIds) {
    await stopThreadAppServerSession(threadId);
  }
}

async function stopAllThreadContainers(cfg: Config, logger: Logger): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  let containers: Array<{ runtimeContainer: string; dindContainer: string | null }> = [];
  try {
    containers = await db
      .select({
        runtimeContainer: threads.runtimeContainer,
        dindContainer: threads.dindContainer,
      })
      .from(threads)
      .all();
  } finally {
    client.close();
  }

  const containerService = new ThreadContainerService();
  for (const container of containers) {
    await containerService.stopContainer(container.runtimeContainer).catch((error: unknown) => {
      logger.warn(`Failed to stop runtime container '${container.runtimeContainer}': ${toErrorMessage(error)}`);
    });
    if (container.dindContainer && container.dindContainer.trim().length > 0) {
      await containerService.stopContainer(container.dindContainer).catch((error: unknown) => {
        logger.warn(`Failed to stop DinD container '${container.dindContainer}': ${toErrorMessage(error)}`);
      });
    }
  }
}

async function reconcileTrackedRunningThreadsOnStartup(cfg: Config, logger: Logger): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  let runningThreads: Array<{
    id: string;
    sdkThreadId: string | null;
    currentSdkTurnId: string | null;
    runtimeContainer: string;
  }> = [];
  try {
    runningThreads = await db
      .select({
        id: threads.id,
        sdkThreadId: threads.sdkThreadId,
        currentSdkTurnId: threads.currentSdkTurnId,
        runtimeContainer: threads.runtimeContainer,
      })
      .from(threads)
      .where(eq(threads.isCurrentTurnRunning, true))
      .all();
  } finally {
    client.close();
  }

  if (runningThreads.length === 0) {
    return;
  }

  const containerService = new ThreadContainerService();
  for (const thread of runningThreads) {
    if (!thread.sdkThreadId || !thread.currentSdkTurnId) {
      await updateThreadTurnStateInDb(cfg.state_db_path, thread.id, {
        isCurrentTurnRunning: false,
      });
      logger.warn(
        `Cleared stale running state for thread '${thread.id}' during startup because the tracked SDK thread/turn identifiers were incomplete.`,
      );
      continue;
    }

    let runtimeRunning = false;
    try {
      runtimeRunning = await containerService.isContainerRunning(thread.runtimeContainer);
    } catch (error: unknown) {
      logger.warn(
        `Failed checking runtime container '${thread.runtimeContainer}' for thread '${thread.id}' during startup reconciliation: ${toErrorMessage(error)}`,
      );
      continue;
    }

    if (!runtimeRunning) {
      await updateThreadTurnStateInDb(cfg.state_db_path, thread.id, {
        isCurrentTurnRunning: false,
      });
      logger.info(
        `Cleared stale running state for thread '${thread.id}' during startup because runtime container '${thread.runtimeContainer}' is not running.`,
      );
    }
  }
}

const SUPPORTED_REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function normalizeReasoningLevels(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      return [];
    }
  }

  return [];
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatWorkspaceStartupMessage(
  cfg: Pick<Config, "config_directory" | "workspace_path" | "workspaces_directory" | "use_dedicated_workspaces">,
): string {
  if (cfg.use_dedicated_workspaces) {
    const workspacesDirectory = resolveThreadsRootDirectory(cfg.config_directory, cfg.workspaces_directory);
    return `Workspace modality: dedicated (workspaces dir: ${workspacesDirectory})`;
  }

  const workspaceDirectory = resolveThreadWorkspaceDirectory({
    configDirectory: cfg.config_directory,
    workspacesDirectory: cfg.workspaces_directory,
    workspacePath: cfg.workspace_path,
    useDedicatedWorkspaces: false,
    threadId: "startup",
  });
  return `Workspace modality: shared (workspace: ${workspaceDirectory})`;
}

function getGrpcStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };
  return typeof code === "number" ? code : undefined;
}

function getGrpcStatusName(error: unknown): string | undefined {
  const code = getGrpcStatusCode(error);
  if (code === undefined) {
    return undefined;
  }

  const statusName = (grpc.status as Record<number, unknown>)[code];
  return typeof statusName === "string" ? statusName : undefined;
}

export function isRetryableApiConnectionError(error: unknown): boolean {
  return getGrpcStatusCode(error) !== grpc.status.UNAUTHENTICATED;
}

function formatGrpcMetadataForLog(metadata: grpc.Metadata | undefined): string | undefined {
  if (!metadata) {
    return undefined;
  }

  const rawEntries = metadata.getMap();
  const entries = Object.entries(rawEntries);
  if (entries.length === 0) {
    return undefined;
  }

  const normalizedEntries = Object.fromEntries(entries.map(([key, value]) => [
    key,
    Buffer.isBuffer(value) ? value.toString("base64") : String(value),
  ]));
  return JSON.stringify(normalizedEntries);
}

export function formatApiConnectionFailureMessage(
  error: unknown,
  apiUrl: string,
  secret: string | undefined,
): string {
  const statusCode = getGrpcStatusCode(error);
  const statusName = getGrpcStatusName(error);
  const serviceError = isGrpcServiceError(error) ? error : undefined;
  const baseMessage = serviceError && typeof serviceError.details === "string" && serviceError.details.trim().length > 0
    ? serviceError.details.trim()
    : toErrorMessage(error);

  let message = baseMessage;
  if (statusCode !== undefined) {
    message = `gRPC ${statusName ?? "UNKNOWN"} (${statusCode}): ${baseMessage}`;
  }

  message += ` [endpoint=${apiUrl}]`;

  if (statusCode === grpc.status.UNAUTHENTICATED && (!secret || secret.trim().length === 0)) {
    message += " Provide --secret <secret> to authenticate.";
  }

  return message;
}

export function formatApiConnectionFailureDiagnostics(error: unknown): string | undefined {
  if (!isGrpcServiceError(error)) {
    return error instanceof Error && typeof error.stack === "string" ? error.stack : undefined;
  }

  const diagnostics: string[] = [];
  const statusCode = getGrpcStatusCode(error);
  const statusName = getGrpcStatusName(error);
  if (statusCode !== undefined) {
    diagnostics.push(`code=${statusCode}`);
  }
  if (statusName) {
    diagnostics.push(`status=${statusName}`);
  }
  if (typeof error.details === "string" && error.details.trim().length > 0) {
    diagnostics.push(`details=${JSON.stringify(error.details.trim())}`);
  }

  const metadata = formatGrpcMetadataForLog(error.metadata);
  if (metadata) {
    diagnostics.push(`metadata=${metadata}`);
  }

  if (typeof error.stack === "string" && error.stack.trim().length > 0) {
    diagnostics.push(`stack=${JSON.stringify(error.stack)}`);
  }

  return diagnostics.length > 0 ? diagnostics.join(" ") : undefined;
}

export function shouldUseTurnSteer(allowSteer: boolean, startedFromIdle: boolean): boolean {
  return allowSteer && !startedFromIdle;
}

export function isNoActiveTurnSteerError(error: unknown): boolean {
  return /no active turn to steer/i.test(toErrorMessage(error));
}

export function isNoRunningTurnInterruptError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return /no running turn to interrupt/i.test(message)
    || /thread .* is not running/i.test(message)
    || /thread .* already stopped/i.test(message);
}

function isTurnCompletionTimeoutError(error: unknown): boolean {
  return /timed out waiting for completion of turn/i.test(toErrorMessage(error));
}

interface ResolvedThreadNameUpdate {
  sdkThreadId: string;
  threadName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function rewriteLocalTargetForDockerRuntime(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.startsWith("[")) {
    const closingBracketIndex = trimmed.indexOf("]");
    if (closingBracketIndex > 0) {
      const host = trimmed.slice(1, closingBracketIndex).toLowerCase();
      if (LOCALHOST_HOSTNAMES.has(host)) {
        return `${DOCKER_INTERNAL_HOSTNAME}${trimmed.slice(closingBracketIndex + 1)}`;
      }
    }
    return trimmed;
  }

  const colonIndex = trimmed.indexOf(":");
  const host = (colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed).toLowerCase();
  if (!LOCALHOST_HOSTNAMES.has(host)) {
    return trimmed;
  }

  return `${DOCKER_INTERNAL_HOSTNAME}${colonIndex >= 0 ? trimmed.slice(colonIndex) : ""}`;
}

export function normalizeThreadAgentApiUrlForRuntime(agentApiUrl: string): string {
  const trimmed = agentApiUrl.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      if (LOCALHOST_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
        parsed.hostname = DOCKER_INTERNAL_HOSTNAME;
      }

      const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
      return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return trimmed;
    }
  }

  const firstSlashIndex = trimmed.indexOf("/");
  const target = firstSlashIndex >= 0 ? trimmed.slice(0, firstSlashIndex) : trimmed;
  const pathSuffix = firstSlashIndex >= 0 ? trimmed.slice(firstSlashIndex) : "";
  const rewrittenTarget = rewriteLocalTargetForDockerRuntime(target);
  if (rewrittenTarget !== target) {
    return `http://${rewrittenTarget}${pathSuffix}`;
  }
  return `${rewrittenTarget}${pathSuffix}`;
}

export function extractThreadNameUpdateFromNotification(
  notification: ServerNotification,
): ResolvedThreadNameUpdate | null {
  if (notification.method === "thread/name/updated") {
    const rawParams = notification.params as unknown as Record<string, unknown>;
    const sdkThreadId =
      normalizeNonEmptyString(rawParams.threadId) ??
      normalizeNonEmptyString(rawParams.thread_id) ??
      normalizeNonEmptyString(rawParams.conversationId) ??
      normalizeNonEmptyString(rawParams.conversation_id);
    if (!sdkThreadId) {
      return null;
    }

    return {
      sdkThreadId,
      threadName:
        normalizeNonEmptyString(rawParams.threadName) ??
        normalizeNonEmptyString(rawParams.thread_name),
    };
  }

  const rawNotification = notification as unknown as { method?: unknown; params?: unknown };
  if (rawNotification.method !== "codex/event/thread_name_updated") {
    return null;
  }

  if (!isRecord(rawNotification.params)) {
    return null;
  }

  const params = rawNotification.params;
  const msg = isRecord(params.msg) ? params.msg : undefined;
  const sdkThreadId =
    normalizeNonEmptyString(msg?.thread_id) ??
    normalizeNonEmptyString(msg?.threadId) ??
    normalizeNonEmptyString(params.threadId) ??
    normalizeNonEmptyString(params.thread_id) ??
    normalizeNonEmptyString(params.conversationId) ??
    normalizeNonEmptyString(params.conversation_id);
  if (!sdkThreadId) {
    return null;
  }

  const threadName =
    normalizeNonEmptyString(msg?.thread_name) ??
    normalizeNonEmptyString(msg?.threadName) ??
    normalizeNonEmptyString(params.threadName) ??
    normalizeNonEmptyString(params.thread_name);

  return { sdkThreadId, threadName };
}

function isGrpcServiceError(error: unknown): error is grpc.ServiceError {
  return Boolean(error && typeof error === "object" && "code" in error);
}

function isUnimplementedGrpcMethod(error: unknown): boolean {
  return isGrpcServiceError(error) && error.code === grpc.status.UNIMPLEMENTED;
}

function normalizeAccessTokenExpiration(accessTokenExpiresUnixTimeMs: bigint): {
  accessTokenExpiresUnixTimeMs: string;
  accessTokenExpiration: string;
} {
  const rawUnixTimeMs = Number(accessTokenExpiresUnixTimeMs);
  const expirationUnixTimeMs = Number.isFinite(rawUnixTimeMs) && rawUnixTimeMs > 0
    ? Math.floor(rawUnixTimeMs)
    : Date.now() + 60 * 60_000;

  return {
    accessTokenExpiresUnixTimeMs: expirationUnixTimeMs.toString(),
    accessTokenExpiration: new Date(expirationUnixTimeMs).toISOString(),
  };
}

async function loadRuntimeGithubInstallations(
  apiClient: CompanyhelmApiClient,
  options: CompanyhelmApiCallOptions | undefined,
  logger: Logger,
): Promise<RuntimeGithubInstallation[]> {
  let installationIds: bigint[] = [];
  try {
    const listResponse = await apiClient.listGithubInstallationsForRunner(options);
    installationIds = listResponse.installations.map((installation) => installation.installationId);
  } catch (error: unknown) {
    const warning = isUnimplementedGrpcMethod(error)
      ? "CompanyHelm API does not implement listGithubInstallationsForRunner yet."
      : `Failed to fetch GitHub installations: ${toErrorMessage(error)}`;
    logger.warn(warning);
    return [];
  }

  const installationDetails: RuntimeGithubInstallation[] = [];

  for (const installationId of installationIds) {
    try {
      const accessTokenResponse = await apiClient.getGithubInstallationAccessTokenForRunner(installationId, options);
      const accessToken = accessTokenResponse.accessToken.trim();
      if (!accessToken) {
        logger.warn(`Received empty GitHub access token for installation ${installationId.toString()}; skipping.`);
        continue;
      }

      const expiration = normalizeAccessTokenExpiration(accessTokenResponse.accessTokenExpiresUnixTimeMs);
      const repositories = [...new Set(accessTokenResponse.repositories.filter((repository) => repository.trim().length > 0))]
        .sort((left, right) => left.localeCompare(right));
      installationDetails.push({
        installationId: accessTokenResponse.installationId.toString(),
        accessToken,
        accessTokenExpiresUnixTimeMs: expiration.accessTokenExpiresUnixTimeMs,
        accessTokenExpiration: expiration.accessTokenExpiration,
        repositories,
      });
    } catch (error: unknown) {
      const warning = isUnimplementedGrpcMethod(error)
        ? "CompanyHelm API does not implement getGithubInstallationAccessTokenForRunner yet."
        : `Failed to fetch GitHub access token for installation ${installationId.toString()}: ${toErrorMessage(error)}`;
      logger.warn(warning);
    }
  }

  return installationDetails;
}

function buildWorkspaceGithubInstallationsPayload(
  installations: RuntimeGithubInstallation[],
): WorkspaceGithubInstallationsPayload {
  return {
    synced_at: new Date().toISOString(),
    installations: installations.map((installation) => ({
      installation_id: installation.installationId,
      access_token: installation.accessToken,
      access_token_expires_unix_time_ms: installation.accessTokenExpiresUnixTimeMs,
      access_token_expiration: installation.accessTokenExpiration,
      repositories: installation.repositories,
    })),
  };
}

function writeWorkspaceGithubInstallationsPayload(
  workspaceDirectory: string,
  payload: WorkspaceGithubInstallationsPayload,
  logger: Logger,
): void {
  const installationsDirectory = join(workspaceDirectory, WORKSPACE_INSTALLATIONS_DIRECTORY);
  const installationsPath = join(installationsDirectory, WORKSPACE_INSTALLATIONS_FILENAME);
  const temporaryPath = `${installationsPath}.tmp`;
  const serializedPayload = `${JSON.stringify(payload, null, 2)}\n`;

  try {
    mkdirSync(installationsDirectory, { recursive: true });
    writeFileSync(temporaryPath, serializedPayload, "utf8");
    renameSync(temporaryPath, installationsPath);
  } catch (error: unknown) {
    logger.warn(`Failed writing GitHub installations file for workspace '${workspaceDirectory}': ${toErrorMessage(error)}`);
  }
}

function isHttpsRepositoryUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeThreadGitSkillDirectoryPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("/")) {
    return null;
  }
  if (trimmed.includes("\\")) {
    return null;
  }

  const segments = trimmed.split("/").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  return segments.join("/");
}

function createThreadGitSkillLinkName(rawDirectoryPath: string): string {
  const fallback = "skill";
  const segments = rawDirectoryPath.split("/").filter((segment) => segment.length > 0);
  const lastPathSegment = segments.length > 0 ? segments[segments.length - 1] : fallback;
  const sanitized = lastPathSegment
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/^\.+/, "");
  return sanitized.length > 0 ? sanitized : fallback;
}

function createThreadGitSkillCheckoutDirectoryName(
  repositoryUrl: string,
  commitReference: string,
  index: number,
): string {
  const digest = createHash("sha256")
    .update(`${repositoryUrl}\n${commitReference}`)
    .digest("hex")
    .slice(0, 12);
  const repoPathPart = repositoryUrl
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .toLowerCase()
    .slice(0, 48) || "repo";
  return `${String(index + 1).padStart(2, "0")}-${repoPathPart}-${digest}`;
}

function normalizeThreadGitSkillPackagesForThreadConfig(
  rawPackages: CreateThreadRequest["gitSkillPackages"] | undefined,
  logger: Logger,
): ThreadGitSkillPackageConfig[] {
  if (!Array.isArray(rawPackages) || rawPackages.length === 0) {
    return [];
  }

  const normalizedPackages: ThreadGitSkillPackageConfig[] = [];
  const linkNameAllocations = new Map<string, number>();

  for (const [packageIndex, rawPackage] of rawPackages.entries()) {
    const repositoryUrl = normalizeNonEmptyString(rawPackage.repositoryUrl);
    const commitReference = normalizeNonEmptyString(rawPackage.commitReference);
    if (!repositoryUrl || !isHttpsRepositoryUrl(repositoryUrl)) {
      logger.warn(`Skipping thread git skill package at index ${packageIndex}: repositoryUrl must be an https URL.`);
      continue;
    }
    if (!commitReference) {
      logger.warn(`Skipping thread git skill package at index ${packageIndex}: commitReference is required.`);
      continue;
    }

    const rawSkills = Array.isArray(rawPackage.skills) ? rawPackage.skills : [];
    const skills: ThreadGitSkillConfig[] = [];

    for (const rawSkill of rawSkills) {
      const normalizedDirectoryPath = normalizeThreadGitSkillDirectoryPath(rawSkill.directoryPath ?? "");
      if (!normalizedDirectoryPath) {
        logger.warn(
          `Skipping thread git skill '${rawSkill.directoryPath ?? ""}' in package '${repositoryUrl}': invalid relative directory path.`,
        );
        continue;
      }

      const baseLinkName = createThreadGitSkillLinkName(normalizedDirectoryPath);
      const allocation = linkNameAllocations.get(baseLinkName) ?? 0;
      linkNameAllocations.set(baseLinkName, allocation + 1);
      const linkName = allocation === 0 ? baseLinkName : `${baseLinkName}-${allocation + 1}`;

      skills.push({
        directoryPath: normalizedDirectoryPath,
        linkName,
      });
    }

    if (skills.length === 0) {
      logger.warn(
        `Skipping thread git skill package '${repositoryUrl}@${commitReference}': no valid skill directory paths were provided.`,
      );
      continue;
    }

    normalizedPackages.push({
      repositoryUrl,
      commitReference,
      checkoutDirectoryName: createThreadGitSkillCheckoutDirectoryName(
        repositoryUrl,
        commitReference,
        normalizedPackages.length,
      ),
      skills,
    });
  }

  return normalizedPackages;
}

function normalizeThreadMcpHeaderEntries(
  rawEntries: Array<{ key?: string; value?: string }> | undefined,
  context: string,
  logger: Logger,
): ThreadMcpHeaderConfig[] {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    return [];
  }

  const seenKeys = new Set<string>();
  const normalizedEntries: ThreadMcpHeaderConfig[] = [];
  for (const rawEntry of rawEntries) {
    const key = normalizeNonEmptyString(rawEntry.key);
    if (!key) {
      logger.warn(`Skipping ${context} entry with empty key.`);
      continue;
    }

    const dedupeKey = key.toLowerCase();
    if (seenKeys.has(dedupeKey)) {
      logger.warn(`Skipping duplicate ${context} key '${key}'.`);
      continue;
    }
    seenKeys.add(dedupeKey);

    normalizedEntries.push({
      key,
      value: typeof rawEntry.value === "string" ? rawEntry.value : "",
    });
  }

  return normalizedEntries;
}

function normalizeThreadMcpServersForThreadConfig(
  rawServers: CreateThreadRequest["mcpServers"] | undefined,
  logger: Logger,
): ThreadMcpServerConfig[] {
  if (!Array.isArray(rawServers) || rawServers.length === 0) {
    return [];
  }

  const nameAllocations = new Map<string, number>();
  const normalizedServers: ThreadMcpServerConfig[] = [];

  for (const [serverIndex, rawServer] of rawServers.entries()) {
    const rawName = normalizeNonEmptyString(rawServer.name);
    if (!rawName) {
      logger.warn(`Skipping thread MCP server at index ${serverIndex}: name is required.`);
      continue;
    }

    const normalizedNameKey = rawName.toLowerCase();
    const allocation = nameAllocations.get(normalizedNameKey) ?? 0;
    nameAllocations.set(normalizedNameKey, allocation + 1);
    const resolvedName = allocation === 0 ? rawName : `${rawName}-${allocation + 1}`;
    if (resolvedName !== rawName) {
      logger.warn(`Renaming duplicate thread MCP server '${rawName}' to '${resolvedName}'.`);
    }

    if (rawServer.transportConfig.case === "stdio") {
      const command = normalizeNonEmptyString(rawServer.transportConfig.value.command);
      if (!command) {
        logger.warn(`Skipping thread MCP stdio server '${resolvedName}': command is required.`);
        continue;
      }

      const args = Array.isArray(rawServer.transportConfig.value.args)
        ? rawServer.transportConfig.value.args.filter((arg): arg is string => typeof arg === "string")
        : [];
      const envVars = normalizeThreadMcpHeaderEntries(
        rawServer.transportConfig.value.envVars,
        `thread MCP stdio env var for '${resolvedName}'`,
        logger,
      );

      normalizedServers.push({
        name: resolvedName,
        transport: "stdio",
        command,
        args,
        envVars,
        authType: "none",
        headers: [],
      });
      continue;
    }

    if (rawServer.transportConfig.case !== "streamableHttp") {
      logger.warn(`Skipping thread MCP server '${resolvedName}': transport is missing.`);
      continue;
    }

    const url = normalizeNonEmptyString(rawServer.transportConfig.value.url);
    if (!url) {
      logger.warn(`Skipping thread MCP streamable_http server '${resolvedName}': url is required.`);
      continue;
    }

    const authType = rawServer.transportConfig.value.authType === THREAD_MCP_AUTH_TYPE_BEARER_TOKEN
      ? "bearer_token"
      : "none";
    const bearerToken = authType === "bearer_token"
      ? normalizeNonEmptyString(rawServer.transportConfig.value.bearerToken)
      : null;
    if (authType === "bearer_token" && !bearerToken) {
      logger.warn(`Skipping thread MCP streamable_http server '${resolvedName}': bearer token is required.`);
      continue;
    }

    const headers = normalizeThreadMcpHeaderEntries(
      rawServer.transportConfig.value.headers,
      `thread MCP streamable_http header for '${resolvedName}'`,
      logger,
    );

    normalizedServers.push({
      name: resolvedName,
      transport: "streamable_http",
      args: [],
      envVars: [],
      url,
      authType,
      bearerToken,
      headers,
    });
  }

  return normalizedServers;
}

function resolveThreadMcpConfigPath(workspaceDirectory: string): string {
  return join(workspaceDirectory, WORKSPACE_INSTALLATIONS_DIRECTORY, THREAD_MCP_CONFIG_FILENAME);
}

function writeWorkspaceThreadMcpConfig(
  workspaceDirectory: string,
  mcpServers: ThreadMcpServerConfig[],
  logger: Logger,
): void {
  const configPath = resolveThreadMcpConfigPath(workspaceDirectory);
  const configDirectory = join(workspaceDirectory, WORKSPACE_INSTALLATIONS_DIRECTORY);
  const temporaryPath = `${configPath}.tmp`;

  try {
    mkdirSync(configDirectory, { recursive: true });
    if (mcpServers.length === 0) {
      rmSync(configPath, { force: true });
      rmSync(temporaryPath, { force: true });
      return;
    }

    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ servers: mcpServers }, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, configPath);
  } catch (error: unknown) {
    logger.warn(`Failed writing thread MCP config for workspace '${workspaceDirectory}': ${toErrorMessage(error)}`);
  }
}

function parseThreadMcpConfig(content: unknown): ThreadMcpServerConfig[] | null {
  if (!isRecord(content) || !Array.isArray(content.servers)) {
    return null;
  }

  const parsedServers: ThreadMcpServerConfig[] = [];
  for (const rawServer of content.servers) {
    if (!isRecord(rawServer)) {
      return null;
    }

    const name = normalizeNonEmptyString(rawServer.name);
    const transport = rawServer.transport;
    const authType = rawServer.authType;
    if (
      !name ||
      (transport !== "stdio" && transport !== "streamable_http") ||
      (authType !== "none" && authType !== "bearer_token")
    ) {
      return null;
    }

    const args = Array.isArray(rawServer.args) && rawServer.args.every((arg) => typeof arg === "string")
      ? rawServer.args as string[]
      : [];
    const envVars = Array.isArray(rawServer.envVars)
      ? rawServer.envVars
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => ({
          key: normalizeNonEmptyString(entry.key) ?? "",
          value: typeof entry.value === "string" ? entry.value : "",
        }))
        .filter((entry) => entry.key.length > 0)
      : [];
    const headers = Array.isArray(rawServer.headers)
      ? rawServer.headers
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => ({
          key: normalizeNonEmptyString(entry.key) ?? "",
          value: typeof entry.value === "string" ? entry.value : "",
        }))
        .filter((entry) => entry.key.length > 0)
      : [];

    if (transport === "stdio") {
      const command = normalizeNonEmptyString(rawServer.command);
      if (!command) {
        return null;
      }

      parsedServers.push({
        name,
        transport,
        command,
        args,
        envVars,
        authType,
        headers: [],
      });
      continue;
    }

    const url = normalizeNonEmptyString(rawServer.url);
    const bearerToken = authType === "bearer_token"
      ? normalizeNonEmptyString(rawServer.bearerToken)
      : null;
    if (!url) {
      return null;
    }
    if (authType === "bearer_token" && !bearerToken) {
      return null;
    }

    parsedServers.push({
      name,
      transport,
      args: [],
      envVars: [],
      url,
      authType,
      bearerToken,
      headers,
    });
  }

  return parsedServers;
}

function readWorkspaceThreadMcpConfig(workspaceDirectory: string, logger: Logger): ThreadMcpServerConfig[] {
  const configPath = resolveThreadMcpConfigPath(workspaceDirectory);
  try {
    const rawContent = readFileSync(configPath, "utf8");
    const parsedContent = JSON.parse(rawContent) as unknown;
    const parsedConfig = parseThreadMcpConfig(parsedContent);
    if (!parsedConfig) {
      logger.warn(`Thread MCP config has invalid shape at '${configPath}'.`);
      return [];
    }
    return parsedConfig;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return [];
    }
    logger.warn(`Failed reading thread MCP config at '${configPath}': ${toErrorMessage(error)}`);
    return [];
  }
}

function resolveThreadAgentCliConfigPath(workspaceDirectory: string): string {
  return join(workspaceDirectory, WORKSPACE_INSTALLATIONS_DIRECTORY, THREAD_AGENT_CLI_CONFIG_FILENAME);
}

function parseThreadAgentCliConfig(content: unknown): RuntimeAgentCliConfig | null {
  if (!isRecord(content)) {
    return null;
  }

  const agentApiUrl = normalizeNonEmptyString(content.agent_api_url);
  const token = normalizeNonEmptyString(content.token);
  if (!agentApiUrl || !token) {
    return null;
  }

  return {
    agent_api_url: agentApiUrl,
    token,
  };
}

function writeWorkspaceThreadAgentCliConfig(
  workspaceDirectory: string,
  cliSecret: string,
  agentApiUrl: string,
  logger: Logger,
): void {
  const configPath = resolveThreadAgentCliConfigPath(workspaceDirectory);
  const configDirectory = join(workspaceDirectory, WORKSPACE_INSTALLATIONS_DIRECTORY);
  const temporaryPath = `${configPath}.tmp`;

  try {
    mkdirSync(configDirectory, { recursive: true });
    if (cliSecret.length === 0) {
      rmSync(configPath, { force: true });
      rmSync(temporaryPath, { force: true });
      return;
    }

    const payload: RuntimeAgentCliConfig = {
      agent_api_url: normalizeThreadAgentApiUrlForRuntime(agentApiUrl),
      token: cliSecret,
    };
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, configPath);
  } catch (error: unknown) {
    logger.warn(`Failed writing thread agent CLI config for workspace '${workspaceDirectory}': ${toErrorMessage(error)}`);
  }
}

function readWorkspaceThreadAgentCliConfig(
  workspaceDirectory: string,
  logger: Logger,
): RuntimeAgentCliConfig | null {
  const configPath = resolveThreadAgentCliConfigPath(workspaceDirectory);
  try {
    const rawContent = readFileSync(configPath, "utf8");
    const parsedContent = JSON.parse(rawContent) as unknown;
    const parsedConfig = parseThreadAgentCliConfig(parsedContent);
    if (!parsedConfig) {
      logger.warn(`Thread agent CLI config has invalid shape at '${configPath}'.`);
      return null;
    }
    return parsedConfig;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return null;
    }
    logger.warn(`Failed reading thread agent CLI config at '${configPath}': ${toErrorMessage(error)}`);
    return null;
  }
}

function escapeTomlString(value: string): string {
  return JSON.stringify(value);
}

function formatTomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : escapeTomlString(value);
}

function buildThreadMcpBearerTokenEnvVarName(serverName: string, serverIndex: number): string {
  const normalized = serverName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  const suffix = normalized.length > 0 ? normalized : `SERVER_${serverIndex + 1}`;
  return `${THREAD_MCP_BEARER_TOKEN_ENV_PREFIX}${suffix}`;
}

function buildThreadCodexMcpSetup(mcpServers: ThreadMcpServerConfig[]): ThreadCodexMcpSetup {
  const lines = [
    "# Generated by CompanyHelm. Thread-scoped MCP server configuration for Codex.",
  ];
  const appServerEnv: Record<string, string> = {};

  for (const [serverIndex, server] of mcpServers.entries()) {
    const serverTableName = escapeTomlString(server.name);
    lines.push("", `[mcp_servers.${serverTableName}]`);
    lines.push(`startup_timeout_sec = ${THREAD_MCP_STARTUP_TIMEOUT_SECONDS}`);

    if (server.transport === "stdio") {
      lines.push(`command = ${escapeTomlString(server.command ?? "")}`);
      if (server.args.length > 0) {
        lines.push(`args = [${server.args.map((arg) => escapeTomlString(arg)).join(", ")}]`);
      }
      if (server.envVars.length > 0) {
        lines.push("", `[mcp_servers.${serverTableName}.env]`);
        for (const envVar of server.envVars) {
          lines.push(`${formatTomlKey(envVar.key)} = ${escapeTomlString(envVar.value)}`);
        }
      }
      continue;
    }

    lines.push(`url = ${escapeTomlString(server.url ?? "")}`);
    if (server.authType === "bearer_token" && server.bearerToken) {
      const envVarName = buildThreadMcpBearerTokenEnvVarName(server.name, serverIndex);
      lines.push(`bearer_token_env_var = ${escapeTomlString(envVarName)}`);
      appServerEnv[envVarName] = server.bearerToken;
    }
    if (server.headers.length > 0) {
      const renderedHeaders = server.headers
        .map((header) => `${formatTomlKey(header.key)} = ${escapeTomlString(header.value)}`)
        .join(", ");
      lines.push(`http_headers = { ${renderedHeaders} }`);
    }
  }

  return {
    configToml: `${lines.join("\n").trimEnd()}\n`,
    appServerEnv,
  };
}

function resolveThreadGitSkillsConfigPath(workspaceDirectory: string): string {
  return join(workspaceDirectory, WORKSPACE_INSTALLATIONS_DIRECTORY, THREAD_GIT_SKILLS_CONFIG_FILENAME);
}

function writeWorkspaceThreadGitSkillsConfig(
  workspaceDirectory: string,
  gitSkillPackages: ThreadGitSkillPackageConfig[],
  logger: Logger,
): void {
  const configPath = resolveThreadGitSkillsConfigPath(workspaceDirectory);
  const configDirectory = join(workspaceDirectory, WORKSPACE_INSTALLATIONS_DIRECTORY);
  const temporaryPath = `${configPath}.tmp`;

  try {
    mkdirSync(configDirectory, { recursive: true });
    if (gitSkillPackages.length === 0) {
      rmSync(configPath, { force: true });
      rmSync(temporaryPath, { force: true });
      return;
    }

    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ packages: gitSkillPackages }, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, configPath);
  } catch (error: unknown) {
    logger.warn(`Failed writing thread git skills config for workspace '${workspaceDirectory}': ${toErrorMessage(error)}`);
  }
}

function parseThreadGitSkillsConfig(content: unknown): ThreadGitSkillPackageConfig[] | null {
  if (!isRecord(content) || !Array.isArray(content.packages)) {
    return null;
  }

  const parsedPackages: ThreadGitSkillPackageConfig[] = [];

  for (const rawPackage of content.packages) {
    if (!isRecord(rawPackage)) {
      return null;
    }

    const repositoryUrl = normalizeNonEmptyString(rawPackage.repositoryUrl);
    const commitReference = normalizeNonEmptyString(rawPackage.commitReference);
    const checkoutDirectoryName = normalizeNonEmptyString(rawPackage.checkoutDirectoryName);
    const rawSkills = rawPackage.skills;
    if (
      !repositoryUrl ||
      !isHttpsRepositoryUrl(repositoryUrl) ||
      !commitReference ||
      !checkoutDirectoryName ||
      checkoutDirectoryName.includes("/") ||
      checkoutDirectoryName.includes("\\") ||
      !Array.isArray(rawSkills)
    ) {
      return null;
    }

    const parsedSkills: ThreadGitSkillConfig[] = [];
    for (const rawSkill of rawSkills) {
      if (!isRecord(rawSkill)) {
        return null;
      }
      const directoryPath = normalizeThreadGitSkillDirectoryPath(normalizeNonEmptyString(rawSkill.directoryPath) ?? "");
      const linkName = normalizeNonEmptyString(rawSkill.linkName);
      if (
        !directoryPath ||
        !linkName ||
        linkName.includes("/") ||
        linkName.includes("\\") ||
        linkName.trim().length === 0 ||
        linkName.trim() === "." ||
        linkName.trim() === ".."
      ) {
        return null;
      }
      parsedSkills.push({ directoryPath, linkName });
    }

    if (parsedSkills.length === 0) {
      continue;
    }

    parsedPackages.push({
      repositoryUrl,
      commitReference,
      checkoutDirectoryName,
      skills: parsedSkills,
    });
  }

  return parsedPackages;
}

function readWorkspaceThreadGitSkillsConfig(workspaceDirectory: string, logger: Logger): ThreadGitSkillPackageConfig[] {
  const configPath = resolveThreadGitSkillsConfigPath(workspaceDirectory);

  try {
    const rawContent = readFileSync(configPath, "utf8");
    const parsedContent = JSON.parse(rawContent) as unknown;
    const parsedPackages = parseThreadGitSkillsConfig(parsedContent);
    if (!parsedPackages) {
      logger.warn(`Thread git skills config has invalid shape at '${configPath}'.`);
      return [];
    }
    return parsedPackages;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return [];
    }
    logger.warn(`Failed reading thread git skills config at '${configPath}': ${toErrorMessage(error)}`);
    return [];
  }
}

async function ensureThreadGitSkillsInRuntime(
  cfg: Config,
  threadState: ThreadMessageExecutionState,
  containerService: ThreadContainerService,
  logger: Logger,
): Promise<void> {
  const packages = new ThreadMetadataStore(cfg.config_directory, logger).readThreadGitSkillsConfig(threadState.id);
  if (packages.length === 0) {
    return;
  }

  await containerService.ensureRuntimeContainerThreadGitSkills(
    threadState.runtimeContainer,
    {
      uid: threadState.uid,
      gid: threadState.gid,
      agentUser: cfg.agent_user,
      agentHomeDirectory: threadState.homeDirectory,
    },
    {
      cloneRootDirectory: cfg.thread_git_skills_directory,
      packages,
    },
  );
}

function buildThreadRuntimeUser(cfg: Config, threadState: ThreadMessageExecutionState): {
  uid: number;
  gid: number;
  agentUser: string;
  agentHomeDirectory: string;
} {
  return {
    uid: threadState.uid,
    gid: threadState.gid,
    agentUser: cfg.agent_user,
    agentHomeDirectory: threadState.homeDirectory,
  };
}

async function reconcileThreadRunningStateBeforeUserMessage(
  cfg: Config,
  threadState: ThreadMessageExecutionState,
  logger: Logger,
): Promise<ThreadMessageExecutionState> {
  if (!threadState.isCurrentTurnRunning) {
    return threadState;
  }

  if (!threadState.sdkThreadId || !threadState.currentSdkTurnId) {
    await updateThreadTurnState(cfg, threadState.id, {
      isCurrentTurnRunning: false,
    });
    logger.warn(
      `Cleared stale running state for thread '${threadState.id}' before user message handling because the tracked SDK thread/turn identifiers were incomplete.`,
    );
    return {
      ...threadState,
      isCurrentTurnRunning: false,
    };
  }

  const containerService = new ThreadContainerService();
  if (!(await containerService.isContainerRunning(threadState.runtimeContainer))) {
    await stopThreadAppServerSession(threadState.id);
    await updateThreadTurnState(cfg, threadState.id, {
      isCurrentTurnRunning: false,
    });
    logger.info(
      `Cleared stale running state for thread '${threadState.id}' before user message handling because runtime container '${threadState.runtimeContainer}' is not running.`,
    );
    return {
      ...threadState,
      isCurrentTurnRunning: false,
    };
  }

  const metadataStore = new ThreadMetadataStore(cfg.config_directory, logger);
  const persistedThreadMcpServers = metadataStore.readThreadMcpConfig(threadState.id);
  const persistedThreadGitSkillPackages = metadataStore.readThreadGitSkillsConfig(threadState.id);
  const threadMcpSetup = buildThreadCodexMcpSetup(persistedThreadMcpServers);
  const threadAgentCliConfig = buildThreadAgentCliConfig(threadState.cliSecret, cfg.agent_api_url);
  const appServerSession = await getOrCreateThreadAppServerSession(
    threadState.id,
    threadState.runtimeContainer,
    threadMcpSetup.appServerEnv,
    cfg.codex.app_server_client_name,
    logger,
  );
  const runtimeUser = buildThreadRuntimeUser(cfg, threadState);

  await ensureThreadRuntimeReady({
    dindContainer: threadState.dindContainer,
    runtimeContainer: threadState.runtimeContainer,
    containerService,
    gitUserName: cfg.git_user_name,
    gitUserEmail: cfg.git_user_email,
    user: runtimeUser,
  });
  await ensureThreadGitSkillsInRuntime(cfg, threadState, containerService, logger);
  await containerService.ensureRuntimeContainerThreadMetadata(
    threadState.runtimeContainer,
    runtimeUser,
    {
      mcpServers: persistedThreadMcpServers,
      gitSkillPackages: persistedThreadGitSkillPackages,
      threadAgentCliConfig,
    },
  );
  if (threadAgentCliConfig) {
    await containerService.ensureRuntimeContainerAgentCliConfig(
      threadState.runtimeContainer,
      runtimeUser,
      threadAgentCliConfig,
    );
  }
  if (!appServerSession.started) {
    await containerService.ensureRuntimeContainerCodexConfig(
      threadState.runtimeContainer,
      runtimeUser,
      threadMcpSetup.configToml,
    );
  }

  await ensureThreadAppServerSessionStarted(appServerSession);

  const resumeResult = await appServerSession.appServer.resumeThread({
    threadId: threadState.sdkThreadId,
    approvalPolicy: YOLO_APPROVAL_POLICY,
    sandbox: YOLO_SANDBOX_MODE,
    persistExtendedHistory: true,
  });
  appServerSession.sdkThreadId = resumeResult.thread.id;
  appServerSession.rolloutPath = resumeResult.thread.path;
  rememberThreadRolloutPath(threadState.id, resumeResult.thread.path);

  const trackedTurn = resumeResult.thread.turns.find((turn) => turn.id === threadState.currentSdkTurnId);
  if (trackedTurn?.status === "inProgress") {
    return {
      ...threadState,
      sdkThreadId: resumeResult.thread.id,
    };
  }

  await updateThreadTurnState(cfg, threadState.id, {
    sdkThreadId: resumeResult.thread.id,
    isCurrentTurnRunning: false,
  });
  logger.info(
    `Cleared stale running state for thread '${threadState.id}' before user message handling because SDK turn '${threadState.currentSdkTurnId}' is no longer in progress.`,
  );
  return {
    ...threadState,
    sdkThreadId: resumeResult.thread.id,
    isCurrentTurnRunning: false,
  };
}

async function listTrackedThreadRuntimeTargets(cfg: Config, logger: Logger): Promise<TrackedThreadRuntimeTarget[]> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    return await db
      .select({
        threadId: threads.id,
        runtimeContainer: threads.runtimeContainer,
        homeDirectory: threads.homeDirectory,
        uid: threads.uid,
        gid: threads.gid,
      })
      .from(threads)
      .all();
  } catch (error: unknown) {
    logger.warn(`Failed to list tracked thread runtimes for GitHub installation sync: ${toErrorMessage(error)}`);
    return [];
  } finally {
    client.close();
  }
}

function resolveGithubInstallationsSyncDelayMs(installations: RuntimeGithubInstallation[]): number {
  let syncDelayMs = GITHUB_INSTALLATIONS_SYNC_INTERVAL_MS;
  const now = Date.now();

  for (const installation of installations) {
    const expirationUnixTimeMs = Number(installation.accessTokenExpiresUnixTimeMs);
    if (!Number.isFinite(expirationUnixTimeMs) || expirationUnixTimeMs <= 0) {
      continue;
    }

    const refreshInMs = expirationUnixTimeMs - now - GITHUB_INSTALLATIONS_REFRESH_WINDOW_MS;
    const boundedRefreshDelayMs = Math.max(
      GITHUB_INSTALLATIONS_MIN_SYNC_INTERVAL_MS,
      Math.min(GITHUB_INSTALLATIONS_SYNC_INTERVAL_MS, refreshInMs),
    );
    syncDelayMs = Math.min(syncDelayMs, boundedRefreshDelayMs);
  }

  return Math.max(
    GITHUB_INSTALLATIONS_MIN_SYNC_INTERVAL_MS,
    Math.min(GITHUB_INSTALLATIONS_SYNC_INTERVAL_MS, syncDelayMs),
  );
}

async function syncGithubInstallationsForRuntimeTargets(
  cfg: Config,
  apiClient: CompanyhelmApiClient,
  options: CompanyhelmApiCallOptions | undefined,
  runtimeTargets: TrackedThreadRuntimeTarget[],
  logger: Logger,
): Promise<RuntimeGithubInstallation[]> {
  const uniqueTargets = [
    ...new Map(
      runtimeTargets
        .filter((target) => target.runtimeContainer.trim().length > 0)
        .map((target) => [target.runtimeContainer, target] as const),
    ).values(),
  ];
  if (uniqueTargets.length === 0) {
    return [];
  }

  const installations = await loadRuntimeGithubInstallations(apiClient, options, logger);
  const payload = buildWorkspaceGithubInstallationsPayload(installations);
  const containerService = new ThreadContainerService();

  for (const target of uniqueTargets) {
    try {
      if (!await containerService.isContainerRunning(target.runtimeContainer)) {
        continue;
      }

      await containerService.ensureRuntimeContainerGithubInstallations(
        target.runtimeContainer,
        {
          uid: target.uid,
          gid: target.gid,
          agentUser: cfg.agent_user,
          agentHomeDirectory: target.homeDirectory,
        },
        payload,
      );
    } catch (error: unknown) {
      logger.warn(
        `Failed syncing GitHub installations into runtime container '${target.runtimeContainer}': ${toErrorMessage(error)}`,
      );
    }
  }

  logger.debug(
    `Synced ${installations.length} GitHub installation token(s) to ${uniqueTargets.length} runtime container(s).`,
  );
  return installations;
}

async function waitForAbort(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    function handleAbort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }

    signal.addEventListener("abort", handleAbort);
  });
}

async function runGithubInstallationsSyncLoop(
  cfg: Config,
  apiClient: CompanyhelmApiClient,
  options: CompanyhelmApiCallOptions | undefined,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let nextDelayMs = GITHUB_INSTALLATIONS_SYNC_INTERVAL_MS;
    try {
      const runtimeTargets = await listTrackedThreadRuntimeTargets(cfg, logger);
      const installations = await syncGithubInstallationsForRuntimeTargets(
        cfg,
        apiClient,
        options,
        runtimeTargets,
        logger,
      );
      nextDelayMs = resolveGithubInstallationsSyncDelayMs(installations);
    } catch (error: unknown) {
      logger.warn(`GitHub installation sync loop iteration failed: ${toErrorMessage(error)}`);
      nextDelayMs = GITHUB_INSTALLATIONS_MIN_SYNC_INTERVAL_MS;
    }

    await waitForAbort(signal, nextDelayMs);
  }
}

function normalizeReasoningEffort(value: string | undefined): ReasoningEffort | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase() as ReasoningEffort;
  if (!SUPPORTED_REASONING_EFFORTS.has(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeAdditionalModelInstructions(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildThreadAgentCliConfig(
  cliSecret: string | null | undefined,
  agentApiUrl: string,
): RuntimeAgentCliConfig | null {
  const normalizedSecret = normalizeNonEmptyString(cliSecret);
  if (!normalizedSecret) {
    return null;
  }

  return {
    agent_api_url: normalizeThreadAgentApiUrlForRuntime(agentApiUrl),
    token: normalizedSecret,
  };
}

function buildThreadDeveloperInstructions(
  threadId: string,
  cfg: Config,
  additionalModelInstructions: string | null | undefined,
  cliSecret: string | null | undefined,
): string {
  return buildCodexDeveloperInstructions(additionalModelInstructions, {
    homeDirectory: cfg.agent_home_directory,
    agentApiUrl: normalizeThreadAgentApiUrlForRuntime(cfg.agent_api_url),
    agentToken: normalizeNonEmptyString(cliSecret) ?? "<thread-secret>",
    threadId,
    workspaceMode: cfg.use_dedicated_workspaces ? "dedicated" : "shared",
  });
}

function buildUserTextInput(text: string): UserInput[] {
  return [
    {
      type: "text",
      text,
      text_elements: [],
    },
  ];
}

function truncateSummary(text: string, maxLength = 240): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeUserInput(input: UserInput): string {
  switch (input.type) {
    case "text":
      return input.text.trim();
    case "image":
      return `[image] ${input.url}`;
    case "localImage":
      return `[local image] ${input.path}`;
    case "skill":
      return `[skill] ${input.name} (${input.path})`;
    case "mention":
      return `[mention] ${input.name} (${input.path})`;
    default:
      return "";
  }
}

function summarizeWebSearchItem(item: Extract<ThreadItem, { type: "webSearch" }>): string {
  if (!item.action) {
    return `Web search: ${truncateSummary(item.query, 180)}`;
  }

  switch (item.action.type) {
    case "search": {
      const query = item.action.query?.trim()
        || item.action.queries?.map((entry) => entry.trim()).filter((entry) => entry.length > 0).join(", ")
        || item.query;
      return `Web search: ${truncateSummary(query, 180)}`;
    }
    case "openPage":
      return item.action.url ? `Opened web page: ${item.action.url}` : "Opened web page";
    case "findInPage": {
      const target = item.action.url ? ` in ${item.action.url}` : "";
      const pattern = item.action.pattern?.trim();
      if (!pattern) {
        return `Find in page${target}`;
      }
      return `Find in page${target}: ${truncateSummary(pattern, 140)}`;
    }
    case "other":
    default:
      return `Web search action: ${truncateSummary(item.query, 180)}`;
  }
}

function mapThreadItemType(item: ThreadItem): ItemType {
  switch (item.type) {
    case "userMessage":
      return ItemType.USER_MESSAGE;
    case "agentMessage":
      return ItemType.AGENT_MESSAGE;
    case "plan":
      return ItemType.PLAN;
    case "reasoning":
      return ItemType.REASONING;
    case "commandExecution":
      return ItemType.COMMAND_EXECUTION;
    case "fileChange":
      return ItemType.FILE_CHANGE;
    case "mcpToolCall":
      return ItemType.MCP_TOOL_CALL;
    case "collabAgentToolCall":
      return ItemType.COLLAB_AGENT_TOOL_CALL;
    case "webSearch":
      return ItemType.WEB_SEARCH;
    case "imageView":
      return ItemType.IMAGE_VIEW;
    case "enteredReviewMode":
      return ItemType.ENTERED_REVIEW_MODE;
    case "exitedReviewMode":
      return ItemType.EXITED_REVIEW_MODE;
    case "contextCompaction":
      return ItemType.CONTEXT_COMPACTION;
    default:
      return ItemType.ITEM_TYPE_UNKNOWN;
  }
}

function summarizeThreadItemText(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "userMessage": {
      const summarizedInputs = item.content
        .map((input) => summarizeUserInput(input))
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (summarizedInputs.length === 0) {
        return "User message";
      }
      return truncateSummary(summarizedInputs.join("\n"), 800);
    }
    case "agentMessage":
      return item.text.trim() || "Agent message";
    case "plan":
      return item.text.trim() || "Plan update";
    case "reasoning": {
      const summary = item.summary.join("\n").trim();
      if (summary) {
        return truncateSummary(summary, 800);
      }
      const reasoningContent = item.content.join("\n").trim();
      return reasoningContent ? truncateSummary(reasoningContent, 800) : "Reasoning update";
    }
    case "commandExecution":
      return item.command.trim() || "Command execution";
    case "fileChange": {
      const changedPaths = item.changes
        .map((change) => String(change.path || "").trim())
        .filter((path) => path.length > 0);
      if (changedPaths.length === 0) {
        return `File change (${item.status})`;
      }
      const preview = changedPaths.slice(0, 3).join(", ");
      const suffix = changedPaths.length > 3 ? ", ..." : "";
      const noun = changedPaths.length === 1 ? "file" : "files";
      return `File change (${item.status}): ${changedPaths.length} ${noun} (${preview}${suffix})`;
    }
    case "mcpToolCall": {
      const base = `MCP ${item.server}/${item.tool} (${item.status})`;
      if (item.error?.message) {
        return `${base}: ${truncateSummary(item.error.message, 140)}`;
      }
      if (item.status === "completed") {
        return `${base}: completed`;
      }
      return base;
    }
    case "collabAgentToolCall": {
      const receiverCount = item.receiverThreadIds.length;
      const receiverLabel = receiverCount === 1 ? "1 receiver" : `${receiverCount} receivers`;
      const prompt = item.prompt?.trim();
      if (prompt) {
        return `Collab ${item.tool} (${item.status}, ${receiverLabel}): ${truncateSummary(prompt, 140)}`;
      }
      return `Collab ${item.tool} (${item.status}, ${receiverLabel})`;
    }
    case "webSearch":
      return summarizeWebSearchItem(item);
    case "imageView":
      return item.path.trim() ? `Viewed image: ${item.path}` : "Viewed image";
    case "enteredReviewMode":
      return item.review.trim() ? `Entered review mode: ${truncateSummary(item.review, 180)}` : "Entered review mode";
    case "exitedReviewMode":
      return item.review.trim() ? `Exited review mode: ${truncateSummary(item.review, 180)}` : "Exited review mode";
    case "contextCompaction":
      return "Context compaction";
    default:
      return undefined;
  }
}

function buildCommandExecutionItem(item: ThreadItem):
  | {
      command: string;
      cwd: string;
      processId: string;
      output?: string;
    }
  | undefined {
  if (item.type !== "commandExecution") {
    return undefined;
  }

  return {
    command: item.command,
    cwd: item.cwd,
    processId: item.processId ?? "unknown",
    output: item.aggregatedOutput ?? undefined,
  };
}

function removeWorkspaceDirectory(workspacePath: string): void {
  rmSync(workspacePath, { recursive: true, force: true });
}

async function sendRequestError(
  commandChannel: ClientMessageSink,
  errorMessage: string,
  requestId?: string,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    requestId,
    payload: {
      case: "requestError",
      value: {
        errorMessage,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendHeartbeatResponse(
  commandChannel: ClientMessageSink,
  requestId?: string,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    requestId,
    payload: {
      case: "heartbeatResponse",
      value: {},
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendCodexDeviceCode(
  commandChannel: ClientMessageSink,
  deviceCode: string,
  requestId?: string,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    requestId,
    payload: {
      case: "codexDeviceCode",
      value: {
        deviceCode,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendAgentSdkUpdate(
  commandChannel: ClientMessageSink,
  sdk: AgentSdk,
  requestId?: string,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    requestId,
    payload: {
      case: "agentSdkUpdate",
      value: sdk,
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendThreadUpdate(
  commandChannel: ClientMessageSink,
  threadId: string,
  status: ThreadStatus,
  requestId?: string,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    requestId,
    payload: {
      case: "threadUpdate",
      value: {
        threadId,
        status,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendThreadNameUpdate(
  commandChannel: ClientMessageSink,
  threadId: string,
  threadName?: string,
): Promise<void> {
  const normalizedThreadName = typeof threadName === "string"
    ? threadName.trim() || undefined
    : undefined;
  const message = create(ClientMessageSchema, {
    payload: {
      case: "threadNameUpdate",
      value: {
        threadId,
        threadName: normalizedThreadName,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendTurnExecutionUpdate(
  commandChannel: ClientMessageSink,
  threadId: string,
  sdkTurnId: string,
  status: TurnStatus,
  requestId?: string,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    requestId,
    payload: {
      case: "turnUpdate",
      value: {
        threadId,
        sdkTurnId,
        status,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendItemExecutionUpdate(
  commandChannel: ClientMessageSink,
  threadId: string,
  sdkTurnId: string,
  sdkItemId: string,
  status: ItemStatus,
  item: ThreadItem,
  requestId?: string,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    requestId,
    payload: {
      case: "itemUpdate",
      value: {
        sdkItemId,
        status,
        itemType: mapThreadItemType(item),
        text: summarizeThreadItemText(item),
        commandExecutionItem: buildCommandExecutionItem(item),
        threadId,
        sdkTurnId,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function loadRunnerRegistrationSdks(cfg: Config, logger: Logger): Promise<RunnerRegistrationSdk[]> {
  const { db, client } = await initDb(cfg.state_db_path);

  try {
    const configuredSdks = await db.select().from(agentSdks).orderBy(agentSdks.name).all();
    if (configuredSdks.length === 0) {
      return [];
    }

    const models = await db.select().from(llmModels).orderBy(llmModels.sdkName, llmModels.name).all();
    const modelsBySdk = new Map<string, Array<{ name: string; reasoning: string[] }>>();

    for (const model of models) {
      const sdkModels = modelsBySdk.get(model.sdkName) ?? [];
      sdkModels.push({
        name: model.name,
        reasoning: normalizeReasoningLevels(model.reasoningLevels),
      });
      modelsBySdk.set(model.sdkName, sdkModels);
    }

    return configuredSdks.map((sdk) => {
      if (sdk.name !== "codex") {
        return {
          name: sdk.name,
          models: sdk.status === "configured" ? (modelsBySdk.get(sdk.name) ?? []) : [],
          status: sdk.status === "configured" ? AgentSdkStatus.READY : AgentSdkStatus.UNCONFIGURED,
        };
      }

      if (sdk.status !== "configured" || sdk.authentication === "unauthenticated") {
        return {
          name: sdk.name,
          models: [],
          status: AgentSdkStatus.UNCONFIGURED,
        };
      }

      try {
        logger.debug("Refreshing Codex models for runner registration.");
        return {
          name: sdk.name,
          models: modelsBySdk.get(sdk.name) ?? [],
          status: AgentSdkStatus.READY,
        };
      } catch (error: unknown) {
        return {
          name: sdk.name,
          models: modelsBySdk.get(sdk.name) ?? [],
          status: AgentSdkStatus.ERROR,
          errorMessage: formatSdkModelRefreshFailure("codex", error),
        };
      }
    });
  } finally {
    client.close();
  }
}
async function countSdkModels(cfg: Config, sdkName: string): Promise<number> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const models = await db.select({ name: llmModels.name }).from(llmModels).where(eq(llmModels.sdkName, sdkName)).all();
    return models.length;
  } finally {
    client.close();
  }
}

async function loadCodexSdkState(
  cfg: Config,
): Promise<{ name: string; authentication: string; status: string } | undefined> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    return await db.select().from(agentSdks).where(eq(agentSdks.name, "codex")).get() ?? undefined;
  } finally {
    client.close();
  }
}

async function refreshCodexModelsForRegistration(
  cfg: Config,
  logger: Logger,
  reportProgress?: (message: string) => void,
): Promise<string | null> {
  const codexSdk = await loadCodexSdkState(cfg);

  if (!codexSdk || codexSdk.status !== "configured" || codexSdk.authentication === "unauthenticated") {
    logger.info("Codex is not configured; registering runner with unconfigured Codex SDK state.");
    return null;
  }

  try {
    reportProgress?.("Refreshing Codex models from the local app-server.");
    const results = await refreshSdkModels({
      sdk: "codex",
      logger,
      imageStatusReporter: reportProgress,
    });
    const modelCount = results[0]?.modelCount ?? 0;
    logger.info(`Refreshed Codex models from container app-server (${modelCount} models).`);
    reportProgress?.(`Refreshed Codex models from container app-server (${modelCount} models).`);
    return null;
  } catch (error: unknown) {
    const cachedModelCount = await countSdkModels(cfg, "codex");
    const failureMessage = formatSdkModelRefreshFailure("codex", error);
    if (cachedModelCount > 0) {
      logger.warn(
        `${failureMessage} Using ${cachedModelCount} cached Codex model(s) while registering Codex in error state.`,
      );
    } else {
      logger.warn(`${failureMessage} Registering Codex in error state with zero models.`);
    }
    return failureMessage;
  }
}

async function buildRegisterRunnerRequest(
  cfg: Config,
  logger: Logger,
  codexRefreshErrorMessage?: string | null,
): Promise<RegisterRunnerRequest> {
  const sdks = await loadRunnerRegistrationSdks(cfg, logger);
  return create(RegisterRunnerRequestSchema, {
    agentSdks: sdks.map((sdk) => ({
      name: sdk.name,
      models: sdk.models,
      status: sdk.name === "codex" && codexRefreshErrorMessage
        ? AgentSdkStatus.ERROR
        : sdk.status,
      errorMessage: sdk.name === "codex" ? (codexRefreshErrorMessage ?? sdk.errorMessage) : sdk.errorMessage,
    })),
  });
}

async function buildCodexAgentSdkUpdate(
  cfg: Config,
  logger: Logger,
  statusOverride?: number,
  errorMessage?: string,
): Promise<AgentSdk> {
  const sdks = await loadRunnerRegistrationSdks(cfg, logger);
  const codex = sdks.find((sdk) => sdk.name === "codex");
  return {
    name: "codex",
    models: codex?.models ?? [],
    status: statusOverride ?? codex?.status ?? AgentSdkStatus.UNCONFIGURED,
    errorMessage: errorMessage ?? codex?.errorMessage,
  } as AgentSdk;
}

async function resolveThreadAuthMode(cfg: Config): Promise<ThreadAuthMode> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const codexSdk = await db.select().from(agentSdks).where(eq(agentSdks.name, "codex")).get();
    if (!codexSdk) {
      throw new Error("Codex SDK is not configured.");
    }

    if (codexSdk.authentication === "api-key") {
      return "dedicated";
    }

    if (codexSdk.authentication !== "host" && codexSdk.authentication !== "dedicated") {
      throw new Error(`Unsupported Codex authentication mode '${codexSdk.authentication}' for thread creation.`);
    }

    return codexSdk.authentication;
  } finally {
    client.close();
  }
}

async function handleCreateThreadRequest(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: CreateThreadRequest,
  requestId: string | undefined,
  apiClient: CompanyhelmApiClient,
  apiCallOptions: CompanyhelmApiCallOptions | undefined,
  logger: Logger,
): Promise<void> {
  const threadId = (request.threadId ?? "").trim();
  const modelName = (request.model ?? "").trim();
  const requestedReasoningLevel = (request.reasoningLevel ?? "").trim();
  if (!threadId) {
    logger.warn("Rejecting createThreadRequest: threadId is required.");
    await sendRequestError(commandChannel, "Thread id is required.", requestId);
    return;
  }

  if (!modelName) {
    logger.warn("Rejecting createThreadRequest: model is required.");
    await sendRequestError(commandChannel, "Model is required.", requestId);
    return;
  }

  const { db, client } = await initDb(cfg.state_db_path);
  const workspaceProvisioner = new ThreadWorkspaceProvisioner(
    cfg.config_directory,
    cfg.workspaces_directory,
    cfg.workspace_path,
    cfg.use_dedicated_workspaces,
  );
  const metadataStore = new ThreadMetadataStore(cfg.config_directory, logger);
  const threadDirectory = workspaceProvisioner.resolveWorkspaceDirectory(threadId);
  const containerNames = buildThreadContainerNames(threadId);
  const hostInfo = getHostInfo(cfg.codex.codex_auth_path);
  const normalizedAdditionalModelInstructions = normalizeAdditionalModelInstructions(
    request.additionalModelInstructions,
  );
  const threadGitSkillPackages = normalizeThreadGitSkillPackagesForThreadConfig(request.gitSkillPackages, logger);
  const threadMcpServers = normalizeThreadMcpServersForThreadConfig(request.mcpServers, logger);
  const cliSecret = String(request.cliSecret ?? "").trim();
  logger.debug(
    `Received createThreadRequest for thread '${threadId}' (model '${modelName}', reasoning '${requestedReasoningLevel}', additional instructions length '${normalizedAdditionalModelInstructions?.length ?? 0}', git skill packages '${threadGitSkillPackages.length}', MCP servers '${threadMcpServers.length}').`,
  );

  let authMode: ThreadAuthMode;

  try {
    authMode = await resolveThreadAuthMode(cfg);

    const modelConfig = await db
      .select({
        name: llmModels.name,
        reasoningLevels: llmModels.reasoningLevels,
      })
      .from(llmModels)
      .where(eq(llmModels.name, modelName))
      .get();
    const configuredModelSample = await db
      .select({ name: llmModels.name })
      .from(llmModels)
      .limit(1)
      .all();

    if (configuredModelSample.length > 0) {
      if (!modelConfig) {
        throw new Error(`Model '${modelName}' is not configured.`);
      }

      if (requestedReasoningLevel.length > 0) {
        const supportedReasoningLevels = normalizeReasoningLevels(modelConfig.reasoningLevels);
        if (supportedReasoningLevels.length > 0 && !supportedReasoningLevels.includes(requestedReasoningLevel)) {
          throw new Error(
            `Reasoning level '${requestedReasoningLevel}' is not configured for model '${modelName}'.`,
          );
        }
      }
    }

    await db.insert(threads).values({
      id: threadId,
      sdkThreadId: null,
      cliSecret: cliSecret.length > 0 ? cliSecret : null,
      model: modelName,
      reasoningLevel: requestedReasoningLevel,
      additionalModelInstructions: normalizedAdditionalModelInstructions,
      status: "pending",
      currentSdkTurnId: null,
      isCurrentTurnRunning: false,
      workspace: threadDirectory,
      runtimeContainer: containerNames.runtime,
      dindContainer: cfg.use_host_docker_runtime ? null : containerNames.dind,
      homeDirectory: cfg.agent_home_directory,
      uid: hostInfo.uid,
      gid: hostInfo.gid,
    });
    logger.debug(`Thread '${threadId}' inserted with status 'pending'.`);
  } catch (error: unknown) {
    logger.warn(`Failed to initialize thread '${threadId}': ${toErrorMessage(error)}`);
    await sendRequestError(
      commandChannel,
      `Failed to initialize thread '${threadId}': ${toErrorMessage(error)}`,
      requestId,
    );
    return;
  } finally {
    client.close();
  }

  workspaceProvisioner.ensureWorkspaceDirectory(threadId);
  metadataStore.writeThreadGitSkillsConfig(threadId, threadGitSkillPackages);
  metadataStore.writeThreadMcpConfig(threadId, threadMcpServers);
  logger.debug(`Thread '${threadId}' workspace initialized at '${threadDirectory}'.`);

  const containerService = new ThreadContainerService();
  const mounts = buildSharedThreadMounts({
    threadDirectory,
    homeVolumeName: containerNames.home,
    tmpVolumeName: containerNames.tmp,
    codexAuthMode: authMode,
    codexAuthPath: cfg.codex.codex_auth_path,
    codexAuthFilePath: cfg.codex.codex_auth_file_path,
    configDirectory: cfg.config_directory,
    containerHomeDirectory: cfg.agent_home_directory,
  });

  try {
    await containerService.createThreadContainers({
      dindImage: cfg.dind_image,
      runtimeImage: cfg.runtime_image,
      names: containerNames,
      user: {
        uid: hostInfo.uid,
        gid: hostInfo.gid,
        agentUser: cfg.agent_user,
        agentHomeDirectory: cfg.agent_home_directory,
      },
      mounts,
      useHostDockerRuntime: cfg.use_host_docker_runtime,
      hostDockerPath: cfg.host_docker_path,
      imageStatusReporter: (message: string) => {
        logger.info(`[thread ${threadId}] ${message}`);
      },
    });
    if (cfg.use_host_docker_runtime) {
      logger.debug(`Thread '${threadId}' runtime container created (${containerNames.runtime}) in host docker mode.`);
    } else {
      logger.debug(`Thread '${threadId}' containers created (${containerNames.runtime}, ${containerNames.dind}).`);
    }
  } catch (error: unknown) {
    logger.warn(`Failed to create containers for thread '${threadId}': ${toErrorMessage(error)}`);
    await sendRequestError(
      commandChannel,
      `Failed to create containers for thread '${threadId}': ${toErrorMessage(error)}`,
      requestId,
    );
    return;
  }

  let readyRequestId: string | undefined;
  const { db: updateDb, client: updateClient } = await initDb(cfg.state_db_path);
  try {
    const threadState = await loadThreadMessageExecutionState(cfg.state_db_path, threadId);
    if (!threadState) {
      throw new Error(`Thread '${threadId}' disappeared before SDK bootstrap.`);
    }

    const persistedThreadMcpServers = metadataStore.readThreadMcpConfig(threadState.id);
    const persistedThreadGitSkillPackages = metadataStore.readThreadGitSkillsConfig(threadState.id);
    const threadMcpSetup = buildThreadCodexMcpSetup(persistedThreadMcpServers);
    const threadAgentCliConfig = buildThreadAgentCliConfig(threadState.cliSecret, cfg.agent_api_url);
    const appServerSession = await getOrCreateThreadAppServerSession(
      threadId,
      threadState.runtimeContainer,
      threadMcpSetup.appServerEnv,
      cfg.codex.app_server_client_name,
      logger,
    );
    const runtimeUser = {
      uid: threadState.uid,
      gid: threadState.gid,
      agentUser: cfg.agent_user,
      agentHomeDirectory: threadState.homeDirectory,
    };

    await ensureThreadRuntimeReady({
      dindContainer: threadState.dindContainer,
      runtimeContainer: threadState.runtimeContainer,
      containerService,
      gitUserName: cfg.git_user_name,
      gitUserEmail: cfg.git_user_email,
      user: runtimeUser,
    });
    await ensureThreadGitSkillsInRuntime(cfg, threadState, containerService, logger);
    await containerService.ensureRuntimeContainerThreadMetadata(
      threadState.runtimeContainer,
      runtimeUser,
      {
        mcpServers: persistedThreadMcpServers,
        gitSkillPackages: persistedThreadGitSkillPackages,
        threadAgentCliConfig,
      },
    );
    if (threadAgentCliConfig) {
      await containerService.ensureRuntimeContainerAgentCliConfig(
        threadState.runtimeContainer,
        runtimeUser,
        threadAgentCliConfig,
      );
    }
    await syncGithubInstallationsForRuntimeTargets(
      cfg,
      apiClient,
      apiCallOptions,
      [
        {
          threadId: threadState.id,
          runtimeContainer: threadState.runtimeContainer,
          homeDirectory: threadState.homeDirectory,
          uid: threadState.uid,
          gid: threadState.gid,
        },
      ],
      logger,
    );
    if (!appServerSession.started) {
      await containerService.ensureRuntimeContainerCodexConfig(
        threadState.runtimeContainer,
        runtimeUser,
        threadMcpSetup.configToml,
      );
    }

    await ensureThreadAppServerSessionStarted(appServerSession);

    const developerInstructions = buildThreadDeveloperInstructions(
      threadId,
      cfg,
      threadState.additionalModelInstructions,
      threadState.cliSecret,
    );
    logger.debug(
      `Starting app-server thread '${threadId}' with developer instructions: ${JSON.stringify(developerInstructions)}.`,
    );
    const threadStartResponse = await appServerSession.appServer.startThreadWithResponse(
      {
        model: threadState.model,
        modelProvider: null,
        cwd: "/workspace",
        approvalPolicy: YOLO_APPROVAL_POLICY,
        sandbox: YOLO_SANDBOX_MODE,
        config: null,
        baseInstructions: null,
        developerInstructions,
        personality: null,
        ephemeral: null,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      },
      requestId,
    );
    if (requestId && threadStartResponse.id !== requestId) {
      throw new Error(
        `App-server thread/start response id '${String(threadStartResponse.id)}' did not match runner request id '${requestId}'.`,
      );
    }
    if (!threadStartResponse.result.thread?.id) {
      throw new Error(`App-server thread/start did not return an SDK thread id for thread '${threadId}'.`);
    }
    readyRequestId = typeof threadStartResponse.id === "string" && threadStartResponse.id.length > 0
      ? threadStartResponse.id
      : undefined;
    appServerSession.sdkThreadId = threadStartResponse.result.thread.id;
    appServerSession.rolloutPath = threadStartResponse.result.thread.path;
    rememberThreadRolloutPath(threadId, threadStartResponse.result.thread.path);

    await updateDb
      .update(threads)
      .set({
        status: "ready",
        sdkThreadId: threadStartResponse.result.thread.id,
      })
      .where(eq(threads.id, threadId));
  } catch (error: unknown) {
    logger.warn(`Failed to mark thread '${threadId}' as ready: ${toErrorMessage(error)}`);
    await containerService.forceRemoveContainer(containerNames.runtime);
    if (!cfg.use_host_docker_runtime) {
      await containerService.forceRemoveContainer(containerNames.dind);
    }
    await containerService.forceRemoveVolume(containerNames.home);
    await containerService.forceRemoveVolume(containerNames.tmp);
    await sendRequestError(
      commandChannel,
      `Failed to mark thread '${threadId}' as ready: ${toErrorMessage(error)}`,
      requestId,
    );
    return;
  } finally {
    updateClient.close();
  }

  logger.info(`Thread '${threadId}' created and ready.`);
  await sendThreadUpdate(commandChannel, threadId, ThreadStatus.READY, readyRequestId);
}

type ExistingThreadResource = {
  id: string;
  runtimeContainer: string;
  dindContainer: string | null;
  workspace: string;
};

type DeleteThreadWithCleanupResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

type ThreadDeletionRequest = {
  threadId: string;
};

async function deleteThreadWithCleanup(
  cfg: Config,
  request: ThreadDeletionRequest,
): Promise<DeleteThreadWithCleanupResult> {
  const { db, client } = await initDb(cfg.state_db_path);

  let existingThread: ExistingThreadResource | undefined;
  try {
    existingThread = await db
      .select({
        id: threads.id,
        runtimeContainer: threads.runtimeContainer,
        dindContainer: threads.dindContainer,
        workspace: threads.workspace,
      })
      .from(threads)
      .where(eq(threads.id, request.threadId))
      .get();
  } catch (error: unknown) {
    return {
      kind: "error",
      message: `Failed to load thread '${request.threadId}': ${toErrorMessage(error)}`,
    };
  } finally {
    client.close();
  }

  if (!existingThread) {
    return { kind: "not_found" };
  }

  const containerService = new ThreadContainerService();
  try {
    const containerNames = buildThreadContainerNames(existingThread.id);
    const workspaceProvisioner = new ThreadWorkspaceProvisioner(
      cfg.config_directory,
      cfg.workspaces_directory,
      cfg.workspace_path,
      cfg.use_dedicated_workspaces,
    );
    await stopThreadAppServerSession(request.threadId);
    threadRolloutPaths.delete(request.threadId);
    await containerService.forceRemoveContainer(existingThread.runtimeContainer);
    if (existingThread.dindContainer && existingThread.dindContainer.trim().length > 0) {
      await containerService.forceRemoveContainer(existingThread.dindContainer);
    }
    await containerService.forceRemoveVolume(containerNames.home);
    await containerService.forceRemoveVolume(containerNames.tmp);
    workspaceProvisioner.removeWorkspaceDirectory(existingThread.id, existingThread.workspace);
    new ThreadMetadataStore(cfg.config_directory, createLogger("ERROR")).removeThreadMetadata(existingThread.id);
  } catch (error: unknown) {
    return {
      kind: "error",
      message: `Failed to delete resources for thread '${request.threadId}': ${toErrorMessage(error)}`,
    };
  }

  const { db: deleteDb, client: deleteClient } = await initDb(cfg.state_db_path);
  try {
    await deleteDb
      .delete(threads)
      .where(eq(threads.id, request.threadId));
  } catch (error: unknown) {
    return {
      kind: "error",
      message: `Failed to delete thread '${request.threadId}': ${toErrorMessage(error)}`,
    };
  } finally {
    deleteClient.close();
  }

  return { kind: "deleted" };
}

async function handleDeleteThreadRequest(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: DeleteThreadRequest,
  requestId: string | undefined,
  logger: Logger,
): Promise<void> {
  const deleteResult = await deleteThreadWithCleanup(cfg, request);
  if (deleteResult.kind === "not_found") {
    logger.warn(
      `Delete requested for missing thread '${request.threadId}'. Treating as deleted.`,
    );
    await sendThreadUpdate(commandChannel, request.threadId, ThreadStatus.DELETED, requestId);
    return;
  }
  if (deleteResult.kind === "error") {
    await sendRequestError(commandChannel, deleteResult.message, requestId);
    return;
  }

  await sendThreadUpdate(commandChannel, request.threadId, ThreadStatus.DELETED, requestId);
}

async function reportNoRunningInterruptAsReady(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: InterruptTurnRequest,
  threadState: ThreadMessageExecutionState,
  logger: Logger,
  logMessage: string,
): Promise<void> {
  try {
    await updateThreadTurnState(cfg, request.threadId, {
      isCurrentTurnRunning: false,
    });
  } catch (error: unknown) {
    logger.warn(
      `Failed to persist non-running interrupt state for thread '${request.threadId}': ${toErrorMessage(error)}`,
    );
  }

  if (threadState.currentSdkTurnId) {
    await sendTurnExecutionUpdate(
      commandChannel,
      request.threadId,
      threadState.currentSdkTurnId,
      TurnStatus.COMPLETED,
    );
  }
  await sendThreadUpdate(commandChannel, request.threadId, ThreadStatus.READY);
  logger.warn(logMessage);
}

async function handleInterruptTurnRequest(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: InterruptTurnRequest,
  logger: Logger,
): Promise<void> {
  let threadState: ThreadMessageExecutionState | undefined;
  try {
    threadState = await loadThreadMessageExecutionState(cfg.state_db_path, request.threadId);
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to load thread '${request.threadId}': ${toErrorMessage(error)}`);
    return;
  }

  if (!threadState) {
    await sendRequestError(commandChannel, `Thread '${request.threadId}' does not exist.`);
    return;
  }

  if (!threadState.isCurrentTurnRunning) {
    await reportNoRunningInterruptAsReady(
      cfg,
      commandChannel,
      request,
      threadState,
      logger,
      `Interrupt requested for thread '${request.threadId}' with no running turn; reported ready state.`,
    );
    return;
  }

  if (!threadState.currentSdkTurnId) {
    await sendRequestError(commandChannel, `Thread '${request.threadId}' is running but current SDK turn id is missing.`);
    return;
  }

  if (!threadState.sdkThreadId) {
    await sendRequestError(commandChannel, `Thread '${request.threadId}' is running but SDK thread id is missing.`);
    return;
  }

  const appServerSession = await getOrCreateThreadAppServerSession(
    request.threadId,
    threadState.runtimeContainer,
    {},
    cfg.codex.app_server_client_name,
    logger,
  );

  try {
    await ensureThreadAppServerSessionStarted(appServerSession);
  } catch (error: unknown) {
    const message = toErrorMessage(error);
    logger.warn(`Failed to start app-server session for interrupt: ${message}`);
    await sendRequestError(
      commandChannel,
      `Failed to connect to app-server for thread '${request.threadId}': ${message}`,
    );
    return;
  }

  const interruptParams = {
    threadId: threadState.sdkThreadId,
    turnId: threadState.currentSdkTurnId,
  };

  try {
    await appServerSession.appServer.interruptTurn(interruptParams);
  } catch (error: unknown) {
    if (isNoRunningTurnInterruptError(error)) {
      await reportNoRunningInterruptAsReady(
        cfg,
        commandChannel,
        request,
        threadState,
        logger,
        `Interrupt requested for thread '${request.threadId}' but turn '${threadState.currentSdkTurnId}' was already stopped; reported ready state.`,
      );
      return;
    }
    const message = toErrorMessage(error);
    logger.warn(`Failed to interrupt turn '${threadState.currentSdkTurnId}': ${message}`);
    await sendRequestError(
      commandChannel,
      `Failed to interrupt turn '${threadState.currentSdkTurnId}' for thread '${request.threadId}': ${message}`,
    );
    return;
  }

  logger.info(`Requested interrupt of turn '${threadState.currentSdkTurnId}' for thread '${request.threadId}'.`);
}

async function updateThreadTurnState(
  cfg: Config,
  threadId: string,
  update: {
    sdkThreadId?: string | null;
    currentSdkTurnId?: string | null;
    isCurrentTurnRunning?: boolean;
  },
): Promise<void> {
  await updateThreadTurnStateInDb(cfg.state_db_path, threadId, update);
}

async function waitForThreadTurnCompletion(
  stateDbPath: string,
  appServer: AppServerService,
  commandChannel: ClientMessageSink,
  threadId: string,
  sdkThreadId: string,
  sdkTurnId: string,
  logger: Logger,
  requestId?: string,
): Promise<"completed" | "interrupted" | "failed"> {
  let receivedThreadNameUpdate = false;
  try {
    const terminalStatus = await appServer.waitForTurnCompletion(
      sdkThreadId,
      sdkTurnId,
      async (notification: ServerNotification) => {
        const threadNameUpdate = extractThreadNameUpdateFromNotification(notification);
        if (threadNameUpdate && threadNameUpdate.sdkThreadId === sdkThreadId) {
          receivedThreadNameUpdate = true;
          await sendThreadNameUpdate(commandChannel, threadId, threadNameUpdate.threadName);
        }

        if (
          notification.method === "item/started" &&
          notification.params.threadId === sdkThreadId &&
          notification.params.turnId === sdkTurnId
        ) {
          const itemRequestId = notification.params.item.type === "userMessage"
            ? (await assignPendingUserMessageRequestIdForItem(
              stateDbPath,
              threadId,
              sdkTurnId,
              notification.params.item.id,
            ) ?? requestId)
            : requestId;
          await sendItemExecutionUpdate(
            commandChannel,
            threadId,
            sdkTurnId,
            notification.params.item.id,
            ItemStatus.RUNNING,
            notification.params.item,
            itemRequestId,
          );
        }

        if (
          notification.method === "item/completed" &&
          notification.params.threadId === sdkThreadId &&
          notification.params.turnId === sdkTurnId
        ) {
          const itemRequestId = notification.params.item.type === "userMessage"
            ? (await consumePendingUserMessageRequestIdForItem(
              stateDbPath,
              threadId,
              sdkTurnId,
              notification.params.item.id,
            ) ?? requestId)
            : requestId;
          await sendItemExecutionUpdate(
            commandChannel,
            threadId,
            sdkTurnId,
            notification.params.item.id,
            ItemStatus.COMPLETED,
            notification.params.item,
            itemRequestId,
          );
        }
      },
      TURN_COMPLETION_TIMEOUT_MS,
    );

    if (!receivedThreadNameUpdate) {
      try {
        const threadReadResponse = await appServer.readThread({
          threadId: sdkThreadId,
          includeTurns: false,
        });
        const fallbackThreadName = normalizeNonEmptyString(threadReadResponse.thread.preview);
        if (fallbackThreadName) {
          await sendThreadNameUpdate(commandChannel, threadId, fallbackThreadName);
        }
      } catch (error: unknown) {
        logger.debug(
          `Failed to read SDK thread '${sdkThreadId}' for fallback thread title inference: ${toErrorMessage(error)}`,
        );
      }
    }

    return terminalStatus;
  } finally {
    await clearPendingUserMessageRequestIdsForTurn(stateDbPath, threadId, sdkTurnId);
  }
}

async function executeCreateUserMessageRequest(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: CreateUserMessageRequest,
  requestId: string | undefined,
  threadState: ThreadMessageExecutionState,
  startedFromIdle: boolean,
  trackTurnCompletion: boolean,
  logger: Logger,
): Promise<void> {
  const containerService = new ThreadContainerService();
  const metadataStore = new ThreadMetadataStore(cfg.config_directory, logger);
  const persistedThreadMcpServers = metadataStore.readThreadMcpConfig(threadState.id);
  const persistedThreadGitSkillPackages = metadataStore.readThreadGitSkillsConfig(threadState.id);
  const threadMcpSetup = buildThreadCodexMcpSetup(persistedThreadMcpServers);
  const threadAgentCliConfig = buildThreadAgentCliConfig(threadState.cliSecret, cfg.agent_api_url);
  const appServerSession = await getOrCreateThreadAppServerSession(
    request.threadId,
    threadState.runtimeContainer,
    threadMcpSetup.appServerEnv,
    cfg.codex.app_server_client_name,
    logger,
  );
  const appServer = appServerSession.appServer;
  const runtimeUser = buildThreadRuntimeUser(cfg, threadState);

  let sdkThreadId = threadState.sdkThreadId;
  let sdkTurnId = threadState.currentSdkTurnId;
  let turnAccepted = false;
  let keepRuntimeWarm = false;
  let shouldTrackTurnCompletion = trackTurnCompletion;
  let enqueuedRequestTurnId: string | null = null;
  let turnCompletionWaitStarted = false;

  try {
    await ensureThreadRuntimeReady({
      dindContainer: threadState.dindContainer,
      runtimeContainer: threadState.runtimeContainer,
      containerService,
      gitUserName: cfg.git_user_name,
      gitUserEmail: cfg.git_user_email,
      user: runtimeUser,
    });
    await ensureThreadGitSkillsInRuntime(cfg, threadState, containerService, logger);
    await containerService.ensureRuntimeContainerThreadMetadata(
      threadState.runtimeContainer,
      runtimeUser,
      {
        mcpServers: persistedThreadMcpServers,
        gitSkillPackages: persistedThreadGitSkillPackages,
        threadAgentCliConfig,
      },
    );
    if (threadAgentCliConfig) {
      await containerService.ensureRuntimeContainerAgentCliConfig(
        threadState.runtimeContainer,
        runtimeUser,
        threadAgentCliConfig,
      );
    }
    if (!appServerSession.started) {
      await containerService.ensureRuntimeContainerCodexConfig(
        threadState.runtimeContainer,
        runtimeUser,
        threadMcpSetup.configToml,
      );
    }

    await ensureThreadAppServerSessionStarted(appServerSession);

    if (sdkThreadId) {
      if (appServerSession.sdkThreadId !== sdkThreadId) {
        const resumeParams: ThreadResumeParams = {
          threadId: sdkThreadId,
          approvalPolicy: YOLO_APPROVAL_POLICY,
          sandbox: YOLO_SANDBOX_MODE,
          persistExtendedHistory: true,
        };
        const resumeResult = await appServer.resumeThread(resumeParams);
        appServerSession.sdkThreadId = resumeResult.thread.id;
        appServerSession.rolloutPath = resumeResult.thread.path;
        rememberThreadRolloutPath(request.threadId, resumeResult.thread.path);
      }
    } else if (appServerSession.sdkThreadId) {
      sdkThreadId = appServerSession.sdkThreadId;
      await updateThreadTurnState(cfg, request.threadId, { sdkThreadId });
    } else {
      const developerInstructions = buildThreadDeveloperInstructions(
        request.threadId,
        cfg,
        threadState.additionalModelInstructions,
        threadState.cliSecret,
      );
      const threadStartParams: ThreadStartParams = {
        model: request.model ?? threadState.model,
        modelProvider: null,
        cwd: "/workspace",
        approvalPolicy: YOLO_APPROVAL_POLICY,
        sandbox: YOLO_SANDBOX_MODE,
        config: null,
        baseInstructions: null,
        developerInstructions,
        personality: null,
        ephemeral: null,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      };

      logger.debug(
        `Starting app-server thread '${request.threadId}' with developer instructions: ${JSON.stringify(developerInstructions)}.`,
      );
      const threadStartResult = await appServer.startThread(threadStartParams);
      sdkThreadId = threadStartResult.thread.id;
      appServerSession.sdkThreadId = sdkThreadId;
      appServerSession.rolloutPath = threadStartResult.thread.path;
      rememberThreadRolloutPath(request.threadId, threadStartResult.thread.path);
      await updateThreadTurnState(cfg, request.threadId, { sdkThreadId });
    }

    if (!sdkThreadId) {
      throw new Error(`Failed to resolve SDK thread id for thread '${request.threadId}'.`);
    }
    const resolvedSdkThreadId = sdkThreadId;

    const input = buildUserTextInput(request.text);
    const startNewTurn = async (): Promise<string> => {
      const turnStartParams: TurnStartParams = {
        threadId: resolvedSdkThreadId,
        input,
        model: request.model ?? null,
        effort: normalizeReasoningEffort(request.modelReasoningLevel ?? threadState.reasoningLevel),
        summary: null,
        personality: null,
        cwd: null,
        approvalPolicy: YOLO_APPROVAL_POLICY,
        sandboxPolicy: YOLO_SANDBOX_POLICY,
        outputSchema: null,
        collaborationMode: null,
      };
      const turnStartResult = await appServer.startTurn(turnStartParams);
      return turnStartResult.turn.id;
    };

    if (shouldUseTurnSteer(request.allowSteer, startedFromIdle)) {
      if (!threadState.currentSdkTurnId) {
        throw new Error(`Thread '${request.threadId}' is marked running but has no current SDK turn id.`);
      }

      const activeSdkTurnId = threadState.currentSdkTurnId;
      const steerParams: TurnSteerParams = {
        threadId: resolvedSdkThreadId,
        input,
        expectedTurnId: activeSdkTurnId,
      };
      try {
        const turnSteerResult = await appServer.steerTurn(steerParams);
        if (turnSteerResult.turnId && turnSteerResult.turnId !== activeSdkTurnId) {
          logger.debug(
            `turn/steer returned turn '${turnSteerResult.turnId}' for thread '${request.threadId}', preserving active turn '${activeSdkTurnId}' as the canonical turn id.`,
          );
        }
        sdkTurnId = activeSdkTurnId;
      } catch (error: unknown) {
        if (!isNoActiveTurnSteerError(error)) {
          throw error;
        }

        logger.warn(
          `No active turn to steer for thread '${request.threadId}'. Starting a new turn for queued steer request.`,
        );
        shouldTrackTurnCompletion = true;
        sdkTurnId = await startNewTurn();
      }
    } else {
      sdkTurnId = await startNewTurn();
    }

    if (!sdkTurnId) {
      throw new Error(`Failed to create SDK turn for thread '${request.threadId}'.`);
    }

    turnAccepted = true;
    await enqueuePendingUserMessageRequestIdForTurn(cfg.state_db_path, request.threadId, sdkTurnId, requestId);
    enqueuedRequestTurnId = requestId ? sdkTurnId : null;
    await updateThreadTurnState(cfg, request.threadId, {
      sdkThreadId,
      currentSdkTurnId: sdkTurnId,
      isCurrentTurnRunning: true,
    });
    await sendTurnExecutionUpdate(commandChannel, request.threadId, sdkTurnId, TurnStatus.RUNNING, requestId);

    if (!shouldTrackTurnCompletion) {
      keepRuntimeWarm = true;
      return;
    }

    turnCompletionWaitStarted = true;
    const terminalStatus = await waitForThreadTurnCompletion(
      cfg.state_db_path,
      appServer,
      commandChannel,
      request.threadId,
      sdkThreadId,
      sdkTurnId,
      logger,
      requestId,
    );

    await updateThreadTurnState(cfg, request.threadId, {
      currentSdkTurnId: sdkTurnId,
      isCurrentTurnRunning: false,
    });
    await sendTurnExecutionUpdate(commandChannel, request.threadId, sdkTurnId, TurnStatus.COMPLETED, requestId);

    if (terminalStatus === "failed") {
      await sendRequestError(
        commandChannel,
        `Turn '${sdkTurnId}' finished with status '${terminalStatus}' for thread '${request.threadId}'.`,
        requestId,
      );
    } else if (terminalStatus === "interrupted") {
      logger.info(`Turn '${sdkTurnId}' for thread '${request.threadId}' was interrupted.`);
      keepRuntimeWarm = true;
    } else {
      // Keep app-server + containers warm for fast follow-up user messages on the same thread.
      keepRuntimeWarm = true;
    }
  } catch (error: unknown) {
    if (enqueuedRequestTurnId && requestId) {
      await removePendingUserMessageRequestIdForTurn(
        cfg.state_db_path,
        request.threadId,
        enqueuedRequestTurnId,
        requestId,
      );
    }
    if (turnCompletionWaitStarted && !isTurnCompletionTimeoutError(error)) {
      await updateThreadTurnState(cfg, request.threadId, {
        isCurrentTurnRunning: false,
      }).catch(() => undefined);
    } else if (startedFromIdle && !turnAccepted) {
      await updateThreadTurnState(cfg, request.threadId, {
        isCurrentTurnRunning: false,
      }).catch(() => undefined);
    }

    logger.warn(
      `Failed to create user message turn for thread '${request.threadId}': ${toErrorMessage(error)}`,
    );
    await sendRequestError(commandChannel, toErrorMessage(error), requestId);
  } finally {
    if (!keepRuntimeWarm) {
      await stopThreadAppServerSession(request.threadId);
      await containerService.stopContainer(threadState.runtimeContainer).catch((error: unknown) => {
        logger.warn(`Failed to stop runtime container '${threadState.runtimeContainer}': ${toErrorMessage(error)}`);
      });
      if (threadState.dindContainer && threadState.dindContainer.trim().length > 0) {
        await containerService.stopContainer(threadState.dindContainer).catch((error: unknown) => {
          logger.warn(`Failed to stop DinD container '${threadState.dindContainer}': ${toErrorMessage(error)}`);
        });
      }
    }
  }
}

async function handleCreateUserMessageRequest(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: CreateUserMessageRequest,
  requestId: string | undefined,
  logger: Logger,
): Promise<void> {
  let threadState: ThreadMessageExecutionState | undefined;

  try {
    threadState = await loadThreadMessageExecutionState(cfg.state_db_path, request.threadId);

    if (!threadState) {
      await sendRequestError(commandChannel, `Thread '${request.threadId}' does not exist.`, requestId);
      return;
    }

    if (threadState.isCurrentTurnRunning && !request.allowSteer) {
      threadState = await reconcileThreadRunningStateBeforeUserMessage(cfg, threadState, logger);
    }

    if (!request.allowSteer && threadState.isCurrentTurnRunning) {
      await sendRequestError(
        commandChannel,
        `Thread '${request.threadId}' already has a running turn and allowSteer=false.`,
        requestId,
      );
      return;
    }

    if (threadState.isCurrentTurnRunning && request.allowSteer && !threadState.currentSdkTurnId) {
      await sendRequestError(
        commandChannel,
        `Thread '${request.threadId}' is in an inconsistent state: running turn id is missing.`,
        requestId,
      );
      return;
    }
  } catch (error: unknown) {
    await sendRequestError(
      commandChannel,
      `Failed to load thread '${request.threadId}': ${toErrorMessage(error)}`,
      requestId,
    );
    return;
  }

  if (!threadState) {
    return;
  }

  const startedFromIdle = !threadState.isCurrentTurnRunning;
  if (startedFromIdle) {
    try {
      await updateThreadTurnState(cfg, request.threadId, {
        isCurrentTurnRunning: true,
      });
      threadState.isCurrentTurnRunning = true;
    } catch (error: unknown) {
      await sendRequestError(
        commandChannel,
        `Failed to reserve thread '${request.threadId}' for execution: ${toErrorMessage(error)}`,
        requestId,
      );
      return;
    }
  }

  const trackTurnCompletion = startedFromIdle;
  void executeCreateUserMessageRequest(
    cfg,
    commandChannel,
    request,
    requestId,
    threadState,
    startedFromIdle,
    trackTurnCompletion,
    logger,
  );
}

async function handleCodexConfigurationRequest(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: { authType: CodexAuthType; codexApiKey?: string },
  requestId: string | undefined,
  logger: Logger,
): Promise<void> {
  try {
    if (request.authType === CodexAuthType.API_KEY) {
      const apiKey = String(request.codexApiKey ?? "").trim();
      if (!apiKey) {
        await sendRequestError(commandChannel, "Codex API key is required.", requestId);
        return;
      }
      await runCodexApiKeyAuth(cfg, apiKey, {
        logInfo: (message: string) => logger.info(message),
        logSuccess: (message: string) => logger.info(message),
      });
    } else if (request.authType === CodexAuthType.DEVICE_CODE) {
      await runCodexDeviceCodeAuth(
        cfg,
        async (deviceCode: string) => {
          await sendCodexDeviceCode(commandChannel, deviceCode, requestId);
        },
        {
          logInfo: (message: string) => logger.info(message),
          logSuccess: (message: string) => logger.info(message),
        },
      );
    } else {
      await sendRequestError(commandChannel, "Unsupported Codex auth type.", requestId);
      return;
    }

    const codexSdk = await loadCodexSdkState(cfg);
    if (!codexSdk || codexSdk.status !== "configured" || codexSdk.authentication === "unauthenticated") {
      const sdkUpdate = await buildCodexAgentSdkUpdate(cfg, logger, AgentSdkStatus.UNCONFIGURED);
      await sendAgentSdkUpdate(commandChannel, sdkUpdate, requestId);
      return;
    }

    const codexRefreshErrorMessage = await refreshCodexModelsForRegistration(cfg, logger);
    const sdkUpdate = await buildCodexAgentSdkUpdate(
      cfg,
      logger,
      codexRefreshErrorMessage ? AgentSdkStatus.ERROR : AgentSdkStatus.READY,
      codexRefreshErrorMessage ?? undefined,
    );
    await sendAgentSdkUpdate(commandChannel, sdkUpdate, requestId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const sdkUpdate = await buildCodexAgentSdkUpdate(cfg, logger, AgentSdkStatus.ERROR, message);
    await sendAgentSdkUpdate(commandChannel, sdkUpdate, requestId);
    await sendRequestError(commandChannel, message, requestId);
  }
}

export async function runCommandLoop(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  commandMessageSink: ClientMessageSink,
  apiClient: CompanyhelmApiClient,
  apiCallOptions: CompanyhelmApiCallOptions | undefined,
  logger: Logger,
): Promise<void> {
  for await (const serverMessage of commandChannel) {
    const requestId = serverMessage.requestId ?? undefined;
    switch (serverMessage.request.case) {
      case "createThreadRequest":
        await handleCreateThreadRequest(
          cfg,
          commandMessageSink,
          serverMessage.request.value,
          requestId,
          apiClient,
          apiCallOptions,
          logger,
        );
        break;
      case "deleteThreadRequest":
        await handleDeleteThreadRequest(cfg, commandMessageSink, serverMessage.request.value, requestId, logger);
        break;
      case "createUserMessageRequest":
        void handleCreateUserMessageRequest(
          cfg,
          commandMessageSink,
          serverMessage.request.value,
          requestId,
          logger,
        ).catch((error: unknown) => {
          logger.warn(`Unhandled createUserMessageRequest error: ${toErrorMessage(error)}`);
        });
        break;
      case "interruptTurnRequest":
        await handleInterruptTurnRequest(cfg, commandMessageSink, serverMessage.request.value, logger);
        break;
      case "heartbeatRequest":
        await sendHeartbeatResponse(commandMessageSink, requestId);
        break;
      case "codexConfigurationRequest":
        await handleCodexConfigurationRequest(
          cfg,
          commandMessageSink,
          serverMessage.request.value,
          requestId,
          logger,
        );
        break;
      default:
        break;
    }
  }
}

function buildGrpcAuthCallOptions(secret: string | undefined): { metadata: grpc.Metadata } | undefined {
  if (!secret || secret.trim().length === 0) {
    return undefined;
  }

  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${secret}`);
  return { metadata };
}

export function isInternalDaemonChildProcess(): boolean {
  return process.env[DAEMON_CHILD_ENV] === "1";
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new RootCommandInterruptedError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortErrorFromSignal(signal);
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortErrorFromSignal(signal));
  }

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(abortErrorFromSignal(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
}

function delayWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortErrorFromSignal(signal));
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(abortErrorFromSignal(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function installRootInterruptHandlers(
  logger: Logger,
  onInterrupt: () => void,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();

  const requestInterrupt = (reason: string) => {
    if (controller.signal.aborted) {
      return;
    }

    restoreInteractiveTerminalState();
    process.exitCode = 130;
    logger.info(`${reason} received. Shutting down root command.`);
    try {
      onInterrupt();
    } catch {
      // Best-effort shutdown hook.
    }
    controller.abort(new RootCommandInterruptedError(reason));
  };

  const handleSigint = () => {
    requestInterrupt("SIGINT");
  };
  const handleSigterm = () => {
    requestInterrupt("SIGTERM");
  };
  const handleStdinData = (chunk: Buffer | string) => {
    const input = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (containsCtrlCInterruptInput(input)) {
      requestInterrupt("Ctrl-C");
    }
  };

  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  if (process.stdin.isTTY) {
    process.stdin.on("data", handleStdinData);
    process.stdin.resume();
  }

  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
      if (process.stdin.isTTY) {
        process.stdin.off("data", handleStdinData);
      }
    },
  };
}

function resolveEffectiveDaemonLogPath(cfg: Config): string {
  const envPath = process.env[DAEMON_LOG_PATH_ENV];
  if (envPath && envPath.trim().length > 0) {
    return expandHome(envPath);
  }
  return resolveDaemonLogPath(cfg.state_db_path);
}

export async function runDetachedDaemonProcess(options: RootCommandOptions): Promise<void> {
  const cfg = buildRootConfig(options);
  const logPath = options.logPath && options.logPath.trim().length > 0
    ? expandHome(options.logPath)
    : resolveDaemonLogPath(cfg.state_db_path);
  mkdirSync(dirname(logPath), { recursive: true });

  const logFd = openSync(logPath, "a");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        detached: true,
        env: {
          ...process.env,
          [DAEMON_CHILD_ENV]: "1",
          [DAEMON_LOG_PATH_ENV]: logPath,
        },
        stdio: ["ignore", logFd, logFd, "ipc"],
        windowsHide: true,
      });

      let settled = false;
      const startupWatchdog = new DaemonStartupWatchdog(DAEMON_STARTUP_TIMEOUT_MS, () => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        reject(new Error(`Timed out waiting for daemon startup confirmation. See ${logPath}.`));
      });

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        startupWatchdog.finish();
        callback();
      };

      child.once("error", (error) => {
        finish(() => reject(error));
      });
      child.once("exit", (code, signal) => {
        finish(() => {
          reject(new Error(`Daemon exited before startup completed (code=${code ?? "null"}, signal=${signal ?? "null"}). See ${logPath}.`));
        });
      });
      child.on("message", (message) => {
        if (!message || typeof message !== "object" || !("type" in message)) {
          return;
        }

        const type = (message as { type?: unknown }).type;
        if (type === "daemon-progress") {
          startupWatchdog.bump();
          return;
        }

        if (type === "daemon-ready") {
          finish(() => {
            if (child.connected) {
              child.disconnect();
            }
            child.unref();
            console.log(`CompanyHelm daemon started (pid ${child.pid}). Logs: ${logPath}`);
            resolve();
          });
          return;
        }

        if (type === "daemon-error") {
          const messageValue = (message as { message?: unknown }).message;
          const daemonErrorMessage =
            typeof messageValue === "string" ? messageValue : `Daemon startup failed. See ${logPath}.`;
          finish(() => reject(new Error(daemonErrorMessage)));
        }
      });
    });
  } finally {
    closeSync(logFd);
  }
}

export function sendDaemonParentMessage(
  message:
    | { type: "daemon-progress"; message: string }
    | { type: "daemon-ready" }
    | { type: "daemon-error"; message: string },
): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

export async function runRootCommand(
  options: RootCommandOptions,
  runtimeOptions?: RootCommandRuntimeOptions,
): Promise<void> {
  const logger = createLogger(options.logLevel ?? "INFO", { daemonMode: options.daemon ?? false });
  const cfg = buildRootConfig(options);
  logger.info(formatWorkspaceStartupMessage(cfg));
  await ensureRunnerStartupPreflight(cfg);
  await ensureCodexRunnerStartState(cfg, {
    useDedicatedAuth: options.useDedicatedAuth,
    logInfo: (message: string) => logger.info(message),
  });

  const codexRefreshErrorMessage = await refreshCodexModelsForRegistration(
    cfg,
    logger,
    runtimeOptions?.onDaemonProgress,
  );
  const registerRequest = await buildRegisterRunnerRequest(cfg, logger, codexRefreshErrorMessage);
  const apiCallOptions = buildGrpcAuthCallOptions(options.secret);
  if (options.daemon) {
    await claimCurrentDaemonState(cfg.state_db_path, process.pid, resolveEffectiveDaemonLogPath(cfg));
    runtimeOptions?.onDaemonReady?.();
  }
  const commandMessageSink = new BufferedClientMessageSender({
    maxBufferedEvents: cfg.client_message_buffer_limit,
    logger,
  });
  await reconcileTrackedRunningThreadsOnStartup(cfg, logger);
  let reconnectAttempt = 0;
  let activeApiClient: CompanyhelmApiClient | null = null;
  let activeCommandChannel: CompanyhelmCommandChannel | null = null;
  const interruptState = installRootInterruptHandlers(logger, () => {
    activeCommandChannel?.cancel();
    activeApiClient?.close();
  });

  try {
    while (true) {
      throwIfAborted(interruptState.signal);
      const apiClient = new CompanyhelmApiClient({ apiUrl: cfg.companyhelm_api_url, logger });
      activeApiClient = apiClient;
      let commandChannel: CompanyhelmCommandChannel | null = null;
      let githubInstallationsSyncAbortController: AbortController | null = null;
      let githubInstallationsSyncTask: Promise<void> | null = null;

      try {
        reconnectAttempt += 1;
        commandChannel = await apiClient.connect(registerRequest, apiCallOptions);
        activeCommandChannel = commandChannel;
        await raceWithAbort(commandChannel.waitForOpen(COMMAND_CHANNEL_OPEN_TIMEOUT_MS), interruptState.signal);
        commandMessageSink.bind(commandChannel);
        const bufferedMessages = commandMessageSink.getBufferedMessageCount();
        if (bufferedMessages > 0) {
          logger.info(
            `Connected to CompanyHelm API at ${cfg.companyhelm_api_url}; flushing ${bufferedMessages} buffered message(s).`,
          );
        } else {
          logger.info(`Connected to CompanyHelm API at ${cfg.companyhelm_api_url}`);
        }
        reconnectAttempt = 0;

        githubInstallationsSyncAbortController = new AbortController();
        githubInstallationsSyncTask = runGithubInstallationsSyncLoop(
          cfg,
          apiClient,
          apiCallOptions,
          logger,
          githubInstallationsSyncAbortController.signal,
        ).catch((error: unknown) => {
          if (!githubInstallationsSyncAbortController?.signal.aborted) {
            logger.warn(`GitHub installation sync loop exited unexpectedly: ${toErrorMessage(error)}`);
          }
        });

        await raceWithAbort(
          runCommandLoop(cfg, commandChannel, commandMessageSink, apiClient, apiCallOptions, logger),
          interruptState.signal,
        );
        logger.warn("CompanyHelm API command channel closed. Reconnecting...");
      } catch (error: unknown) {
        if (error instanceof RootCommandInterruptedError) {
          return;
        }
        const failureMessage = formatApiConnectionFailureMessage(error, cfg.companyhelm_api_url, options.secret);
        const diagnostics = formatApiConnectionFailureDiagnostics(error);
        if (diagnostics) {
          logger.debug(`CompanyHelm API failure diagnostics: ${diagnostics}`);
        }
        if (!isRetryableApiConnectionError(error)) {
          throw new Error(failureMessage);
        }
        logger.warn(
          `CompanyHelm API connection attempt ${reconnectAttempt} failed: ${failureMessage}. ` +
            "Retrying...",
        );
      } finally {
        if (githubInstallationsSyncAbortController) {
          githubInstallationsSyncAbortController.abort();
        }
        void githubInstallationsSyncTask;
        if (commandChannel) {
          commandChannel.cancel();
          commandMessageSink.unbind(commandChannel);
        } else {
          commandMessageSink.unbind();
        }
        if (activeCommandChannel === commandChannel) {
          activeCommandChannel = null;
        }
        if (activeApiClient === apiClient) {
          activeApiClient = null;
        }
        apiClient.close();
      }

      await delayWithAbort(COMMAND_CHANNEL_CONNECT_RETRY_DELAY_MS, interruptState.signal);
    }
  } finally {
    interruptState.dispose();
    const droppedMessages = commandMessageSink.getDroppedMessageCount();
    if (droppedMessages > 0) {
      logger.warn(`Dropped ${droppedMessages} outbound client message(s) while command channel was disconnected.`);
    }
    if (options.daemon) {
      await clearCurrentDaemonState(cfg.state_db_path, process.pid).catch((error: unknown) => {
        logger.warn(`Failed to clear daemon state: ${toErrorMessage(error)}`);
      });
    }
    await stopAllThreadAppServerSessions();
    await stopAllThreadContainers(cfg, logger);
  }
}

export function buildRootConfig(options: RootCommandOptions): Config {
  if (options.useDedicatedWorkspaces && typeof options.workspacePath === "string" && options.workspacePath.trim().length > 0) {
    throw new Error("--workspace-path and --use-dedicated-workspaces cannot be used together.");
  }

  return configSchema.parse({
    config_directory: options.configPath,
    workspace_path: options.workspacePath,
    use_dedicated_workspaces: options.useDedicatedWorkspaces,
    state_db_path: options.stateDbPath,
    companyhelm_api_url: options.serverUrl,
    agent_api_url: options.agentApiUrl,
    use_host_docker_runtime: options.useHostDockerRuntime,
    host_docker_path: options.hostDockerPath,
    thread_git_skills_directory: options.threadGitSkillsDirectory,
  });
}
