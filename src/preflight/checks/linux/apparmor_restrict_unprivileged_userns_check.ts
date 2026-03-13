import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { PreflightCheck, PreflightCheckResult, PreflightFixResult } from "../../check.js";

interface LinuxApparmorRestrictUnprivilegedUsernsConfig {
  use_host_docker_runtime: boolean;
  dind_image: string;
}

interface LinuxApparmorRestrictUnprivilegedUsernsCheckDependencies {
  platform?: NodeJS.Platform;
  readSysctlValue?: (key: string) => Promise<string | null>;
  runShellCommand?: (command: string) => Promise<void>;
}

const APPARMOR_SYSCTL_KEY = "kernel.apparmor_restrict_unprivileged_userns";
const UNPRIVILEGED_USERNS_SYSCTL_KEY = "kernel.unprivileged_userns_clone";
const USER_NAMESPACE_LIMIT_SYSCTL_KEY = "user.max_user_namespaces";

function isRootlessDindImage(image: string): boolean {
  return image.toLowerCase().includes("rootless");
}

async function defaultReadSysctlValue(key: string): Promise<string | null> {
  const path = `/proc/sys/${key.replace(/\./g, "/")}`;
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function defaultRunShellCommand(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { stdio: "inherit" });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${signal ?? code ?? "unknown"}): ${command}`));
    });
  });
}

export class LinuxApparmorRestrictUnprivilegedUsernsCheck implements PreflightCheck {
  readonly id = "linux.apparmor_restrict_unprivileged_userns";
  readonly description = "Verify Linux AppArmor permits unprivileged user namespaces for rootless DinD.";

  private readonly platform: NodeJS.Platform;
  private readonly readSysctlValue: (key: string) => Promise<string | null>;
  private readonly runShellCommand: (command: string) => Promise<void>;

  constructor(
    private readonly cfg: LinuxApparmorRestrictUnprivilegedUsernsConfig,
    dependencies: LinuxApparmorRestrictUnprivilegedUsernsCheckDependencies = {},
  ) {
    this.platform = dependencies.platform ?? process.platform;
    this.readSysctlValue = dependencies.readSysctlValue ?? defaultReadSysctlValue;
    this.runShellCommand = dependencies.runShellCommand ?? defaultRunShellCommand;
  }

  async run(): Promise<PreflightCheckResult> {
    if (!this.isApplicable()) {
      return {
        status: "skipped",
        summary: "Check only applies to Linux rootless DinD setups.",
        fixAvailable: false,
      };
    }

    const apparmorRestriction = await this.readSysctlValue(APPARMOR_SYSCTL_KEY);
    if (apparmorRestriction === "1") {
      const [userNamespaceClone, userNamespaceLimit] = await Promise.all([
        this.readSysctlValue(UNPRIVILEGED_USERNS_SYSCTL_KEY),
        this.readSysctlValue(USER_NAMESPACE_LIMIT_SYSCTL_KEY),
      ]);
      return {
        status: "failed",
        summary:
          `${APPARMOR_SYSCTL_KEY}=1 blocks rootless DinD on this Linux host ` +
          `(kernel.unprivileged_userns_clone=${userNamespaceClone ?? "unknown"}, ` +
          `user.max_user_namespaces=${userNamespaceLimit ?? "unknown"}).`,
        fixAvailable: true,
      };
    }

    return {
      status: "passed",
      summary: "Linux host is compatible with rootless DinD.",
      fixAvailable: false,
    };
  }

  async fix(): Promise<PreflightFixResult> {
    if (!this.isApplicable()) {
      return {
        status: "skipped",
        summary: "Check only applies to Linux rootless DinD setups.",
      };
    }

    await this.runShellCommand(
      "sudo tee /etc/sysctl.d/99-companyhelm-rootless.conf >/dev/null <<'EOF'\n" +
      "kernel.unprivileged_userns_clone = 1\n" +
      "user.max_user_namespaces = 28633\n" +
      "kernel.apparmor_restrict_unprivileged_userns = 0\n" +
      "EOF",
    );
    await this.runShellCommand("sudo sysctl --system");

    return {
      status: "fixed",
      summary: "Updated Linux sysctl configuration for rootless DinD.",
    };
  }

  private isApplicable(): boolean {
    return this.platform === "linux" && !this.cfg.use_host_docker_runtime && isRootlessDindImage(this.cfg.dind_image);
  }
}
