/**
 * SpawnManager - Handles player spawn and respawn logic
 * 
 * Responsibilities:
 * - Finding spawn positions via terrain raycast
 * - Tracking spawn readiness (terrain loaded at spawn point)
 * - Finding respawn positions after falling
 * - Debug visualization for spawn detection
 * 
 * Uses TerrainRaycaster interface to decouple from VoxelIntegration.
 */

import * as THREE from 'three';
import { 
  PLAYER_HEIGHT, 
  SPAWN_HEIGHT_OFFSET, 
  SPAWN_RAYCAST_HEIGHT,
  SPAWN_FALLBACK_HEIGHT,
} from '@worldify/shared';
import type { TerrainRaycaster } from './TerrainRaycaster';

/**
 * Configuration for SpawnManager
 */
export interface SpawnConfig {
  /** Whether to show spawn debug visualization */
  showDebug?: boolean;
}

const DEFAULT_CONFIG: Required<SpawnConfig> = {
  showDebug: true,
};

/**
 * SpawnManager handles all spawn/respawn position finding.
 */
export class SpawnManager {
  private config: Required<SpawnConfig>;
  private scene: THREE.Scene;
  private terrainProvider: TerrainRaycaster | null = null;
  
  // Raycaster for terrain height detection
  private raycaster = new THREE.Raycaster();
  
  // Spawn state
  private cachedSpawnPosition: THREE.Vector3 | null = null;
  private spawnFound = false;
  private lastMeshCount = 0;
  
  // Debug visualization
  private debugObjects: THREE.Object3D[] = [];

  constructor(scene: THREE.Scene, config: SpawnConfig = {}) {
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the terrain provider for raycasting.
   */
  setTerrainProvider(provider: TerrainRaycaster): void {
    this.terrainProvider = provider;
  }

  /**
   * Update spawn detection.
   * Call during spectator mode to find spawn point when terrain loads.
   */
  update(): void {
    if (!this.terrainProvider) return;
    
    const meshes = this.terrainProvider.getCollisionMeshes();
    const currentMeshCount = meshes.length;
    
    // Only re-raycast if mesh count changed (new chunks loaded)
    if (currentMeshCount !== this.lastMeshCount) {
      this.lastMeshCount = currentMeshCount;
      
      // Attempt raycast at origin
      const terrainHeight = this.raycastTerrainHeight(0, 0);
      
      if (terrainHeight !== null) {
        const spawnY = this.calculateSpawnY(terrainHeight);
        this.cachedSpawnPosition = new THREE.Vector3(0, spawnY, 0);
        this.spawnFound = true;
        console.log(`[SpawnManager] Spawn point found at Y=${spawnY.toFixed(2)}`);
      } else {
        this.spawnFound = false;
      }
    }
  }

  /**
   * Check if spawn point has been found via raycast.
   */
  isSpawnReady(): boolean {
    return this.spawnFound;
  }

  /**
   * Get the cached spawn position (from spectator mode detection).
   * Falls back to getSpawnPosition if not cached.
   */
  getCachedSpawnPosition(): THREE.Vector3 {
    if (this.cachedSpawnPosition) {
      return this.cachedSpawnPosition.clone();
    }
    return this.getSpawnPosition(0, 0);
  }

  /**
   * Get spawn position by raycasting down to find terrain.
   * Falls back to high position if no terrain found.
   * 
   * @param x World X coordinate
   * @param z World Z coordinate
   * @returns Spawn position
   */
  getSpawnPosition(x: number = 0, z: number = 0): THREE.Vector3 {
    const terrainHeight = this.raycastTerrainHeight(x, z);
    
    if (terrainHeight !== null) {
      const spawnY = this.calculateSpawnY(terrainHeight);
      return new THREE.Vector3(x, spawnY, z);
    }
    
    // Fallback: spawn HIGH to let gravity bring player down
    console.warn('[SpawnManager] No terrain found, using fallback height');
    return new THREE.Vector3(x, SPAWN_FALLBACK_HEIGHT, z);
  }

  /**
   * Find a safe respawn position for a player who fell too long.
   * 
   * Priority:
   * 1. Last grounded position (if available)
   * 2. Raycast at current XZ
   * 3. Raycast at origin
   * 4. null (terrain not ready)
   * 
   * @param currentPos Current player position
   * @param lastGroundedPos Last position where player was grounded
   * @returns Respawn position, or null if terrain not ready
   */
  findRespawnPosition(
    currentPos: THREE.Vector3,
    lastGroundedPos: THREE.Vector3 | null
  ): THREE.Vector3 | null {
    // Option 1: Use last grounded position
    if (lastGroundedPos) {
      console.log('[SpawnManager] Respawning at last grounded position');
      return lastGroundedPos.clone();
    }
    
    // Option 2: Raycast at current XZ
    const terrainAtCurrent = this.raycastTerrainHeight(currentPos.x, currentPos.z);
    if (terrainAtCurrent !== null) {
      console.log('[SpawnManager] Respawning via raycast at current XZ');
      return new THREE.Vector3(currentPos.x, this.calculateSpawnY(terrainAtCurrent), currentPos.z);
    }
    
    // Option 3: Raycast at origin
    const terrainAtOrigin = this.raycastTerrainHeight(0, 0);
    if (terrainAtOrigin !== null) {
      console.log('[SpawnManager] Respawning via raycast at origin');
      return new THREE.Vector3(0, this.calculateSpawnY(terrainAtOrigin), 0);
    }
    
    // All methods failed - terrain not loaded
    console.warn('[SpawnManager] All respawn methods failed - terrain not ready');
    return null;
  }

  /**
   * Calculate spawn Y from terrain height (DRY helper).
   */
  private calculateSpawnY(terrainHeight: number): number {
    return terrainHeight + PLAYER_HEIGHT + SPAWN_HEIGHT_OFFSET;
  }

  /**
   * Raycast down from a high point to find terrain surface.
   * 
   * @param x World X coordinate
   * @param z World Z coordinate
   * @returns Y coordinate of terrain surface, or null if not found
   */
  private raycastTerrainHeight(x: number, z: number): number | null {
    if (!this.terrainProvider) return null;
    
    const rayOrigin = new THREE.Vector3(x, SPAWN_RAYCAST_HEIGHT, z);
    const rayDir = new THREE.Vector3(0, -1, 0);
    
    this.raycaster.set(rayOrigin, rayDir);
    this.raycaster.far = SPAWN_RAYCAST_HEIGHT * 2;
    
    const meshes = this.terrainProvider.getCollisionMeshes();
    
    if (meshes.length === 0) {
      return null;
    }
    
    const intersects = this.raycaster.intersectObjects(meshes, false);
    
    if (intersects.length > 0) {
      const hitPoint = intersects[0].point;
      
      // Show debug visualization if enabled
      if (this.config.showDebug) {
        this.showDebugVisualization(rayOrigin, hitPoint);
      }
      
      return hitPoint.y;
    }
    
    return null;
  }

  /**
   * Show debug visualization for spawn raycast.
   */
  private showDebugVisualization(rayOrigin: THREE.Vector3, hitPoint: THREE.Vector3): void {
    this.clearDebugVisualization();
    
    // Line from ray origin to hit
    const lineMaterial = new THREE.LineBasicMaterial({ 
      color: 0x00ff00, 
      depthTest: false,
      transparent: true,
      opacity: 0.8
    });
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([rayOrigin, hitPoint]);
    const line = new THREE.Line(lineGeometry, lineMaterial);
    line.renderOrder = 999;
    this.scene.add(line);
    this.debugObjects.push(line);
    
    // Hit marker (red sphere)
    const hitMarker = this.createMarker(hitPoint, 0.3, 0xff0000);
    this.scene.add(hitMarker);
    this.debugObjects.push(hitMarker);
    
    // Spawn position marker (cyan sphere)
    const spawnY = this.calculateSpawnY(hitPoint.y);
    const spawnMarker = this.createMarker(
      new THREE.Vector3(hitPoint.x, spawnY, hitPoint.z), 
      0.2, 
      0x00ffff
    );
    this.scene.add(spawnMarker);
    this.debugObjects.push(spawnMarker);
  }

  /**
   * Create a debug marker sphere.
   */
  private createMarker(position: THREE.Vector3, radius: number, color: number): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(radius, 16, 16);
    const material = new THREE.MeshBasicMaterial({ 
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.8
    });
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(position);
    marker.renderOrder = 999;
    return marker;
  }

  /**
   * Clear spawn debug visualization.
   */
  clearDebugVisualization(): void {
    for (const obj of this.debugObjects) {
      this.scene.remove(obj);
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    }
    this.debugObjects = [];
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    this.clearDebugVisualization();
    this.terrainProvider = null;
  }
}
