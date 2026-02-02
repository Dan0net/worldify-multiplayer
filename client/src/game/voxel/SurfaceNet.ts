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

import { getMaterial, getWeight as unpackWeight, MATERIAL_TYPE_LUT, MAT_TYPE_TRANSPARENT } from '@worldify/shared';

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
 * Combined output with separate solid and transparent meshes.
 * Generated in a single pass for efficiency.
 */
export interface SplitSurfaceNetOutput {
  /** Mesh for solid (opaque) materials */
  solid: SurfaceNetOutput;
  /** Mesh for transparent materials */
  transparent: SurfaceNetOutput;
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
 * SINGLE-PASS with DUAL SURFACES: Traverses voxel grid once but generates
 * two separate meshes - one for solid materials, one for transparent.
 * 
 * Key insight: At solid↔transparent boundaries, we need surfaces on BOTH sides.
 * This is achieved by treating "other type" voxels as air when computing each mask:
 * - solidGrid: transparent voxels → air (weight = -0.00001)
 * - transGrid: solid voxels → air (weight = -0.00001)
 * 
 * PERFORMANCE: Uses direct flat array access with index arithmetic.
 * All vertex/face computation is inlined to avoid function call overhead.
 * 
 * @param input Flat voxel data array and dimensions
 * @returns Split mesh outputs for solid and transparent materials
 */
export function meshVoxelsSplit(input: SurfaceNetInput): SplitSurfaceNetOutput {
  const { dims, data, skipHighBoundary = [false, false, false] } = input;
  
  // Pre-compute grid strides for index arithmetic
  const dimsX = dims[0];
  const dimsXY = dims[0] * dims[1];
  
  // High boundary positions where we skip faces if no neighbor exists
  const highBoundary = [dims[0] - 2, dims[1] - 2, dims[2] - 2];

  // Separate vertex buffers for each mesh type
  const bufferSize = (dims[0] + 1) * (dims[1] + 1) * 2;
  const solidBuffer = new Int32Array(bufferSize);
  const transBuffer = new Int32Array(bufferSize);
  
  // Separate vertex data for each mesh
  const solidVertices: [number, number, number][] = [];
  const solidMaterials: number[] = [];
  const solidNormalAccum: [number, number, number][] = [];
  const solidFaces: [number, number, number][] = [];
  
  const transVertices: [number, number, number][] = [];
  const transMaterials: number[] = [];
  const transNormalAccum: [number, number, number][] = [];
  const transFaces: [number, number, number][] = [];

  // Grid traversal state
  let n = 0;
  const x = new Int32Array(3);
  const R = new Int32Array([1, dims[0] + 1, (dims[0] + 1) * (dims[1] + 1)]);
  
  // Two grids with adjusted weights (reused each cell)
  const solidGrid = new Float32Array(8);
  const transGrid = new Float32Array(8);
  
  // Reusable vertex position array (avoid allocation per cell)
  const v: [number, number, number] = [0, 0, 0];
  
  let bufNo = 1;

  // March over the voxel grid
  for (x[2] = 0; x[2] < dims[2] - 1; ++x[2], n += dims[0], bufNo ^= 1, R[2] = -R[2]) {
    let m = 1 + (dims[0] + 1) * (1 + bufNo * (dims[1] + 1));

    for (x[1] = 0; x[1] < dims[1] - 1; ++x[1], ++n, m += 2) {
      for (x[0] = 0; x[0] < dims[0] - 1; ++x[0], ++n, ++m) {
        // Sample 2x2x2 grid using direct index arithmetic
        // Base index in flat array for current cell position
        const baseIdx = x[2] * dimsXY + x[1] * dimsX + x[0];
        
        let solidMask = 0;
        let transMask = 0;
        let g = 0;
        
        // Track max weight voxels for material assignment
        let solidPMax = -Infinity;
        let solidMaxIdx = baseIdx;
        let transPMax = -Infinity;
        let transMaxIdx = baseIdx;

        // Sample 2x2x2 grid with inline index arithmetic
        // k=0, j=0, i=0
        let idx = baseIdx;
        let voxel = data[idx];
        let weight = unpackWeight(voxel);
        let material = getMaterial(voxel);
        let isTransparent = MATERIAL_TYPE_LUT[material] === MAT_TYPE_TRANSPARENT;
        let solidWeight = (weight > 0 && isTransparent) ? FILTER_WEIGHT : weight;
        let transWeight = (weight > 0 && !isTransparent) ? FILTER_WEIGHT : weight;
        solidGrid[g] = solidWeight;
        transGrid[g] = transWeight;
        solidMask |= solidWeight < 0 ? 1 << g : 0;
        transMask |= transWeight < 0 ? 1 << g : 0;
        if (solidWeight > solidPMax) { solidPMax = solidWeight; solidMaxIdx = idx; }
        if (transWeight > transPMax) { transPMax = transWeight; transMaxIdx = idx; }
        ++g;

        // k=0, j=0, i=1
        idx = baseIdx + 1;
        voxel = data[idx];
        weight = unpackWeight(voxel);
        material = getMaterial(voxel);
        isTransparent = MATERIAL_TYPE_LUT[material] === MAT_TYPE_TRANSPARENT;
        solidWeight = (weight > 0 && isTransparent) ? FILTER_WEIGHT : weight;
        transWeight = (weight > 0 && !isTransparent) ? FILTER_WEIGHT : weight;
        solidGrid[g] = solidWeight;
        transGrid[g] = transWeight;
        solidMask |= solidWeight < 0 ? 1 << g : 0;
        transMask |= transWeight < 0 ? 1 << g : 0;
        if (solidWeight > solidPMax) { solidPMax = solidWeight; solidMaxIdx = idx; }
        if (transWeight > transPMax) { transPMax = transWeight; transMaxIdx = idx; }
        ++g;

        // k=0, j=1, i=0
        idx = baseIdx + dimsX;
        voxel = data[idx];
        weight = unpackWeight(voxel);
        material = getMaterial(voxel);
        isTransparent = MATERIAL_TYPE_LUT[material] === MAT_TYPE_TRANSPARENT;
        solidWeight = (weight > 0 && isTransparent) ? FILTER_WEIGHT : weight;
        transWeight = (weight > 0 && !isTransparent) ? FILTER_WEIGHT : weight;
        solidGrid[g] = solidWeight;
        transGrid[g] = transWeight;
        solidMask |= solidWeight < 0 ? 1 << g : 0;
        transMask |= transWeight < 0 ? 1 << g : 0;
        if (solidWeight > solidPMax) { solidPMax = solidWeight; solidMaxIdx = idx; }
        if (transWeight > transPMax) { transPMax = transWeight; transMaxIdx = idx; }
        ++g;

        // k=0, j=1, i=1
        idx = baseIdx + dimsX + 1;
        voxel = data[idx];
        weight = unpackWeight(voxel);
        material = getMaterial(voxel);
        isTransparent = MATERIAL_TYPE_LUT[material] === MAT_TYPE_TRANSPARENT;
        solidWeight = (weight > 0 && isTransparent) ? FILTER_WEIGHT : weight;
        transWeight = (weight > 0 && !isTransparent) ? FILTER_WEIGHT : weight;
        solidGrid[g] = solidWeight;
        transGrid[g] = transWeight;
        solidMask |= solidWeight < 0 ? 1 << g : 0;
        transMask |= transWeight < 0 ? 1 << g : 0;
        if (solidWeight > solidPMax) { solidPMax = solidWeight; solidMaxIdx = idx; }
        if (transWeight > transPMax) { transPMax = transWeight; transMaxIdx = idx; }
        ++g;

        // k=1, j=0, i=0
        idx = baseIdx + dimsXY;
        voxel = data[idx];
        weight = unpackWeight(voxel);
        material = getMaterial(voxel);
        isTransparent = MATERIAL_TYPE_LUT[material] === MAT_TYPE_TRANSPARENT;
        solidWeight = (weight > 0 && isTransparent) ? FILTER_WEIGHT : weight;
        transWeight = (weight > 0 && !isTransparent) ? FILTER_WEIGHT : weight;
        solidGrid[g] = solidWeight;
        transGrid[g] = transWeight;
        solidMask |= solidWeight < 0 ? 1 << g : 0;
        transMask |= transWeight < 0 ? 1 << g : 0;
        if (solidWeight > solidPMax) { solidPMax = solidWeight; solidMaxIdx = idx; }
        if (transWeight > transPMax) { transPMax = transWeight; transMaxIdx = idx; }
        ++g;

        // k=1, j=0, i=1
        idx = baseIdx + dimsXY + 1;
        voxel = data[idx];
        weight = unpackWeight(voxel);
        material = getMaterial(voxel);
        isTransparent = MATERIAL_TYPE_LUT[material] === MAT_TYPE_TRANSPARENT;
        solidWeight = (weight > 0 && isTransparent) ? FILTER_WEIGHT : weight;
        transWeight = (weight > 0 && !isTransparent) ? FILTER_WEIGHT : weight;
        solidGrid[g] = solidWeight;
        transGrid[g] = transWeight;
        solidMask |= solidWeight < 0 ? 1 << g : 0;
        transMask |= transWeight < 0 ? 1 << g : 0;
        if (solidWeight > solidPMax) { solidPMax = solidWeight; solidMaxIdx = idx; }
        if (transWeight > transPMax) { transPMax = transWeight; transMaxIdx = idx; }
        ++g;

        // k=1, j=1, i=0
        idx = baseIdx + dimsXY + dimsX;
        voxel = data[idx];
        weight = unpackWeight(voxel);
        material = getMaterial(voxel);
        isTransparent = MATERIAL_TYPE_LUT[material] === MAT_TYPE_TRANSPARENT;
        solidWeight = (weight > 0 && isTransparent) ? FILTER_WEIGHT : weight;
        transWeight = (weight > 0 && !isTransparent) ? FILTER_WEIGHT : weight;
        solidGrid[g] = solidWeight;
        transGrid[g] = transWeight;
        solidMask |= solidWeight < 0 ? 1 << g : 0;
        transMask |= transWeight < 0 ? 1 << g : 0;
        if (solidWeight > solidPMax) { solidPMax = solidWeight; solidMaxIdx = idx; }
        if (transWeight > transPMax) { transPMax = transWeight; transMaxIdx = idx; }
        ++g;

        // k=1, j=1, i=1
        idx = baseIdx + dimsXY + dimsX + 1;
        voxel = data[idx];
        weight = unpackWeight(voxel);
        material = getMaterial(voxel);
        isTransparent = MATERIAL_TYPE_LUT[material] === MAT_TYPE_TRANSPARENT;
        solidWeight = (weight > 0 && isTransparent) ? FILTER_WEIGHT : weight;
        transWeight = (weight > 0 && !isTransparent) ? FILTER_WEIGHT : weight;
        solidGrid[g] = solidWeight;
        transGrid[g] = transWeight;
        solidMask |= solidWeight < 0 ? 1 << g : 0;
        transMask |= transWeight < 0 ? 1 << g : 0;
        if (solidWeight > solidPMax) { solidPMax = solidWeight; solidMaxIdx = idx; }
        if (transWeight > transPMax) { transPMax = transWeight; transMaxIdx = idx; }

        // Check boundary conditions
        const onLowBoundary = (x[0] === 0 || x[1] === 0 || x[2] === 0);
        const onHighBoundaryNoNeighbor = 
          (skipHighBoundary[0] && x[0] >= highBoundary[0] - 1) ||
          (skipHighBoundary[1] && x[1] >= highBoundary[1] - 1) ||
          (skipHighBoundary[2] && x[2] >= highBoundary[2] - 1);
        const ignoreFace = onLowBoundary || onHighBoundaryNoNeighbor;

        // ==================== SOLID MESH ====================
        if (solidMask !== 0 && solidMask !== 0xff) {
          const edgeMask = EDGE_TABLE[solidMask];
          
          // Compute vertex position inline
          v[0] = 0; v[1] = 0; v[2] = 0;
          let eCount = 0;
          
          for (let ei = 0; ei < 12; ++ei) {
            if (!(edgeMask & (1 << ei))) continue;
            ++eCount;
            
            const e0 = CUBE_EDGES[ei << 1];
            const e1 = CUBE_EDGES[(ei << 1) + 1];
            const g0 = solidGrid[e0];
            const g1 = solidGrid[e1];
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
            const vertIdx = solidVertices.length;
            solidBuffer[m] = vertIdx;
            solidVertices.push([vx, vy, vz]);
            solidNormalAccum.push([0, 0, 0]);
            
            solidMaterials.push(getMaterial(data[solidMaxIdx]));
            
            // Generate faces inline
            for (let fi = 0; fi < 3; ++fi) {
              if (!(edgeMask & (1 << fi))) continue;
              
              const iu = (fi + 1) % 3;
              const iv = (fi + 2) % 3;
              
              if (x[iu] === 0 || x[iv] === 0) continue;
              
              const du = R[iu];
              const dv = R[iv];
              
              const idx0 = solidBuffer[m];
              const idx1 = solidBuffer[m - du];
              const idx2 = solidBuffer[m - dv];
              const idx3 = solidBuffer[m - du - dv];
              
              const vert0 = solidVertices[idx0];
              const vert1 = solidVertices[idx1];
              const vert2 = solidVertices[idx2];
              const vert3 = solidVertices[idx3];
              
              // Compute face normals inline
              let e0x: number, e0y: number, e0z: number;
              let e1x: number, e1y: number, e1z: number;
              let nX: number, nY: number, nZ: number, lenSq: number, len: number;
              
              if (solidMask & 1) {
                // Face 1: idx1, idx0, idx3
                e0x = vert1[0] - vert0[0]; e0y = vert1[1] - vert0[1]; e0z = vert1[2] - vert0[2];
                e1x = vert3[0] - vert1[0]; e1y = vert3[1] - vert1[1]; e1z = vert3[2] - vert1[2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                solidNormalAccum[idx1][0] += nX; solidNormalAccum[idx1][1] += nY; solidNormalAccum[idx1][2] += nZ;
                solidNormalAccum[idx0][0] += nX; solidNormalAccum[idx0][1] += nY; solidNormalAccum[idx0][2] += nZ;
                solidNormalAccum[idx3][0] += nX; solidNormalAccum[idx3][1] += nY; solidNormalAccum[idx3][2] += nZ;
                
                // Face 2: idx2, idx3, idx0
                e0x = vert2[0] - vert3[0]; e0y = vert2[1] - vert3[1]; e0z = vert2[2] - vert3[2];
                e1x = vert0[0] - vert2[0]; e1y = vert0[1] - vert2[1]; e1z = vert0[2] - vert2[2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                solidNormalAccum[idx2][0] += nX; solidNormalAccum[idx2][1] += nY; solidNormalAccum[idx2][2] += nZ;
                solidNormalAccum[idx3][0] += nX; solidNormalAccum[idx3][1] += nY; solidNormalAccum[idx3][2] += nZ;
                solidNormalAccum[idx0][0] += nX; solidNormalAccum[idx0][1] += nY; solidNormalAccum[idx0][2] += nZ;
                
                if (!ignoreFace) {
                  solidFaces.push([idx1, idx0, idx3]);
                  solidFaces.push([idx2, idx3, idx0]);
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
                
                solidNormalAccum[idx2][0] += nX; solidNormalAccum[idx2][1] += nY; solidNormalAccum[idx2][2] += nZ;
                solidNormalAccum[idx0][0] += nX; solidNormalAccum[idx0][1] += nY; solidNormalAccum[idx0][2] += nZ;
                solidNormalAccum[idx3][0] += nX; solidNormalAccum[idx3][1] += nY; solidNormalAccum[idx3][2] += nZ;
                
                // Face 2: idx1, idx3, idx0
                e0x = vert1[0] - vert3[0]; e0y = vert1[1] - vert3[1]; e0z = vert1[2] - vert3[2];
                e1x = vert0[0] - vert1[0]; e1y = vert0[1] - vert1[1]; e1z = vert0[2] - vert1[2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                solidNormalAccum[idx1][0] += nX; solidNormalAccum[idx1][1] += nY; solidNormalAccum[idx1][2] += nZ;
                solidNormalAccum[idx3][0] += nX; solidNormalAccum[idx3][1] += nY; solidNormalAccum[idx3][2] += nZ;
                solidNormalAccum[idx0][0] += nX; solidNormalAccum[idx0][1] += nY; solidNormalAccum[idx0][2] += nZ;
                
                if (!ignoreFace) {
                  solidFaces.push([idx2, idx0, idx3]);
                  solidFaces.push([idx1, idx3, idx0]);
                }
              }
            }
          }
        }

        // ==================== TRANSPARENT MESH ====================
        if (transMask !== 0 && transMask !== 0xff) {
          const edgeMask = EDGE_TABLE[transMask];
          
          // Compute vertex position inline
          v[0] = 0; v[1] = 0; v[2] = 0;
          let eCount = 0;
          
          for (let ei = 0; ei < 12; ++ei) {
            if (!(edgeMask & (1 << ei))) continue;
            ++eCount;
            
            const e0 = CUBE_EDGES[ei << 1];
            const e1 = CUBE_EDGES[(ei << 1) + 1];
            const g0 = transGrid[e0];
            const g1 = transGrid[e1];
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
            const vertIdx = transVertices.length;
            transBuffer[m] = vertIdx;
            transVertices.push([vx, vy, vz]);
            transNormalAccum.push([0, 0, 0]);
            
            transMaterials.push(getMaterial(data[transMaxIdx]));
            
            // Generate faces inline
            for (let fi = 0; fi < 3; ++fi) {
              if (!(edgeMask & (1 << fi))) continue;
              
              const iu = (fi + 1) % 3;
              const iv = (fi + 2) % 3;
              
              if (x[iu] === 0 || x[iv] === 0) continue;
              
              const du = R[iu];
              const dv = R[iv];
              
              const idx0 = transBuffer[m];
              const idx1 = transBuffer[m - du];
              const idx2 = transBuffer[m - dv];
              const idx3 = transBuffer[m - du - dv];
              
              const vert0 = transVertices[idx0];
              const vert1 = transVertices[idx1];
              const vert2 = transVertices[idx2];
              const vert3 = transVertices[idx3];
              
              // Compute face normals inline
              let e0x: number, e0y: number, e0z: number;
              let e1x: number, e1y: number, e1z: number;
              let nX: number, nY: number, nZ: number, lenSq: number, len: number;
              
              if (transMask & 1) {
                // Face 1: idx1, idx0, idx3
                e0x = vert1[0] - vert0[0]; e0y = vert1[1] - vert0[1]; e0z = vert1[2] - vert0[2];
                e1x = vert3[0] - vert1[0]; e1y = vert3[1] - vert1[1]; e1z = vert3[2] - vert1[2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                transNormalAccum[idx1][0] += nX; transNormalAccum[idx1][1] += nY; transNormalAccum[idx1][2] += nZ;
                transNormalAccum[idx0][0] += nX; transNormalAccum[idx0][1] += nY; transNormalAccum[idx0][2] += nZ;
                transNormalAccum[idx3][0] += nX; transNormalAccum[idx3][1] += nY; transNormalAccum[idx3][2] += nZ;
                
                // Face 2: idx2, idx3, idx0
                e0x = vert2[0] - vert3[0]; e0y = vert2[1] - vert3[1]; e0z = vert2[2] - vert3[2];
                e1x = vert0[0] - vert2[0]; e1y = vert0[1] - vert2[1]; e1z = vert0[2] - vert2[2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                transNormalAccum[idx2][0] += nX; transNormalAccum[idx2][1] += nY; transNormalAccum[idx2][2] += nZ;
                transNormalAccum[idx3][0] += nX; transNormalAccum[idx3][1] += nY; transNormalAccum[idx3][2] += nZ;
                transNormalAccum[idx0][0] += nX; transNormalAccum[idx0][1] += nY; transNormalAccum[idx0][2] += nZ;
                
                if (!ignoreFace) {
                  transFaces.push([idx1, idx0, idx3]);
                  transFaces.push([idx2, idx3, idx0]);
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
                
                transNormalAccum[idx2][0] += nX; transNormalAccum[idx2][1] += nY; transNormalAccum[idx2][2] += nZ;
                transNormalAccum[idx0][0] += nX; transNormalAccum[idx0][1] += nY; transNormalAccum[idx0][2] += nZ;
                transNormalAccum[idx3][0] += nX; transNormalAccum[idx3][1] += nY; transNormalAccum[idx3][2] += nZ;
                
                // Face 2: idx1, idx3, idx0
                e0x = vert1[0] - vert3[0]; e0y = vert1[1] - vert3[1]; e0z = vert1[2] - vert3[2];
                e1x = vert0[0] - vert1[0]; e1y = vert0[1] - vert1[1]; e1z = vert0[2] - vert1[2];
                nX = e0y * e1z - e0z * e1y;
                nY = e0z * e1x - e0x * e1z;
                nZ = e0x * e1y - e0y * e1x;
                lenSq = nX * nX + nY * nY + nZ * nZ;
                if (lenSq < 0.000001) { nX = 0; nY = 1; nZ = 0; }
                else { len = 1.0 / Math.sqrt(lenSq); nX *= len; nY *= len; nZ *= len; }
                
                transNormalAccum[idx1][0] += nX; transNormalAccum[idx1][1] += nY; transNormalAccum[idx1][2] += nZ;
                transNormalAccum[idx3][0] += nX; transNormalAccum[idx3][1] += nY; transNormalAccum[idx3][2] += nZ;
                transNormalAccum[idx0][0] += nX; transNormalAccum[idx0][1] += nY; transNormalAccum[idx0][2] += nZ;
                
                if (!ignoreFace) {
                  transFaces.push([idx2, idx0, idx3]);
                  transFaces.push([idx1, idx3, idx0]);
                }
              }
            }
          }
        }
      }
    }
  }

  // Build outputs
  const solid = solidFaces.length > 0 
    ? buildOutput(solidVertices, solidNormalAccum, solidMaterials, solidFaces)
    : emptyOutput();
    
  const transparent = transFaces.length > 0
    ? buildOutput(transVertices, transNormalAccum, transMaterials, transFaces)
    : emptyOutput();

  return { solid, transparent };
}

/**
 * Check if a SurfaceNet output is empty (no geometry).
 */
export function isEmptyMesh(output: SurfaceNetOutput): boolean {
  return output.vertexCount === 0 || output.triangleCount === 0;
}
