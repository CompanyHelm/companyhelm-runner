# CompanyHelm CLI Shell Test Scenarios

**Purpose:** This document is a shared QA reference for manually testing the interactive `shell` command in CompanyHelm Runner.

**Audience:** QA testers, CLI maintainers, and reviewers validating state DB inspection behavior.

**Preconditions:**
- Node.js version supported by the repo is installed.
- A state DB exists, or the tester is comfortable inspecting an empty DB shell.

---

## 1. Shell Startup

### Scenario 1.1: Shell starts without SDK bootstrap prerequisites

**Steps:**
1. Run `companyhelm-runner shell` in a clean environment.

**Expected Results:**
- The command opens the interactive shell instead of failing on SDK configuration.
- The shell prints the resolved state DB path.
- The shell shows the available inspection commands.

### Scenario 1.2: Help output remains accurate

**Steps:**
1. Run `companyhelm-runner shell`.
2. Run `help`.

**Expected Results:**
- The shell lists the supported commands.
- The help text matches the current read-only DB inspection behavior.

---

## 2. DB Inspection Commands

### Scenario 2.1: List threads

**Steps:**
1. Run `companyhelm-runner shell`.
2. Enter `list threads`.

**Expected Results:**
- The shell prints thread rows from the local state DB.
- Empty DBs report no thread rows cleanly.

### Scenario 2.2: Inspect a single thread

**Steps:**
1. Run `companyhelm-runner shell`.
2. Enter `thread status <thread-id>` for a known thread.

**Expected Results:**
- The shell prints the full DB row for the selected thread.
- Unknown thread IDs return a clear not-found message.

### Scenario 2.3: List containers

**Steps:**
1. Run `companyhelm-runner shell`.
2. Enter `list containers`.

**Expected Results:**
- The shell prints per-thread runtime and DinD container fields from the DB.
- The output includes thread IDs so container rows are attributable.

### Scenario 2.4: Show daemon state

**Steps:**
1. Run `companyhelm-runner shell`.
2. Enter `show daemon`.

**Expected Results:**
- The shell prints the `daemon_state` row when present.
- Empty daemon state reports cleanly without crashing.

---

## 3. Regression Checklist

1. Verify the shell still exits cleanly with `exit` or `quit`.
2. Verify `shell --help` describes the read-only DB inspector.
3. Verify the shell works both with the default DB path and with `--state-db-path`.
