export class DaemonStartupWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {
    this.bump();
  }

  public bump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onTimeout();
    }, this.timeoutMs);
  }

  public finish(): void {
    if (!this.timer) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
