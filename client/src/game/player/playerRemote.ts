/**
 * Remote player representation
 * Handles interpolation between server snapshots
 */

import * as THREE from 'three';
import { PlayerSnapshot } from '@worldify/shared';

export class PlayerRemote {
  public readonly playerId: number;
  public readonly mesh: THREE.Group;

  private targetPosition = new THREE.Vector3();
  private targetYaw = 0;
  private currentYaw = 0;

  constructor(playerId: number) {
    this.playerId = playerId;

    // Create player group
    // Note: Server sends eye position (1.6m from ground), so we offset mesh down
    this.mesh = new THREE.Group();

    // Body (capsule) - total height ~1.6m (radius 0.3 * 2 + length 1.0)
    // Centered at y=0 relative to eye, so bottom is at -0.8, top at +0.8
    // Eye is at 1.6m, body center should be at ~0.9m, so offset = 0.9 - 1.6 = -0.7
    const bodyGeo = new THREE.CapsuleGeometry(0.3, 1.0, 4, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ 
      color: this.getPlayerColor(playerId)
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = -0.7; // Body center relative to eye position
    this.mesh.add(body);

    // Head (sphere) - at eye level
    const headGeo = new THREE.SphereGeometry(0.2, 8, 8);
    const headMat = new THREE.MeshStandardMaterial({ 
      color: 0xffdbac // Skin tone
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 0.1; // Slightly above eye level
    this.mesh.add(head);

    // Direction indicator - nose/visor sticking out front
    const visorGeo = new THREE.BoxGeometry(0.15, 0.08, 0.15);
    const visorMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 0.05, -0.25); // In front of head at eye level
    this.mesh.add(visor);
  }

  private getPlayerColor(playerId: number): number {
    // Generate a consistent color based on player ID
    const colors = [
      0xff6b6b, // Red
      0x4ecdc4, // Teal
      0xffe66d, // Yellow
      0x95e1d3, // Mint
      0xf38181, // Coral
      0xaa96da, // Purple
      0x45b7d1, // Blue
      0xf9ca24, // Gold
    ];
    return colors[playerId % colors.length];
  }

  applySnapshot(snapshot: PlayerSnapshot): void {
    this.targetPosition.set(snapshot.x, snapshot.y, snapshot.z);
    this.targetYaw = snapshot.yaw;
  }

  update(deltaMs: number): void {
    // Interpolate position smoothly
    const t = Math.min(1, deltaMs / 100);
    this.mesh.position.lerp(this.targetPosition, t);

    // Interpolate yaw (handle wrap-around)
    let yawDiff = this.targetYaw - this.currentYaw;
    // Normalize to [-PI, PI]
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    this.currentYaw += yawDiff * t;
    this.mesh.rotation.y = this.currentYaw;
  }

  dispose(): void {
    // Dispose all child geometries and materials
    this.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
    });
  }
}
