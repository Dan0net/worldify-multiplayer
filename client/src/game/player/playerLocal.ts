/**
 * Local player controller
 * Handles input, movement, physics, and voxel terrain collision
 * 
 * Uses physics sub-stepping and capsule collision with three-mesh-bvh,
 * similar to worldify-app's Player.ts implementation.
 */

import * as THREE from 'three';
import { 
  MovementInput, 
  PlayerSnapshot,
  INPUT_JUMP,
  INPUT_SPRINT,
  // Physics constants from shared
  MOVE_SPEED,
  SPRINT_MULTIPLIER,
  GRAVITY,
  JUMP_VELOCITY,
  PLAYER_HEIGHT_INNER,
  PLAYER_RADIUS,
  PHYSICS_STEPS,
  // Movement utilities from shared
  getWorldDirectionFromInput,
} from '@worldify/shared';
import { Controls } from './controls';
import type { VoxelIntegration } from '../voxel/VoxelIntegration';
import type { CapsuleInfo } from '../voxel/VoxelCollision';

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

  // Capsule info (reused each frame)
  private capsuleInfo: CapsuleInfo = {
    radius: PLAYER_RADIUS,
    segment: new THREE.Line3(
      new THREE.Vector3(0, 0, 0), // Start (head)
      new THREE.Vector3(0, -PLAYER_HEIGHT_INNER, 0) // End (feet)
    ),
  };

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
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
    };
  }

  /**
   * Apply authoritative state from server snapshot
   * Movement is client-authoritative, so we ignore server position
   */
  applyServerState(_snapshot: PlayerSnapshot): void {
    // Client-authoritative movement: don't apply server position
    // Server just relays our position to other clients
  }

  /**
   * Update local player physics and movement
   * Uses sub-stepping for stable physics at any frame rate
   */
  update(deltaMs: number, controls: Controls): void {
    const dt = Math.min(deltaMs / 1000, 0.1); // Cap at 100ms to prevent spiral of death
    const buttons = controls.getButtonMask();

    // Use controls directly for responsive camera
    this.yaw = controls.yaw;
    this.pitch = controls.pitch;

    // Handle jump - only if grounded
    if (this.isGrounded && (buttons & INPUT_JUMP)) {
      this.velocity.y = JUMP_VELOCITY;
      this.isGrounded = false;
    }

    // Run physics in sub-steps for stability
    const deltaStep = dt / PHYSICS_STEPS;
    for (let i = 0; i < PHYSICS_STEPS; i++) {
      this.physicsStep(deltaStep, buttons);
    }
  }

  /**
   * Single physics sub-step
   */
  private physicsStep(dt: number, buttons: number): void {
    // Apply gravity
    if (this.isGrounded) {
      // Small downward force to keep grounded
      this.velocity.y = GRAVITY * dt;
    } else {
      this.velocity.y += GRAVITY * dt;
    }

    // Apply vertical velocity
    this.position.y += this.velocity.y * dt;

    // Calculate horizontal movement using shared utility
    const worldDir = getWorldDirectionFromInput(buttons, this.yaw);
    if (worldDir) {
      // Apply speed
      let speed = MOVE_SPEED;
      if (buttons & INPUT_SPRINT) {
        speed *= SPRINT_MULTIPLIER;
      }

      this.position.x += worldDir.worldX * speed * dt;
      this.position.z += worldDir.worldZ * speed * dt;
    }

    // Apply voxel terrain collision
    this.resolveTerrainCollision(dt);
  }

  /**
   * Resolve collision with voxel terrain using capsule collision.
   * Uses three-mesh-bvh's shapecast for efficient collision detection,
   * similar to worldify-app's Player.ts collisionUpdate method.
   */
  private resolveTerrainCollision(dt: number): void {
    if (!this.voxelIntegration) return;

    // Get collision result using capsule-based collision
    const result = this.voxelIntegration.resolveCapsuleCollision(
      this.capsuleInfo,
      this.position,
      this.velocity,
      dt
    );

    // Update grounded state from collision result
    this.isGrounded = result.isOnGround;

    // Apply position correction
    this.position.add(result.deltaVector);

    // Adjust velocity based on collision
    if (!this.isGrounded && result.collided) {
      // Remove velocity component in collision direction
      const deltaDir = result.deltaVector.clone().normalize();
      this.velocity.addScaledVector(deltaDir, -deltaDir.dot(this.velocity));
    } else if (this.isGrounded) {
      // On ground - zero out velocity
      this.velocity.set(0, 0, 0);
    }
  }

  /**
   * Check if player is grounded
   */
  getIsGrounded(): boolean {
    return this.isGrounded;
  }
}
