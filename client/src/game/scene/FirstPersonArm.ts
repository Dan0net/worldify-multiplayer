/**
 * FirstPersonArm — a Minecraft-style first-person view model.
 *
 * A low-poly arm holding the actual SurfaceNet mesh of the current build (the same
 * model the thumbnails use, with the real terrain materials) while build mode is on,
 * and an empty hand otherwise. A punch swing fires on place/dig.
 *
 * Rendering: the arm lives in the MAIN scene (so the world's day/night lights
 * illuminate it) but on dedicated first-person layers, excluded from the normal
 * composed render. It is drawn by its own ORTHOGRAPHIC camera (`vmCamera`) so the
 * main camera's FOV/aspect never skews it and it renders at a consistent size —
 * like the build thumbnails (which also use an ortho camera). `renderFirstPersonArm`
 * draws the arm then the item, each over a cleared depth buffer, so nothing occludes
 * them.
 *
 * Module singleton, mirroring the camera/scene singletons.
 */

import * as THREE from 'three';
import type { BuildConfig, Quat } from '@worldify/shared';
import { createBuildItemMeshes } from '../../ui/PresetThumbnailRenderer';
import { FIRST_PERSON_LAYER, FIRST_PERSON_ITEM_LAYER } from './firstPersonLayer';
import { getCamera } from './camera';

let vmCamera: THREE.OrthographicCamera | null = null; // dedicated view-model camera
let group: THREE.Group | null = null;   // arm rig; positioned in vmCamera space each frame
let hand: THREE.Group | null = null;    // holds the arm mesh + current build item
let armSkinMat: THREE.MeshStandardMaterial | null = null;
let heldItem: THREE.Object3D | null = null;
let heldKey = '';                        // rebuild guard (config + rotation + texture variant)

const ARM_DEPTH = 2;     // vm-camera-local Z of the arm (ortho: clip only, not size)
const CORNER_X = 0.9;    // fraction of the ortho half-width → toward the right edge
const CORNER_Y = 0.9;    // fraction of the ortho half-height → toward the bottom edge
/**
 * Overall view-model size. The ortho frustum is scaled by sqrt(w*h) (rotation-
 * invariant), so the world→pixel scale — and thus the arm's pixel size — is the
 * same in portrait and landscape. Larger VM_SIZE → smaller arm.
 */
const VM_SIZE = 2.2;
/** Scales the (camera) head-bob applied inversely to the arm — keep the arm sway subtle. */
const ARM_BOB_SCALE = 0.6;

/**
 * Orientation that makes the held item present the SAME face as its thumbnail.
 * The thumbnail camera views from (-0.8, 0.6, -0.8); applying the inverse of that
 * view orientation to the item makes the view-model camera (looking down -Z)
 * reproduce the thumbnail angle.
 */
const HELD_ITEM_QUAT = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().lookAt(
    new THREE.Vector3(-0.8, 0.6, -0.8),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0),
  ),
).invert();

let swing = 0; // 1 on trigger, decays to 0
let visible = false;

/** Put an object and all descendants on a single layer. */
function setLayerDeep(obj: THREE.Object3D, layer: number): void {
  obj.traverse((o) => o.layers.set(layer));
}

/** Build the arm + its dedicated ortho camera and add them to the scene (hidden). */
export function initFirstPersonArm(scene: THREE.Scene): void {
  if (group) return;

  vmCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  scene.add(vmCamera); // in the scene graph so its child arm renders + is lit

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
  // Forearm — a slim capsule (Minecraft-style) coming from the bottom-right corner,
  // the wrist behind/below the held block (which draws over it). Tuned in an
  // isolated harness to match Minecraft's block-in-hand layout.
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.72, 4, 10), armSkinMat);
  arm.rotation.set(-0.1, 0.1, 0.66);
  arm.position.set(0.05, -0.06, 0.1);
  arm.frustumCulled = false;
  hand.add(arm);

  setLayerDeep(group, FIRST_PERSON_LAYER);
  vmCamera.add(group);
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
 * Size the ortho frustum so the world→pixel scale is sqrt(w*h)-based, i.e. the
 * SAME in portrait and landscape → the arm renders at a consistent pixel size.
 * Returns the current half-width/half-height for corner placement.
 */
function sizeVmCamera(): { halfW: number; halfH: number } {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  const ref = Math.sqrt(w * h);
  const halfW = 0.5 * (w / ref) * VM_SIZE;
  const halfH = 0.5 * (h / ref) * VM_SIZE;
  if (vmCamera) {
    vmCamera.left = -halfW; vmCamera.right = halfW;
    vmCamera.top = halfH; vmCamera.bottom = -halfH;
    vmCamera.updateProjectionMatrix();
  }
  return { halfW, halfH };
}

/**
 * Per-frame update: anchors the arm to the bottom-right of the ortho frustum (so it
 * sits in the corner at a consistent size in any orientation), applies the punch
 * swing + inverse head-bob, and rebuilds the held build mesh only when it changes.
 */
export function updateFirstPersonArm(opts: {
  visible: boolean;
  buildMode: boolean;
  config?: BuildConfig;
  rotation?: Quat;
  texturesReady: boolean;
  variant: string;
  headBob: number;
  dtMs: number;
}): void {
  if (!group || !hand) return;

  visible = opts.visible;
  group.visible = opts.visible;
  if (!opts.visible) return;

  const dt = Math.min(opts.dtMs, 100) / 1000;

  const { halfW, halfH } = sizeVmCamera();
  const baseX = halfW * CORNER_X;
  const baseY = -halfH * CORNER_Y;

  // Punch swing (decays 1 → 0; peaks mid-decay for an out-and-back motion).
  if (swing > 0) swing = Math.max(0, swing - dt * 4.5);
  const punch = Math.sin(swing * Math.PI);

  // Inverse head-bob: the arm counter-moves to the camera's walk head-bob (scaled
  // down so the arm sway is subtle).
  group.position.set(baseX, baseY - punch * 0.18 - opts.headBob * ARM_BOB_SCALE, -ARM_DEPTH);
  group.rotation.set(-punch * 0.7, 0, 0);

  // Held item — the real build mesh, rebuilt only when it changes.
  if (opts.buildMode && opts.config && opts.texturesReady) {
    const key = itemKey(opts.config, opts.rotation, opts.variant);
    if (key !== heldKey) {
      clearHeldItem();
      const mesh = createBuildItemMeshes(opts.config, opts.rotation);
      if (mesh) {
        mesh.position.set(-0.16, 0.24, -0.3);  // held in the lower-right, Minecraft-style
        mesh.quaternion.copy(HELD_ITEM_QUAT);  // thumbnail's 3/4 view angle
        mesh.scale.multiplyScalar(1.27);       // ~0.33 world extent (from the 0.26 base)
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
 * Render the arm on top of the composited frame, with its own ortho camera. Draws
 * the arm layer then the item layer, each over a cleared depth buffer, using the
 * same renderer/tone-mapping as the world. Call right after the composer.
 */
export function renderFirstPersonArm(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
  if (!group || !vmCamera || !visible) return;

  // Match the main camera's orientation so the scene lights hit the arm/item the
  // same way they'd hit the world in view — i.e. lighting responds to the player's
  // facing + time of day. The arm stays screen-locked (it's a child at a fixed
  // local offset) and undistorted (ortho); only the light direction relative to it
  // changes. The object-space held-item texture is unaffected by this rotation.
  const mainCam = getCamera();
  if (mainCam) vmCamera.quaternion.copy(mainCam.quaternion);

  const prevShadowAuto = renderer.shadowMap.autoUpdate;
  const prevAutoClear = renderer.autoClear;
  renderer.shadowMap.autoUpdate = false;   // don't recompute world shadows for this pass
  renderer.autoClear = false;

  // Pass 1 — the arm, over the composited world.
  renderer.clearDepth();
  vmCamera.layers.set(FIRST_PERSON_LAYER);
  renderer.render(scene, vmCamera);

  // Pass 2 — the held item, over the arm (fresh depth → always on top, no z-fight).
  renderer.clearDepth();
  vmCamera.layers.set(FIRST_PERSON_ITEM_LAYER);
  renderer.render(scene, vmCamera);

  // Restore renderer state EXACTLY as it was. The pmndrs EffectComposer keeps
  // `autoClear = false` and does its own per-pass clearing; hardcoding it back to `true`
  // here (the original bug) let the composer auto-clear the GodRaysEffect's internal
  // occlusion targets on the next frame, so the sun disc lost its occlusion mask and the
  // whole bright sky leaked into the rays — the blue full-frame wash seen in first-person.
  renderer.autoClear = prevAutoClear;
  renderer.shadowMap.autoUpdate = prevShadowAuto;
}

/** Dispose the arm resources. */
export function disposeFirstPersonArm(): void {
  if (!group) return;
  clearHeldItem();
  vmCamera?.parent?.remove(vmCamera);
  group.parent?.remove(group);
  disposeArmObject(group);
  armSkinMat?.dispose();
  armSkinMat = null;
  group = null;
  hand = null;
  vmCamera = null;
}
