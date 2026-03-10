import type { Command } from "commander";
import { registerRunnerCommands } from "./runner/register-runner-commands.js";
import { registerShellCommand } from "./shell.js";
import { registerSdkCommands } from "./sdk/register-sdk-commands.js";
import { registerStatusCommand } from "./status.js";
import { registerThreadCommands } from "./thread/register-thread-commands.js";

export function registerCommands(program: Command): void {
  registerRunnerCommands(program);
  registerStatusCommand(program);
  registerThreadCommands(program);
  registerShellCommand(program);
  registerSdkCommands(program);
}
