import * as THREE from 'three';
import { getScene } from './scene';

// Shadow light configuration - offset from player position
const SHADOW_LIGHT_OFFSET = new THREE.Vector3(75, 20, 70);

// Shadow map size (higher = sharper shadows, more expensive)
const SHADOW_MAP_SIZE = 4096;

// Shadow camera frustum size (covers this many meters in each direction)
const SHADOW_CAMERA_SIZE = 100;

// Shadow light reference for updates
let shadowLight: THREE.DirectionalLight | null = null;

export function setupLighting(): void {
  const scene = getScene();
  if (!scene) return;

  // Ambient light - soft fill
  const ambient = new THREE.AmbientLight(0xffffff, 0.1);
  scene.add(ambient);

  // Directional light (sun) - sunset yellow to match skybox
  shadowLight = new THREE.DirectionalLight(0xffcc00, 3.0);
  shadowLight.position.copy(SHADOW_LIGHT_OFFSET);
  
  // Enable shadow casting
  shadowLight.castShadow = true;
  
  // Configure shadow map quality
  shadowLight.shadow.mapSize.width = SHADOW_MAP_SIZE;
  shadowLight.shadow.mapSize.height = SHADOW_MAP_SIZE;
  
  // Configure shadow camera (orthographic frustum)
  shadowLight.shadow.camera.left = -SHADOW_CAMERA_SIZE;
  shadowLight.shadow.camera.right = SHADOW_CAMERA_SIZE;
  shadowLight.shadow.camera.top = SHADOW_CAMERA_SIZE;
  shadowLight.shadow.camera.bottom = -SHADOW_CAMERA_SIZE;
  shadowLight.shadow.camera.near = 0.5;
  shadowLight.shadow.camera.far = 500;
  
  // Shadow bias to prevent shadow acne
  shadowLight.shadow.bias = 0.0;
  shadowLight.shadow.normalBias = 0.1;
  
  scene.add(shadowLight);
  scene.add(shadowLight.target);
}

/**
 * Update shadow light position to follow player
 * Call this each frame to keep shadows centered on the player
 */
export function updateShadowLight(playerPosition: THREE.Vector3): void {
  if (!shadowLight) return;
  
  // Position light relative to player
  shadowLight.position.copy(playerPosition).add(SHADOW_LIGHT_OFFSET);
  
  // Shadow target follows player
  shadowLight.target.position.copy(playerPosition);
}
