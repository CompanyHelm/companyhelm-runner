interface VitestReporterResolverOptions {
  stdoutIsTTY: boolean;
  env?: NodeJS.ProcessEnv;
}

export class VitestReporterResolver {
  private readonly stdoutIsTTY: boolean;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: VitestReporterResolverOptions) {
    this.stdoutIsTTY = options.stdoutIsTTY;
    this.env = options.env ?? process.env;
  }

  resolve(): string[] | undefined {
    const configured = this.env.COMPANYHELM_VITEST_REPORTER?.trim();
    if (configured && configured.length > 0) {
      return configured
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }

    if (this.stdoutIsTTY) {
      return ["basic"];
    }

    return undefined;
  }
}
