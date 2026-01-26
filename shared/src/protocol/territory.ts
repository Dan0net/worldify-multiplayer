/**
 * Territory system types
 */

export interface TerritoryCell {
  ownerId: number; // 0 = unclaimed, player IDs start at 1
}

export interface TerritoryUpdate {
  cells: Array<{
    gridX: number;
    gridZ: number;
    ownerId: number;
  }>;
}
