import { defineConfig } from "vitest/config";
import { VitestReporterResolver } from "./src/testing/vitest_reporter.js";

const reporters = new VitestReporterResolver({
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  env: process.env,
}).resolve();

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    ...(reporters ? { reporters } : {}),
  },
});
