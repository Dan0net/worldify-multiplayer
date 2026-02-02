/**
 * Stamp definitions for procedural terrain features (trees, rocks)
 * Stamps are small voxel patterns that get applied on top of terrain
 */

import { sdfBox, sdfCylinder } from '../../voxel/shapes.js';
import { mat } from '../../materials/index.js';

// SDF threshold for voxel inclusion - sqrt(2)/2 handles 45° rotations
const SDF_THRESHOLD = 0.71;

// ============== Types ==============

export interface StampVoxel {
  /** Offset from stamp origin (voxels) */
  x: number;
  y: number;
  z: number;
  /** Material ID */
  material: number;
  /** Weight value for smooth blending (-0.5 to 0.5) */
  weight: number;
}

export interface StampDefinition {
  /** Unique identifier for stamp type */
  type: StampType;
  /** Stamp variant index (0-n) */
  variant: number;
  /** Voxels relative to origin (ground level center) */
  voxels: StampVoxel[];
  /** Bounding box in voxels (for overlap detection) */
  bounds: {
    minX: number; maxX: number;
    minY: number; maxY: number;
    minZ: number; maxZ: number;
  };
}

export enum StampType {
  TREE_PINE = 'tree_pine',
  TREE_OAK = 'tree_oak',
  ROCK_SMALL = 'rock_small',
  ROCK_MEDIUM = 'rock_medium',
  ROCK_LARGE = 'rock_large',
  BUILDING_SMALL = 'building_small',
  BUILDING_HUT = 'building_hut',
}

// ============== Stamp Generation Helpers ==============

/**
 * Create a cylinder of voxels (used for tree trunks)
 */
function cylinder(
  centerX: number,
  centerZ: number,
  radius: number,
  yStart: number,
  yEnd: number,
  material: number
): StampVoxel[] {
  const voxels: StampVoxel[] = [];
  const r2 = radius * radius;
  
  for (let y = yStart; y < yEnd; y++) {
    for (let x = -Math.ceil(radius); x <= Math.ceil(radius); x++) {
      for (let z = -Math.ceil(radius); z <= Math.ceil(radius); z++) {
        const dist2 = x * x + z * z;
        if (dist2 <= r2) {
          // Smooth edge with weight based on distance
          const edgeDist = radius - Math.sqrt(dist2);
          const weight = Math.min(0.5, Math.max(-0.4, edgeDist * 0.5));
          voxels.push({
            x: centerX + x,
            y,
            z: centerZ + z,
            material,
            weight,
          });
        }
      }
    }
  }
  return voxels;
}

/**
 * Create a sphere of voxels (used for tree canopy, rocks)
 * Uses smooth low-frequency noise for blobby irregularities
 */
function sphere(
  centerX: number,
  centerY: number,
  centerZ: number,
  radius: number,
  material: number,
  irregularity: number = 0,
  seed: number = 0
): StampVoxel[] {
  const voxels: StampVoxel[] = [];
  const r = Math.ceil(radius);
  
  // Precompute smooth noise samples at low frequency for blobby variation
  // Sample at ~4 points around the sphere for smooth interpolation
  const noiseFreq = 0.3; // Lower = smoother blobs
  
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        // Smooth noise: combine multiple low-frequency sine waves for organic shape
        // This creates smooth undulations rather than per-voxel spikes
        const nx = x * noiseFreq;
        const ny = y * noiseFreq;
        const nz = z * noiseFreq;
        
        // Layered smooth noise (pseudo-simplex-like)
        const n1 = Math.sin(seed * 1.1 + nx * 1.7 + ny * 2.3 + nz * 1.9);
        const n2 = Math.sin(seed * 2.3 + nx * 2.1 - nz * 1.3 + ny * 1.7) * 0.5;
        const n3 = Math.sin(seed * 0.7 + ny * 1.9 + nz * 2.7 - nx * 1.1) * 0.3;
        const smoothNoise = (n1 + n2 + n3) / 1.8; // Normalize to roughly -1 to 1
        
        const variation = smoothNoise * irregularity;
        const effectiveRadius = radius + variation;
        
        const dist = Math.sqrt(x * x + y * y + z * z);
        if (dist <= effectiveRadius) {
          const edgeDist = effectiveRadius - dist;
          const weight = Math.min(0.5, Math.max(-0.4, edgeDist * 0.5));
          voxels.push({
            x: centerX + x,
            y: centerY + y,
            z: centerZ + z,
            material,
            weight,
          });
        }
      }
    }
  }
  return voxels;
}

/**
 * Calculate bounding box from voxels
 */
function calculateBounds(voxels: StampVoxel[]): StampDefinition['bounds'] {
  if (voxels.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }
  
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  for (const v of voxels) {
    minX = Math.min(minX, v.x);
    maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
    minZ = Math.min(minZ, v.z);
    maxZ = Math.max(maxZ, v.z);
  }
  
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

// ============== Stamp Generators ==============

// Shared tree constants for consistent appearance
const TREE_TRUNK_HEIGHT = 16;  // Fixed trunk height in voxels (4m) - canopy starts here

/**
 * Generate a pine tree stamp variant
 */
function generatePineTree(variant: number): StampDefinition {
  const voxels: StampVoxel[] = [];
  
  // Variation parameters based on variant
  const trunkRadius = 1.2 + (variant % 2) * 0.2;  // 1.2-1.4 - consistent with oak
  const canopyLayers = 3 + (variant % 2);
  const barkMaterial = variant % 2 === 0 ? mat('bark2') : mat('bark3');
  const leafMaterial = mat('leaves_trans_3');
  
  // Trunk - fixed height so canopies align
  voxels.push(...cylinder(0, 0, trunkRadius, 0, TREE_TRUNK_HEIGHT, barkMaterial));
  
  // Canopy - layered cones, 50% bigger
  const canopyStart = TREE_TRUNK_HEIGHT;  // Start at trunk top, same as oak
  const totalCanopyHeight = 20 + (variant % 3) * 4;  // 20-28 voxels of canopy
  const layerHeight = totalCanopyHeight / canopyLayers;
  
  for (let layer = 0; layer < canopyLayers; layer++) {
    const layerY = canopyStart + layer * layerHeight;
    // 50% bigger: 6-7.5 base radius instead of 4-5
    const layerRadius = (6 - layer * 1.2 + (variant % 3) * 0.75);
    const layerTop = layerY + layerHeight * 1.3;
    
    // Create tapered canopy layer
    for (let y = layerY; y < layerTop; y++) {
      const progress = (y - layerY) / (layerTop - layerY);
      const radius = layerRadius * (1 - progress * 0.7);
      voxels.push(...sphere(0, Math.floor(y), 0, radius, leafMaterial, 0.5, variant + layer));
    }
  }
  
  return {
    type: StampType.TREE_PINE,
    variant,
    voxels,
    bounds: calculateBounds(voxels),
  };
}

/**
 * Generate an oak tree stamp variant
 */
function generateOakTree(variant: number): StampDefinition {
  const voxels: StampVoxel[] = [];
  
  // Variation parameters - 50% bigger canopy
  const trunkRadius = 1.3 + (variant % 2) * 0.2;  // 1.3-1.5 - consistent with pine
  const canopyRadius = (7.5 + (variant % 3) * 1.5);  // 7.5-12 (was 5-8, now 50% bigger)
  const barkMaterial = variant % 2 === 0 ? mat('bark2') : mat('bark3');
  const leafMaterial = mat('leaves_trans_3');
  
  // Trunk - fixed height so canopies align with pine
  voxels.push(...cylinder(0, 0, trunkRadius, 0, TREE_TRUNK_HEIGHT, barkMaterial));
  
  // Canopy - larger irregular sphere centered above trunk
  const canopyY = TREE_TRUNK_HEIGHT + canopyRadius * 0.3;
  voxels.push(...sphere(0, Math.floor(canopyY), 0, canopyRadius, leafMaterial, 1.2, variant * 7));
  
  // Add some smaller spheres for irregular shape
  const offsets = [
    { x: canopyRadius * 0.5, z: 0 },
    { x: -canopyRadius * 0.4, z: canopyRadius * 0.3 },
    { x: 0, z: -canopyRadius * 0.5 },
  ];
  
  for (let i = 0; i < offsets.length; i++) {
    const off = offsets[i];
    voxels.push(...sphere(
      Math.floor(off.x),
      Math.floor(canopyY + (i - 1) * 1.5),
      Math.floor(off.z),
      canopyRadius * 0.6,
      leafMaterial,
      0.8,
      variant * 13 + i
    ));
  }
  
  return {
    type: StampType.TREE_OAK,
    variant,
    voxels,
    bounds: calculateBounds(voxels),
  };
}

/**
 * Generate a rock stamp variant
 */
function generateRock(type: StampType, variant: number): StampDefinition {
  let radius: number;
  switch (type) {
    case StampType.ROCK_SMALL:
      radius = 3 + (variant % 3) * 0.5;
      break;
    case StampType.ROCK_MEDIUM:
      radius = 5 + (variant % 3) * 0.8;
      break;
    case StampType.ROCK_LARGE:
      radius = 8 + (variant % 4) * 1.2;
      break;
    default:
      radius = 4;
  }
  
  // Material variation
  const materials = [mat('rock'), mat('rock2'), mat('rock_moss')];
  const material = materials[variant % materials.length];
  
  // Vertical scale factor (values > 1 make rocks taller)
  const yScale = 0.9 + (variant % 3) * 0.15;
  
  // Generate irregular sphere, centered slightly underground
  const voxels: StampVoxel[] = [];
  const r = Math.ceil(radius);
  
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        // Apply vertical squash
        const scaledY = y / yScale;
        
        // Irregularity
        const hash = Math.sin(variant + x * 12.9898 + scaledY * 78.233 + z * 37.719) * 43758.5453;
        const variation = (hash - Math.floor(hash)) * 0.8 - 0.4;
        const effectiveRadius = radius + variation;
        
        const dist = Math.sqrt(x * x + scaledY * scaledY + z * z);
        if (dist <= effectiveRadius) {
          const edgeDist = effectiveRadius - dist;
          const weight = Math.min(0.5, Math.max(-0.4, edgeDist * 0.4));
          voxels.push({
            x,
            y: y - Math.floor(radius * 0.15), // Sink into ground slightly (25-50% protrudes)
            z,
            material,
            weight,
          });
        }
      }
    }
  }
  
  return {
    type,
    variant,
    voxels,
    bounds: calculateBounds(voxels),
  };
}

// ============== SDF-Based Building Generators (With Rotation Support) ==============

/**
 * Rotate a 2D point around the origin by angle (radians)
 * Used to transform query points for rotated SDF sampling
 */
function rotateXZ(x: number, z: number, cos: number, sin: number): { rx: number; rz: number } {
  return {
    rx: x * cos + z * sin,
    rz: -x * sin + z * cos,
  };
}

/**
 * Generate a small rectangular building using proper SDF sampling with rotation
 */
function generateSmallBuildingSDF(variant: number, rotation: number): StampDefinition {
  const voxels: StampVoxel[] = [];
  
  // Variation parameters
  const widthBase = 24 + (variant % 3) * 12;   // 24-48 voxels (6-12m)
  const depthBase = Math.max(widthBase, 24 + (variant % 2) * 12);
  const heightBase = 14 + (variant % 3) * 2;  // 14-18 voxels (3.5-4.5m)
  
  // Material selection
  const wallMaterials = [mat('brick2'), mat('brick7'), mat('brick3')];
  const roofMaterials = [mat('roof'), mat('roof2')];
  const floorMaterials = [mat('brick8'), mat('tile3')];
  const wallMaterial = wallMaterials[variant % wallMaterials.length];
  const roofMaterial = roofMaterials[variant % roofMaterials.length];
  const floorMaterial = floorMaterials[variant % floorMaterials.length];
  const foundationMaterial = mat('cobble');
  
  const halfWidth = widthBase / 2;
  const halfDepth = depthBase / 2;
  const wallThickness = 2;  // 2 voxels for proper rotation support
  
  // Roof parameters
  const roofPeakHeight = Math.floor(widthBase / 2) + 2;
  const roofOverhang = 2;
  
  // Pre-compute rotation
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  
  // Door and window parameters
  const doorHalfWidth = 3;
  const doorHeight = 8;
  const windowY = 5;
  const windowHalfSize = 3;
  const windowHeight = 4;
  
  // Calculate bounding box with rotation margin
  const maxDim = Math.ceil(Math.max(halfWidth, halfDepth) + roofOverhang + 5);
  const maxHeight = heightBase + roofPeakHeight + 2;
  
  // Sample SDF over the entire bounding volume
  for (let y = -4; y <= maxHeight; y++) {
    for (let x = -maxDim; x <= maxDim; x++) {
      for (let z = -maxDim; z <= maxDim; z++) {
        // Rotate query point to local building space (inverse rotation)
        const { rx, rz } = rotateXZ(x, z, cos, -sin);
        
        // Evaluate what's at this rotated position using proper SDFs
        const voxelData = evaluateSmallBuildingSDF(
          rx, y, rz,
          halfWidth, halfDepth, heightBase, wallThickness,
          roofPeakHeight, roofOverhang,
          doorHalfWidth, doorHeight,
          windowY, windowHalfSize, windowHeight,
          wallMaterial, foundationMaterial, floorMaterial, roofMaterial
        );
        
        if (voxelData) {
          voxels.push({
            x, y, z,
            material: voxelData.material,
            weight: voxelData.weight,
          });
        }
      }
    }
  }
  
  return {
    type: StampType.BUILDING_SMALL,
    variant,
    voxels,
    bounds: calculateBounds(voxels),
  };
}

/**
 * Evaluate small building using proper SDF at a point in local (unrotated) space
 */
function evaluateSmallBuildingSDF(
  x: number, y: number, z: number,
  halfWidth: number, halfDepth: number, heightBase: number, wallThickness: number,
  roofPeakHeight: number, roofOverhang: number,
  doorHalfWidth: number, doorHeight: number,
  windowY: number, windowHalfSize: number, windowHeight: number,
  wallMaterial: number, foundationMaterial: number, floorMaterial: number, roofMaterial: number
): { material: number; weight: number } | null {
  
  // Foundation SDF (-4 to 0, extends slightly beyond walls)
  const foundationHalfHeight = 2;
  const foundationY = -2; // Center at y=-2
  const foundationDist = sdfBox(
    { x, y: y - foundationY, z },
    { x: halfWidth + 1, y: foundationHalfHeight, z: halfDepth + 1 }
  );
  if (foundationDist < SDF_THRESHOLD && y >= -4 && y <= 0) {
    return { material: foundationMaterial, weight: 0.45 };
  }
  
  // Stairs in front of door
  if (y >= -3 && y <= 0) {
    const stairStep = -y;
    for (let step = 0; step < 4; step++) {
      if (stairStep === step) {
        const stairZ = -halfDepth - 1.5 - step;
        const stairDist = sdfBox(
          { x, y: 0, z: z - stairZ },
          { x: doorHalfWidth, y: 0.5, z: 0.5 }
        );
        if (stairDist < SDF_THRESHOLD) {
          return { material: foundationMaterial, weight: 0.45 };
        }
      }
    }
  }
  
  // Doorway carving - extends through wall and slightly in front to clear terrain
  if (y >= 0 && y < doorHeight) {
    const doorwayDist = sdfBox(
      { x, y: y - doorHeight / 2, z: z + halfDepth + 1 },
      { x: doorHalfWidth + 0.5, y: doorHeight / 2, z: wallThickness + 2 }
    );
    if (doorwayDist < SDF_THRESHOLD) {
      return { material: 0, weight: -0.5 };  // Carve out doorway
    }
  }
  
  // Floor SDF (y = 0, inside walls)
  if (y >= 0 && y < 1) {
    const floorDist = sdfBox(
      { x, y: y - 0.5, z },
      { x: halfWidth - 0.5, y: 0.5, z: halfDepth - 0.5 }
    );
    if (floorDist < SDF_THRESHOLD) {
      return { material: floorMaterial, weight: 0.45 };
    }
  }
  
  // Interior air (carve out inside) - must check before walls
  if (y >= 1 && y < heightBase) {
    const interiorDist = sdfBox(
      { x, y: y - heightBase / 2, z },
      { x: halfWidth - wallThickness, y: heightBase / 2, z: halfDepth - wallThickness }
    );
    if (interiorDist < -SDF_THRESHOLD) {  // Well inside interior
      return { material: 0, weight: -0.5 };
    }
  }
  
  // Ceiling
  if (y >= heightBase - 1 && y <= heightBase) {
    const ceilingDist = sdfBox(
      { x, y: y - heightBase + 0.5, z },
      { x: halfWidth - 0.5, y: 0.5, z: halfDepth - 0.5 }
    );
    if (ceilingDist < SDF_THRESHOLD) {
      return { material: mat('concrete'), weight: 0.45 };
    }
  }
  
  // Walls using hollow box SDF
  if (y >= 1 && y <= heightBase) {
    // Outer box
    const outerDist = sdfBox(
      { x, y: y - (heightBase + 1) / 2, z },
      { x: halfWidth, y: heightBase / 2, z: halfDepth }
    );
    // Inner box (hollow)
    const innerDist = sdfBox(
      { x, y: y - (heightBase + 1) / 2, z },
      { x: halfWidth - wallThickness, y: heightBase / 2 + 1, z: halfDepth - wallThickness }
    );
    
    // Wall shell: inside outer, outside inner
    if (outerDist < SDF_THRESHOLD && innerDist > -SDF_THRESHOLD) {
      // Check for door (front wall, negative Z)
      if (z < -halfDepth + wallThickness + SDF_THRESHOLD && y <= doorHeight) {
        const doorDist = sdfBox(
          { x, y: y - doorHeight / 2, z: z + halfDepth },
          { x: doorHalfWidth, y: doorHeight / 2, z: wallThickness + 1 }
        );
        if (doorDist < SDF_THRESHOLD) {
          return null; // Door opening
        }
      }
      
      // Check for windows - carve terrain like interior
      const inWindowY = y >= windowY && y < windowY + windowHeight;
      if (inWindowY) {
        // Side windows (on X walls) - spaced further apart
        if (Math.abs(x) > halfWidth - wallThickness - SDF_THRESHOLD) {
          const numSideWindows = Math.max(1, Math.floor(halfDepth / 10));
          for (let w = 0; w < numSideWindows; w++) {
            const windowZ = -halfDepth / 2 + (w + 0.5) * (halfDepth / numSideWindows);
            const windowDist = sdfBox(
              { x: 0, y: y - windowY - windowHeight / 2, z: z - windowZ },
              { x: wallThickness + 1, y: windowHeight / 2, z: windowHalfSize }
            );
            if (windowDist < SDF_THRESHOLD) {
              return { material: 0, weight: -0.5 }; // Carve window opening
            }
          }
        }
        
        // Back windows (on positive Z wall) - spaced further apart
        if (z > halfDepth - wallThickness - SDF_THRESHOLD) {
          const numBackWindows = Math.max(1, Math.floor(halfWidth / 10));
          for (let w = 0; w < numBackWindows; w++) {
            const windowX = -halfWidth / 2 + (w + 0.5) * (halfWidth / numBackWindows);
            const windowDist = sdfBox(
              { x: x - windowX, y: y - windowY - windowHeight / 2, z: 0 },
              { x: windowHalfSize, y: windowHeight / 2, z: wallThickness + 1 }
            );
            if (windowDist < SDF_THRESHOLD) {
              return { material: 0, weight: -0.5 }; // Carve window opening
            }
          }
        }
      }
      
      return { material: wallMaterial, weight: 0.45 };
    }
  }
  
  // Pitched roof
  if (y > heightBase && y <= heightBase + roofPeakHeight) {
    const roofY = y - heightBase - 1;
    const halfWidthAtY = halfWidth + roofOverhang - roofY * 0.8;
    
    if (halfWidthAtY >= 0) {
      const roofDist = sdfBox(
        { x, y: 0, z },
        { x: halfWidthAtY, y: 0.5, z: halfDepth + roofOverhang }
      );
      if (roofDist < SDF_THRESHOLD) {
        return { material: roofMaterial, weight: 0.45 };
      }
    }
  }
  
  return null;
}

/**
 * Generate a round hut using proper SDF sampling with rotation
 */
function generateHutSDF(variant: number, rotation: number): StampDefinition {
  const voxels: StampVoxel[] = [];
  
  // Variation parameters
  const radius = 10 + (variant % 3) * 2;      // 10-14 voxels radius
  const wallHeight = 12 + (variant % 2) * 2;  // 12-14 voxels
  const roofHeight = radius + 3;
  
  // Material selection
  const wallMaterials = [mat('wood'), mat('wood2')];
  const roofMaterials = [mat('roof'), mat('roof2'), mat('metal')];
  const floorMaterial = mat('cobble2');
  const foundationMaterial = mat('stone2');
  const wallMaterial = wallMaterials[variant % wallMaterials.length];
  const roofMaterial = roofMaterials[variant % roofMaterials.length];
  
  const wallThickness = 2;
  const doorHalfWidth = 3;
  const doorHeight = 8;
  const windowY = 5;
  const windowHeight = 4;
  const windowHalfWidth = 3;
  
  // Pre-compute rotation
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  
  // Bounding box with margin for rotation
  const maxDim = radius + 5;
  const maxHeight = wallHeight + roofHeight + 2;
  
  // Sample SDF over the entire bounding volume
  for (let y = -2; y <= maxHeight; y++) {
    for (let x = -maxDim; x <= maxDim; x++) {
      for (let z = -maxDim; z <= maxDim; z++) {
        // Rotate query point to local building space (inverse rotation)
        const { rx, rz } = rotateXZ(x, z, cos, -sin);
        
        // Evaluate what's at this rotated position using proper SDFs
        const voxelData = evaluateHutSDF(
          rx, y, rz,
          radius, wallHeight, roofHeight, wallThickness,
          doorHalfWidth, doorHeight,
          windowY, windowHeight, windowHalfWidth,
          wallMaterial, foundationMaterial, floorMaterial, roofMaterial
        );
        
        if (voxelData) {
          voxels.push({
            x, y, z,
            material: voxelData.material,
            weight: voxelData.weight,
          });
        }
      }
    }
  }
  
  return {
    type: StampType.BUILDING_HUT,
    variant,
    voxels,
    bounds: calculateBounds(voxels),
  };
}

/**
 * Evaluate hut using proper SDF at a point in local (unrotated) space
 */
function evaluateHutSDF(
  x: number, y: number, z: number,
  radius: number, wallHeight: number, roofHeight: number, wallThickness: number,
  doorHalfWidth: number, doorHeight: number,
  windowY: number, windowHeight: number, windowHalfWidth: number,
  wallMaterial: number, foundationMaterial: number, floorMaterial: number, roofMaterial: number
): { material: number; weight: number } | null {
  
  // Foundation SDF (-2 to 0)
  if (y >= -2 && y < 0) {
    const foundationDist = sdfCylinder({ x, y: y + 1, z }, radius + 1, 1);
    if (foundationDist < SDF_THRESHOLD) {
      return { material: foundationMaterial, weight: 0.45 };
    }
    // Stairs in front of door
    const stairStep = -y - 1;
    if (stairStep >= 0 && stairStep < 4) {
      const stairZ = -radius - 1.5 - stairStep;
      const stairDist = sdfBox(
        { x, y: 0, z: z - stairZ },
        { x: doorHalfWidth, y: 0.5, z: 0.5 }
      );
      if (stairDist < SDF_THRESHOLD) {
        return { material: foundationMaterial, weight: 0.45 };
      }
    }
  }
  
  // Doorway carving - extends through wall and slightly in front to clear terrain
  if (y >= 0 && y < doorHeight) {
    const doorwayDist = sdfBox(
      { x, y: y - doorHeight / 2, z: z + radius + 1 },
      { x: doorHalfWidth + 0.5, y: doorHeight / 2, z: wallThickness + 2 }
    );
    if (doorwayDist < SDF_THRESHOLD) {
      return { material: 0, weight: -0.5 };  // Carve out doorway
    }
  }
  
  // Floor (y = 0)
  if (y >= 0 && y < 1) {
    const floorDist = sdfCylinder({ x, y: y - 0.5, z }, radius, 0.5);
    if (floorDist < SDF_THRESHOLD) {
      return { material: floorMaterial, weight: 0.45 };
    }
  }
  
  // Interior air
  if (y >= 1 && y < wallHeight - 1) {
    const interiorDist = sdfCylinder({ x, y: y - wallHeight / 2, z }, radius - wallThickness, wallHeight / 2);
    if (interiorDist < -SDF_THRESHOLD) {
      return { material: 0, weight: -0.5 };
    }
  }
  
  // Ceiling
  if (y >= wallHeight - 2 && y < wallHeight) {
    const ceilingDist = sdfCylinder({ x, y: y - wallHeight + 1, z }, radius - wallThickness, 1);
    if (ceilingDist < SDF_THRESHOLD) {
      return { material: mat('concrete'), weight: 0.45 };
    }
  }
  
  // Walls (hollow cylinder)
  if (y >= 1 && y < wallHeight) {
    const outerDist = sdfCylinder({ x, y: y - wallHeight / 2, z }, radius, wallHeight / 2);
    const innerDist = sdfCylinder({ x, y: y - wallHeight / 2, z }, radius - wallThickness, wallHeight / 2 + 1);
    
    // Wall shell: inside outer, outside inner
    if (outerDist < SDF_THRESHOLD && innerDist > -SDF_THRESHOLD) {
      // Door opening (negative Z side)
      if (z < -radius + wallThickness + SDF_THRESHOLD && y < doorHeight) {
        const doorDist = sdfBox(
          { x, y: y - doorHeight / 2, z: z + radius },
          { x: doorHalfWidth, y: doorHeight / 2, z: wallThickness + 1 }
        );
        if (doorDist < SDF_THRESHOLD) {
          return null;
        }
      }
      
      // Window openings - carve terrain like interior
      const inWindowY = y >= windowY && y < windowY + windowHeight;
      if (inWindowY) {
        // Left window (negative X)
        if (x < -radius + wallThickness + SDF_THRESHOLD) {
          const windowDist = sdfBox(
            { x: x + radius, y: y - windowY - windowHeight / 2, z },
            { x: wallThickness + 2, y: windowHeight / 2, z: windowHalfWidth }
          );
          if (windowDist < SDF_THRESHOLD) {
            return { material: 0, weight: -0.5 }; // Carve window opening
          }
        }
        // Right window (positive X)
        if (x > radius - wallThickness - SDF_THRESHOLD) {
          const windowDist = sdfBox(
            { x: x - radius, y: y - windowY - windowHeight / 2, z },
            { x: wallThickness + 2, y: windowHeight / 2, z: windowHalfWidth }
          );
          if (windowDist < SDF_THRESHOLD) {
            return { material: 0, weight: -0.5 }; // Carve window opening
          }
        }
        // Back window (positive Z)
        if (z > radius - wallThickness - SDF_THRESHOLD) {
          const windowDist = sdfBox(
            { x, y: y - windowY - windowHeight / 2, z: z - radius },
            { x: windowHalfWidth, y: windowHeight / 2, z: wallThickness + 2 }
          );
          if (windowDist < SDF_THRESHOLD) {
            return { material: 0, weight: -0.5 }; // Carve window opening
          }
        }
      }
      
      return { material: wallMaterial, weight: 0.45 };
    }
  }
  
  // Conical roof
  if (y >= wallHeight && y < wallHeight + roofHeight) {
    const roofY = y - wallHeight;
    const roofRadius = radius + 1 - (roofY * (radius + 1) / roofHeight);
    const roofDist = sdfCylinder({ x, y: 0, z }, roofRadius, 0.5);
    if (roofDist < SDF_THRESHOLD) {
      return { material: roofMaterial, weight: 0.45 };
    }
  }
  
  return null;
}

// ============== Stamp Registry ==============

const VARIANTS_PER_TYPE = 4;

/**
 * Check if a stamp type is a building that supports rotation
 */
export function isRotatableStamp(type: StampType): boolean {
  return type === StampType.BUILDING_SMALL || type === StampType.BUILDING_HUT;
}

/**
 * Get a stamp definition by type, variant, and optional rotation
 * Buildings are generated fresh each time with rotation applied to SDF sampling
 * Non-buildings are cached by type+variant
 * 
 * @param type - Stamp type
 * @param variant - Variant index (0-3)
 * @param rotation - Rotation in radians around Y axis (only used for buildings)
 */
export function getStamp(type: StampType, variant: number, rotation: number = 0): StampDefinition {
  const normalizedVariant = variant % VARIANTS_PER_TYPE;
  
  // Buildings are generated fresh with rotation - no caching
  if (isRotatableStamp(type)) {
    return createStamp(type, normalizedVariant, rotation);
  }
  
  // Non-buildings are cached (trees, rocks don't need rotation)
  const key = `${type}:${normalizedVariant}`;
  let stamp = stampCacheNonBuildings.get(key);
  if (!stamp) {
    stamp = createStamp(type, normalizedVariant, 0);
    stampCacheNonBuildings.set(key, stamp);
  }
  return stamp;
}

/** Cache for non-building stamps only (trees, rocks) */
const stampCacheNonBuildings = new Map<string, StampDefinition>();

/**
 * Create a new stamp definition
 */
function createStamp(type: StampType, variant: number, rotation: number = 0): StampDefinition {
  switch (type) {
    case StampType.TREE_PINE:
      return generatePineTree(variant);
    case StampType.TREE_OAK:
      return generateOakTree(variant);
    case StampType.ROCK_SMALL:
    case StampType.ROCK_MEDIUM:
    case StampType.ROCK_LARGE:
      return generateRock(type, variant);
    case StampType.BUILDING_SMALL:
      return generateSmallBuildingSDF(variant, rotation);
    case StampType.BUILDING_HUT:
      return generateHutSDF(variant, rotation);
    default:
      throw new Error(`Unknown stamp type: ${type}`);
  }
}

/**
 * Get the number of variants for a stamp type
 */
export function getVariantCount(): number {
  return VARIANTS_PER_TYPE;
}

/**
 * Get all stamp types
 */
export function getAllStampTypes(): StampType[] {
  return Object.values(StampType);
}
