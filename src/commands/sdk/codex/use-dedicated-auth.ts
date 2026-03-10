import type { Command } from "commander";
import { config as configSchema, type Config } from "../../../config.js";
import {
  defaultUseDedicatedCodexAuthDependencies,
  runUseDedicatedCodexAuth,
  type UseDedicatedCodexAuthDependencies,
} from "./auth.js";

export async function runSdkCodexUseDedicatedAuthCommand(
  cfg: Config = configSchema.parse({}),
  overrides: Partial<UseDedicatedCodexAuthDependencies> = {},
): Promise<void> {
  const deps: UseDedicatedCodexAuthDependencies = { ...defaultUseDedicatedCodexAuthDependencies, ...overrides };
  await runUseDedicatedCodexAuth(cfg, deps);
}

export function registerSdkCodexUseDedicatedAuthCommand(codexCommand: Command): void {
  codexCommand
    .command("use-dedicated-auth")
    .description("Configure the Codex SDK to use dedicated authentication.")
    .action(async () => {
      await runSdkCodexUseDedicatedAuthCommand();
    });
}
