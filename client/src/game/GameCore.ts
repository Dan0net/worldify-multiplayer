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
import { initExploreCamera, updateExploreCamera, getExploreTarget } from './scene/ExploreCamera';
import {
  initSpawnMarker, isMarkerPlaced, placeMarkerAtColumn, setMarkerVisible,
  consumeMarkerSpawn, resetMarker,
} from './spawn/SpawnMarker';
import { initLighting, applyEnvironmentSettings, updateShadowFollow } from './scene/Lighting';
import { updateDayNightCycle } from './scene/DayNightCycle';
import { updateSkyTime, updateSkyCamera } from './scene/SkyDome';
import { initEffects, renderEffects, resizeEffects, disposeEffects } from './scene/effects';
import { useGameStore } from '../state/store';
import { setClearChunksCallback, updateMapPlayerPosition, updateMapOtherPlayers } from '../state/transient';
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
import { RoomSnapshot, GameMode, VoxelBuildCommit, VoxelChunkData, BuildResult, MapTileResponse, SurfaceColumnResponse, RequestNack, updateTileFromChunk, updateTileHash, createMapTile } from '@worldify/shared';
import { VoxelIntegration } from './voxel/VoxelIntegration';
import { setVoxelWireframe } from './voxel/VoxelMaterials';
import { GameLoop } from './GameLoop';
import { isTouch } from './deviceMode';
import { PlayerManager } from './PlayerManager';
import { Builder } from './build/Builder';
import { SpawnManager } from './spawn/SpawnManager';
import { materialManager, updateWindTime, subscribeMaterialSettings, subscribeWaterSettings } from './material';
import { getMapTileCache } from './maptile/mapTileCacheSingleton';
import { perfStats } from './debug/PerformanceStats';
import { initWorlds, setWorldSwitchHandler, loadSnapPoints, saveSnapPoints, savePlayerPos, loadPlayerPos, setPlayerPosProvider } from './world/WorldManager';

/** How often to persist the player position while Playing (ms). */
const POS_SAVE_INTERVAL_MS = 4000;
/** Lift restored spawns slightly above the saved Y to avoid clipping pre-collision. */
const RESTORE_HEIGHT_OFFSET = 0.5;

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

  // Throttle accumulator for periodic player-position saves while Playing (ms).
  private posSaveAccumMs = 0;

  // True when the active world has a persisted position — spawn is ready immediately
  // (no terrain raycast needed) and streaming is centered on that saved position.
  private hasSavedSpawn = false;

  // Store subscription for the render-scale slider
  private renderScaleUnsub: (() => void) | null = null;

  // Last voxel stats written to the store (change-gate to avoid per-frame re-renders)
  private lastVoxelStats = { chunksLoaded: -1, meshesVisible: -1, debugObjects: -1 };

  // Store subscriptions that push material/water settings to the shaders
  private materialSettingsUnsub: (() => void) | null = null;
  private waterSettingsUnsub: (() => void) | null = null;

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
    // antialias: false — pmndrs EffectComposer handles MSAA via multisampled FBOs
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    // updateStyle=false: the drawing buffer may be rendered below native (renderScale);
    // CSS keeps the canvas full-size so the browser upscales it (the fill-rate win).
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x87ceeb); // Sky blue
    
    // Enable shadow mapping
    // PCFShadowMap supports shadow.radius for soft/blurred edges
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    
    // Enable tone mapping for better HDR handling
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // Add canvas to DOM
    const canvas = this.renderer.domElement;
    canvas.id = 'game-canvas';
    // Display size is governed by CSS (#game-canvas: 100%/100%); the drawing buffer
    // is set separately so renderScale can shrink it without shrinking the canvas.
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    document.body.appendChild(canvas);

    // Initialize scene, camera, lighting
    createScene();
    createCamera();
    
    // Initialize static lighting system (matches MaterialPreview)
    initLighting(this.renderer);
    
    // Apply initial environment settings from store
    const initialEnv = useGameStore.getState().environment;
    applyEnvironmentSettings(initialEnv);

    // Initialize pmndrs post-processing pipeline (empty — render pass only for now)
    const scene = getScene();
    const camera = getCamera();
    if (scene && camera) {
      initEffects(this.renderer, scene, camera);
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
    // Store the level so UI can read it. Mobile defaults to a near view
    // distance (4 chunks) unless the user has saved a preference.
    const effectiveVisibility = savedVisibility
      ?? (isTouch() ? 2 : QUALITY_PRESETS[qualityLevel].visibilityRadius);

    // Restore the last-played local world (or auto-create the first one) before
    // the terrain system starts, so it generates with the active world's seed
    // and its persisted chunks.
    await initWorlds();

    // Center the background orbit camera + chunk streaming on the persisted player
    // position, so the world loads AROUND where the player left off (not the origin).
    const savedPose = loadPlayerPos();
    this.hasSavedSpawn = savedPose !== null;
    if (savedPose) this.spectatorCenter.set(savedPose.x, savedPose.y, savedPose.z);

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
      
      // Initialize spawn manager + the explore-mode spawn marker gizmo
      this.spawnManager = new SpawnManager(scene);
      this.spawnManager.setTerrainProvider(this.voxelIntegration);
      initSpawnMarker(scene, this.voxelIntegration);
      
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

      // Offline builds apply locally; refresh map tiles like the server-commit path does.
      this.builder.onBuildApplied = (modifiedChunks) => {
        if (modifiedChunks.length > 0) {
          this.updateMapTilesFromChunks(modifiedChunks);
        }
      };

      // Register chunk clearing callback for F9 debug
      setClearChunksCallback(() => {
        const playerPos = this.playerManager.getLocalPlayer().position.clone();
        this.voxelIntegration.clearAndReload(playerPos);
      });

      // Snap-point persistence: restore this world's points, save on change.
      const snap = this.builder.getSnapManager();
      loadSnapPoints().then((pts) => snap.setDepositedPoints(pts));
      snap.onDepositedChanged = () => saveSnapPoints(snap.getDepositedPoints());

      // Rebuild terrain + snap points when the active world changes (world picker).
      setWorldSwitchHandler(() => this.switchLocalWorld());

      // Supply the current pose so WorldManager can save the OUTGOING world on switch.
      setPlayerPosProvider(() => this.currentPlayerPose());

      // Undo last build (Ctrl/Cmd+Z or mobile button).
      controls.onUndo = () => {
        const keys = this.voxelIntegration.world.undoLastBuild();
        if (keys.length > 0) this.updateMapTilesFromChunks(keys);
      };
    }

    // Request pointer lock on canvas click (only when playing)
    canvas.addEventListener('click', () => {
      if (useGameStore.getState().gameMode === GameMode.Playing) {
        controls.requestPointerLock();
      }
    });

    // Register for network events
    on('snapshot', this.handleSnapshot);
    on('buildCommit', this.handleBuildCommit);
    on('chunkData', this.handleChunkData);
    on('mapTileData', this.handleMapTileData);
    on('surfaceColumnData', this.handleSurfaceColumnData);
    on('requestNack', this.handleRequestNack);

    // Handle resize
    window.addEventListener('resize', this.onResize);

    // Persist the player position when the tab is hidden/closed (mobile-safe).
    window.addEventListener('pagehide', this.savePlayerPosNow);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    // Re-apply the drawing-buffer size whenever the render-scale slider changes.
    this.renderScaleUnsub = useGameStore.subscribe((state, prev) => {
      if (state.renderScale !== prev.renderScale) this.onResize();
    });

    // Push material/water setting changes to the shaders (replaces the old
    // bridge setters' side effects).
    this.materialSettingsUnsub = subscribeMaterialSettings();
    this.waterSettingsUnsub = subscribeWaterSettings();

    // Start game loop and input loop
    this.gameLoop.start(this.update);
    this.playerManager.startInputLoop();
  }

  /**
   * Rebuild the local world after the active world changed (world picker).
   * Clears terrain + map tiles, regenerates with the new seed, and restores the
   * new world's snap points. Re-gates spawn so Play waits for terrain.
   */
  private switchLocalWorld(): void {
    useGameStore.getState().setSpawnReady(false);
    this.hasSpawnedPlayer = false;
    this.posSaveAccumMs = 0;
    resetMarker(); // re-auto-place the spawn marker for the new world
    getMapTileCache().clear();

    // Re-center the orbit camera + chunk streaming on the NEW world's saved position
    // (WorldManager.activate has already loaded it). With no saved position, center on
    // the origin — that's where SpawnManager probes for ground, so spawn resolves.
    const savedPose = loadPlayerPos();
    this.hasSavedSpawn = savedPose !== null;
    const streamCenter = savedPose
      ? new THREE.Vector3(savedPose.x, savedPose.y, savedPose.z)
      : new THREE.Vector3(0, 0, 0);
    this.spectatorCenter.copy(streamCenter);
    this.voxelIntegration.world.reloadLocalWorld(streamCenter);
    // setDepositedPoints replaces the points without firing the save callback,
    // so restoring the new world's snaps doesn't overwrite them.
    const snap = this.builder.getSnapManager();
    loadSnapPoints().then((pts) => snap.setDepositedPoints(pts));
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
    
    // Reset game mode to Explore so player sees the home screen
    useGameStore.getState().setGameMode(GameMode.Explore);
    
    // Reset spawn state so terrain detection starts fresh
    if (this.spawnManager) {
      this.spawnManager.reset();
    }
    useGameStore.getState().setSpawnReady(false);
    
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
   * Handle request NACK from server - clear pending entry so it can be re-requested
   */
  private handleRequestNack = (nack: RequestNack): void => {
    if (!this.voxelIntegration) return;
    this.voxelIntegration.world.handleRequestNack(nack);
  };

  /**
   * Main update loop callback - called by GameLoop
   */
  private update = (deltaMs: number, elapsedTime: number): void => {
    perfStats.begin('gameUpdate');

    const gameMode = useGameStore.getState().gameMode;
    const camera = getCamera();
    const localPlayer = this.playerManager.getLocalPlayer();

    // Check for game mode transitions
    this.handleGameModeTransition(gameMode, localPlayer);

    // Sync voxel debug state from store to VoxelDebugManager
    this.updateVoxelDebug();

    // Update based on current game mode
    switch (gameMode) {
      case GameMode.Explore:
        this.updateExploreMode(camera);
        break;

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
    updateMapPlayerPosition(mapCenter.x, mapCenter.z, localPlayer.yaw, this.playerManager.getLocalPlayerColor());
    updateMapOtherPlayers(this.playerManager.getRemotePlayerPositions());

    // Update wind animation for foliage
    updateWindTime(elapsedTime);

    // Update day-night cycle + sky. updateDayNightCycle applies the derived
    // sun/moon/hemisphere values directly to the lights + sky each frame — the
    // store is no longer round-tripped per frame (manual env edits apply
    // themselves on-change via the debug panel / subscriptions).
    perfStats.begin('environment');
    updateDayNightCycle(deltaMs);
    updateSkyTime(elapsedTime);
    if (camera) {
      updateSkyCamera(camera);
    }
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

    // Render through effects pipeline
    const scene = getScene();
    if (scene && camera) {
      perfStats.begin('render');
      renderEffects(this.renderer, scene, camera, deltaMs * 0.001);
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
    
    // Leaving Playing mode - capture player position for spectator center + persist it
    if (previousMode === GameMode.Playing) {
      this.spectatorCenter.copy(localPlayer.position);
      this.savePlayerPosNow();
    }

    // Entering Explore (boot or pause) - seed the free camera on the current center and
    // re-place the spawn marker there (updateExploreMode auto-places once terrain is
    // ready), so pausing drops the marker where you are and tapping Play resumes.
    if (currentMode === GameMode.Explore) {
      initExploreCamera(this.spectatorCenter);
      resetMarker();
    } else {
      setMarkerVisible(false); // hide the spawn gizmo outside explore
    }

    // Entering Playing mode - spawn at the chosen marker if the Play button armed one
    // (works even for a re-play after pausing); otherwise the first-time spawn logic.
    if (currentMode === GameMode.Playing) {
      const markerSpawn = consumeMarkerSpawn();
      if (markerSpawn) {
        this.playerManager.setSpawnPosition(markerSpawn);
        controls.pitch = 0; // level look on a fresh marker spawn
        this.hasSpawnedPlayer = true;
        this.spawnManager?.clearDebugVisualization();
      } else if (!this.hasSpawnedPlayer) {
        this.spawnPlayer();
      }
    }
  }

  /**
   * Calculate spawn position and place player.
   * Called when entering Playing mode for the first time.
   */
  private spawnPlayer(): void {
    if (!this.spawnManager) return;

    // Prefer the world's persisted position; fall back to terrain-raycast spawn for a
    // fresh world. Lift slightly above the saved Y so the player doesn't clip in before
    // the chunk under them has meshed + built a collider.
    const saved = loadPlayerPos();
    if (saved) {
      this.playerManager.setSpawnPosition(new THREE.Vector3(saved.x, saved.y + RESTORE_HEIGHT_OFFSET, saved.z));
      controls.yaw = saved.yaw;
      controls.pitch = saved.pitch;
    } else {
      this.playerManager.setSpawnPosition(this.spawnManager.getCachedSpawnPosition());
    }
    this.hasSpawnedPlayer = true;

    // Clear spawn debug visualization now that game is starting
    this.spawnManager.clearDebugVisualization();
  }

  /** Current player pose (position + look) for persistence. */
  private currentPlayerPose(): { x: number; y: number; z: number; yaw: number; pitch: number } {
    const p = this.playerManager.getLocalPlayer().position;
    return { x: p.x, y: p.y, z: p.z, yaw: controls.yaw, pitch: controls.pitch };
  }

  /** Save the player's position now, if they've spawned (position is meaningful). */
  private savePlayerPosNow = (): void => {
    if (this.hasSpawnedPlayer) savePlayerPos(this.currentPlayerPose());
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.savePlayerPosNow();
  };

  /**
   * Sync voxel debug state from store to VoxelDebugManager
   */
  private updateVoxelDebug(): void {
    if (!this.voxelIntegration) return;

    const debugState = useGameStore.getState().voxelDebug;
    this.voxelIntegration.debug.setState(debugState);

    // Sync wireframe mode to shared material
    setVoxelWireframe(debugState.showWireframe);

    // Sync seam-normal stitching toggle (default on)
    this.voxelIntegration.world.seamStitcher.enabled = debugState.stitchSeams ?? true;

    // Update voxel stats in store — but only when a value actually changed. This
    // write happens every frame; a bare `setVoxelStats` allocates a new object each
    // time and re-renders every store subscriber, so gate it on change.
    const stats = this.voxelIntegration.getStats();
    const debugObjects = this.voxelIntegration.debug.getDebugObjectCount();
    const last = this.lastVoxelStats;
    if (
      stats.chunksLoaded !== last.chunksLoaded ||
      stats.meshesVisible !== last.meshesVisible ||
      debugObjects !== last.debugObjects
    ) {
      last.chunksLoaded = stats.chunksLoaded;
      last.meshesVisible = stats.meshesVisible;
      last.debugObjects = debugObjects;
      useGameStore.getState().setVoxelStats({
        chunksLoaded: stats.chunksLoaded,
        meshesVisible: stats.meshesVisible,
        debugObjects,
      });
    }
  }

  /**
   * Update for Explore mode — user-driven free 3rd-person camera over the world.
   */
  private updateExploreMode(camera: THREE.PerspectiveCamera | null): void {
    if (camera) updateExploreCamera(camera);

    // The explore target is the world stream/shadow center; keep spectatorCenter in
    // sync so streaming, shadows, and the map follow where the user pans.
    this.spectatorCenter.copy(getExploreTarget());

    if (this.voxelIntegration) {
      perfStats.begin('voxelUpdate');
      this.voxelIntegration.update(this.spectatorCenter);
      perfStats.end('voxelUpdate');
    }

    // Auto-place the spawn marker at the current center (last/saved position) once its
    // terrain is streamed, so a Play button is available immediately. The user can then
    // tap elsewhere to relocate it. Retry each frame until it lands.
    setMarkerVisible(true);
    if (!isMarkerPlaced()) {
      placeMarkerAtColumn(this.spectatorCenter.x, this.spectatorCenter.z);
    }
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
      if (this.hasSavedSpawn) {
        // A persisted position is an absolute spawn — ready without a terrain raycast
        // (which probes the origin and would never resolve for a far-away saved world).
        if (!useGameStore.getState().spawnReady) useGameStore.getState().setSpawnReady(true);
      } else {
        this.spawnManager.update();
        // Update spawn ready state in store
        const spawnReady = this.spawnManager.isSpawnReady();
        if (spawnReady !== useGameStore.getState().spawnReady) {
          useGameStore.getState().setSpawnReady(spawnReady);
        }
      }
    } else if (this.hasSpawnedPlayer && !useGameStore.getState().spawnReady) {
      // Already spawned before — always ready to respawn
      useGameStore.getState().setSpawnReady(true);
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
    // The build menu soft-pauses play: freeze the player + build preview while it's
    // open (it takes over the whole window), but keep streaming + rendering so the
    // world stays live behind the translucent overlay and thumbnails keep rendering.
    const menuPaused = useGameStore.getState().build.menuOpen;

    // Update player physics and movement
    perfStats.begin('physics');
    if (!menuPaused) this.playerManager.updateLocalPlayer(deltaMs);
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
      if (!menuPaused) {
        perfStats.begin('buildPreview');
        this.builder.update(camera, localPlayer.position);
        perfStats.end('buildPreview');
      }
    }

    // Periodically persist position so an unexpected close still resumes near here.
    this.posSaveAccumMs += deltaMs;
    if (this.posSaveAccumMs >= POS_SAVE_INTERVAL_MS) {
      this.posSaveAccumMs = 0;
      savePlayerPos(this.currentPlayerPose());
    }
  }

  private onResize = (): void => {
    const camera = getCamera();
    if (camera) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
    // renderScale shrinks the drawing buffer below the display size (fill-rate lever).
    const scale = useGameStore.getState().renderScale;
    const w = Math.max(1, Math.round(window.innerWidth * scale));
    const h = Math.max(1, Math.round(window.innerHeight * scale));
    this.renderer.setSize(w, h, false); // updateStyle=false — keep CSS display size
    resizeEffects(w, h);
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

    // Clean up effects pipeline
    disposeEffects();

    this.savePlayerPosNow();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pagehide', this.savePlayerPosNow);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.renderScaleUnsub) { this.renderScaleUnsub(); this.renderScaleUnsub = null; }
    if (this.materialSettingsUnsub) { this.materialSettingsUnsub(); this.materialSettingsUnsub = null; }
    if (this.waterSettingsUnsub) { this.waterSettingsUnsub(); this.waterSettingsUnsub = null; }
    this.renderer.dispose();
    document.body.removeChild(this.renderer.domElement);
  }
}
