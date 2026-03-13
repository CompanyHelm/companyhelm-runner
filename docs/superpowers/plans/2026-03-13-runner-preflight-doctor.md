# Runner Preflight Doctor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable runner preflight framework, a Linux AppArmor host check, and `doctor`/`doctor fix` entrypoints while making `start` fail fast on incompatible hosts.

**Architecture:** Add a small `src/preflight` layer with class-based checks and a runner orchestrator. Route both startup and the new doctor command through the same entrypoint so checks and fixes stay consistent.

**Tech Stack:** TypeScript, Commander, Vitest

---

## Chunk 1: Preflight Framework

### Task 1: Add the preflight contracts and orchestrator

**Files:**
- Create: `src/preflight/check.ts`
- Create: `src/preflight/runner_preflight.ts`
- Test: `tests/unit/preflight.test.ts`

- [x] **Step 1: Write the failing tests**
- [x] **Step 2: Run the targeted tests and verify they fail**
- [x] **Step 3: Add the minimal preflight types and orchestrator**
- [x] **Step 4: Rerun the targeted tests and verify they pass**

## Chunk 2: Linux Check

### Task 2: Add the Linux AppArmor rootless-DinD check

**Files:**
- Create: `src/preflight/checks/linux/apparmor_restrict_unprivileged_userns_check.ts`
- Test: `tests/unit/preflight.test.ts`

- [x] **Step 1: Define the failing Linux check behavior in tests**
- [x] **Step 2: Run the targeted tests and verify they fail**
- [x] **Step 3: Implement the class-based Linux check and fix flow**
- [x] **Step 4: Rerun the targeted tests and verify they pass**

## Chunk 3: Command Wiring

### Task 3: Add doctor and startup preflight entrypoints

**Files:**
- Create: `src/preflight/entrypoints.ts`
- Create: `src/commands/doctor.ts`
- Modify: `src/commands/register-commands.ts`
- Modify: `src/commands/root.ts`
- Test: `tests/unit/doctor-cli.test.ts`

- [x] **Step 1: Define the command-level failing tests**
- [x] **Step 2: Run the targeted tests and verify they fail**
- [x] **Step 3: Wire doctor and startup preflight through the shared entrypoints**
- [x] **Step 4: Rerun targeted tests and the full unit suite**

## Chunk 4: Verification

### Task 4: Validate runner behavior and related test assumptions

**Files:**
- Review: `tests/unit`
- Review: `companyhelm-common`

- [x] **Step 1: Run `npm run test:unit`**
- [x] **Step 2: Run `node dist/cli.js doctor`**
- [x] **Step 3: Inspect `companyhelm-common` for runner e2e assumptions**
