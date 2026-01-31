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

    const playerColor = this.getPlayerColor(playerId);

    // Body (rounded capsule) - friendly blob shape
    const bodyGeo = new THREE.CapsuleGeometry(0.35, 0.8, 8, 16);
    const bodyMat = new THREE.MeshStandardMaterial({ 
      color: playerColor,
      roughness: 0.6,
      metalness: 0.1,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = -0.65;
    body.castShadow = true;
    body.receiveShadow = true;
    this.mesh.add(body);

    // Head (larger, rounder for friendly look)
    const headGeo = new THREE.SphereGeometry(0.28, 16, 16);
    const headMat = new THREE.MeshStandardMaterial({ 
      color: 0xffdbac,
      roughness: 0.7,
      metalness: 0,
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 0.08;
    head.castShadow = true;
    head.receiveShadow = true;
    this.mesh.add(head);

    // --- Face elements ---
    
    // Left eye white
    const eyeWhiteGeo = new THREE.SphereGeometry(0.07, 8, 8);
    const eyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const leftEyeWhite = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
    leftEyeWhite.position.set(-0.09, 0.12, -0.22);
    leftEyeWhite.scale.z = 0.5;
    this.mesh.add(leftEyeWhite);

    // Right eye white
    const rightEyeWhite = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
    rightEyeWhite.position.set(0.09, 0.12, -0.22);
    rightEyeWhite.scale.z = 0.5;
    this.mesh.add(rightEyeWhite);

    // Left pupil
    const pupilGeo = new THREE.SphereGeometry(0.035, 8, 8);
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    const leftPupil = new THREE.Mesh(pupilGeo, pupilMat);
    leftPupil.position.set(-0.09, 0.12, -0.26);
    this.mesh.add(leftPupil);

    // Right pupil
    const rightPupil = new THREE.Mesh(pupilGeo, pupilMat);
    rightPupil.position.set(0.09, 0.12, -0.26);
    this.mesh.add(rightPupil);

    // Smile (curved line using torus)
    const smileGeo = new THREE.TorusGeometry(0.08, 0.015, 8, 16, Math.PI);
    const smileMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
    const smile = new THREE.Mesh(smileGeo, smileMat);
    smile.position.set(0, 0.0, -0.24);
    smile.rotation.x = Math.PI; // Flip to make it a smile
    smile.rotation.z = Math.PI; // Orient correctly
    this.mesh.add(smile);

    // Cheek blush (left)
    const blushGeo = new THREE.CircleGeometry(0.04, 16);
    const blushMat = new THREE.MeshBasicMaterial({ 
      color: 0xffaaaa, 
      transparent: true, 
      opacity: 0.5 
    });
    const leftBlush = new THREE.Mesh(blushGeo, blushMat);
    leftBlush.position.set(-0.18, 0.02, -0.21);
    leftBlush.rotation.y = 0.4;
    this.mesh.add(leftBlush);

    // Cheek blush (right)
    const rightBlush = new THREE.Mesh(blushGeo, blushMat);
    rightBlush.position.set(0.18, 0.02, -0.21);
    rightBlush.rotation.y = -0.4;
    this.mesh.add(rightBlush);

    // Little hat/cap in player color for personality
    const hatGeo = new THREE.CylinderGeometry(0.15, 0.2, 0.12, 16);
    const hatMat = new THREE.MeshStandardMaterial({ 
      color: playerColor,
      roughness: 0.5,
    });
    const hat = new THREE.Mesh(hatGeo, hatMat);
    hat.position.set(0, 0.32, -0.02);
    hat.rotation.x = -0.15;
    this.mesh.add(hat);

    // Hat brim
    const brimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.03, 16);
    const brim = new THREE.Mesh(brimGeo, hatMat);
    brim.position.set(0, 0.26, -0.08);
    brim.rotation.x = -0.15;
    this.mesh.add(brim);
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
