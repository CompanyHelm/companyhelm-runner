import type { Command } from "commander";
import { registerRunnerStartCommand } from "./start.js";
import { registerRunnerStopCommand } from "./stop.js";

export function registerRunnerCommands(program: Command): void {
  const runnerCommand = program
    .command("runner")
    .description("Manage the local CompanyHelm runner daemon.");

  registerRunnerStartCommand(runnerCommand);
  registerRunnerStopCommand(runnerCommand);
}
