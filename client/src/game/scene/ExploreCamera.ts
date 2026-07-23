/**
 * ExploreCamera — free 3rd-person camera for the home / explore screen.
 *
 * Orbits a ground `target` the user can PAN (drag), ROTATE (right-drag / two-finger),
 * and ZOOM (wheel / pinch). Starts pitched 45° down. Unlike the FPS camera it is not
 * driven by the player; unlike the old spectator camera it does not auto-orbit.
 *
 * The `target` doubles as the world's stream/shadow center while exploring, so panning
 * loads terrain where you look. State is module-level (one camera, one explore session).
 */

import * as THREE from 'three';
import { MAX_ZOOM_LEVEL } from '@worldify/shared';

const target = new THREE.Vector3(0, 0, 0);
let yaw = 0;
let pitch = -Math.PI / 4;   // 45° down

// LOD zoom. `zoomExp` is the CONTINUOUS wheel-driven zoom (0…MAX_ZOOM_LEVEL); the camera distance is
// BASE_DISTANCE·2^zoomExp so zooming feels smooth/analog while the world's apparent chunk size stays
// roughly constant (a level-L chunk is 2^L bigger, viewed from 2^L further). The DISCRETE data level is
// round(zoomExp) with a settle-debounced dead-band (getExploreZoomLevel) so wheel jitter can't flip
// levels and a fast multi-threshold sweep jumps straight to where it settles (no intermediate loads).
let zoomExp = 0;
const BASE_DISTANCE = 32;
let distance = BASE_DISTANCE;

// Look-down range: never flip past straight-down or up above the horizon.
const MIN_PITCH = -Math.PI / 2 + 0.05;
const MAX_PITCH = -0.12;

const ROTATE_SPEED = 0.009;   // radians per pixel
const PAN_SPEED = 0.0016;     // world units per pixel, per unit distance
const ZOOM_EXP_SPEED = 0.0025;   // zoomExp change per wheel delta unit
const PINCH_ZOOM = 0.006;        // per pixel of pinch distance change (→ zoomExp via ZOOM_EXP_SPEED)

// Discrete level state (hysteresis + settle debounce).
let committedLevel = 0;
let pendingTarget = 0;
let pendingSince = 0;
const LEVEL_SETTLE_MS = 160;

function applyZoom(): void {
  distance = BASE_DISTANCE * Math.pow(2, zoomExp);
}

/** Discrete LOD data level for the current zoom. Snaps to round(zoomExp) only after it has held
 *  steady for LEVEL_SETTLE_MS, so a fast sweep skips the levels it passes through. */
export function getExploreZoomLevel(): number {
  const t = Math.max(0, Math.min(MAX_ZOOM_LEVEL, Math.round(zoomExp)));
  if (t !== committedLevel) {
    const now = (typeof performance !== 'undefined' ? performance.now() : 0);
    if (t !== pendingTarget) { pendingTarget = t; pendingSince = now; }
    else if (now - pendingSince >= LEVEL_SETTLE_MS) committedLevel = t;
  } else {
    pendingTarget = t;
  }
  return committedLevel;
}

/** Linear scale factor (2^level) for the current committed data level. */
export function getExploreZoomScale(): number {
  return 1 << committedLevel;
}

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _fwd = new THREE.Vector3();

// Recenter glide: eases `target` (ease-in-out) from where it was to a new spawn point, so
// tapping/dragging the spawn marker pans smoothly to re-center on it.
const GLIDE_DURATION_MS = 350;
const glideFrom = new THREE.Vector3();
const glideTo = new THREE.Vector3();
let glideMs = 0;
let gliding = false;

// True while the user is grabbing/dragging the spawn marker; the center-follow that pins
// the spawn to screen center is suspended so the drag isn't immediately overridden.
let markerInteracting = false;

/** Seed the explore camera at a world center (e.g. saved player position). */
export function initExploreCamera(center: THREE.Vector3): void {
  target.copy(center);
  yaw = 0;
  pitch = -Math.PI / 4;
  zoomExp = 0;
  committedLevel = 0;
  pendingTarget = 0;
  applyZoom();
  gliding = false;
  markerInteracting = false;
}

/** Mark whether the user is actively manipulating the spawn marker (suspends center-follow). */
export function setExploreMarkerInteracting(v: boolean): void {
  markerInteracting = v;
}
export function isExploreMarkerInteracting(): boolean {
  return markerInteracting;
}

/** Start a smooth glide of the orbit target to `dest` (recenter on a moved spawn). */
export function beginExploreTargetGlide(dest: THREE.Vector3): void {
  glideFrom.copy(target);
  glideTo.copy(dest);
  glideMs = GLIDE_DURATION_MS;
  gliding = true;
}

/** True while a recenter glide is in progress (center-follow stays suspended meanwhile). */
export function isExploreGliding(): boolean {
  return gliding;
}

/** Advance an in-progress recenter glide. Call each frame with the frame delta (ms). */
export function advanceExploreTargetGlide(deltaMs: number): void {
  if (!gliding) return;
  glideMs = Math.max(0, glideMs - deltaMs);
  const t = 1 - glideMs / GLIDE_DURATION_MS;
  const eased = t * t * (3 - 2 * t);   // smoothstep
  target.copy(glideFrom).lerp(glideTo, eased);
  if (glideMs === 0) gliding = false;
}

/** The current orbit target — also used as the world stream/shadow center. */
export function getExploreTarget(): THREE.Vector3 {
  return target;
}

// Base near/far (must match createCamera). At coarse LOD the whole scene is scaled by 2^level, so the
// camera sits 2^level further out and the terrain extends 2^level further — the fixed far plane would
// clip it. Scale near+far by the zoom so the view volume grows with the world; keeping the near:far
// RATIO constant preserves depth-buffer precision (no z-fighting) at every level.
const BASE_NEAR = 0.1;
const BASE_FAR = 1000;

/** Reset the camera near/far planes to their base (play / full detail). */
export function resetCameraClipPlanes(camera: THREE.PerspectiveCamera): void {
  if (camera.near !== BASE_NEAR || camera.far !== BASE_FAR) {
    camera.near = BASE_NEAR;
    camera.far = BASE_FAR;
    camera.updateProjectionMatrix();
  }
}

/** Position + orient the camera from the current orbit state. Call each frame. */
export function updateExploreCamera(camera: THREE.PerspectiveCamera): void {
  _euler.set(pitch, yaw, 0, 'YXZ');
  _fwd.set(0, 0, -1).applyEuler(_euler);
  camera.position.copy(target).addScaledVector(_fwd, -distance);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pitch, yaw, 0);

  // Grow the clip planes with the LOD zoom so coarse (far, large) terrain isn't clipped.
  const scale = 1 << getExploreZoomLevel();
  const near = BASE_NEAR * scale, far = BASE_FAR * scale;
  if (camera.near !== near || camera.far !== far) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

/** Rotate the orbit (right-drag / two-finger). dx/dy in pixels. */
export function exploreCameraRotate(dx: number, dy: number): void {
  yaw -= dx * ROTATE_SPEED;
  pitch -= dy * ROTATE_SPEED;
  if (pitch < MIN_PITCH) pitch = MIN_PITCH;
  if (pitch > MAX_PITCH) pitch = MAX_PITCH;
}

/** Pan the target across the ground plane (one-finger / left-drag). dx/dy in pixels. */
export function exploreCameraPan(dx: number, dy: number): void {
  // Screen-right and screen-forward projected onto the horizontal plane (yaw only).
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const rightX = cy, rightZ = -sy;   // (1,0,0) rotated by yaw about Y
  const fwdX = -sy, fwdZ = -cy;      // (0,0,-1) rotated by yaw about Y
  const s = distance * PAN_SPEED;
  // Drag right → world slides right (target moves left); drag down → target moves toward camera.
  target.x -= (rightX * dx - fwdX * dy) * s;
  target.z -= (rightZ * dx - fwdZ * dy) * s;
}

/** Zoom in/out. Positive `delta` zooms OUT (wheel down) → higher zoomExp → coarser LOD, further camera. */
export function exploreCameraZoom(delta: number): void {
  zoomExp += delta * ZOOM_EXP_SPEED;
  if (zoomExp < 0) zoomExp = 0;
  if (zoomExp > MAX_ZOOM_LEVEL) zoomExp = MAX_ZOOM_LEVEL;
  applyZoom();
}

/** Zoom from a pinch distance change (pixels); positive `deltaPixels` = fingers apart → zoom in. */
export function exploreCameraPinch(deltaPixels: number): void {
  exploreCameraZoom(-deltaPixels * PINCH_ZOOM / ZOOM_EXP_SPEED);
}
