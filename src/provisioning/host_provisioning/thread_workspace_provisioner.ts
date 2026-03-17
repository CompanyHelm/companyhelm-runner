import { mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { expandHome } from "../../utils/path.js";
import { resolveThreadDirectory } from "../../service/thread_lifecycle.js";

export interface ResolveThreadWorkspaceDirectoryOptions {
  configDirectory: string;
  workspacesDirectory: string;
  workspacePath: string;
  useDedicatedWorkspaces: boolean;
  threadId: string;
}

function resolveSharedWorkspacePath(workspacePath: string): string {
  const expandedWorkspacePath = expandHome(workspacePath);
  if (isAbsolute(expandedWorkspacePath)) {
    return expandedWorkspacePath;
  }

  return resolve(process.cwd(), expandedWorkspacePath);
}

export function resolveThreadWorkspaceDirectory(options: ResolveThreadWorkspaceDirectoryOptions): string {
  if (options.useDedicatedWorkspaces) {
    return resolveThreadDirectory(options.configDirectory, options.workspacesDirectory, options.threadId);
  }

  return resolveSharedWorkspacePath(options.workspacePath);
}

export function resolveThreadMetadataDirectory(configDirectory: string, threadId: string): string {
  return join(expandHome(configDirectory), "thread-metadata", `thread-${threadId}`);
}

export class ThreadWorkspaceProvisioner {
  constructor(
    private readonly configDirectory: string,
    private readonly workspacesDirectory: string,
    private readonly workspacePath: string,
    private readonly useDedicatedWorkspaces: boolean,
  ) {}

  resolveWorkspaceDirectory(threadId: string): string {
    return resolveThreadWorkspaceDirectory({
      configDirectory: this.configDirectory,
      workspacesDirectory: this.workspacesDirectory,
      workspacePath: this.workspacePath,
      useDedicatedWorkspaces: this.useDedicatedWorkspaces,
      threadId,
    });
  }

  ensureWorkspaceDirectory(threadId: string): string {
    const workspaceDirectory = this.resolveWorkspaceDirectory(threadId);
    mkdirSync(workspaceDirectory, { recursive: true });
    return workspaceDirectory;
  }

  removeWorkspaceDirectory(threadId: string, workspaceDirectory: string): void {
    if (!this.useDedicatedWorkspaces) {
      return;
    }

    if (workspaceDirectory !== this.resolveWorkspaceDirectory(threadId)) {
      return;
    }

    rmSync(workspaceDirectory, { recursive: true, force: true });
  }
}
