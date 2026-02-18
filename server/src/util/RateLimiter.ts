/**
 * RateLimiter & ConcurrencyLimiter - Generic rate/concurrency control
 * 
 * Single Responsibility: Only handles rate/concurrency limiting logic.
 * Dependency Inversion: Can be injected into handlers that need limiting.
 */

/**
 * A generic rate limiter that tracks action timestamps per key.
 */
export class RateLimiter {
  private readonly lastActionTime = new Map<string, number>();
  private readonly intervalMs: number;

  /**
   * @param intervalMs Minimum milliseconds between actions
   */
  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  /**
   * Check if an action is rate limited and update the timestamp if not.
   * @param key Unique identifier (e.g., `${roomId}:${playerId}`)
   * @returns true if rate limited (action should be blocked), false if allowed
   */
  check(key: string): boolean {
    const lastTime = this.lastActionTime.get(key) ?? 0;
    const now = Date.now();

    if (now - lastTime < this.intervalMs) {
      return true; // Rate limited
    }

    this.lastActionTime.set(key, now);
    return false; // Allowed
  }

  /**
   * Remove rate limiting data for a specific key.
   */
  remove(key: string): void {
    this.lastActionTime.delete(key);
  }

  /**
   * Remove all keys matching a prefix.
   * @param prefix Key prefix to match (e.g., `${roomId}:`)
   */
  removeByPrefix(prefix: string): void {
    for (const key of this.lastActionTime.keys()) {
      if (key.startsWith(prefix)) {
        this.lastActionTime.delete(key);
      }
    }
  }

  /**
   * Clear all rate limiting data.
   */
  clear(): void {
    this.lastActionTime.clear();
  }
}

/**
 * Limits the number of concurrent in-flight operations per key.
 * Use tryAcquire() before starting work; release() when done.
 */
export class ConcurrencyLimiter {
  private readonly counts = new Map<string, number>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** Returns true if a slot was acquired, false if at limit. */
  tryAcquire(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.max) return false;
    this.counts.set(key, current + 1);
    return true;
  }

  /** Release one slot for the key. */
  release(key: string): void {
    const current = this.counts.get(key) ?? 0;
    if (current <= 1) this.counts.delete(key);
    else this.counts.set(key, current - 1);
  }

  /** Remove all counts for keys starting with prefix. */
  removeByPrefix(prefix: string): void {
    for (const key of this.counts.keys()) {
      if (key.startsWith(prefix)) this.counts.delete(key);
    }
  }
}
