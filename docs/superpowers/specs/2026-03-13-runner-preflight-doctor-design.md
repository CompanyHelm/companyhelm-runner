# Runner Preflight Doctor Design

## Goal

Add a reusable runner preflight framework, a Linux AppArmor rootless-DinD compatibility check, and a `doctor` command so startup can fail fast on incompatible hosts while users still have an explicit remediation path.

## Design

- Introduce `src/preflight/` as the single home for host checks.
- Keep the check contract minimal: each check is a class with `run()` and `fix()`.
- Add a `RunnerPreflight` orchestrator that runs checks, optionally applies fixes, and reruns checks after fixes.
- Add a Linux-specific `LinuxApparmorRestrictUnprivilegedUsernsCheck` under `src/preflight/checks/linux/`.
- Wire `companyhelm-runner start` through startup preflight so rootless DinD host issues fail before normal daemon bootstrap.
- Add `companyhelm-runner doctor` and `companyhelm-runner doctor fix` as explicit operator-facing entrypoints.

## Error Handling

- Individual check execution failures are surfaced as failed preflight results rather than crashing the orchestrator.
- `doctor` prints the full summary and exits nonzero when blocking failures remain.
- `start` throws a targeted error that includes the summary plus guidance to run `doctor` or `doctor fix`.

## Testing

- Add unit coverage for the orchestrator fix flow.
- Add unit coverage for the Linux AppArmor check run/fix behavior.
- Add CLI help coverage for the new `doctor` root command.
