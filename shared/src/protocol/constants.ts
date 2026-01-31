/**
 * Game constants shared between client and server
 */

// Room limits
export const MAX_PLAYERS_PER_ROOM = 64;

// Tick rates
export const SERVER_TICK_HZ = 20;
export const SNAPSHOT_HZ = 15;
export const CLIENT_INPUT_HZ = 30;

// Build system
export const BUILD_STRICT_ORDER = true;

// Room cleanup
export const EMPTY_ROOM_TIMEOUT_MS = 60_000;

// ============== Room Names ==============
/**
 * Fixed pool of fun room names.
 * Each room name hashes to a unique spawn region in the world.
 */
export const ROOM_NAMES = [
  'cozy-crater',
  'sunny-summit',
  'breezy-bay',
  'pixel-peak',
  'fuzzy-falls',
  'coral-cove',
  'mellow-meadow',
  'dapper-dunes',
  'wiggly-woods',
  'snoozy-slopes',
  'bouncy-basin',
  'glimmer-gulch',
  'tipsy-terrace',
  'wobble-woods',
  'zippy-zenith',
  'noodle-nook',
  'sparkle-springs',
  'doodle-dale',
  'giggle-grove',
  'bumble-bluff',
] as const;

export type RoomName = (typeof ROOM_NAMES)[number];

/**
 * Spacing between room spawn regions in chunks.
 * 10,000 chunks × 8m = 80km between regions.
 */
export const ROOM_SPACING_CHUNKS = 10_000;
