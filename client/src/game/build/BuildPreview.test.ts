/**
 * Unit tests for BuildPreview
 * Tests the preview API and basic functionality
 */

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { BuildPreview } from './BuildPreview.js';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import { MeshWorkerPool } from '../voxel/MeshWorkerPool.js';
import {
  BuildMode,
  BuildShape,
  BuildConfig,
  Quat,
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
  preview.initialize(world, scene, world.meshPool);
  return { preview, world, scene };
}

function createDefaultBuildConfig(mode: BuildMode = BuildMode.ADD): BuildConfig {
  return {
    shape: BuildShape.SPHERE,
    mode,
    size: { x: 2, y: 2, z: 2 },
    material: 1,
  };
}

function createDefaultRotation(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
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
    const rotation = createDefaultRotation();
    
    expect(() => {
      preview.updatePreview(targetPos, rotation, config);
    }).not.toThrow();
  });

  test('updatePreview with remove mode does not throw', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(0, 1, 0);
    const config = createDefaultBuildConfig(BuildMode.SUBTRACT);
    const rotation = createDefaultRotation();
    
    expect(() => {
      preview.updatePreview(targetPos, rotation, config);
    }).not.toThrow();
  });

  test('clearPreview does not throw', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(0, 2, 0);
    const config = createDefaultBuildConfig();
    const rotation = createDefaultRotation();
    
    preview.updatePreview(targetPos, rotation, config);
    
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
    const rotation = createDefaultRotation();
    
    preview.updatePreview(targetPos, rotation, config);
    preview.clearPreview();
    
    expect(preview.hasActivePreview()).toBe(false);
  });
});

describe('Hold Preview Tests', () => {
  test('holdPreview does not throw', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 4, 4);
    const config = createDefaultBuildConfig();
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    
    preview.updatePreview(targetPos, rotation, config);
    
    expect(() => {
      preview.holdPreview();
    }).not.toThrow();
  });

  test('holdPreview without preview does not throw', () => {
    const { preview } = createTestPreview();
    
    expect(() => {
      preview.holdPreview();
    }).not.toThrow();
  });

  test('holdPreview clears state', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 4, 4);
    const config = createDefaultBuildConfig();
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    
    preview.updatePreview(targetPos, rotation, config);
    preview.holdPreview();
    
    // After hold, hasActivePreview should be false
    expect(preview.hasActivePreview()).toBe(false);
  });
});

describe('Boundary Behavior Tests', () => {
  test('Build operations do not throw', () => {
    const { preview } = createTestPreview();
    const config = createDefaultBuildConfig();
    const rotation = createDefaultRotation();
    
    // Test various positions
    const positions = [
      new THREE.Vector3(4, 2, 4),   // center of chunk
      new THREE.Vector3(7.9, 2, 4), // near edge
      new THREE.Vector3(0, 2, 0),   // at origin
      new THREE.Vector3(-4, 2, -4), // negative coords
    ];
    
    for (const pos of positions) {
      expect(() => {
        preview.updatePreview(pos, rotation, config);
        preview.holdPreview();
      }).not.toThrow();
    }
  });
});

describe('API Consistency Tests', () => {
  test('updatePreview can be called multiple times', () => {
    const { preview } = createTestPreview();
    const config = createDefaultBuildConfig();
    const rotation = createDefaultRotation();
    
    // Call updatePreview multiple times with different positions
    expect(() => {
      preview.updatePreview(new THREE.Vector3(1, 1, 1), rotation, config);
      preview.updatePreview(new THREE.Vector3(2, 2, 2), rotation, config);
      preview.updatePreview(new THREE.Vector3(3, 3, 3), rotation, config);
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
    const rotation = { x: 0, y: 0.383, z: 0, w: 0.924 }; // ~45° Y
    
    expect(() => {
      preview.updatePreview(targetPos, rotation, config);
    }).not.toThrow();
  });

  test('Different rotations do not throw', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 2, 4);
    const config = createDefaultBuildConfig();
    
    const rotations: Quat[] = [
      { x: 0, y: 0, z: 0, w: 1 },
      { x: 0, y: 0.383, z: 0, w: 0.924 },
      { x: 0, y: 0.707, z: 0, w: 0.707 },
      { x: 0, y: 1, z: 0, w: 0 },
    ];
    
    for (const rotation of rotations) {
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
    const rotation = createDefaultRotation();
    preview.updatePreview(targetPos, rotation, config);
    
    expect(() => {
      preview.dispose();
    }).not.toThrow();
  });

  test('dispose clears active preview', () => {
    const { preview } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 2, 4);
    const config = createDefaultBuildConfig();
    const rotation = createDefaultRotation();
    preview.updatePreview(targetPos, rotation, config);
    
    preview.dispose();
    expect(preview.hasActivePreview()).toBe(false);
  });
});
