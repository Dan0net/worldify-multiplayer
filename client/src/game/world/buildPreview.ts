/**
 * Build preview ghost mesh
 */

import * as THREE from 'three';
import { BuildPieceType, TERRITORY_CELL_SIZE } from '@worldify/shared';
import { getScene } from '../scene/scene';

export class BuildPreview {
  private mesh: THREE.Mesh | null = null;
  private currentType: BuildPieceType | null = null;

  show(type: BuildPieceType, gridX: number, gridZ: number, rotation: number): void {
    const scene = getScene();
    if (!scene) return;

    // Recreate mesh if type changed
    if (this.currentType !== type) {
      this.hide();
      this.mesh = this.createMesh(type);
      scene.add(this.mesh);
      this.currentType = type;
    }

    if (this.mesh) {
      this.mesh.position.set(
        gridX * TERRITORY_CELL_SIZE,
        type === BuildPieceType.FLOOR ? 0.05 : 1,
        gridZ * TERRITORY_CELL_SIZE
      );
      this.mesh.rotation.y = (rotation * Math.PI) / 2;
      this.mesh.visible = true;
    }
  }

  hide(): void {
    if (this.mesh) {
      const scene = getScene();
      if (scene) {
        scene.remove(this.mesh);
      }
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
      this.currentType = null;
    }
  }

  private createMesh(type: BuildPieceType): THREE.Mesh {
    let geo: THREE.BufferGeometry;

    switch (type) {
      case BuildPieceType.FLOOR:
        geo = new THREE.BoxGeometry(TERRITORY_CELL_SIZE, 0.1, TERRITORY_CELL_SIZE);
        break;
      case BuildPieceType.WALL:
        geo = new THREE.BoxGeometry(TERRITORY_CELL_SIZE, 2, 0.2);
        break;
      case BuildPieceType.SLOPE:
        geo = new THREE.BoxGeometry(TERRITORY_CELL_SIZE, 0.1, TERRITORY_CELL_SIZE);
        break;
      default:
        geo = new THREE.BoxGeometry(1, 1, 1);
    }

    const mat = new THREE.MeshStandardMaterial({
      color: 0x4f46e5,
      transparent: true,
      opacity: 0.5,
    });

    return new THREE.Mesh(geo, mat);
  }
}
