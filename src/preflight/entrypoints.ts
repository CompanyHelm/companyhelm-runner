import type { Config } from "../config.js";
import type { PreflightSummaryResult } from "./check.js";
import { LinuxApparmorRestrictUnprivilegedUsernsCheck } from "./checks/linux/apparmor_restrict_unprivileged_userns_check.js";
import { RunnerPreflight, type RunnerPreflightSummary } from "./runner_preflight.js";

interface RunnerPreflightDependencyOverrides {
  platform?: NodeJS.Platform;
  readSysctlValue?: (key: string) => Promise<string | null>;
  runShellCommand?: (command: string) => Promise<void>;
}

export interface RunRunnerPreflightOptions {
  cfg: Config;
  applyFixes?: boolean;
}

function renderPreflightStatusLabel(status: PreflightSummaryResult["status"]): string {
  if (status === "passed") {
    return "PASS";
  }
  if (status === "failed") {
    return "FAIL";
  }
  return "SKIP";
}

export function createRunnerPreflight(
  cfg: Config,
  overrides: RunnerPreflightDependencyOverrides = {},
): RunnerPreflight {
  return new RunnerPreflight([
    new LinuxApparmorRestrictUnprivilegedUsernsCheck(cfg, overrides),
  ]);
}

export async function runRunnerPreflight(
  options: RunRunnerPreflightOptions,
  overrides: RunnerPreflightDependencyOverrides = {},
): Promise<RunnerPreflightSummary> {
  return await createRunnerPreflight(options.cfg, overrides).run({ applyFixes: options.applyFixes });
}

export function formatRunnerPreflightSummary(summary: RunnerPreflightSummary): string {
  const lines = [`Preflight status: ${summary.passed ? "passed" : "failed"}`];
  if (summary.results.length === 0) {
    lines.push("No applicable preflight checks.");
    return lines.join("\n");
  }

  for (const result of summary.results) {
    lines.push(`[${renderPreflightStatusLabel(result.status)}] ${result.id}: ${result.summary}`);
  }
  return lines.join("\n");
}

export async function ensureRunnerStartupPreflight(
  cfg: Config,
  overrides: RunnerPreflightDependencyOverrides = {},
): Promise<void> {
  const summary = await runRunnerPreflight({ cfg }, overrides);
  if (summary.passed) {
    return;
  }

  throw new Error(
    `${formatRunnerPreflightSummary(summary)}\n` +
    "Run `companyhelm-runner doctor` for details or `companyhelm-runner doctor fix` to try automatic fixes.",
  );
}
