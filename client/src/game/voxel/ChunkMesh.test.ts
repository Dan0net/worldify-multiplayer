/**
 * Unit tests for ChunkMesh and VoxelMaterials
 * Run with: npx tsx client/src/game/voxel/ChunkMesh.test.ts
 */

import * as THREE from 'three';
import { meshChunk } from './SurfaceNet.js';
import { Chunk } from '@worldify/shared';
import { ChunkMesh, createMeshFromSurfaceNet, disposeMesh } from './ChunkMesh.js';
import { getMaterialColor, MATERIAL_COLORS, voxelMaterial } from './VoxelMaterials.js';
import { CHUNK_WORLD_SIZE, VOXEL_SCALE } from '@worldify/shared';

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
        throw new Error(`Expected non-null value, got null`);
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error(`Expected defined value, got undefined`);
      }
    },
  };
}

console.log('\n=== VoxelMaterials Tests ===\n');

// ============== Material Color Tests ==============

test('Material ID 0 is green', () => {
  const color = getMaterialColor(0);
  // Green should have higher G component than R and B
  expect(color.g).toBeGreaterThan(color.r);
  expect(color.g).toBeGreaterThan(color.b);
});

test('Material ID 1 is red', () => {
  const color = getMaterialColor(1);
  // Red should have high R component
  expect(color.r).toBeGreaterThan(0.7);
});

test('Material ID 2 is blue', () => {
  const color = getMaterialColor(2);
  // Blue should have high B component
  expect(color.b).toBeGreaterThan(0.7);
});

test('MATERIAL_COLORS has 128 entries', () => {
  expect(MATERIAL_COLORS.length).toBe(128);
});

test('getMaterialColor clamps out-of-range IDs', () => {
  // Should not throw for out of range
  const colorNeg = getMaterialColor(-5);
  const colorHigh = getMaterialColor(200);
  expect(colorNeg).toBeDefined();
  expect(colorHigh).toBeDefined();
});

test('voxelMaterial uses vertex colors', () => {
  expect(voxelMaterial.vertexColors).toBeTrue();
});

console.log('\n=== ChunkMesh Tests ===\n');

// ============== Mesh Creation Tests ==============

test('Single chunk with flat terrain creates visible mesh', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16); // Green grass
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  const mesh = createMeshFromSurfaceNet(output, chunk);
  
  expect(mesh).toNotBeNull();
  if (mesh) {
    expect(mesh.geometry.getAttribute('position')).toBeDefined();
    expect(mesh.geometry.getAttribute('normal')).toBeDefined();
    expect(mesh.geometry.getAttribute('color')).toBeDefined();
    expect(mesh.geometry.index).toNotBeNull();
    
    mesh.geometry.dispose();
  }
});

test('Mesh is positioned correctly at chunk world coordinates', () => {
  const chunk = new Chunk(2, -1, 3);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  const mesh = createMeshFromSurfaceNet(output, chunk);
  
  expect(mesh).toNotBeNull();
  if (mesh) {
    // Chunk (2, -1, 3) should be at world position (16, -8, 24)
    expect(mesh.position.x).toBeCloseTo(2 * CHUNK_WORLD_SIZE, 1);
    expect(mesh.position.y).toBeCloseTo(-1 * CHUNK_WORLD_SIZE, 1);
    expect(mesh.position.z).toBeCloseTo(3 * CHUNK_WORLD_SIZE, 1);
    
    mesh.geometry.dispose();
  }
});

test('Empty chunk produces no mesh', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.fill(-0.5, 0, 16); // All empty
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  const mesh = createMeshFromSurfaceNet(output, chunk);
  
  expect(mesh).toBeNull();
});

test('Mesh vertices are scaled to world units', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  const mesh = createMeshFromSurfaceNet(output, chunk);
  
  expect(mesh).toNotBeNull();
  if (mesh) {
    const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    
    // Check that positions are in world scale (VOXEL_SCALE = 0.25)
    // A voxel at position 16 in voxel coords should be at 4.0 in world coords
    let foundSurfaceVertex = false;
    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i);
      // Surface at voxel Y=16 should be around world Y=4.0
      if (Math.abs(y - 16 * VOXEL_SCALE) < 0.5) {
        foundSurfaceVertex = true;
        break;
      }
    }
    expect(foundSurfaceVertex).toBeTrue();
    
    mesh.geometry.dispose();
  }
});

test('Mesh has vertex colors matching material IDs', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16); // Material 0 = green
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  const mesh = createMeshFromSurfaceNet(output, chunk);
  
  expect(mesh).toNotBeNull();
  if (mesh) {
    const colorAttr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(colorAttr).toBeDefined();
    expect(colorAttr.count).toBeGreaterThan(0);
    
    // Check that colors are in valid range
    for (let i = 0; i < Math.min(10, colorAttr.count); i++) {
      const r = colorAttr.getX(i);
      const g = colorAttr.getY(i);
      const b = colorAttr.getZ(i);
      
      if (r < 0 || r > 1 || g < 0 || g > 1 || b < 0 || b > 1) {
        throw new Error(`Invalid color at vertex ${i}: (${r}, ${g}, ${b})`);
      }
    }
    
    mesh.geometry.dispose();
  }
});

test('Mesh has bounding box computed', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  const mesh = createMeshFromSurfaceNet(output, chunk);
  
  expect(mesh).toNotBeNull();
  if (mesh) {
    expect(mesh.geometry.boundingBox).toNotBeNull();
    expect(mesh.geometry.boundingSphere).toNotBeNull();
    
    mesh.geometry.dispose();
  }
});

test('Mesh casts and receives shadows', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  const mesh = createMeshFromSurfaceNet(output, chunk);
  
  expect(mesh).toNotBeNull();
  if (mesh) {
    expect(mesh.castShadow).toBeTrue();
    expect(mesh.receiveShadow).toBeTrue();
    
    mesh.geometry.dispose();
  }
});

// ============== ChunkMesh Class Tests ==============

test('ChunkMesh.updateMesh creates mesh correctly', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const chunkMesh = new ChunkMesh(chunk);
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  chunkMesh.updateMesh(output);
  
  expect(chunkMesh.hasGeometry()).toBeTrue();
  expect(chunkMesh.getVertexCount()).toBeGreaterThan(0);
  expect(chunkMesh.getTriangleCount()).toBeGreaterThan(0);
  
  chunkMesh.disposeMesh();
});

test('ChunkMesh.disposeMesh properly cleans up', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const chunkMesh = new ChunkMesh(chunk);
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  chunkMesh.updateMesh(output);
  expect(chunkMesh.hasGeometry()).toBeTrue();
  
  chunkMesh.disposeMesh();
  
  expect(chunkMesh.mesh).toBeNull();
  expect(chunkMesh.disposed).toBeTrue();
  expect(chunkMesh.hasGeometry()).toBeFalse();
});

test('ChunkMesh.updateMesh disposes old mesh when called again', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const chunkMesh = new ChunkMesh(chunk);
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  chunkMesh.updateMesh(output);
  const firstVertCount = chunkMesh.getVertexCount();
  
  // Update terrain and remesh
  chunk.generateFlat(10, 1, 16);
  const output2 = meshChunk(chunk, neighbors);
  
  chunkMesh.updateMesh(output2);
  
  // Should have new mesh, not crash
  expect(chunkMesh.hasGeometry()).toBeTrue();
  
  chunkMesh.disposeMesh();
});

test('ChunkMesh stores chunk key in userData', () => {
  const chunk = new Chunk(1, 2, 3);
  chunk.generateFlat(16, 0, 16);
  
  const chunkMesh = new ChunkMesh(chunk);
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  chunkMesh.updateMesh(output);
  
  expect(chunkMesh.mesh).toNotBeNull();
  if (chunkMesh.mesh) {
    expect(chunkMesh.mesh.userData.chunkKey).toBe('1,2,3');
  }
  
  chunkMesh.disposeMesh();
});

// ============== Scene Integration Tests ==============

test('ChunkMesh adds to and removes from scene', () => {
  const scene = new THREE.Scene();
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const chunkMesh = new ChunkMesh(chunk);
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  // Add to scene
  chunkMesh.updateMesh(output, scene);
  expect(scene.children.length).toBe(1);
  
  // Remove from scene
  chunkMesh.disposeMesh(scene);
  expect(scene.children.length).toBe(0);
});

test('disposeMesh standalone function works', () => {
  const scene = new THREE.Scene();
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const output = meshChunk(chunk, neighbors);
  
  const mesh = createMeshFromSurfaceNet(output, chunk);
  expect(mesh).toNotBeNull();
  
  if (mesh) {
    scene.add(mesh);
    expect(scene.children.length).toBe(1);
    
    disposeMesh(mesh, scene);
    expect(scene.children.length).toBe(0);
  }
});

// ============== Different Material Tests ==============

test('Different materials produce different vertex colors', () => {
  const chunk1 = new Chunk(0, 0, 0);
  chunk1.generateFlat(16, 0, 16); // Material 0 = green
  
  const chunk2 = new Chunk(1, 0, 0);
  chunk2.generateFlat(16, 1, 16); // Material 1 = red
  
  const neighbors = new Map<string, Chunk>();
  
  const output1 = meshChunk(chunk1, neighbors);
  const output2 = meshChunk(chunk2, neighbors);
  
  const mesh1 = createMeshFromSurfaceNet(output1, chunk1);
  const mesh2 = createMeshFromSurfaceNet(output2, chunk2);
  
  expect(mesh1).toNotBeNull();
  expect(mesh2).toNotBeNull();
  
  if (mesh1 && mesh2) {
    const colors1 = mesh1.geometry.getAttribute('color') as THREE.BufferAttribute;
    const colors2 = mesh2.geometry.getAttribute('color') as THREE.BufferAttribute;
    
    // Get average green component for mesh1 (should be high)
    let avgG1 = 0;
    for (let i = 0; i < colors1.count; i++) {
      avgG1 += colors1.getY(i);
    }
    avgG1 /= colors1.count;
    
    // Get average red component for mesh2 (should be high)
    let avgR2 = 0;
    for (let i = 0; i < colors2.count; i++) {
      avgR2 += colors2.getX(i);
    }
    avgR2 /= colors2.count;
    
    expect(avgG1).toBeGreaterThan(0.4); // Green material has high G
    expect(avgR2).toBeGreaterThan(0.7); // Red material has high R
    
    mesh1.geometry.dispose();
    mesh2.geometry.dispose();
  }
});

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
