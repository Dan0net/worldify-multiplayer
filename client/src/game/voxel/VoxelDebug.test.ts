/**
 * Unit tests for VoxelDebug - Visual debugging tools for voxel terrain
 */

import { describe, test, expect } from 'vitest';
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
import { meshChunk } from './ChunkMesher.js';
import { CHUNK_WORLD_SIZE } from '@worldify/shared';

function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

function createTestChunk(cx = 0, cy = 0, cz = 0): Chunk {
  return new Chunk(cx, cy, cz);
}

function createChunkWithTerrain(cx = 0, cy = 0, cz = 0): Chunk {
  const chunk = new Chunk(cx, cy, cz);
  chunk.generateFlat(16, 0, 16);
  return chunk;
}

function createTestChunkMesh(chunk: Chunk): ChunkMesh {
  const chunkMesh = new ChunkMesh(chunk);
  const output = meshChunk(chunk, new Map());
  chunkMesh.updateMesh(output);
  return chunkMesh;
}

describe('Default State Tests', () => {
  test('DEFAULT_DEBUG_STATE has all toggles disabled', () => {
    expect(DEFAULT_DEBUG_STATE.showChunkBounds).toBe(false);
    expect(DEFAULT_DEBUG_STATE.showEmptyChunks).toBe(false);
    expect(DEFAULT_DEBUG_STATE.showCollisionMesh).toBe(false);
    expect(DEFAULT_DEBUG_STATE.showChunkCoords).toBe(false);
  });
});

describe('Chunk Bounds Helper Tests', () => {
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
});

describe('Empty Chunk Marker Tests', () => {
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
    expect(material.transparent).toBe(true);
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
});

describe('Collision Wireframe Tests', () => {
  test('createCollisionWireframe returns null for ChunkMesh without geometry', () => {
    const chunk = createTestChunk();
    const chunkMesh = new ChunkMesh(chunk);
    
    const wireframe = createCollisionWireframe(chunkMesh);
    expect(wireframe).toBeNull();
  });

  test('createCollisionWireframe returns LineSegments for mesh with geometry', () => {
    const chunk = createChunkWithTerrain();
    const chunkMesh = createTestChunkMesh(chunk);
    
    const wireframe = createCollisionWireframe(chunkMesh);
    expect(wireframe).not.toBeNull();
    expect(wireframe).toBeInstanceOf(THREE.LineSegments);
  });

  test('createCollisionWireframe copies mesh position', () => {
    const chunk = createChunkWithTerrain(1, 0, 1);
    const chunkMesh = createTestChunkMesh(chunk);
    
    if (chunkMesh.mesh) {
      chunkMesh.mesh.position.set(8, 0, 8);
    }
    
    const wireframe = createCollisionWireframe(chunkMesh);
    expect(wireframe).not.toBeNull();
    expect(wireframe!.position.x).toBe(8);
    expect(wireframe!.position.z).toBe(8);
  });

  test('createCollisionWireframe uses cyan color', () => {
    const chunk = createChunkWithTerrain();
    const chunkMesh = createTestChunkMesh(chunk);
    
    const wireframe = createCollisionWireframe(chunkMesh);
    expect(wireframe).not.toBeNull();
    
    const material = wireframe!.material as THREE.LineBasicMaterial;
    expect(material.color.getHex()).toBe(COLOR_COLLISION);
  });

  test('createCollisionWireframe stores userData correctly', () => {
    const chunk = createChunkWithTerrain(2, 0, 3);
    const chunkMesh = createTestChunkMesh(chunk);
    
    const wireframe = createCollisionWireframe(chunkMesh);
    expect(wireframe).not.toBeNull();
    expect(wireframe!.userData.chunkKey).toBe('2,0,3');
    expect(wireframe!.userData.debugType).toBe('collisionWireframe');
  });
});

describe('Chunk Label Tests', () => {
  test('createChunkLabel returns Sprite or null (no DOM)', () => {
    const chunk = createTestChunk();
    const label = createChunkLabel(chunk);
    
    if (typeof document !== 'undefined') {
      expect(label).toBeInstanceOf(THREE.Sprite);
    } else {
      expect(label).toBeNull();
    }
  });
});

describe('VoxelDebugManager Tests', () => {
  test('VoxelDebugManager starts with default state', () => {
    const scene = createTestScene();
    const manager = new VoxelDebugManager(scene);
    
    const state = manager.getState();
    expect(state.showChunkBounds).toBe(false);
    expect(state.showEmptyChunks).toBe(false);
    expect(state.showCollisionMesh).toBe(false);
    expect(state.showChunkCoords).toBe(false);
  });

  test('VoxelDebugManager.setState updates state', () => {
    const scene = createTestScene();
    const manager = new VoxelDebugManager(scene);
    
    manager.setState({ showChunkBounds: true });
    
    const state = manager.getState();
    expect(state.showChunkBounds).toBe(true);
    expect(state.showEmptyChunks).toBe(false);
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

  test('Toggling debug off removes all debug geometry from scene', () => {
    const scene = createTestScene();
    const manager = new VoxelDebugManager(scene);
    
    const chunk = createTestChunk();
    const chunks = new Map<string, Chunk>();
    chunks.set(chunk.key, chunk);
    const meshes = new Map<string, ChunkMesh>();
    
    manager.setState({
      showChunkBounds: true,
      showEmptyChunks: true,
    });
    manager.update(chunks, meshes);
    
    const countBefore = scene.children.length;
    expect(countBefore).toBeGreaterThan(0);
    
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
    
    const chunks = new Map<string, Chunk>();
    const meshes = new Map<string, ChunkMesh>();
    
    for (let i = 0; i < 3; i++) {
      const chunk = createChunkWithTerrain(i, 0, 0);
      chunks.set(chunk.key, chunk);
      const chunkMesh = createTestChunkMesh(chunk);
      meshes.set(chunk.key, chunkMesh);
    }
    
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
    
    manager.setState({ showChunkBounds: true });
    manager.update(chunks, meshes);
    
    const chunkMesh = createTestChunkMesh(chunk);
    meshes.set(chunk.key, chunkMesh);
    
    manager.update(chunks, meshes);
    
    expect(manager.getStats().chunkBounds).toBe(1);
  });

  test('Empty marker removed when chunk gets mesh', () => {
    const scene = createTestScene();
    const manager = new VoxelDebugManager(scene);
    
    const chunk = createChunkWithTerrain();
    const chunks = new Map<string, Chunk>();
    chunks.set(chunk.key, chunk);
    const meshes = new Map<string, ChunkMesh>();
    
    manager.setState({ showEmptyChunks: true });
    manager.update(chunks, meshes);
    
    expect(manager.getStats().emptyMarkers).toBe(1);
    
    const chunkMesh = createTestChunkMesh(chunk);
    meshes.set(chunk.key, chunkMesh);
    manager.update(chunks, meshes);
    
    expect(manager.getStats().emptyMarkers).toBe(0);
  });
});
