import type { PreflightCheck, PreflightCheckResult, PreflightSummaryResult } from "./check.js";

export interface RunnerPreflightRunOptions {
  applyFixes?: boolean;
}

export interface RunnerPreflightSummary {
  passed: boolean;
  results: PreflightSummaryResult[];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RunnerPreflight {
  constructor(private readonly checks: PreflightCheck[]) {}

  async run(options: RunnerPreflightRunOptions = {}): Promise<RunnerPreflightSummary> {
    const results: PreflightSummaryResult[] = [];

    for (const check of this.checks) {
      results.push(await this.runCheck(check, options.applyFixes === true));
    }

    return {
      passed: results.every((result) => result.status !== "failed"),
      results,
    };
  }

  private async runCheck(check: PreflightCheck, applyFixes: boolean): Promise<PreflightSummaryResult> {
    let result = await this.safeRun(check);

    if (applyFixes && result.status === "failed" && result.fixAvailable) {
      try {
        await check.fix();
      } catch (error: unknown) {
        return {
          ...result,
          id: check.id,
          description: check.description,
          summary: `${result.summary} Fix attempt failed: ${toErrorMessage(error)}`,
        };
      }
      result = await this.safeRun(check);
    }

    return {
      ...result,
      id: check.id,
      description: check.description,
    };
  }

  private async safeRun(check: PreflightCheck): Promise<PreflightCheckResult> {
    try {
      return await check.run();
    } catch (error: unknown) {
      return {
        status: "failed",
        summary: `Check execution failed: ${toErrorMessage(error)}`,
        fixAvailable: false,
      };
    }
  }
}
