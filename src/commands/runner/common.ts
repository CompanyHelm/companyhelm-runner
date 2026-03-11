import type { Command } from "commander";
import { CONFIG_PATH_OPTION_DESCRIPTION } from "../global-options.js";

export interface RunnerStartCommandOptions {
  configPath?: string;
  serverUrl?: string;
  agentApiUrl?: string;
  daemon?: boolean;
  logLevel?: string;
  logPath?: string;
  secret?: string;
  stateDbPath?: string;
  useHostDockerRuntime?: boolean;
  useDedicatedAuth?: boolean;
  hostDockerPath?: string;
  threadGitSkillsDirectory?: string;
}

export interface RunnerStopCommandOptions {
  stateDbPath?: string;
}

export function addRunnerStartOptions(command: Command): Command {
  return command
    .option("--config-path <path>", CONFIG_PATH_OPTION_DESCRIPTION)
    .option("--server-url <url>", "CompanyHelm gRPC API URL override.")
    .option(
      "--agent-api-url <url>",
      "Agent gRPC API URL for companyhelm-agent in runtime containers (localhost is rewritten to http://host.docker.internal).",
    )
    .option("--secret <secret>", "Bearer secret used as gRPC Authorization header.")
    .option("--state-db-path <path>", "State database path override (defaults to state.db under the active config directory).")
    .option("--log-path <path>", "Daemon log file override.")
    .option(
      "--use-host-docker-runtime",
      "Mount host Docker socket into runtime containers instead of creating DinD sidecars.",
    )
    .option(
      "--use-dedicated-auth",
      "Preserve existing dedicated Codex auth if already configured; otherwise keep Codex unconfigured on startup.",
    )
    .option(
      "--host-docker-path <path>",
      "Host Docker endpoint when --use-host-docker-runtime is enabled (unix:///<socket-path> or tcp://localhost:<port>).",
    )
    .option(
      "--thread-git-skills-directory <path>",
      "Container path where thread git skill repositories are cloned before linking into ~/.codex/skills.",
    )
    .option("-d, --daemon", "Run in daemon mode and fail fast when no SDK is configured.")
    .option("--log-level <level>", "Log level (DEBUG, INFO, WARN, ERROR).", "INFO");
}
