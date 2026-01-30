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
 */

import { getMaterial } from '@worldify/shared';

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
 * Input data for surface net meshing.
 * Provides access to voxel weights and packed voxel data.
 */
export interface SurfaceNetInput {
  /** Dimensions of the voxel grid [x, y, z] */
  dims: [number, number, number];
  /** Get weight at coordinates (negative = inside, positive = outside) */
  getWeight: (x: number, y: number, z: number) => number;
  /** Get packed voxel data at coordinates (for material lookup) */
  getVoxel: (x: number, y: number, z: number) => number;
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
 * Fast inverse square root
 */
function invSqrt(x: number): number {
  return 1.0 / Math.sqrt(x);
}

/**
 * Generate face normal from three vertices
 */
function generateFaceNormal(
  v0: [number, number, number],
  v1: [number, number, number],
  v2: [number, number, number]
): [number, number, number] {
  const e0x = v0[0] - v1[0];
  const e0y = v0[1] - v1[1];
  const e0z = v0[2] - v1[2];

  const e1x = v2[0] - v0[0];
  const e1y = v2[1] - v0[1];
  const e1z = v2[2] - v0[2];

  const nX = e0y * e1z - e0z * e1y;
  const nY = e0z * e1x - e0x * e1z;
  const nZ = e0x * e1y - e0y * e1x;

  const lenSq = nX * nX + nY * nY + nZ * nZ;
  if (lenSq < 0.000001) {
    return [0, 1, 0];
  }
  const l = invSqrt(lenSq);

  return [nX * l, nY * l, nZ * l];
}

/**
 * Accumulate normal into vertex normal accumulator
 */
function accumulateNormal(
  normalAccum: [number, number, number][],
  vertexIndex: number,
  normal: [number, number, number]
): void {
  normalAccum[vertexIndex][0] += normal[0];
  normalAccum[vertexIndex][1] += normal[1];
  normalAccum[vertexIndex][2] += normal[2];
}

/**
 * Generate a mesh from voxel data using SurfaceNets algorithm.
 * 
 * This is a pure function - give it voxel accessors and dimensions,
 * get back mesh geometry. No game-specific concepts.
 * 
 * @param input Voxel data accessors and dimensions
 * @returns SurfaceNet mesh output
 */
export function meshVoxels(input: SurfaceNetInput): SurfaceNetOutput {
  const { dims, getWeight, getVoxel, skipHighBoundary = [false, false, false] } = input;
  
  // High boundary positions where we skip faces if no neighbor exists
  // dims is CHUNK_SIZE+2, so dims[i]-2 = CHUNK_SIZE is the high boundary
  const highBoundary = [dims[0] - 2, dims[1] - 2, dims[2] - 2];

  // Vertex buffer - stores which vertex is at each grid position
  let buffer = new Int32Array(4096);
  
  // Output arrays
  const vertices: [number, number, number][] = [];
  const materialIndices: number[] = [];
  const faces: [number, number, number][] = [];
  const normalAccum: [number, number, number][] = [];

  // Grid traversal state
  let n = 0; // Flat 1D grid index
  const x = new Int32Array(3); // Current x,y,z coordinates
  const R = new Int32Array([1, dims[0] + 1, (dims[0] + 1) * (dims[1] + 1)]); // Axis strides
  const grid = new Float32Array(8); // Local 2x2x2 grid values
  let bufNo = 1; // Buffer alternation flag

  // Ensure buffer is large enough
  if (R[2] * 2 > buffer.length) {
    buffer = new Int32Array(R[2] * 2);
  }

  // March over the voxel grid
  for (x[2] = 0; x[2] < dims[2] - 1; ++x[2], n += dims[0], bufNo ^= 1, R[2] = -R[2]) {
    // Buffer pointer for this z-slice
    let m = 1 + (dims[0] + 1) * (1 + bufNo * (dims[1] + 1));

    for (x[1] = 0; x[1] < dims[1] - 1; ++x[1], ++n, m += 2) {
      for (x[0] = 0; x[0] < dims[0] - 1; ++x[0], ++n, ++m) {
        // Read 8 field values around this vertex and calculate mask
        let mask = 0;
        let g = 0;
        let pMax = -Infinity;
        let maxI = 0, maxJ = 0, maxK = 0;

        // Sample 2x2x2 grid
        for (let k = 0; k < 2; ++k) {
          for (let j = 0; j < 2; ++j) {
            for (let i = 0; i < 2; ++i, ++g) {
              // Get local coordinates
              const lx = x[0] + i;
              const ly = x[1] + j;
              const lz = x[2] + k;

              const p = getWeight(lx, ly, lz);
              grid[g] = p;
              
              // Build mask: bit is set if weight < 0 (inside surface)
              mask |= p < 0 ? 1 << g : 0;
              
              // Track max weight to find material
              if (p > pMax) {
                pMax = p;
                maxI = i;
                maxJ = j;
                maxK = k;
              }
            }
          }
        }

        // Skip if no surface crossing (all inside or all outside)
        if (mask === 0 || mask === 0xff) {
          continue;
        }

        // Sum up edge intersections to find vertex position
        const edgeMask = EDGE_TABLE[mask];
        const v: [number, number, number] = [0.0, 0.0, 0.0];
        let eCount = 0;

        // Check each of the 12 edges
        for (let i = 0; i < 12; ++i) {
          if (!(edgeMask & (1 << i))) {
            continue;
          }

          ++eCount;

          // Find intersection point on this edge
          const e0 = CUBE_EDGES[i << 1];
          const e1 = CUBE_EDGES[(i << 1) + 1];
          const g0 = grid[e0];
          const g1 = grid[e1];
          let t = g0 - g1;
          
          if (Math.abs(t) > 1e-6) {
            t = g0 / t;
          } else {
            continue;
          }

          // Interpolate position along edge
          for (let j = 0, k = 1; j < 3; ++j, k <<= 1) {
            const a = e0 & k;
            const b = e1 & k;
            if (a !== b) {
              v[j] += a ? 1.0 - t : t;
            } else {
              v[j] += a ? 1.0 : 0;
            }
          }
        }

        // Average edge intersections and add to coordinate
        if (eCount > 0) {
          const s = 1.0 / eCount;
          v[0] = x[0] + s * v[0];
          v[1] = x[1] + s * v[1];
          v[2] = x[2] + s * v[2];
        }

        // Store vertex index in buffer
        buffer[m] = vertices.length;
        vertices.push(v);
        normalAccum.push([0, 0, 0]);
        
        // Get material from the solid voxel (highest weight)
        const solidVoxel = getVoxel(x[0] + maxI, x[1] + maxJ, x[2] + maxK);
        materialIndices.push(getMaterial(solidVoxel));

        // Skip faces on low boundary (x=0, y=0, z=0) - those faces are rendered by adjacent chunk
        // Also skip faces on high boundary if no neighbor exists (nothing to stitch with)
        // Note: at x[i] = CHUNK_SIZE-1, the 2x2x2 grid samples x[i]+1 = CHUNK_SIZE which is in the margin
        const onLowBoundary = (x[0] === 0 || x[1] === 0 || x[2] === 0);
        const onHighBoundaryNoNeighbor = 
          (skipHighBoundary[0] && x[0] >= highBoundary[0] - 1) ||
          (skipHighBoundary[1] && x[1] >= highBoundary[1] - 1) ||
          (skipHighBoundary[2] && x[2] >= highBoundary[2] - 1);
        const ignoreFace = onLowBoundary || onHighBoundaryNoNeighbor;

        // Generate faces for edges along each axis
        for (let i = 0; i < 3; ++i) {
          if (!(edgeMask & (1 << i))) {
            continue;
          }

          const iu = (i + 1) % 3;
          const iv = (i + 2) % 3;

          // Skip if on low boundary (adjacent vertices don't exist in our buffer)
          if (x[iu] === 0 || x[iv] === 0) {
            continue;
          }

          // Look up adjacent vertices in buffer
          const du = R[iu];
          const dv = R[iv];

          // Generate triangles with correct winding based on corner sign
          if (mask & 1) {
            const norm = generateFaceNormal(
              vertices[buffer[m - du]],
              vertices[buffer[m]],
              vertices[buffer[m - du - dv]]
            );
            const norm2 = generateFaceNormal(
              vertices[buffer[m - dv]],
              vertices[buffer[m - du - dv]],
              vertices[buffer[m]]
            );

            if (!ignoreFace) {
              faces.push([buffer[m - du], buffer[m], buffer[m - du - dv]]);
              faces.push([buffer[m - dv], buffer[m - du - dv], buffer[m]]);
            }

            // Accumulate normals for smooth shading
            accumulateNormal(normalAccum, buffer[m - du], norm);
            accumulateNormal(normalAccum, buffer[m], norm);
            accumulateNormal(normalAccum, buffer[m - du - dv], norm);

            accumulateNormal(normalAccum, buffer[m - dv], norm2);
            accumulateNormal(normalAccum, buffer[m - du - dv], norm2);
            accumulateNormal(normalAccum, buffer[m], norm2);
          } else {
            const norm = generateFaceNormal(
              vertices[buffer[m - dv]],
              vertices[buffer[m]],
              vertices[buffer[m - du - dv]]
            );
            const norm2 = generateFaceNormal(
              vertices[buffer[m - du]],
              vertices[buffer[m - du - dv]],
              vertices[buffer[m]]
            );

            if (!ignoreFace) {
              faces.push([buffer[m - dv], buffer[m], buffer[m - du - dv]]);
              faces.push([buffer[m - du], buffer[m - du - dv], buffer[m]]);
            }

            // Accumulate normals for smooth shading
            accumulateNormal(normalAccum, buffer[m - dv], norm);
            accumulateNormal(normalAccum, buffer[m], norm);
            accumulateNormal(normalAccum, buffer[m - du - dv], norm);

            accumulateNormal(normalAccum, buffer[m - du], norm2);
            accumulateNormal(normalAccum, buffer[m - du - dv], norm2);
            accumulateNormal(normalAccum, buffer[m], norm2);
          }
        }
      }
    }
  }

  // Convert to output format
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
 * Check if a SurfaceNet output is empty (no geometry).
 */
export function isEmptyMesh(output: SurfaceNetOutput): boolean {
  return output.vertexCount === 0 || output.triangleCount === 0;
}
