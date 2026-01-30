/**
 * Unit tests for BuildPreview
 * Tests the preview API and basic functionality
 */

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { BuildPreview } from './BuildPreview.js';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import {
  BUILD_RADIUS,
  BuildMode,
  BuildShape,
  BuildConfig,
} from '@worldify/shared';

function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

function createTestWorld(): { world: VoxelWorld; scene: THREE.Scene } {
  const scene = createTestScene();
  const world = new VoxelWorld(scene);
  world.init();
  return { world, scene };
}

function createTestPreview(): {
  preview: BuildPreview;
  world: VoxelWorld;
  scene: THREE.Scene;
} {
  const { world, scene } = createTestWorld();
  const preview = new BuildPreview();
  preview.initialize(world, scene);
  return { preview, world, scene };
}

function createDefaultBuildConfig(mode: BuildMode = BuildMode.Add): BuildConfig {
  return {
    shape: BuildShape.Sphere,
    mode,
    size: { x: BUILD_RADIUS, y: BUILD_RADIUS, z: BUILD_RADIUS },
    material: 1,
  };
}

describe('BuildPreview Initialization Tests', () => {
  test('BuildPreview can be created', () => {
    const preview = new BuildPreview();
    expect(preview).toBeDefined();
  });

  test('BuildPreview can be initialized with world and scene', () => {
    const { preview } = createTestPreview();
    expect(preview).toBeDefined();
  });
});

describe('Preview Update Tests', () => {
  test('updatePreview does not throw', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(0, 2, 0);
    const config = createDefaultBuildConfig();
    
    expect(() => {
      preview.updatePreview(targetPos, 0, config);
    }).not.toThrow();
  });

  test('updatePreview with remove mode does not throw', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(0, 1, 0);
    const config = createDefaultBuildConfig(BuildMode.Remove);
    
    expect(() => {
      preview.updatePreview(targetPos, 0, config);
    }).not.toThrow();
  });

  test('clearPreview does not throw', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(0, 2, 0);
    const config = createDefaultBuildConfig();
    
    preview.updatePreview(targetPos, 0, config);
    
    expect(() => {
      preview.clearPreview();
    }).not.toThrow();
  });

  test('hasActivePreview returns false before any update', () => {
    const { preview } = createTestPreview();
    expect(preview.hasActivePreview()).toBe(false);
  });

  test('hasActivePreview returns false after clearPreview', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(0, 2, 0);
    const config = createDefaultBuildConfig();
    
    preview.updatePreview(targetPos, 0, config);
    preview.clearPreview();
    
    expect(preview.hasActivePreview()).toBe(false);
  });
});

describe('Commit Tests', () => {
  test('commitPreview returns array', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 4, 4);
    const config = createDefaultBuildConfig();
    
    preview.updatePreview(targetPos, 0, config);
    const result = preview.commitPreview();
    
    expect(result).toBeInstanceOf(Array);
  });

  test('commitPreview without preview returns empty array', () => {
    const { preview } = createTestPreview();
    
    const result = preview.commitPreview();
    expect(result).toEqual([]);
  });

  test('commitPreview clears state', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 4, 4);
    const config = createDefaultBuildConfig();
    
    preview.updatePreview(targetPos, 0, config);
    preview.commitPreview();
    
    // After commit, hasActivePreview should be false
    expect(preview.hasActivePreview()).toBe(false);
  });
});

describe('Boundary Behavior Tests', () => {
  test('Build operations do not throw', () => {
    const { preview } = createTestPreview();
    const config = createDefaultBuildConfig();
    
    // Test various positions
    const positions = [
      new THREE.Vector3(4, 2, 4),   // center of chunk
      new THREE.Vector3(7.9, 2, 4), // near edge
      new THREE.Vector3(0, 2, 0),   // at origin
      new THREE.Vector3(-4, 2, -4), // negative coords
    ];
    
    for (const pos of positions) {
      expect(() => {
        preview.updatePreview(pos, 0, config);
        preview.commitPreview();
      }).not.toThrow();
    }
  });
});

describe('API Consistency Tests', () => {
  test('updatePreview can be called multiple times', () => {
    const { preview } = createTestPreview();
    const config = createDefaultBuildConfig();
    
    // Call updatePreview multiple times with different positions
    expect(() => {
      preview.updatePreview(new THREE.Vector3(1, 1, 1), 0, config);
      preview.updatePreview(new THREE.Vector3(2, 2, 2), 0, config);
      preview.updatePreview(new THREE.Vector3(3, 3, 3), 0, config);
    }).not.toThrow();
  });

  test('commitPreview can be called multiple times', () => {
    const { preview } = createTestPreview();
    const config = createDefaultBuildConfig();
    
    expect(() => {
      preview.updatePreview(new THREE.Vector3(1, 1, 1), 0, config);
      preview.commitPreview();
      preview.updatePreview(new THREE.Vector3(2, 2, 2), 0, config);
      preview.commitPreview();
    }).not.toThrow();
  });

  test('clearPreview can be called without update', () => {
    const { preview } = createTestPreview();
    
    expect(() => {
      preview.clearPreview();
    }).not.toThrow();
  });
});

describe('Rotation Tests', () => {
  test('updatePreview with rotation does not throw', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 2, 4);
    const config = createDefaultBuildConfig();
    
    expect(() => {
      preview.updatePreview(targetPos, Math.PI / 4, config);
    }).not.toThrow();
  });

  test('Different rotations do not throw', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 2, 4);
    const config = createDefaultBuildConfig();
    
    for (const rotation of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
      expect(() => {
        preview.updatePreview(targetPos, rotation, config);
        preview.clearPreview();
      }).not.toThrow();
    }
  });
});

describe('Dispose Tests', () => {
  test('dispose cleans up without error', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 2, 4);
    const config = createDefaultBuildConfig();
    preview.updatePreview(targetPos, 0, config);
    
    expect(() => {
      preview.dispose();
    }).not.toThrow();
  });

  test('dispose clears active preview', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 2, 4);
    const config = createDefaultBuildConfig();
    preview.updatePreview(targetPos, 0, config);
    
    preview.dispose();
    expect(preview.hasActivePreview()).toBe(false);
  });
});
