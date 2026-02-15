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
import { MAX_BUILD_DISTANCE } from '@worldify/shared';

/** Maximum instances per instanced mesh */
const MAX_INSTANCES = 128;

/** Marker geometry radius */
const MARKER_RADIUS = 0.16;

/** Distance at which markers start fading out (fraction of MAX_BUILD_DISTANCE) */
const FADE_START = MAX_BUILD_DISTANCE * 0.65;
/** Distance at which markers are fully invisible */
const FADE_END = MAX_BUILD_DISTANCE;

/** Color for deposited markers (idle) */
const COLOR_DEPOSITED = new THREE.Color(0x2266ff);

/** Color for the specific deposited marker being snapped to */
const COLOR_SNAPPED = new THREE.Color(0x00ff00);

/** Color for current-shape snap points (same blue as deposited) */
const COLOR_CURRENT = new THREE.Color(0x2266ff);

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

  /** Currently highlighted deposited marker indices */
  private highlightedDeposited = new Set<number>();

  /** Currently highlighted current-shape marker indices */
  private highlightedCurrent = new Set<number>();

  /** Current deposited count (for color updates) */
  private depositedCount = 0;

  /** Current-shape count (for color updates) */
  private currentCount = 0;

  /** Stored positions for distance fade calculations */
  private depositedPositions: THREE.Vector3[] = [];
  private currentPositions: THREE.Vector3[] = [];

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'BuildSnapMarkers';

    this.geometry = new THREE.OctahedronGeometry(MARKER_RADIUS, 0);

    // Deposited markers — plain blue, rendered on top of everything
    this.depositedMaterial = new THREE.MeshBasicMaterial({
      color: COLOR_DEPOSITED,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this.depositedMesh = new THREE.InstancedMesh(this.geometry, this.depositedMaterial, MAX_INSTANCES);
    this.depositedMesh.count = 0;
    this.depositedMesh.frustumCulled = false;
    this.depositedMesh.renderOrder = 1000;
    // Enable per-instance color
    this.depositedMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES * 3), 3
    );
    this.group.add(this.depositedMesh);

    // Current-shape markers — blue, more transparent, rendered on top
    this.currentMaterial = new THREE.MeshBasicMaterial({
      color: COLOR_CURRENT,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this.currentMesh = new THREE.InstancedMesh(this.geometry, this.currentMaterial, MAX_INSTANCES);
    this.currentMesh.count = 0;
    this.currentMesh.frustumCulled = false;
    this.currentMesh.renderOrder = 999;
    // Enable per-instance color for current markers
    this.currentMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES * 3), 3
    );
    this.group.add(this.currentMesh);
  }

  /**
   * Update deposited marker instances from world positions.
   */
  updateDeposited(positions: THREE.Vector3[]): void {
    const count = Math.min(positions.length, MAX_INSTANCES);
    this.depositedMesh.count = count;
    this.depositedCount = count;
    this.depositedPositions = positions.slice(0, count);

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
    this.highlightedDeposited.clear();
  }

  /**
   * Update current-shape marker instances from world positions.
   */
  updateCurrent(positions: THREE.Vector3[]): void {
    const count = Math.min(positions.length, MAX_INSTANCES);
    this.currentMesh.count = count;
    this.currentCount = count;
    this.currentPositions = positions.slice(0, count);

    for (let i = 0; i < count; i++) {
      this.dummy.position.copy(positions[i]);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.currentMesh.setMatrixAt(i, this.dummy.matrix);
      // Set default blue color
      this.currentMesh.setColorAt(i, COLOR_CURRENT);
    }
    this.currentMesh.instanceMatrix.needsUpdate = true;
    if (this.currentMesh.instanceColor) {
      this.currentMesh.instanceColor.needsUpdate = true;
    }
    this.highlightedCurrent.clear();
  }

  /**
   * Highlight all deposited and current-shape markers that are overlapping (green).
   * Pass empty sets to clear all highlighting.
   */
  setSnappedSets(depositedIndices: ReadonlySet<number>, currentIndices: ReadonlySet<number>): void {
    // --- Deposited highlights ---
    let depositedDirty = false;

    // Reset previous highlights that are no longer in the set
    for (const idx of this.highlightedDeposited) {
      if (!depositedIndices.has(idx) && idx < this.depositedCount) {
        this.depositedMesh.setColorAt(idx, COLOR_DEPOSITED);
        depositedDirty = true;
      }
    }
    // Set new highlights
    for (const idx of depositedIndices) {
      if (idx < this.depositedCount) {
        this.depositedMesh.setColorAt(idx, COLOR_SNAPPED);
        depositedDirty = true;
      }
    }
    this.highlightedDeposited = new Set(depositedIndices);
    if (depositedDirty && this.depositedMesh.instanceColor) {
      this.depositedMesh.instanceColor.needsUpdate = true;
    }

    // --- Current-shape highlights ---
    let currentDirty = false;

    // Reset previous highlights that are no longer in the set
    for (const idx of this.highlightedCurrent) {
      if (!currentIndices.has(idx) && idx < this.currentCount) {
        this.currentMesh.setColorAt(idx, COLOR_CURRENT);
        currentDirty = true;
      }
    }
    // Set new highlights
    for (const idx of currentIndices) {
      if (idx < this.currentCount) {
        this.currentMesh.setColorAt(idx, COLOR_SNAPPED);
        currentDirty = true;
      }
    }
    this.highlightedCurrent = new Set(currentIndices);
    if (currentDirty && this.currentMesh.instanceColor) {
      this.currentMesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Update per-instance scale based on distance from camera.
   * Markers fade out (shrink) between FADE_START and FADE_END.
   */
  updateFade(cameraPosition: THREE.Vector3): void {
    const invRange = 1 / (FADE_END - FADE_START);

    // Fade deposited markers
    if (this.depositedCount > 0) {
      let dirty = false;
      for (let i = 0; i < this.depositedCount; i++) {
        const dist = this.depositedPositions[i].distanceTo(cameraPosition);
        let scale: number;
        if (dist <= FADE_START) {
          scale = 1;
        } else if (dist >= FADE_END) {
          scale = 0;
        } else {
          scale = 1 - (dist - FADE_START) * invRange;
        }
        this.dummy.position.copy(this.depositedPositions[i]);
        this.dummy.scale.setScalar(scale);
        this.dummy.updateMatrix();
        this.depositedMesh.setMatrixAt(i, this.dummy.matrix);
        dirty = true;
      }
      if (dirty) {
        this.depositedMesh.instanceMatrix.needsUpdate = true;
      }
    }

    // Fade current-shape markers
    if (this.currentCount > 0) {
      let dirty = false;
      for (let i = 0; i < this.currentCount; i++) {
        const dist = this.currentPositions[i].distanceTo(cameraPosition);
        let scale: number;
        if (dist <= FADE_START) {
          scale = 1;
        } else if (dist >= FADE_END) {
          scale = 0;
        } else {
          scale = 1 - (dist - FADE_START) * invRange;
        }
        this.dummy.position.copy(this.currentPositions[i]);
        this.dummy.scale.setScalar(scale);
        this.dummy.updateMatrix();
        this.currentMesh.setMatrixAt(i, this.dummy.matrix);
        dirty = true;
      }
      if (dirty) {
        this.currentMesh.instanceMatrix.needsUpdate = true;
      }
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
    this.currentCount = 0;
    this.highlightedDeposited.clear();
    this.highlightedCurrent.clear();
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
