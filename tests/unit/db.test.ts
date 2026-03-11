import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDb } from "../../dist/state/db.js";

test("initDb can initialize a fresh database", async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-runner-db-"));
  const stateDbPath = path.join(tempDirectory, "state.db");

  try {
    const { client } = await initDb(stateDbPath);
    client.close();
    assert.equal(true, true);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
