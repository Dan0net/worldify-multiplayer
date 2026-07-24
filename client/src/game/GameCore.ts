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
import { initFirstPersonArm, updateFirstPersonArm, startFirstPersonArmExit, tickFirstPersonArmExit, renderFirstPersonArm } from './scene/FirstPersonArm';
import {
  initExploreCamera, updateExploreCamera, getExploreTarget,
  advanceExploreTargetGlide, isExploreGliding, isExploreMarkerInteracting,
  getExploreZoomLevel, getExploreZoomScale, resetCameraClipPlanes,
} from './scene/ExploreCamera';
import {
  initSpawnMarker, isMarkerPlaced, placeMarkerAtColumn, setMarkerVisible,
  getMarkerBase, consumeMarkerSpawn, resetMarker, setSpawnLodScale,
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
  loadSavedFarViewRings,
  detectQualityLevel,
} from './quality/QualityPresets';
import { setRendererRef, setVisibilityRadiusCallback, setFarViewRingsCallback, syncQualityToStore } from './quality/QualityManager';
import { controls } from './player/controls';
import { on } from '../net/decode';
import { RoomSnapshot, GameMode, VoxelBuildCommit, VoxelChunkData, BuildResult, MapTileResponse, SurfaceColumnResponse, RequestNack, updateTileFromChunk, updateTileHash, createMapTile, CHUNK_SIZE, VOXEL_SCALE } from '@worldify/shared';

/** Chebyshev radius (in map tiles = 8 m each) of map tiles kept around the player; farther explored
 *  tiles are evicted so the cache doesn't grow forever. ~48 tiles ≈ 384 m, ~28 MB worst case. */
const MAP_TILE_KEEP_RADIUS = 48;
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
import { initWorlds, setWorldSwitchHandler, loadSnapPoints, saveSnapPoints, savePlayerPos, loadPlayerPos, setPlayerPosProvider, saveTimeOfDay, loadTimeOfDay, setTimeOfDayProvider } from './world/WorldManager';

/** How often to persist the player position while Playing (ms). */
const POS_SAVE_INTERVAL_MS = 4000;
/** Lift restored spawns slightly above the saved Y to avoid clipping pre-collision. */
const RESTORE_HEIGHT_OFFSET = 0.5;

/** Cubic ease-in-out (0→1) for the explore↔first-person camera glides. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

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
  // Last tile the map cache was pruned around; prune only when the player crosses into a new tile so
  // explored map tiles don't accumulate without bound (see MapTileCache.prune).
  private mapPruneTx = NaN;
  private mapPruneTz = NaN;
  /** Explore stream centre in level-LOCAL space (true target ÷ 2^level) fed to the voxel world, which
   *  runs its streaming/BFS in 8 m chunk units while the grouper root scales geometry to true world. */
  private _lodScaledCenter = new THREE.Vector3();

  // Last (x,z) the explore center-follow placed the spawn marker at, so it only re-raycasts
  // when the camera target actually moved (NaN = force placement on the next frame).
  private lastFollowX = NaN;
  private lastFollowZ = NaN;

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
    // DPI cap (the device-pixel lever). `renderScale` separately scales the sub-native
    // buffer; there is no per-preset maxPixelRatio anymore.
    const MAX_DEVICE_PIXEL_RATIO = 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO));
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
      // The first-person arm renders with its own ortho camera (added to the scene).
      initFirstPersonArm(scene);
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

    // Restore this world's persisted time-of-day (falls back to the default cycle time).
    const savedTod = loadTimeOfDay();
    if (savedTod !== null) useGameStore.getState().setTimeOfDay(savedTod);

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
      // Wire the Explore far-view (coarse ring count) callback.
      setFarViewRingsCallback((rings: number) => {
        this.voxelIntegration.world.setFarViewRings(rings);
      });
      // Apply the quality preset (including visibility radius + far-view rings) and sync to store.
      syncQualityToStore(qualityLevel, effectiveVisibility, loadSavedFarViewRings() ?? undefined);
      
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

      // As real chunks stream in, refresh their map tiles so procedurally-placed
      // trees/rocks/buildings appear on the minimap (the baseline tile is stamp-free).
      this.voxelIntegration.world.onChunkIngested = (key) => {
        this.pendingMapChunks.add(key);
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

      // Supply the current time-of-day so it's saved per world on switch.
      setTimeOfDayProvider(() => useGameStore.getState().environment.timeOfDay);

      // Undo last build (Z, or mobile button).
      controls.onUndo = () => {
        const keys = this.voxelIntegration.world.undoLastBuild();
        if (keys.length > 0) {
          // Mirror the place path: hand the active preview off as a commit so the reverted
          // chunk's remesh clears the stale preview mesh + restores the suppressed group.
          this.builder.commitPreview();
          this.updateMapTilesFromChunks(keys);
        }
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
    // Clear the cached surface spawn so the new world computes a FRESH one on its own terrain —
    // otherwise the previous world's spawn point can leak in until collision meshes rebuild.
    this.spawnManager?.reset();

    // Re-center the orbit camera + chunk streaming on the NEW world's saved position
    // (WorldManager.activate has already loaded it). With no saved position, center on
    // the origin — that's where SpawnManager probes for ground, so spawn resolves.
    const savedPose = loadPlayerPos();
    this.hasSavedSpawn = savedPose !== null;
    this.spawnManager?.setSpawnTarget(0, 0);
    const streamCenter = savedPose
      ? new THREE.Vector3(savedPose.x, savedPose.y, savedPose.z)
      : new THREE.Vector3(0, 0, 0);
    this.spectatorCenter.copy(streamCenter);
    // Reset the explore orbit camera onto the new world's center. Without this the module-
    // level target keeps the PREVIOUS world's location/Y (switchLocalWorld runs while in
    // explore, which never re-seeds it), so a fresh world would open framed underground.
    // The per-frame center-follow then lifts the target onto this world's surface once it
    // streams in.
    initExploreCamera(streamCenter);
    this.lastFollowX = NaN;
    this.lastFollowZ = NaN;
    // Restore the new world's persisted time-of-day (WorldManager.activate loaded it).
    const savedTod = loadTimeOfDay();
    if (savedTod !== null) useGameStore.getState().setTimeOfDay(savedTod);
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

    // Apply the build operation to voxel world (parts are the geometry)
    const operation = {
      center: commit.intent.center,
      rotation: commit.intent.rotation,
      parts: commit.intent.parts,
    };

    const modifiedChunks = this.voxelIntegration.world.applyBuildOperation(operation);

    // Collision rebuild is deferred to onChunkRemeshed (when worker provides new geometry)
    // so the BVH always matches the actual mesh.
    if (modifiedChunks.length > 0) {
      // Update map tiles for modified chunks
      this.updateMapTilesFromChunks(modifiedChunks);
    }
  };

  /** Chunk keys streamed in but not yet folded into the minimap (bounded flush). */
  private pendingMapChunks = new Set<string>();

  /** Accumulating phase for the camera head-bob while walking. */
  private headBobPhase = 0;

  /** Brief camera glide from the explore view to the first-person pose on entering Playing. */
  private cameraIntroMs = 0; // enter (explore→FP) glide remaining (ms); 0 = inactive
  private cameraIntroFromPos = new THREE.Vector3();
  private cameraIntroFromQuat = new THREE.Quaternion();
  private cameraOutroMs = 0; // exit (FP→explore) glide remaining (ms); 0 = inactive
  private cameraOutroFromPos = new THREE.Vector3();
  private cameraOutroFromQuat = new THREE.Quaternion();
  private introTmpPos = new THREE.Vector3();
  private introTmpQuat = new THREE.Quaternion();
  private static readonly CAMERA_INTRO_DURATION_MS = 1350;
  // Play-from-Explore intro is GATED on level-0 terrain readiness: after clicking Play (which drops the
  // world to LOD level 0), the camera is held at the captured explore pose while the full-detail chunks
  // stream in under the marker; the intro glide to first-person only starts once enough are meshed (or a
  // safety timeout), so you never drop into FP onto blocky/unloaded ground.
  private pendingPlayIntro = false;
  private playIntroWaitMs = 0;
  private static readonly PLAY_INTRO_MAX_WAIT_MS = 5000;
  private static readonly PLAY_INTRO_MESH_READY = 6;
  // Time constant (ms) for easing the explore orbit height onto the surface, so the camera
  // doesn't judder as terrain height steps between columns / streams in during a pan.
  private static readonly EXPLORE_Y_SMOOTH_MS = 140;

  /**
   * Fold a bounded batch of freshly-streamed chunks into the minimap each frame.
   * Capped so a burst of streaming can't spike a frame; the rest carry to the
   * next frame. Grouping by tile happens in updateMapTilesFromChunks.
   */
  private flushMapTilesFromStreamedChunks(): void {
    if (this.pendingMapChunks.size === 0) return;
    const MAX_PER_FRAME = 24;
    const batch: string[] = [];
    for (const key of this.pendingMapChunks) {
      batch.push(key);
      this.pendingMapChunks.delete(key);
      if (batch.length >= MAX_PER_FRAME) break;
    }
    this.updateMapTilesFromChunks(batch);
  }

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
        this.updateExploreMode(camera, deltaMs);
        break;

      case GameMode.MainMenu:
      case GameMode.Spectating:
        this.updateSpectatorMode(camera, deltaMs, elapsedTime);
        break;

      case GameMode.Playing:
        this.updatePlayingMode(camera, localPlayer, deltaMs);
        break;
    }

    // Outside Playing, drive the arm's slide-down exit (or keep it hidden). updatePlayingMode
    // drives it while playing.
    if (gameMode !== GameMode.Playing) tickFirstPersonArmExit(deltaMs);

    // Refresh minimap tiles from freshly-streamed chunks (bounded per frame).
    this.flushMapTilesFromStreamedChunks();

    // Always update remote players (visible in all modes)
    perfStats.begin('players');
    this.playerManager.updateRemotePlayers(deltaMs);
    perfStats.end('players');

    // Update map overlay positions (all modes so spectator map shows players)
    const mapCenter = gameMode === GameMode.Playing ? localPlayer.position : this.spectatorCenter;
    updateMapPlayerPosition(mapCenter.x, mapCenter.z, localPlayer.yaw, this.playerManager.getLocalPlayerColor());
    updateMapOtherPlayers(this.playerManager.getRemotePlayerPositions());

    // Bound the map-tile cache: when the player crosses into a new tile, evict tiles far from them so
    // exploring a large world doesn't grow the (otherwise never-evicted) cache without bound.
    const tileMeters = CHUNK_SIZE * VOXEL_SCALE;
    const ctx = Math.floor(mapCenter.x / tileMeters), ctz = Math.floor(mapCenter.z / tileMeters);
    if (ctx !== this.mapPruneTx || ctz !== this.mapPruneTz) {
      this.mapPruneTx = ctx; this.mapPruneTz = ctz;
      getMapTileCache().prune(ctx, ctz, MAP_TILE_KEEP_RADIUS);
    }

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
    // (Suppressed during the intro glide, which owns the camera orientation.)
    if (gameMode === GameMode.Playing && camera && this.cameraIntroMs === 0 && !this.pendingPlayIntro) {
      camera.rotation.set(controls.pitch, controls.yaw, 0);
    }

    // Render through effects pipeline
    const scene = getScene();
    if (scene && camera) {
      perfStats.begin('render');
      renderEffects(this.renderer, scene, camera, deltaMs * 0.001);
      // Draw the first-person arm on top (own ortho camera + layers, cleared depth)
      // so it's never occluded by water/geometry but still lit by the scene lights.
      renderFirstPersonArm(this.renderer, scene);
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
      this.pendingPlayIntro = false; // cancel a not-yet-started play intro if we bailed out early
    }

    // Entering Explore (boot or pause) - seed the free camera on the current center and
    // re-place the spawn marker there (updateExploreMode auto-places once terrain is
    // ready), so pausing drops the marker where you are and tapping Play resumes.
    if (currentMode === GameMode.Explore) {
      // Smooth camera-out: glide from the current first-person pose to the explore view.
      if (previousMode === GameMode.Playing) {
        const cam = getCamera();
        if (cam) {
          this.cameraOutroFromPos.copy(cam.position);
          this.cameraOutroFromQuat.copy(cam.quaternion);
          this.cameraOutroMs = GameCore.CAMERA_INTRO_DURATION_MS;
          this.cameraIntroMs = 0; // cancel any in-flight enter glide
        }
      }
      initExploreCamera(this.spectatorCenter);
      resetMarker();
      // Leaving play — slide the arm out and re-arm the reveal (hotbar + pills slide out via
      // firstPersonReady flipping false). The explore UI slides back in only once the outro glide
      // completes (exploreReady set below); a non-play entry (boot) has no outro, so show it now.
      if (previousMode === GameMode.Playing) startFirstPersonArmExit();
      else useGameStore.getState().setExploreReady(true);
      useGameStore.getState().setFirstPersonReady(false);
    } else {
      setMarkerVisible(false); // hide the spawn gizmo outside explore
    }

    // Entering Playing mode - spawn at the chosen marker if the Play button armed one
    // (works even for a re-play after pausing); otherwise the first-time spawn logic.
    if (currentMode === GameMode.Playing) {
      useGameStore.getState().setExploreReady(false); // explore UI animates out
      // Play is always full detail: drop back to LOD level 0 (scale 1) and the diamond visibility
      // volume. If the user hit Play while zoomed out, the coarse view is held (frozen) while the
      // level-0 chunks stream in under the camera-intro tween.
      this.voxelIntegration?.setCubeVisibility(false);
      this.voxelIntegration?.setExploreLevel(0);
      // Restore the base near/far clip planes (explore may have widened them for a coarse LOD).
      const playCam = getCamera();
      if (playCam) resetCameraClipPlanes(playCam);
      const markerSpawn = consumeMarkerSpawn();
      if (markerSpawn) {
        this.playerManager.setSpawnPosition(markerSpawn);
        controls.pitch = 0; // level look on a fresh marker spawn
        this.hasSpawnedPlayer = true;
        this.spawnManager?.clearDebugVisualization();
      } else if (!this.hasSpawnedPlayer) {
        this.spawnPlayer();
      }

      // Capture the current (zoomed-wherever) explore camera pose. Rather than starting the glide
      // immediately, enter the PENDING state: hold this pose while LOD level 0 streams in under the
      // marker (setExploreLevel(0) above kicked that off, holding the coarse view meanwhile), then the
      // glide to first-person fires once the ground is ready (updatePlayingMode). This is the "zoom in,
      // load, then transition" of the plan. No glide when re-entering from a non-Explore mode.
      if (previousMode === GameMode.Explore) {
        const cam = getCamera();
        if (cam) {
          this.cameraIntroFromPos.copy(cam.position);
          this.cameraIntroFromQuat.copy(cam.quaternion);
          this.cameraIntroMs = 0;
          this.pendingPlayIntro = true;
          this.playIntroWaitMs = 0;
        }
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
    // Time-of-day advances in every mode, so persist it regardless of spawn state.
    saveTimeOfDay(useGameStore.getState().environment.timeOfDay);
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
  private updateExploreMode(camera: THREE.PerspectiveCamera | null, deltaMs: number): void {
    // Advance any in-progress recenter glide (eases the orbit target toward a moved spawn),
    // then run "center-follow": pin the spawn marker to the surface directly under screen
    // center (the orbit target) and sit the target on that surface, so the spawn stays
    // centered as the user pans. Suspended while the user grabs the marker or a glide is
    // animating (so those interactions aren't overridden). Retries each frame until the
    // center column's terrain has streamed — which also lifts a fresh world onto its surface.
    advanceExploreTargetGlide(deltaMs);
    setMarkerVisible(true);
    // Tell the marker the current LOD scale BEFORE any raycast this frame (center-follow below and taps
    // between frames): the raycast target meshes are level-local, so the marker transforms true-world
    // queries by this scale to hit the coarse terrain. Must precede placeMarkerAtColumn.
    // Use the DISPLAYED terrain level (the meshes actually on screen), not the camera's target — during a
    // multi-level LOD walk they differ, and the marker raycasts the live meshes at their current scale.
    setSpawnLodScale(this.voxelIntegration ? (1 << this.voxelIntegration.lodLevel) : getExploreZoomScale());
    const target = getExploreTarget();
    // Surface-follow: keep the spawn marker under screen centre as the user pans — at ALL zoom levels
    // (coarse terrain renders at its true world height, so the top-down column raycast still resolves
    // the surface). The camera-height ease is kept to level 0 only, since at coarse zoom the far camera
    // over blocky/streaming terrain would judder if its height chased the surface.
    if (!isExploreMarkerInteracting() && !isExploreGliding()) {
      const moved = target.x !== this.lastFollowX || target.z !== this.lastFollowZ;
      if ((moved || !isMarkerPlaced()) && placeMarkerAtColumn(target.x, target.z)) {
        this.lastFollowX = target.x;
        this.lastFollowZ = target.z;
      }
      // Ease the orbit height onto the marker's surface (level 0 only — see above). Runs every frame
      // (not gated on x/z movement) so it keeps settling after a pan stops and gives a smooth one-time
      // rise onto the surface when a world opens.
      if (getExploreZoomLevel() === 0 && isMarkerPlaced()) {
        const k = 1 - Math.exp(-deltaMs / GameCore.EXPLORE_Y_SMOOTH_MS);
        target.y += (getMarkerBase().y - target.y) * k;
      }
    }

    if (camera) updateExploreCamera(camera);

    // Brief first-person→explore glide on exiting play: blend from the captured FP pose
    // toward the explore pose (which updateExploreCamera just wrote into the camera).
    if (camera && this.cameraOutroMs > 0) {
      this.cameraOutroMs = Math.max(0, this.cameraOutroMs - deltaMs);
      const t = 1 - this.cameraOutroMs / GameCore.CAMERA_INTRO_DURATION_MS;
      const eased = easeInOut(t);
      this.introTmpPos.copy(camera.position);
      this.introTmpQuat.copy(camera.quaternion);
      camera.position.copy(this.cameraOutroFromPos).lerp(this.introTmpPos, eased);
      camera.quaternion.copy(this.cameraOutroFromQuat).slerp(this.introTmpQuat, eased);
      // Outro finished → let the explore UI (world/settings/panel) animate back in.
      if (this.cameraOutroMs === 0) useGameStore.getState().setExploreReady(true);
    }

    // The explore target is the world stream/shadow center; keep spectatorCenter in sync
    // (with the surface-corrected Y from center-follow above) so streaming, shadows, the
    // map, and the visibility BFS follow where the user pans/spawns.
    this.spectatorCenter.copy(target);

    if (this.voxelIntegration) {
      // LOD zoom: the voxel world streams in level-LOCAL 8 m chunk units and the grouper root scales
      // geometry to true world by 2^level. Feed it the target ÷ scale; a level change (settled on the
      // wheel) triggers hold-then-swap. Explore uses the cube (square) visibility volume.
      const targetLevel = getExploreZoomLevel();
      this.voxelIntegration.setCubeVisibility(true);
      // Step the terrain LOD ONE level at a time toward the camera's target, and only once the previous
      // swap has fully retired. A fast multi-level flick (e.g. 6→0) thus loads each intermediate level in
      // turn — a cheap 2× refinement per step — instead of collapsing to one all-or-nothing swap of huge
      // coarse chunks that strands the view on the larger zoom level until the entire fine level streams.
      let level = this.voxelIntegration.lodLevel;
      if (level !== targetLevel && !this.voxelIntegration.retireActive) {
        level += targetLevel > level ? 1 : -1;
        this.voxelIntegration.setExploreLevel(level);
      }
      // Scale the stream centre by the DISPLAYED level (the grouper root's actual scale), not the camera's
      // target — during a multi-level walk the two differ, and the centre must match the level being streamed.
      const scale = 1 << level;
      this._lodScaledCenter.copy(target).multiplyScalar(1 / scale);
      perfStats.begin('voxelUpdate');
      this.voxelIntegration.update(this._lodScaledCenter);
      perfStats.end('voxelUpdate');
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
      if (this.pendingPlayIntro) {
        // Hold the captured explore pose while full-detail (level 0) terrain streams in under the
        // marker. Start the glide once enough chunks are meshed (or a safety timeout) so the drop into
        // first-person lands on loaded ground, not blocky/empty terrain.
        this.playIntroWaitMs += deltaMs;
        camera.position.copy(this.cameraIntroFromPos);
        camera.quaternion.copy(this.cameraIntroFromQuat);
        const level0 = (this.voxelIntegration?.lodLevel ?? 0) === 0;
        const meshed = useGameStore.getState().voxelStats.meshesVisible >= GameCore.PLAY_INTRO_MESH_READY;
        if ((level0 && meshed) || this.playIntroWaitMs >= GameCore.PLAY_INTRO_MAX_WAIT_MS) {
          this.pendingPlayIntro = false;
          this.cameraIntroMs = GameCore.CAMERA_INTRO_DURATION_MS;
        }
      } else {
        updateCameraFromPlayer(camera, localPlayer);
        // Brief explore→first-person glide: blend from the captured explore pose toward
        // the live FP pose (which updateCameraFromPlayer just wrote into the camera).
        if (this.cameraIntroMs > 0) {
          this.cameraIntroMs = Math.max(0, this.cameraIntroMs - deltaMs);
          const t = 1 - this.cameraIntroMs / GameCore.CAMERA_INTRO_DURATION_MS;
          const eased = easeInOut(t);
          this.introTmpPos.copy(camera.position);
          this.introTmpQuat.copy(camera.quaternion);
          camera.position.copy(this.cameraIntroFromPos).lerp(this.introTmpPos, eased);
          camera.quaternion.copy(this.cameraIntroFromQuat).slerp(this.introTmpQuat, eased);
        }
        if (!menuPaused) {
          perfStats.begin('buildPreview');
          this.builder.update(camera, localPlayer.position);
          perfStats.end('buildPreview');
        }
      }
    }

    // Camera head-bob while moving — a subtle vertical bob applied to the camera
    // position (rotation is late-latched at render, so only position is safe here).
    // The first-person arm is a camera child, so it inherits this motion.
    const move = controls.getMoveVector();
    const speed = Math.hypot(move.moveX, move.moveZ);
    let headBob = 0;
    // Skip head-bob during the intro glide so it doesn't fight the tween.
    if (camera && !menuPaused && this.cameraIntroMs === 0 && !this.pendingPlayIntro) {
      if (speed > 0.1) this.headBobPhase += (Math.min(deltaMs, 100) / 1000) * 9;
      headBob = Math.sin(this.headBobPhase * 2) * 0.05 * Math.min(1, speed);
      camera.position.y += headBob;
    }

    // Once the explore→FP camera glide finishes, flag first-person ready so the arm + hotbar
    // reveal together (covers no-glide re-entry too, where cameraIntroMs is already 0).
    if (this.cameraIntroMs === 0 && !this.pendingPlayIntro && !useGameStore.getState().firstPersonReady) {
      useGameStore.getState().setFirstPersonReady(true);
    }

    // First-person arm — hidden while the menu soft-pauses play AND during the camera intro glide
    // (it slides in once the glide completes).
    const build = useGameStore.getState().build;
    const ts = useGameStore.getState().textureState;
    const meta = build.presetMeta[build.presetId];
    updateFirstPersonArm({
      visible: !menuPaused && this.cameraIntroMs === 0 && !this.pendingPlayIntro,
      buildMode: build.buildMode,
      rotation: meta?.baseRotation,
      parts: meta?.parts,
      texturesReady: ts === 'low' || ts === 'high',
      variant: ts === 'high' ? 'hi' : 'lo',
      headBob,
      dtMs: deltaMs,
    });

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
