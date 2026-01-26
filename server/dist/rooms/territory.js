/**
 * Server-side territory management
 */
import { TERRITORY_GRID_SIZE } from '@worldify/shared';
export function claimCell(room, x, z, playerId) {
    if (x < 0 || x >= TERRITORY_GRID_SIZE || z < 0 || z >= TERRITORY_GRID_SIZE) {
        return false;
    }
    const index = z * TERRITORY_GRID_SIZE + x;
    room.territory[index] = playerId;
    return true;
}
export function getCell(room, x, z) {
    if (x < 0 || x >= TERRITORY_GRID_SIZE || z < 0 || z >= TERRITORY_GRID_SIZE) {
        return 0;
    }
    return room.territory[z * TERRITORY_GRID_SIZE + x];
}
export function applyConsumeWave(_room) {
    // TODO: shrink unclaimed territory
    // TODO: remove disconnected islands
}
//# sourceMappingURL=territory.js.map