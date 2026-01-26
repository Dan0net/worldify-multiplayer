/**
 * Territory system types
 */
export interface TerritoryCell {
    ownerId: number;
}
export interface TerritoryUpdate {
    cells: Array<{
        gridX: number;
        gridZ: number;
        ownerId: number;
    }>;
}
//# sourceMappingURL=territory.d.ts.map