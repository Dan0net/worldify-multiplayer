/**
 * BuildMarker - Wireframe indicator for build placement
 * 
 * Shows a wireframe shape at the raycast hit point to indicate
 * where the build will be placed.
 */

import * as THREE from 'three';
import {
  BuildShape,
  BuildMode,
  BuildPreset,
  BuildPresetAlign,
  MAX_BUILD_DISTANCE,
  VOXEL_SCALE,
  BUILD_ROTATION_STEP,
  getPreset,
  composeRotation,
} from '@worldify/shared';
import { storeBridge } from '../../state/bridge';

// Colors for different build modes
const COLOR_ADD = 0x00ff00;      // Green for add
const COLOR_SUBTRACT = 0xff0000; // Red for subtract
const COLOR_PAINT = 0x0088ff;    // Blue for paint
const COLOR_FILL = 0xffff00;     // Yellow for fill
const COLOR_INVALID = 0x888888;  // Gray for invalid/too far

/**
 * Gets the wireframe color for a build mode.
 */
function getModeColor(mode: BuildMode, isValid: boolean): number {
  if (!isValid) return COLOR_INVALID;
  switch (mode) {
    case BuildMode.ADD: return COLOR_ADD;
    case BuildMode.SUBTRACT: return COLOR_SUBTRACT;
    case BuildMode.PAINT: return COLOR_PAINT;
    case BuildMode.FILL: return COLOR_FILL;
    default: return COLOR_ADD;
  }
}

/**
 * BuildMarker renders a wireframe indicator for build placement.
 */
export class BuildMarker {
  /** Container for all marker geometry */
  private readonly group: THREE.Group;

  /** Current wireframe mesh */
  private wireframe: THREE.LineSegments | null = null;

  /** Raycaster for hit detection */
  private readonly raycaster: THREE.Raycaster;

  /** Reusable vectors */
  private readonly _direction = new THREE.Vector3();
  private readonly _hitPoint = new THREE.Vector3();
  private readonly _hitNormal = new THREE.Vector3();

  /** Stored composed rotation quaternion (base + user Y rotation) */
  private readonly _composedQuat = new THREE.Quaternion();

  /** Temp vectors for projection calculations */
  private readonly _hNormal = new THREE.Vector3();
  private readonly _tempAxis = new THREE.Vector3();

  /** Rotated OBB half-Y extent (world units), updated per-rebuild */
  private rotatedHalfY = 0;

  /** Current preset ID being shown */
  private currentPresetId = -1;

  /** Current rotation steps */
  private currentRotation = -1;

  /** Whether marker is currently visible */
  private isVisible = false;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'BuildMarker';
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = MAX_BUILD_DISTANCE;
  }

  /**
   * Get the Three.js group to add to scene.
   */
  getObject(): THREE.Group {
    return this.group;
  }

  /**
   * Update the marker position and visibility.
   * Should be called every frame.
   * 
   * @param camera The camera to raycast from
   * @param collisionMeshes Array of meshes to raycast against
   * @returns Whether a valid build target was found
   */
  update(camera: THREE.Camera, collisionMeshes: THREE.Object3D[]): { hasValidTarget: boolean } {
    const presetId = storeBridge.buildPresetId;
    const rotationSteps = storeBridge.buildRotationSteps;

    // Hide if build mode disabled (preset 0)
    if (presetId === 0) {
      this.hide();
      return { hasValidTarget: false };
    }

    const preset = getPreset(presetId);

    // Rebuild wireframe if preset or rotation changed
    if (presetId !== this.currentPresetId || rotationSteps !== this.currentRotation) {
      this.rebuildWireframe(preset, rotationSteps);
      this.currentPresetId = presetId;
      this.currentRotation = rotationSteps;
    }

    // Raycast from camera center
    this._direction.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.raycaster.set(camera.position, this._direction);

    const intersects = this.raycaster.intersectObjects(collisionMeshes, false);

    if (intersects.length === 0) {
      this.hide();
      return { hasValidTarget: false };
    }

    const hit = intersects[0];
    
    // Check distance
    const isValid = hit.distance <= MAX_BUILD_DISTANCE;
    
    // Get hit point and normal
    this._hitPoint.copy(hit.point);
    if (hit.face) {
      // Transform normal to world space (handles rotated/scaled meshes)
      this._hitNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    } else {
      this._hitNormal.set(0, 1, 0);
    }

    // Calculate marker position based on align mode
    const position = this.calculatePosition(preset, this._hitPoint, this._hitNormal);
    this.group.position.copy(position);

    // Update color based on validity
    this.updateColor(preset.config.mode, isValid);

    // Show the marker
    this.show();
    return { hasValidTarget: isValid };
  }

  /**
   * Calculate the build position based on alignment mode.
   * Note: For BASE alignment, the wireframe is offset up within the group,
   * so the group position stays at the hit point (which is the base).
   */
  private calculatePosition(
    preset: BuildPreset,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3
  ): THREE.Vector3 {
    const size = preset.config.size;
    const pos = hitPoint.clone();

    switch (preset.align) {
      case BuildPresetAlign.CENTER:
        // Center on hit point - no offset (works for both ADD and SUBTRACT)
        break;

      case BuildPresetAlign.BASE:
        // Base at hit point - wireframe is offset up within the group
        break;

      case BuildPresetAlign.PROJECT: {
        // Horizontal: base at surface (wireframe Y offset handles visual,
        // getTargetPosition handles build center). No extra offset.
        // Vertical: full OBB depth offset along horizontal normal so shape
        // fully protrudes and nothing clips behind the surface.
        if (Math.abs(hitNormal.y) < 0.5) {
          const hN = this._hNormal.set(hitNormal.x, 0, hitNormal.z).normalize();

          // Full OBB support value along horizontal normal
          this._tempAxis.set(1, 0, 0).applyQuaternion(this._composedQuat);
          let depthExtent = size.x * Math.abs(this._tempAxis.dot(hN));
          this._tempAxis.set(0, 1, 0).applyQuaternion(this._composedQuat);
          depthExtent += size.y * Math.abs(this._tempAxis.dot(hN));
          this._tempAxis.set(0, 0, 1).applyQuaternion(this._composedQuat);
          depthExtent += size.z * Math.abs(this._tempAxis.dot(hN));

          pos.addScaledVector(hN, depthExtent * VOXEL_SCALE);
        }
        break;
      }

      case BuildPresetAlign.SURFACE:
        // Offset along normal by half size (average half-extent)
        const avgSize = (size.x + size.y + size.z) / 3;
        pos.addScaledVector(hitNormal, avgSize * VOXEL_SCALE);
        break;
    }

    return pos;
  }

  /**
   * Rebuild the wireframe geometry for the current preset.
   */
  private rebuildWireframe(preset: BuildPreset, rotationSteps: number): void {
    // Remove old wireframe
    if (this.wireframe) {
      this.group.remove(this.wireframe);
      this.wireframe.geometry.dispose();
      (this.wireframe.material as THREE.Material).dispose();
      this.wireframe = null;
    }

    // Don't create wireframe for disabled preset
    if (preset.id === 0) return;

    const size = preset.config.size;
    const shape = preset.config.shape;

    // Size values are half-extents in voxel units
    // Convert to world units: size * VOXEL_SCALE for radius/half-extent
    // For full dimensions (box width/height), use size * 2 * VOXEL_SCALE
    const halfX = size.x * VOXEL_SCALE;
    const halfY = size.y * VOXEL_SCALE;
    const halfZ = size.z * VOXEL_SCALE;

    let geometry: THREE.BufferGeometry;

    switch (shape) {
      case BuildShape.SPHERE:
        // Sphere radius is size.x
        geometry = new THREE.IcosahedronGeometry(halfX, 1);
        break;

      case BuildShape.CYLINDER:
        // Cylinder: radius = size.x, half-height = size.y
        geometry = new THREE.CylinderGeometry(halfX, halfX, halfY * 2, 16);
        break;

      case BuildShape.PRISM:
        // Triangular prism - full dimensions
        geometry = this.createPrismGeometry(halfX * 2, halfY * 2, halfZ * 2);
        break;

      case BuildShape.CUBE:
      default:
        // Box uses full dimensions
        geometry = new THREE.BoxGeometry(halfX * 2, halfY * 2, halfZ * 2);
        break;
    }

    // Create edges geometry for wireframe
    const edges = new THREE.EdgesGeometry(geometry);
    geometry.dispose();

    const material = new THREE.LineBasicMaterial({
      color: getModeColor(preset.config.mode, true),
      linewidth: 2,
      transparent: true,
      opacity: 0.8,
    });

    this.wireframe = new THREE.LineSegments(edges, material);

    // Apply composed rotation (base rotation + user Y rotation)
    const composed = composeRotation(preset, (rotationSteps * BUILD_ROTATION_STEP * Math.PI) / 180);
    this._composedQuat.set(composed.x, composed.y, composed.z, composed.w);
    this.wireframe.quaternion.copy(this._composedQuat);

    // Compute the rotated OBB half-Y extent (world units).
    // This is the correct base offset for shapes with baseRotation (e.g. floors, stairs).
    this._tempAxis.set(1, 0, 0).applyQuaternion(this._composedQuat);
    this.rotatedHalfY = size.x * Math.abs(this._tempAxis.y);
    this._tempAxis.set(0, 1, 0).applyQuaternion(this._composedQuat);
    this.rotatedHalfY += size.y * Math.abs(this._tempAxis.y);
    this._tempAxis.set(0, 0, 1).applyQuaternion(this._composedQuat);
    this.rotatedHalfY += size.z * Math.abs(this._tempAxis.y);
    this.rotatedHalfY *= VOXEL_SCALE;

    // For BASE and PROJECT, offset the wireframe up by the rotated half-Y so
    // the shape's bottom edge sits at the group origin (base at surface).
    if (preset.align === BuildPresetAlign.BASE || preset.align === BuildPresetAlign.PROJECT) {
      this.wireframe.position.y = this.rotatedHalfY;
    }

    this.group.add(this.wireframe);
  }

  /**
   * Create a triangular prism geometry.
   */
  private createPrismGeometry(width: number, height: number, depth: number): THREE.BufferGeometry {
    // Simple triangular prism
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;

    const vertices = new Float32Array([
      // Front triangle
      0, hh, hd,      // top
      -hw, -hh, hd,   // bottom left
      hw, -hh, hd,    // bottom right
      // Back triangle
      0, hh, -hd,     // top
      -hw, -hh, -hd,  // bottom left
      hw, -hh, -hd,   // bottom right
    ]);

    const indices = [
      // Front face
      0, 1, 2,
      // Back face
      3, 5, 4,
      // Bottom face
      1, 4, 5, 1, 5, 2,
      // Left face
      0, 3, 4, 0, 4, 1,
      // Right face
      0, 2, 5, 0, 5, 3,
    ];

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    return geometry;
  }

  /**
   * Update the wireframe color.
   */
  private updateColor(mode: BuildMode, isValid: boolean): void {
    if (!this.wireframe) return;
    const material = this.wireframe.material as THREE.LineBasicMaterial;
    material.color.setHex(getModeColor(mode, isValid));
  }

  /**
   * Show the marker.
   */
  private show(): void {
    if (!this.isVisible) {
      this.group.visible = true;
      this.isVisible = true;
    }
  }

  /**
   * Hide the marker.
   */
  private hide(): void {
    if (this.isVisible) {
      this.group.visible = false;
      this.isVisible = false;
    }
  }

  /**
   * Get the build operation center position (world coordinates).
   * For BASE alignment, this is offset up from the hit point by half the shape height.
   * Returns null if no valid target.
   */
  getTargetPosition(): THREE.Vector3 | null {
    if (!this.isVisible) return null;

    const preset = getPreset(this.currentPresetId);
    const pos = this.group.position.clone();

    // For BASE / PROJECT, the group is at the hit point (base of the shape)
    // but the build operation needs the center, so offset up by the rotated half-Y.
    if (preset.align === BuildPresetAlign.BASE || preset.align === BuildPresetAlign.PROJECT) {
      pos.y += this.rotatedHalfY;
    }

    return pos;
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    if (this.wireframe) {
      this.wireframe.geometry.dispose();
      (this.wireframe.material as THREE.Material).dispose();
      this.group.remove(this.wireframe);
      this.wireframe = null;
    }
  }
}
