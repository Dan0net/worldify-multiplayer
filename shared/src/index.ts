// Shared package exports
export * from './protocol/version.js';
export * from './protocol/msgIds.js';
export * from './protocol/constants.js';
export * from './protocol/movement.js';
export * from './protocol/snapshot.js';
export * from './protocol/build.js';
export * from './protocol/territory.js';
export * from './util/bytes.js';
export * from './util/quantize.js';

// Re-export commonly used types for convenience
export type { MovementInput, PlayerPosition } from './protocol/movement.js';
export type { PlayerSnapshot, RoomSnapshot } from './protocol/snapshot.js';
export type { BuildIntent, BuildCommit } from './protocol/build.js';
