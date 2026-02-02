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

import { getMaterial, getWeight as unpackWeight, MATERIAL_TYPE_LUT } from '@worldify/shared';

// ============== Constants ==============

/** Mesh type indices for array-based mesh slots */
const MESH_SOLID = 0;
const MESH_TRANS = 1;
const MESH_LIQUID = 2;
const MESH_COUNT = 3;

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
 * Build a SurfaceNetOutput from shared vertex data and a face list.
 */
function buildOutput(
  vertices: [number, number, number][],
  normalAccum: [number, number, number][],
  materialIndices: number[],
  faces: [number, number, number][]
): SurfaceNetOutput {
  const vertexCount = vertices.length;
  const triangleCount = faces.length;

  // Build position array
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = vertices[i][0];
    positions[i * 3 + 1] = vertices[i][1];
    positions[i * 3 + 2] = vertices[i][2];
  }

  // Build normalized normal array from accumulated normals
  // Negate normals because face normals point inward from winding
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const nx = normalAccum[i][0];
    const ny = normalAccum[i][1];
    const nz = normalAccum[i][2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0.0001) {
      normals[i * 3] = -nx / len;
      normals[i * 3 + 1] = -ny / len;
      normals[i * 3 + 2] = -nz / len;
    } else {
      normals[i * 3] = 0;
      normals[i * 3 + 1] = 1;
      normals[i * 3 + 2] = 0;
    }
  }

  // Build index array
  const indices = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < triangleCount; i++) {
    indices[i * 3] = faces[i][0];
    indices[i * 3 + 1] = faces[i][1];
    indices[i * 3 + 2] = faces[i][2];
  }

  // Build materials array
  const materials = new Uint8Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    materials[i] = materialIndices[i];
  }

  return {
    positions,
    normals,
    indices,
    materials,
    vertexCount,
    triangleCount,
  };
}

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

/**
 * Generate meshes from voxel data using SurfaceNets algorithm.
 * 
 * SINGLE-PASS with MULTI-SURFACE: Traverses voxel grid once but generates
 * separate meshes for solid, transparent, and liquid materials.
 * 
 * Key insight: At material type boundaries, we need surfaces on BOTH sides.
 * This is achieved by treating "other type" voxels as air when computing each mask.
 * 
 * PERFORMANCE: Uses array-based mesh slots to avoid code duplication while
 * maintaining zero function call overhead. Direct flat array access with
 * index arithmetic for cache-efficient voxel sampling.
 * 
 * @param input Flat voxel data array and dimensions
 * @returns Split mesh outputs for solid, transparent, and liquid materials
 */
export function meshVoxelsSplit(input: SurfaceNetInput): SplitSurfaceNetOutput {
  const { dims, data, skipHighBoundary = [false, false, false] } = input;
  
  // Pre-compute grid strides for index arithmetic
  const dimsX = dims[0];
  const dimsXY = dims[0] * dims[1];
  
  // High boundary positions where we skip faces if no neighbor exists
  const highBoundary = [dims[0] - 2, dims[1] - 2, dims[2] - 2];

  // Array-based mesh slots for each material type
  const bufferSize = (dims[0] + 1) * (dims[1] + 1) * 2;
  const buffers = [
    new Int32Array(bufferSize),
    new Int32Array(bufferSize),
    new Int32Array(bufferSize),
  ];
  const vertices: [number, number, number][][] = [[], [], []];
  const materials: number[][] = [[], [], []];
  const normalAccum: [number, number, number][][] = [[], [], []];
  const faces: [number, number, number][][] = [[], [], []];
  const grids = [new Float32Array(8), new Float32Array(8), new Float32Array(8)];
  
  // Per-cell state for each mesh type (reused each cell)
  const masks = new Uint8Array(MESH_COUNT);
  const maxIdxs = new Int32Array(MESH_COUNT);
  const maxWeights = new Float32Array(MESH_COUNT);

  // Grid traversal state
  let n = 0;
  const x = new Int32Array(3);
  const R = new Int32Array([1, dims[0] + 1, (dims[0] + 1) * (dims[1] + 1)]);
  
  // Reusable vertex position array (avoid allocation per cell)
  const v: [number, number, number] = [0, 0, 0];
  
  let bufNo = 1;

  // Pre-compute 2x2x2 corner offsets for index arithmetic
  const cornerOffsets = new Int32Array([
    0,                      // (0,0,0)
    1,                      // (1,0,0)
    dimsX,                  // (0,1,0)
    dimsX + 1,              // (1,1,0)
    dimsXY,                 // (0,0,1)
    dimsXY + 1,             // (1,0,1)
    dimsXY + dimsX,         // (0,1,1)
    dimsXY + dimsX + 1,     // (1,1,1)
  ]);

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
        for (let g = 0; g < 8; ++g) {
          const idx = baseIdx + cornerOffsets[g];
          const voxel = data[idx];
          const weight = unpackWeight(voxel);
          const material = getMaterial(voxel);
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
          const buffer = buffers[mt];
          const verts = vertices[mt];
          const norms = normalAccum[mt];
          const mats = materials[mt];
          const faceList = faces[mt];
          
          const edgeMask = EDGE_TABLE[mask];
          
          // Compute vertex position
          v[0] = 0; v[1] = 0; v[2] = 0;
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
            
            for (let axis = 0, bit = 1; axis < 3; ++axis, bit <<= 1) {
              const a = e0 & bit;
              const b = e1 & bit;
              if (a !== b) {
                v[axis] += a ? 1.0 - t : t;
              } else {
                v[axis] += a ? 1.0 : 0;
              }
            }
          }
          
          if (eCount > 0) {
            const s = 1.0 / eCount;
            const vx = x[0] + s * v[0];
            const vy = x[1] + s * v[1];
            const vz = x[2] + s * v[2];
            
            // Store vertex
            const vertIdx = verts.length;
            buffer[m] = vertIdx;
            verts.push([vx, vy, vz]);
            norms.push([0, 0, 0]);
            mats.push(getMaterial(data[maxIdxs[mt]]));
            
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
              
              const vert0 = verts[idx0];
              const vert1 = verts[idx1];
              const vert2 = verts[idx2];
              const vert3 = verts[idx3];
              
              // Compute face normals inline
              let e0x: number, e0y: number, e0z: number;
              let e1x: number, e1y: number, e1z: number;
              let nX: number, nY: number, nZ: number, lenSq: number, len: number;
              
              if (mask & 1) {
                // Face 1: idx1, idx0, idx3
                e0x = vert1[0] - vert0[0]; e0y = vert1[1] - vert0[1]; e0z = vert1[2] - vert0[2];
                e1x = vert3[0] - vert1[0]; e1y = vert3[1] - vert1[1]; e1z = vert3[2] - vert1[2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                norms[idx1][0] += nX; norms[idx1][1] += nY; norms[idx1][2] += nZ;
                norms[idx0][0] += nX; norms[idx0][1] += nY; norms[idx0][2] += nZ;
                norms[idx3][0] += nX; norms[idx3][1] += nY; norms[idx3][2] += nZ;
                
                // Face 2: idx2, idx3, idx0
                e0x = vert2[0] - vert3[0]; e0y = vert2[1] - vert3[1]; e0z = vert2[2] - vert3[2];
                e1x = vert0[0] - vert2[0]; e1y = vert0[1] - vert2[1]; e1z = vert0[2] - vert2[2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                norms[idx2][0] += nX; norms[idx2][1] += nY; norms[idx2][2] += nZ;
                norms[idx3][0] += nX; norms[idx3][1] += nY; norms[idx3][2] += nZ;
                norms[idx0][0] += nX; norms[idx0][1] += nY; norms[idx0][2] += nZ;
                
                if (!ignoreFace) {
                  faceList.push([idx1, idx0, idx3]);
                  faceList.push([idx2, idx3, idx0]);
                }
              } else {
                // Face 1: idx2, idx0, idx3
                e0x = vert2[0] - vert0[0]; e0y = vert2[1] - vert0[1]; e0z = vert2[2] - vert0[2];
                e1x = vert3[0] - vert2[0]; e1y = vert3[1] - vert2[1]; e1z = vert3[2] - vert2[2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                norms[idx2][0] += nX; norms[idx2][1] += nY; norms[idx2][2] += nZ;
                norms[idx0][0] += nX; norms[idx0][1] += nY; norms[idx0][2] += nZ;
                norms[idx3][0] += nX; norms[idx3][1] += nY; norms[idx3][2] += nZ;
                
                // Face 2: idx1, idx3, idx0
                e0x = vert1[0] - vert3[0]; e0y = vert1[1] - vert3[1]; e0z = vert1[2] - vert3[2];
                e1x = vert0[0] - vert1[0]; e1y = vert0[1] - vert1[1]; e1z = vert0[2] - vert1[2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                norms[idx1][0] += nX; norms[idx1][1] += nY; norms[idx1][2] += nZ;
                norms[idx3][0] += nX; norms[idx3][1] += nY; norms[idx3][2] += nZ;
                norms[idx0][0] += nX; norms[idx0][1] += nY; norms[idx0][2] += nZ;
                
                if (!ignoreFace) {
                  faceList.push([idx2, idx0, idx3]);
                  faceList.push([idx1, idx3, idx0]);
                }
              }
            }
          }
        }
      }
    }
  }

  // Build outputs for each mesh type
  const solid = faces[MESH_SOLID].length > 0 
    ? buildOutput(vertices[MESH_SOLID], normalAccum[MESH_SOLID], materials[MESH_SOLID], faces[MESH_SOLID])
    : emptyOutput();
    
  const transparent = faces[MESH_TRANS].length > 0
    ? buildOutput(vertices[MESH_TRANS], normalAccum[MESH_TRANS], materials[MESH_TRANS], faces[MESH_TRANS])
    : emptyOutput();
    
  const liquid = faces[MESH_LIQUID].length > 0
    ? buildOutput(vertices[MESH_LIQUID], normalAccum[MESH_LIQUID], materials[MESH_LIQUID], faces[MESH_LIQUID])
    : emptyOutput();

  return { solid, transparent, liquid };
}

/**
 * Check if a SurfaceNet output is empty (no geometry).
 */
export function isEmptyMesh(output: SurfaceNetOutput): boolean {
  return output.vertexCount === 0 || output.triangleCount === 0;
}
