/**
 * Tests for movement utility functions
 */

import { describe, test, expect } from 'vitest';
import {
  getMovementFromButtons,
  rotateToWorldDirection,
  getWorldDirectionFromInput,
  lerpAngle,
} from './movement.js';
import {
  INPUT_FORWARD,
  INPUT_BACKWARD,
  INPUT_LEFT,
  INPUT_RIGHT,
} from '../protocol/movement.js';

describe('getMovementFromButtons', () => {
  test('no buttons returns zero movement', () => {
    const result = getMovementFromButtons(0);
    expect(result.moveX).toBe(0);
    expect(result.moveZ).toBe(0);
  });

  test('forward movement', () => {
    const result = getMovementFromButtons(INPUT_FORWARD);
    expect(result.moveX).toBe(0);
    expect(result.moveZ).toBe(-1);
  });

  test('diagonal movement is normalized', () => {
    const result = getMovementFromButtons(INPUT_FORWARD | INPUT_RIGHT);
    const length = Math.sqrt(result.moveX ** 2 + result.moveZ ** 2);
    expect(length).toBeCloseTo(1, 5);
  });
});

describe('lerpAngle', () => {
  test('t=0 returns current angle', () => {
    expect(lerpAngle(1.0, 2.0, 0)).toBeCloseTo(1.0);
  });

  test('t=1 returns target angle', () => {
    expect(lerpAngle(1.0, 2.0, 1)).toBeCloseTo(2.0);
  });

  test('t=0.5 returns midpoint', () => {
    expect(lerpAngle(0, 1, 0.5)).toBeCloseTo(0.5);
  });

  test('takes shortest path across PI boundary (positive wrap)', () => {
    // From just below PI to just above -PI (close together, wrapping around)
    const result = lerpAngle(Math.PI * 0.9, -Math.PI * 0.9, 0.5);
    // Should go through PI (shortest path), not back through 0
    expect(Math.abs(result)).toBeGreaterThan(Math.PI * 0.8);
  });

  test('takes shortest path across PI boundary (negative wrap)', () => {
    // From -170° to 170° should go through ±180°, not through 0°
    const from = -Math.PI * (170 / 180);
    const to = Math.PI * (170 / 180);
    const result = lerpAngle(from, to, 0.5);
    // Midpoint should be near ±PI, not near 0
    expect(Math.abs(result)).toBeGreaterThan(Math.PI * 0.9);
  });

  test('handles same angle', () => {
    expect(lerpAngle(1.5, 1.5, 0.5)).toBeCloseTo(1.5);
  });

  test('handles zero angles', () => {
    expect(lerpAngle(0, 0, 0.5)).toBeCloseTo(0);
  });

  test('small angle difference interpolates linearly', () => {
    const result = lerpAngle(0.1, 0.3, 0.5);
    expect(result).toBeCloseTo(0.2);
  });
});
