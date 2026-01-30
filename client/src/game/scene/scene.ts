import * as THREE from 'three';
import { setupSkybox } from './Skybox';

let scene: THREE.Scene | null = null;

export function createScene(): THREE.Scene {
  scene = new THREE.Scene();
  // Solid blue fallback until skybox loads
  scene.background = new THREE.Color(0x87ceeb);

  // Load equirectangular skybox (replaces solid color when ready)
  setupSkybox(scene);

  // Ground plane and grid removed - now using voxel terrain

  return scene;
}

export function getScene(): THREE.Scene | null {
  return scene;
}
