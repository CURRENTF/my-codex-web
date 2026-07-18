export class KeyedOperationLock {
  private readonly locks = new Map<string, Promise<unknown>>();

  withKey<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const tracked = next.then(() => undefined, () => undefined).finally(() => {
      if (this.locks.get(key) === tracked) this.locks.delete(key);
    });
    this.locks.set(key, tracked);
    return next;
  }

  withKeys<T>(keys: string[], action: () => Promise<T>): Promise<T> {
    const [key, ...rest] = [...new Set(keys)].sort();
    return key ? this.withKey(key, () => this.withKeys(rest, action)) : action();
  }
}
