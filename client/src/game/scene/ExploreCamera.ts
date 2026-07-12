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

/** Seed the explore camera at a world center (e.g. saved player position). */
export function initExploreCamera(center: THREE.Vector3): void {
  target.copy(center);
  yaw = 0;
  pitch = -Math.PI / 4;
  distance = 32;
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
