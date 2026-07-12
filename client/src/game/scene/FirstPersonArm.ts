/**
 * FirstPersonArm — a Minecraft-style first-person view model.
 *
 * A low-poly arm attached to the camera (so it stays fixed in view). It holds a
 * small block matching the current build's material while build mode is on, and
 * an empty hand otherwise. Subtle walk-bob from movement, and a punch swing on
 * place/dig. Drawn with depthTest:false + high renderOrder like the world markers
 * so it never clips into nearby geometry.
 *
 * Module singleton, mirroring the camera/scene singletons.
 */

import * as THREE from 'three';
import { Materials } from '@worldify/shared';

let group: THREE.Group | null = null;
let heldBlock: THREE.Mesh | null = null;
let heldMat: THREE.MeshStandardMaterial | null = null;

// Resting pose in camera-local space (bottom-right, just in front of the near plane).
const REST = new THREE.Vector3(0.34, -0.36, -0.7);

let bobPhase = 0;
let swing = 0; // 1 on trigger, decays to 0

/** Build the arm + held block and attach to the camera (hidden until updated). */
export function initFirstPersonArm(camera: THREE.Camera): void {
  if (group) return;

  group = new THREE.Group();
  group.frustumCulled = false;
  group.renderOrder = 998;
  group.visible = false;

  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xd9a066, roughness: 0.85, metalness: 0.0, depthTest: false,
    // Slight self-illumination so the hand stays readable facing away from the sun.
    emissive: 0x3a2717, emissiveIntensity: 0.6,
  });
  // Forearm — a capsule angled forward from the lower-right.
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.5, 4, 10), skinMat);
  arm.rotation.set(1.15, 0.15, -0.15);
  arm.position.set(0.02, -0.05, 0.12);
  arm.renderOrder = 998;
  arm.frustumCulled = false;
  group.add(arm);

  // Held block — tinted to the current build material while build mode is on.
  heldMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0.0, depthTest: false, emissiveIntensity: 0.35 });
  heldBlock = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), heldMat);
  heldBlock.position.set(-0.02, 0.06, -0.3);
  heldBlock.rotation.set(0.3, 0.5, 0);
  heldBlock.renderOrder = 999;
  heldBlock.frustumCulled = false;
  heldBlock.visible = false;
  group.add(heldBlock);

  group.position.copy(REST);
  camera.add(group);
}

/** Trigger a one-shot punch swing (call when a build is placed/dug). */
export function triggerArmSwing(): void {
  swing = 1;
}

/** Hide the arm (non-Playing modes / menu open). */
export function setFirstPersonArmVisible(visible: boolean): void {
  if (group) group.visible = visible;
}

/**
 * Per-frame update. `speed` is the movement magnitude (0..1) for walk-bob;
 * `buildMode`/`materialId` drive the held block.
 */
export function updateFirstPersonArm(opts: {
  visible: boolean;
  buildMode: boolean;
  materialId: number;
  speed: number;
  dtMs: number;
}): void {
  if (!group || !heldBlock || !heldMat) return;

  group.visible = opts.visible;
  if (!opts.visible) return;

  const dt = Math.min(opts.dtMs, 100) / 1000;
  const moving = opts.speed > 0.1;

  // Walk-bob + sway while moving.
  if (moving) bobPhase += dt * 8;
  const bob = moving ? Math.sin(bobPhase * 2) * 0.02 : 0;
  const sway = moving ? Math.cos(bobPhase) * 0.018 : 0;

  // Punch swing (decays 1 → 0; peaks mid-decay for an out-and-back motion).
  if (swing > 0) swing = Math.max(0, swing - dt * 4.5);
  const punch = Math.sin(swing * Math.PI);

  group.position.set(REST.x + sway, REST.y + bob - punch * 0.06, REST.z - punch * 0.18);
  group.rotation.set(-punch * 0.7, 0, 0);

  // Held block reflects the current build.
  heldBlock.visible = opts.buildMode;
  if (opts.buildMode) {
    const hex = Materials.getColor(opts.materialId);
    heldMat.color.set(hex);
    heldMat.emissive.set(hex);
  }
}

/** Dispose the arm resources. */
export function disposeFirstPersonArm(): void {
  if (!group) return;
  group.parent?.remove(group);
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  group = null;
  heldBlock = null;
  heldMat = null;
}
