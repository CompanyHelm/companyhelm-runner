# Runner Codex Registration/Auth Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `companyhelm-runner` always register Codex with explicit readiness state, auto-detect host auth on start, and support server-driven API key/device-code Codex configuration using `@companyhelm/protos` `0.5.19`.

**Architecture:** Keep the state DB as the Codex SDK source of truth, introduce explicit startup normalization plus a small auth orchestration layer around existing app-server/runtime transport, and propagate the richer proto SDK status payload both at registration and in live control-channel updates.

**Tech Stack:** TypeScript, Vitest, Drizzle/libsql, gRPC, Docker runtime/app-server transport, `@companyhelm/protos`

---

## Chunk 1: Proto And Registration Contract

### Task 1: Upgrade protocol dependency and map new SDK payloads

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/commands/root.ts`
- Modify: `src/service/companyhelm_api_client.ts`
- Test: `tests/integration/companyhelm.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add/update an integration test that expects registration and SDK updates to use `AgentSdk.status`/`errorMessage` semantics from protos `0.5.19`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- tests/integration/companyhelm.integration.test.ts`
Expected: FAIL because the current runner dependency/types do not support the richer SDK contract.

- [ ] **Step 3: Write minimal implementation**

Upgrade `@companyhelm/protos` to `0.5.19` and update runner code to emit/consume full `AgentSdk` payloads instead of the old `SdkUpdate` shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration -- tests/integration/companyhelm.integration.test.ts`
Expected: PASS for the updated SDK contract scenarios.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/commands/root.ts src/service/companyhelm_api_client.ts tests/integration/companyhelm.integration.test.ts
git commit -m "feat: upgrade runner sdk status protocol"
```

### Task 2: Make registration always include Codex

**Files:**
- Modify: `src/commands/root.ts`
- Modify: `src/commands/startup.ts`
- Modify: `src/commands/sdk/codex/auth.ts`
- Test: `tests/unit/startup.test.ts`
- Test: `tests/integration/companyhelm.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests showing an unconfigured runner still inserts/registers `codex` with `UNCONFIGURED`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/startup.test.ts`
Expected: FAIL because startup/root currently require a configured SDK before registration.

- [ ] **Step 3: Write minimal implementation**

Normalize startup DB state so `codex` always exists, remove the root-command hard failure on missing configured SDKs, and build registration from the persisted `codex` record.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/startup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/root.ts src/commands/startup.ts src/commands/sdk/codex/auth.ts tests/unit/startup.test.ts tests/integration/companyhelm.integration.test.ts
git commit -m "feat: always register codex sdk"
```

## Chunk 2: Startup Status And Error Reporting

### Task 3: Auto-detect host auth and preserve dedicated override semantics

**Files:**
- Modify: `src/commands/root.ts`
- Modify: `src/commands/startup.ts`
- Modify: `src/commands/sdk/codex/auth.ts`
- Test: `tests/unit/startup.test.ts`
- Test: `tests/integration/companyhelm.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests for:
- host auth auto-detected on start
- `--use-dedicated-auth` keeping existing dedicated config only
- otherwise marking Codex unconfigured

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/startup.test.ts`
Expected: FAIL on the new startup normalization rules.

- [ ] **Step 3: Write minimal implementation**

Implement startup normalization and logging behavior without interactive prompting in the root command path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/startup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/root.ts src/commands/startup.ts src/commands/sdk/codex/auth.ts tests/unit/startup.test.ts tests/integration/companyhelm.integration.test.ts
git commit -m "feat: normalize runner codex auth on start"
```

### Task 4: Report model refresh failures as SDK errors instead of startup aborts

**Files:**
- Modify: `src/commands/root.ts`
- Modify: `src/service/sdk/refresh_models.ts`
- Test: `tests/integration/companyhelm.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add an integration test that expects runner registration to succeed with `AGENT_SDK_STATUS_ERROR` and `error_message` when Codex model refresh fails under configured auth.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- tests/integration/companyhelm.integration.test.ts`
Expected: FAIL because the current runner aborts startup.

- [ ] **Step 3: Write minimal implementation**

Change registration prep so configured-auth refresh failures are captured into SDK status/error fields rather than thrown.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration -- tests/integration/companyhelm.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/root.ts src/service/sdk/refresh_models.ts tests/integration/companyhelm.integration.test.ts
git commit -m "feat: surface codex model refresh errors in registration"
```

## Chunk 3: Server-Driven Codex Configuration

### Task 5: Handle API key Codex configuration requests

**Files:**
- Modify: `src/service/app_server.ts`
- Modify: `src/commands/root.ts`
- Modify: `src/commands/sdk/codex/auth.ts`
- Test: `tests/unit/app-server.test.ts`
- Test: `tests/integration/companyhelm.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests covering a `CodexConfigurationRequest` with `API_KEY`, expecting auth persistence, model refresh, and an `agent_sdk_update`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/app-server.test.ts`
Expected: FAIL because the request path does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add typed app-server helpers for account login and wire `CodexConfigurationRequest` handling through the control loop.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/app-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service/app_server.ts src/commands/root.ts src/commands/sdk/codex/auth.ts tests/unit/app-server.test.ts tests/integration/companyhelm.integration.test.ts
git commit -m "feat: support api key codex configuration"
```

### Task 6: Handle device-code auth requests and auth.json copy-back

**Files:**
- Modify: `src/commands/root.ts`
- Modify: `src/commands/sdk/codex/auth.ts`
- Modify: `src/service/docker/runtime_app_server_exec.ts`
- Modify: `src/service/docker/app_server_container.ts`
- Test: `tests/unit/app-server.test.ts`
- Test: `tests/integration/companyhelm.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests covering a device-code auth request, device-code extraction, auth-complete detection, auth-file copy-back, and the final `agent_sdk_update`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/app-server.test.ts`
Expected: FAIL because the flow does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement the runtime login orchestration, parse the device code from interactive output, detect completion, copy `auth.json` into runner-managed storage, persist dedicated auth, refresh models, and notify the server.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/app-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/root.ts src/commands/sdk/codex/auth.ts src/service/docker/runtime_app_server_exec.ts src/service/docker/app_server_container.ts tests/unit/app-server.test.ts tests/integration/companyhelm.integration.test.ts
git commit -m "feat: support device code codex configuration"
```

## Chunk 4: Verification And Delivery

### Task 7: Run verification and prepare PR

**Files:**
- Modify: `docs/superpowers/specs/2026-03-11-runner-codex-registration-auth-design.md`
- Modify: `docs/superpowers/plans/2026-03-11-runner-codex-registration-auth.md`

- [ ] **Step 1: Run runner verification**

Run:
- `npm test`
- `npm run test:integration -- tests/integration/companyhelm.integration.test.ts`

Expected: PASS.

- [ ] **Step 2: Run relevant shared checks**

Run the runner-related check in `companyhelm-common` to confirm no required e2e harness changes were missed.

- [ ] **Step 3: Review diff critically**

Inspect changed files and make any final fixes required by test output and requirements.

- [ ] **Step 4: Rebase, push, and create PR**

Run:
- `git fetch origin`
- `git rebase origin/main`
- `git push --set-upstream origin <branch>`
- `gh pr create --body-file <path>`

- [ ] **Step 5: Wait for checks and resolve failures if needed**

Monitor PR checks, fix any failures, push again, and re-check until green.
