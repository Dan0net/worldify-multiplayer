/**
 * Unit tests for ChunkMesh and VoxelMaterials
 */

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { meshChunk } from './ChunkMesher.js';
import { Chunk } from './Chunk.js';
import { ChunkMesh, createMeshFromSurfaceNet, disposeMesh } from './ChunkMesh.js';
import { getMaterialColor, MATERIAL_COLORS, voxelMaterial } from './VoxelMaterials.js';
import { CHUNK_WORLD_SIZE, VOXEL_SCALE } from '@worldify/shared';

describe('VoxelMaterials Tests', () => {
  test('Material ID 0 is green', () => {
    const color = getMaterialColor(0);
    expect(color.g).toBeGreaterThan(color.r);
    expect(color.g).toBeGreaterThan(color.b);
  });

  test('Material ID 1 is red', () => {
    const color = getMaterialColor(1);
    expect(color.r).toBeGreaterThan(0.7);
  });

  test('Material ID 2 is blue', () => {
    const color = getMaterialColor(2);
    expect(color.b).toBeGreaterThan(0.7);
  });

  test('MATERIAL_COLORS has 128 entries', () => {
    expect(MATERIAL_COLORS.length).toBe(128);
  });

  test('getMaterialColor clamps out-of-range IDs', () => {
    const colorNeg = getMaterialColor(-5);
    const colorHigh = getMaterialColor(200);
    expect(colorNeg).toBeDefined();
    expect(colorHigh).toBeDefined();
  });

  test('voxelMaterial uses vertex colors', () => {
    expect(voxelMaterial.vertexColors).toBe(true);
  });
});

describe('ChunkMesh Mesh Creation Tests', () => {
  test('Single chunk with flat terrain creates visible mesh', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    const mesh = createMeshFromSurfaceNet(output.solid, chunk);
    
    expect(mesh).not.toBeNull();
    if (mesh) {
      expect(mesh.geometry.getAttribute('position')).toBeDefined();
      expect(mesh.geometry.getAttribute('normal')).toBeDefined();
      expect(mesh.geometry.getAttribute('materialIds')).toBeDefined();
      
      mesh.geometry.dispose();
    }
  });

  test('Mesh is positioned correctly at chunk world coordinates', () => {
    const chunk = new Chunk(2, -1, 3);
    chunk.generateFlat(16, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    const mesh = createMeshFromSurfaceNet(output.solid, chunk);
    
    expect(mesh).not.toBeNull();
    if (mesh) {
      expect(mesh.position.x).toBeCloseTo(2 * CHUNK_WORLD_SIZE, 1);
      expect(mesh.position.y).toBeCloseTo(-1 * CHUNK_WORLD_SIZE, 1);
      expect(mesh.position.z).toBeCloseTo(3 * CHUNK_WORLD_SIZE, 1);
      
      mesh.geometry.dispose();
    }
  });

  test('Empty chunk produces no mesh', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.fill(-0.5, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    const mesh = createMeshFromSurfaceNet(output.solid, chunk);
    
    expect(mesh).toBeNull();
  });

  test('Mesh vertices are scaled to world units', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    const mesh = createMeshFromSurfaceNet(output.solid, chunk);
    
    expect(mesh).not.toBeNull();
    if (mesh) {
      const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      
      let foundSurfaceVertex = false;
      for (let i = 0; i < posAttr.count; i++) {
        const y = posAttr.getY(i);
        if (Math.abs(y - 16 * VOXEL_SCALE) < 0.5) {
          foundSurfaceVertex = true;
          break;
        }
      }
      expect(foundSurfaceVertex).toBe(true);
      
      mesh.geometry.dispose();
    }
  });

  test('Mesh has vertex colors matching material IDs', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    const mesh = createMeshFromSurfaceNet(output.solid, chunk);
    
    expect(mesh).not.toBeNull();
    if (mesh) {
      const colorAttr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      expect(colorAttr).toBeDefined();
      expect(colorAttr.count).toBeGreaterThan(0);
      
      for (let i = 0; i < Math.min(10, colorAttr.count); i++) {
        const r = colorAttr.getX(i);
        const g = colorAttr.getY(i);
        const b = colorAttr.getZ(i);
        
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(1);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1);
      }
      
      mesh.geometry.dispose();
    }
  });

  test('Mesh has bounding box computed', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    const mesh = createMeshFromSurfaceNet(output.solid, chunk);
    
    expect(mesh).not.toBeNull();
    if (mesh) {
      expect(mesh.geometry.boundingBox).not.toBeNull();
      expect(mesh.geometry.boundingSphere).not.toBeNull();
      
      mesh.geometry.dispose();
    }
  });

  test('Mesh casts and receives shadows', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    const mesh = createMeshFromSurfaceNet(output.solid, chunk);
    
    expect(mesh).not.toBeNull();
    if (mesh) {
      expect(mesh.castShadow).toBe(true);
      expect(mesh.receiveShadow).toBe(true);
      
      mesh.geometry.dispose();
    }
  });
});

describe('ChunkMesh Class Tests', () => {
  test('ChunkMesh.updateMesh creates mesh correctly', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const chunkMesh = new ChunkMesh(chunk);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    chunkMesh.updateMesh(output.solid);
    
    expect(chunkMesh.hasGeometry()).toBe(true);
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
    
    chunkMesh.updateMesh(output.solid);
    expect(chunkMesh.hasGeometry()).toBe(true);
    
    chunkMesh.disposeMesh();
    
    expect(chunkMesh.mesh).toBeNull();
    expect(chunkMesh.disposed).toBe(true);
    expect(chunkMesh.hasGeometry()).toBe(false);
  });

  test('ChunkMesh.updateMesh disposes old mesh when called again', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const chunkMesh = new ChunkMesh(chunk);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    chunkMesh.updateMesh(output.solid);
    const firstVertCount = chunkMesh.getVertexCount();
    
    chunk.generateFlat(10, 1, 16);
    const output2 = meshChunk(chunk, neighbors);
    
    chunkMesh.updateMesh(output2);
    
    expect(chunkMesh.hasGeometry()).toBe(true);
    
    chunkMesh.disposeMesh();
  });

  test('ChunkMesh stores chunk key in userData', () => {
    const chunk = new Chunk(1, 2, 3);
    chunk.generateFlat(16, 0, 16);
    
    const chunkMesh = new ChunkMesh(chunk);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    chunkMesh.updateMesh(output.solid);
    
    expect(chunkMesh.mesh).not.toBeNull();
    if (chunkMesh.mesh) {
      expect(chunkMesh.mesh.userData.chunkKey).toBe('1,2,3');
    }
    
    chunkMesh.disposeMesh();
  });
});

describe('Scene Integration Tests', () => {
  test('ChunkMesh adds to and removes from scene', () => {
    const scene = new THREE.Scene();
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const chunkMesh = new ChunkMesh(chunk);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    chunkMesh.updateMesh(output, scene);
    expect(scene.children.length).toBe(1);
    
    chunkMesh.disposeMesh(scene);
    expect(scene.children.length).toBe(0);
  });

  test('disposeMesh standalone function works', () => {
    const scene = new THREE.Scene();
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const output = meshChunk(chunk, neighbors);
    
    const mesh = createMeshFromSurfaceNet(output.solid, chunk);
    expect(mesh).not.toBeNull();
    
    if (mesh) {
      scene.add(mesh);
      expect(scene.children.length).toBe(1);
      
      disposeMesh(mesh, scene);
      expect(scene.children.length).toBe(0);
    }
  });
});

describe('Different Material Tests', () => {
  test('Different materials produce different vertex colors', () => {
    const chunk1 = new Chunk(0, 0, 0);
    chunk1.generateFlat(16, 0, 16);
    
    const chunk2 = new Chunk(1, 0, 0);
    chunk2.generateFlat(16, 1, 16);
    
    const neighbors = new Map<string, Chunk>();
    
    const output1 = meshChunk(chunk1, neighbors);
    const output2 = meshChunk(chunk2, neighbors);
    
    const mesh1 = createMeshFromSurfaceNet(output1, chunk1);
    const mesh2 = createMeshFromSurfaceNet(output2, chunk2);
    
    expect(mesh1).not.toBeNull();
    expect(mesh2).not.toBeNull();
    
    if (mesh1 && mesh2) {
      const colors1 = mesh1.geometry.getAttribute('color') as THREE.BufferAttribute;
      const colors2 = mesh2.geometry.getAttribute('color') as THREE.BufferAttribute;
      
      let avgG1 = 0;
      for (let i = 0; i < colors1.count; i++) {
        avgG1 += colors1.getY(i);
      }
      avgG1 /= colors1.count;
      
      let avgR2 = 0;
      for (let i = 0; i < colors2.count; i++) {
        avgR2 += colors2.getX(i);
      }
      avgR2 /= colors2.count;
      
      expect(avgG1).toBeGreaterThan(0.4);
      expect(avgR2).toBeGreaterThan(0.7);
      
      mesh1.geometry.dispose();
      mesh2.geometry.dispose();
    }
  });
});
