/**
 * PerformanceStats - Per-subsystem frame timing and renderer metrics
 * 
 * Collects granular timing for each subsystem in the game loop,
 * plus Three.js renderer.info stats. Updated every frame internally,
 * flushed to the store at ~10Hz to avoid React churn.
 * 
 * Usage:
 *   perfStats.begin('physics');
 *   // ... do physics ...
 *   perfStats.end('physics');
 *   
 *   // After render:
 *   perfStats.captureRendererInfo(renderer);
 *   perfStats.endFrame();
 */

import * as THREE from 'three';
import { storeBridge } from '../../state/bridge';

/** Subsystem timing keys */
export type PerfSection =
  | 'gameUpdate'     // Total frame time (update callback)
  | 'physics'        // Player physics + movement
  | 'voxelUpdate'    // VoxelWorld.update (visibility + remesh)
  | 'remesh'         // Just the remesh queue portion
  | 'buildPreview'   // Build preview meshing
  | 'players'        // Remote player interpolation
  | 'environment'    // Day/night + sky + lighting apply
  | 'render'         // renderer.render / composer.render
  ;

/** Snapshot of per-frame performance data */
export interface PerfSnapshot {
  // Per-subsystem times in ms (rolling averages)
  gameUpdate: number;
  physics: number;
  voxelUpdate: number;
  remesh: number;
  buildPreview: number;
  players: number;
  environment: number;
  render: number;

  // Three.js renderer info
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;

  // Voxel-specific
  remeshQueueSize: number;
  pendingChunks: number;

  // Memory (when available)
  jsHeapMB: number;
}

const EMPTY_SNAPSHOT: PerfSnapshot = {
  gameUpdate: 0, physics: 0, voxelUpdate: 0, remesh: 0,
  buildPreview: 0, players: 0, environment: 0, render: 0,
  drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0,
  remeshQueueSize: 0, pendingChunks: 0, jsHeapMB: 0,
};

/** Rolling average window size (frames) */
const AVG_WINDOW = 60;

/** Store flush interval (ms) */
const FLUSH_INTERVAL_MS = 200; // 5Hz — enough for UI, minimal React overhead

class PerformanceStatsCollector {
  // Accumulator for rolling averages
  private accum: Record<PerfSection, number[]> = {
    gameUpdate: [], physics: [], voxelUpdate: [], remesh: [],
    buildPreview: [], players: [], environment: [], render: [],
  };

  // In-flight timers
  private starts = new Map<PerfSection, number>();

  // Latest computed snapshot
  private snapshot: PerfSnapshot = { ...EMPTY_SNAPSHOT };

  // Flush throttle
  private lastFlush = 0;

  // Additional per-frame counters (set externally)
  private _remeshQueueSize = 0;
  private _pendingChunks = 0;

  /** Start timing a section */
  begin(section: PerfSection): void {
    this.starts.set(section, performance.now());
  }

  /** End timing a section */
  end(section: PerfSection): void {
    const start = this.starts.get(section);
    if (start === undefined) return;
    const elapsed = performance.now() - start;
    this.starts.delete(section);

    const buf = this.accum[section];
    buf.push(elapsed);
    if (buf.length > AVG_WINDOW) buf.shift();
  }

  /** Capture renderer.info after render call */
  captureRendererInfo(renderer: THREE.WebGLRenderer): void {
    const info = renderer.info;
    this.snapshot.drawCalls = info.render.calls;
    this.snapshot.triangles = info.render.triangles;
    this.snapshot.geometries = info.memory.geometries;
    this.snapshot.textures = info.memory.textures;
    this.snapshot.programs = info.programs?.length ?? 0;
  }

  /** Set voxel queue stats (called from VoxelWorld) */
  setVoxelQueueStats(remeshQueueSize: number, pendingChunks: number): void {
    this._remeshQueueSize = remeshQueueSize;
    this._pendingChunks = pendingChunks;
  }

  /** Call at the end of each frame to compute averages and flush */
  endFrame(): void {
    // Compute rolling averages
    for (const key of Object.keys(this.accum) as PerfSection[]) {
      const buf = this.accum[key];
      if (buf.length === 0) {
        this.snapshot[key] = 0;
      } else {
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        this.snapshot[key] = sum / buf.length;
      }
    }

    this.snapshot.remeshQueueSize = this._remeshQueueSize;
    this.snapshot.pendingChunks = this._pendingChunks;

    // JS heap (Chrome-only)
    const mem = (performance as any).memory;
    if (mem) {
      this.snapshot.jsHeapMB = Math.round(mem.usedJSHeapSize / (1024 * 1024));
    }

    // Flush to store at throttled rate
    const now = performance.now();
    if (now - this.lastFlush >= FLUSH_INTERVAL_MS) {
      this.lastFlush = now;
      storeBridge.updatePerfStats({ ...this.snapshot });
    }
  }

  /** Get latest snapshot (for non-React reads) */
  getSnapshot(): Readonly<PerfSnapshot> {
    return this.snapshot;
  }
}

/** Singleton instance */
export const perfStats = new PerformanceStatsCollector();
