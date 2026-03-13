import assert from "node:assert/strict";
import { Writable } from "node:stream";

class BufferWritable extends Writable {
  private readonly chunks: string[] = [];

  _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  toString(): string {
    return this.chunks.join("");
  }
}

test("runner preflight applies fixes for fixable failures and reruns checks", async () => {
  const { RunnerPreflight } = require("../../dist/preflight/runner_preflight.js");

  let checkAttempts = 0;
  let fixAttempts = 0;
  const preflight = new RunnerPreflight([
    {
      id: "linux.apparmor_restrict_unprivileged_userns",
      description: "Linux AppArmor rootless userns compatibility",
      async run() {
        checkAttempts += 1;
        return checkAttempts === 1
          ? {
              status: "failed",
              summary: "kernel.apparmor_restrict_unprivileged_userns=1 blocks rootless DinD",
              fixAvailable: true,
            }
          : {
              status: "passed",
              summary: "Linux host is compatible with rootless DinD",
              fixAvailable: false,
            };
      },
      async fix() {
        fixAttempts += 1;
        return {
          status: "fixed",
          summary: "Updated sysctl configuration for rootless DinD",
        };
      },
    },
  ]);

  const summary = await preflight.run({ applyFixes: true });

  assert.equal(summary.passed, true);
  assert.equal(checkAttempts, 2);
  assert.equal(fixAttempts, 1);
  assert.deepEqual(summary.results.map((result: { status: string }) => result.status), ["passed"]);
});

test("linux apparmor check fails for rootless dind when ubuntu blocks unprivileged user namespaces", async () => {
  const { LinuxApparmorRestrictUnprivilegedUsernsCheck } = require(
    "../../dist/preflight/checks/linux/apparmor_restrict_unprivileged_userns_check.js",
  );

  const check = new LinuxApparmorRestrictUnprivilegedUsernsCheck(
    {
      use_host_docker_runtime: false,
      dind_image: "docker:29-dind-rootless",
    },
    {
      platform: "linux",
      readSysctlValue: async (key: string) => {
        const values: Record<string, string> = {
          "kernel.unprivileged_userns_clone": "1",
          "user.max_user_namespaces": "15338",
          "kernel.apparmor_restrict_unprivileged_userns": "1",
        };
        return values[key] ?? null;
      },
      runShellCommand: async () => {
        throw new Error("fix should not run during the check phase");
      },
    },
  );

  const result = await check.run();

  assert.equal(result.status, "failed");
  assert.equal(result.fixAvailable, true);
  assert.match(result.summary, /apparmor_restrict_unprivileged_userns=1/i);
});

test("linux apparmor check fix writes the sysctl file and reloads sysctl state", async () => {
  const { LinuxApparmorRestrictUnprivilegedUsernsCheck } = require(
    "../../dist/preflight/checks/linux/apparmor_restrict_unprivileged_userns_check.js",
  );

  const commands: string[] = [];
  const check = new LinuxApparmorRestrictUnprivilegedUsernsCheck(
    {
      use_host_docker_runtime: false,
      dind_image: "docker:29-dind-rootless",
    },
    {
      platform: "linux",
      readSysctlValue: async () => "0",
      runShellCommand: async (command: string) => {
        commands.push(command);
      },
    },
  );

  const result = await check.fix();

  assert.equal(result.status, "fixed");
  assert.deepEqual(commands, [
    "sudo tee /etc/sysctl.d/99-companyhelm-rootless.conf >/dev/null <<'EOF'\nkernel.unprivileged_userns_clone = 1\nuser.max_user_namespaces = 28633\nkernel.apparmor_restrict_unprivileged_userns = 0\nEOF",
    "sudo sysctl --system",
  ]);
});

test("doctor fix prints the rerun summary after applying fixes", async () => {
  const { runRunnerDoctorCommand } = require("../../dist/commands/doctor.js");

  const stdout = new BufferWritable();
  const applyFixesValues: boolean[] = [];
  await runRunnerDoctorCommand(
    { fix: true },
    {
      stdout,
      runPreflightFn: async ({ applyFixes }: { applyFixes: boolean }) => {
        applyFixesValues.push(applyFixes);
        return {
          passed: true,
          results: [
            {
              id: "linux.apparmor_restrict_unprivileged_userns",
              status: "passed",
              summary: "Linux host is compatible with rootless DinD",
              fixAvailable: false,
            },
          ],
        };
      },
    },
  );

  assert.deepEqual(applyFixesValues, [true]);
  assert.match(stdout.toString(), /Preflight status: passed/);
});
