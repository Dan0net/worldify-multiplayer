/**
 * FirstPersonArm — a Minecraft-style first-person view model.
 *
 * A low-poly arm attached to the camera (so it stays fixed in view). It holds the
 * actual SurfaceNet mesh of the current build (the same model the thumbnails use)
 * while build mode is on, and an empty hand otherwise. A punch swing fires on
 * place/dig. Movement wobble is NOT applied here — the camera head-bob (which this
 * arm inherits, being a camera child) provides it. Drawn depthTest:false + high
 * renderOrder like the world markers so it never clips into nearby geometry.
 *
 * Module singleton, mirroring the camera/scene singletons.
 */

import * as THREE from 'three';
import type { BuildConfig, Quat } from '@worldify/shared';
import { createBuildItemMeshes } from '../../ui/PresetThumbnailRenderer';

let group: THREE.Group | null = null;   // attached to the camera
let hand: THREE.Group | null = null;    // holds the arm mesh + current build item
let heldItem: THREE.Object3D | null = null;
let heldKey = '';                        // rebuild guard (config + rotation + texture variant)

// Resting pose in camera-local space — low and to the right, angled up-forward.
const REST = new THREE.Vector3(0.34, -0.5, -0.7);

let swing = 0; // 1 on trigger, decays to 0

/** Build the arm and attach it to the camera (hidden until updated). */
export function initFirstPersonArm(camera: THREE.Camera): void {
  if (group) return;

  group = new THREE.Group();
  group.frustumCulled = false;
  group.renderOrder = 998;
  group.visible = false;

  hand = new THREE.Group();
  group.add(hand);

  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xd9a066, roughness: 0.85, metalness: 0.0, depthTest: false,
    // Slight self-illumination so the hand stays readable facing away from the sun.
    emissive: 0x3a2717, emissiveIntensity: 0.6,
  });
  // Forearm — a capsule rising up-and-forward from the lower right.
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.5, 4, 10), skinMat);
  arm.rotation.set(0.5, 0.25, -0.2);
  arm.position.set(0.05, -0.05, 0.02);
  arm.renderOrder = 998;
  arm.frustumCulled = false;
  hand.add(arm);

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

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
      o.geometry.dispose();
      const m = o.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
  });
}

function clearHeldItem(): void {
  if (heldItem && hand) {
    hand.remove(heldItem);
    disposeObject(heldItem);
  }
  heldItem = null;
  heldKey = '';
}

function itemKey(config: BuildConfig, rotation: Quat | undefined, variant: string): string {
  const r = rotation ? `${rotation.x.toFixed(3)},${rotation.y.toFixed(3)},${rotation.z.toFixed(3)},${rotation.w.toFixed(3)}` : '';
  return `${variant}|${config.mode}|${config.shape}|${config.size.x},${config.size.y},${config.size.z}|${config.material}|${config.thickness ?? 0}|${config.closed ?? 1}|${config.arcSweep ?? 0}|${r}`;
}

/**
 * Per-frame update. The held item is the real build mesh (rebuilt only when the
 * build or texture variant changes, and only once textures are ready so it's
 * textured).
 */
export function updateFirstPersonArm(opts: {
  visible: boolean;
  buildMode: boolean;
  config?: BuildConfig;
  rotation?: Quat;
  texturesReady: boolean;
  variant: string;
  dtMs: number;
}): void {
  if (!group || !hand) return;

  group.visible = opts.visible;
  if (!opts.visible) return;

  const dt = Math.min(opts.dtMs, 100) / 1000;

  // Punch swing (decays 1 → 0; peaks mid-decay for an out-and-back motion).
  if (swing > 0) swing = Math.max(0, swing - dt * 4.5);
  const punch = Math.sin(swing * Math.PI);
  group.position.set(REST.x, REST.y - punch * 0.06, REST.z - punch * 0.18);
  group.rotation.set(-punch * 0.7, 0, 0);

  // Held item — the real build mesh, rebuilt only when it changes.
  if (opts.buildMode && opts.config && opts.texturesReady) {
    const key = itemKey(opts.config, opts.rotation, opts.variant);
    if (key !== heldKey) {
      clearHeldItem();
      const mesh = createBuildItemMeshes(opts.config, opts.rotation);
      if (mesh) {
        mesh.position.set(0, 0.02, -0.32);
        mesh.rotation.set(0.35, 0.6, 0);
        hand.add(mesh);
        heldItem = mesh;
      }
      heldKey = key;
    }
  } else if (heldItem) {
    clearHeldItem();
  }
}

/** Dispose the arm resources. */
export function disposeFirstPersonArm(): void {
  if (!group) return;
  clearHeldItem();
  group.parent?.remove(group);
  disposeObject(group);
  group = null;
  hand = null;
}
