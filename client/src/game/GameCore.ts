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
import { initLighting, applyEnvironmentSettings } from './scene/Lighting';
import { updateDayNightCycle } from './scene/DayNightCycle';
import { updateSkyTime, updateSkyCamera } from './scene/SkyDome';
import { initPostProcessing, renderWithPostProcessing, resizePostProcessing, disposePostProcessing, isPostProcessingEnabled } from './scene/postprocessing';
import { storeBridge } from '../state/bridge';
import { useGameStore } from '../state/store';
import { controls } from './player/controls';
import { on } from '../net/decode';
import { RoomSnapshot, GameMode, VoxelBuildCommit, VoxelChunkData, BuildResult } from '@worldify/shared';
import { VoxelIntegration } from './voxel/VoxelIntegration';
import { setVoxelWireframe } from './voxel/VoxelMaterials';
import { GameLoop } from './GameLoop';
import { PlayerManager } from './PlayerManager';
import { Builder } from './build/Builder';
import { SpawnManager } from './spawn/SpawnManager';
import { materialManager, updateWindTime } from './material';

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
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
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
        ssaoKernelRadius: 12,
        ssaoMinDistance: 0.002,
        // Bloom settings from worldify-app
        bloomEnabled: true,
        bloomIntensity: 0.3,
        bloomThreshold: 0.85,
        bloomRadius: 0.4,
      });
    }

    // Initialize voxel terrain system
    if (scene) {
      this.voxelIntegration = new VoxelIntegration(scene, {
        debugEnabled: false,
        collisionEnabled: true,
      });
      
      // Note: useServerChunks is read from store by VoxelWorld
      this.voxelIntegration.init();
      
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

      // Initialize build system
      this.builder.setMeshProvider(this.voxelIntegration);
      this.builder.setVoxelWorld(this.voxelIntegration.world, scene);
      this.builder.addToScene(scene);
      
      // Handle collision rebuild after builds
      this.builder.onBuildCommit = (modifiedChunks: string[]) => {
        this.voxelIntegration.rebuildCollisionForChunks(modifiedChunks);
      };

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

    // Rebuild collision for modified chunks
    if (modifiedChunks.length > 0) {
      this.voxelIntegration.rebuildCollisionForChunks(modifiedChunks);
    }
  };

  /**
   * Handle chunk data from server - apply to voxel world
   */
  private handleChunkData = (chunkData: VoxelChunkData): void => {
    if (!this.voxelIntegration) return;
    
    // Apply chunk data to voxel world
    this.voxelIntegration.world.receiveChunkData(chunkData);
  };

  /**
   * Main update loop callback - called by GameLoop
   */
  private update = (deltaMs: number, elapsedTime: number): void => {
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
    this.playerManager.updateRemotePlayers(deltaMs);

    // Update wind animation for foliage
    updateWindTime(elapsedTime);

    // Update day-night cycle (calculates lighting based on time)
    updateDayNightCycle(deltaMs);
    
    // Update sky shader animation and camera matrices
    updateSkyTime(elapsedTime);
    if (camera) {
      updateSkyCamera(camera);
    }
    
    // Apply any environment changes to the lighting system
    const envState = storeBridge.environment;
    applyEnvironmentSettings(envState);

    // Render with post-processing (SSAO + bloom) or fallback to direct render
    const scene = getScene();
    if (scene && camera) {
      if (isPostProcessingEnabled()) {
        renderWithPostProcessing();
      } else {
        this.renderer.render(scene, camera);
      }
    }
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
      this.voxelIntegration.update(this.spectatorCenter);
    }
    
    // Update spawn detection
    if (this.spawnManager) {
      this.spawnManager.update();
      
      // Update spawn ready state in store
      const spawnReady = this.spawnManager.isSpawnReady();
      if (spawnReady !== storeBridge.spawnReady) {
        storeBridge.setSpawnReady(spawnReady);
      }
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
    this.playerManager.updateLocalPlayer(deltaMs);

    // Update voxel terrain around player
    if (this.voxelIntegration) {
      this.voxelIntegration.update(localPlayer.position);
    }

    // Update camera and build system
    if (camera) {
      updateCameraFromPlayer(camera, localPlayer);
      this.builder.update(camera);
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
