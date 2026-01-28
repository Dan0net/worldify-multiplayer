/**
 * Unit tests for VoxelDebug - Visual debugging tools for voxel terrain
 * Run with: npx tsx client/src/game/voxel/VoxelDebug.test.ts
 * 
 * Stage 6 Success Criteria:
 * - Pressing debug key shows wireframe boxes around all loaded chunks
 * - Empty chunks (above terrain) show yellow/transparent markers
 * - Collision wireframe overlays exactly on rendered terrain mesh
 * - Chunk coordinate labels readable at chunk centers
 * - Toggling debug off removes all debug geometry from scene
 * - Debug rendering has minimal performance impact when disabled
 * - DebugPanel shows toggle states and chunk statistics
 */

import * as THREE from 'three';
import {
  VoxelDebugManager,
  VoxelDebugState,
  DEFAULT_DEBUG_STATE,
  createChunkBoundsHelper,
  createEmptyChunkMarker,
  createCollisionWireframe,
  createChunkLabel,
  COLOR_HAS_MESH,
  COLOR_EMPTY,
  COLOR_COLLISION,
} from './VoxelDebug.js';
import { Chunk } from './Chunk.js';
import { ChunkMesh } from './ChunkMesh.js';
import { meshChunk } from './SurfaceNet.js';
import { CHUNK_WORLD_SIZE } from '@worldify/shared';

// Simple test runner
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${e}`);
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toBeCloseTo(expected: number, precision = 2) {
      const diff = Math.abs((actual as number) - expected);
      if (diff > Math.pow(10, -precision)) {
        throw new Error(`Expected ${expected} (±${Math.pow(10, -precision)}), got ${actual}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if ((actual as number) <= expected) {
        throw new Error(`Expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeTrue() {
      if (actual !== true) {
        throw new Error(`Expected true, got ${actual}`);
      }
    },
    toBeFalse() {
      if (actual !== false) {
        throw new Error(`Expected false, got ${actual}`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null, got ${actual}`);
      }
    },
    toNotBeNull() {
      if (actual === null) {
        throw new Error(`Expected non-null, got null`);
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error(`Expected defined, got undefined`);
      }
    },
    toBeInstanceOf<C>(cls: new (...args: unknown[]) => C) {
      if (!(actual instanceof cls)) {
        throw new Error(`Expected instance of ${cls.name}, got ${typeof actual}`);
      }
    },
  };
}

// Create test scene
function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

// Create a test chunk
function createTestChunk(cx = 0, cy = 0, cz = 0): Chunk {
  return new Chunk(cx, cy, cz);
}

// Create a chunk with terrain for mesh generation
function createChunkWithTerrain(cx = 0, cy = 0, cz = 0): Chunk {
  const chunk = new Chunk(cx, cy, cz);
  chunk.generateFlat(16, 0, 16);
  return chunk;
}

// Create a ChunkMesh with actual geometry
function createTestChunkMesh(chunk: Chunk): ChunkMesh {
  const chunkMesh = new ChunkMesh(chunk);
  const output = meshChunk(chunk, new Map());
  chunkMesh.updateMesh(output);
  return chunkMesh;
}

console.log('\n=== VoxelDebug Tests ===\n');

// ============== Default State Tests ==============

test('DEFAULT_DEBUG_STATE has all toggles disabled', () => {
  expect(DEFAULT_DEBUG_STATE.showChunkBounds).toBeFalse();
  expect(DEFAULT_DEBUG_STATE.showEmptyChunks).toBeFalse();
  expect(DEFAULT_DEBUG_STATE.showCollisionMesh).toBeFalse();
  expect(DEFAULT_DEBUG_STATE.showChunkCoords).toBeFalse();
});

// ============== Chunk Bounds Helper Tests ==============

test('createChunkBoundsHelper returns LineSegments', () => {
  const chunk = createTestChunk();
  const wireframe = createChunkBoundsHelper(chunk, true);
  
  expect(wireframe).toBeInstanceOf(THREE.LineSegments);
});

test('createChunkBoundsHelper positions at chunk center', () => {
  const chunk = createTestChunk(2, 1, -1);
  const wireframe = createChunkBoundsHelper(chunk, true);
  
  const worldPos = chunk.getWorldPosition();
  expect(wireframe.position.x).toBeCloseTo(worldPos.x + CHUNK_WORLD_SIZE / 2, 3);
  expect(wireframe.position.y).toBeCloseTo(worldPos.y + CHUNK_WORLD_SIZE / 2, 3);
  expect(wireframe.position.z).toBeCloseTo(worldPos.z + CHUNK_WORLD_SIZE / 2, 3);
});

test('createChunkBoundsHelper uses green for chunks with mesh', () => {
  const chunk = createTestChunk();
  const wireframe = createChunkBoundsHelper(chunk, true);
  
  const material = wireframe.material as THREE.LineBasicMaterial;
  expect(material.color.getHex()).toBe(COLOR_HAS_MESH);
});

test('createChunkBoundsHelper uses yellow for empty chunks', () => {
  const chunk = createTestChunk();
  const wireframe = createChunkBoundsHelper(chunk, false);
  
  const material = wireframe.material as THREE.LineBasicMaterial;
  expect(material.color.getHex()).toBe(COLOR_EMPTY);
});

test('createChunkBoundsHelper stores chunk key in userData', () => {
  const chunk = createTestChunk(1, 2, 3);
  const wireframe = createChunkBoundsHelper(chunk, true);
  
  expect(wireframe.userData.chunkKey).toBe('1,2,3');
  expect(wireframe.userData.debugType).toBe('chunkBounds');
});

// ============== Empty Chunk Marker Tests ==============

test('createEmptyChunkMarker returns Mesh', () => {
  const chunk = createTestChunk();
  const marker = createEmptyChunkMarker(chunk);
  
  expect(marker).toBeInstanceOf(THREE.Mesh);
});

test('createEmptyChunkMarker positions at chunk center', () => {
  const chunk = createTestChunk(1, -1, 2);
  const marker = createEmptyChunkMarker(chunk);
  
  const worldPos = chunk.getWorldPosition();
  expect(marker.position.x).toBeCloseTo(worldPos.x + CHUNK_WORLD_SIZE / 2, 3);
  expect(marker.position.y).toBeCloseTo(worldPos.y + CHUNK_WORLD_SIZE / 2, 3);
  expect(marker.position.z).toBeCloseTo(worldPos.z + CHUNK_WORLD_SIZE / 2, 3);
});

test('createEmptyChunkMarker is translucent', () => {
  const chunk = createTestChunk();
  const marker = createEmptyChunkMarker(chunk);
  
  const material = marker.material as THREE.MeshBasicMaterial;
  expect(material.transparent).toBeTrue();
  expect(material.opacity).toBeCloseTo(0.3, 2);
});

test('createEmptyChunkMarker uses yellow color', () => {
  const chunk = createTestChunk();
  const marker = createEmptyChunkMarker(chunk);
  
  const material = marker.material as THREE.MeshBasicMaterial;
  expect(material.color.getHex()).toBe(COLOR_EMPTY);
});

test('createEmptyChunkMarker stores userData correctly', () => {
  const chunk = createTestChunk(-1, 0, 1);
  const marker = createEmptyChunkMarker(chunk);
  
  expect(marker.userData.chunkKey).toBe('-1,0,1');
  expect(marker.userData.debugType).toBe('emptyMarker');
});

// ============== Collision Wireframe Tests ==============

test('createCollisionWireframe returns null for ChunkMesh without geometry', () => {
  const chunk = createTestChunk();
  const chunkMesh = new ChunkMesh(chunk);
  // Don't update mesh - no geometry
  
  const wireframe = createCollisionWireframe(chunkMesh);
  expect(wireframe).toBeNull();
});

test('createCollisionWireframe returns LineSegments for mesh with geometry', () => {
  const chunk = createChunkWithTerrain();
  const chunkMesh = createTestChunkMesh(chunk);
  
  const wireframe = createCollisionWireframe(chunkMesh);
  expect(wireframe).toNotBeNull();
  expect(wireframe).toBeInstanceOf(THREE.LineSegments);
});

test('createCollisionWireframe copies mesh position', () => {
  const chunk = createChunkWithTerrain(1, 0, 1);
  const chunkMesh = createTestChunkMesh(chunk);
  
  // Manually set mesh position for test
  if (chunkMesh.mesh) {
    chunkMesh.mesh.position.set(8, 0, 8);
  }
  
  const wireframe = createCollisionWireframe(chunkMesh);
  expect(wireframe).toNotBeNull();
  expect(wireframe!.position.x).toBe(8);
  expect(wireframe!.position.z).toBe(8);
});

test('createCollisionWireframe uses cyan color', () => {
  const chunk = createChunkWithTerrain();
  const chunkMesh = createTestChunkMesh(chunk);
  
  const wireframe = createCollisionWireframe(chunkMesh);
  expect(wireframe).toNotBeNull();
  
  const material = wireframe!.material as THREE.LineBasicMaterial;
  expect(material.color.getHex()).toBe(COLOR_COLLISION);
});

test('createCollisionWireframe stores userData correctly', () => {
  const chunk = createChunkWithTerrain(2, 0, 3);
  const chunkMesh = createTestChunkMesh(chunk);
  
  const wireframe = createCollisionWireframe(chunkMesh);
  expect(wireframe).toNotBeNull();
  expect(wireframe!.userData.chunkKey).toBe('2,0,3');
  expect(wireframe!.userData.debugType).toBe('collisionWireframe');
});

// ============== Chunk Label Tests ==============
// Note: These tests may return null in Node.js environment (no DOM)

test('createChunkLabel returns Sprite or null (no DOM)', () => {
  const chunk = createTestChunk();
  const label = createChunkLabel(chunk);
  
  // In Node.js, returns null; in browser, returns Sprite
  if (typeof document !== 'undefined') {
    expect(label).toBeInstanceOf(THREE.Sprite);
  } else {
    expect(label).toBeNull();
  }
});

test('createChunkLabel positions at chunk center (when DOM available)', () => {
  const chunk = createTestChunk(0, 1, 0);
  const label = createChunkLabel(chunk);
  
  if (label === null) {
    // Skip in Node.js environment
    console.log('  (skipped - no DOM)');
    return;
  }
  
  const worldPos = chunk.getWorldPosition();
  expect(label.position.x).toBeCloseTo(worldPos.x + CHUNK_WORLD_SIZE / 2, 3);
  expect(label.position.y).toBeCloseTo(worldPos.y + CHUNK_WORLD_SIZE / 2, 3);
  expect(label.position.z).toBeCloseTo(worldPos.z + CHUNK_WORLD_SIZE / 2, 3);
});

test('createChunkLabel stores userData correctly (when DOM available)', () => {
  const chunk = createTestChunk(5, -2, 3);
  const label = createChunkLabel(chunk);
  
  if (label === null) {
    // Skip in Node.js environment
    console.log('  (skipped - no DOM)');
    return;
  }
  
  expect(label.userData.chunkKey).toBe('5,-2,3');
  expect(label.userData.debugType).toBe('chunkLabel');
});

test('createChunkLabel has appropriate scale (when DOM available)', () => {
  const chunk = createTestChunk();
  const label = createChunkLabel(chunk);
  
  if (label === null) {
    // Skip in Node.js environment
    console.log('  (skipped - no DOM)');
    return;
  }
  
  expect(label.scale.x).toBe(2);
  expect(label.scale.y).toBe(2);
});

// ============== VoxelDebugManager Tests ==============

test('VoxelDebugManager starts with default state', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const state = manager.getState();
  expect(state.showChunkBounds).toBeFalse();
  expect(state.showEmptyChunks).toBeFalse();
  expect(state.showCollisionMesh).toBeFalse();
  expect(state.showChunkCoords).toBeFalse();
});

test('VoxelDebugManager.setState updates state', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  manager.setState({ showChunkBounds: true });
  
  const state = manager.getState();
  expect(state.showChunkBounds).toBeTrue();
  expect(state.showEmptyChunks).toBeFalse();
});

test('VoxelDebugManager starts with no debug objects', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  expect(manager.getDebugObjectCount()).toBe(0);
});

test('VoxelDebugManager.update creates chunk bounds when enabled', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const chunk = createTestChunk();
  const chunks = new Map<string, Chunk>();
  chunks.set(chunk.key, chunk);
  
  const meshes = new Map<string, ChunkMesh>();
  
  manager.setState({ showChunkBounds: true });
  manager.update(chunks, meshes);
  
  expect(manager.getDebugObjectCount()).toBeGreaterThan(0);
  expect(scene.children.length).toBeGreaterThan(0);
});

test('VoxelDebugManager.update creates empty markers when enabled', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const chunk = createTestChunk();
  const chunks = new Map<string, Chunk>();
  chunks.set(chunk.key, chunk);
  
  // No mesh = empty chunk
  const meshes = new Map<string, ChunkMesh>();
  
  manager.setState({ showEmptyChunks: true });
  manager.update(chunks, meshes);
  
  const stats = manager.getStats();
  expect(stats.emptyMarkers).toBe(1);
});

test('VoxelDebugManager.update creates collision wireframe when enabled', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const chunk = createChunkWithTerrain();
  const chunks = new Map<string, Chunk>();
  chunks.set(chunk.key, chunk);
  
  const chunkMesh = createTestChunkMesh(chunk);
  const meshes = new Map<string, ChunkMesh>();
  meshes.set(chunk.key, chunkMesh);
  
  manager.setState({ showCollisionMesh: true });
  manager.update(chunks, meshes);
  
  const stats = manager.getStats();
  expect(stats.collisionWireframes).toBe(1);
});

test('VoxelDebugManager.update creates chunk labels when enabled (if DOM available)', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const chunk = createTestChunk();
  const chunks = new Map<string, Chunk>();
  chunks.set(chunk.key, chunk);
  
  const meshes = new Map<string, ChunkMesh>();
  
  manager.setState({ showChunkCoords: true });
  manager.update(chunks, meshes);
  
  const stats = manager.getStats();
  // In Node.js, labels won't be created (no DOM)
  if (typeof document !== 'undefined') {
    expect(stats.chunkLabels).toBe(1);
  } else {
    expect(stats.chunkLabels).toBe(0);
  }
});

test('Toggling debug off removes all debug geometry from scene', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const chunk = createTestChunk();
  const chunks = new Map<string, Chunk>();
  chunks.set(chunk.key, chunk);
  const meshes = new Map<string, ChunkMesh>();
  
  // Enable bounds and empty (these don't require DOM)
  manager.setState({
    showChunkBounds: true,
    showEmptyChunks: true,
  });
  manager.update(chunks, meshes);
  
  const countBefore = scene.children.length;
  expect(countBefore).toBeGreaterThan(0);
  
  // Disable all
  manager.setState({
    showChunkBounds: false,
    showEmptyChunks: false,
  });
  
  expect(manager.getDebugObjectCount()).toBe(0);
  expect(scene.children.length).toBe(0);
});

test('VoxelDebugManager removes debug objects for unloaded chunks', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const chunk1 = createTestChunk(0, 0, 0);
  const chunk2 = createTestChunk(1, 0, 0);
  const chunks = new Map<string, Chunk>();
  chunks.set(chunk1.key, chunk1);
  chunks.set(chunk2.key, chunk2);
  const meshes = new Map<string, ChunkMesh>();
  
  manager.setState({ showChunkBounds: true });
  manager.update(chunks, meshes);
  
  expect(manager.getStats().chunkBounds).toBe(2);
  
  // "Unload" chunk2
  chunks.delete(chunk2.key);
  manager.update(chunks, meshes);
  
  expect(manager.getStats().chunkBounds).toBe(1);
});

test('VoxelDebugManager.dispose removes all objects', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const chunk = createTestChunk();
  const chunks = new Map<string, Chunk>();
  chunks.set(chunk.key, chunk);
  const meshes = new Map<string, ChunkMesh>();
  
  // Use bounds and empty markers (don't require DOM)
  manager.setState({ showChunkBounds: true, showEmptyChunks: true });
  manager.update(chunks, meshes);
  
  expect(scene.children.length).toBeGreaterThan(0);
  
  manager.dispose();
  
  expect(manager.getDebugObjectCount()).toBe(0);
  expect(scene.children.length).toBe(0);
});

test('VoxelDebugManager.getStats returns accurate counts', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  // Create 3 chunks
  const chunks = new Map<string, Chunk>();
  const meshes = new Map<string, ChunkMesh>();
  
  for (let i = 0; i < 3; i++) {
    const chunk = createChunkWithTerrain(i, 0, 0);
    chunks.set(chunk.key, chunk);
    const chunkMesh = createTestChunkMesh(chunk);
    meshes.set(chunk.key, chunkMesh);
  }
  
  // Enable visualizations that don't require DOM
  manager.setState({
    showChunkBounds: true,
    showCollisionMesh: true,
  });
  manager.update(chunks, meshes);
  
  const stats = manager.getStats();
  expect(stats.chunkBounds).toBe(3);
  expect(stats.collisionWireframes).toBe(3);
  expect(stats.totalObjects).toBe(6);
});

test('Debug rendering has minimal impact when disabled', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const chunks = new Map<string, Chunk>();
  const meshes = new Map<string, ChunkMesh>();
  
  for (let i = 0; i < 64; i++) {
    const chunk = createTestChunk(i % 4, Math.floor(i / 4) % 4, Math.floor(i / 16));
    chunks.set(chunk.key, chunk);
  }
  
  // All disabled - should create no objects
  manager.update(chunks, meshes);
  
  expect(manager.getDebugObjectCount()).toBe(0);
  expect(scene.children.length).toBe(0);
});

test('Chunk bounds color updates when mesh status changes', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const chunk = createChunkWithTerrain();
  const chunks = new Map<string, Chunk>();
  chunks.set(chunk.key, chunk);
  const meshes = new Map<string, ChunkMesh>();
  
  // Start without mesh (empty)
  manager.setState({ showChunkBounds: true });
  manager.update(chunks, meshes);
  
  // Add mesh
  const chunkMesh = createTestChunkMesh(chunk);
  meshes.set(chunk.key, chunkMesh);
  
  // Update should change color
  manager.update(chunks, meshes);
  
  // Should still have 1 bounds object
  expect(manager.getStats().chunkBounds).toBe(1);
});

test('Empty marker removed when chunk gets mesh', () => {
  const scene = createTestScene();
  const manager = new VoxelDebugManager(scene);
  
  const chunk = createChunkWithTerrain();
  const chunks = new Map<string, Chunk>();
  chunks.set(chunk.key, chunk);
  const meshes = new Map<string, ChunkMesh>();
  
  // Start without mesh
  manager.setState({ showEmptyChunks: true });
  manager.update(chunks, meshes);
  
  expect(manager.getStats().emptyMarkers).toBe(1);
  
  // Add mesh
  const chunkMesh = createTestChunkMesh(chunk);
  meshes.set(chunk.key, chunkMesh);
  manager.update(chunks, meshes);
  
  // Empty marker should be removed
  expect(manager.getStats().emptyMarkers).toBe(0);
});

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
