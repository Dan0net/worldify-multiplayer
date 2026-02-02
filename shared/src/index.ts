// Shared package exports
export * from './protocol/version.js';
export * from './protocol/msgIds.js';
export * from './protocol/constants.js';
export * from './protocol/physics.js';
export * from './protocol/gameMode.js';
export * from './protocol/movement.js';
export * from './protocol/snapshot.js';
export * from './protocol/buildMessages.js';
export * from './protocol/messages.js';
export * from './util/bytes.js';
export * from './util/quantize.js';
export * from './util/movement.js';
export * from './util/logger.js';
export * from './util/roomOffset.js';

// Materials
export * from './materials/index.js';

// Voxel terrain
export * from './voxel/constants.js';
export * from './voxel/voxelData.js';
export * from './voxel/ChunkData.js';
export * from './voxel/buildTypes.js';
export * from './voxel/buildPresets.js';
export * from './voxel/shapes.js';
export * from './voxel/drawing.js';

// Terrain generation
export * from './terrain/index.js';

// Re-export commonly used types for convenience
export type { MovementInput, PlayerPosition } from './protocol/movement.js';
export type { PlayerSnapshot, RoomSnapshot } from './protocol/snapshot.js';
export type { UnpackedVoxel, ChunkCoord, VoxelCoord, WorldCoord } from './voxel/voxelData.js';
export type { SerializedChunkData } from './voxel/ChunkData.js';
export type { BuildConfig, BuildOperation, Vec3, Quat, Size3, VoxelBBox } from './voxel/buildTypes.js';
