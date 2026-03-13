import type { Command } from "commander";
import { registerDoctorCommand } from "./doctor.js";
import { registerLogsCommand } from "./logs.js";
import { registerRunnerStartCommand } from "./runner/start.js";
import { registerRunnerStopCommand } from "./runner/stop.js";
import { registerShellCommand } from "./shell.js";
import { registerSdkCommands } from "./sdk/register-sdk-commands.js";
import { registerStatusCommand } from "./status.js";
import { registerThreadCommands } from "./thread/register-thread-commands.js";

export function registerCommands(program: Command): void {
  registerRunnerStartCommand(program);
  registerRunnerStopCommand(program);
  registerDoctorCommand(program);
  registerStatusCommand(program);
  registerLogsCommand(program);
  registerThreadCommands(program);
  registerShellCommand(program);
  registerSdkCommands(program);
}
