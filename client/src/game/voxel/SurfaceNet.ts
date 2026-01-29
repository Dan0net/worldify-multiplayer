/**
 * SurfaceNet meshing algorithm for voxel terrain
 * 
 * Based on Mikola Lysenko's implementation:
 * https://github.com/mikolalysenko/mikolern-density
 * 
 * SurfaceNets work by:
 * 1. For each cell (2×2×2 voxels), check if surface crosses (sign change in weights)
 * 2. If crossing, place a vertex at the weighted average of edge crossings
 * 3. Connect vertices with quads where edges cross the surface
 */

import { CHUNK_SIZE, getMaterial } from '@worldify/shared';
import { Chunk } from './Chunk.js';

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

// Edge table for cube corners
// Each edge connects two corners - defines which corners form each of the 12 edges
const EDGE_TABLE: [number, number][] = [
  [0, 1], [1, 3], [3, 2], [2, 0], // Bottom face edges
  [4, 5], [5, 7], [7, 6], [6, 4], // Top face edges
  [0, 4], [1, 5], [2, 6], [3, 7], // Vertical edges
];

// Corner offsets for a 2x2x2 cell (x, y, z)
const CORNER_OFFSETS: [number, number, number][] = [
  [0, 0, 0], // 0
  [1, 0, 0], // 1
  [0, 0, 1], // 2
  [1, 0, 1], // 3
  [0, 1, 0], // 4
  [1, 1, 0], // 5
  [0, 1, 1], // 6
  [1, 1, 1], // 7
];



/**
 * Generate a mesh from chunk voxel data using SurfaceNets algorithm.
 * 
 * @param chunk The chunk to mesh
 * @param neighbors Map of neighbor chunks for margin sampling
 * @returns SurfaceNet mesh output
 */
export function meshChunk(chunk: Chunk, neighbors: Map<string, Chunk>): SurfaceNetOutput {
  // Pre-allocate buffers (will be trimmed at the end)
  const positions: number[] = [];
  const normals: number[] = [];
  const materials: number[] = [];
  const indices: number[] = [];

  // Grid to store vertex indices for each cell (for connecting faces)
  // We use CHUNK_SIZE+1 to include boundary cells that connect to neighbors
  const gridSize = CHUNK_SIZE + 1;
  const vertexGrid = new Int32Array(gridSize * gridSize * gridSize).fill(-1);

  const getGridIndex = (x: number, y: number, z: number): number => {
    return x + y * gridSize + z * gridSize * gridSize;
  };

  // Helper to get weight - uses margin for coordinates outside chunk bounds
  // Returns NaN for missing neighbors to skip surface generation at edges
  const getW = (x: number, y: number, z: number): number => {
    if (x >= 0 && x < CHUNK_SIZE && y >= 0 && y < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
      return chunk.getWeightAt(x, y, z);
    }
    // Check if neighbor exists
    const ncx = chunk.cx + (x < 0 ? -1 : x >= CHUNK_SIZE ? 1 : 0);
    const ncy = chunk.cy + (y < 0 ? -1 : y >= CHUNK_SIZE ? 1 : 0);
    const ncz = chunk.cz + (z < 0 ? -1 : z >= CHUNK_SIZE ? 1 : 0);
    
    if (ncx !== chunk.cx || ncy !== chunk.cy || ncz !== chunk.cz) {
      const neighborKey = `${ncx},${ncy},${ncz}`;
      if (!neighbors.has(neighborKey)) {
        return NaN; // Signal missing neighbor
      }
    }
    return chunk.getWeightWithMargin(x, y, z, neighbors);
  };

  // Helper to get voxel
  const getV = (x: number, y: number, z: number): number => {
    if (x >= 0 && x < CHUNK_SIZE && y >= 0 && y < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
      return chunk.getVoxel(x, y, z);
    }
    return chunk.getVoxelWithMargin(x, y, z, neighbors);
  };

  // Helper to check if a weight is valid (not from missing neighbor)
  const isValidWeight = (w: number): boolean => !isNaN(w);

  // First pass: find surface crossings and create vertices
  // Process all cells including boundary (using margin data for the +1 corners)
  // We iterate to CHUNK_SIZE (inclusive) to create vertices at chunk boundaries
  for (let z = 0; z <= CHUNK_SIZE; z++) {
    for (let y = 0; y <= CHUNK_SIZE; y++) {
      for (let x = 0; x <= CHUNK_SIZE; x++) {
        // Get weights at all 8 corners of the cell
        const cornerWeights: number[] = [];
        const cornerVoxels: number[] = [];
        let mask = 0;
        let hasInvalidCorner = false;

        for (let i = 0; i < 8; i++) {
          const [dx, dy, dz] = CORNER_OFFSETS[i];
          const w = getW(x + dx, y + dy, z + dz);
          cornerWeights.push(w);
          cornerVoxels.push(getV(x + dx, y + dy, z + dz));
          
          if (!isValidWeight(w)) {
            hasInvalidCorner = true;
          } else if (w > 0) {
            mask |= (1 << i);
          }
        }

        // Skip cells with missing neighbor data
        if (hasInvalidCorner) {
          continue;
        }

        // If all corners same sign, no surface crossing
        if (mask === 0 || mask === 0xff) {
          continue;
        }

        // Calculate vertex position by averaging edge crossings
        let vertX = 0, vertY = 0, vertZ = 0;
        let crossingCount = 0;

        for (let e = 0; e < 12; e++) {
          const [c0, c1] = EDGE_TABLE[e];
          const w0 = cornerWeights[c0];
          const w1 = cornerWeights[c1];

          // Check if edge crosses surface (different signs)
          if ((w0 > 0) !== (w1 > 0)) {
            // Interpolate crossing position
            const t = w0 / (w0 - w1);
            const [dx0, dy0, dz0] = CORNER_OFFSETS[c0];
            const [dx1, dy1, dz1] = CORNER_OFFSETS[c1];

            vertX += dx0 + t * (dx1 - dx0);
            vertY += dy0 + t * (dy1 - dy0);
            vertZ += dz0 + t * (dz1 - dz0);
            crossingCount++;
          }
        }

        if (crossingCount > 0) {
          // Average the crossing positions
          vertX = x + vertX / crossingCount;
          vertY = y + vertY / crossingCount;
          vertZ = z + vertZ / crossingCount;

          // Store vertex index in grid
          const gridIdx = getGridIndex(x, y, z);
          vertexGrid[gridIdx] = positions.length / 3;

          positions.push(vertX, vertY, vertZ);

          // Calculate normal using central differences at the vertex position
          // This produces smoother normals than using corner weights directly
          const vxi = Math.floor(vertX);
          const vyi = Math.floor(vertY);
          const vzi = Math.floor(vertZ);
          
          // Sample weight field around the vertex position using central differences
          const wxp = getW(vxi + 1, vyi, vzi);
          const wxn = getW(vxi - 1, vyi, vzi);
          const wyp = getW(vxi, vyi + 1, vzi);
          const wyn = getW(vxi, vyi - 1, vzi);
          const wzp = getW(vxi, vyi, vzi + 1);
          const wzn = getW(vxi, vyi, vzi - 1);
          
          // Gradient points from solid (positive weight) to air (negative weight)
          // Normal should point outward (from solid to air)
          let nx = (isValidWeight(wxp) && isValidWeight(wxn)) ? (wxn - wxp) : 0;
          let ny = (isValidWeight(wyp) && isValidWeight(wyn)) ? (wyn - wyp) : 0;
          let nz = (isValidWeight(wzp) && isValidWeight(wzn)) ? (wzn - wzp) : 0;

          // Normalize
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (len > 0.0001) {
            normals.push(nx / len, ny / len, nz / len);
          } else {
            normals.push(0, 1, 0); // Default up normal
          }

          // Get material from the solid corner (positive weight)
          let solidMaterial = 0;
          for (let i = 0; i < 8; i++) {
            if (cornerWeights[i] > 0) {
              solidMaterial = getMaterial(cornerVoxels[i]);
              break;
            }
          }
          materials.push(solidMaterial);
        }
      }
    }
  }

  // Second pass: connect vertices with quads
  // Iterate over all cells that can have vertices (including boundary)
  for (let z = 0; z <= CHUNK_SIZE; z++) {
    for (let y = 0; y <= CHUNK_SIZE; y++) {
      for (let x = 0; x <= CHUNK_SIZE; x++) {
        const v0 = vertexGrid[getGridIndex(x, y, z)];
        if (v0 < 0) continue;

        // Check each axis for quad generation
        for (let axis = 0; axis < 3; axis++) {
          // Get the two other axes
          const axis1 = (axis + 1) % 3;
          const axis2 = (axis + 2) % 3;

          // Check if we have all 4 vertices for a quad
          const coords1 = [x, y, z];
          const coords2 = [x, y, z];
          const coords3 = [x, y, z];

          coords1[axis1]++;
          coords2[axis2]++;
          coords3[axis1]++;
          coords3[axis2]++;

          // Skip if any vertex is outside the valid grid range (now CHUNK_SIZE+1)
          if (coords1[0] > CHUNK_SIZE || coords1[1] > CHUNK_SIZE || coords1[2] > CHUNK_SIZE) continue;
          if (coords2[0] > CHUNK_SIZE || coords2[1] > CHUNK_SIZE || coords2[2] > CHUNK_SIZE) continue;
          if (coords3[0] > CHUNK_SIZE || coords3[1] > CHUNK_SIZE || coords3[2] > CHUNK_SIZE) continue;

          const v1 = vertexGrid[getGridIndex(coords1[0], coords1[1], coords1[2])];
          const v2 = vertexGrid[getGridIndex(coords2[0], coords2[1], coords2[2])];
          const v3 = vertexGrid[getGridIndex(coords3[0], coords3[1], coords3[2])];

          if (v1 < 0 || v2 < 0 || v3 < 0) continue;

          // Check if edge along this axis crosses surface
          const w0 = getW(x, y, z);
          const offset = [0, 0, 0];
          offset[axis] = 1;
          const w1 = getW(x + offset[0], y + offset[1], z + offset[2]);

          if ((w0 > 0) === (w1 > 0)) continue;

          // Determine winding order based on which side is solid
          if (w0 > 0) {
            // Solid on negative side of axis (flip winding)
            indices.push(v0, v3, v1);
            indices.push(v0, v2, v3);
          } else {
            // Solid on positive side of axis (flip winding)
            indices.push(v0, v1, v3);
            indices.push(v0, v3, v2);
          }
        }
      }
    }
  }

  // Convert to typed arrays
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    materials: new Uint8Array(materials),
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
