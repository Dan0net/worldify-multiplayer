import * as THREE from 'three';
import { getScene } from './scene';

export function setupLighting(): void {
  const scene = getScene();
  if (!scene) return;

  // Ambient light
  const ambient = new THREE.AmbientLight(0xffffff, 0.1);
  scene.add(ambient);

  // Directional light (sun) - sunset yellow to match skybox
  const sun = new THREE.DirectionalLight(0xffcc00, 3.0);
  sun.position.set(75, 20, 70);
  sun.castShadow = true;
  scene.add(sun);
}
