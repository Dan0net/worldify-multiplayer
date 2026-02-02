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
 * ┌─────────────┬─────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type    │ Description                              │
 * ├─────────────┼─────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8   │ MSG_VOXEL_BUILD_INTENT (0x06)            │
 * │ 1-4         │ float32 │ Center X (world coords)                  │
 * │ 5-8         │ float32 │ Center Y (world coords)                  │
 * │ 9-12        │ float32 │ Center Z (world coords)                  │
 * │ 13-16       │ float32 │ Quaternion X                             │
 * │ 17-20       │ float32 │ Quaternion Y                             │
 * │ 21-24       │ float32 │ Quaternion Z                             │
 * │ 25-28       │ float32 │ Quaternion W                             │
 * │ 29          │ uint8   │ Shape (0=cube, 1=sphere, 2=cylinder, 3=prism) │
 * │ 30          │ uint8   │ Mode (0=add, 1=subtract, 2=paint, 3=fill)│
 * │ 31-34       │ float32 │ Size X                                   │
 * │ 35-38       │ float32 │ Size Y                                   │
 * │ 39-42       │ float32 │ Size Z                                   │
 * │ 43          │ uint8   │ Material ID (0-127)                      │
 * │ 44          │ uint8   │ Flags (bit0=hasThickness, bit1=closed)   │
 * │ 45-48       │ float32 │ Thickness (optional, if flag set)        │
 * │ 49-52       │ float32 │ Arc sweep (optional, if needed)          │
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * Variable size: 45-53 bytes depending on optional fields
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
 * │ 11+         │ bytes   │ Raw voxel data (32×32×32×2 = 65536 bytes)│
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * Total: 65547 bytes
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
};

const NUM_TO_MODE: BuildMode[] = [
  BuildMode.ADD,
  BuildMode.SUBTRACT,
  BuildMode.PAINT,
  BuildMode.FILL,
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
  /** Build configuration */
  config: BuildConfig;
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
  /** Raw voxel data (32×32×32 = 32768 uint16 values) */
  voxelData: Uint16Array;
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
 * Write intent data to a ByteWriter (without message ID).
 */
function writeIntentData(writer: ByteWriter, intent: VoxelBuildIntent): void {
  const { center, rotation, config } = intent;
  
  // Calculate flags
  let flags = 0;
  if (config.thickness !== undefined) flags |= FLAG_HAS_THICKNESS;
  if (config.closed) flags |= FLAG_CLOSED;
  if (config.arcSweep !== undefined) flags |= FLAG_HAS_ARC_SWEEP;
  
  // Center position
  writer.writeFloat32(center.x);
  writer.writeFloat32(center.y);
  writer.writeFloat32(center.z);
  
  // Rotation quaternion
  writer.writeFloat32(rotation.x);
  writer.writeFloat32(rotation.y);
  writer.writeFloat32(rotation.z);
  writer.writeFloat32(rotation.w);
  
  // Shape and mode
  writer.writeUint8(SHAPE_TO_NUM[config.shape]);
  writer.writeUint8(MODE_TO_NUM[config.mode]);
  
  // Size
  writer.writeFloat32(config.size.x);
  writer.writeFloat32(config.size.y);
  writer.writeFloat32(config.size.z);
  
  // Material
  writer.writeUint8(config.material & 0x7f);
  
  // Flags
  writer.writeUint8(flags);
  
  // Optional fields
  if (flags & FLAG_HAS_THICKNESS) {
    writer.writeFloat32(config.thickness!);
  }
  if (flags & FLAG_HAS_ARC_SWEEP) {
    writer.writeFloat32(config.arcSweep!);
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
  
  // Shape and mode
  const shapeNum = reader.readUint8();
  const modeNum = reader.readUint8();
  
  // Size
  const size = {
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
  };
  
  // Material
  const material = reader.readUint8();
  
  // Flags
  const flags = reader.readUint8();
  
  // Build config
  const config: BuildConfig = {
    shape: NUM_TO_SHAPE[shapeNum] ?? BuildShape.CUBE,
    mode: NUM_TO_MODE[modeNum] ?? BuildMode.ADD,
    size,
    material,
  };
  
  // Optional fields
  if (flags & FLAG_HAS_THICKNESS) {
    config.thickness = reader.readFloat32();
  }
  if (flags & FLAG_CLOSED) {
    config.closed = true;
  }
  if (flags & FLAG_HAS_ARC_SWEEP) {
    config.arcSweep = reader.readFloat32();
  }
  
  return { center, rotation, config };
}

/**
 * Calculate the byte size of an intent.
 */
function intentByteSize(intent: VoxelBuildIntent): number {
  let size = 44; // base size (without message ID)
  if (intent.config.thickness !== undefined) size += 4;
  if (intent.config.arcSweep !== undefined) size += 4;
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
  // 1 (msgId) + 6 (coords) + 4 (seq) + 65536 (data) = 65547 bytes
  const size = 11 + VOXELS_PER_CHUNK * 2;
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
  const voxelData = new Uint16Array(VOXELS_PER_CHUNK);
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
