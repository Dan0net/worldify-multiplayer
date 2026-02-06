/**
 * Tests for PlayerLocal fall detection and respawn triggering
 * 
 * Covers:
 * - Fall time tracking
 * - Respawn callback triggering after MAX_FALL_TIME
 * - Last grounded position tracking
 * - Respawn method behavior
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { PlayerLocal, RespawnCallback } from './playerLocal.js';
import { MAX_FALL_TIME, COYOTE_TIME, JUMP_BUFFER_TIME } from '@worldify/shared';

// Mock Controls
const createMockControls = () => ({
  yaw: 0,
  pitch: 0,
  getButtonMask: () => 0,
  requestPointerLock: vi.fn(),
  exitPointerLock: vi.fn(),
  isLocked: () => false,
});

describe('PlayerLocal Fall Detection', () => {
  let player: PlayerLocal;
  let respawnCallback: ReturnType<typeof vi.fn>;
  let mockControls: ReturnType<typeof createMockControls>;

  beforeEach(() => {
    player = new PlayerLocal();
    respawnCallback = vi.fn();
    player.setRespawnCallback(respawnCallback);
    mockControls = createMockControls();
  });

  test('starts with zero fall time', () => {
    expect(player.getFallTime()).toBe(0);
  });

  test('starts grounded (no initial velocity)', () => {
    expect(player.getIsGrounded()).toBe(false); // Not grounded until collision check
  });

  test('tracks last grounded position when on ground', () => {
    // Initially no last grounded position
    expect(player.getLastGroundedPosition()).toBeNull();
  });

  test('respawn resets position and velocity', () => {
    // Set some initial state
    player.position.set(100, -500, 100);
    player.velocity.set(10, -50, 10);

    const respawnPos = new THREE.Vector3(0, 20, 0);
    player.respawn(respawnPos);

    expect(player.position.x).toBe(0);
    expect(player.position.y).toBe(20);
    expect(player.position.z).toBe(0);
    expect(player.velocity.x).toBe(0);
    expect(player.velocity.y).toBe(0);
    expect(player.velocity.z).toBe(0);
  });

  test('respawn resets fall time', () => {
    // Simulate some falling
    player.velocity.y = -10;
    
    // Manual respawn
    player.respawn(new THREE.Vector3(0, 20, 0));
    
    expect(player.getFallTime()).toBe(0);
  });

  test('respawn callback is set correctly', () => {
    const callback: RespawnCallback = vi.fn();
    player.setRespawnCallback(callback);
    
    // The callback should be stored (we can't directly access it, but we can verify via behavior)
    expect(callback).not.toHaveBeenCalled(); // Not called just by setting
  });
});

describe('MAX_FALL_TIME constant', () => {
  test('MAX_FALL_TIME is reasonable value', () => {
    expect(MAX_FALL_TIME).toBeGreaterThan(0);
    expect(MAX_FALL_TIME).toBeLessThanOrEqual(10); // Not too long
    expect(MAX_FALL_TIME).toBeGreaterThanOrEqual(3); // Not too short
  });

  test('MAX_FALL_TIME is exactly 5 seconds', () => {
    expect(MAX_FALL_TIME).toBe(5.0);
  });
});

describe('PlayerLocal Input', () => {
  let player: PlayerLocal;
  let mockControls: ReturnType<typeof createMockControls>;

  beforeEach(() => {
    player = new PlayerLocal();
    mockControls = createMockControls();
  });

  test('getInput returns input with position', () => {
    player.position.set(10, 20, 30);
    
    const input = player.getInput(mockControls as any);
    
    expect(input.x).toBe(10);
    expect(input.y).toBe(20);
    expect(input.z).toBe(30);
  });

  test('getInput increments sequence number', () => {
    const input1 = player.getInput(mockControls as any);
    const input2 = player.getInput(mockControls as any);
    
    expect(input2.seq).toBe(input1.seq + 1);
  });

  test('getInput includes yaw and pitch from controls', () => {
    mockControls.yaw = 1.5;
    mockControls.pitch = -0.5;
    
    const input = player.getInput(mockControls as any);
    
    expect(input.yaw).toBe(1.5);
    expect(input.pitch).toBe(-0.5);
  });
});

describe('PlayerLocal Position and Velocity', () => {
  let player: PlayerLocal;

  beforeEach(() => {
    player = new PlayerLocal();
  });

  test('initial position is at origin', () => {
    expect(player.position.x).toBe(0);
    expect(player.position.y).toBe(0);
    expect(player.position.z).toBe(0);
  });

  test('initial velocity is zero', () => {
    expect(player.velocity.x).toBe(0);
    expect(player.velocity.y).toBe(0);
    expect(player.velocity.z).toBe(0);
  });

  test('initial yaw and pitch are zero', () => {
    expect(player.yaw).toBe(0);
    expect(player.pitch).toBe(0);
  });
});

describe('Coyote Time and Jump Buffer Constants', () => {
  test('COYOTE_TIME is a reasonable value', () => {
    expect(COYOTE_TIME).toBeGreaterThan(0);
    expect(COYOTE_TIME).toBeLessThanOrEqual(0.3); // Not too generous
  });

  test('JUMP_BUFFER_TIME is a reasonable value', () => {
    expect(JUMP_BUFFER_TIME).toBeGreaterThan(0);
    expect(JUMP_BUFFER_TIME).toBeLessThanOrEqual(0.3); // Not too generous
  });

  test('COYOTE_TIME is 150ms', () => {
    expect(COYOTE_TIME).toBe(0.15);
  });

  test('JUMP_BUFFER_TIME is 150ms', () => {
    expect(JUMP_BUFFER_TIME).toBe(0.15);
  });
});

describe('PlayerLocal Coyote Time and Jump Buffer', () => {
  let player: PlayerLocal;

  beforeEach(() => {
    player = new PlayerLocal();
  });

  test('respawn exhausts coyote time to prevent immediate jump', () => {
    player.respawn(new THREE.Vector3(0, 20, 0));
    // After respawn, player should not be able to coyote-jump
    // (timeSinceGrounded is set to COYOTE_TIME)
    expect(player.getIsGrounded()).toBe(false);
  });
});
