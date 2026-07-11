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
import { useGameStore } from '../../state/store';

/** Subsystem timing keys */
export type PerfSection =
  | 'gameUpdate'     // Total frame time (update callback)
  | 'physics'        // Player physics + movement
  | 'voxelUpdate'    // VoxelWorld.update (visibility + remesh)
  | 'remesh'         // Just the remesh queue portion
  | 'lighting'       // Sunlight column + BFS propagation (computeChunkSunlight)
  | 'grouper'        // ChunkGrouper.rebuild (merge bake + upload)
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
  lighting: number;
  grouper: number;
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
  colliderQueueSize: number;
  groupsRebuilt: number;    // chunk-groups re-merged this frame
  bufferReallocs: number;   // merged-buffer reallocations this frame

  // Memory (when available)
  jsHeapMB: number;
}

const EMPTY_SNAPSHOT: PerfSnapshot = {
  gameUpdate: 0, physics: 0, voxelUpdate: 0, remesh: 0, lighting: 0, grouper: 0,
  buildPreview: 0, players: 0, environment: 0, render: 0,
  drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0,
  remeshQueueSize: 0, pendingChunks: 0, colliderQueueSize: 0,
  groupsRebuilt: 0, bufferReallocs: 0, jsHeapMB: 0,
};

/** Rolling average window size (frames) */
const AVG_WINDOW = 60;

/** Store flush interval (ms) */
const FLUSH_INTERVAL_MS = 200; // 5Hz — enough for UI, minimal React overhead

class PerformanceStatsCollector {
  // Rolling window of PER-FRAME totals (one sample per frame, AVG_WINDOW frames).
  private accum: Record<PerfSection, number[]> = {
    gameUpdate: [], physics: [], voxelUpdate: [], remesh: [], lighting: [], grouper: [],
    buildPreview: [], players: [], environment: [], render: [],
  };

  // Per-frame accumulator: sums every begin/end pair for a section within the
  // current frame, so a section timed many times per frame (e.g. lighting — one
  // call per chunk relight) reports its per-frame TOTAL, not a per-call average.
  private frameSum = new Map<PerfSection, number>();

  // In-flight timers
  private starts = new Map<PerfSection, number>();

  // Latest computed snapshot
  private snapshot: PerfSnapshot = { ...EMPTY_SNAPSHOT };

  // Flush throttle
  private lastFlush = 0;

  // Additional per-frame counters (set externally)
  private _remeshQueueSize = 0;
  private _pendingChunks = 0;
  private _colliderQueueSize = 0;
  private _groupsRebuilt = 0;
  private _bufferReallocs = 0;

  /** Start timing a section */
  begin(section: PerfSection): void {
    this.starts.set(section, performance.now());
  }

  /** End timing a section — adds to this frame's running total for the section. */
  end(section: PerfSection): void {
    const start = this.starts.get(section);
    if (start === undefined) return;
    const elapsed = performance.now() - start;
    this.starts.delete(section);
    this.frameSum.set(section, (this.frameSum.get(section) ?? 0) + elapsed);
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

  /** Set collider build-queue size (called from VoxelIntegration) */
  setColliderQueueSize(size: number): void {
    this._colliderQueueSize = size;
  }

  /** Set chunk-group rebuild stats for the frame (called from VoxelWorld). */
  setGrouperStats(groupsRebuilt: number, bufferReallocs: number): void {
    this._groupsRebuilt = groupsRebuilt;
    this._bufferReallocs = bufferReallocs;
  }

  /** Call at the end of each frame to compute averages and flush */
  endFrame(): void {
    // Fold a sample for EVERY section into its rolling window each frame — using the
    // section's per-frame total, or 0 if it did no work this frame. Pushing zeros for
    // idle frames is what lets an intermittent section (e.g. lighting) decay back to 0
    // when nothing is happening, instead of freezing at its last active average.
    for (const key of Object.keys(this.accum) as PerfSection[]) {
      const buf = this.accum[key];
      buf.push(this.frameSum.get(key) ?? 0);
      if (buf.length > AVG_WINDOW) buf.shift();
    }
    this.frameSum.clear();

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
    this.snapshot.colliderQueueSize = this._colliderQueueSize;
    this.snapshot.groupsRebuilt = this._groupsRebuilt;
    this.snapshot.bufferReallocs = this._bufferReallocs;

    // JS heap (Chrome-only)
    const mem = (performance as any).memory;
    if (mem) {
      this.snapshot.jsHeapMB = Math.round(mem.usedJSHeapSize / (1024 * 1024));
    }

    // Flush to store at throttled rate
    const now = performance.now();
    if (now - this.lastFlush >= FLUSH_INTERVAL_MS) {
      this.lastFlush = now;
      useGameStore.getState().setPerfStats({ ...this.snapshot });
    }
  }

  /** Get latest snapshot (for non-React reads) */
  getSnapshot(): Readonly<PerfSnapshot> {
    return this.snapshot;
  }
}

/** Singleton instance */
export const perfStats = new PerformanceStatsCollector();
