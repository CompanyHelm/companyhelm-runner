# Stale Running Turn Self-Heal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the runner recover from stale `isCurrentTurnRunning` state so non-running threads no longer reject new user messages with `allowSteer=false`.

**Architecture:** Add a cheap startup reconciliation pass that only clears obviously stale running flags when the runtime container is not running or the persisted running-turn identifiers are incomplete. Add a lazy reconciliation path before the existing non-steer rejection that resumes the SDK thread and inspects the persisted turn status so the runner can clear stale state and continue with a fresh turn when the SDK no longer reports that turn as in progress.

**Tech Stack:** TypeScript, Vitest integration tests, Dockerode-backed thread container service, Codex app-server client

---

### Task 1: Add failing stale-state recovery tests

**Files:**
- Modify: `tests/integration/companyhelm.integration.test.ts`

- [ ] **Step 1: Write the failing startup reconciliation integration test**

- [ ] **Step 2: Run the targeted integration test to verify it fails for the current stale-state behavior**

- [ ] **Step 3: Write the failing lazy SDK turn-status reconciliation integration test**

- [ ] **Step 4: Run the targeted integration test to verify it fails for the current stale-state behavior**

### Task 2: Add cheap startup reconciliation

**Files:**
- Modify: `src/service/thread_lifecycle.ts`
- Modify: `src/commands/root.ts`
- Test: `tests/integration/companyhelm.integration.test.ts`

- [ ] **Step 1: Add thread-container runtime state inspection support**

- [ ] **Step 2: Reconcile persisted running flags at runner startup using only local container state and missing-ID checks**

- [ ] **Step 3: Run the startup reconciliation integration test to verify it passes**

### Task 3: Add lazy authoritative turn reconciliation

**Files:**
- Modify: `src/commands/root.ts`
- Test: `tests/integration/companyhelm.integration.test.ts`

- [ ] **Step 1: Reconcile persisted running state before rejecting non-steer requests**

- [ ] **Step 2: Resume the SDK thread, inspect the tracked turn status, and clear stale flags when the turn is no longer `inProgress`**

- [ ] **Step 3: Run the lazy reconciliation integration test to verify it passes**

### Task 4: Verify runner behavior

**Files:**
- Modify: `tests/integration/companyhelm.integration.test.ts`

- [ ] **Step 1: Run the focused integration tests for stale-state recovery**

- [ ] **Step 2: Run the runner test suite relevant to the touched behavior**

- [ ] **Step 3: Review the diff for unintended changes**
