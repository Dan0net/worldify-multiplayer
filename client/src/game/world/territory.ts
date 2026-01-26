/**
 * Territory visualization
 */

import * as THREE from 'three';
import { TERRITORY_GRID_SIZE, TERRITORY_CELL_SIZE } from '@worldify/shared';
import { getScene } from '../scene/scene';

// Will be used for world coordinate conversion
export const TERRITORY_WORLD_SIZE = TERRITORY_GRID_SIZE * TERRITORY_CELL_SIZE;

export class Territory {
  private grid: Uint16Array;
  private mesh: THREE.Mesh | null = null;

  constructor() {
    this.grid = new Uint16Array(TERRITORY_GRID_SIZE * TERRITORY_GRID_SIZE);
  }

  setCell(x: number, z: number, ownerId: number): void {
    if (x >= 0 && x < TERRITORY_GRID_SIZE && z >= 0 && z < TERRITORY_GRID_SIZE) {
      this.grid[z * TERRITORY_GRID_SIZE + x] = ownerId;
    }
  }

  getCell(x: number, z: number): number {
    if (x >= 0 && x < TERRITORY_GRID_SIZE && z >= 0 && z < TERRITORY_GRID_SIZE) {
      return this.grid[z * TERRITORY_GRID_SIZE + x];
    }
    return 0;
  }

  updateVisualization(): void {
    // TODO: update territory mesh based on grid state
  }

  dispose(): void {
    if (this.mesh) {
      const scene = getScene();
      if (scene) {
        scene.remove(this.mesh);
      }
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
  }
}
