/**
 * SurfaceNet meshing algorithm for voxel terrain
 * 
 * Based on Mikola Lysenko's implementation:
 * https://github.com/mikolalysenko/isosurface
 * 
 * The MIT License (MIT)
 * Copyright (c) 2012-2013 Mikola Lysenko
 * 
 * SurfaceNets work by:
 * 1. For each cell (2×2×2 voxels), check if surface crosses (sign change in weights)
 * 2. If crossing, place a vertex at the weighted average of edge crossings
 * 3. Connect vertices with quads where edges cross the surface
 * 
 * This is a PURE function - it takes voxel data and produces mesh data.
 * It has no knowledge of Chunks or any game-specific concepts.
 * 
 * OPTIMIZATION: Single-pass mesh generation with face binning by material type.
 * Generates one vertex set, but separates faces into solid/transparent buckets.
 */

import {
  CHUNK_SIZE,
  MATERIAL_TYPE_LUT,
  WEIGHT_SHIFT,
  WEIGHT_MASK,
  WEIGHT_MIN,
  MATERIAL_SHIFT,
  MATERIAL_MASK,
  INV_WEIGHT_MAX_PACKED,
  hasSurfaceCrossing,
} from '@worldify/shared';

// ============== Constants ==============

/** Mesh type indices for array-based mesh slots */
const MESH_SOLID = 0;
const MESH_TRANS = 1;
const MESH_LIQUID = 2;
const MESH_COUNT = 3;

/** Grid dimensions: CHUNK_SIZE + 2 margin for neighbor stitching */
const GRID_SIZE = CHUNK_SIZE + 2; // 34
const GRID_STRIDE_X = GRID_SIZE;
const GRID_STRIDE_XY = GRID_SIZE * GRID_SIZE;

// ============== Types ==============

export interface SurfaceNetOutput {
  /** Vertex positions (x, y, z per vertex) */
  positions: Float32Array;
  /** Vertex normals (x, y, z per vertex) */
  normals: Float32Array;
  /** Triangle indices */
  indices: Uint32Array;
  /** Material ID per vertex */
  materials: Uint8Array;
  /** Number of vertices */
  vertexCount: number;
  /** Number of triangles */
  triangleCount: number;
}

/**
 * Combined output with separate solid, transparent, and liquid meshes.
 * Generated in a single pass for efficiency.
 */
export interface SplitSurfaceNetOutput {
  /** Mesh for solid (opaque) materials */
  solid: SurfaceNetOutput;
  /** Mesh for transparent materials */
  transparent: SurfaceNetOutput;
  /** Mesh for liquid materials */
  liquid: SurfaceNetOutput;
}

/**
 * Input data for surface net meshing.
 * Uses flat data array for cache-efficient direct access.
 */
export interface SurfaceNetInput {
  /** Dimensions of the voxel grid [x, y, z] */
  dims: [number, number, number];
  /** Flat packed voxel data array (dims[0] * dims[1] * dims[2]) */
  data: Uint16Array;
  /** 
   * Skip faces at high boundary for each axis [+X, +Y, +Z].
   * When true, faces at dims[axis]-2 are skipped (no neighbor to stitch with).
   */
  skipHighBoundary?: [boolean, boolean, boolean];
}

// ============== Pre-computed Tables ==============

// All 24 pairs of cells in 2x2x2 grid (12 edges, 2 indices each)
const CUBE_EDGES = new Int32Array(24);

// Edge table: 256 possible cube configurations -> 12-bit edge crossing mask
const EDGE_TABLE = new Int32Array(256);

// Initialize lookup tables
(function initTables() {
  // Build cube edges - pairs of adjacent corners
  let k = 0;
  for (let i = 0; i < 8; ++i) {
    for (let j = 1; j <= 4; j <<= 1) {
      const p = i ^ j;
      if (i <= p) {
        CUBE_EDGES[k++] = i;
        CUBE_EDGES[k++] = p;
      }
    }
  }

  // Build edge table - which edges cross for each cube configuration
  for (let i = 0; i < 256; ++i) {
    let em = 0;
    for (let j = 0; j < 24; j += 2) {
      const a = !!(i & (1 << CUBE_EDGES[j]));
      const b = !!(i & (1 << CUBE_EDGES[j + 1]));
      em |= a !== b ? 1 << (j >> 1) : 0;
    }
    EDGE_TABLE[i] = em;
  }
})();

// ============== Helper Functions ==============

/**
 * Create an empty SurfaceNetOutput.
 */
function emptyOutput(): SurfaceNetOutput {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    materials: new Uint8Array(0),
    vertexCount: 0,
    triangleCount: 0,
  };
}

// Weight to treat "other type" voxels as slightly outside surface
const FILTER_WEIGHT = -0.00001;

// ============== Reusable Typed Array Pools ==============
// Pre-allocated buffers that grow as needed. Avoids per-chunk allocation.
// Each mesh type (solid/trans/liquid) gets its own set of buffers.

/** Initial capacity in vertices per mesh type */
const INITIAL_VERT_CAPACITY = 4096;
/** Initial capacity in triangles per mesh type */
const INITIAL_TRI_CAPACITY = 8192;

/** Pool of typed array buffers for each mesh type */
interface MeshPool {
  positions: Float32Array;   // 3 floats per vertex
  normals: Float32Array;     // 3 floats per vertex
  materials: Uint8Array;     // 1 byte per vertex
  indices: Uint32Array;      // 3 uints per triangle
  vertCapacity: number;
  triCapacity: number;
}

const meshPools: MeshPool[] = [];
for (let i = 0; i < MESH_COUNT; ++i) {
  meshPools.push({
    positions: new Float32Array(INITIAL_VERT_CAPACITY * 3),
    normals: new Float32Array(INITIAL_VERT_CAPACITY * 3),
    materials: new Uint8Array(INITIAL_VERT_CAPACITY),
    indices: new Uint32Array(INITIAL_TRI_CAPACITY * 3),
    vertCapacity: INITIAL_VERT_CAPACITY,
    triCapacity: INITIAL_TRI_CAPACITY,
  });
}

/** Ensure pool has enough vertex capacity, growing by 2x if needed */
function ensureVertCapacity(pool: MeshPool, needed: number): void {
  if (needed <= pool.vertCapacity) return;
  let cap = pool.vertCapacity;
  while (cap < needed) cap <<= 1;
  const newPos = new Float32Array(cap * 3);
  newPos.set(pool.positions);
  pool.positions = newPos;
  const newNorm = new Float32Array(cap * 3);
  newNorm.set(pool.normals);
  pool.normals = newNorm;
  const newMat = new Uint8Array(cap);
  newMat.set(pool.materials);
  pool.materials = newMat;
  pool.vertCapacity = cap;
}

/** Ensure pool has enough triangle capacity, growing by 2x if needed */
function ensureTriCapacity(pool: MeshPool, needed: number): void {
  if (needed <= pool.triCapacity) return;
  let cap = pool.triCapacity;
  while (cap < needed) cap <<= 1;
  const newIdx = new Uint32Array(cap * 3);
  newIdx.set(pool.indices);
  pool.indices = newIdx;
  pool.triCapacity = cap;
}

// ============== Pre-computed Grid State (fixed for 34³ grid) ==============
// These are derived from GRID_SIZE which never changes at runtime.
// Hoisted to module level to avoid re-allocation on every meshVoxelsSplit() call.

/** Vertex index buffers for connecting faces (one per mesh type) */
const VERT_IDX_BUFFER_SIZE = (GRID_SIZE + 1) * (GRID_SIZE + 1) * 2;
const vertIdxBuffers = [
  new Int32Array(VERT_IDX_BUFFER_SIZE),
  new Int32Array(VERT_IDX_BUFFER_SIZE),
  new Int32Array(VERT_IDX_BUFFER_SIZE),
];

/** Per-mesh-type write cursors */
const vertCounts = new Int32Array(MESH_COUNT);
const triCounts = new Int32Array(MESH_COUNT);

/** SurfaceNet corner weight grids per mesh type */
const grids = [new Float32Array(8), new Float32Array(8), new Float32Array(8)];

/** Per-cell state for each mesh type (reused each cell) */
const masks = new Uint8Array(MESH_COUNT);
const maxIdxs = new Int32Array(MESH_COUNT);
const maxWeights = new Float32Array(MESH_COUNT);

/** Grid traversal position */
const xPos = new Int32Array(3);

/** High boundary positions (dims - 2, precomputed for 34³) */
const highBoundary = new Int32Array([GRID_SIZE - 2, GRID_SIZE - 2, GRID_SIZE - 2]);

/** 2x2x2 corner offsets into flat grid array (fixed for 34³) */
const cornerOffsets = new Int32Array([
  0,                                          // (0,0,0)
  1,                                          // (1,0,0)
  GRID_STRIDE_X,                              // (0,1,0)
  GRID_STRIDE_X + 1,                          // (1,1,0)
  GRID_STRIDE_XY,                             // (0,0,1)
  GRID_STRIDE_XY + 1,                         // (1,0,1)
  GRID_STRIDE_XY + GRID_STRIDE_X,             // (0,1,1)
  GRID_STRIDE_XY + GRID_STRIDE_X + 1,         // (1,1,1)
]);

/**
 * Generate meshes from voxel data using SurfaceNets algorithm.
 * 
 * SINGLE-PASS with MULTI-SURFACE: Traverses voxel grid once but generates
 * separate meshes for solid, transparent, and liquid materials.
 * 
 * Key insight: At material type boundaries, we need surfaces on BOTH sides.
 * This is achieved by treating "other type" voxels as air when computing each mask.
 * 
 * PERFORMANCE OPTIMIZATIONS:
 * - Pre-allocated typed array pools eliminate ~27K JS object allocations per chunk
 * - Inlined bit operations avoid ~314K function calls per chunk
 * - Write directly to Float32Array/Uint32Array, no buildOutput() copy step
 * - Normal accumulation uses flat Float32Array with 3-float stride
 * 
 * @param input Flat voxel data array and dimensions
 * @returns Split mesh outputs for solid, transparent, and liquid materials
 */
export function meshVoxelsSplit(input: SurfaceNetInput): SplitSurfaceNetOutput {
  const { dims, data, skipHighBoundary = [false, false, false] } = input;
  
  // Grid strides (constant for 34³ grid, but kept as locals for JIT hinting)
  const dimsX = dims[0];
  const dimsXY = dims[0] * dims[1];

  // === Early bail — use shared utility that respects bit layout constants ===
  if (!hasSurfaceCrossing(data)) {
    return { solid: emptyOutput(), transparent: emptyOutput(), liquid: emptyOutput() };
  }

  // Reset write cursors (pools/buffers are module-level, no allocation needed)
  vertCounts[0] = vertCounts[1] = vertCounts[2] = 0;
  triCounts[0] = triCounts[1] = triCounts[2] = 0;
  
  // Grid traversal state
  let n = 0;
  const x = xPos;
  x[0] = x[1] = x[2] = 0;
  const R = new Int32Array([1, dimsX + 1, (dimsX + 1) * (dims[1] + 1)]);
  
  let bufNo = 1;

  // March over the voxel grid
  for (x[2] = 0; x[2] < dims[2] - 1; ++x[2], n += dims[0], bufNo ^= 1, R[2] = -R[2]) {
    let m = 1 + (dims[0] + 1) * (1 + bufNo * (dims[1] + 1));

    for (x[1] = 0; x[1] < dims[1] - 1; ++x[1], ++n, m += 2) {
      for (x[0] = 0; x[0] < dims[0] - 1; ++x[0], ++n, ++m) {
        // Base index in flat array for current cell position
        const baseIdx = x[2] * dimsXY + x[1] * dimsX + x[0];
        
        // Reset per-mesh state
        masks[0] = masks[1] = masks[2] = 0;
        maxWeights[0] = maxWeights[1] = maxWeights[2] = -Infinity;
        maxIdxs[0] = maxIdxs[1] = maxIdxs[2] = baseIdx;

        // Sample 2x2x2 grid corners using pre-computed offsets
        // Bit operations use shared constants so changes to voxel layout propagate
        for (let g = 0; g < 8; ++g) {
          const idx = baseIdx + cornerOffsets[g];
          const voxel = data[idx];
          const weight = ((voxel >> WEIGHT_SHIFT) & WEIGHT_MASK) * INV_WEIGHT_MAX_PACKED + WEIGHT_MIN;
          const material = (voxel >> MATERIAL_SHIFT) & MATERIAL_MASK;
          const matType = MATERIAL_TYPE_LUT[material]; // 0=solid, 1=trans, 2=liquid
          
          // For each mesh type, compute adjusted weight
          // Own type keeps original weight, other types become air if solid
          for (let mt = 0; mt < MESH_COUNT; ++mt) {
            const adjustedWeight = (weight > 0 && matType !== mt) ? FILTER_WEIGHT : weight;
            grids[mt][g] = adjustedWeight;
            masks[mt] |= adjustedWeight < 0 ? 1 << g : 0;
            if (adjustedWeight > maxWeights[mt]) {
              maxWeights[mt] = adjustedWeight;
              maxIdxs[mt] = idx;
            }
          }
        }

        // Check boundary conditions
        const onLowBoundary = (x[0] === 0 || x[1] === 0 || x[2] === 0);
        const onHighBoundaryNoNeighbor = 
          (skipHighBoundary[0] && x[0] >= highBoundary[0] - 1) ||
          (skipHighBoundary[1] && x[1] >= highBoundary[1] - 1) ||
          (skipHighBoundary[2] && x[2] >= highBoundary[2] - 1);
        const ignoreFace = onLowBoundary || onHighBoundaryNoNeighbor;

        // Process each mesh type
        for (let mt = 0; mt < MESH_COUNT; ++mt) {
          const mask = masks[mt];
          if (mask === 0 || mask === 0xff) continue;
          
          const grid = grids[mt];
          const buffer = vertIdxBuffers[mt];
          const pool = meshPools[mt];
          
          const edgeMask = EDGE_TABLE[mask];
          
          // Compute vertex position (inline, no tuple allocation)
          let vx = 0, vy = 0, vz = 0;
          let eCount = 0;
          
          for (let ei = 0; ei < 12; ++ei) {
            if (!(edgeMask & (1 << ei))) continue;
            ++eCount;
            
            const e0 = CUBE_EDGES[ei << 1];
            const e1 = CUBE_EDGES[(ei << 1) + 1];
            const g0 = grid[e0];
            const g1 = grid[e1];
            let t = g0 - g1;
            
            if (Math.abs(t) > 1e-6) {
              t = g0 / t;
            } else {
              continue;
            }
            
            // Axis 0 (X)
            {
              const a = e0 & 1;
              const b = e1 & 1;
              if (a !== b) { vx += a ? 1.0 - t : t; }
              else { vx += a ? 1.0 : 0; }
            }
            // Axis 1 (Y)
            {
              const a = e0 & 2;
              const b = e1 & 2;
              if (a !== b) { vy += a ? 1.0 - t : t; }
              else { vy += a ? 1.0 : 0; }
            }
            // Axis 2 (Z)
            {
              const a = e0 & 4;
              const b = e1 & 4;
              if (a !== b) { vz += a ? 1.0 - t : t; }
              else { vz += a ? 1.0 : 0; }
            }
          }
          
          if (eCount > 0) {
            const s = 1.0 / eCount;
            const px = x[0] + s * vx;
            const py = x[1] + s * vy;
            const pz = x[2] + s * vz;
            
            // === 3a: Write directly to typed array pool ===
            const vertIdx = vertCounts[mt];
            ensureVertCapacity(pool, vertIdx + 1);
            buffer[m] = vertIdx;
            
            const v3 = vertIdx * 3;
            pool.positions[v3] = px;
            pool.positions[v3 + 1] = py;
            pool.positions[v3 + 2] = pz;
            // Initialize normal accumulator to zero
            pool.normals[v3] = 0;
            pool.normals[v3 + 1] = 0;
            pool.normals[v3 + 2] = 0;
            // Extract material using shared constants
            pool.materials[vertIdx] = (data[maxIdxs[mt]] >> MATERIAL_SHIFT) & MATERIAL_MASK;
            vertCounts[mt] = vertIdx + 1;
            
            // Generate faces
            for (let fi = 0; fi < 3; ++fi) {
              if (!(edgeMask & (1 << fi))) continue;
              
              const iu = (fi + 1) % 3;
              const iv = (fi + 2) % 3;
              
              if (x[iu] === 0 || x[iv] === 0) continue;
              
              const du = R[iu];
              const dv = R[iv];
              
              const idx0 = buffer[m];
              const idx1 = buffer[m - du];
              const idx2 = buffer[m - dv];
              const idx3 = buffer[m - du - dv];
              
              // Read vertex positions from typed arrays for normal computation
              const i0x3 = idx0 * 3, i1x3 = idx1 * 3, i2x3 = idx2 * 3, i3x3 = idx3 * 3;
              const pos = pool.positions;
              const nrm = pool.normals;
              
              // Compute face normals inline
              let e0x: number, e0y: number, e0z: number;
              let e1x: number, e1y: number, e1z: number;
              let nX: number, nY: number, nZ: number, lenSq: number, len: number;
              
              if (mask & 1) {
                // Face 1: idx1, idx0, idx3
                e0x = pos[i1x3] - pos[i0x3]; e0y = pos[i1x3+1] - pos[i0x3+1]; e0z = pos[i1x3+2] - pos[i0x3+2];
                e1x = pos[i3x3] - pos[i1x3]; e1y = pos[i3x3+1] - pos[i1x3+1]; e1z = pos[i3x3+2] - pos[i1x3+2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                nrm[i1x3] += nX; nrm[i1x3+1] += nY; nrm[i1x3+2] += nZ;
                nrm[i0x3] += nX; nrm[i0x3+1] += nY; nrm[i0x3+2] += nZ;
                nrm[i3x3] += nX; nrm[i3x3+1] += nY; nrm[i3x3+2] += nZ;
                
                // Face 2: idx2, idx3, idx0
                e0x = pos[i2x3] - pos[i3x3]; e0y = pos[i2x3+1] - pos[i3x3+1]; e0z = pos[i2x3+2] - pos[i3x3+2];
                e1x = pos[i0x3] - pos[i2x3]; e1y = pos[i0x3+1] - pos[i2x3+1]; e1z = pos[i0x3+2] - pos[i2x3+2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                nrm[i2x3] += nX; nrm[i2x3+1] += nY; nrm[i2x3+2] += nZ;
                nrm[i3x3] += nX; nrm[i3x3+1] += nY; nrm[i3x3+2] += nZ;
                nrm[i0x3] += nX; nrm[i0x3+1] += nY; nrm[i0x3+2] += nZ;
                
                if (!ignoreFace) {
                  ensureTriCapacity(pool, triCounts[mt] + 2);
                  const ti = triCounts[mt] * 3;
                  pool.indices[ti] = idx1; pool.indices[ti+1] = idx0; pool.indices[ti+2] = idx3;
                  pool.indices[ti+3] = idx2; pool.indices[ti+4] = idx3; pool.indices[ti+5] = idx0;
                  triCounts[mt] += 2;
                }
              } else {
                // Face 1: idx2, idx0, idx3
                e0x = pos[i2x3] - pos[i0x3]; e0y = pos[i2x3+1] - pos[i0x3+1]; e0z = pos[i2x3+2] - pos[i0x3+2];
                e1x = pos[i3x3] - pos[i2x3]; e1y = pos[i3x3+1] - pos[i2x3+1]; e1z = pos[i3x3+2] - pos[i2x3+2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                nrm[i2x3] += nX; nrm[i2x3+1] += nY; nrm[i2x3+2] += nZ;
                nrm[i0x3] += nX; nrm[i0x3+1] += nY; nrm[i0x3+2] += nZ;
                nrm[i3x3] += nX; nrm[i3x3+1] += nY; nrm[i3x3+2] += nZ;
                
                // Face 2: idx1, idx3, idx0
                e0x = pos[i1x3] - pos[i3x3]; e0y = pos[i1x3+1] - pos[i3x3+1]; e0z = pos[i1x3+2] - pos[i3x3+2];
                e1x = pos[i0x3] - pos[i1x3]; e1y = pos[i0x3+1] - pos[i1x3+1]; e1z = pos[i0x3+2] - pos[i1x3+2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                nrm[i1x3] += nX; nrm[i1x3+1] += nY; nrm[i1x3+2] += nZ;
                nrm[i3x3] += nX; nrm[i3x3+1] += nY; nrm[i3x3+2] += nZ;
                nrm[i0x3] += nX; nrm[i0x3+1] += nY; nrm[i0x3+2] += nZ;
                
                if (!ignoreFace) {
                  ensureTriCapacity(pool, triCounts[mt] + 2);
                  const ti = triCounts[mt] * 3;
                  pool.indices[ti] = idx2; pool.indices[ti+1] = idx0; pool.indices[ti+2] = idx3;
                  pool.indices[ti+3] = idx1; pool.indices[ti+4] = idx3; pool.indices[ti+5] = idx0;
                  triCounts[mt] += 2;
                }
              }
            }
          }
        }
      }
    }
  }

  // === Build final outputs by slicing typed arrays (no per-element copy) ===
  function buildFinalOutput(mt: number): SurfaceNetOutput {
    const vc = vertCounts[mt];
    const tc = triCounts[mt];
    if (tc === 0) return emptyOutput();
    
    const pool = meshPools[mt];
    
    // Normalize accumulated normals and negate (face normals point inward from winding)
    const normSrc = pool.normals;
    const normals = new Float32Array(vc * 3);
    for (let i = 0; i < vc; ++i) {
      const i3 = i * 3;
      const nx = normSrc[i3];
      const ny = normSrc[i3 + 1];
      const nz = normSrc[i3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0.0001) {
        const invLen = -1.0 / len;
        normals[i3] = nx * invLen;
        normals[i3 + 1] = ny * invLen;
        normals[i3 + 2] = nz * invLen;
      } else {
        normals[i3] = 0;
        normals[i3 + 1] = 1;
        normals[i3 + 2] = 0;
      }
    }
    
    return {
      positions: pool.positions.slice(0, vc * 3),
      normals,
      indices: pool.indices.slice(0, tc * 3),
      materials: pool.materials.slice(0, vc),
      vertexCount: vc,
      triangleCount: tc,
    };
  }

  return { 
    solid: buildFinalOutput(MESH_SOLID), 
    transparent: buildFinalOutput(MESH_TRANS), 
    liquid: buildFinalOutput(MESH_LIQUID) 
  };
}

/**
 * Check if a SurfaceNet output is empty (no geometry).
 */
export function isEmptyMesh(output: SurfaceNetOutput): boolean {
  return output.vertexCount === 0 || output.triangleCount === 0;
}
