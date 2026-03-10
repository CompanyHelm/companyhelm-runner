# CompanyHelm CLI Bootstrap and Config Test Scenarios

**Purpose:** This document is a shared QA reference for manually testing CompanyHelm CLI bootstrap and configuration behavior.

**Audience:** QA testers, CLI maintainers, and reviewers validating startup, config handling, and authentication bootstrap behavior.

**Preconditions:**
- Node.js version supported by the repo is installed.
- Docker is available when testing dedicated authentication or runtime flows that depend on containers.
- Testers have access to a stable environment with predictable config and seed data where needed.

---

## 1. Installation and Basic Invocation

### Scenario 1.1: Install the CLI successfully

**Steps:**
1. Install the package globally or run it through `npx`.
2. Confirm the executable is available in the shell.

**Expected Results:**
- The install completes without dependency or permission errors.
- The CLI command is available to run.

### Scenario 1.2: Help output is available

**Steps:**
1. Run the top-level help command.
2. Run help for subcommands relevant to bootstrap and config behavior.

**Expected Results:**
- Help output renders without crashing.
- Each command shows a readable description.
- Options and required arguments are visible.

### Scenario 1.3: Version output works

**Steps:**
1. Run the version command.

**Expected Results:**
- The CLI prints a version string.
- The command exits successfully.

---

## 2. First-Time Bootstrap

### Scenario 2.1: First-time startup bootstraps local state

**Steps:**
1. Run the root CLI command in a clean environment with no configured SDKs.
2. Observe startup output and prompts.

**Expected Results:**
- The CLI initializes local state without crashing.
- Startup output is readable.
- The user is guided into the authentication or bootstrap flow.

### Scenario 2.2: Host-auth bootstrap path works when host credentials exist

**Steps:**
1. Ensure the configured host Codex auth file exists.
2. Run the CLI in a clean environment with no SDK configured.
3. Choose the host authentication option when prompted.

**Expected Results:**
- The host authentication option is offered.
- Startup completes successfully.
- The CLI records Codex as configured.

### Scenario 2.3: Dedicated-auth bootstrap path handles cancellation and success correctly

**Steps:**
1. Run the CLI in a clean environment with no SDK configured.
2. Choose dedicated authentication.
3. Test both paths:
   - cancel before auth completes
   - complete the auth flow successfully

**Expected Results:**
- On cancel, the CLI exits cleanly with a clear message.
- On success, credentials are saved in the configured location.
- The SDK is recorded and model refresh proceeds.

### Scenario 2.4: Existing SDK configuration skips bootstrap

**Steps:**
1. Run the root CLI command in an environment where SDK setup already exists.

**Expected Results:**
- The CLI recognizes the configured SDK state.
- The bootstrap prompt is skipped.
- Startup proceeds without re-running first-time setup.

---

## 3. Config Overrides

### Scenario 3.1: Start with valid config overrides

**Steps:**
1. Run the root command with one or more supported overrides, such as:
   - config path
   - server URL
   - state DB path
   - log level
2. Observe startup behavior.

**Expected Results:**
- The CLI accepts valid overrides.
- The command uses the provided values instead of defaults.
- No unexpected validation error appears for valid input.

### Scenario 3.2: Invalid configuration fails clearly

**Steps:**
1. Run the root command with an invalid or unreachable configuration value.
2. Repeat with a malformed URL or invalid file path where relevant.

**Expected Results:**
- The CLI fails cleanly.
- The error message explains what is wrong.
- The process exits without hanging.

### Scenario 3.3: Custom state DB path works

**Steps:**
1. Run a command that reads local state with `--state-db-path <path>`.
2. Repeat with a different valid path.

**Expected Results:**
- The CLI reads from the specified state DB path.
- Output changes accordingly if the underlying data differs.

### Scenario 3.4: Invalid state DB path fails clearly

**Steps:**
1. Run a command with a bad or inaccessible state DB path.

**Expected Results:**
- The CLI fails cleanly.
- The error identifies the path or access problem.

---

## 4. Daemon Startup Preconditions

### Scenario 4.1: Daemon mode failure path is clear

**Steps:**
1. Run the CLI in daemon mode in an environment that is intentionally missing required SDK setup.

**Expected Results:**
- The CLI fails fast if that is the intended behavior.
- The error explains the missing prerequisite.

### Scenario 4.2: Log level changes output behavior

**Steps:**
1. Run a representative startup command with default logging.
2. Run the same command with a more verbose log level.

**Expected Results:**
- The verbose run includes more detail.
- Output remains readable and does not corrupt primary command results.

---

## 5. Regression Checklist

1. Reproduce the original bootstrap or config issue first.
2. Verify the exact startup or config path now works.
3. Verify invalid-input handling still fails clearly.
4. Re-run one adjacent startup path to catch regressions.
