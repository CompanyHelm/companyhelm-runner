import { constants } from "node:fs";
import { access, open, readFile, type FileHandle } from "node:fs/promises";
import type { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { config as configSchema } from "../config.js";
import { readCurrentDaemonState, type CurrentDaemonState } from "../state/daemon_state.js";
import { resolveDaemonLogPath } from "../utils/daemon.js";

export interface LogsCommandOptions {
  live?: boolean;
  stateDbPath?: string;
}

interface RunnerLogsCommandDependencies {
  fileExistsFn?: (filePath: string) => Promise<boolean>;
  openFileFn?: (filePath: string) => Promise<FileHandle>;
  pollIntervalMs?: number;
  readCurrentDaemonStateFn?: (stateDbPath: string) => Promise<CurrentDaemonState | null>;
  readFileFn?: (filePath: string) => Promise<string>;
  signal?: AbortSignal;
  stdout?: Writable;
}

class RunnerLogsCommand {
  private readonly fileExistsFn: (filePath: string) => Promise<boolean>;
  private readonly openFileFn: (filePath: string) => Promise<FileHandle>;
  private readonly pollIntervalMs: number;
  private readonly readCurrentDaemonStateFn: (stateDbPath: string) => Promise<CurrentDaemonState | null>;
  private readonly readFileFn: (filePath: string) => Promise<string>;
  private readonly signal?: AbortSignal;
  private readonly stdout: Writable;

  constructor(dependencies: RunnerLogsCommandDependencies = {}) {
    this.fileExistsFn = dependencies.fileExistsFn ?? defaultFileExists;
    this.openFileFn = dependencies.openFileFn ?? defaultOpenFile;
    this.pollIntervalMs = dependencies.pollIntervalMs ?? 100;
    this.readCurrentDaemonStateFn = dependencies.readCurrentDaemonStateFn ?? readCurrentDaemonState;
    this.readFileFn = dependencies.readFileFn ?? defaultReadFile;
    this.signal = dependencies.signal;
    this.stdout = dependencies.stdout ?? process.stdout;
  }

  async run(options: LogsCommandOptions): Promise<void> {
    const cfg = configSchema.parse({
      state_db_path: options.stateDbPath,
    });
    const logPath = await this.resolveLogPath(cfg.state_db_path);

    if (!(await this.fileExistsFn(logPath))) {
      this.stdout.write(`CompanyHelm runner log file not found at ${logPath}.\n`);
      return;
    }

    if (!options.live) {
      this.stdout.write(await this.readFileFn(logPath));
      return;
    }

    await this.followLogFile(logPath);
  }

  private async resolveLogPath(stateDbPath: string): Promise<string> {
    const state = await this.readCurrentDaemonStateFn(stateDbPath);
    return state?.logPath ?? resolveDaemonLogPath(stateDbPath);
  }

  private async followLogFile(logPath: string): Promise<void> {
    const fileHandle = await this.openFileFn(logPath);

    try {
      let offset = await this.writeAvailableContents(fileHandle, 0);

      while (!this.signal?.aborted) {
        try {
          await sleep(this.pollIntervalMs, undefined, this.signal ? { signal: this.signal } : undefined);
        } catch (error: unknown) {
          if (isAbortError(error)) {
            return;
          }
          throw error;
        }

        offset = await this.writeAvailableContents(fileHandle, offset);
      }
    } finally {
      await fileHandle.close();
    }
  }

  private async writeAvailableContents(fileHandle: FileHandle, offset: number): Promise<number> {
    const stats = await fileHandle.stat();
    let nextOffset = offset;

    if (stats.size < nextOffset) {
      nextOffset = 0;
    }

    const unreadBytes = stats.size - nextOffset;
    if (unreadBytes <= 0) {
      return nextOffset;
    }

    const buffer = Buffer.alloc(unreadBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, unreadBytes, nextOffset);
    if (bytesRead > 0) {
      this.stdout.write(buffer.subarray(0, bytesRead));
    }

    return nextOffset + bytesRead;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function defaultFileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultOpenFile(filePath: string): Promise<FileHandle> {
  return await open(filePath, "r");
}

async function defaultReadFile(filePath: string): Promise<string> {
  return await readFile(filePath, "utf8");
}

export async function runRunnerLogsCommand(
  options: LogsCommandOptions,
  dependencies?: RunnerLogsCommandDependencies,
): Promise<void> {
  await new RunnerLogsCommand(dependencies).run(options);
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Print the local CompanyHelm daemon log output.")
    .option("--live", "Keep streaming appended daemon log output.")
    .option("--state-db-path <path>", "State database path override (defaults to state.db under the active config directory).")
    .action(async (options: LogsCommandOptions) => {
      await runRunnerLogsCommand(options);
    });
}
