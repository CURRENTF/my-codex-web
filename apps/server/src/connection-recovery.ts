export type AppServerConnectionState = "connected" | "connecting" | "disconnected";

interface ConnectionRecoveryOptions {
  reconcile(): Promise<void>;
  onState(state: AppServerConnectionState): void;
  onRecovered?(): Promise<void> | void;
  onError(error: unknown): void;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export class ConnectionRecovery {
  private generation = 0;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private current: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: ConnectionRecoveryOptions) {}

  handle(state: AppServerConnectionState): Promise<void> {
    const generation = ++this.generation;
    this.clearRetry();
    this.attempt = 0;
    if (state !== "connected") {
      this.options.onState(state);
      this.current = Promise.resolve();
      return this.current;
    }
    return this.run(generation);
  }

  waitForCurrent(): Promise<void> {
    return this.current;
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearRetry();
  }

  private run(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return Promise.resolve();
    this.options.onState("connecting");
    const current = this.options.reconcile()
      .then(async () => {
        if (this.stopped || generation !== this.generation) return;
        this.attempt = 0;
        this.options.onState("connected");
        await this.options.onRecovered?.();
      })
      .catch((error) => {
        if (this.stopped || generation !== this.generation) return;
        this.options.onError(error);
        this.options.onState("disconnected");
        const delay = Math.min(
          this.options.retryMaxMs ?? 10_000,
          (this.options.retryBaseMs ?? 250) * 2 ** this.attempt++,
        );
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.run(generation);
        }, delay);
        this.retryTimer.unref();
      });
    this.current = current;
    return current;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
