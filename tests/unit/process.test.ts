import assert from "node:assert/strict";

import { test } from "vitest";

import { isZombieProcessState, parseProcStatState } from "../../src/utils/process.js";

test("parseProcStatState extracts the process state from /proc stat content", () => {
  assert.equal(parseProcStatState("12345 (companyhelm) S 1 2 3 4"), "S");
  assert.equal(parseProcStatState("12345 (companyhelm worker) Z 1 2 3 4"), "Z");
});

test("parseProcStatState returns null for malformed stat content", () => {
  assert.equal(parseProcStatState(""), null);
  assert.equal(parseProcStatState("12345 companyhelm"), null);
});

test("isZombieProcessState only marks zombie state as dead", () => {
  assert.equal(isZombieProcessState("Z"), true);
  assert.equal(isZombieProcessState("S"), false);
  assert.equal(isZombieProcessState(null), false);
});
