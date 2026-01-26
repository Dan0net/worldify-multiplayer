import * as THREE from 'three';
import type { PlayerLocal } from '../player/playerLocal';

let camera: THREE.PerspectiveCamera | null = null;

export function createCamera(): THREE.PerspectiveCamera {
  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 1.8, 0);
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

  // Reset camera rotation and apply yaw (Y) then pitch (X)
  camera.rotation.order = 'YXZ';
  camera.rotation.y = player.yaw;
  camera.rotation.x = player.pitch;
}
