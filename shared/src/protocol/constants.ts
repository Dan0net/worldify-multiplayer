/**
 * Game constants shared between client and server
 */

// Room limits
export const MAX_PLAYERS_PER_ROOM = 64;

// Tick rates
export const SERVER_TICK_HZ = 20;
export const SNAPSHOT_HZ = 15;
export const CLIENT_INPUT_HZ = 30;

// Territory grid
export const TERRITORY_GRID_SIZE = 128;
export const TERRITORY_CELL_SIZE = 2; // meters

// Build system
export const BUILD_STRICT_ORDER = true;

// Room cleanup
export const EMPTY_ROOM_TIMEOUT_MS = 60_000;
