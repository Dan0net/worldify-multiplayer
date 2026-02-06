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
  MAX_FALL_TIME,
  DIRECTION_SMOOTH_SPEED,
  // Movement utilities from shared
  getWorldDirectionFromInput,
  lerpAngle,
} from '@worldify/shared';
import { Controls } from './controls';
import type { VoxelIntegration } from '../voxel/VoxelIntegration';
import type { CapsuleInfo } from '../voxel/VoxelCollision';

/** Callback type for respawn requests */
export type RespawnCallback = (currentPos: THREE.Vector3, lastGroundedPos: THREE.Vector3 | null) => void;

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

  // Fall detection
  private fallTime = 0; // Continuous time spent falling (seconds)
  private lastGroundedPosition: THREE.Vector3 | null = null;

  // Smooth direction tracking
  private smoothDirAngle = 0;
  private wasMoving = false;
  
  // Respawn callback (set by GameCore)
  private onRespawnNeeded: RespawnCallback | null = null;

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
   * Set callback for when player needs to respawn (fell too long)
   */
  setRespawnCallback(callback: RespawnCallback): void {
    this.onRespawnNeeded = callback;
  }

  /**
   * Get the last position where the player was grounded
   */
  getLastGroundedPosition(): THREE.Vector3 | null {
    return this.lastGroundedPosition;
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
      // Compute target direction angle
      const targetAngle = Math.atan2(worldDir.worldX, worldDir.worldZ);

      if (!this.wasMoving) {
        // Just started moving - snap to target direction for responsiveness
        this.smoothDirAngle = targetAngle;
      } else {
        // Smoothly rotate toward target (frame-rate independent exponential smoothing)
        const smoothFactor = 1 - Math.exp(-DIRECTION_SMOOTH_SPEED * dt);
        this.smoothDirAngle = lerpAngle(this.smoothDirAngle, targetAngle, smoothFactor);
      }

      // Use smoothed direction for movement
      const smoothX = Math.sin(this.smoothDirAngle);
      const smoothZ = Math.cos(this.smoothDirAngle);

      // Apply speed
      let speed = MOVE_SPEED;
      if (buttons & INPUT_SPRINT) {
        speed *= SPRINT_MULTIPLIER;
      }

      this.position.x += smoothX * speed * dt;
      this.position.z += smoothZ * speed * dt;

      this.wasMoving = true;
    } else {
      this.wasMoving = false;
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
    const wasGrounded = this.isGrounded;
    this.isGrounded = result.isOnGround;

    // Apply position correction
    this.position.add(result.deltaVector);

    // Track last grounded position for respawn
    if (this.isGrounded) {
      if (!this.lastGroundedPosition) {
        this.lastGroundedPosition = new THREE.Vector3();
      }
      this.lastGroundedPosition.copy(this.position);
      this.fallTime = 0; // Reset fall timer
    }

    // Track fall time (only when falling with negative velocity and not grounded)
    if (!this.isGrounded && this.velocity.y < 0) {
      this.fallTime += dt;
      
      // Check if fallen for too long
      if (this.fallTime > MAX_FALL_TIME) {
        this.triggerRespawn();
      }
    } else if (wasGrounded && !this.isGrounded) {
      // Just left ground (e.g. jumped) - don't reset fall time until actually falling down
      // Fall time is already 0 from being grounded
    }

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
   * Trigger a respawn request
   */
  private triggerRespawn(): void {
    if (this.onRespawnNeeded) {
      this.onRespawnNeeded(this.position.clone(), this.lastGroundedPosition);
    }
    // Reset fall time to prevent repeated triggers
    this.fallTime = 0;
  }

  /**
   * Respawn the player at a given position
   */
  respawn(position: THREE.Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.isGrounded = false;
    this.fallTime = 0;
  }

  /**
   * Check if player is grounded
   */
  getIsGrounded(): boolean {
    return this.isGrounded;
  }

  /**
   * Get current fall time in seconds
   */
  getFallTime(): number {
    return this.fallTime;
  }
}
