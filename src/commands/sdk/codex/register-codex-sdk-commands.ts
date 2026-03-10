import type { Command } from "commander";
import { registerSdkCodexUseDedicatedAuthCommand } from "./use-dedicated-auth.js";
import { registerSdkCodexUseHostAuthCommand } from "./use-host-auth.js";

export function registerCodexSdkCommands(sdkCommand: Command): void {
  const codexCommand = sdkCommand
    .command("codex")
    .description("Manage Codex SDK authentication.");

  registerSdkCodexUseHostAuthCommand(codexCommand);
  registerSdkCodexUseDedicatedAuthCommand(codexCommand);
}
