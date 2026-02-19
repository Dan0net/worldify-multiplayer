/**
 * GameCore - Main game orchestration
 * 
 * Responsibilities:
 * - Renderer management
 * - Scene/camera setup
 * - Coordinating PlayerManager and GameLoop
 * - Voxel terrain integration
 * - Network event registration
 * 
 * Extracted responsibilities:
 * - Player lifecycle → PlayerManager
 * - RAF/timing/FPS → GameLoop
 */

import * as THREE from 'three';
import { createScene, getScene } from './scene/scene';
import { createCamera, getCamera, updateCameraFromPlayer, updateSpectatorCamera } from './scene/camera';
import { initLighting, applyEnvironmentSettings, updateShadowFollow } from './scene/Lighting';
import { updateDayNightCycle } from './scene/DayNightCycle';
import { updateSkyTime, updateSkyCamera } from './scene/SkyDome';
import { initPostProcessing, renderWithPostProcessing, resizePostProcessing, disposePostProcessing, isPostProcessingEnabled } from './scene/postprocessing';
import { storeBridge } from '../state/bridge';
import { useGameStore } from '../state/store';
import {
  QualityLevel,
  QUALITY_PRESETS,
  loadSavedQualityLevel,
  loadSavedVisibilityRadius,
  detectQualityLevel,
} from './quality/QualityPresets';
import { setRendererRef, setVisibilityRadiusCallback, syncQualityToStore } from './quality/QualityManager';
import { controls } from './player/controls';
import { on } from '../net/decode';
import { RoomSnapshot, GameMode, VoxelBuildCommit, VoxelChunkData, BuildResult, MapTileResponse, SurfaceColumnResponse, updateTileFromChunk, updateTileHash, createMapTile } from '@worldify/shared';
import { VoxelIntegration } from './voxel/VoxelIntegration';
import { setVoxelWireframe } from './voxel/VoxelMaterials';
import { GameLoop } from './GameLoop';
import { PlayerManager } from './PlayerManager';
import { Builder } from './build/Builder';
import { SpawnManager } from './spawn/SpawnManager';
import { materialManager, updateWindTime } from './material';
import { getMapTileCache } from './maptile/mapTileCacheSingleton';
import { perfStats } from './debug/PerformanceStats';

export class GameCore {
  private renderer!: THREE.WebGLRenderer;

  // Extracted modules
  private gameLoop: GameLoop;
  private playerManager: PlayerManager;

  // Voxel terrain system
  private voxelIntegration!: VoxelIntegration;

  // Spawn system
  private spawnManager!: SpawnManager;

  // Build system
  private builder: Builder;

  // Track if player has been properly spawned
  private hasSpawnedPlayer = false;
  private lastGameMode: GameMode = GameMode.MainMenu;
  
  // Center point for spectator camera orbit (updated when leaving Playing mode)
  private spectatorCenter = new THREE.Vector3(0, 0, 0);

  constructor() {
    this.gameLoop = new GameLoop();
    this.playerManager = new PlayerManager();
    this.builder = new Builder(controls);
  }

  async init(): Promise<void> {
    // Initialize material system early (non-blocking)
    materialManager.initialize().catch(err => {
      console.warn('Material initialization failed, using fallback colors:', err);
    });

    // Create renderer
    // antialias: false because EffectComposer uses its own MSAA render target;
    // canvas-level MSAA would only antialias the final fullscreen quad (wasted GPU work).
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x87ceeb); // Sky blue
    
    // Enable shadow mapping
    // Using PCFSoftShadowMap to support customDepthMaterial for alpha-tested shadows
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    
    // Enable tone mapping for better HDR handling
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // Add canvas to DOM
    const canvas = this.renderer.domElement;
    canvas.id = 'game-canvas';
    document.body.appendChild(canvas);

    // Initialize scene, camera, lighting
    createScene();
    createCamera();
    
    // Initialize static lighting system (matches MaterialPreview)
    initLighting(this.renderer);
    
    // Apply initial environment settings from store
    const initialEnv = useGameStore.getState().environment;
    applyEnvironmentSettings(initialEnv);

    // Initialize post-processing (ambient occlusion + bloom)
    const scene = getScene();
    const camera = getCamera();
    if (scene && camera) {
      initPostProcessing(this.renderer, scene, camera, {
        enabled: true,
        // SSAO settings from worldify-app
        ssaoKernelRadius: 0.5,
        ssaoMinDistance: 0.002,
        // Bloom settings
        bloomEnabled: true,
        bloomIntensity: 0.5,
        bloomThreshold: 0.8,
        bloomRadius: 1,
      });
    }

    // ---- Quality auto-detect / restore ----
    setRendererRef(this.renderer);
    const savedLevel = loadSavedQualityLevel();
    const savedVisibility = loadSavedVisibilityRadius();
    let qualityLevel: QualityLevel;
    if (savedLevel) {
      qualityLevel = savedLevel;
      console.log(`[Quality] Restored saved preset: ${qualityLevel}`);
    } else {
      const gl = this.renderer.getContext();
      qualityLevel = detectQualityLevel(gl);
      console.log(`[Quality] Auto-detected preset: ${qualityLevel}`);
    }
    // Store the level so UI can read it
    const effectiveVisibility = savedVisibility ?? QUALITY_PRESETS[qualityLevel].visibilityRadius;

    // Initialize voxel terrain system
    if (scene) {
      this.voxelIntegration = new VoxelIntegration(scene, {
        debugEnabled: false,
        collisionEnabled: true,
      });
      
      // Set camera for visibility-based loading
      if (camera) {
        this.voxelIntegration.setCamera(camera);
      }
      
      // Note: useServerChunks is read from store by VoxelWorld
      this.voxelIntegration.init();
      
      // Wire visibility radius callback for quality system
      setVisibilityRadiusCallback((radius: number) => {
        this.voxelIntegration.world.setVisibilityRadius(radius);
      });
      // Apply the quality preset (including visibility radius) and sync to store
      syncQualityToStore(qualityLevel, effectiveVisibility);
      
      // Initialize spawn manager
      this.spawnManager = new SpawnManager(scene);
      this.spawnManager.setTerrainProvider(this.voxelIntegration);
      
      // Connect player manager to voxel collision system
      this.playerManager.setVoxelIntegration(this.voxelIntegration);
      
      // Set up respawn callback using SpawnManager
      this.playerManager.setRespawnFinder((currentPos, lastGrounded) => 
        this.spawnManager.findRespawnPosition(currentPos, lastGrounded)
      );
      
      // Spawn position will be calculated when entering Playing mode
      // (chunks may not be loaded yet at init time)

      // Wire tile data from VoxelWorld to map cache
      this.voxelIntegration.world.onTileReceived = (tx, tz, heights, materials) => {
        const cache = getMapTileCache();
        cache.receiveTileData(tx, tz, heights, materials);
      };

      // Initialize build system
      this.builder.setMeshProvider(this.voxelIntegration);
      this.builder.setVoxelWorld(this.voxelIntegration.world, scene);
      this.builder.addToScene(scene);

      // Register chunk clearing callback for F9 debug
      storeBridge.setClearChunksCallback(() => {
        const playerPos = this.playerManager.getLocalPlayer().position.clone();
        this.voxelIntegration.clearAndReload(playerPos);
      });
    }

    // Request pointer lock on canvas click (only when playing)
    canvas.addEventListener('click', () => {
      if (storeBridge.gameMode === GameMode.Playing) {
        controls.requestPointerLock();
      }
    });

    // Register for network events
    on('snapshot', this.handleSnapshot);
    on('buildCommit', this.handleBuildCommit);
    on('chunkData', this.handleChunkData);
    on('mapTileData', this.handleMapTileData);
    on('surfaceColumnData', this.handleSurfaceColumnData);

    // Handle resize
    window.addEventListener('resize', this.onResize);

    // Start game loop and input loop
    this.gameLoop.start(this.update);
    this.playerManager.startInputLoop();
  }

  setLocalPlayerId(playerId: number): void {
    this.playerManager.setLocalPlayerId(playerId);
  }

  /**
   * Handle reconnection after server restart.
   * Resets game state to allow fresh start with new server.
   */
  handleReconnect(): void {
    console.log('[GameCore] Handling reconnection...');
    
    // Reset game mode to MainMenu so player sees spectator overlay
    storeBridge.setGameMode(GameMode.MainMenu);
    
    // Reset spawn state so terrain detection starts fresh
    if (this.spawnManager) {
      this.spawnManager.reset();
    }
    storeBridge.setSpawnReady(false);
    
    // Clear and reload chunks from new server
    if (this.voxelIntegration) {
      const playerPos = this.playerManager.getLocalPlayer().position.clone();
      this.voxelIntegration.clearAndReload(playerPos);
    }
    
    // Reset player spawned flag
    this.hasSpawnedPlayer = false;
    
    console.log('[GameCore] Reconnection handling complete');
  }

  private handleSnapshot = (snapshot: RoomSnapshot): void => {
    const scene = getScene();
    if (!scene) return;
    this.playerManager.handleSnapshot(snapshot, scene);
  };

  /**
   * Handle build commit from server - apply to voxel world
   */
  private handleBuildCommit = (commit: VoxelBuildCommit): void => {
    if (commit.result !== BuildResult.SUCCESS || !commit.intent) {
      return;
    }

    // Apply the build operation to voxel world
    const operation = {
      center: commit.intent.center,
      rotation: commit.intent.rotation,
      config: commit.intent.config,
    };

    const modifiedChunks = this.voxelIntegration.world.applyBuildOperation(operation);

    // Collision rebuild is deferred to onChunkRemeshed (when worker provides new geometry)
    // so the BVH always matches the actual mesh.
    if (modifiedChunks.length > 0) {
      // Update map tiles for modified chunks
      this.updateMapTilesFromChunks(modifiedChunks);
    }
  };

  /**
   * Update map tiles from modified chunks.
   * Uses the shared updateTileFromChunk function.
   */
  private updateMapTilesFromChunks(chunkKeys: string[]): void {
    const cache = getMapTileCache();
    const world = this.voxelIntegration.world;

    // Group chunks by tile (tx, tz) since multiple Y-level chunks affect same tile
    const tileUpdates = new Map<string, string[]>();
    
    for (const key of chunkKeys) {
      const chunk = world.chunks.get(key);
      if (!chunk) continue;
      
      const tileKey = `${chunk.cx},${chunk.cz}`;
      if (!tileUpdates.has(tileKey)) {
        tileUpdates.set(tileKey, []);
      }
      tileUpdates.get(tileKey)!.push(key);
    }

    // Update each affected tile
    for (const [tileKey, chunkKeysForTile] of tileUpdates) {
      const [txStr, tzStr] = tileKey.split(',');
      const tx = parseInt(txStr, 10);
      const tz = parseInt(tzStr, 10);
      
      // Get or create tile in cache
      let tile = cache.get(tx, tz);
      if (!tile) {
        tile = createMapTile(tx, tz);
        cache.set(tx, tz, tile);
      }
      
      // Update tile from each chunk in this column
      for (const chunkKey of chunkKeysForTile) {
        const chunk = world.chunks.get(chunkKey);
        if (chunk) {
          updateTileFromChunk(tile, chunk);
        }
      }

      // Recompute hash after all chunk updates for this tile
      updateTileHash(tile);
    }
  }

  /**
   * Handle chunk data from server - apply to voxel world
   */
  private handleChunkData = (chunkData: VoxelChunkData): void => {
    if (!this.voxelIntegration) return;
    
    // Apply chunk data to voxel world
    this.voxelIntegration.world.receiveChunkData(chunkData);
  };

  /**
   * Handle map tile data from server - route through VoxelWorld for column tracking
   */
  private handleMapTileData = (tileData: MapTileResponse): void => {
    if (!this.voxelIntegration) return;
    this.voxelIntegration.world.receiveTileData(tileData);
  };

  /**
   * Handle surface column data from server - contains tile + chunks
   */
  private handleSurfaceColumnData = (columnData: SurfaceColumnResponse): void => {
    if (!this.voxelIntegration) return;
    this.voxelIntegration.world.receiveSurfaceColumnData(columnData);
  };

  /**
   * Main update loop callback - called by GameLoop
   */
  private update = (deltaMs: number, elapsedTime: number): void => {
    perfStats.begin('gameUpdate');

    const gameMode = storeBridge.gameMode;
    const camera = getCamera();
    const localPlayer = this.playerManager.getLocalPlayer();

    // Check for game mode transitions
    this.handleGameModeTransition(gameMode, localPlayer);

    // Sync voxel debug state from store to VoxelDebugManager
    this.updateVoxelDebug();

    // Update based on current game mode
    switch (gameMode) {
      case GameMode.MainMenu:
      case GameMode.Spectating:
        this.updateSpectatorMode(camera, deltaMs, elapsedTime);
        break;

      case GameMode.Playing:
        this.updatePlayingMode(camera, localPlayer, deltaMs);
        break;
    }

    // Always update remote players (visible in all modes)
    perfStats.begin('players');
    this.playerManager.updateRemotePlayers(deltaMs);
    perfStats.end('players');

    // Update map overlay positions (all modes so spectator map shows players)
    const mapCenter = gameMode === GameMode.Playing ? localPlayer.position : this.spectatorCenter;
    storeBridge.updateMapPlayerPosition(mapCenter.x, mapCenter.z, localPlayer.yaw, this.playerManager.getLocalPlayerColor());
    storeBridge.updateMapOtherPlayers(this.playerManager.getRemotePlayerPositions());

    // Update wind animation for foliage
    updateWindTime(elapsedTime);

    // Update day-night cycle + sky + environment
    perfStats.begin('environment');
    updateDayNightCycle(deltaMs);
    updateSkyTime(elapsedTime);
    if (camera) {
      updateSkyCamera(camera);
    }
    const envState = storeBridge.environment;
    applyEnvironmentSettings(envState);
    perfStats.end('environment');

    // Update shadow camera to follow current center point
    const shadowCenter = gameMode === GameMode.Playing ? localPlayer.position : this.spectatorCenter;
    updateShadowFollow(shadowCenter);

    // Late-latch camera rotation: apply the very latest mouse input just before
    // rendering, so any mousemove events that arrived during the update phase
    // (physics, environment, shadows, etc.) are reflected this frame rather than
    // being deferred to the next one.
    if (gameMode === GameMode.Playing && camera) {
      camera.rotation.set(controls.pitch, controls.yaw, 0);
    }

    // Render with post-processing (SSAO + bloom) or fallback to direct render
    const scene = getScene();
    if (scene && camera) {
      perfStats.begin('render');
      if (isPostProcessingEnabled()) {
        renderWithPostProcessing();
      } else {
        this.renderer.render(scene, camera);
      }
      perfStats.end('render');
      perfStats.captureRendererInfo(this.renderer);
    }

    perfStats.end('gameUpdate');
    perfStats.endFrame();
  };

  /**
   * Handle game mode transitions (e.g. MainMenu → Playing)
   */
  private handleGameModeTransition(currentMode: GameMode, localPlayer: ReturnType<PlayerManager['getLocalPlayer']>): void {
    if (currentMode === this.lastGameMode) return;
    
    const previousMode = this.lastGameMode;
    this.lastGameMode = currentMode;
    
    // Leaving Playing mode - capture player position for spectator center
    if (previousMode === GameMode.Playing) {
      this.spectatorCenter.copy(localPlayer.position);
    }
    
    // Entering Playing mode - calculate proper spawn position
    if (currentMode === GameMode.Playing && !this.hasSpawnedPlayer) {
      this.spawnPlayer();
    }
  }

  /**
   * Calculate spawn position and place player.
   * Called when entering Playing mode for the first time.
   */
  private spawnPlayer(): void {
    if (!this.spawnManager) return;
    
    // Use cached spawn position from spectator mode detection
    const spawnPos = this.spawnManager.getCachedSpawnPosition();
    this.playerManager.setSpawnPosition(spawnPos);
    this.hasSpawnedPlayer = true;
    
    // Clear spawn debug visualization now that game is starting
    this.spawnManager.clearDebugVisualization();
  }

  /**
   * Sync voxel debug state from store to VoxelDebugManager
   */
  private updateVoxelDebug(): void {
    if (!this.voxelIntegration) return;

    const debugState = storeBridge.voxelDebug;
    this.voxelIntegration.debug.setState(debugState);

    // Sync wireframe mode to shared material
    setVoxelWireframe(debugState.showWireframe);

    // Update voxel stats in store
    const stats = this.voxelIntegration.getStats();
    storeBridge.updateVoxelStats({
      chunksLoaded: stats.chunksLoaded,
      meshesVisible: stats.meshesVisible,
      debugObjects: this.voxelIntegration.debug.getDebugObjectCount(),
    });
  }

  /**
   * Update for MainMenu/Spectating modes - orbiting camera
   */
  private updateSpectatorMode(
    camera: THREE.PerspectiveCamera | null,
    deltaMs: number,
    elapsedTime: number
  ): void {
    if (camera) {
      updateSpectatorCamera(camera, deltaMs, elapsedTime, this.spectatorCenter);
    }

    // Update voxel terrain centered on spectator center (preserves chunks when returning from playing)
    if (this.voxelIntegration) {
      perfStats.begin('voxelUpdate');
      this.voxelIntegration.update(this.spectatorCenter);
      perfStats.end('voxelUpdate');
    }
    
    // Update spawn detection (only needed before first spawn; after that, player
    // respawns at their last position so terrain raycast is unnecessary)
    if (this.spawnManager && !this.hasSpawnedPlayer) {
      this.spawnManager.update();
      
      // Update spawn ready state in store
      const spawnReady = this.spawnManager.isSpawnReady();
      if (spawnReady !== storeBridge.spawnReady) {
        storeBridge.setSpawnReady(spawnReady);
      }
    } else if (this.hasSpawnedPlayer && !storeBridge.spawnReady) {
      // Already spawned before — always ready to respawn
      storeBridge.setSpawnReady(true);
    }
  }

  /**
   * Update for Playing mode - FPS controls
   */
  private updatePlayingMode(
    camera: THREE.PerspectiveCamera | null,
    localPlayer: ReturnType<PlayerManager['getLocalPlayer']>,
    deltaMs: number
  ): void {
    // Update player physics and movement
    perfStats.begin('physics');
    this.playerManager.updateLocalPlayer(deltaMs);
    perfStats.end('physics');

    // Update voxel terrain around player
    if (this.voxelIntegration) {
      perfStats.begin('voxelUpdate');
      this.voxelIntegration.update(localPlayer.position);
      perfStats.end('voxelUpdate');
    }

    // Update camera and build system
    if (camera) {
      updateCameraFromPlayer(camera, localPlayer);
      perfStats.begin('buildPreview');
      this.builder.update(camera, localPlayer.position);
      perfStats.end('buildPreview');
    }

  }

  private onResize = (): void => {
    const camera = getCamera();
    if (camera) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    resizePostProcessing(window.innerWidth, window.innerHeight);
  };

  dispose(): void {
    // Stop loops
    this.gameLoop.stop();
    this.playerManager.dispose();

    // Clean up build system
    this.builder.dispose();

    // Clean up spawn manager
    if (this.spawnManager) {
      this.spawnManager.dispose();
    }

    // Clean up voxel terrain
    if (this.voxelIntegration) {
      this.voxelIntegration.dispose();
    }

    // Clean up post-processing
    disposePostProcessing();

    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    document.body.removeChild(this.renderer.domElement);
  }
}
