import assert from "node:assert/strict";
import { Command } from "commander";
import { registerRunnerCommands } from "../../dist/commands/runner/register-runner-commands.js";
import {
  buildShellDaemonOverrideArgs,
  getShellConfigurableDaemonOptions,
  parseShellCommand,
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

test("shell parses DB inspection commands and aliases", () => {
  assert.deepEqual(parseShellCommand("list threads"), { type: "list-threads" });
  assert.deepEqual(parseShellCommand("threads"), { type: "list-threads" });
  assert.deepEqual(parseShellCommand("thread status thread-123"), {
    type: "thread-status",
    threadId: "thread-123",
  });
  assert.deepEqual(parseShellCommand("status thread-456"), {
    type: "thread-status",
    threadId: "thread-456",
  });
  assert.deepEqual(parseShellCommand("list containers"), { type: "list-containers" });
  assert.deepEqual(parseShellCommand("show daemon"), { type: "show-daemon" });
  assert.deepEqual(parseShellCommand("quit"), { type: "exit" });
});

test("shell reports unknown commands when parsing fails", () => {
  assert.deepEqual(parseShellCommand("unsupported command"), {
    type: "unknown",
    input: "unsupported command",
  });
});
