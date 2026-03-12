import type { Command } from "commander";
import { addRunnerStartOptions } from "./runner/common.js";
import { registerLogsCommand } from "./logs.js";
import { registerRunnerStartCommand } from "./runner/start.js";
import { registerRunnerStopCommand } from "./runner/stop.js";
import { runRunnerStartCommand } from "./runner/start.js";
import { registerShellCommand } from "./shell.js";
import { registerSdkCommands } from "./sdk/register-sdk-commands.js";
import { registerStatusCommand } from "./status.js";
import { registerThreadCommands } from "./thread/register-thread-commands.js";

export function registerCommands(program: Command): void {
  addRunnerStartOptions(
    program
      .command("companyhelm-runner")
      .description("Alias for starting the local CompanyHelm runner."),
  ).action(runRunnerStartCommand);
  registerRunnerStartCommand(program);
  registerRunnerStopCommand(program);
  registerStatusCommand(program);
  registerLogsCommand(program);
  registerThreadCommands(program);
  registerShellCommand(program);
  registerSdkCommands(program);
}
