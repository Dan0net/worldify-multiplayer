/**
 * GameLoop - RAF timing and FPS calculation
 * 
 * Extracted from GameCore to handle:
 * - requestAnimationFrame loop management
 * - Delta time calculation
 * - FPS measurement and reporting
 * - Elapsed time tracking
 */

import { storeBridge } from '../state/bridge';

export type LoopCallback = (deltaMs: number, elapsedTime: number) => void;

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
      storeBridge.updateDebugStats(fps, deltaMs);
      this.frameCount = 0;
      this.fpsAccumulator = 0;
    }

    // Call the update callback
    if (this.callback) {
      this.callback(deltaMs, this.elapsedTime);
    }
  };
}
