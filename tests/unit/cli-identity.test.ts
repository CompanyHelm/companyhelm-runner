import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntryPoint = path.resolve(__dirname, "../../dist/cli.js");

test("runner help uses the companyhelm-runner command name", () => {
  const result = spawnSync(process.execPath, [cliEntryPoint, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: companyhelm-runner/);
});

test("runner help does not list the removed companyhelm-runner command alias", () => {
  const result = spawnSync(process.execPath, [cliEntryPoint, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /\n\s+companyhelm-runner\s+\[options\]/);
});

test("runner help includes the logs command", () => {
  const result = spawnSync(process.execPath, [cliEntryPoint, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\blogs\b/);
});

test("runner help exposes start and stop at the root level", () => {
  const result = spawnSync(process.execPath, [cliEntryPoint, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\bstart\b/);
  assert.match(result.stdout, /\bstop\b/);
  assert.doesNotMatch(result.stdout, /\n\s+runner\s+/);
});
