import * as THREE from 'three';
import type { PlayerLocal } from '../player/playerLocal';

let camera: THREE.PerspectiveCamera | null = null;

// Spectator camera settings
const SPECTATOR_HEIGHT = 15;
const SPECTATOR_DISTANCE = 20;
const SPECTATOR_LOOK_UP_OFFSET = 0; // How much above origin the camera looks (tilts up)
const SPECTATOR_ROTATION_SPEED = 0.1; // radians per second

export function createCamera(): THREE.PerspectiveCamera {
  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  // Start in spectator position
  camera.position.set(0, SPECTATOR_HEIGHT, SPECTATOR_DISTANCE);
  camera.lookAt(0, 0, 0);
  return camera;
}

export function getCamera(): THREE.PerspectiveCamera | null {
  return camera;
}

/**
 * Update camera position and rotation to match local player
 * First-person view: camera is at player's eye position, rotated by yaw/pitch
 */
export function updateCameraFromPlayer(
  camera: THREE.PerspectiveCamera,
  player: PlayerLocal
): void {
  // Position camera at player eye height
  camera.position.copy(player.position);

  // Reset camera rotation completely for FPS mode
  // Must set rotation order BEFORE setting values, and reset z to avoid roll from lookAt
  camera.rotation.order = 'YXZ';
  camera.rotation.set(player.pitch, player.yaw, 0);
}

/**
 * Update spectator camera - orbits around a center point looking down
 * @param center The point to orbit around (defaults to origin)
 */
export function updateSpectatorCamera(
  camera: THREE.PerspectiveCamera,
  _deltaMs: number,
  elapsedTime: number,
  center: THREE.Vector3 = new THREE.Vector3(0, 0, 0)
): void {
  // Orbit around the center point
  const angle = elapsedTime * SPECTATOR_ROTATION_SPEED;
  camera.position.x = center.x + Math.sin(angle) * SPECTATOR_DISTANCE;
  camera.position.z = center.z + Math.cos(angle) * SPECTATOR_DISTANCE;
  camera.position.y = center.y + SPECTATOR_HEIGHT;
  
  // Look at a point above center to tilt camera up
  camera.lookAt(center.x, center.y + SPECTATOR_LOOK_UP_OFFSET, center.z);
}
