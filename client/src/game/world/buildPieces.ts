/**
 * Build pieces rendering
 */

import * as THREE from 'three';
import { BuildPieceType, BuildCommit, TERRITORY_CELL_SIZE } from '@worldify/shared';
import { getScene } from '../scene/scene';

export class BuildPieces {
  private pieces: Map<number, THREE.Mesh> = new Map();

  addPiece(commit: BuildCommit): void {
    const scene = getScene();
    if (!scene) return;

    const mesh = this.createMesh(commit.pieceType);
    mesh.position.set(
      commit.gridX * TERRITORY_CELL_SIZE,
      commit.pieceType === BuildPieceType.FLOOR ? 0.05 : 1,
      commit.gridZ * TERRITORY_CELL_SIZE
    );
    mesh.rotation.y = (commit.rotation * Math.PI) / 2;

    scene.add(mesh);
    this.pieces.set(commit.buildSeq, mesh);
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

    const mat = new THREE.MeshStandardMaterial({ color: 0x6366f1 });
    return new THREE.Mesh(geo, mat);
  }

  dispose(): void {
    const scene = getScene();
    for (const mesh of this.pieces.values()) {
      if (scene) {
        scene.remove(mesh);
      }
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.pieces.clear();
  }
}
