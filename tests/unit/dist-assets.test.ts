import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

test("build output includes packaged runtime templates", () => {
  const repositoryRoot = path.resolve(__dirname, "../..");
  const expectedTemplates = [
    "app_server_bootstrap.sh.j2",
    "runtime_agents.md.j2",
    "runtime_bashrc.j2",
  ];

  for (const templateName of expectedTemplates) {
    assert.equal(
      existsSync(path.join(repositoryRoot, "dist", "templates", templateName)),
      true,
      `expected dist/templates/${templateName} to exist after build`,
    );
  }
});
