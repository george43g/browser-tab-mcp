/**
 * Generic TTL + memory-pressure LRU cache.
 *
 * Generalizes imsg-mcp's `tui/messageCache.ts` away from messages-keyed-by-
 * chatIdentifier. Two eviction signals:
 *   - TTL: entries older than `ttlMs` are dropped on the next sweep tick.
 *   - Memory pressure: the cache subscribes to the watchdog's memory
 *     sample stream and evicts the LRU half when heap exceeds `pressureMb`.
 *
 * Subscribes lazily — calling `withMemoryPressure()` is opt-in. Tools that
 * don't want the dependency just instantiate `new MemoryCache()` and skip.
 */

import { onMemorySample } from "@george43g/robustness";

export interface CacheEntry<V> {
  value: V;
  lastAccess: number;
}

export interface MemoryCacheOptions {
  /** Time-to-live in ms. Entries older than this are dropped on read. Default 10min. */
  ttlMs?: number;
  /** How often to sweep TTL'd entries proactively. Default = ttlMs / 4. */
  sweepIntervalMs?: number;
  /** When set, subscribe to watchdog memory samples and evict LRU half above this MB threshold. */
  pressureMb?: number;
}

export class MemoryCache<V> {
  private readonly map = new Map<string, CacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly pressureMb: number | null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: MemoryCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.pressureMb = opts.pressureMb ?? null;

    const interval = opts.sweepIntervalMs ?? Math.max(15_000, this.ttlMs / 4);
    this.sweepTimer = setInterval(() => this.sweep(), interval);
    this.sweepTimer.unref();

    if (this.pressureMb !== null) {
      const threshold = this.pressureMb;
      this.unsubscribe = onMemorySample((_rssMb, heapMb) => {
        if (heapMb >= threshold) this.evictLruHalf();
      });
    }
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.lastAccess > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    entry.lastAccess = Date.now();
    return entry.value;
  }

  set(key: string, value: V): void {
    this.map.set(key, { value, lastAccess: Date.now() });
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  /** Drop all TTL'd entries. */
  sweep(): number {
    const cutoff = Date.now() - this.ttlMs;
    let dropped = 0;
    for (const [k, v] of this.map) {
      if (v.lastAccess < cutoff) {
        this.map.delete(k);
        dropped++;
      }
    }
    return dropped;
  }

  /** Evict the least-recently-used half. Called on memory pressure. */
  evictLruHalf(): number {
    const sorted = Array.from(this.map.entries()).sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const half = Math.floor(sorted.length / 2);
    for (let i = 0; i < half; i++) {
      const entry = sorted[i];
      if (entry) this.map.delete(entry[0]);
    }
    return half;
  }

  /** Stop sweeping + memory-pressure subscription. */
  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }
}
