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
import { setupLighting } from './scene/lighting';
import { storeBridge } from '../state/bridge';
import { controls } from './player/controls';
import { on } from '../net/decode';
import { RoomSnapshot, GameMode, VoxelBuildCommit, VoxelChunkData, BuildResult } from '@worldify/shared';
import { VoxelIntegration } from './voxel/VoxelIntegration';
import { setVoxelWireframe } from './voxel/VoxelMaterials';
import { GameLoop } from './GameLoop';
import { PlayerManager } from './PlayerManager';
import { Builder } from './build/Builder';

export class GameCore {
  private renderer!: THREE.WebGLRenderer;

  // Extracted modules
  private gameLoop: GameLoop;
  private playerManager: PlayerManager;

  // Voxel terrain system
  private voxelIntegration!: VoxelIntegration;

  // Build system
  private builder: Builder;

  constructor() {
    this.gameLoop = new GameLoop();
    this.playerManager = new PlayerManager();
    this.builder = new Builder(controls);
  }

  async init(): Promise<void> {
    // Create renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x87ceeb); // Sky blue

    // Add canvas to DOM
    const canvas = this.renderer.domElement;
    canvas.id = 'game-canvas';
    document.body.appendChild(canvas);

    // Initialize scene, camera, lighting
    createScene();
    createCamera();
    setupLighting();

    // Initialize voxel terrain system
    const scene = getScene();
    if (scene) {
      this.voxelIntegration = new VoxelIntegration(scene, {
        debugEnabled: false,
        collisionEnabled: true,
      });
      this.voxelIntegration.init();
      
      // Connect player manager to voxel collision system
      this.playerManager.setVoxelIntegration(this.voxelIntegration);
      
      // Set player spawn position above terrain
      const spawnPos = this.voxelIntegration.getSpawnPosition(0, 0);
      this.playerManager.setSpawnPosition(spawnPos);

      // Initialize build system
      this.builder.setMeshProvider(this.voxelIntegration);
      this.builder.setVoxelWorld(this.voxelIntegration.world, scene);
      this.builder.addToScene(scene);
      
      // Handle collision rebuild after builds
      this.builder.onBuildCommit = (modifiedChunks: string[]) => {
        this.voxelIntegration.rebuildCollisionForChunks(modifiedChunks);
      };

      // Enable server-based chunk loading
      this.voxelIntegration.world.enableServerChunks();
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

    // Render
    const scene = getScene();
    if (scene && camera) {
      this.renderer.render(scene, camera);
    }
  };

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
      updateSpectatorCamera(camera, deltaMs, elapsedTime);
    }

    // Update voxel terrain centered on origin
    if (this.voxelIntegration) {
      this.voxelIntegration.update(new THREE.Vector3(0, 10, 0));
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
  };

  dispose(): void {
    // Stop loops
    this.gameLoop.stop();
    this.playerManager.dispose();

    // Clean up build system
    this.builder.dispose();

    // Clean up voxel terrain
    if (this.voxelIntegration) {
      this.voxelIntegration.dispose();
    }

    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    document.body.removeChild(this.renderer.domElement);
  }
}
