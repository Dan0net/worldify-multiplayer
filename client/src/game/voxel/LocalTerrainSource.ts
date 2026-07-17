/**
 * LocalTerrainSource - client-side terrain generation for offline / local play.
 *
 * Mirrors the server's generation pipeline (ChunkProvider + MapTileProvider +
 * SurfaceColumnProvider) using the SAME shared `TerrainGenerator` and helpers,
 * so a local world is identical to a server world for a given seed. Produces the
 * exact network response shapes (VoxelChunkData / MapTileResponse /
 * SurfaceColumnResponse) so VoxelWorld can ingest them through its existing
 * receive* methods with no other changes.
 *
 * No persistence yet (a fresh world each session) — that is a later addition.
 */

import {
  TerrainGenerator,
  createMapTile,
  tilePixelIndex,
  updateTileFromChunk,
  chunkHasContent,
  scanMultiChunkColumn,
  getChunkRangeFromHeights,
  CHUNK_SIZE,
  VOXEL_SCALE,
  MAP_TILE_SIZE,
  type VoxelChunkData,
  type MapTileResponse,
  type SurfaceColumnResponse,
  type SurfaceColumnChunk,
  type CaveConfig,
  type TerrainLayerConfig,
} from '@worldify/shared';

/** Matches SurfaceColumnProvider on the server. */
const CHUNKS_BELOW_SURFACE = 0;
const MAX_CHUNKS_ABOVE = 4;

export class LocalTerrainSource {
  private readonly gen: TerrainGenerator;
  /** Cache raw generated chunk data so tile scanning and chunk requests agree. */
  private readonly cache = new Map<string, Uint32Array>();

  constructor(seed: number, caveConfig?: CaveConfig, terrainConfig?: TerrainLayerConfig) {
    this.gen = new TerrainGenerator({
      seed,
      ...(caveConfig ? { caveConfig } : {}),
      ...(terrainConfig ? { terrainLayer: terrainConfig } : {}),
    });
  }

  private rawChunk(cx: number, cy: number, cz: number): Uint32Array {
    const key = `${cx},${cy},${cz}`;
    let data = this.cache.get(key);
    if (!data) {
      data = this.gen.generateChunk(cx, cy, cz);
      this.cache.set(key, data);
    }
    return data;
  }

  /** Fill a fresh tile with terrain-baseline surface heights/materials. */
  private baselineTile(tx: number, tz: number) {
    const tile = createMapTile(tx, tz);
    const worldX0 = tx * CHUNK_SIZE * VOXEL_SCALE;
    const worldZ0 = tz * CHUNK_SIZE * VOXEL_SCALE;
    for (let lz = 0; lz < MAP_TILE_SIZE; lz++) {
      for (let lx = 0; lx < MAP_TILE_SIZE; lx++) {
        const { height, material } = this.gen.sampleSurface(
          worldX0 + lx * VOXEL_SCALE,
          worldZ0 + lz * VOXEL_SCALE,
        );
        const i = tilePixelIndex(lx, lz);
        tile.heights[i] = height;
        tile.materials[i] = material;
      }
    }
    return tile;
  }

  /** Generate a single chunk (equivalent of a server VOXEL_CHUNK_DATA response). */
  generateChunk(cx: number, cy: number, cz: number): VoxelChunkData {
    return {
      chunkX: cx,
      chunkY: cy,
      chunkZ: cz,
      lastBuildSeq: 0,
      voxelData: this.rawChunk(cx, cy, cz),
    };
  }

  /** Generate a terrain-baseline tile (equivalent of a MAP_TILE_DATA response). */
  generateTile(tx: number, tz: number): MapTileResponse {
    const tile = this.baselineTile(tx, tz);
    return { tx, tz, heights: tile.heights, materials: tile.materials };
  }

  /**
   * Generate a bootstrap surface column: tile + the chunks that intersect the
   * surface. Mirrors SurfaceColumnProvider.generateColumn.
   */
  generateColumn(tx: number, tz: number): SurfaceColumnResponse {
    const tile = this.baselineTile(tx, tz);

    const { minCy: terrainMinCy, maxCy: terrainMaxCy } = getChunkRangeFromHeights(tile.heights);
    const minCy = terrainMinCy - CHUNKS_BELOW_SURFACE;

    const chunks: SurfaceColumnChunk[] = [];
    const chunkDatas: Array<{ cy: number; data: Uint32Array }> = [];

    for (let cy = minCy; cy <= terrainMaxCy + MAX_CHUNKS_ABOVE; cy++) {
      const data = this.rawChunk(tx, cy, tz);
      // Always include terrain chunks; above terrain, include ANY chunk with content
      // (tree canopies, tall buildings). Skip empties but keep scanning to MAX_CHUNKS_ABOVE
      // so a canopy separated from the terrain top by an empty chunk is still captured.
      if (cy <= terrainMaxCy || chunkHasContent(data)) {
        chunkDatas.push({ cy, data });
        chunks.push({ chunkY: cy, lastBuildSeq: 0, voxelData: data });
      }
    }

    // Capture stamps/trees spanning chunks into the tile surface.
    for (const c of chunkDatas) {
      updateTileFromChunk(
        tile,
        { cx: tx, cy: c.cy, cz: tz, data: c.data },
        (lx, lz) => scanMultiChunkColumn(chunkDatas, lx, lz),
      );
    }

    return { tx, tz, heights: tile.heights, materials: tile.materials, chunks };
  }
}
