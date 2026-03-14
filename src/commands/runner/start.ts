import type { Command } from "commander";
import {
  runDetachedDaemonProcess,
  runRootCommand,
  sendDaemonParentMessage,
  isInternalDaemonChildProcess,
  toErrorMessage,
} from "../root.js";
import { addRunnerStartOptions, type RunnerStartCommandOptions } from "./common.js";

export async function runRunnerStartCommand(options: RunnerStartCommandOptions): Promise<void> {
  if (options.daemon && !isInternalDaemonChildProcess()) {
    await runDetachedDaemonProcess(options);
    return;
  }

  try {
    await runRootCommand(options, isInternalDaemonChildProcess()
      ? {
          onDaemonReady: () => {
            sendDaemonParentMessage({ type: "daemon-ready" });
          },
          onDaemonProgress: (message: string) => {
            sendDaemonParentMessage({ type: "daemon-progress", message });
          },
        }
      : undefined);
  } catch (error: unknown) {
    if (isInternalDaemonChildProcess()) {
      sendDaemonParentMessage({ type: "daemon-error", message: toErrorMessage(error) });
    }
    throw error;
  }
}

export function registerRunnerStartCommand(runnerCommand: Command): void {
  addRunnerStartOptions(
    runnerCommand
      .command("start")
      .description("Start the local CompanyHelm runner daemon."),
  ).action(runRunnerStartCommand);
}
