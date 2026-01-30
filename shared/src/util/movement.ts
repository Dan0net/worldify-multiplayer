/**
 * Movement calculation utilities shared between client and server
 * 
 * These functions ensure consistent movement behavior and prevent
 * client/server desync from duplicated math.
 */

import {
  INPUT_FORWARD,
  INPUT_BACKWARD,
  INPUT_LEFT,
  INPUT_RIGHT,
} from '../protocol/movement.js';

// ============== Types ==============

export interface MovementVector {
  /** Local X movement (-1 to 1, left/right) */
  moveX: number;
  /** Local Z movement (-1 to 1, forward/back) */
  moveZ: number;
}

export interface WorldDirection {
  /** World X direction */
  worldX: number;
  /** World Z direction */
  worldZ: number;
}

// ============== Input Processing ==============

/**
 * Extract and normalize movement direction from button bitmask.
 * Handles diagonal normalization so diagonal movement isn't faster.
 * 
 * @param buttons Button bitmask from input
 * @returns Normalized movement vector (length 0 or 1)
 */
export function getMovementFromButtons(buttons: number): MovementVector {
  let moveX = 0;
  let moveZ = 0;

  if (buttons & INPUT_FORWARD) moveZ -= 1;
  if (buttons & INPUT_BACKWARD) moveZ += 1;
  if (buttons & INPUT_LEFT) moveX -= 1;
  if (buttons & INPUT_RIGHT) moveX += 1;

  // Normalize diagonal movement
  const length = Math.sqrt(moveX * moveX + moveZ * moveZ);
  if (length > 0) {
    moveX /= length;
    moveZ /= length;
  }

  return { moveX, moveZ };
}

// ============== Coordinate Transformation ==============

/**
 * Rotate local movement direction to world space based on yaw.
 * 
 * In Three.js coordinate system:
 * - -Z is forward
 * - +X is right
 * - Yaw rotates around Y axis
 * 
 * @param moveX Local X movement (-1 to 1)
 * @param moveZ Local Z movement (-1 to 1)
 * @param yaw Player yaw in radians
 * @returns World-space direction vector
 */
export function rotateToWorldDirection(
  moveX: number,
  moveZ: number,
  yaw: number
): WorldDirection {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  
  return {
    worldX: moveX * cos + moveZ * sin,
    worldZ: -moveX * sin + moveZ * cos,
  };
}

/**
 * Combined helper: get world direction from buttons and yaw.
 * Returns null if no movement input.
 * 
 * @param buttons Button bitmask from input
 * @param yaw Player yaw in radians
 * @returns World direction or null if no input
 */
export function getWorldDirectionFromInput(
  buttons: number,
  yaw: number
): WorldDirection | null {
  const { moveX, moveZ } = getMovementFromButtons(buttons);
  
  if (moveX === 0 && moveZ === 0) {
    return null;
  }
  
  return rotateToWorldDirection(moveX, moveZ, yaw);
}
