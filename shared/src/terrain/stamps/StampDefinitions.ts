/**
 * Stamp definitions for procedural terrain features (trees, rocks)
 * Stamps are small voxel patterns that get applied on top of terrain
 */

// ============== Material IDs (from pallet.json indices) ==============

export const MAT_BARK = 4;      // bark2 - tree trunks
export const MAT_BARK_DARK = 5; // bark3 - variation
export const MAT_LEAVES = 48;   // leaves_trans - tree canopy
export const MAT_LEAVES2 = 49;  // leaves2_trans - variation
export const MAT_ROCK = 1;      // rock - boulders
export const MAT_ROCK2 = 3;     // rock2 - variation
export const MAT_ROCK_MOSS = 23; // rock_moss - mossy rocks

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
  
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        // Add irregularity using simple hash
        const hash = Math.sin(seed + x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
        const variation = (hash - Math.floor(hash)) * irregularity;
        const effectiveRadius = radius + variation - irregularity * 0.5;
        
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

/**
 * Generate a pine tree stamp variant
 */
function generatePineTree(variant: number): StampDefinition {
  const voxels: StampVoxel[] = [];
  
  // Variation parameters based on variant
  const heightBase = 24 + (variant % 3) * 4;  // 24-32 voxels tall (6-8m)
  const trunkRadius = 1 + (variant % 2) * 0.5;
  const canopyLayers = 3 + (variant % 2);
  const barkMaterial = variant % 2 === 0 ? MAT_BARK : MAT_BARK_DARK;
  const leafMaterial = variant % 2 === 0 ? MAT_LEAVES : MAT_LEAVES2;
  
  // Trunk
  voxels.push(...cylinder(0, 0, trunkRadius, 0, heightBase * 0.7, barkMaterial));
  
  // Canopy - layered cones
  const canopyStart = Math.floor(heightBase * 0.35);
  const canopyEnd = heightBase;
  const layerHeight = (canopyEnd - canopyStart) / canopyLayers;
  
  for (let layer = 0; layer < canopyLayers; layer++) {
    const layerY = canopyStart + layer * layerHeight;
    const layerRadius = 4 - layer * 0.8 + (variant % 3) * 0.5;
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
  
  // Variation parameters
  const heightBase = 20 + (variant % 4) * 3;  // 20-32 voxels (5-8m)
  const trunkRadius = 1.5 + (variant % 2) * 0.5;
  const canopyRadius = 5 + (variant % 3);
  const barkMaterial = variant % 2 === 0 ? MAT_BARK : MAT_BARK_DARK;
  const leafMaterial = variant % 2 === 0 ? MAT_LEAVES : MAT_LEAVES2;
  
  // Trunk
  const trunkHeight = Math.floor(heightBase * 0.5);
  voxels.push(...cylinder(0, 0, trunkRadius, 0, trunkHeight, barkMaterial));
  
  // Canopy - larger irregular sphere
  const canopyY = trunkHeight + canopyRadius * 0.3;
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
  const materials = [MAT_ROCK, MAT_ROCK2, MAT_ROCK_MOSS];
  const material = materials[variant % materials.length];
  
  // Flatten factor (rocks are wider than tall)
  const yScale = 0.6 + (variant % 3) * 0.1;
  
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

// ============== Stamp Registry ==============

const VARIANTS_PER_TYPE = 4;

/** Pre-generated stamp definitions */
const stampCache = new Map<string, StampDefinition>();

/**
 * Get a stamp definition by type and variant
 */
export function getStamp(type: StampType, variant: number): StampDefinition {
  const normalizedVariant = variant % VARIANTS_PER_TYPE;
  const key = `${type}:${normalizedVariant}`;
  
  let stamp = stampCache.get(key);
  if (!stamp) {
    stamp = createStamp(type, normalizedVariant);
    stampCache.set(key, stamp);
  }
  return stamp;
}

/**
 * Create a new stamp definition
 */
function createStamp(type: StampType, variant: number): StampDefinition {
  switch (type) {
    case StampType.TREE_PINE:
      return generatePineTree(variant);
    case StampType.TREE_OAK:
      return generateOakTree(variant);
    case StampType.ROCK_SMALL:
    case StampType.ROCK_MEDIUM:
    case StampType.ROCK_LARGE:
      return generateRock(type, variant);
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
