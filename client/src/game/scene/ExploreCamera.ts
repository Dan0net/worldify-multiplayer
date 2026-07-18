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

const target = new THREE.Vector3(0, 0, 0);
let yaw = 0;
let pitch = -Math.PI / 4;   // 45° down
let distance = 32;

// Look-down range: never flip past straight-down or up above the horizon.
const MIN_PITCH = -Math.PI / 2 + 0.05;
const MAX_PITCH = -0.12;
const MIN_DISTANCE = 6;
const MAX_DISTANCE = 140;

const ROTATE_SPEED = 0.009;   // radians per pixel
const PAN_SPEED = 0.0016;     // world units per pixel, per unit distance
const ZOOM_SPEED = 0.0007;    // per wheel delta unit
const PINCH_ZOOM = 0.006;     // per pixel of pinch distance change

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
  distance = 32;
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

/** Position + orient the camera from the current orbit state. Call each frame. */
export function updateExploreCamera(camera: THREE.PerspectiveCamera): void {
  _euler.set(pitch, yaw, 0, 'YXZ');
  _fwd.set(0, 0, -1).applyEuler(_euler);
  camera.position.copy(target).addScaledVector(_fwd, -distance);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pitch, yaw, 0);
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

/** Zoom the orbit distance. Positive `delta` zooms out (wheel down / pinch in). */
export function exploreCameraZoom(delta: number): void {
  distance *= Math.exp(delta * ZOOM_SPEED);
  if (distance < MIN_DISTANCE) distance = MIN_DISTANCE;
  if (distance > MAX_DISTANCE) distance = MAX_DISTANCE;
}

/** Zoom from a pinch distance change (pixels); positive `deltaPixels` = fingers apart → zoom in. */
export function exploreCameraPinch(deltaPixels: number): void {
  exploreCameraZoom(-deltaPixels * PINCH_ZOOM / ZOOM_SPEED);
}
