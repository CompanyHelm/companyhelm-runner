import assert from "node:assert/strict";
import { Command } from "commander";
import { addGlobalOptions, applyGlobalOptionEnvironment } from "../../dist/commands/global-options.js";
import { CONFIG_PATH_ENV } from "../../dist/config.js";

test("root --config-path is available to nested subcommands and overrides the config env var", async () => {
  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = "/tmp/companyhelm-from-env";

  const program = addGlobalOptions(new Command());
  let observedConfigPath: string | undefined;
  let observedGlobalOption: string | undefined;

  program.hook("preAction", (_thisCommand, actionCommand) => {
    applyGlobalOptionEnvironment(actionCommand);
  });

  program
    .command("sdk")
    .command("codex")
    .command("use-host-auth")
    .action((_options, command) => {
      observedConfigPath = process.env[CONFIG_PATH_ENV];
      observedGlobalOption = command.optsWithGlobals().configPath as string | undefined;
    });

  try {
    await program.parseAsync([
      "node",
      "companyhelm-runner",
      "--config-path",
      "/tmp/companyhelm-from-cli",
      "sdk",
      "codex",
      "use-host-auth",
    ]);

    assert.equal(observedGlobalOption, "/tmp/companyhelm-from-cli");
    assert.equal(observedConfigPath, "/tmp/companyhelm-from-cli");
  } finally {
    if (previous === undefined) {
      delete process.env[CONFIG_PATH_ENV];
    } else {
      process.env[CONFIG_PATH_ENV] = previous;
    }
  }
});
