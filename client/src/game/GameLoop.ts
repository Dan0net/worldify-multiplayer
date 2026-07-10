/**
 * GameLoop - RAF timing and FPS calculation
 * 
 * Extracted from GameCore to handle:
 * - requestAnimationFrame loop management
 * - Delta time calculation
 * - FPS measurement and reporting
 * - Elapsed time tracking
 */

import { updateDebugStats } from '../state/transient';

export type LoopCallback = (deltaMs: number, elapsedTime: number) => void;

/** Max delta passed to the update callback (ms). Prevents physics tunneling after a hitch. */
const MAX_FRAME_DELTA_MS = 100;

export class GameLoop {
  private animationId: number | null = null;
  private lastTime = 0;
  private frameCount = 0;
  private fpsAccumulator = 0;
  private elapsedTime = 0; // Total elapsed time in seconds

  private callback: LoopCallback | null = null;

  /**
   * Start the game loop with the given callback
   */
  start(callback: LoopCallback): void {
    this.callback = callback;
    this.lastTime = performance.now();
    this.elapsedTime = 0;
    this.frameCount = 0;
    this.fpsAccumulator = 0;
    this.animationId = requestAnimationFrame(this.loop);
  }

  /**
   * Stop the game loop
   */
  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.callback = null;
  }

  /**
   * Get total elapsed time since loop started (in seconds)
   */
  getElapsedTime(): number {
    return this.elapsedTime;
  }

  /**
   * Check if the loop is running
   */
  isRunning(): boolean {
    return this.animationId !== null;
  }

  private loop = (time: number): void => {
    // Schedule next frame FIRST - gives the browser maximum time to prepare
    // the next vsync callback while we process the current frame.
    this.animationId = requestAnimationFrame(this.loop);

    const deltaMs = time - this.lastTime;
    this.lastTime = time;
    this.elapsedTime += deltaMs / 1000;

    // FPS calculation - update once per second
    this.frameCount++;
    this.fpsAccumulator += deltaMs;
    if (this.fpsAccumulator >= 1000) {
      const fps = Math.round((this.frameCount * 1000) / this.fpsAccumulator);
      updateDebugStats(fps, deltaMs);
      this.frameCount = 0;
      this.fpsAccumulator = 0;
    }

    // Call the update callback with a clamped delta. A generation/GC hitch or a
    // backgrounded tab can produce a huge deltaMs; an unclamped physics step
    // that large tunnels the player capsule through the thin surface mesh.
    if (this.callback) {
      const dt = Math.min(deltaMs, MAX_FRAME_DELTA_MS);
      this.callback(dt, this.elapsedTime);
    }
  };
}
