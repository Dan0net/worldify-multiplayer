import {
  Scene,
  TextureLoader,
  EquirectangularReflectionMapping,
  SRGBColorSpace,
  Texture,
} from 'three';

let skyboxTexture: Texture | null = null;

/**
 * Loads and applies an equirectangular skybox texture to the scene.
 * Sets both scene.background (visible sky) and scene.environment (IBL reflections).
 */
export function setupSkybox(scene: Scene, onLoaded?: () => void): void {
  const loader = new TextureLoader();

  loader.load(
    '/images/kloppenheim_06_puresky.jpg',
    (texture) => {
      texture.mapping = EquirectangularReflectionMapping;
      texture.colorSpace = SRGBColorSpace;

      scene.background = texture;
      scene.environment = texture;
      // environmentIntensity is available in Three.js r155+ but types may lag
      (scene as unknown as { environmentIntensity: number }).environmentIntensity = 0.5;

      skyboxTexture = texture;
      onLoaded?.();
    },
    undefined,
    (error) => {
      console.error('Failed to load skybox texture:', error);
    }
  );
}

/**
 * Dispose of the skybox texture to free GPU memory.
 */
export function disposeSkybox(): void {
  if (skyboxTexture) {
    skyboxTexture.dispose();
    skyboxTexture = null;
  }
}
