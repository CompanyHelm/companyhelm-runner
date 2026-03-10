import type { Command } from "commander";
import { CONFIG_PATH_ENV, DEFAULT_CONFIG_DIRECTORY } from "../config.js";

export const CONFIG_PATH_OPTION_DESCRIPTION =
  `Config directory override (defaults to $${CONFIG_PATH_ENV} or ${DEFAULT_CONFIG_DIRECTORY}).`;

export function addGlobalOptions(program: Command): Command {
  return program.option("--config-path <path>", CONFIG_PATH_OPTION_DESCRIPTION);
}

export function applyGlobalOptionEnvironment(command: Command): void {
  const options = command.optsWithGlobals() as { configPath?: unknown };
  if (typeof options.configPath !== "string") {
    return;
  }

  const configPath = options.configPath.trim();
  if (configPath.length > 0) {
    process.env[CONFIG_PATH_ENV] = configPath;
  }
}
