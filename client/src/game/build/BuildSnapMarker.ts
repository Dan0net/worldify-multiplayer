/**
 * BuildSnapMarker — Visual rendering for snap point markers.
 * 
 * Uses InstancedMesh with simple translucent blue octahedrons.
 * 
 * Two visual sets:
 * - Deposited markers (blue): persistent points left after placement.
 *   The specific marker being snapped to is highlighted green.
 * - Current-shape markers (white): ephemeral points on the active shape.
 */

import * as THREE from 'three';

/** Maximum instances per instanced mesh */
const MAX_INSTANCES = 128;

/** Marker geometry radius */
const MARKER_RADIUS = 0.16;

/** Color for deposited markers (idle) */
const COLOR_DEPOSITED = new THREE.Color(0x2266ff);

/** Color for the specific deposited marker being snapped to */
const COLOR_SNAPPED = new THREE.Color(0x00ff66);

/** Color for current-shape snap points */
const COLOR_CURRENT = new THREE.Color(0xffffff);

/**
 * BuildSnapMarker manages instanced mesh rendering for snap point visualization.
 */
export class BuildSnapMarker {
  /** Container group added to scene */
  readonly group: THREE.Group;

  /** Instanced mesh for deposited markers */
  private depositedMesh: THREE.InstancedMesh;
  private depositedMaterial: THREE.MeshBasicMaterial;

  /** Instanced mesh for current-shape markers */
  private currentMesh: THREE.InstancedMesh;
  private currentMaterial: THREE.MeshBasicMaterial;

  /** Shared geometry */
  private geometry: THREE.OctahedronGeometry;

  /** Dummy for setting instance matrices */
  private readonly dummy = new THREE.Object3D();

  /** Currently highlighted deposited marker index (-1 = none) */
  private highlightedIndex = -1;

  /** Current deposited count (for color updates) */
  private depositedCount = 0;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'BuildSnapMarkers';

    this.geometry = new THREE.OctahedronGeometry(MARKER_RADIUS, 0);

    // Deposited markers — plain blue
    this.depositedMaterial = new THREE.MeshBasicMaterial({
      color: COLOR_DEPOSITED,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.depositedMesh = new THREE.InstancedMesh(this.geometry, this.depositedMaterial, MAX_INSTANCES);
    this.depositedMesh.count = 0;
    this.depositedMesh.frustumCulled = false;
    // Enable per-instance color
    this.depositedMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES * 3), 3
    );
    this.group.add(this.depositedMesh);

    // Current-shape markers — white, more transparent
    this.currentMaterial = new THREE.MeshBasicMaterial({
      color: COLOR_CURRENT,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.currentMesh = new THREE.InstancedMesh(this.geometry, this.currentMaterial, MAX_INSTANCES);
    this.currentMesh.count = 0;
    this.currentMesh.frustumCulled = false;
    this.group.add(this.currentMesh);
  }

  /**
   * Update deposited marker instances from world positions.
   */
  updateDeposited(positions: THREE.Vector3[]): void {
    const count = Math.min(positions.length, MAX_INSTANCES);
    this.depositedMesh.count = count;
    this.depositedCount = count;

    for (let i = 0; i < count; i++) {
      this.dummy.position.copy(positions[i]);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.depositedMesh.setMatrixAt(i, this.dummy.matrix);
      // Set default blue color
      this.depositedMesh.setColorAt(i, COLOR_DEPOSITED);
    }
    this.depositedMesh.instanceMatrix.needsUpdate = true;
    if (this.depositedMesh.instanceColor) {
      this.depositedMesh.instanceColor.needsUpdate = true;
    }
    this.highlightedIndex = -1;
  }

  /**
   * Update current-shape marker instances from world positions.
   */
  updateCurrent(positions: THREE.Vector3[]): void {
    const count = Math.min(positions.length, MAX_INSTANCES);
    this.currentMesh.count = count;

    for (let i = 0; i < count; i++) {
      this.dummy.position.copy(positions[i]);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.currentMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.currentMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Highlight a specific deposited marker as snapped (green).
   * Pass -1 to clear highlighting.
   */
  setSnappedIndex(index: number): void {
    if (index === this.highlightedIndex) return;

    // Reset previous highlight
    if (this.highlightedIndex >= 0 && this.highlightedIndex < this.depositedCount) {
      this.depositedMesh.setColorAt(this.highlightedIndex, COLOR_DEPOSITED);
    }

    // Set new highlight
    if (index >= 0 && index < this.depositedCount) {
      this.depositedMesh.setColorAt(index, COLOR_SNAPPED);
    }

    this.highlightedIndex = index;

    if (this.depositedMesh.instanceColor) {
      this.depositedMesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Show/hide all markers.
   */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * Clear all markers.
   */
  clear(): void {
    this.depositedMesh.count = 0;
    this.currentMesh.count = 0;
    this.depositedCount = 0;
    this.highlightedIndex = -1;
  }

  /**
   * Dispose of GPU resources.
   */
  dispose(): void {
    this.geometry.dispose();
    this.depositedMaterial.dispose();
    this.currentMaterial.dispose();
    this.depositedMesh.dispose();
    this.currentMesh.dispose();
  }
}
