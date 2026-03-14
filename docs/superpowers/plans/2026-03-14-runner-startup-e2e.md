# Runner Startup E2E Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent cold-start runner daemon timeouts and verify `companyhelm` works end to end in both image mode and local-repo mode.

**Architecture:** Keep the fix inside `companyhelm-runner`, where daemon readiness is delayed by first-run model refresh and Docker image pulls. Use daemon progress messages to extend a startup watchdog, then validate the fix by running `companyhelm` against a local runner build in both startup modes and exercising the live UI chat flow.

**Tech Stack:** TypeScript, Vitest, Node.js, Docker, `companyhelm` CLI, Playwright

---

### Task 1: Lock the Runner Timeout Behavior

**Files:**
- Modify: `src/commands/root.ts`
- Modify: `src/commands/runner/start.ts`
- Create: `src/utils/daemon_startup_watchdog.ts`
- Test: `tests/unit/daemon-startup-watchdog.test.ts`

- [ ] **Step 1: Write the failing test**

Add a unit test that proves a startup watchdog extends the timeout when progress is reported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/daemon-startup-watchdog.test.ts`
Expected: FAIL before the watchdog behavior exists or is wired correctly.

- [ ] **Step 3: Write minimal implementation**

Add a small watchdog helper, emit daemon progress messages during Codex model refresh, and reset the startup timeout when progress arrives.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/daemon-startup-watchdog.test.ts`
Expected: PASS

- [ ] **Step 5: Run broader runner verification**

Run: `npm test`
Expected: PASS

### Task 2: Validate `companyhelm` Image Mode With Local Runner

**Files:**
- No source changes required unless verification exposes a new defect

- [ ] **Step 1: Build the runner**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 2: Run image mode against the local runner build**

Run:
`DOCKER_HOST=tcp://localhost:2375 COMPANYHELM_RUNNER_CLI_PATH=/workspace/companyhelm-runner/dist/cli.js node dist/cli.js up`

Expected: Postgres, API, frontend, and runner become ready without daemon timeout.

- [ ] **Step 3: Tear down cleanly**

Run: `DOCKER_HOST=tcp://localhost:2375 COMPANYHELM_RUNNER_CLI_PATH=/workspace/companyhelm-runner/dist/cli.js node dist/cli.js down`
Expected: exit 0 and no leftover `companyhelm-*` containers.

### Task 3: Validate Local-Repo Mode With Local Runner

**Files:**
- No source changes required unless verification exposes a new defect

- [ ] **Step 1: Run local-repo mode**

Run:
`DOCKER_HOST=tcp://localhost:2375 COMPANYHELM_RUNNER_CLI_PATH=/workspace/companyhelm-runner/dist/cli.js node dist/cli.js up --api-repo-path /workspace/companyhelm-api --web-repo-path /workspace/companyhelm-web`

Expected: Postgres starts in Docker, local API/web start from sibling repos, and runner registers successfully.

- [ ] **Step 2: Tear down cleanly**

Run: `DOCKER_HOST=tcp://localhost:2375 COMPANYHELM_RUNNER_CLI_PATH=/workspace/companyhelm-runner/dist/cli.js node dist/cli.js down`
Expected: exit 0 and no leftover service processes.

### Task 4: Exercise the Live UI

**Files:**
- No source changes required unless verification exposes a new defect

- [ ] **Step 1: Log in through the UI**

Use Playwright against the running stack and authenticate with the generated local credentials.

- [ ] **Step 2: Send one agent message**

Open an agent chat, send a message, and wait for a response payload in the UI.

- [ ] **Step 3: Capture exact evidence**

Record the working URL, the login identity used, the agent/thread used, and the received reply text.

### Task 5: Finalize and Publish

**Files:**
- Modify: PR body files if needed

- [ ] **Step 1: Rebase on latest main**

Run: `git fetch origin && git rebase origin/main`
Expected: clean rebase

- [ ] **Step 2: Commit and push the runner fix**

Run standard git add/commit/push commands.

- [ ] **Step 3: Create or update the PR**

Use `gh pr create --body-file ...` or `gh pr edit --body-file ...`.

- [ ] **Step 4: Check PR status**

Wait for configured checks, or confirm that none are configured.
