import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("runtime Dockerfile does not bundle companyhelm agent cli", () => {
  const dockerfile = readFileSync(new URL("../../dockerfiles/Dockerfile-runtime", import.meta.url), "utf8");

  assert.equal(dockerfile.includes("@companyhelm/agent-cli"), false);
});

test("thread container docs describe the current runtime tooling set", () => {
  const docs = readFileSync(new URL("../../docs/thread-containers.md", import.meta.url), "utf8");

  assert.equal(docs.includes("`companyhelm-agent`"), false);
  assert.equal(docs.includes("`nvm`, `codex`, `aws`, `playwright`"), true);
});
