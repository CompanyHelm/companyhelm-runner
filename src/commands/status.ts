import type { Command } from "commander";
import { dirname } from "node:path";
import { config as configSchema } from "../config.js";
import { readCurrentDaemonState } from "../state/daemon_state.js";
import { resolveDaemonLogDirectory, resolveDaemonLogPath } from "../utils/daemon.js";
import { isProcessRunning } from "../utils/process.js";

interface StatusCommandOptions {
  stateDbPath?: string;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show whether the local CompanyHelm daemon is running.")
    .option("--state-db-path <path>", "State database path override (defaults to state.db under the active config directory).")
    .action(async (options: StatusCommandOptions) => {
      const cfg = configSchema.parse({
        state_db_path: options.stateDbPath,
      });
      const state = await readCurrentDaemonState(cfg.state_db_path);
      const running = state?.pid != null && isProcessRunning(state.pid);
      const logPath = state?.logPath ?? resolveDaemonLogPath(cfg.state_db_path);
      const logDirectory = state?.logPath ? dirname(state.logPath) : resolveDaemonLogDirectory(cfg.state_db_path);

      console.log(`Daemon: ${running ? "running" : "not running"}`);
      if (state?.pid != null) {
        console.log(`PID: ${running ? state.pid : `${state.pid} (stale)`}`);
      } else {
        console.log("PID: none");
      }
      console.log(`Log directory: ${logDirectory}`);
      console.log(`Log file: ${logPath}`);
    });
}
