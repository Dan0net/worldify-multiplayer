// Shared package exports
export * from './protocol/version.js';
export * from './protocol/msgIds.js';
export * from './protocol/constants.js';
export * from './protocol/physics.js';
export * from './protocol/movement.js';
export * from './protocol/snapshot.js';
export * from './protocol/build.js';
export * from './protocol/buildMessages.js';
export * from './protocol/territory.js';
export * from './protocol/messages.js';
export * from './util/bytes.js';
export * from './util/quantize.js';
export * from './util/movement.js';

// Voxel terrain
export * from './voxel/constants.js';
export * from './voxel/voxelData.js';
export * from './voxel/Chunk.js';
export * from './voxel/buildTypes.js';
export * from './voxel/shapes.js';
export * from './voxel/drawing.js';

// Terrain generation
export * from './terrain/index.js';

// Re-export commonly used types for convenience
export type { MovementInput, PlayerPosition } from './protocol/movement.js';
export type { PlayerSnapshot, RoomSnapshot } from './protocol/snapshot.js';
export type { BuildIntent, BuildCommit } from './protocol/build.js';
export type { UnpackedVoxel, ChunkCoord, VoxelCoord, WorldCoord } from './voxel/voxelData.js';
export type { ChunkData } from './voxel/Chunk.js';
export type { BuildConfig, BuildOperation, Vec3, Quat, Size3, VoxelBBox } from './voxel/buildTypes.js';
