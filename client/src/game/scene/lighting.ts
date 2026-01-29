import * as THREE from 'three';
import { getScene } from './scene';

export function setupLighting(): void {
  const scene = getScene();
  if (!scene) return;

  // Ambient light
  const ambient = new THREE.AmbientLight(0xffffff, 0.1);
  scene.add(ambient);

  // Directional light (sun)
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(50, 100, 50);
  sun.castShadow = true;
  scene.add(sun);
}
