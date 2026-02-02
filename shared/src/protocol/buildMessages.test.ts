/**
 * Unit tests for buildMessages.ts - binary encoding/decoding
 */

import { describe, test, expect } from 'vitest';
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

describe('VOXEL_BUILD_INTENT Tests', () => {
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
    
    expect(encoded[0]).toBe(MSG_VOXEL_BUILD_INTENT);
    expect(encoded.length).toBe(45);
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
    
    expect(encoded.length).toBe(49);
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
    
    expect(encoded.length).toBe(53);
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

    expect(decoded.center.x).toBeCloseTo(original.center.x, 2);
    expect(decoded.center.y).toBeCloseTo(original.center.y, 2);
    expect(decoded.center.z).toBeCloseTo(original.center.z, 2);
    
    expect(decoded.rotation.x).toBeCloseTo(original.rotation.x, 2);
    expect(decoded.rotation.w).toBeCloseTo(original.rotation.w, 2);
    
    expect(decoded.config.shape).toBe(original.config.shape);
    expect(decoded.config.mode).toBe(original.config.mode);
    expect(decoded.config.size.x).toBeCloseTo(original.config.size.x, 2);
    expect(decoded.config.material).toBe(original.config.material);
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

    expect(decoded.config.thickness!).toBeCloseTo(original.config.thickness!, 2);
    expect(decoded.config.closed).toBe(true);
    expect(decoded.config.arcSweep!).toBeCloseTo(original.config.arcSweep!, 2);
  });
});

describe('VOXEL_BUILD_COMMIT Tests', () => {
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
    
    expect(encoded[0]).toBe(MSG_VOXEL_BUILD_COMMIT);
    expect(encoded.length).toBe(52);
  });

  test('encodeVoxelBuildCommit failure', () => {
    const commit: VoxelBuildCommit = {
      buildSeq: 100,
      playerId: 3,
      result: BuildResult.TOO_FAR,
    };

    const encoded = encodeVoxelBuildCommit(commit);
    
    expect(encoded.length).toBe(8);
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

    expect(decoded.buildSeq).toBe(original.buildSeq);
    expect(decoded.playerId).toBe(original.playerId);
    expect(decoded.result).toBe(BuildResult.SUCCESS);
    expect(decoded.intent).not.toBeUndefined();
    expect(decoded.intent!.config.shape).toBe(BuildShape.CUBE);
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

    expect(decoded.buildSeq).toBe(50);
    expect(decoded.playerId).toBe(8);
    expect(decoded.result).toBe(BuildResult.NO_PERMISSION);
    expect(decoded.intent).toBeUndefined();
  });
});

describe('VOXEL_CHUNK_DATA Tests', () => {
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
    
    expect(encoded[0]).toBe(MSG_VOXEL_CHUNK_DATA);
    expect(encoded.length).toBe(65547);
  });

  test('decode VoxelChunkData round-trip', () => {
    const voxelData = new Uint16Array(VOXELS_PER_CHUNK);
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

    expect(decoded.chunkX).toBe(-10);
    expect(decoded.chunkY).toBe(5);
    expect(decoded.chunkZ).toBe(100);
    expect(decoded.lastBuildSeq).toBe(999);
    expect(decoded.voxelData[0]).toBe(0x1234);
    expect(decoded.voxelData[1000]).toBe(0xABCD);
    expect(decoded.voxelData[VOXELS_PER_CHUNK - 1]).toBe(0xFFFF);
  });
});

describe('VOXEL_CHUNK_REQUEST Tests', () => {
  test('encodeVoxelChunkRequest', () => {
    const request: VoxelChunkRequest = {
      chunkX: 3,
      chunkY: -2,
      chunkZ: 15,
      forceRegen: false,
    };

    const encoded = encodeVoxelChunkRequest(request);
    
    expect(encoded[0]).toBe(MSG_VOXEL_CHUNK_REQUEST);
    expect(encoded.length).toBe(8);
  });

  test('decode VoxelChunkRequest round-trip', () => {
    const original: VoxelChunkRequest = {
      chunkX: -100,
      chunkY: 50,
      chunkZ: 0,
      forceRegen: false,
    };

    const encoded = encodeVoxelChunkRequest(original);
    const reader = new ByteReader(encoded);
    reader.readUint8(); // skip message ID
    const decoded = decodeVoxelChunkRequest(reader);

    expect(decoded.chunkX).toBe(-100);
    expect(decoded.chunkY).toBe(50);
    expect(decoded.chunkZ).toBe(0);
    expect(decoded.forceRegen).toBe(false);
  });

  test('decode VoxelChunkRequest with forceRegen=true', () => {
    const original: VoxelChunkRequest = {
      chunkX: 5,
      chunkY: -3,
      chunkZ: 10,
      forceRegen: true,
    };

    const encoded = encodeVoxelChunkRequest(original);
    const reader = new ByteReader(encoded);
    reader.readUint8(); // skip message ID
    const decoded = decodeVoxelChunkRequest(reader);

    expect(decoded.chunkX).toBe(5);
    expect(decoded.chunkY).toBe(-3);
    expect(decoded.chunkZ).toBe(10);
    expect(decoded.forceRegen).toBe(true);
  });
});

describe('Utility Function Tests', () => {
  test('packVoxelIndex and unpackVoxelIndex', () => {
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
      expect(unpacked.x).toBe(tc.x);
      expect(unpacked.y).toBe(tc.y);
      expect(unpacked.z).toBe(tc.z);
    }
  });

  test('buildResultToString', () => {
    expect(buildResultToString(BuildResult.SUCCESS)).toBe('Success');
    expect(buildResultToString(BuildResult.TOO_FAR)).toBe('Too far from player');
    expect(buildResultToString(BuildResult.NO_PERMISSION)).toBe('No permission in this area');
    expect(buildResultToString(BuildResult.COLLISION)).toBe('Collision with player');
    expect(buildResultToString(BuildResult.INVALID_CONFIG)).toBe('Invalid build configuration');
    expect(buildResultToString(BuildResult.RATE_LIMITED)).toBe('Building too fast');
  });
});
