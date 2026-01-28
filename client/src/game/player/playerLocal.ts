/**
 * Local player controller
 * Handles input, movement, physics, and voxel terrain collision
 */

import * as THREE from 'three';
import { 
  MovementInput, 
  PlayerSnapshot,
  INPUT_FORWARD,
  INPUT_BACKWARD,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_JUMP,
  INPUT_SPRINT,
} from '@worldify/shared';
import { Controls } from './controls';
import type { VoxelIntegration } from '../voxel/VoxelIntegration';

// Physics constants
const MOVE_SPEED = 5.0;
const SPRINT_MULTIPLIER = 1.6;
const GRAVITY = 20.0;
const JUMP_VELOCITY = 8.0;
const PLAYER_HEIGHT = 1.6; // Eye height
const PLAYER_RADIUS = 0.3; // Collision capsule radius

export class PlayerLocal {
  // Position (client authoritative for vertical, server for horizontal)
  public position = new THREE.Vector3(0, 0, 0);
  public yaw = 0;
  public pitch = 0;

  // Velocity for physics
  public velocity = new THREE.Vector3(0, 0, 0);

  // Collision reference
  private voxelIntegration: VoxelIntegration | null = null;

  // State
  private isGrounded = false;
  private inputSeq = 0;

  /**
   * Set the voxel integration for collision detection
   */
  setVoxelIntegration(voxel: VoxelIntegration): void {
    this.voxelIntegration = voxel;
  }

  /**
   * Get current input state to send to server
   */
  getInput(controls: Controls): MovementInput {
    return {
      buttons: controls.getButtonMask(),
      yaw: controls.yaw,
      pitch: controls.pitch,
      seq: this.inputSeq++,
    };
  }

  /**
   * Apply authoritative state from server snapshot
   * Server handles horizontal position, client handles vertical
   */
  applyServerState(snapshot: PlayerSnapshot): void {
    // Only apply horizontal position from server
    this.position.x = snapshot.x;
    this.position.z = snapshot.z;
    // Y is handled locally with physics
  }

  /**
   * Update local player physics and movement
   */
  update(deltaMs: number, controls: Controls): void {
    const dt = deltaMs / 1000;
    const buttons = controls.getButtonMask();

    // Use controls directly for responsive camera
    this.yaw = controls.yaw;
    this.pitch = controls.pitch;

    // Handle jump - only if grounded
    if (this.isGrounded && (buttons & INPUT_JUMP)) {
      this.velocity.y = JUMP_VELOCITY;
      this.isGrounded = false;
    }

    // Apply gravity
    this.velocity.y -= GRAVITY * dt;

    // Apply vertical velocity
    this.position.y += this.velocity.y * dt;

    // Calculate horizontal movement direction
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

      // Rotate by player yaw to get world direction
      const cos = Math.cos(this.yaw);
      const sin = Math.sin(this.yaw);
      const worldX = moveX * cos + moveZ * sin;
      const worldZ = -moveX * sin + moveZ * cos;

      // Apply speed
      let speed = MOVE_SPEED;
      if (buttons & INPUT_SPRINT) {
        speed *= SPRINT_MULTIPLIER;
      }

      this.position.x += worldX * speed * dt;
      this.position.z += worldZ * speed * dt;
    }

    // Apply voxel terrain collision
    this.resolveTerrainCollision();
  }

  /**
   * Resolve collision with voxel terrain using BVH
   */
  private resolveTerrainCollision(): void {
    if (!this.voxelIntegration) return;

    // PRIMARY: Use raycast for reliable ground detection
    // Cast from player position downward to find ground
    const rayOrigin = new THREE.Vector3(
      this.position.x,
      this.position.y + 1, // Start slightly above current position
      this.position.z
    );
    const rayDirection = new THREE.Vector3(0, -1, 0);
    
    const hit = this.voxelIntegration.raycast(rayOrigin, rayDirection, 20);
    
    if (hit) {
      const groundY = hit.point.y;
      const feetY = this.position.y - PLAYER_HEIGHT;
      
      // If feet are below or at ground level, snap to ground
      if (feetY <= groundY + 0.05) {
        this.position.y = groundY + PLAYER_HEIGHT;
        
        // Only stop falling if we were moving down
        if (this.velocity.y < 0) {
          this.velocity.y = 0;
          this.isGrounded = true;
        }
      } else {
        // Check if we're close enough to ground to be "grounded"
        if (feetY < groundY + 0.1) {
          this.isGrounded = true;
        } else {
          this.isGrounded = false;
        }
      }
    }

    // SECONDARY: Use capsule collision for horizontal walls
    const feetPos = new THREE.Vector3(
      this.position.x,
      this.position.y - PLAYER_HEIGHT + PLAYER_RADIUS,
      this.position.z
    );
    const headPos = new THREE.Vector3(
      this.position.x,
      this.position.y - PLAYER_RADIUS,
      this.position.z
    );

    const pushOut = this.voxelIntegration.resolveCapsuleCollision(
      feetPos,
      headPos,
      PLAYER_RADIUS
    );

    // Only apply horizontal push-out (walls)
    // Vertical is handled by raycast above
    if (Math.abs(pushOut.x) > 0.001 || Math.abs(pushOut.z) > 0.001) {
      this.position.x += pushOut.x;
      this.position.z += pushOut.z;
    }
  }

  /**
   * Check if player is grounded
   */
  getIsGrounded(): boolean {
    return this.isGrounded;
  }
}
