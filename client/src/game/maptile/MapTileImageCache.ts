/**
 * MapTileImageCache - Shared singleton that renders map tiles to ImageBitmaps.
 *
 * Responsibilities:
 * - Renders MapTileData → ImageBitmap asynchronously (no main-thread stall)
 * - Caches results keyed by tile key + data hash
 * - Staggers rendering: at most MAX_RENDERS_PER_FRAME new tiles per frame
 * - Shared across all MapRenderer instances (spectator + overlay)
 *
 * Why this exists:
 * Previously each MapRenderer had its own cache and used synchronous
 * canvas.toDataURL() per tile, causing massive frame drops when many
 * tiles arrived at once.
 */

import {
  MapTileData,
  MAP_TILE_SIZE,
  tilePixelIndex,
  Materials,
} from '@worldify/shared';

// ---------- Constants ----------

/** Maximum tiles to render from the pending queue per frame */
const MAX_RENDERS_PER_FRAME = 2;

// ---------- Color Cache ----------

const MATERIAL_RGB_CACHE: [number, number, number][] = [];

function initColorCache(): void {
  if (MATERIAL_RGB_CACHE.length > 0) return;
  for (let i = 0; i < Materials.count; i++) {
    MATERIAL_RGB_CACHE[i] = Materials.getColorRGB(i);
  }
  MATERIAL_RGB_CACHE[255] = [255, 255, 255];
}

// ---------- Cached Entry ----------

export interface CachedTileImage {
  /** The rendered tile as an ImageBitmap (GPU-friendly, no data URL) */
  bitmap: ImageBitmap;
  /** Hash that was used to generate this bitmap */
  dataHash: number;
}

// ---------- Singleton State ----------

/** Global cache: tile key → rendered image + hash */
const imageCache = new Map<string, CachedTileImage>();

/** Pending tiles that need rendering: tile key → { tile, hash } */
const pendingQueue = new Map<string, { tile: MapTileData; hash: number }>();

/** Reusable offscreen canvas for tile rendering (32×32) */
let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

/** Listeners notified when new bitmaps become available */
type InvalidateListener = () => void;
const listeners = new Set<InvalidateListener>();

/** Whether a flush is already scheduled for this frame */
let flushScheduled = false;

// ---------- Setup ----------

function ensureCanvas(): void {
  if (offscreenCanvas) return;
  initColorCache();
  offscreenCanvas = new OffscreenCanvas(MAP_TILE_SIZE, MAP_TILE_SIZE);
  const ctx = offscreenCanvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get OffscreenCanvas 2D context');
  offscreenCtx = ctx;
}

// ---------- Rendering ----------

/** Render tile pixels into the offscreen canvas and return an ImageBitmap. */
function renderTileToBitmap(tile: MapTileData): Promise<ImageBitmap> {
  ensureCanvas();
  const ctx = offscreenCtx!;
  const canvas = offscreenCanvas!;

  const imageData = ctx.createImageData(MAP_TILE_SIZE, MAP_TILE_SIZE);
  const data = imageData.data;

  for (let lz = 0; lz < MAP_TILE_SIZE; lz++) {
    for (let lx = 0; lx < MAP_TILE_SIZE; lx++) {
      const tileIndex = tilePixelIndex(lx, lz);
      const height = tile.heights[tileIndex];
      const material = tile.materials[tileIndex];

      const rgb = MATERIAL_RGB_CACHE[material] ?? MATERIAL_RGB_CACHE[255];
      // Height shading (hardcoded defaults matching MapRenderer)
      const heightNorm = (height - (-32)) / (64 - (-32));
      const brightness = Math.max(0.3, Math.min(1.0, 0.5 + heightNorm * 0.5));
      const r = Math.round(rgb[0] * brightness);
      const g = Math.round(rgb[1] * brightness);
      const b = Math.round(rgb[2] * brightness);

      const px = (lz * MAP_TILE_SIZE + lx) * 4;
      data[px] = r;
      data[px + 1] = g;
      data[px + 2] = b;
      data[px + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return createImageBitmap(canvas);
}

// ---------- Flush Loop (staggered) ----------

async function flushPending(): Promise<void> {
  flushScheduled = false;

  let rendered = 0;
  for (const [key, { tile, hash }] of pendingQueue) {
    if (rendered >= MAX_RENDERS_PER_FRAME) break;

    // Skip if already cached with matching hash
    const existing = imageCache.get(key);
    if (existing && existing.dataHash === hash) {
      pendingQueue.delete(key);
      continue;
    }

    // Render (async — createImageBitmap yields to browser)
    const bitmap = await renderTileToBitmap(tile);

    // Dispose old bitmap
    if (existing) existing.bitmap.close();

    imageCache.set(key, { bitmap, dataHash: hash });
    pendingQueue.delete(key);
    rendered++;
  }

  // Notify listeners that new bitmaps are available
  if (rendered > 0) {
    for (const cb of listeners) cb();
  }

  // If more pending, schedule next frame
  if (pendingQueue.size > 0) {
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => { flushPending(); });
}

// ---------- Public API ----------

/**
 * Get a cached bitmap for a tile, or enqueue it for async rendering.
 * Returns the bitmap if ready, null if still pending.
 */
export function getTileBitmap(key: string, tile: MapTileData): CachedTileImage | null {
  const hash = tile._hash;

  const cached = imageCache.get(key);
  if (cached && cached.dataHash === hash) {
    return cached;
  }

  // Enqueue for async rendering (deduplicates automatically)
  pendingQueue.set(key, { tile, hash });
  scheduleFlush();

  return null;
}

/**
 * Register a listener called when new tile bitmaps become available.
 * Returns an unsubscribe function.
 */
export function onTileBitmapsReady(cb: InvalidateListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Clear the entire image cache (e.g. on reconnect).
 */
export function clearTileImageCache(): void {
  for (const entry of imageCache.values()) {
    entry.bitmap.close();
  }
  imageCache.clear();
  pendingQueue.clear();
}
