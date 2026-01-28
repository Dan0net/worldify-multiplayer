/**
 * Unit tests for voxel data utilities
 * Run with: npx tsx shared/src/voxel/voxelData.test.ts
 */

import {
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  VOXELS_PER_CHUNK,
  WEIGHT_MIN,
  WEIGHT_MAX,
} from './constants.js';

import {
  packVoxel,
  unpackVoxel,
  getWeight,
  getMaterial,
  getLight,
  setWeight,
  setMaterial,
  setLight,
  worldToChunk,
  chunkToWorld,
  worldToVoxel,
  voxelToWorld,
  voxelIndex,
  indexToVoxel,
  globalVoxelToLocal,
  chunkKey,
  parseChunkKey,
  isInChunkBounds,
} from './voxelData.js';

// Simple test runner
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${e}`);
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toBeCloseTo(expected: number, precision = 2) {
      const diff = Math.abs((actual as number) - expected);
      if (diff > Math.pow(10, -precision)) {
        throw new Error(`Expected ${expected} (±${Math.pow(10, -precision)}), got ${actual}`);
      }
    },
    toEqual(expected: T) {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr}, got ${actualStr}`);
      }
    },
  };
}

console.log('\n=== Voxel Data Tests ===\n');

// ============== Pack/Unpack Round-trip Tests ==============

test('packVoxel(0.0, 5, 16) round-trips correctly', () => {
  const packed = packVoxel(0.0, 5, 16);
  const unpacked = unpackVoxel(packed);
  expect(unpacked.weight).toBeCloseTo(0.0, 1);
  expect(unpacked.material).toBe(5);
  expect(unpacked.light).toBe(16);
});

test('Weight edge case: -0.5 round-trips correctly', () => {
  const packed = packVoxel(-0.5, 0, 0);
  const unpacked = unpackVoxel(packed);
  expect(unpacked.weight).toBeCloseTo(WEIGHT_MIN, 2);
});

test('Weight edge case: +0.5 round-trips correctly', () => {
  const packed = packVoxel(0.5, 0, 0);
  const unpacked = unpackVoxel(packed);
  expect(unpacked.weight).toBeCloseTo(WEIGHT_MAX, 2);
});

test('Maximum material value (127) round-trips', () => {
  const packed = packVoxel(0.0, 127, 0);
  const unpacked = unpackVoxel(packed);
  expect(unpacked.material).toBe(127);
});

test('Maximum light value (31) round-trips', () => {
  const packed = packVoxel(0.0, 0, 31);
  const unpacked = unpackVoxel(packed);
  expect(unpacked.light).toBe(31);
});

test('All fields at max values round-trip', () => {
  const packed = packVoxel(0.5, 127, 31);
  const unpacked = unpackVoxel(packed);
  expect(unpacked.weight).toBeCloseTo(0.5, 2);
  expect(unpacked.material).toBe(127);
  expect(unpacked.light).toBe(31);
});

test('All fields at min values round-trip', () => {
  const packed = packVoxel(-0.5, 0, 0);
  const unpacked = unpackVoxel(packed);
  expect(unpacked.weight).toBeCloseTo(-0.5, 2);
  expect(unpacked.material).toBe(0);
  expect(unpacked.light).toBe(0);
});

// ============== Individual Getter Tests ==============

test('getWeight extracts weight correctly', () => {
  const packed = packVoxel(0.25, 10, 5);
  expect(getWeight(packed)).toBeCloseTo(0.25, 1);
});

test('getMaterial extracts material correctly', () => {
  const packed = packVoxel(0.0, 42, 0);
  expect(getMaterial(packed)).toBe(42);
});

test('getLight extracts light correctly', () => {
  const packed = packVoxel(0.0, 0, 20);
  expect(getLight(packed)).toBe(20);
});

// ============== Setter Tests ==============

test('setWeight updates only weight', () => {
  const packed = packVoxel(0.0, 50, 25);
  const updated = setWeight(packed, 0.3);
  const unpacked = unpackVoxel(updated);
  expect(unpacked.weight).toBeCloseTo(0.3, 1);
  expect(unpacked.material).toBe(50);
  expect(unpacked.light).toBe(25);
});

test('setMaterial updates only material', () => {
  const packed = packVoxel(0.2, 50, 25);
  const updated = setMaterial(packed, 100);
  const unpacked = unpackVoxel(updated);
  expect(unpacked.weight).toBeCloseTo(0.2, 1);
  expect(unpacked.material).toBe(100);
  expect(unpacked.light).toBe(25);
});

test('setLight updates only light', () => {
  const packed = packVoxel(0.2, 50, 25);
  const updated = setLight(packed, 5);
  const unpacked = unpackVoxel(updated);
  expect(unpacked.weight).toBeCloseTo(0.2, 1);
  expect(unpacked.material).toBe(50);
  expect(unpacked.light).toBe(5);
});

// ============== Coordinate Conversion Tests ==============

test('worldToChunk(8.1, 0, 0) returns (1, 0, 0)', () => {
  const result = worldToChunk(8.1, 0, 0);
  expect(result.cx).toBe(1);
  expect(result.cy).toBe(0);
  expect(result.cz).toBe(0);
});

test('worldToChunk at origin', () => {
  const result = worldToChunk(0, 0, 0);
  expect(result.cx).toBe(0);
  expect(result.cy).toBe(0);
  expect(result.cz).toBe(0);
});

test('worldToChunk handles negative coordinates', () => {
  const result = worldToChunk(-1, -8.5, -0.1);
  expect(result.cx).toBe(-1);
  expect(result.cy).toBe(-2);
  expect(result.cz).toBe(-1);
});

test('worldToChunk at exact boundary goes to next chunk', () => {
  const result = worldToChunk(8.0, 16.0, 24.0);
  expect(result.cx).toBe(1);
  expect(result.cy).toBe(2);
  expect(result.cz).toBe(3);
});

test('chunkToWorld returns correct world position', () => {
  const result = chunkToWorld(1, 2, 3);
  expect(result.x).toBe(8);
  expect(result.y).toBe(16);
  expect(result.z).toBe(24);
});

test('chunkToWorld handles negative chunks', () => {
  const result = chunkToWorld(-1, -2, 0);
  expect(result.x).toBe(-8);
  expect(result.y).toBe(-16);
  expect(result.z).toBe(0);
});

test('worldToVoxel converts correctly', () => {
  const result = worldToVoxel(1.0, 2.5, 0.3);
  expect(result.vx).toBe(4);  // 1.0 / 0.25 = 4
  expect(result.vy).toBe(10); // 2.5 / 0.25 = 10
  expect(result.vz).toBe(1);  // 0.3 / 0.25 = 1.2 → 1
});

test('voxelToWorld returns voxel center', () => {
  const result = voxelToWorld(4, 10, 1);
  expect(result.x).toBeCloseTo(1.125, 3); // (4 + 0.5) * 0.25
  expect(result.y).toBeCloseTo(2.625, 3); // (10 + 0.5) * 0.25
  expect(result.z).toBeCloseTo(0.375, 3); // (1 + 0.5) * 0.25
});

// ============== Voxel Index Tests ==============

test('voxelIndex(0, 0, 0) returns 0', () => {
  expect(voxelIndex(0, 0, 0)).toBe(0);
});

test('voxelIndex(31, 31, 31) returns last index', () => {
  expect(voxelIndex(31, 31, 31)).toBe(VOXELS_PER_CHUNK - 1);
});

test('voxelIndex layout is x + y*32 + z*32*32', () => {
  expect(voxelIndex(1, 0, 0)).toBe(1);
  expect(voxelIndex(0, 1, 0)).toBe(32);
  expect(voxelIndex(0, 0, 1)).toBe(1024);
});

test('indexToVoxel round-trips with voxelIndex', () => {
  const coords = indexToVoxel(voxelIndex(5, 10, 15));
  expect(coords.vx).toBe(5);
  expect(coords.vy).toBe(10);
  expect(coords.vz).toBe(15);
});

test('indexToVoxel(0) returns origin', () => {
  const coords = indexToVoxel(0);
  expect(coords.vx).toBe(0);
  expect(coords.vy).toBe(0);
  expect(coords.vz).toBe(0);
});

test('indexToVoxel(last) returns (31, 31, 31)', () => {
  const coords = indexToVoxel(VOXELS_PER_CHUNK - 1);
  expect(coords.vx).toBe(31);
  expect(coords.vy).toBe(31);
  expect(coords.vz).toBe(31);
});

// ============== Global to Local Conversion ==============

test('globalVoxelToLocal within first chunk', () => {
  const result = globalVoxelToLocal(5, 10, 15);
  expect(result.chunk.cx).toBe(0);
  expect(result.chunk.cy).toBe(0);
  expect(result.chunk.cz).toBe(0);
  expect(result.local.vx).toBe(5);
  expect(result.local.vy).toBe(10);
  expect(result.local.vz).toBe(15);
});

test('globalVoxelToLocal crosses chunk boundary', () => {
  const result = globalVoxelToLocal(35, 64, 100);
  expect(result.chunk.cx).toBe(1);  // 35 / 32 = 1
  expect(result.chunk.cy).toBe(2);  // 64 / 32 = 2
  expect(result.chunk.cz).toBe(3);  // 100 / 32 = 3
  expect(result.local.vx).toBe(3);  // 35 % 32 = 3
  expect(result.local.vy).toBe(0);  // 64 % 32 = 0
  expect(result.local.vz).toBe(4);  // 100 % 32 = 4
});

test('globalVoxelToLocal handles negative coordinates', () => {
  const result = globalVoxelToLocal(-1, -33, 0);
  expect(result.chunk.cx).toBe(-1);
  expect(result.chunk.cy).toBe(-2);
  expect(result.chunk.cz).toBe(0);
  expect(result.local.vx).toBe(31); // -1 mod 32 = 31
  expect(result.local.vy).toBe(31); // -33 mod 32 = 31
  expect(result.local.vz).toBe(0);
});

// ============== Chunk Key Tests ==============

test('chunkKey creates correct string', () => {
  expect(chunkKey(1, 2, 3)).toBe('1,2,3');
  expect(chunkKey(-1, 0, 5)).toBe('-1,0,5');
});

test('parseChunkKey parses correctly', () => {
  const result = parseChunkKey('1,2,3');
  expect(result.cx).toBe(1);
  expect(result.cy).toBe(2);
  expect(result.cz).toBe(3);
});

test('chunkKey and parseChunkKey round-trip', () => {
  const key = chunkKey(-5, 10, 0);
  const parsed = parseChunkKey(key);
  expect(parsed.cx).toBe(-5);
  expect(parsed.cy).toBe(10);
  expect(parsed.cz).toBe(0);
});

// ============== Bounds Check Tests ==============

test('isInChunkBounds returns true for valid coords', () => {
  expect(isInChunkBounds(0, 0, 0)).toBe(true);
  expect(isInChunkBounds(31, 31, 31)).toBe(true);
  expect(isInChunkBounds(15, 15, 15)).toBe(true);
});

test('isInChunkBounds returns false for out-of-bounds', () => {
  expect(isInChunkBounds(-1, 0, 0)).toBe(false);
  expect(isInChunkBounds(32, 0, 0)).toBe(false);
  expect(isInChunkBounds(0, -1, 0)).toBe(false);
  expect(isInChunkBounds(0, 32, 0)).toBe(false);
  expect(isInChunkBounds(0, 0, -1)).toBe(false);
  expect(isInChunkBounds(0, 0, 32)).toBe(false);
});

// ============== Constants Verification ==============

test('CHUNK_SIZE is 32', () => {
  expect(CHUNK_SIZE).toBe(32);
});

test('CHUNK_WORLD_SIZE is 8', () => {
  expect(CHUNK_WORLD_SIZE).toBe(8);
});

test('VOXELS_PER_CHUNK is 32768', () => {
  expect(VOXELS_PER_CHUNK).toBe(32768);
});

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
