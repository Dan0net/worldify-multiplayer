/**
 * VoxelDebug - Visual debugging tools for voxel terrain
 * 
 * Provides:
 * - Chunk boundary wireframes (8m × 8m × 8m boxes)
 * - Empty chunk markers
 * - Collision mesh wireframes
 * - Chunk coordinate labels
 */

import * as THREE from 'three';
import { CHUNK_WORLD_SIZE } from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { ChunkMesh } from './ChunkMesh.js';

// ============== Debug Colors ==============
/** Green - chunk has visible mesh */
export const COLOR_HAS_MESH = 0x00ff00;
/** Yellow - chunk is empty (no surface) */
export const COLOR_EMPTY = 0xffff00;
/** Red - chunk is loading */
export const COLOR_LOADING = 0xff0000;
/** Cyan - collision wireframe */
export const COLOR_COLLISION = 0x00ffff;
/** White - chunk coordinate text */
export const COLOR_TEXT = 0xffffff;

// ============== Debug State ==============

/**
 * Debug toggle state - controls which visualizations are shown.
 */
export interface VoxelDebugState {
  showChunkBounds: boolean;
  showEmptyChunks: boolean;
  showCollisionMesh: boolean;
  showChunkCoords: boolean;
}

/**
 * Default debug state - all disabled
 */
export const DEFAULT_DEBUG_STATE: VoxelDebugState = {
  showChunkBounds: false,
  showEmptyChunks: false,
  showCollisionMesh: false,
  showChunkCoords: false,
};

// ============== Helper Creation Functions ==============

/**
 * Create a wireframe box for chunk boundaries.
 * @param chunk The chunk to create bounds for
 * @param hasMesh Whether the chunk has a visible mesh
 * @returns LineSegments object representing chunk bounds
 */
export function createChunkBoundsHelper(chunk: Chunk, hasMesh: boolean): THREE.LineSegments {
  const geometry = new THREE.BoxGeometry(CHUNK_WORLD_SIZE, CHUNK_WORLD_SIZE, CHUNK_WORLD_SIZE);
  const edges = new THREE.EdgesGeometry(geometry);
  
  const color = hasMesh ? COLOR_HAS_MESH : COLOR_EMPTY;
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 });
  
  const wireframe = new THREE.LineSegments(edges, material);
  
  // Position at chunk center
  const worldPos = chunk.getWorldPosition();
  wireframe.position.set(
    worldPos.x + CHUNK_WORLD_SIZE / 2,
    worldPos.y + CHUNK_WORLD_SIZE / 2,
    worldPos.z + CHUNK_WORLD_SIZE / 2
  );
  
  // Store chunk info
  wireframe.userData.chunkKey = chunk.key;
  wireframe.userData.debugType = 'chunkBounds';
  
  return wireframe;
}

/**
 * Create a small marker for empty chunks (no terrain surface).
 * @param chunk The empty chunk
 * @returns Mesh object representing empty chunk marker
 */
export function createEmptyChunkMarker(chunk: Chunk): THREE.Mesh {
  // Small translucent box at chunk center
  const size = CHUNK_WORLD_SIZE * 0.1;
  const geometry = new THREE.BoxGeometry(size, size, size);
  const material = new THREE.MeshBasicMaterial({
    color: COLOR_EMPTY,
    transparent: true,
    opacity: 0.3,
  });
  
  const marker = new THREE.Mesh(geometry, material);
  
  // Position at chunk center
  const worldPos = chunk.getWorldPosition();
  marker.position.set(
    worldPos.x + CHUNK_WORLD_SIZE / 2,
    worldPos.y + CHUNK_WORLD_SIZE / 2,
    worldPos.z + CHUNK_WORLD_SIZE / 2
  );
  
  // Store chunk info
  marker.userData.chunkKey = chunk.key;
  marker.userData.debugType = 'emptyMarker';
  
  return marker;
}

/**
 * Create a wireframe overlay for a terrain mesh (collision visualization).
 * @param chunkMesh The ChunkMesh to create wireframe for
 * @returns LineSegments object, or null if no mesh exists
 */
export function createCollisionWireframe(chunkMesh: ChunkMesh): THREE.LineSegments | null {
  if (!chunkMesh.mesh || !chunkMesh.mesh.geometry) {
    return null;
  }
  
  const edges = new THREE.EdgesGeometry(chunkMesh.mesh.geometry, 30); // 30 degree threshold
  const material = new THREE.LineBasicMaterial({
    color: COLOR_COLLISION,
    transparent: true,
    opacity: 0.8,
    depthTest: false, // Render on top to avoid Z-fighting with terrain
  });
  
  const wireframe = new THREE.LineSegments(edges, material);
  wireframe.renderOrder = 1; // Render after terrain
  
  // Copy position from mesh
  wireframe.position.copy(chunkMesh.mesh.position);
  
  // Store chunk info
  wireframe.userData.chunkKey = chunkMesh.chunk.key;
  wireframe.userData.debugType = 'collisionWireframe';
  
  return wireframe;
}

/**
 * Create a text sprite showing chunk coordinates.
 * @param chunk The chunk to label
 * @returns Sprite with coordinate text, or null if DOM not available (Node.js)
 */
export function createChunkLabel(chunk: Chunk): THREE.Sprite | null {
  // Check if document exists (not available in Node.js)
  if (typeof document === 'undefined') {
    return null;
  }
  
  // Create canvas for text
  const canvas = document.createElement('canvas');
  const size = 256;
  canvas.width = size;
  canvas.height = size;
  
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(0, 0, size, size);
  
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${chunk.cx},${chunk.cy},${chunk.cz}`, size / 2, size / 2);
  
  // Create texture from canvas
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  
  const sprite = new THREE.Sprite(material);
  
  // Position at chunk center
  const worldPos = chunk.getWorldPosition();
  sprite.position.set(
    worldPos.x + CHUNK_WORLD_SIZE / 2,
    worldPos.y + CHUNK_WORLD_SIZE / 2,
    worldPos.z + CHUNK_WORLD_SIZE / 2
  );
  
  // Scale to reasonable size
  sprite.scale.set(2, 2, 1);
  
  // Store chunk info
  sprite.userData.chunkKey = chunk.key;
  sprite.userData.debugType = 'chunkLabel';
  
  return sprite;
}

// ============== VoxelDebugManager Class ==============

/**
 * Manages debug visualization for the voxel world.
 * Creates and removes debug objects based on toggle state.
 */
export class VoxelDebugManager {
  /** Reference to the scene */
  readonly scene: THREE.Scene;
  
  /** Current debug state */
  private state: VoxelDebugState = { ...DEFAULT_DEBUG_STATE };
  
  /** All debug objects, keyed by type and chunk key */
  private debugObjects: Map<string, THREE.Object3D> = new Map();
  
  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }
  
  /**
   * Update debug state and refresh visualizations.
   * @param newState Partial state update
   */
  setState(newState: Partial<VoxelDebugState>): void {
    const prevState = { ...this.state };
    this.state = { ...this.state, ...newState };
    
    // Handle toggling off - remove those visuals
    if (prevState.showChunkBounds && !this.state.showChunkBounds) {
      this.removeByType('chunkBounds');
    }
    if (prevState.showEmptyChunks && !this.state.showEmptyChunks) {
      this.removeByType('emptyMarker');
    }
    if (prevState.showCollisionMesh && !this.state.showCollisionMesh) {
      this.removeByType('collisionWireframe');
    }
    if (prevState.showChunkCoords && !this.state.showChunkCoords) {
      this.removeByType('chunkLabel');
    }
  }
  
  /**
   * Get current debug state.
   */
  getState(): VoxelDebugState {
    return { ...this.state };
  }
  
  /**
   * Update debug visuals based on current chunks and meshes.
   * Call this after chunks load/unload.
   * @param chunks All loaded chunks
   * @param meshes All chunk meshes
   */
  update(chunks: Map<string, Chunk>, meshes: Map<string, ChunkMesh>): void {
    // Remove debug objects for unloaded chunks
    const loadedKeys = new Set(chunks.keys());
    const keysToRemove: string[] = [];
    
    for (const [objKey, obj] of this.debugObjects) {
      const chunkKey = obj.userData.chunkKey;
      if (!loadedKeys.has(chunkKey)) {
        keysToRemove.push(objKey);
      }
    }
    
    for (const key of keysToRemove) {
      const obj = this.debugObjects.get(key);
      if (obj) {
        this.disposeObject(obj);
        this.debugObjects.delete(key);
      }
    }
    
    // Add/update debug objects for loaded chunks
    for (const [chunkKey, chunk] of chunks) {
      const chunkMesh = meshes.get(chunkKey);
      const hasMesh = chunkMesh?.hasGeometry() ?? false;
      
      // Chunk bounds
      if (this.state.showChunkBounds) {
        this.ensureChunkBounds(chunk, hasMesh);
      }
      
      // Empty chunk markers
      if (this.state.showEmptyChunks && !hasMesh) {
        this.ensureEmptyMarker(chunk);
      } else {
        // Remove empty marker if chunk now has mesh
        this.removeDebugObject('emptyMarker', chunkKey);
      }
      
      // Collision wireframe
      if (this.state.showCollisionMesh && chunkMesh && hasMesh) {
        this.ensureCollisionWireframe(chunkMesh);
      }
      
      // Chunk labels
      if (this.state.showChunkCoords) {
        this.ensureChunkLabel(chunk);
      }
    }
  }
  
  /**
   * Ensure chunk bounds wireframe exists for a chunk.
   */
  private ensureChunkBounds(chunk: Chunk, hasMesh: boolean): void {
    const objKey = `chunkBounds:${chunk.key}`;
    const existing = this.debugObjects.get(objKey);
    
    if (existing) {
      // Update color if mesh status changed
      const mat = (existing as THREE.LineSegments).material as THREE.LineBasicMaterial;
      const targetColor = hasMesh ? COLOR_HAS_MESH : COLOR_EMPTY;
      if (mat.color.getHex() !== targetColor) {
        mat.color.setHex(targetColor);
      }
      return;
    }
    
    const wireframe = createChunkBoundsHelper(chunk, hasMesh);
    this.debugObjects.set(objKey, wireframe);
    this.scene.add(wireframe);
  }
  
  /**
   * Ensure empty chunk marker exists.
   */
  private ensureEmptyMarker(chunk: Chunk): void {
    const objKey = `emptyMarker:${chunk.key}`;
    if (this.debugObjects.has(objKey)) return;
    
    const marker = createEmptyChunkMarker(chunk);
    this.debugObjects.set(objKey, marker);
    this.scene.add(marker);
  }
  
  /**
   * Ensure collision wireframe exists for a chunk mesh.
   */
  private ensureCollisionWireframe(chunkMesh: ChunkMesh): void {
    const objKey = `collisionWireframe:${chunkMesh.chunk.key}`;
    
    // Remove old wireframe if mesh changed
    const existing = this.debugObjects.get(objKey);
    if (existing) {
      // Check if mesh position changed (mesh was updated)
      if (chunkMesh.mesh && existing.position.equals(chunkMesh.mesh.position)) {
        return; // No change
      }
      // Remove old and recreate
      this.disposeObject(existing);
      this.debugObjects.delete(objKey);
    }
    
    const wireframe = createCollisionWireframe(chunkMesh);
    if (wireframe) {
      this.debugObjects.set(objKey, wireframe);
      this.scene.add(wireframe);
    }
  }
  
  /**
   * Ensure chunk label exists.
   */
  private ensureChunkLabel(chunk: Chunk): void {
    const objKey = `chunkLabel:${chunk.key}`;
    if (this.debugObjects.has(objKey)) return;
    
    const label = createChunkLabel(chunk);
    if (label) {
      this.debugObjects.set(objKey, label);
      this.scene.add(label);
    }
  }
  
  /**
   * Remove a specific debug object.
   */
  private removeDebugObject(type: string, chunkKey: string): void {
    const objKey = `${type}:${chunkKey}`;
    const obj = this.debugObjects.get(objKey);
    if (obj) {
      this.disposeObject(obj);
      this.debugObjects.delete(objKey);
    }
  }
  
  /**
   * Remove all debug objects of a specific type.
   */
  private removeByType(type: string): void {
    const keysToRemove: string[] = [];
    
    for (const [objKey, obj] of this.debugObjects) {
      if (obj.userData.debugType === type) {
        keysToRemove.push(objKey);
      }
    }
    
    for (const key of keysToRemove) {
      const obj = this.debugObjects.get(key);
      if (obj) {
        this.disposeObject(obj);
        this.debugObjects.delete(key);
      }
    }
  }
  
  /**
   * Dispose of a debug object and remove from scene.
   */
  private disposeObject(obj: THREE.Object3D): void {
    this.scene.remove(obj);
    
    // Dispose geometry and material
    if (obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    } else if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    } else if (obj instanceof THREE.Sprite) {
      (obj.material as THREE.SpriteMaterial).map?.dispose();
      obj.material.dispose();
    }
  }
  
  /**
   * Get count of debug objects.
   */
  getDebugObjectCount(): number {
    return this.debugObjects.size;
  }
  
  /**
   * Get stats about debug visualizations.
   */
  getStats(): {
    totalObjects: number;
    chunkBounds: number;
    emptyMarkers: number;
    collisionWireframes: number;
    chunkLabels: number;
  } {
    let chunkBounds = 0;
    let emptyMarkers = 0;
    let collisionWireframes = 0;
    let chunkLabels = 0;
    
    for (const obj of this.debugObjects.values()) {
      switch (obj.userData.debugType) {
        case 'chunkBounds': chunkBounds++; break;
        case 'emptyMarker': emptyMarkers++; break;
        case 'collisionWireframe': collisionWireframes++; break;
        case 'chunkLabel': chunkLabels++; break;
      }
    }
    
    return {
      totalObjects: this.debugObjects.size,
      chunkBounds,
      emptyMarkers,
      collisionWireframes,
      chunkLabels,
    };
  }
  
  /**
   * Dispose of all debug objects.
   */
  dispose(): void {
    for (const obj of this.debugObjects.values()) {
      this.disposeObject(obj);
    }
    this.debugObjects.clear();
  }
}
