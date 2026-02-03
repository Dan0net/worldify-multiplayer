import * as THREE from 'three';

let scene: THREE.Scene | null = null;

export function createScene(): THREE.Scene {
  scene = new THREE.Scene();
  
  // Background set to null - procedural SkyDome handles the sky
  // SkyDome is initialized after lighting in GameCore
  scene.background = null;

  return scene;
}

export function getScene(): THREE.Scene | null {
  return scene;
}
