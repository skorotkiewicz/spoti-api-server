export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class Cache<T> {
  private entries = new Map<string, { value: T; expires: number }>();

  constructor(private limit = 200, private now = Date.now) {}

  async read(key: string, ttlMs: number, load: () => Promise<T>) {
    const cached = this.entries.get(key);
    if (cached && cached.expires > this.now()) {
      return { data: cached.value, cache: 'HIT' as const };
    }
    this.entries.delete(key);
    const value = await load();
    if (ttlMs > 0) {
      if (this.entries.size >= this.limit) {
        this.entries.delete(this.entries.keys().next().value!);
      }
      this.entries.set(key, { value, expires: this.now() + ttlMs });
    }
    return { data: value, cache: 'MISS' as const };
  }

  clear() {
    this.entries.clear();
  }
}

// ponytail: one shared page serializes all browser work; use separate account workers if throughput matters.
export class BrowserQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= 16) {
      return Promise.reject(new ApiError(503, 'BUSY', 'Browser queue is full. Retry later.'));
    }
    this.pending++;
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result.finally(() => { this.pending--; });
  }
}
