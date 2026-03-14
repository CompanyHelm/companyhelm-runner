import assert from "node:assert/strict";

import { afterEach, test, vi } from "vitest";

import { DaemonStartupWatchdog } from "../../dist/utils/daemon_startup_watchdog.js";

afterEach(() => {
  vi.useRealTimers();
});

test("bump extends the timeout window", async () => {
  vi.useFakeTimers();

  let timeoutCount = 0;
  const watchdog = new DaemonStartupWatchdog(100, () => {
    timeoutCount += 1;
  });

  await vi.advanceTimersByTimeAsync(50);
  watchdog.bump();
  await vi.advanceTimersByTimeAsync(75);
  assert.equal(timeoutCount, 0);

  await vi.advanceTimersByTimeAsync(25);
  assert.equal(timeoutCount, 1);
});

test("finish cancels the timeout", async () => {
  vi.useFakeTimers();

  let timeoutCount = 0;
  const watchdog = new DaemonStartupWatchdog(100, () => {
    timeoutCount += 1;
  });

  watchdog.finish();
  await vi.advanceTimersByTimeAsync(200);
  assert.equal(timeoutCount, 0);
});
