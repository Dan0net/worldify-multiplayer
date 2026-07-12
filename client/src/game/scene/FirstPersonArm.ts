/**
 * FirstPersonArm — a Minecraft-style first-person view model.
 *
 * A low-poly arm attached to the camera. It holds the actual SurfaceNet mesh of
 * the current build (the same model the thumbnails use, with the real terrain
 * materials) while build mode is on, and an empty hand otherwise. A punch swing
 * fires on place/dig. Movement wobble comes from the camera head-bob (inherited,
 * being a camera child).
 *
 * Rendering: the arm lives in the MAIN scene (so the world's day/night lights
 * illuminate it) but on FIRST_PERSON_LAYER, excluded from the normal composed
 * render. `renderFirstPersonArm` then draws only that layer on top of everything,
 * with a cleared depth buffer — so it's never occluded by water/geometry.
 *
 * Module singleton, mirroring the camera/scene singletons.
 */

import * as THREE from 'three';
import type { BuildConfig, Quat } from '@worldify/shared';
import { createBuildItemMeshes } from '../../ui/PresetThumbnailRenderer';
import { FIRST_PERSON_LAYER, FIRST_PERSON_ITEM_LAYER } from './firstPersonLayer';

let group: THREE.Group | null = null;   // attached to the camera; positioned each frame
let hand: THREE.Group | null = null;    // holds the arm mesh + current build item
let armSkinMat: THREE.MeshStandardMaterial | null = null;
let heldItem: THREE.Object3D | null = null;
let heldKey = '';                        // rebuild guard (config + rotation + texture variant)

const ARM_DEPTH = 0.7;   // camera-local distance the arm sits in front of the eye
const CORNER_X = 0.9;    // fraction of the frustum half-width → pins to the right edge
const CORNER_Y = 0.92;   // fraction of the frustum half-height → pins to the bottom edge

let swing = 0; // 1 on trigger, decays to 0
let visible = false;

/** Put an object and all descendants on a single layer. */
function setLayerDeep(obj: THREE.Object3D, layer: number): void {
  obj.traverse((o) => o.layers.set(layer));
}

/** Build the arm and attach it to the camera (hidden until updated). */
export function initFirstPersonArm(camera: THREE.Camera): void {
  if (group) return;

  group = new THREE.Group();
  group.frustumCulled = false;
  group.visible = false;

  hand = new THREE.Group();
  group.add(hand);

  armSkinMat = new THREE.MeshStandardMaterial({
    color: 0xd9a066, roughness: 0.85, metalness: 0.0,
    // Slight self-illumination so the hand keeps some form at night.
    emissive: 0x3a2717, emissiveIntensity: 0.35,
  });
  // Forearm — a capsule rising from the bottom-right corner up toward the held
  // item, tilted back so the hand sits BEHIND the item (which draws over it).
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.52, 4, 10), armSkinMat);
  arm.rotation.set(-0.55, 0.1, 0.42);
  arm.position.set(0.02, -0.06, 0.06);
  arm.frustumCulled = false;
  hand.add(arm);

  setLayerDeep(group, FIRST_PERSON_LAYER);
  camera.add(group);
}

/** Trigger a one-shot punch swing (call when a build is placed/dug). */
export function triggerArmSwing(): void {
  swing = 1;
}

/** Hide the arm (non-Playing modes / menu open). */
export function setFirstPersonArmVisible(v: boolean): void {
  visible = v;
  if (group) group.visible = v;
}

function disposeArmObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
      o.geometry.dispose();
      // Only dispose dedicated held-item materials; shared terrain/water/wireframe
      // materials are reused elsewhere and must not be disposed.
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.userData?.heldItem) m.dispose();
    }
  });
}

function clearHeldItem(): void {
  if (heldItem && hand) {
    hand.remove(heldItem);
    disposeArmObject(heldItem);
  }
  heldItem = null;
  heldKey = '';
}

function itemKey(config: BuildConfig, rotation: Quat | undefined, variant: string): string {
  const r = rotation ? `${rotation.x.toFixed(3)},${rotation.y.toFixed(3)},${rotation.z.toFixed(3)},${rotation.w.toFixed(3)}` : '';
  return `${variant}|${config.mode}|${config.shape}|${config.size.x},${config.size.y},${config.size.z}|${config.material}|${config.thickness ?? 0}|${config.closed ?? 1}|${config.arcSweep ?? 0}|${r}`;
}

/**
 * Per-frame update: anchors the arm to the bottom-right frustum corner (so it
 * stays put across aspect/fov), applies the punch swing, and rebuilds the held
 * build mesh only when it changes (and only once textures are ready).
 */
export function updateFirstPersonArm(opts: {
  visible: boolean;
  buildMode: boolean;
  config?: BuildConfig;
  rotation?: Quat;
  texturesReady: boolean;
  variant: string;
  fovDeg: number;
  aspect: number;
  dtMs: number;
}): void {
  if (!group || !hand) return;

  visible = opts.visible;
  group.visible = opts.visible;
  if (!opts.visible) return;

  const dt = Math.min(opts.dtMs, 100) / 1000;

  // Anchor to the frustum corner: same screen position regardless of aspect/fov.
  const halfH = ARM_DEPTH * Math.tan((opts.fovDeg * Math.PI) / 180 / 2);
  const halfW = halfH * opts.aspect;
  const baseX = halfW * CORNER_X;
  const baseY = -halfH * CORNER_Y;

  // Punch swing (decays 1 → 0; peaks mid-decay for an out-and-back motion).
  if (swing > 0) swing = Math.max(0, swing - dt * 4.5);
  const punch = Math.sin(swing * Math.PI);
  group.position.set(baseX, baseY - punch * 0.06, -ARM_DEPTH - punch * 0.18);
  group.rotation.set(-punch * 0.7, 0, 0);

  // Held item — the real build mesh, rebuilt only when it changes.
  if (opts.buildMode && opts.config && opts.texturesReady) {
    const key = itemKey(opts.config, opts.rotation, opts.variant);
    if (key !== heldKey) {
      clearHeldItem();
      const mesh = createBuildItemMeshes(opts.config, opts.rotation);
      if (mesh) {
        mesh.position.set(-0.14, 0.16, -0.16);
        mesh.rotation.set(0.35, 0.6, 0);
        setLayerDeep(mesh, FIRST_PERSON_ITEM_LAYER); // drawn over the arm
        hand.add(mesh);
        heldItem = mesh;
      }
      heldKey = key;
    }
  } else if (heldItem) {
    clearHeldItem();
  }
}

/**
 * Render the arm on top of the composited frame. Draws only FIRST_PERSON_LAYER
 * with a cleared depth buffer, using the same renderer/tone-mapping as the world.
 * Call right after the post-processing composer.
 */
export function renderFirstPersonArm(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  if (!group || !visible) return;

  const prevMask = camera.layers.mask;
  const prevShadowAuto = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;   // don't recompute world shadows for this pass
  renderer.autoClear = false;

  // Pass 1 — the arm, over the composited world.
  renderer.clearDepth();
  camera.layers.set(FIRST_PERSON_LAYER);
  renderer.render(scene, camera);

  // Pass 2 — the held item, over the arm (fresh depth → always on top, no z-fight).
  renderer.clearDepth();
  camera.layers.set(FIRST_PERSON_ITEM_LAYER);
  renderer.render(scene, camera);

  camera.layers.mask = prevMask;
  renderer.autoClear = true;
  renderer.shadowMap.autoUpdate = prevShadowAuto;
}

/** Dispose the arm resources. */
export function disposeFirstPersonArm(): void {
  if (!group) return;
  clearHeldItem();
  group.parent?.remove(group);
  disposeArmObject(group);
  armSkinMat?.dispose();
  armSkinMat = null;
  group = null;
  hand = null;
}
