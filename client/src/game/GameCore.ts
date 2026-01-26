import * as THREE from 'three';
import { createScene, getScene } from './scene/scene';
import { createCamera, getCamera, updateCameraFromPlayer } from './scene/camera';
import { setupLighting } from './scene/lighting';
import { storeBridge } from '../state/bridge';
import { PlayerLocal } from './player/playerLocal';
import { PlayerRemote } from './player/playerRemote';
import { controls } from './player/controls';
import { onSnapshot } from '../net/decode';
import { sendBinary } from '../net/netClient';
import { encodeInput } from '../net/encode';
import { CLIENT_INPUT_HZ, RoomSnapshot } from '@worldify/shared';

export class GameCore {
  private renderer!: THREE.WebGLRenderer;
  private animationId: number | null = null;
  private lastTime = 0;
  private frameCount = 0;
  private fpsAccumulator = 0;

  // Player management
  private localPlayer!: PlayerLocal;
  private remotePlayers = new Map<number, PlayerRemote>();
  private localPlayerId: number | null = null;

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

    // Request pointer lock on canvas click
    canvas.addEventListener('click', () => {
      controls.requestPointerLock();
    });

    // Register for snapshot updates
    onSnapshot(this.handleSnapshot);

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

  private startLoop(): void {
    this.lastTime = performance.now();
    this.animationId = requestAnimationFrame(this.loop);
  }

  private loop = (time: number): void => {
    const deltaMs = time - this.lastTime;
    this.lastTime = time;

    // FPS calculation
    this.frameCount++;
    this.fpsAccumulator += deltaMs;
    if (this.fpsAccumulator >= 1000) {
      const fps = Math.round((this.frameCount * 1000) / this.fpsAccumulator);
      storeBridge.updateDebugStats(fps, deltaMs);
      this.frameCount = 0;
      this.fpsAccumulator = 0;
    }

    // Update local player (for camera)
    this.localPlayer.update(deltaMs, controls);

    // Update remote players (interpolation)
    for (const remote of this.remotePlayers.values()) {
      remote.update(deltaMs);
    }

    // Update camera to follow local player
    const camera = getCamera();
    if (camera) {
      updateCameraFromPlayer(camera, this.localPlayer);
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
