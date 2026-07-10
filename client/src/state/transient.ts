/**
 * Transient (non-reactive) client state.
 *
 * Holds data that must NOT live in the Zustand store: values that update every
 * frame (map marker positions) and would thrash React, an imperative registry
 * (the chunk-clear callback), and the 10 Hz debug-stats rate limiter. These are
 * the only genuinely non-store roles the old StoreBridge served.
 */

import { useGameStore } from './store';

// ============== Map overlay positions ==============
// Updated every frame by GameCore, read by MapPanel — kept out of Zustand so
// per-frame position updates don't trigger React re-renders.

export interface MapMarker {
  x: number;
  z: number;
  rotation: number;
  color: string;
}

const mapPlayerPosition: MapMarker = { x: 0, z: 0, rotation: 0, color: '#45b7d1' };
let mapOtherPlayers: MapMarker[] = [];

export function updateMapPlayerPosition(x: number, z: number, rotation: number, color: string): void {
  mapPlayerPosition.x = x;
  mapPlayerPosition.z = z;
  mapPlayerPosition.rotation = rotation;
  mapPlayerPosition.color = color;
}

export function getMapPlayerPosition(): MapMarker {
  return mapPlayerPosition;
}

export function updateMapOtherPlayers(players: MapMarker[]): void {
  mapOtherPlayers = players;
}

export function getMapOtherPlayers(): MapMarker[] {
  return mapOtherPlayers;
}

// ============== Debug-stats rate limiter (10 Hz) ==============

let lastDebugStatsTime = 0;
const DEBUG_STATS_INTERVAL_MS = 100;

/** Push FPS / tick timing to the store at most 10×/second. */
export function updateDebugStats(fps: number, tickMs: number): void {
  const now = performance.now();
  if (now - lastDebugStatsTime >= DEBUG_STATS_INTERVAL_MS) {
    useGameStore.getState().setDebugStats(fps, tickMs);
    lastDebugStatsTime = now;
  }
}

// ============== Chunk-clear registry ==============
// GameCore registers the callback; the debug panel invokes it (F9).

let clearChunksCallback: (() => void) | null = null;

export function setClearChunksCallback(callback: () => void): void {
  clearChunksCallback = callback;
}

export function clearAndReloadChunks(): void {
  if (clearChunksCallback) {
    clearChunksCallback();
  } else {
    console.warn('[transient] No chunk clear callback registered');
  }
}
