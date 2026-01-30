/**
 * RateLimiter - Generic rate limiting for player actions
 * 
 * Single Responsibility: Only handles rate limiting logic.
 * Dependency Inversion: Can be injected into handlers that need rate limiting.
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
