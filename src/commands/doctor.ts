import type { Writable } from "node:stream";
import type { Command } from "commander";
import { config as configSchema, type Config } from "../config.js";
import {
  formatRunnerPreflightSummary,
  runRunnerPreflight,
  type RunRunnerPreflightOptions,
} from "../preflight/entrypoints.js";
import type { RunnerPreflightSummary } from "../preflight/runner_preflight.js";

export interface DoctorCommandOptions {
  fix?: boolean;
}

interface RunnerDoctorCommandDependencies {
  stdout?: Writable;
  runPreflightFn?: (options: RunRunnerPreflightOptions) => Promise<RunnerPreflightSummary>;
}

class RunnerDoctorCommand {
  private readonly stdout: Writable;
  private readonly runPreflightFn: (options: RunRunnerPreflightOptions) => Promise<RunnerPreflightSummary>;

  constructor(dependencies: RunnerDoctorCommandDependencies = {}) {
    this.stdout = dependencies.stdout ?? process.stdout;
    this.runPreflightFn = dependencies.runPreflightFn ?? runRunnerPreflight;
  }

  async run(options: DoctorCommandOptions): Promise<RunnerPreflightSummary> {
    const cfg = configSchema.parse({}) as Config;
    const summary = await this.runPreflightFn({
      cfg,
      applyFixes: options.fix === true,
    });

    this.stdout.write(`${formatRunnerPreflightSummary(summary)}\n`);
    return summary;
  }
}

export async function runRunnerDoctorCommand(
  options: DoctorCommandOptions,
  dependencies?: RunnerDoctorCommandDependencies,
): Promise<RunnerPreflightSummary> {
  return await new RunnerDoctorCommand(dependencies).run(options);
}

export function registerDoctorCommand(program: Command): void {
  const doctorCommand = program
    .command("doctor")
    .description("Run runner host preflight checks.");

  doctorCommand.action(async () => {
    const summary = await runRunnerDoctorCommand({ fix: false });
    if (!summary.passed) {
      process.exitCode = 1;
    }
  });

  doctorCommand
    .command("fix")
    .description("Attempt to fix supported runner host preflight failures.")
    .action(async () => {
      const summary = await runRunnerDoctorCommand({ fix: true });
      if (!summary.passed) {
        process.exitCode = 1;
      }
    });
}
