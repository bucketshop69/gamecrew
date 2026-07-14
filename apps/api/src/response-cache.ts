/**
 * Small in-memory response cache for hot read endpoints.
 *
 * Entries are keyed by an arbitrary string (route + params) and stamped with
 * a "version" (e.g. the fixture's latest state revision). A read with a
 * matching key and version is served from memory; a version bump (new
 * ingestion write) naturally busts the entry on the next read. A short TTL
 * is a fallback for keys whose version never changes (e.g. finished
 * fixtures) so stale entries still get evicted eventually.
 *
 * Bounded by entry count (simple insertion-order eviction) to avoid
 * unbounded growth under many distinct fixtureId+params combinations.
 */
export interface ResponseCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

interface CacheEntry<T> {
  version: string;
  expiresAt: number;
  value: T;
}

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 500;

export class ResponseCache<T = unknown> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: ResponseCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get(key: string, version: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.version !== version || entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, version: string, value: T, now = Date.now()): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, { version, expiresAt: now + this.ttlMs, value });
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
