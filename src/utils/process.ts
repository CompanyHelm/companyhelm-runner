import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function parseProcStatState(statLine: string): string | null {
  const trimmed = statLine.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const closingParenIndex = trimmed.lastIndexOf(")");
  if (closingParenIndex < 0) {
    return null;
  }

  const suffix = trimmed.slice(closingParenIndex + 1).trim();
  if (suffix.length === 0) {
    return null;
  }

  const state = suffix[0]?.trim();
  return state && state.length > 0 ? state : null;
}

export function isZombieProcessState(state: string | null | undefined): boolean {
  return state === "Z";
}

function readProcessState(pid: number): string | null | undefined {
  if (process.platform === "linux") {
    try {
      return parseProcStatState(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch (error: unknown) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined;
      if (code === "ENOENT") {
        return null;
      }
      return undefined;
    }
  }

  if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd" || process.platform === "sunos") {
    try {
      const status = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
      if (!status) {
        return null;
      }
      return status[0] ?? null;
    } catch (error: unknown) {
      const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
      if (status === 1) {
        return null;
      }
      return undefined;
    }
  }

  return undefined;
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    const state = readProcessState(pid);
    if (state === null) {
      return false;
    }
    if (isZombieProcessState(state)) {
      return false;
    }
    return true;
  } catch (error: unknown) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined;
    if (code === "EPERM") {
      return true;
    }
    if (code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
