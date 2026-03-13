export type PreflightCheckStatus = "passed" | "failed" | "skipped";
export type PreflightFixStatus = "fixed" | "skipped";

export interface PreflightCheckResult {
  status: PreflightCheckStatus;
  summary: string;
  fixAvailable: boolean;
}

export interface PreflightFixResult {
  status: PreflightFixStatus;
  summary: string;
}

export interface PreflightSummaryResult extends PreflightCheckResult {
  id: string;
  description: string;
}

export interface PreflightCheck {
  readonly id: string;
  readonly description: string;
  run(): Promise<PreflightCheckResult>;
  fix(): Promise<PreflightFixResult>;
}
