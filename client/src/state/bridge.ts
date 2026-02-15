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

import { useGameStore, ConnectionStatus, VoxelStats, VoxelDebugToggles, BuildState, TextureLoadingState, MaterialSettings, WaterSettings, PerfSnapshot } from './store';
import { getPreset, BuildPreset, BUILD_ROTATION_STEP, BUILD_ROTATION_STEPS, GameMode } from '@worldify/shared';
import { applyMaterialSettings as applyMaterialSettingsToShaders } from '../game/material/TerrainMaterial';
import { applyWaterSettings as applyWaterSettingsToShaders } from '../game/material/WaterMaterial';
import type { QualityLevel } from '../game/quality/QualityPresets';

// Cache getState for cleaner access - always returns fresh state
const getState = useGameStore.getState;

class StoreBridge {
  private lastUpdateTime = 0;
  private readonly updateIntervalMs = 100; // 10 Hz

  // Callback for clearing chunks (set by GameCore)
  private clearChunksCallback: (() => void) | null = null;

  // Map player position (high-frequency, not in Zustand to avoid re-renders)
  private _mapPlayerPosition = { x: 0, z: 0, rotation: 0 };

  // ============== READS (game code reads state here) ==============

  /**
   * Get current player position for map overlay.
   * Updated every frame by GameCore, read by MapOverlay.
   */
  get mapPlayerPosition(): { x: number; z: number; rotation: number } {
    return this._mapPlayerPosition;
  }

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

  /**
   * Update player position for map overlay.
   * Called every frame by GameCore. Does not trigger React re-renders.
   */
  updateMapPlayerPosition(x: number, z: number, rotation: number): void {
    this._mapPlayerPosition.x = x;
    this._mapPlayerPosition.z = z;
    this._mapPlayerPosition.rotation = rotation;
  }

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

  /**
   * Update detailed performance stats (already rate-limited by PerformanceStats collector)
   */
  updatePerfStats(stats: PerfSnapshot): void {
    getState().setPerfStats(stats);
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

  // ============== Material Settings ==============

  get materialSettings(): MaterialSettings {
    return getState().materialSettings;
  }

  /**
   * Update material settings and apply to shaders.
   * Called from DebugPanel when sliders change.
   */
  setMaterialSettings(updates: Partial<MaterialSettings>): void {
    getState().setMaterialSettings(updates);
    // Apply to shader uniforms
    applyMaterialSettingsToShaders(updates);
  }

  /**
   * Reset material settings to defaults and apply to shaders.
   */
  resetMaterialSettings(): void {
    getState().resetMaterialSettings();
    // Apply defaults to shaders
    applyMaterialSettingsToShaders(getState().materialSettings);
  }

  /**
   * Apply current material settings to shaders.
   * Call this after materials are initialized.
   */
  applyCurrentMaterialSettings(): void {
    applyMaterialSettingsToShaders(this.materialSettings);
  }

  // ============== Water Settings ==============

  get waterSettings(): WaterSettings {
    return getState().waterSettings;
  }

  /**
   * Update water settings and apply to shaders.
   * Called from DebugPanel when sliders change.
   */
  setWaterSettings(updates: Partial<WaterSettings>): void {
    getState().setWaterSettings(updates);
    // Apply to shader uniforms
    applyWaterSettingsToShaders(updates);
  }

  /**
   * Reset water settings to defaults and apply to shaders.
   */
  resetWaterSettings(): void {
    getState().resetWaterSettings();
    // Apply defaults to shaders
    applyWaterSettingsToShaders(getState().waterSettings);
  }

  /**
   * Apply current water settings to shaders.
   * Call this after materials are initialized.
   */
  applyCurrentWaterSettings(): void {
    applyWaterSettingsToShaders(this.waterSettings);
  }

  // ============== Day-Night Cycle ==============

  get dayNightEnabled(): boolean {
    return getState().environment.dayNightEnabled;
  }

  get timeOfDay(): number {
    return getState().environment.timeOfDay;
  }

  get timeSpeed(): number {
    return getState().environment.timeSpeed;
  }

  get environment() {
    return getState().environment;
  }

  /**
   * Set time of day (0-1 normalized)
   */
  setTimeOfDay(time: number): void {
    getState().setTimeOfDay(time);
  }

  /**
   * Set time speed (game-minutes per real-second)
   */
  setTimeSpeed(speed: number): void {
    getState().setTimeSpeed(speed);
  }

  /**
   * Update environment settings
   */
  setEnvironment(updates: Partial<typeof getState extends () => { environment: infer E } ? E : never>): void {
    getState().setEnvironment(updates);
  }

  // ============== Quality Settings ==============

  get qualityLevel(): QualityLevel {
    return getState().qualityLevel;
  }

  get visibilityRadius(): number {
    return getState().visibilityRadius;
  }

  get ssaoEnabled(): boolean {
    return getState().ssaoEnabled;
  }

  get bloomEnabled(): boolean {
    return getState().bloomEnabled;
  }

  get colorCorrectionEnabled(): boolean {
    return getState().colorCorrectionEnabled;
  }

  get shadowsEnabled(): boolean {
    return getState().shadowsEnabled;
  }

  get moonShadows(): boolean {
    return getState().moonShadows;
  }

  get anisotropy(): number {
    return getState().anisotropy;
  }

  get maxPixelRatio(): number {
    return getState().maxPixelRatio;
  }

  get shaderNormalMaps(): boolean {
    return getState().shaderNormalMaps;
  }

  get shaderAoMaps(): boolean {
    return getState().shaderAoMaps;
  }

  get shaderMetalnessMaps(): boolean {
    return getState().shaderMetalnessMaps;
  }

  setQualityLevel(level: QualityLevel): void {
    getState().setQualityLevel(level);
  }

  setVisibilityRadius(radius: number): void {
    getState().setVisibilityRadius(radius);
  }

  setSsaoEnabled(enabled: boolean): void {
    getState().setSsaoEnabled(enabled);
  }

  setBloomEnabled(enabled: boolean): void {
    getState().setBloomEnabled(enabled);
  }

  setColorCorrectionEnabled(enabled: boolean): void {
    getState().setColorCorrectionEnabled(enabled);
  }

  setShadowsEnabled(enabled: boolean): void {
    getState().setShadowsEnabled(enabled);
  }

  setMoonShadows(enabled: boolean): void {
    getState().setMoonShadows(enabled);
  }

  setAnisotropy(value: number): void {
    getState().setAnisotropy(value);
  }

  setMaxPixelRatio(ratio: number): void {
    getState().setMaxPixelRatio(ratio);
  }

  get msaaSamples(): number {
    return getState().msaaSamples;
  }

  setMsaaSamples(samples: number): void {
    getState().setMsaaSamples(samples);
  }

  setShaderNormalMaps(enabled: boolean): void {
    getState().setShaderNormalMaps(enabled);
  }

  setShaderAoMaps(enabled: boolean): void {
    getState().setShaderAoMaps(enabled);
  }

  setShaderMetalnessMaps(enabled: boolean): void {
    getState().setShaderMetalnessMaps(enabled);
  }
}

export const storeBridge = new StoreBridge();
