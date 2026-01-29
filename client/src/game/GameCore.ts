import * as THREE from 'three';
import { createScene, getScene } from './scene/scene';
import { createCamera, getCamera, updateCameraFromPlayer, updateSpectatorCamera } from './scene/camera';
import { setupLighting } from './scene/lighting';
import { storeBridge } from '../state/bridge';
import { PlayerLocal } from './player/playerLocal';
import { PlayerRemote } from './player/playerRemote';
import { controls } from './player/controls';
// Old build system - disabled for voxel terrain
// import { BuildController } from './world/buildController';
import { onSnapshot, onBuildCommit } from '../net/decode';
import { sendBinary, setOnReconnected } from '../net/netClient';
import { encodeInput } from '../net/encode';
import { CLIENT_INPUT_HZ, RoomSnapshot, BuildCommit } from '@worldify/shared';
import { useGameStore } from '../state/store';
import { VoxelIntegration } from './voxel/VoxelIntegration';

export class GameCore {
  private renderer!: THREE.WebGLRenderer;
  private animationId: number | null = null;
  private lastTime = 0;
  private frameCount = 0;
  private fpsAccumulator = 0;
  private elapsedTime = 0; // Total time for spectator camera animation

  // Player management
  private localPlayer!: PlayerLocal;
  private remotePlayers = new Map<number, PlayerRemote>();
  private localPlayerId: number | null = null;

  // Voxel terrain system
  private voxelIntegration!: VoxelIntegration;

  // Old build system - disabled for voxel terrain
  // private buildController!: BuildController;

  // Input sending
  private inputInterval: ReturnType<typeof setInterval> | null = null;

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

    // Create local player
    this.localPlayer = new PlayerLocal();

    // Initialize voxel terrain system
    const scene = getScene();
    if (scene) {
      this.voxelIntegration = new VoxelIntegration(scene, {
        debugEnabled: false,
        collisionEnabled: true,
      });
      this.voxelIntegration.init();
      
      // Connect player to voxel collision system
      this.localPlayer.setVoxelIntegration(this.voxelIntegration);
      
      // Set player spawn position above terrain
      const spawnPos = this.voxelIntegration.getSpawnPosition(0, 0);
      this.localPlayer.position.copy(spawnPos);
    }

    // Old build system - disabled for voxel terrain
    // this.buildController = new BuildController();

    // Request pointer lock on canvas click (only if not spectating)
    canvas.addEventListener('click', () => {
      if (!useGameStore.getState().isSpectating) {
        controls.requestPointerLock();
      }
    });

    // Register for snapshot updates
    onSnapshot(this.handleSnapshot);

    // Register for build commits
    onBuildCommit(this.handleBuildCommit);

    // Register for reconnect events
    setOnReconnected(this.handleReconnected);

    // Handle resize
    window.addEventListener('resize', this.onResize);

    // Start render loop
    this.startLoop();

    // Start input sending loop
    this.startInputLoop();
  }

  setLocalPlayerId(playerId: number): void {
    this.localPlayerId = playerId;
  }

  private startInputLoop(): void {
    const intervalMs = 1000 / CLIENT_INPUT_HZ;
    this.inputInterval = setInterval(() => {
      this.sendInput();
    }, intervalMs);
  }

  private sendInput(): void {
    const input = this.localPlayer.getInput(controls);
    sendBinary(encodeInput(input));
  }

  private handleSnapshot = (snapshot: RoomSnapshot): void => {
    const scene = getScene();
    if (!scene) return;

    // Update player count in store
    storeBridge.updatePlayerCount(snapshot.players.length);

    // Track which players we've seen
    const seenPlayerIds = new Set<number>();

    for (const playerData of snapshot.players) {
      seenPlayerIds.add(playerData.playerId);

      // Skip local player (we control them locally)
      if (playerData.playerId === this.localPlayerId) {
        // Update local player position from server (for now, no prediction)
        this.localPlayer.applyServerState(playerData);
        continue;
      }

      // Get or create remote player
      let remote = this.remotePlayers.get(playerData.playerId);
      if (!remote) {
        remote = new PlayerRemote(playerData.playerId);
        this.remotePlayers.set(playerData.playerId, remote);
        scene.add(remote.mesh);
      }

      remote.applySnapshot(playerData);
    }

    // Remove disconnected players
    for (const [playerId, remote] of this.remotePlayers) {
      if (!seenPlayerIds.has(playerId)) {
        scene.remove(remote.mesh);
        remote.dispose();
        this.remotePlayers.delete(playerId);
      }
    }
  };

  // Old build system handlers - disabled for voxel terrain
  private handleBuildCommit = (_commit: BuildCommit): void => {
    // this.buildController.handleBuildCommit(commit);
  };

  private handleReconnected = (): void => {
    // Old build system sync - disabled
    // const lastSeq = this.buildController.getLastAppliedSeq();
    // console.log(`[game] Reconnected, requesting builds since seq ${lastSeq}`);
    // requestBuildSync(lastSeq);
  };

  private startLoop(): void {
    this.lastTime = performance.now();
    this.animationId = requestAnimationFrame(this.loop);
  }

  private loop = (time: number): void => {
    const deltaMs = time - this.lastTime;
    this.lastTime = time;
    this.elapsedTime += deltaMs / 1000; // Track total time in seconds

    // FPS calculation
    this.frameCount++;
    this.fpsAccumulator += deltaMs;
    if (this.fpsAccumulator >= 1000) {
      const fps = Math.round((this.frameCount * 1000) / this.fpsAccumulator);
      storeBridge.updateDebugStats(fps, deltaMs);
      this.frameCount = 0;
      this.fpsAccumulator = 0;
    }

    const gameState = useGameStore.getState();
    const isSpectating = gameState.isSpectating;
    const camera = getCamera();

    // Sync voxel debug state from store to VoxelDebugManager
    if (this.voxelIntegration) {
      this.voxelIntegration.debug.setState(gameState.voxelDebug);
      
      // Update voxel stats in store
      const stats = this.voxelIntegration.getStats();
      storeBridge.updateVoxelStats({
        chunksLoaded: stats.chunksLoaded,
        meshesVisible: stats.meshesVisible,
        debugObjects: this.voxelIntegration.debug.getDebugObjectCount(),
      });
    }

    if (isSpectating) {
      // Spectator mode: orbit camera looking at game area
      if (camera) {
        updateSpectatorCamera(camera, deltaMs, this.elapsedTime);
      }
      
      // Update voxel terrain in spectator mode too (for debug visualization)
      if (this.voxelIntegration) {
        this.voxelIntegration.update(new THREE.Vector3(0, 10, 0));
      }
    } else {
      // FPS mode: update player and camera
      this.localPlayer.update(deltaMs, controls);
      
      // Update voxel terrain (streaming, collision)
      if (this.voxelIntegration) {
        this.voxelIntegration.update(this.localPlayer.position);
      }
      
      // Old build system - disabled for voxel terrain
      // this.buildController.update();

      if (camera) {
        updateCameraFromPlayer(camera, this.localPlayer);
      }
    }

    // Always update remote players (visible in both modes)
    for (const remote of this.remotePlayers.values()) {
      remote.update(deltaMs);
    }

    // Render
    const scene = getScene();
    if (scene && camera) {
      this.renderer.render(scene, camera);
    }

    this.animationId = requestAnimationFrame(this.loop);
  };

  private onResize = (): void => {
    const camera = getCamera();
    if (camera) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    if (this.inputInterval !== null) {
      clearInterval(this.inputInterval);
    }

    // Clean up voxel terrain
    if (this.voxelIntegration) {
      this.voxelIntegration.dispose();
    }

    // Old build system - disabled
    // this.buildController.dispose();

    // Clean up remote players
    for (const remote of this.remotePlayers.values()) {
      remote.dispose();
    }
    this.remotePlayers.clear();

    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    document.body.removeChild(this.renderer.domElement);
  }
}
