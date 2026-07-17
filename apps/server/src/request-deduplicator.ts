export class RequestDeduplicator {
  private readonly results = new Map<string, Promise<unknown>>();

  run<T>(key: string, action: () => Promise<T> | T): Promise<T> {
    const existing = this.results.get(key);
    if (existing) return existing as Promise<T>;
    const result = Promise.resolve().then(action);
    this.results.set(key, result);
    void result.then(() => {
      const timer = setTimeout(() => this.results.delete(key), 5 * 60_000);
      timer.unref();
    }, () => {
      if (this.results.get(key) === result) this.results.delete(key);
    });
    return result;
  }
}
