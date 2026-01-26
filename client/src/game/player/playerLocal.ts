/**
 * Local player controller
 * Handles input, movement, and camera
 */

import * as THREE from 'three';
import { MovementInput, PlayerSnapshot } from '@worldify/shared';
import { Controls } from './controls';

export class PlayerLocal {
  // Position from server
  public position = new THREE.Vector3(0, 1.6, 0);
  public yaw = 0;
  public pitch = 0;

  // Target position for interpolation
  private targetPosition = new THREE.Vector3(0, 1.6, 0);

  // Velocity is not used client-side (server authoritative)
  public velocity = new THREE.Vector3();

  private inputSeq = 0;

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
   */
  applyServerState(snapshot: PlayerSnapshot): void {
    this.targetPosition.set(snapshot.x, snapshot.y, snapshot.z);
  }

  /**
   * Update local player (interpolation to server state)
   */
  update(deltaMs: number, controls: Controls): void {
    // Interpolate position smoothly to server position
    const t = Math.min(1, deltaMs / 100);
    this.position.lerp(this.targetPosition, t);

    // Use controls directly for responsive camera
    this.yaw = controls.yaw;
    this.pitch = controls.pitch;
  }
}
