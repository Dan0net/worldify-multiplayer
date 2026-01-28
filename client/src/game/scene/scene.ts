import * as THREE from 'three';

let scene: THREE.Scene | null = null;

export function createScene(): THREE.Scene {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  // Ground plane and grid removed - now using voxel terrain

  return scene;
}

export function getScene(): THREE.Scene | null {
  return scene;
}
