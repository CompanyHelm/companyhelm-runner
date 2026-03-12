# Runner Logs Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root `logs` command that prints the runner daemon log file and optionally follows appended output.

**Architecture:** Register a new root command in the existing CLI command registry and implement the behavior in a dedicated command module. The command will reuse the current config and daemon state resolution path, then use native filesystem reads plus polling for live-follow mode.

**Tech Stack:** TypeScript, Commander, Node fs/promises, Vitest

---

## Chunk 1: Tests First

### Task 1: Add failing command tests

**Files:**
- Create: `tests/unit/logs.test.ts`
- Modify: `tests/unit/cli-identity.test.ts`
- Test: `tests/unit/logs.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that cover:
- root help output includes `logs`
- default mode prints full log contents
- missing file prints a friendly message
- live mode prints initial contents and appended bytes

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/logs.test.ts`
Expected: FAIL because the `logs` command module does not exist yet.

## Chunk 2: Minimal Implementation

### Task 2: Register and implement the command

**Files:**
- Create: `src/commands/logs.ts`
- Modify: `src/commands/register-commands.ts`
- Test: `tests/unit/logs.test.ts`

- [ ] **Step 1: Add the command module**

Implement a `RunnerLogsCommand` class that:
- resolves config/state DB path
- resolves the daemon log path from state or fallback path
- prints a friendly message if the log file is absent
- prints full contents by default
- follows appended bytes when `--live` is passed

- [ ] **Step 2: Register the root command**

Wire `registerLogsCommand(program)` into the root command registry.

- [ ] **Step 3: Run the test to verify it passes**

Run: `npm run test:unit -- tests/unit/logs.test.ts tests/unit/cli-identity.test.ts`
Expected: PASS

## Chunk 3: Verification

### Task 3: Validate the repo

**Files:**
- Check: `companyhelm-common` e2e helpers for any required changes

- [ ] **Step 1: Run targeted unit tests**

Run: `npm run test:unit -- tests/unit/logs.test.ts tests/unit/cli-identity.test.ts`
Expected: PASS

- [ ] **Step 2: Run the repo unit suite**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 3: Review shared e2e helpers**

Inspect `companyhelm-common` e2e scripts and confirm no changes are needed for this CLI-only feature.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-03-12-runner-logs-design.md docs/superpowers/plans/2026-03-12-runner-logs.md src/commands/logs.ts src/commands/register-commands.ts tests/unit/logs.test.ts tests/unit/cli-identity.test.ts
git commit -m "feat: add runner logs command"
```
