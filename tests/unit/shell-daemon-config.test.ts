import assert from "node:assert/strict";
import { Command } from "commander";
import { registerRunnerCommands } from "../../dist/commands/runner/register-runner-commands.js";
import {
  buildShellDaemonOverrideArgs,
  getShellConfigurableDaemonOptions,
} from "../../dist/commands/shell.js";

test("shell exposes daemon CLI overrides except hardcoded daemon/serverUrl/secret", () => {
  const program = new Command();
  registerRunnerCommands(program);

  const options = getShellConfigurableDaemonOptions(program);
  const optionNames = options.map((option) => option.name);

  assert.deepEqual(optionNames, [
    "configPath",
    "agentApiUrl",
    "stateDbPath",
    "logPath",
    "useHostDockerRuntime",
    "useDedicatedAuth",
    "hostDockerPath",
    "threadGitSkillsDirectory",
    "logLevel",
  ]);
});

test("shell builds daemon override args from selected option values", () => {
  const program = new Command();
  registerRunnerCommands(program);
  const options = getShellConfigurableDaemonOptions(program);

  const args = buildShellDaemonOverrideArgs(options, {
    configPath: "/tmp/companyhelm-config",
    agentApiUrl: "localhost:15052",
    stateDbPath: "/tmp/companyhelm-state.db",
    logPath: "/tmp/companyhelm-daemon.log",
    useHostDockerRuntime: true,
    useDedicatedAuth: true,
    hostDockerPath: "unix:///tmp/custom-docker.sock",
    threadGitSkillsDirectory: "/tmp/thread-skills",
    logLevel: "DEBUG",
  });

  assert.deepEqual(args, [
    "--config-path",
    "/tmp/companyhelm-config",
    "--agent-api-url",
    "localhost:15052",
    "--state-db-path",
    "/tmp/companyhelm-state.db",
    "--log-path",
    "/tmp/companyhelm-daemon.log",
    "--use-host-docker-runtime",
    "--use-dedicated-auth",
    "--host-docker-path",
    "unix:///tmp/custom-docker.sock",
    "--thread-git-skills-directory",
    "/tmp/thread-skills",
    "--log-level",
    "DEBUG",
  ]);
});
