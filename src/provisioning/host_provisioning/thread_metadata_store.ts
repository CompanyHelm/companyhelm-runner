import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadGitSkillPackageConfig } from "../../service/thread_lifecycle.js";
import type { Logger } from "../../utils/logger.js";
import { resolveThreadMetadataDirectory } from "./thread_workspace_provisioner.js";
import type { ThreadMcpServerConfig } from "./thread_metadata_types.js";

const THREAD_GIT_SKILLS_CONFIG_FILENAME = "thread-git-skills.json";
const THREAD_MCP_CONFIG_FILENAME = "thread-mcp.json";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\")) {
    return null;
  }

  const segments = trimmed.split("/").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  return segments.join("/");
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
    if (!url || (authType === "bearer_token" && !bearerToken)) {
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

    const parsedSkills = [];
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

export class ThreadMetadataStore {
  constructor(
    private readonly configDirectory: string,
    private readonly logger: Logger,
  ) {}

  private resolveThreadMetadataPath(threadId: string, filename: string): string {
    return join(resolveThreadMetadataDirectory(this.configDirectory, threadId), filename);
  }

  private writeJsonFile(threadId: string, filename: string, payload: unknown): void {
    const filePath = this.resolveThreadMetadataPath(threadId, filename);
    const directoryPath = resolveThreadMetadataDirectory(this.configDirectory, threadId);
    const temporaryPath = `${filePath}.tmp`;

    try {
      mkdirSync(directoryPath, { recursive: true });
      writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(temporaryPath, filePath);
    } catch (error: unknown) {
      this.logger.warn(`Failed writing thread metadata at '${filePath}': ${toErrorMessage(error)}`);
    }
  }

  private removeFile(threadId: string, filename: string): void {
    const filePath = this.resolveThreadMetadataPath(threadId, filename);
    rmSync(filePath, { force: true });
    rmSync(`${filePath}.tmp`, { force: true });
  }

  writeThreadMcpConfig(threadId: string, mcpServers: ThreadMcpServerConfig[]): void {
    if (mcpServers.length === 0) {
      this.removeFile(threadId, THREAD_MCP_CONFIG_FILENAME);
      return;
    }

    this.writeJsonFile(threadId, THREAD_MCP_CONFIG_FILENAME, { servers: mcpServers });
  }

  readThreadMcpConfig(threadId: string): ThreadMcpServerConfig[] {
    const filePath = this.resolveThreadMetadataPath(threadId, THREAD_MCP_CONFIG_FILENAME);
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      const mcpServers = parseThreadMcpConfig(parsed);
      if (!mcpServers) {
        this.logger.warn(`Thread MCP config has invalid shape at '${filePath}'.`);
        return [];
      }
      return mcpServers;
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return [];
      }
      this.logger.warn(`Failed reading thread MCP config at '${filePath}': ${toErrorMessage(error)}`);
      return [];
    }
  }

  writeThreadGitSkillsConfig(threadId: string, gitSkillPackages: ThreadGitSkillPackageConfig[]): void {
    if (gitSkillPackages.length === 0) {
      this.removeFile(threadId, THREAD_GIT_SKILLS_CONFIG_FILENAME);
      return;
    }

    this.writeJsonFile(threadId, THREAD_GIT_SKILLS_CONFIG_FILENAME, { packages: gitSkillPackages });
  }

  readThreadGitSkillsConfig(threadId: string): ThreadGitSkillPackageConfig[] {
    const filePath = this.resolveThreadMetadataPath(threadId, THREAD_GIT_SKILLS_CONFIG_FILENAME);
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      const packages = parseThreadGitSkillsConfig(parsed);
      if (!packages) {
        this.logger.warn(`Thread git skills config has invalid shape at '${filePath}'.`);
        return [];
      }
      return packages;
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return [];
      }
      this.logger.warn(`Failed reading thread git skills config at '${filePath}': ${toErrorMessage(error)}`);
      return [];
    }
  }

  removeThreadMetadata(threadId: string): void {
    rmSync(resolveThreadMetadataDirectory(this.configDirectory, threadId), { recursive: true, force: true });
  }
}
