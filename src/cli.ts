#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { addGlobalOptions, applyGlobalOptionEnvironment } from "./commands/global-options.js";
import { registerCommands } from "./commands/register-commands.js";

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("companyhelm-runner")
  .description("Run the CompanyHelm runner in fully isolated Docker sandboxes.")
  .version(getVersion());

addGlobalOptions(program);
registerCommands(program);
program.hook("preAction", (_thisCommand, actionCommand) => {
  applyGlobalOptionEnvironment(actionCommand);
});

function formatCliError(error: unknown): { message: string; exitCode: number } {
  if (error instanceof CommanderError) {
    return {
      message: error.message,
      exitCode: error.exitCode,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      exitCode: 1,
    };
  }

  return {
    message: String(error),
    exitCode: 1,
  };
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error: unknown) {
    const { message, exitCode } = formatCliError(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = exitCode;
  }
}

void main();
