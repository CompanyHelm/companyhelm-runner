import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntryPoint = path.resolve(__dirname, "../../dist/cli.js");

test("runner help includes the doctor command", () => {
  const result = spawnSync(process.execPath, [cliEntryPoint, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\bdoctor\b/);
});
