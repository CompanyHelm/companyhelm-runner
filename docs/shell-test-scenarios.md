# CompanyHelm CLI Shell Test Scenarios

**Purpose:** This document is a shared QA reference for manually testing the `shell` command behavior in CompanyHelm CLI.

**Audience:** QA testers, CLI maintainers, and reviewers validating shell command behavior and shell-related option handling.

**Preconditions:**
- Node.js version supported by the repo is installed.
- Testers have access to an environment where SDK configuration can be controlled.

---

## 1. Shell Command Behavior

### Scenario 1.1: Shell command fails with the current unsupported interactive-shell message

**Steps:**
1. Run the `shell` command in an environment where SDK prerequisites are already configured.

**Expected Results:**
- The command does not pretend to start a usable shell.
- The CLI returns the explicit unsupported-shell error.
- The error tells the user to use the daemon mode entrypoint.

### Scenario 1.2: Shell command fails early when SDK bootstrap prerequisites are missing

**Steps:**
1. Run the `shell` command in a clean environment with no configured SDKs.

**Expected Results:**
- The command fails cleanly.
- The message explains the missing SDK prerequisite.
- The command does not proceed into a misleading interactive state.

---

## 2. Shell and Daemon Option Alignment

### Scenario 2.1: Shell daemon override arguments remain aligned with root options

**Steps:**
1. Review the `shell` command behavior in relation to root command daemon options.
2. Confirm that supported root options intended for daemon startup remain available through the shell flow.
3. Confirm excluded options remain excluded where designed.

**Expected Results:**
- Supported daemon configuration options remain aligned with the root command.
- Hardcoded exclusions stay excluded.
- The shell wrapper behavior is internally consistent.

### Scenario 2.2: Help output for shell remains accurate

**Steps:**
1. Run help for the `shell` command.
2. Compare the help text to actual behavior.

**Expected Results:**
- Help output renders successfully.
- The described behavior is not materially misleading.
- No stale option or usage text is present.

---

## 3. Regression Checklist

1. Reproduce the original shell issue first.
2. Verify the current shell command behavior matches the intended product behavior.
3. Verify prerequisite failures remain clear.
4. Verify shell-related help output still matches reality.
