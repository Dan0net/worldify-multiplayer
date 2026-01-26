import * as THREE from 'three';

let scene: THREE.Scene | null = null;

export function createScene(): THREE.Scene {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  // Add ground plane placeholder
  const groundGeo = new THREE.PlaneGeometry(200, 200);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x3a7d44 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Add grid helper
  const grid = new THREE.GridHelper(200, 100, 0x000000, 0x444444);
  grid.position.y = 0.01;
  scene.add(grid);

  return scene;
}

export function getScene(): THREE.Scene | null {
  return scene;
}
