/**
 * Voxel build system binary messages
 * 
 * These messages handle free-form voxel building with SDF shapes.
 * For the simpler grid-based building, see build.ts.
 * 
 * Flow:
 * 1. Client clicks to build → VOXEL_BUILD_INTENT → Server
 * 2. Server validates, applies build, broadcasts → VOXEL_BUILD_COMMIT → All Clients
 * 3. Each client applies the build locally using shared drawing functions
 * 4. For new chunks or resync → VOXEL_CHUNK_DATA → Client
 * 
 * VOXEL_BUILD_INTENT Binary Layout (Client -> Server):
 * Geometry is always a list of parts (a simple build is a 1-element list).
 * ┌─────────────┬─────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type    │ Description                              │
 * ├─────────────┼─────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8   │ MSG_VOXEL_BUILD_INTENT (0x06)            │
 * │ 1-12        │ float32 │ Center X/Y/Z (world coords)              │
 * │ 13-28       │ float32 │ Quaternion X/Y/Z/W                       │
 * │ 29          │ uint8   │ Part count (>= 1)                        │
 * │ 30+         │ part[]  │ Per part: offset(3×f32) + config block   │
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * Per-part config block: shape(u8) mode(u8) size(3×f32) material(u8)
 *   flags(u8: bit0=thickness,1=closed,2=arc) [thickness f32] [arcSweep f32].
 * Size: 12 + 16 + 1 + Σ(12 + configBytes).
 * 
 * VOXEL_BUILD_COMMIT Binary Layout (Server -> Client):
 * Echoes the build intent to all clients so they can apply it locally.
 * ┌─────────────┬─────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type    │ Description                              │
 * ├─────────────┼─────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8   │ MSG_VOXEL_BUILD_COMMIT (0x87)            │
 * │ 1-4         │ uint32  │ Build sequence number                    │
 * │ 5-6         │ uint16  │ Player ID who placed                     │
 * │ 7           │ uint8   │ Result code (0=success, 1+=error)        │
 * │ 8+          │ Intent  │ VoxelBuildIntent data (if success)       │
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * Variable size: 8 bytes (failure) or 52-60 bytes (success with intent)
 * 
 * VOXEL_CHUNK_DATA Binary Layout (Server -> Client):
 * Full chunk data for new players, streaming, or resync.
 * ┌─────────────┬─────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type    │ Description                              │
 * ├─────────────┼─────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8   │ MSG_VOXEL_CHUNK_DATA (0x88)              │
 * │ 1-2         │ int16   │ Chunk X coordinate                       │
 * │ 3-4         │ int16   │ Chunk Y coordinate                       │
 * │ 5-6         │ int16   │ Chunk Z coordinate                       │
 * │ 7-10        │ uint32  │ Last build sequence applied to chunk     │
 * │ 11+         │ bytes   │ Raw voxel data (32×32×32×4 = 131072 bytes)│
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * Total: 131083 bytes
 * 
 * VOXEL_CHUNK_REQUEST Binary Layout (Client -> Server):
 * Request full chunk data (for streaming or resync).
 * ┌─────────────┬─────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type    │ Description                              │
 * ├─────────────┼─────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8   │ MSG_VOXEL_CHUNK_REQUEST (0x07)           │
 * │ 1-2         │ int16   │ Chunk X coordinate                       │
 * │ 3-4         │ int16   │ Chunk Y coordinate                       │
 * │ 5-6         │ int16   │ Chunk Z coordinate                       │
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * Total: 7 bytes
 */

import { ByteReader, ByteWriter } from '../util/bytes.js';
import {
  BuildConfig,
  BuildMode,
  BuildPart,
  BuildShape,
  Quat,
  Vec3,
} from '../voxel/buildTypes.js';
import { VOXELS_PER_CHUNK } from '../voxel/constants.js';

// ============== Message IDs ==============

export const MSG_VOXEL_BUILD_INTENT = 0x06;
export const MSG_VOXEL_CHUNK_REQUEST = 0x07;
export const MSG_VOXEL_BUILD_COMMIT = 0x87;
export const MSG_VOXEL_CHUNK_DATA = 0x88;

// ============== Build Result Codes ==============

export enum BuildResult {
  SUCCESS = 0,
  TOO_FAR = 1,
  NO_PERMISSION = 2,
  COLLISION = 3,
  INVALID_CONFIG = 4,
  RATE_LIMITED = 5,
}

// ============== Flag bits for optional fields ==============

const FLAG_HAS_THICKNESS = 0x01;
const FLAG_CLOSED = 0x02;
const FLAG_HAS_ARC_SWEEP = 0x04;

// ============== Enums to numbers ==============

const SHAPE_TO_NUM: Record<BuildShape, number> = {
  [BuildShape.CUBE]: 0,
  [BuildShape.SPHERE]: 1,
  [BuildShape.CYLINDER]: 2,
  [BuildShape.PRISM]: 3,
};

const NUM_TO_SHAPE: BuildShape[] = [
  BuildShape.CUBE,
  BuildShape.SPHERE,
  BuildShape.CYLINDER,
  BuildShape.PRISM,
];

const MODE_TO_NUM: Record<BuildMode, number> = {
  [BuildMode.ADD]: 0,
  [BuildMode.SUBTRACT]: 1,
  [BuildMode.PAINT]: 2,
  [BuildMode.FILL]: 3,
  [BuildMode.PUNCH]: 4,
};

const NUM_TO_MODE: BuildMode[] = [
  BuildMode.ADD,
  BuildMode.SUBTRACT,
  BuildMode.PAINT,
  BuildMode.FILL,
  BuildMode.PUNCH,
];

// ============== Types ==============

/**
 * Voxel build intent - sent from client to server when player commits a build.
 */
export interface VoxelBuildIntent {
  /** World position center of the build */
  center: Vec3;
  /** Rotation as quaternion */
  rotation: Quat;
  /** Composite parts (>= 1). Drawn atomically as one build. */
  parts: BuildPart[];
}

/**
 * Build commit - sent from server to all clients.
 * Contains the original intent so clients can apply it locally.
 */
export interface VoxelBuildCommit {
  /** Sequence number for ordering */
  buildSeq: number;
  /** Player who initiated the build */
  playerId: number;
  /** Result code (0 = success) */
  result: BuildResult;
  /** The build intent (only present if result === SUCCESS) */
  intent?: VoxelBuildIntent;
}

/**
 * Chunk data - full voxel data for a chunk.
 */
export interface VoxelChunkData {
  /** Chunk coordinates */
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  /** Last build sequence number applied to this chunk */
  lastBuildSeq: number;
  /** Raw voxel data (32×32×32 = 32768 uint32 values) */
  voxelData: Uint32Array;
}

/**
 * Chunk request - client requests full chunk data.
 */
export interface VoxelChunkRequest {
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  /** If true, server regenerates chunk instead of loading from cache/disk */
  forceRegen: boolean;
}

// ============== Intent Encoding (shared by INTENT and COMMIT) ==============

/**
 * Write a self-contained config block (shape, mode, size, material, flags, optional
 * thickness/arcSweep). Used for composite parts. Same field layout as the main config
 * block minus the center/rotation.
 */
function writePartConfig(writer: ByteWriter, config: BuildConfig): void {
  let flags = 0;
  if (config.thickness !== undefined) flags |= FLAG_HAS_THICKNESS;
  if (config.closed) flags |= FLAG_CLOSED;
  if (config.arcSweep !== undefined) flags |= FLAG_HAS_ARC_SWEEP;

  writer.writeUint8(SHAPE_TO_NUM[config.shape]);
  writer.writeUint8(MODE_TO_NUM[config.mode]);
  writer.writeFloat32(config.size.x);
  writer.writeFloat32(config.size.y);
  writer.writeFloat32(config.size.z);
  writer.writeUint8(config.material & 0x7f);
  writer.writeUint8(flags);
  if (flags & FLAG_HAS_THICKNESS) writer.writeFloat32(config.thickness!);
  if (flags & FLAG_HAS_ARC_SWEEP) writer.writeFloat32(config.arcSweep!);
}

/** Read a self-contained config block written by writePartConfig. */
function readPartConfig(reader: ByteReader): BuildConfig {
  const shapeNum = reader.readUint8();
  const modeNum = reader.readUint8();
  const size = {
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
  };
  const material = reader.readUint8();
  const flags = reader.readUint8();
  const config: BuildConfig = {
    shape: NUM_TO_SHAPE[shapeNum] ?? BuildShape.CUBE,
    mode: NUM_TO_MODE[modeNum] ?? BuildMode.ADD,
    size,
    material,
  };
  if (flags & FLAG_HAS_THICKNESS) config.thickness = reader.readFloat32();
  if (flags & FLAG_CLOSED) config.closed = true;
  if (flags & FLAG_HAS_ARC_SWEEP) config.arcSweep = reader.readFloat32();
  return config;
}

/** Byte size of a writePartConfig block. */
function partConfigByteSize(config: BuildConfig): number {
  let s = 16; // shape(1) + mode(1) + size(12) + material(1) + flags(1)
  if (config.thickness !== undefined) s += 4;
  if (config.arcSweep !== undefined) s += 4;
  return s;
}

/**
 * Write intent data to a ByteWriter (without message ID):
 * center(3f) + rotation(4f) + partCount(u8) + per-part(offset 3f + config block).
 */
function writeIntentData(writer: ByteWriter, intent: VoxelBuildIntent): void {
  const { center, rotation, parts } = intent;

  // Center position
  writer.writeFloat32(center.x);
  writer.writeFloat32(center.y);
  writer.writeFloat32(center.z);

  // Rotation quaternion
  writer.writeFloat32(rotation.x);
  writer.writeFloat32(rotation.y);
  writer.writeFloat32(rotation.z);
  writer.writeFloat32(rotation.w);

  // Parts (>= 1): count then offset + config block per part
  writer.writeUint8(parts.length);
  for (const p of parts) {
    writer.writeFloat32(p.offset.x);
    writer.writeFloat32(p.offset.y);
    writer.writeFloat32(p.offset.z);
    writePartConfig(writer, p.config);
  }
}

/**
 * Read intent data from a ByteReader (without message ID).
 */
function readIntentData(reader: ByteReader): VoxelBuildIntent {
  // Center position
  const center: Vec3 = {
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
  };

  // Rotation quaternion
  const rotation: Quat = {
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
    w: reader.readFloat32(),
  };

  // Parts
  const count = reader.readUint8();
  const parts: BuildPart[] = [];
  for (let i = 0; i < count; i++) {
    const offset: Vec3 = {
      x: reader.readFloat32(),
      y: reader.readFloat32(),
      z: reader.readFloat32(),
    };
    parts.push({ config: readPartConfig(reader), offset });
  }

  return { center, rotation, parts };
}

/**
 * Calculate the byte size of an intent (without message ID):
 * 12 (center) + 16 (rotation) + 1 (count) + Σ per-part (12 offset + config block).
 */
function intentByteSize(intent: VoxelBuildIntent): number {
  let size = 12 + 16 + 1;
  for (const p of intent.parts) size += 12 + partConfigByteSize(p.config);
  return size;
}

// ============== VOXEL_BUILD_INTENT ==============

/**
 * Encode a voxel build intent for network transmission.
 */
export function encodeVoxelBuildIntent(intent: VoxelBuildIntent): Uint8Array {
  const size = 1 + intentByteSize(intent);
  const writer = new ByteWriter(size);
  
  writer.writeUint8(MSG_VOXEL_BUILD_INTENT);
  writeIntentData(writer, intent);
  
  return writer.toUint8Array();
}

/**
 * Decode a voxel build intent from network data.
 * Assumes message ID has already been read.
 */
export function decodeVoxelBuildIntent(reader: ByteReader): VoxelBuildIntent {
  return readIntentData(reader);
}

// ============== VOXEL_BUILD_COMMIT ==============

/**
 * Encode a voxel build commit for network transmission.
 */
export function encodeVoxelBuildCommit(commit: VoxelBuildCommit): Uint8Array {
  // Header: 1 (msgId) + 4 (seq) + 2 (playerId) + 1 (result) = 8 bytes
  let size = 8;
  if (commit.result === BuildResult.SUCCESS && commit.intent) {
    size += intentByteSize(commit.intent);
  }
  
  const writer = new ByteWriter(size);
  
  writer.writeUint8(MSG_VOXEL_BUILD_COMMIT);
  writer.writeUint32(commit.buildSeq);
  writer.writeUint16(commit.playerId);
  writer.writeUint8(commit.result);
  
  if (commit.result === BuildResult.SUCCESS && commit.intent) {
    writeIntentData(writer, commit.intent);
  }
  
  return writer.toUint8Array();
}

/**
 * Decode a voxel build commit from network data.
 * Assumes message ID has already been read.
 */
export function decodeVoxelBuildCommit(reader: ByteReader): VoxelBuildCommit {
  const buildSeq = reader.readUint32();
  const playerId = reader.readUint16();
  const result = reader.readUint8() as BuildResult;
  
  const commit: VoxelBuildCommit = { buildSeq, playerId, result };
  
  if (result === BuildResult.SUCCESS && reader.remaining > 0) {
    commit.intent = readIntentData(reader);
  }
  
  return commit;
}

// ============== VOXEL_CHUNK_DATA ==============

/**
 * Encode chunk data for network transmission.
 */
export function encodeVoxelChunkData(chunk: VoxelChunkData): Uint8Array {
  // 1 (msgId) + 6 (coords) + 4 (seq) + 131072 (data) = 131083 bytes
  const size = 11 + VOXELS_PER_CHUNK * 4;
  const writer = new ByteWriter(size);
  
  writer.writeUint8(MSG_VOXEL_CHUNK_DATA);
  writer.writeInt16(chunk.chunkX);
  writer.writeInt16(chunk.chunkY);
  writer.writeInt16(chunk.chunkZ);
  writer.writeUint32(chunk.lastBuildSeq);
  
  // Write raw voxel data as bytes
  const bytes = new Uint8Array(chunk.voxelData.buffer, chunk.voxelData.byteOffset, chunk.voxelData.byteLength);
  for (let i = 0; i < bytes.length; i++) {
    writer.writeUint8(bytes[i]);
  }
  
  return writer.toUint8Array();
}

/**
 * Decode chunk data from network data.
 * Assumes message ID has already been read.
 */
export function decodeVoxelChunkData(reader: ByteReader): VoxelChunkData {
  const chunkX = reader.readInt16();
  const chunkY = reader.readInt16();
  const chunkZ = reader.readInt16();
  const lastBuildSeq = reader.readUint32();
  
  // Read raw voxel data
  const voxelData = new Uint32Array(VOXELS_PER_CHUNK);
  const bytes = new Uint8Array(voxelData.buffer);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = reader.readUint8();
  }
  
  return { chunkX, chunkY, chunkZ, lastBuildSeq, voxelData };
}

// ============== VOXEL_CHUNK_REQUEST ==============

/**
 * Encode a chunk request for network transmission.
 */
export function encodeVoxelChunkRequest(request: VoxelChunkRequest): Uint8Array {
  const writer = new ByteWriter(8);
  
  writer.writeUint8(MSG_VOXEL_CHUNK_REQUEST);
  writer.writeInt16(request.chunkX);
  writer.writeInt16(request.chunkY);
  writer.writeInt16(request.chunkZ);
  writer.writeUint8(request.forceRegen ? 1 : 0);
  
  return writer.toUint8Array();
}

/**
 * Decode a chunk request from network data.
 * Assumes message ID has already been read.
 */
export function decodeVoxelChunkRequest(reader: ByteReader): VoxelChunkRequest {
  return {
    chunkX: reader.readInt16(),
    chunkY: reader.readInt16(),
    chunkZ: reader.readInt16(),
    forceRegen: reader.readUint8() === 1,
  };
}

// ============== Utility Functions ==============

/**
 * Convert local voxel coordinates (0-31 each) to a packed index.
 */
export function packVoxelIndex(x: number, y: number, z: number): number {
  return x + y * 32 + z * 32 * 32;
}

/**
 * Unpack a voxel index to local coordinates.
 */
export function unpackVoxelIndex(index: number): { x: number; y: number; z: number } {
  const x = index % 32;
  const y = Math.floor(index / 32) % 32;
  const z = Math.floor(index / (32 * 32));
  return { x, y, z };
}

/**
 * Get a human-readable string for a build result.
 */
export function buildResultToString(result: BuildResult): string {
  switch (result) {
    case BuildResult.SUCCESS: return 'Success';
    case BuildResult.TOO_FAR: return 'Too far from player';
    case BuildResult.NO_PERMISSION: return 'No permission in this area';
    case BuildResult.COLLISION: return 'Collision with player';
    case BuildResult.INVALID_CONFIG: return 'Invalid build configuration';
    case BuildResult.RATE_LIMITED: return 'Building too fast';
    default: return 'Unknown error';
  }
}
