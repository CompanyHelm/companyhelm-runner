import type { Command } from "commander";
import { config as configSchema } from "../../config.js";
import { clearCurrentDaemonState, readCurrentDaemonState } from "../../state/daemon_state.js";
import { isProcessRunning } from "../../utils/process.js";
import { toErrorMessage } from "../root.js";
import type { RunnerStopCommandOptions } from "./common.js";

const RUNNER_STOP_TIMEOUT_MS = 15_000;

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessRunning(pid);
}

export async function runRunnerStopCommand(options: RunnerStopCommandOptions): Promise<void> {
  const cfg = configSchema.parse({
    state_db_path: options.stateDbPath,
  });
  const state = await readCurrentDaemonState(cfg.state_db_path);

  if (!state?.pid) {
    console.log("CompanyHelm runner is not running.");
    return;
  }

  if (!isProcessRunning(state.pid)) {
    await clearCurrentDaemonState(cfg.state_db_path, state.pid);
    console.log(`CompanyHelm runner was not running. Cleared stale pid ${state.pid}.`);
    return;
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch (error: unknown) {
    throw new Error(`Failed to stop CompanyHelm runner pid ${state.pid}: ${toErrorMessage(error)}`);
  }

  const stopped = await waitForProcessExit(state.pid, RUNNER_STOP_TIMEOUT_MS);
  if (!stopped) {
    throw new Error(`Timed out waiting for CompanyHelm runner pid ${state.pid} to stop.`);
  }

  await clearCurrentDaemonState(cfg.state_db_path, state.pid);
  console.log(`CompanyHelm runner stopped (pid ${state.pid}).`);
}

export function registerRunnerStopCommand(runnerCommand: Command): void {
  runnerCommand
    .command("stop")
    .description("Stop the local CompanyHelm runner daemon.")
    .option("--state-db-path <path>", "State database path override (defaults to state.db under the active config directory).")
    .action(async (options: RunnerStopCommandOptions) => {
      await runRunnerStopCommand(options);
    });
}
