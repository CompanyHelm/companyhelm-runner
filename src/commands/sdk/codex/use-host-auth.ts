import type { Command } from "commander";
import { config as configSchema, type Config } from "../../../config.js";
import {
  defaultSetCodexHostAuthDependencies,
  runSetCodexHostAuth,
  type SetCodexHostAuthDependencies,
} from "./auth.js";

export async function runSdkCodexUseHostAuthCommand(
  cfg: Config = configSchema.parse({}),
  overrides: Partial<SetCodexHostAuthDependencies> = {},
): Promise<void> {
  cfg = configSchema.parse(cfg);
  const deps: SetCodexHostAuthDependencies = { ...defaultSetCodexHostAuthDependencies, ...overrides };
  const authPath = await runSetCodexHostAuth(cfg, deps);
  console.log(`Codex SDK configured with host authentication using ${authPath}.`);
}

export function registerSdkCodexUseHostAuthCommand(codexCommand: Command): void {
  codexCommand
    .command("use-host-auth")
    .description("Configure the Codex SDK to use host authentication.")
    .action(async () => {
      await runSdkCodexUseHostAuthCommand();
    });
}
