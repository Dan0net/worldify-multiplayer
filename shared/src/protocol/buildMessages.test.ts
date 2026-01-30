/**
 * Unit tests for buildMessages.ts - binary encoding/decoding
 * Run with: npx tsx shared/src/protocol/buildMessages.test.ts
 */

import { ByteReader } from '../util/bytes.js';
import { BuildMode, BuildShape } from '../voxel/buildTypes.js';
import { VOXELS_PER_CHUNK } from '../voxel/constants.js';

import {
  MSG_VOXEL_BUILD_INTENT,
  MSG_VOXEL_BUILD_COMMIT,
  MSG_VOXEL_CHUNK_DATA,
  MSG_VOXEL_CHUNK_REQUEST,
  BuildResult,
  VoxelBuildIntent,
  VoxelBuildCommit,
  VoxelChunkData,
  VoxelChunkRequest,
  encodeVoxelBuildIntent,
  decodeVoxelBuildIntent,
  encodeVoxelBuildCommit,
  decodeVoxelBuildCommit,
  encodeVoxelChunkData,
  decodeVoxelChunkData,
  encodeVoxelChunkRequest,
  decodeVoxelChunkRequest,
  packVoxelIndex,
  unpackVoxelIndex,
  buildResultToString,
} from './buildMessages.js';

// ============== Test Runner ==============

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

function assertEqual<T>(actual: T, expected: T, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual: number, expected: number, epsilon = 0.0001, msg = '') {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${msg}: expected ~${expected}, got ${actual}`);
  }
}

function assertTrue(condition: boolean, msg = '') {
  if (!condition) {
    throw new Error(`${msg}: expected true, got false`);
  }
}

// ============== VOXEL_BUILD_INTENT Tests ==============

test('encodeVoxelBuildIntent basic cube', () => {
  const intent: VoxelBuildIntent = {
    center: { x: 10.5, y: 5.0, z: -3.25 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    config: {
      shape: BuildShape.CUBE,
      mode: BuildMode.ADD,
      size: { x: 2, y: 2, z: 2 },
      material: 5,
    },
  };

  const encoded = encodeVoxelBuildIntent(intent);
  
  // Check message ID
  assertEqual(encoded[0], MSG_VOXEL_BUILD_INTENT, 'message ID');
  
  // Base size without optional fields: 45 bytes
  assertEqual(encoded.length, 45, 'encoded length');
});

test('encodeVoxelBuildIntent with thickness', () => {
  const intent: VoxelBuildIntent = {
    center: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    config: {
      shape: BuildShape.SPHERE,
      mode: BuildMode.SUBTRACT,
      size: { x: 4, y: 4, z: 4 },
      material: 3,
      thickness: 0.5,
    },
  };

  const encoded = encodeVoxelBuildIntent(intent);
  
  // Base 45 + 4 for thickness = 49 bytes
  assertEqual(encoded.length, 49, 'encoded length with thickness');
});

test('encodeVoxelBuildIntent with thickness and arcSweep', () => {
  const intent: VoxelBuildIntent = {
    center: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    config: {
      shape: BuildShape.CYLINDER,
      mode: BuildMode.ADD,
      size: { x: 2, y: 5, z: 2 },
      material: 10,
      thickness: 0.25,
      arcSweep: Math.PI,
    },
  };

  const encoded = encodeVoxelBuildIntent(intent);
  
  // Base 45 + 4 (thickness) + 4 (arcSweep) = 53 bytes
  assertEqual(encoded.length, 53, 'encoded length with thickness and arcSweep');
});

test('decode VoxelBuildIntent round-trip', () => {
  const original: VoxelBuildIntent = {
    center: { x: 15.75, y: -3.5, z: 100.0 },
    rotation: { x: 0.1, y: 0.2, z: 0.3, w: 0.9273 },
    config: {
      shape: BuildShape.PRISM,
      mode: BuildMode.PAINT,
      size: { x: 1.5, y: 2.5, z: 3.5 },
      material: 127,
    },
  };

  const encoded = encodeVoxelBuildIntent(original);
  const reader = new ByteReader(encoded);
  reader.readUint8(); // skip message ID
  const decoded = decodeVoxelBuildIntent(reader);

  assertClose(decoded.center.x, original.center.x, 0.001, 'center.x');
  assertClose(decoded.center.y, original.center.y, 0.001, 'center.y');
  assertClose(decoded.center.z, original.center.z, 0.001, 'center.z');
  
  assertClose(decoded.rotation.x, original.rotation.x, 0.001, 'rotation.x');
  assertClose(decoded.rotation.w, original.rotation.w, 0.001, 'rotation.w');
  
  assertEqual(decoded.config.shape, original.config.shape, 'shape');
  assertEqual(decoded.config.mode, original.config.mode, 'mode');
  assertClose(decoded.config.size.x, original.config.size.x, 0.001, 'size.x');
  assertEqual(decoded.config.material, original.config.material, 'material');
});

test('decode VoxelBuildIntent with optional fields round-trip', () => {
  const original: VoxelBuildIntent = {
    center: { x: 0, y: 10, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    config: {
      shape: BuildShape.CYLINDER,
      mode: BuildMode.ADD,
      size: { x: 3, y: 6, z: 3 },
      material: 50,
      thickness: 0.75,
      closed: true,
      arcSweep: Math.PI * 1.5,
    },
  };

  const encoded = encodeVoxelBuildIntent(original);
  const reader = new ByteReader(encoded);
  reader.readUint8(); // skip message ID
  const decoded = decodeVoxelBuildIntent(reader);

  assertClose(decoded.config.thickness!, original.config.thickness!, 0.001, 'thickness');
  assertEqual(decoded.config.closed, true, 'closed');
  assertClose(decoded.config.arcSweep!, original.config.arcSweep!, 0.001, 'arcSweep');
});

// ============== VOXEL_BUILD_COMMIT Tests ==============

test('encodeVoxelBuildCommit success', () => {
  const intent: VoxelBuildIntent = {
    center: { x: 5, y: 5, z: 5 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    config: {
      shape: BuildShape.SPHERE,
      mode: BuildMode.ADD,
      size: { x: 2, y: 2, z: 2 },
      material: 1,
    },
  };

  const commit: VoxelBuildCommit = {
    buildSeq: 42,
    playerId: 7,
    result: BuildResult.SUCCESS,
    intent,
  };

  const encoded = encodeVoxelBuildCommit(commit);
  
  assertEqual(encoded[0], MSG_VOXEL_BUILD_COMMIT, 'message ID');
  // 8 header + 44 intent = 52 bytes
  assertEqual(encoded.length, 52, 'encoded length');
});

test('encodeVoxelBuildCommit failure', () => {
  const commit: VoxelBuildCommit = {
    buildSeq: 100,
    playerId: 3,
    result: BuildResult.TOO_FAR,
  };

  const encoded = encodeVoxelBuildCommit(commit);
  
  // Just header, no intent: 8 bytes
  assertEqual(encoded.length, 8, 'encoded length for failure');
});

test('decode VoxelBuildCommit success round-trip', () => {
  const original: VoxelBuildCommit = {
    buildSeq: 999,
    playerId: 123,
    result: BuildResult.SUCCESS,
    intent: {
      center: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      config: {
        shape: BuildShape.CUBE,
        mode: BuildMode.SUBTRACT,
        size: { x: 4, y: 4, z: 4 },
        material: 20,
      },
    },
  };

  const encoded = encodeVoxelBuildCommit(original);
  const reader = new ByteReader(encoded);
  reader.readUint8(); // skip message ID
  const decoded = decodeVoxelBuildCommit(reader);

  assertEqual(decoded.buildSeq, original.buildSeq, 'buildSeq');
  assertEqual(decoded.playerId, original.playerId, 'playerId');
  assertEqual(decoded.result, BuildResult.SUCCESS, 'result');
  assertTrue(decoded.intent !== undefined, 'intent exists');
  assertEqual(decoded.intent!.config.shape, BuildShape.CUBE, 'intent shape');
});

test('decode VoxelBuildCommit failure round-trip', () => {
  const original: VoxelBuildCommit = {
    buildSeq: 50,
    playerId: 8,
    result: BuildResult.NO_PERMISSION,
  };

  const encoded = encodeVoxelBuildCommit(original);
  const reader = new ByteReader(encoded);
  reader.readUint8(); // skip message ID
  const decoded = decodeVoxelBuildCommit(reader);

  assertEqual(decoded.buildSeq, 50, 'buildSeq');
  assertEqual(decoded.playerId, 8, 'playerId');
  assertEqual(decoded.result, BuildResult.NO_PERMISSION, 'result');
  assertEqual(decoded.intent, undefined, 'no intent for failure');
});

// ============== VOXEL_CHUNK_DATA Tests ==============

test('encodeVoxelChunkData size', () => {
  const voxelData = new Uint16Array(VOXELS_PER_CHUNK);
  voxelData[0] = 0x1234;
  voxelData[100] = 0xABCD;

  const chunk: VoxelChunkData = {
    chunkX: -5,
    chunkY: 2,
    chunkZ: 10,
    lastBuildSeq: 42,
    voxelData,
  };

  const encoded = encodeVoxelChunkData(chunk);
  
  assertEqual(encoded[0], MSG_VOXEL_CHUNK_DATA, 'message ID');
  // 1 + 6 + 4 + 65536 = 65547 bytes
  assertEqual(encoded.length, 65547, 'encoded length');
});

test('decode VoxelChunkData round-trip', () => {
  const voxelData = new Uint16Array(VOXELS_PER_CHUNK);
  // Set some test values
  voxelData[0] = 0x1234;
  voxelData[1000] = 0xABCD;
  voxelData[VOXELS_PER_CHUNK - 1] = 0xFFFF;

  const original: VoxelChunkData = {
    chunkX: -10,
    chunkY: 5,
    chunkZ: 100,
    lastBuildSeq: 999,
    voxelData,
  };

  const encoded = encodeVoxelChunkData(original);
  const reader = new ByteReader(encoded);
  reader.readUint8(); // skip message ID
  const decoded = decodeVoxelChunkData(reader);

  assertEqual(decoded.chunkX, -10, 'chunkX');
  assertEqual(decoded.chunkY, 5, 'chunkY');
  assertEqual(decoded.chunkZ, 100, 'chunkZ');
  assertEqual(decoded.lastBuildSeq, 999, 'lastBuildSeq');
  assertEqual(decoded.voxelData[0], 0x1234, 'voxelData[0]');
  assertEqual(decoded.voxelData[1000], 0xABCD, 'voxelData[1000]');
  assertEqual(decoded.voxelData[VOXELS_PER_CHUNK - 1], 0xFFFF, 'voxelData[last]');
});

// ============== VOXEL_CHUNK_REQUEST Tests ==============

test('encodeVoxelChunkRequest', () => {
  const request: VoxelChunkRequest = {
    chunkX: 3,
    chunkY: -2,
    chunkZ: 15,
  };

  const encoded = encodeVoxelChunkRequest(request);
  
  assertEqual(encoded[0], MSG_VOXEL_CHUNK_REQUEST, 'message ID');
  assertEqual(encoded.length, 7, 'encoded length');
});

test('decode VoxelChunkRequest round-trip', () => {
  const original: VoxelChunkRequest = {
    chunkX: -100,
    chunkY: 50,
    chunkZ: 0,
  };

  const encoded = encodeVoxelChunkRequest(original);
  const reader = new ByteReader(encoded);
  reader.readUint8(); // skip message ID
  const decoded = decodeVoxelChunkRequest(reader);

  assertEqual(decoded.chunkX, -100, 'chunkX');
  assertEqual(decoded.chunkY, 50, 'chunkY');
  assertEqual(decoded.chunkZ, 0, 'chunkZ');
});

// ============== Utility Function Tests ==============

test('packVoxelIndex and unpackVoxelIndex', () => {
  // Test corner cases
  const testCases = [
    { x: 0, y: 0, z: 0 },
    { x: 31, y: 0, z: 0 },
    { x: 0, y: 31, z: 0 },
    { x: 0, y: 0, z: 31 },
    { x: 31, y: 31, z: 31 },
    { x: 15, y: 16, z: 17 },
  ];

  for (const tc of testCases) {
    const packed = packVoxelIndex(tc.x, tc.y, tc.z);
    const unpacked = unpackVoxelIndex(packed);
    assertEqual(unpacked.x, tc.x, `x for (${tc.x},${tc.y},${tc.z})`);
    assertEqual(unpacked.y, tc.y, `y for (${tc.x},${tc.y},${tc.z})`);
    assertEqual(unpacked.z, tc.z, `z for (${tc.x},${tc.y},${tc.z})`);
  }
});

test('buildResultToString', () => {
  assertEqual(buildResultToString(BuildResult.SUCCESS), 'Success', 'SUCCESS');
  assertEqual(buildResultToString(BuildResult.TOO_FAR), 'Too far from player', 'TOO_FAR');
  assertEqual(buildResultToString(BuildResult.NO_PERMISSION), 'No permission in this area', 'NO_PERMISSION');
  assertEqual(buildResultToString(BuildResult.COLLISION), 'Collision with player', 'COLLISION');
  assertEqual(buildResultToString(BuildResult.INVALID_CONFIG), 'Invalid build configuration', 'INVALID_CONFIG');
  assertEqual(buildResultToString(BuildResult.RATE_LIMITED), 'Building too fast', 'RATE_LIMITED');
});

// ============== Run Tests ==============

console.log('\n========================================');
console.log('buildMessages.ts Unit Tests');
console.log('========================================\n');

// Tests run automatically when file is executed
// Summary printed below

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
