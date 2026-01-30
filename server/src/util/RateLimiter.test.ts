/**
 * Tests for RateLimiter utility
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter } from './RateLimiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(100); // 100ms interval
    vi.useFakeTimers();
  });

  describe('check', () => {
    it('should allow first action', () => {
      expect(limiter.check('player1')).toBe(false); // Not rate limited
    });

    it('should block rapid subsequent actions', () => {
      expect(limiter.check('player1')).toBe(false); // First allowed
      expect(limiter.check('player1')).toBe(true);  // Second blocked
    });

    it('should allow action after interval passes', () => {
      expect(limiter.check('player1')).toBe(false); // First allowed
      
      vi.advanceTimersByTime(50);
      expect(limiter.check('player1')).toBe(true);  // Still blocked
      
      vi.advanceTimersByTime(60); // Total 110ms
      expect(limiter.check('player1')).toBe(false); // Now allowed
    });

    it('should track different keys independently', () => {
      expect(limiter.check('player1')).toBe(false);
      expect(limiter.check('player2')).toBe(false); // Different key, allowed
      expect(limiter.check('player1')).toBe(true);  // Same key, blocked
      expect(limiter.check('player2')).toBe(true);  // Same key, blocked
    });
  });

  describe('remove', () => {
    it('should remove rate limit for a key', () => {
      limiter.check('player1');
      expect(limiter.check('player1')).toBe(true); // Blocked
      
      limiter.remove('player1');
      expect(limiter.check('player1')).toBe(false); // Allowed again
    });
  });

  describe('removeByPrefix', () => {
    it('should remove all keys with matching prefix', () => {
      limiter.check('room1:player1');
      limiter.check('room1:player2');
      limiter.check('room2:player1');
      
      limiter.removeByPrefix('room1:');
      
      // room1 players can act again
      expect(limiter.check('room1:player1')).toBe(false);
      expect(limiter.check('room1:player2')).toBe(false);
      // room2 still blocked
      expect(limiter.check('room2:player1')).toBe(true);
    });
  });

  describe('clear', () => {
    it('should remove all rate limits', () => {
      limiter.check('player1');
      limiter.check('player2');
      
      limiter.clear();
      
      expect(limiter.check('player1')).toBe(false);
      expect(limiter.check('player2')).toBe(false);
    });
  });
});
