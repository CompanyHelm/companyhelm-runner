# Interrupt Not-Running Reconciliation Design

## Goal

Make interrupt handling self-heal when the underlying SDK or Chat layer reports that a thread has no running turn to interrupt, so interrupt requests succeed as a no-op and both runner and API state converge on "not running".

## Scope

- Broaden runner interrupt error detection to cover equivalent "thread is not running" failures.
- Treat those failures as a successful reconciliation path instead of a request error.
- Mark runner thread execution state as not running when reconciliation happens.
- Mark API thread turn rows as not running when the API knows the thread is not running.
- Clear every stale `running` turn row for the affected API thread.

## Runner Reconciliation

`companyhelm-runner` already has a narrow recovery path for one app-server interrupt error that means "no running turn". This change keeps that model but broadens the matcher to cover equivalent SDK and Chat error strings, including the observed `Chat error: Thread '<id>' has no running turn to interrupt.` form.

When the runner hits one of those errors during `interruptTurn`:

- log a warning
- persist `isCurrentTurnRunning=false`
- emit a synthetic terminal turn update for the tracked turn when one exists
- emit `ThreadStatus.READY`
- return success instead of a request error

This keeps the API-facing contract simple: an interrupt for an already-stopped thread is idempotent.

## API Reconciliation

`companyhelm-api` currently throws before dispatch when the thread row is not `running`. That keeps stale `thread_turns.status='running'` rows alive even though the thread itself is already stopped.

This change adds a local reconciliation helper used by `interruptTurnForThread(...)`:

- if the thread row is not `running`, update all `thread_turns` for that thread with `status='running'` to `status='completed'`
- publish turn updates for the thread
- return success without enqueueing an interrupt request

The API does not need to change the thread status in this path because the thread row is already the source of truth that the thread is not running.

## Data Consistency Rules

- Runner state DB:
  - `isCurrentTurnRunning=false` means the thread is interrupt-idempotent.
  - `currentSdkTurnId` may remain set as the most recently tracked turn id.
- API DB:
  - a thread with `threads.status!='running'` must not have any `thread_turns.status='running'` rows after interrupt reconciliation
  - if more than one turn is incorrectly marked `running`, all of them are completed

## Testing

- Runner unit test for the broader "no running turn to interrupt" matcher.
- API unit test for `interruptTurnForThread(...)` when the thread is already not running and multiple stale running turns exist.
- Focused repo test runs for the touched suites, plus a check of `companyhelm-common` e2e helpers to confirm no shared e2e changes are required.
