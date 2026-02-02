/**
 * Bridge between game core and Zustand store
 * 
 * ALL non-React code must use this bridge for store access.
 * React components should use the useGameStore hook directly.
 * 
 * This centralizes store access, enabling:
 * - Rate limiting for high-frequency updates
 * - Single point of control for state access patterns
 * - Clean separation between React and imperative game code
 */

import { useGameStore, ConnectionStatus, VoxelStats, VoxelDebugToggles, BuildState, TextureLoadingState } from './store';
import { getPreset, BuildPreset, BUILD_ROTATION_STEP, BUILD_ROTATION_STEPS, GameMode } from '@worldify/shared';

// Cache getState for cleaner access - always returns fresh state
const getState = useGameStore.getState;

class StoreBridge {
  private lastUpdateTime = 0;
  private readonly updateIntervalMs = 100; // 10 Hz

  // Callback for clearing chunks (set by GameCore)
  private clearChunksCallback: (() => void) | null = null;

  // ============== READS (game code reads state here) ==============

  get connectionStatus(): ConnectionStatus {
    return getState().connectionStatus;
  }

  get gameMode(): GameMode {
    return getState().gameMode;
  }

  get voxelDebug(): VoxelDebugToggles {
    return getState().voxelDebug;
  }

  get playerId(): number | null {
    return getState().playerId;
  }

  // Build system reads
  get buildState(): BuildState {
    return getState().build;
  }

  get buildPresetId(): number {
    return getState().build.presetId;
  }

  get buildPreset(): BuildPreset {
    return getPreset(this.buildPresetId);
  }

  get buildRotationSteps(): number {
    return getState().build.rotationSteps;
  }

  get buildRotationDegrees(): number {
    return this.buildRotationSteps * BUILD_ROTATION_STEP;
  }

  get buildRotationRadians(): number {
    return (this.buildRotationSteps * BUILD_ROTATION_STEP * Math.PI) / 180;
  }

  get buildIsEnabled(): boolean {
    return this.buildPresetId !== 0;
  }

  get useServerChunks(): boolean {
    return getState().useServerChunks;
  }

  get spawnReady(): boolean {
    return getState().spawnReady;
  }

  // ============== WRITES ==============

  updateConnectionStatus(status: ConnectionStatus): void {
    getState().setConnectionStatus(status);
  }

  updateRoomInfo(roomId: string, playerId: number): void {
    getState().setRoomInfo(roomId, playerId);
  }

  updatePlayerCount(count: number): void {
    getState().setPlayerCount(count);
  }

  updatePing(ping: number): void {
    getState().setPing(ping);
  }

  setGameMode(mode: GameMode): void {
    getState().setGameMode(mode);
  }

  setSpawnReady(ready: boolean): void {
    getState().setSpawnReady(ready);
  }

  updateServerTick(tick: number): void {
    getState().setServerTick(tick);
  }

  /**
   * Rate-limited debug stats update
   */
  updateDebugStats(fps: number, tickMs: number): void {
    const now = performance.now();
    if (now - this.lastUpdateTime >= this.updateIntervalMs) {
      getState().setDebugStats(fps, tickMs);
      this.lastUpdateTime = now;
    }
  }

  /**
   * Update voxel world statistics
   */
  updateVoxelStats(stats: Partial<VoxelStats>): void {
    getState().setVoxelStats(stats);
  }

  // Build system writes
  
  /**
   * Select a build preset (0-9).
   * 0 = disabled, 1-9 = presets
   */
  selectBuildPreset(presetId: number): void {
    getState().setBuildPreset(presetId);
  }

  /**
   * Set build rotation in steps (0 to BUILD_ROTATION_STEPS-1).
   */
  setBuildRotation(steps: number): void {
    getState().setBuildRotation(steps);
  }

  /**
   * Rotate build by direction (-1 or +1).
   */
  rotateBuild(direction: number): void {
    const current = this.buildRotationSteps;
    const next = (current + direction + BUILD_ROTATION_STEPS) % BUILD_ROTATION_STEPS;
    this.setBuildRotation(next);
  }

  /**
   * Update whether build has a valid target.
   */
  setBuildHasValidTarget(valid: boolean): void {
    getState().setBuildHasValidTarget(valid);
  }

  // Texture/material system

  get textureState(): TextureLoadingState {
    return getState().textureState;
  }

  get textureProgress(): number {
    return getState().textureProgress;
  }

  setTextureState(state: TextureLoadingState): void {
    getState().setTextureState(state);
  }

  setTextureProgress(progress: number): void {
    getState().setTextureProgress(progress);
  }

  // Chunk clearing (for dev/debug)

  /**
   * Register callback for clearing chunks.
   * Called by GameCore during initialization.
   */
  setClearChunksCallback(callback: () => void): void {
    this.clearChunksCallback = callback;
  }

  /**
   * Clear all chunks and reload from server.
   * Used by F9 debug key.
   */
  clearAndReloadChunks(): void {
    if (this.clearChunksCallback) {
      this.clearChunksCallback();
    } else {
      console.warn('[StoreBridge] No chunk clear callback registered');
    }
  }

  // Force regenerate mode (dev/debug)

  get forceRegenerateChunks(): boolean {
    return getState().forceRegenerateChunks;
  }

  /**
   * Toggle force regenerate mode.
   * When enabled, chunk requests will include forceRegen flag.
   */
  toggleForceRegenerate(): void {
    const newValue = !this.forceRegenerateChunks;
    getState().setForceRegenerateChunks(newValue);
    console.log(`[StoreBridge] Force regenerate: ${newValue ? 'ON' : 'OFF'}`);
  }
}

export const storeBridge = new StoreBridge();
