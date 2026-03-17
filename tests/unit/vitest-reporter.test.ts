import assert from "node:assert/strict";
import { VitestReporterResolver } from "../../dist/testing/vitest_reporter.js";

test("VitestReporterResolver uses the basic reporter for TTY runs by default", () => {
  const reporters = new VitestReporterResolver({
    stdoutIsTTY: true,
    env: {},
  }).resolve();

  assert.deepEqual(reporters, ["basic"]);
});

test("VitestReporterResolver leaves reporters unset for non-TTY runs", () => {
  const reporters = new VitestReporterResolver({
    stdoutIsTTY: false,
    env: {},
  }).resolve();

  assert.equal(reporters, undefined);
});

test("VitestReporterResolver honors explicit reporter overrides", () => {
  const reporters = new VitestReporterResolver({
    stdoutIsTTY: true,
    env: {
      COMPANYHELM_VITEST_REPORTER: "verbose,json",
    },
  }).resolve();

  assert.deepEqual(reporters, ["verbose", "json"]);
});
