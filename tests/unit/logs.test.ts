import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntryPoint = path.resolve(__dirname, "../../dist/cli.js");

async function createTempDirectory(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "companyhelm-runner-logs-"));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
    }
    await sleep(25);
  }
}

test("logs prints the full daemon log contents by default", async () => {
  const tempDirectory = await createTempDirectory();
  const stateDbPath = path.join(tempDirectory, "state.db");
  const logPath = path.join(tempDirectory, "daemon.log");

  try {
    await writeFile(logPath, "line one\nline two\n", "utf8");

    const result = spawnSync(process.execPath, [cliEntryPoint, "logs", "--state-db-path", stateDbPath], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "line one\nline two\n");
    assert.equal(result.stderr, "");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("logs prints a friendly message when the daemon log file is missing", async () => {
  const tempDirectory = await createTempDirectory();
  const stateDbPath = path.join(tempDirectory, "state.db");
  const logPath = path.join(tempDirectory, "daemon.log");

  try {
    const result = spawnSync(process.execPath, [cliEntryPoint, "logs", "--state-db-path", stateDbPath], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`CompanyHelm runner log file not found at .*${logPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(result.stderr, "");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("logs --live prints the current log contents and follows appended data", async () => {
  const tempDirectory = await createTempDirectory();
  const stateDbPath = path.join(tempDirectory, "state.db");
  const logPath = path.join(tempDirectory, "daemon.log");

  try {
    await writeFile(logPath, "first line\n", "utf8");

    const child = spawn(process.execPath, [cliEntryPoint, "logs", "--live", "--state-db-path", stateDbPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let closed = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    });

    await waitFor(() => stdout.includes("first line\n") || closed, 5_000);
    await appendFile(logPath, "second line\n", "utf8");
    await waitFor(() => stdout.includes("second line\n") || closed, 5_000);

    if (!closed) {
      child.kill("SIGTERM");
    }

    const result = await closePromise;
    assert.ok(stdout.startsWith("first line\n"), `expected initial log output, received: ${JSON.stringify(stdout)}`);
    assert.match(stdout, /second line\n/, `expected appended log output, received: ${JSON.stringify(stdout)}`);
    assert.equal(stderr, "");
    assert.ok(result.signal === "SIGTERM" || result.code === 0, `unexpected child exit: ${JSON.stringify(result)}`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
