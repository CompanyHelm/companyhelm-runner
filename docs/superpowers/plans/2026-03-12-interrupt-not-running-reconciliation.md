# Interrupt Not-Running Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make interrupt requests idempotent when a thread is already stopped by reconciling runner and API state back to not-running instead of returning errors.

**Architecture:** Broaden the runner's existing no-running-turn interrupt recovery path so equivalent Chat/app-server failures are treated as successful reconciliation, then add an API-side cleanup path that clears all stale running turn rows whenever the thread row is already non-running. Cover both sides with targeted regression tests written before production changes.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM, GraphQL resolver and gRPC server tests

---

### Task 1: Add failing runner regressions

**Files:**
- Modify: `tests/unit/root-user-message-routing.test.ts`
- Modify: `src/commands/root.ts`

- [ ] **Step 1: Write a unit test that proves the current interrupt error matcher should accept the broader Chat/app-server no-running-turn wording**

- [ ] **Step 2: Run the targeted unit test to verify it fails before implementation**

### Task 2: Implement runner reconciliation

**Files:**
- Modify: `src/commands/root.ts`
- Test: `tests/unit/root-user-message-routing.test.ts`

- [ ] **Step 1: Broaden the no-running-turn interrupt error matcher to cover equivalent Chat/app-server wording**

- [ ] **Step 2: Change the interrupt reconciliation path to log a warning while still persisting `isCurrentTurnRunning=false` and emitting ready/completed updates**

- [ ] **Step 3: Run the targeted runner unit test to verify it passes**

### Task 3: Add failing API regressions

**Files:**
- Modify: `tests/grpc.runner-server.user-message-queue.test.ts`
- Modify: `src/grpc/runner-server.ts`

- [ ] **Step 1: Add a unit test showing that `interruptTurnForThread(...)` should succeed when the thread row is already non-running and stale running turns still exist**

- [ ] **Step 2: Verify the targeted API test fails because the current code throws `has no running turn to interrupt`**

### Task 4: Implement API cleanup

**Files:**
- Modify: `src/grpc/runner-server.ts`
- Test: `tests/grpc.runner-server.user-message-queue.test.ts`

- [ ] **Step 1: Add a helper that completes every running turn row for a non-running thread and publishes turn updates**

- [ ] **Step 2: Use that helper from `interruptTurnForThread(...)` before the existing throw path so non-running threads reconcile and return success**

- [ ] **Step 3: Run the targeted API test to verify it passes**

### Task 5: Verify and prepare PRs

**Files:**
- Modify: `docs/superpowers/specs/2026-03-12-interrupt-not-running-reconciliation-design.md`
- Modify: `docs/superpowers/plans/2026-03-12-interrupt-not-running-reconciliation.md`

- [ ] **Step 1: Run the focused runner and API test commands covering the changed behavior**

- [ ] **Step 2: Inspect `companyhelm-common` e2e helpers and confirm no shared e2e updates are needed**

- [ ] **Step 3: Fetch and rebase each repo onto `origin/main`**

- [ ] **Step 4: Commit the repo changes, push branches, create PRs, and wait for checks**
