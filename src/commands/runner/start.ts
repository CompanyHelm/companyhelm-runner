import type { Command } from "commander";
import {
  runDetachedDaemonProcess,
  runRootCommand,
  sendDaemonParentMessage,
  isInternalDaemonChildProcess,
  toErrorMessage,
} from "../root.js";
import { addRunnerStartOptions, type RunnerStartCommandOptions } from "./common.js";

export function registerRunnerStartCommand(runnerCommand: Command): void {
  addRunnerStartOptions(
    runnerCommand
      .command("start")
      .description("Start the local CompanyHelm runner daemon."),
  ).action(async (options: RunnerStartCommandOptions) => {
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
          }
        : undefined);
    } catch (error: unknown) {
      if (isInternalDaemonChildProcess()) {
        sendDaemonParentMessage({ type: "daemon-error", message: toErrorMessage(error) });
      }
      throw error;
    }
  });
}
