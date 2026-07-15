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
  BuildConfig,
  BuildPreset,
  BuildPresetAlign,
  BuildPresetSnapShape,
  MAX_BUILD_DISTANCE,
  VOXEL_SCALE,
  BUILD_ROTATION_STEP,
  BUILD_PROJECTION_DEADZONE,
  composeRotation,
  slotIsEmpty,
} from '@worldify/shared';
import { useGameStore } from '../../state/store';
import { getBuildPreset, getBuildRotationRadians } from '../../state/buildAccessors';

/**
 * Derive a "projection size" from the snap shape.
 * PLANE zeroes the thinnest axis (treats the shape as a flat plane).
 * LINE zeroes the two thinnest axes (treats it as a 1D line).
 * All others return the original size unchanged.
 */
function getProjectionSize(snapShape: BuildPresetSnapShape, size: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  if (snapShape === BuildPresetSnapShape.PLANE || snapShape === BuildPresetSnapShape.PRISM) {
    // Zero the smallest axis
    const min = Math.min(size.x, size.y, size.z);
    return {
      x: size.x === min ? 0 : size.x,
      y: size.y === min ? 0 : size.y,
      z: size.z === min ? 0 : size.z,
    };
  }
  if (snapShape === BuildPresetSnapShape.LINE) {
    // Keep only the largest axis
    const max = Math.max(size.x, size.y, size.z);
    return {
      x: size.x === max ? size.x : 0,
      y: size.y === max ? size.y : 0,
      z: size.z === max ? size.z : 0,
    };
  }
  return size;
}

// Colors for different build modes
const COLOR_ADD = 0x00ff00;      // Green for add
const COLOR_SUBTRACT = 0xff0000; // Red for subtract
const COLOR_PAINT = 0x0088ff;    // Blue for paint
const COLOR_FILL = 0xffff00;     // Yellow for fill
const COLOR_INVALID = 0x888888;  // Gray for invalid/too far
const COLOR_TOO_CLOSE = 0xff4400; // Orange for too close to player

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

  /** Current wireframe mesh (single-config / legacy-alignment path) */
  private wireframe: THREE.LineSegments | null = null;

  /** Per-part wireframe meshes (point-out / composite path); empty otherwise */
  private partWireframes: THREE.LineSegments[] = [];

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
  private readonly _hTangent = new THREE.Vector3();
  private readonly _tempAxis = new THREE.Vector3();

  /** Reusable objects for the point-out orientation path */
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _alignQuat = new THREE.Quaternion();
  private readonly _spinQuat = new THREE.Quaternion();
  private readonly _offsetVec = new THREE.Vector3();

  /** Rotated OBB half-Y extent (world units), updated per-rebuild */
  private rotatedHalfY = 0;

  /** Current preset ID being shown */
  private currentPresetId = -1;

  /** Current rotation steps */
  private currentRotation = -1;

  /** Config fingerprint for detecting preset template changes within the same slot */
  private currentConfigFingerprint = '';

  /** Whether marker is currently visible */
  private isVisible = false;

  /** Auto-computed Y rotation from face normal (radians), null when not auto-rotating */
  private autoYRadians: number | null = null;

  /** Cached auto-rotation Y steps equivalent (for dirty-checking) */
  private lastAutoYAngle = NaN;

  /** Reusable NDC vector for screen-space (mobile reticle) raycasts */
  private _ndc = new THREE.Vector2();

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
   * @param castNDC Optional screen-space cast point in NDC (-1..1). When provided
   *   (mobile reticle), the ray is cast through that point; otherwise the ray uses
   *   the camera-centre direction (desktop pointer-lock behaviour).
   * @returns Whether a valid build target was found
   */
  update(
    camera: THREE.Camera,
    collisionMeshes: THREE.Object3D[],
    castNDC?: { x: number; y: number } | null,
  ): { hasValidTarget: boolean } {
    const buildState = useGameStore.getState().build;
    const presetId = buildState.presetId;
    const rotationSteps = buildState.rotationSteps;

    // Hide if build mode is off, or the selected slot has no buildable geometry (empty slot).
    if (!buildState.buildMode || slotIsEmpty(buildState.presetMeta[presetId])) {
      this.hide();
      return { hasValidTarget: false };
    }

    const preset = getBuildPreset();

    // Generate a fingerprint to detect config/meta changes within the same slot
    const cfg = preset.parts[0].config;
    const partsFp = preset.parts
      .map((p) => `${p.config.shape}:${p.config.material}:${p.config.size.x},${p.config.size.y},${p.config.size.z}@${p.offset.x},${p.offset.y},${p.offset.z}`)
      .join(';');
    const fp = `${cfg.shape}|${cfg.size.x},${cfg.size.y},${cfg.size.z}|${preset.snapShape}|${preset.align}|${cfg.thickness ?? ''}|${cfg.arcSweep ?? ''}|${preset.baseRotation?.x ?? ''},${preset.baseRotation?.y ?? ''},${preset.baseRotation?.z ?? ''},${preset.baseRotation?.w ?? ''}|${partsFp}`;
    const configChanged = fp !== this.currentConfigFingerprint;

    // Point-out and auto-rotate derive orientation from the hit normal each frame, so their
    // geometry is rebuilt on preset/config change only; everything else rebuilds on rotation too.
    const perFrameOrient = preset.autoRotateY || preset.align === BuildPresetAlign.POINT_OUT;
    if (!perFrameOrient) {
      this.autoYRadians = null;
      if (presetId !== this.currentPresetId || rotationSteps !== this.currentRotation || configChanged) {
        this.rebuildWireframe(preset, rotationSteps);
        this.currentPresetId = presetId;
        this.currentRotation = rotationSteps;
        this.currentConfigFingerprint = fp;
      }
    } else if (presetId !== this.currentPresetId || configChanged) {
      // Per-frame orient: rebuild geometry on preset/config change only (rotation updated below)
      this.rebuildWireframe(preset, 0);
      this.currentPresetId = presetId;
      this.currentRotation = 0;
      this.currentConfigFingerprint = fp;
    }

    // Raycast through the screen-space cast point (mobile reticle) or the
    // camera centre (desktop). setFromCamera uses the camera's projection so
    // the NDC point maps correctly through FOV/aspect.
    if (castNDC) {
      this._ndc.set(castNDC.x, castNDC.y);
      this.raycaster.setFromCamera(this._ndc, camera);
      this.raycaster.far = MAX_BUILD_DISTANCE;
    } else {
      this._direction.set(0, 0, -1).applyQuaternion(camera.quaternion);
      this.raycaster.set(camera.position, this._direction);
    }

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

    // For auto-rotate presets, derive Y rotation from the hit normal each frame
    if (preset.autoRotateY) {
      this.applyAutoRotateY(preset, this._hitNormal);
    } else if (preset.align === BuildPresetAlign.POINT_OUT) {
      // Point-out: full orientation from the hit normal (up off floors, down off ceilings, …)
      this.applyPointOut(preset, this._hitNormal);
    }

    // Update color based on validity
    this.updateColor(preset.parts[0].config.mode, isValid);

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
    const size = preset.parts[0].config.size;
    const pos = hitPoint.clone();

    switch (preset.align) {
      case BuildPresetAlign.CENTER:
        // Center on hit point - no offset (works for both ADD and SUBTRACT)
        break;

      case BuildPresetAlign.BASE:
        // Base at hit point - wireframe is offset up within the group
        break;

      case BuildPresetAlign.POINT_OUT:
        // Anchor at the hit point; the part wireframes carry their own (rotated) offsets so
        // the base plants on the surface and the shape extends out along the normal.
        break;

      case BuildPresetAlign.PROJECT: {
        // Use projection size (snap-shape-aware) so plane-like shapes
        // sit centered on the surface rather than fully protruding.
        const projSize = getProjectionSize(preset.snapShape, size);

        // On horizontal surfaces: base sits on surface (handled by wireframe offset),
        // and shape is offset so its front center is at the hit point.
        // The shape pivots around the hit point as the user rotates.
        // On vertical surfaces: push shape out so it fully protrudes from the wall,
        // then slide it sideways so the protruding corner sits at the hit point.
        if (Math.abs(hitNormal.y) < 0.5) {
          // Get the wall's horizontal normal and tangent directions
          const wallNormal = this._hNormal.set(hitNormal.x, 0, hitNormal.z).normalize();
          const wallTangent = this._hTangent.set(-wallNormal.z, 0, wallNormal.x);

          // How far does the rotated shape extend along the normal and tangent?
          const { depth, slide } = this.getProjectedExtents(wallNormal, wallTangent, projSize);

          // Push outward so back face is flush with surface
          pos.addScaledVector(wallNormal, depth * VOXEL_SCALE);
          // Slide sideways so protruding corner aligns with hit point
          pos.addScaledVector(wallTangent, slide * VOXEL_SCALE);
        } else {
          // Horizontal surface (floor or ceiling):
          // Offset so front center of shape sits at hit point.
          // "Front" = local +Z axis projected to horizontal after composed rotation.
          // Fallback to local -Y if +Z is vertical (e.g. floor with 90° X rotation).
          const forward = this._hNormal.set(0, 0, 1).applyQuaternion(this._composedQuat);
          forward.y = 0;
          if (forward.lengthSq() < 0.001) {
            // +Z is vertical — use local -Y as forward (original depth axis before X rotation)
            forward.set(0, -1, 0).applyQuaternion(this._composedQuat);
            forward.y = 0;
          }
          if (forward.lengthSq() > 0.001) {
            forward.normalize();
            // Compute half-extent of the rotated shape along the forward direction
            const halfExtent = this.getHorizontalExtent(forward, projSize);
            // Offset forward so the back (bottom) edge sits at the hit point
            // and the shape extends outward away from it
            pos.addScaledVector(forward, halfExtent * VOXEL_SCALE);
          }
        }
        break;
      }

      case BuildPresetAlign.SURFACE: {
        // Offset along normal by half size (average half-extent)
        const avgSize = (size.x + size.y + size.z) / 3;
        pos.addScaledVector(hitNormal, avgSize * VOXEL_SCALE);
        break;
      }

      case BuildPresetAlign.CARVE: {
        // Carve INTO the surface: offset along the negative normal.
        // The shape's OBB extent along the normal gives the carve depth.
        // On vertical surfaces the base sits on the ground (Y offset up).
        if (Math.abs(hitNormal.y) < 0.5) {
          // Vertical wall: compute depth along the horizontal normal
          const wallNormal = this._hNormal.set(hitNormal.x, 0, hitNormal.z).normalize();
          const depth = this.getCarveDepth(wallNormal, size);
          // Push INTO the wall (negative normal direction)
          pos.addScaledVector(wallNormal, -depth * VOXEL_SCALE);
        } else {
          // Horizontal surface: push into the surface
          const depth = this.getCarveDepthVertical(size);
          pos.addScaledVector(hitNormal, -depth * VOXEL_SCALE);
        }
        break;
      }
    }

    return pos;
  }

  /**
   * For the rotated shape, compute how far it extends along a wall's normal
   * and how far to slide it sideways so the protruding corner sits at the origin.
   *
   * Imagine the shape's 3 local axes (X, Y, Z) rotated into world space.
   * Each axis contributes to both the wall-normal direction (depth) and
   * the wall-tangent direction (sideways slide).
   *
   * - depth: total half-extent of the shape along the wall normal
   *          (sum of each axis's normal contribution)
   * - slide: how far the protruding corner is offset sideways from center.
   *          Only axes that meaningfully face the wall contribute;
   *          axes parallel to the wall (within deadzone) are ignored
   *          so the shape stays centered at 0° and 90°.
   */
  private getProjectedExtents(
    wallNormal: THREE.Vector3,
    wallTangent: THREE.Vector3,
    size: { x: number; y: number; z: number }
  ): { depth: number; slide: number } {
    const DEADZONE = BUILD_PROJECTION_DEADZONE;
    const halfExtents = [size.x, size.y, size.z];
    let depth = 0;
    let slide = 0;

    for (let i = 0; i < 3; i++) {
      // Get this local axis in world space (only X and Z matter horizontally)
      this._tempAxis.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0)
        .applyQuaternion(this._composedQuat);

      // How much does this axis point into/away from the wall?
      const normalAmount = this._tempAxis.x * wallNormal.x + this._tempAxis.z * wallNormal.z;
      // How much does this axis run along the wall surface?
      const tangentAmount = this._tempAxis.x * wallTangent.x + this._tempAxis.z * wallTangent.z;

      depth += halfExtents[i] * Math.abs(normalAmount);

      // Only slide for axes that clearly face the wall (outside deadzone).
      // At 0° and 90° the dominant axis is parallel → deadzone → no slide → centered.
      if (Math.abs(normalAmount) > DEADZONE) {
        slide += Math.sign(normalAmount) * halfExtents[i] * tangentAmount;
      }
    }

    return { depth, slide };
  }

  /**
   * Compute the OBB half-extent of the rotated shape along a horizontal direction.
   * Used to offset PROJECT shapes on horizontal surfaces so the front face
   * sits at the hit point.
   */
  private getHorizontalExtent(
    direction: THREE.Vector3,
    size: { x: number; y: number; z: number }
  ): number {
    const halfExtents = [size.x, size.y, size.z];
    let extent = 0;
    for (let i = 0; i < 3; i++) {
      this._tempAxis.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0)
        .applyQuaternion(this._composedQuat);
      // Dot product with direction using only horizontal (xz) components
      const amount = this._tempAxis.x * direction.x + this._tempAxis.z * direction.z;
      extent += halfExtents[i] * Math.abs(amount);
    }
    return extent;
  }

  /**
   * Compute the OBB half-extent along a horizontal wall normal direction.
   * Used by CARVE alignment to determine how far to push INTO the wall.
   */
  private getCarveDepth(
    wallNormal: THREE.Vector3,
    size: { x: number; y: number; z: number }
  ): number {
    const halfExtents = [size.x, size.y, size.z];
    let depth = 0;
    for (let i = 0; i < 3; i++) {
      this._tempAxis.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0)
        .applyQuaternion(this._composedQuat);
      const normalAmount = this._tempAxis.x * wallNormal.x + this._tempAxis.z * wallNormal.z;
      depth += halfExtents[i] * Math.abs(normalAmount);
    }
    return depth;
  }

  /**
   * Compute the OBB half-extent along the vertical (Y) axis.
   * Used by CARVE alignment on horizontal surfaces.
   */
  private getCarveDepthVertical(size: { x: number; y: number; z: number }): number {
    const halfExtents = [size.x, size.y, size.z];
    let depth = 0;
    for (let i = 0; i < 3; i++) {
      this._tempAxis.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0)
        .applyQuaternion(this._composedQuat);
      depth += halfExtents[i] * Math.abs(this._tempAxis.y);
    }
    return depth;
  }

  /**
   * Apply auto-rotation around Y axis based on the hit normal.
   * Computes the Y angle so the shape faces into the surface,
   * then updates the wireframe quaternion and composed quat.
   */
  private applyAutoRotateY(preset: BuildPreset, hitNormal: THREE.Vector3): void {
    // Get horizontal component of the normal
    const nx = hitNormal.x;
    const nz = hitNormal.z;
    const hLen = Math.sqrt(nx * nx + nz * nz);

    let yAngle: number;
    if (hLen > 0.01) {
      // Face INTO the wall: shape Z aligns with -normal (pointing into surface)
      yAngle = Math.atan2(-nx, -nz);
    } else {
      // Horizontal surface — keep current user rotation
      yAngle = getBuildRotationRadians();
    }

    // Skip update if angle hasn't changed meaningfully
    if (Math.abs(yAngle - this.lastAutoYAngle) < 0.001) return;
    this.lastAutoYAngle = yAngle;
    this.autoYRadians = yAngle;

    // Recompute composed quaternion and apply to wireframe
    const composed = composeRotation(preset, yAngle);
    this._composedQuat.set(composed.x, composed.y, composed.z, composed.w);
    if (this.wireframe) {
      this.wireframe.quaternion.copy(this._composedQuat);
    }

    // Recompute rotated half-Y extent
    const size = preset.parts[0].config.size;
    this._tempAxis.set(1, 0, 0).applyQuaternion(this._composedQuat);
    this.rotatedHalfY = size.x * Math.abs(this._tempAxis.y);
    this._tempAxis.set(0, 1, 0).applyQuaternion(this._composedQuat);
    this.rotatedHalfY += size.y * Math.abs(this._tempAxis.y);
    this._tempAxis.set(0, 0, 1).applyQuaternion(this._composedQuat);
    this.rotatedHalfY += size.z * Math.abs(this._tempAxis.y);
    this.rotatedHalfY *= VOXEL_SCALE;
  }

  /**
   * Get the effective Y rotation in radians.
   * Returns the auto-computed angle when autoRotateY is active,
   * otherwise returns the user's manual rotation.
   */
  getEffectiveYRadians(): number {
    return this.autoYRadians ?? getBuildRotationRadians();
  }

  /** Whether this preset uses the point-out / composite parts rendering path. */
  private usesPartsPath(preset: BuildPreset): boolean {
    return preset.align === BuildPresetAlign.POINT_OUT;
  }

  /**
   * Point-out orientation: rotate the shape's canonical +Y axis onto the hit normal, then spin
   * about that normal by the user's Q/E rotation. Applies the orientation + each part's rotated
   * offset to the per-part wireframes, and stores it as the placement quaternion.
   */
  private applyPointOut(preset: BuildPreset, hitNormal: THREE.Vector3): void {
    this._alignQuat.setFromUnitVectors(this._up, hitNormal);
    this._spinQuat.setFromAxisAngle(hitNormal, getBuildRotationRadians());
    this._composedQuat.multiplyQuaternions(this._spinQuat, this._alignQuat);

    const parts = preset.parts;
    for (let i = 0; i < this.partWireframes.length && i < parts.length; i++) {
      const off = parts[i].offset;
      this._offsetVec
        .set(off.x * VOXEL_SCALE, off.y * VOXEL_SCALE, off.z * VOXEL_SCALE)
        .applyQuaternion(this._composedQuat);
      this.partWireframes[i].position.copy(this._offsetVec);
      this.partWireframes[i].quaternion.copy(this._composedQuat);
    }
  }

  /**
   * The full placement rotation quaternion for the current frame. For point-out this is the
   * normal-derived orientation; for every other preset it is the composed base+user-Y rotation
   * already stored during rebuild / auto-rotate. Used by the Builder for preview / snap / place.
   */
  getPlacementRotation(): { x: number; y: number; z: number; w: number } {
    const q = this._composedQuat;
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  }

  /** Dispose and detach all wireframe meshes (single + per-part). */
  private clearWireframes(): void {
    if (this.wireframe) {
      this.group.remove(this.wireframe);
      this.wireframe.geometry.dispose();
      (this.wireframe.material as THREE.Material).dispose();
      this.wireframe = null;
    }
    for (const wf of this.partWireframes) {
      this.group.remove(wf);
      wf.geometry.dispose();
      (wf.material as THREE.Material).dispose();
    }
    this.partWireframes.length = 0;
  }

  /** Build a wireframe LineSegments for one build config (no position/rotation applied). */
  private buildWireframeMesh(config: BuildConfig, mode: BuildMode): THREE.LineSegments {
    const size = config.size;
    // Size values are half-extents in voxel units → world units via VOXEL_SCALE.
    const halfX = size.x * VOXEL_SCALE;
    const halfY = size.y * VOXEL_SCALE;
    const halfZ = size.z * VOXEL_SCALE;

    let geometry: THREE.BufferGeometry;
    switch (config.shape) {
      case BuildShape.SPHERE:
        geometry = new THREE.IcosahedronGeometry(halfX, 1);
        break;
      case BuildShape.CYLINDER:
        geometry = new THREE.CylinderGeometry(halfX, halfX, halfY * 2, 16);
        break;
      case BuildShape.PRISM:
        geometry = this.createPrismGeometry(halfX * 2, halfY * 2, halfZ * 2);
        break;
      case BuildShape.CUBE:
      default:
        geometry = new THREE.BoxGeometry(halfX * 2, halfY * 2, halfZ * 2);
        break;
    }

    const edges = new THREE.EdgesGeometry(geometry);
    geometry.dispose();

    const material = new THREE.LineBasicMaterial({
      color: getModeColor(mode, true),
      linewidth: 2,
      transparent: true,
      opacity: 0.8,
    });
    return new THREE.LineSegments(edges, material);
  }

  /** Compute the rotated OBB half-Y extent (world units) for the single-wireframe path. */
  private computeRotatedHalfY(size: { x: number; y: number; z: number }): void {
    this._tempAxis.set(1, 0, 0).applyQuaternion(this._composedQuat);
    this.rotatedHalfY = size.x * Math.abs(this._tempAxis.y);
    this._tempAxis.set(0, 1, 0).applyQuaternion(this._composedQuat);
    this.rotatedHalfY += size.y * Math.abs(this._tempAxis.y);
    this._tempAxis.set(0, 0, 1).applyQuaternion(this._composedQuat);
    this.rotatedHalfY += size.z * Math.abs(this._tempAxis.y);
    this.rotatedHalfY *= VOXEL_SCALE;
  }

  /**
   * Rebuild the wireframe geometry for the current preset.
   */
  private rebuildWireframe(preset: BuildPreset, rotationSteps: number): void {
    this.clearWireframes();

    // Don't create wireframe for an empty slot (no buildable geometry)
    if (slotIsEmpty(useGameStore.getState().build.presetMeta[preset.id])) return;

    if (this.usesPartsPath(preset)) {
      // Point-out / composite: one wireframe per part. Orientation and per-part offsets are
      // applied every frame by applyPointOut(); seed the placement quat with identity.
      this._composedQuat.identity();
      const mode = preset.parts[0].config.mode;
      for (const part of preset.parts) {
        const wf = this.buildWireframeMesh(part.config, mode);
        this.partWireframes.push(wf);
        this.group.add(wf);
      }
      return;
    }

    // Single-wireframe legacy path.
    this.wireframe = this.buildWireframeMesh(preset.parts[0].config, preset.parts[0].config.mode);

    // Apply composed rotation (base rotation + user Y rotation)
    const composed = composeRotation(preset, (rotationSteps * BUILD_ROTATION_STEP * Math.PI) / 180);
    this._composedQuat.set(composed.x, composed.y, composed.z, composed.w);
    this.wireframe.quaternion.copy(this._composedQuat);

    // Rotated OBB half-Y extent (correct base offset for shapes with baseRotation).
    this.computeRotatedHalfY(preset.parts[0].config.size);

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
    // Right-angled triangular prism matching the SDF:
    // Right angle at bottom-left (-hw, -hh), hypotenuse from (hw, -hh) to (-hw, hh)
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;

    const vertices = new Float32Array([
      // Front triangle (z = +hd)
      -hw, hh, hd,     // top-left
      -hw, -hh, hd,    // bottom-left (right angle)
      hw, -hh, hd,     // bottom-right
      // Back triangle (z = -hd)
      -hw, hh, -hd,    // top-left
      -hw, -hh, -hd,   // bottom-left (right angle)
      hw, -hh, -hd,    // bottom-right
    ]);

    const indices = [
      // Front face
      0, 1, 2,
      // Back face
      3, 5, 4,
      // Bottom face
      1, 4, 5, 1, 5, 2,
      // Left face (vertical edge)
      0, 3, 4, 0, 4, 1,
      // Hypotenuse face
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
    const hex = getModeColor(mode, isValid);
    if (this.wireframe) {
      (this.wireframe.material as THREE.LineBasicMaterial).color.setHex(hex);
    }
    for (const wf of this.partWireframes) {
      (wf.material as THREE.LineBasicMaterial).color.setHex(hex);
    }
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
   * Get the world-space AABB of the build shape.
   * Returns null if no valid target or preset is disabled.
   */
  getWorldAABB(): { min: THREE.Vector3; max: THREE.Vector3 } | null {
    if (!this.isVisible || slotIsEmpty(useGameStore.getState().build.presetMeta[this.currentPresetId])) return null;

    const preset = getBuildPreset();

    // Point-out / composite: union each part's oriented box (part center = anchor + q·offset).
    if (this.usesPartsPath(preset)) {
      const anchor = this.group.position;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const part of preset.parts) {
        this._offsetVec
          .set(part.offset.x * VOXEL_SCALE, part.offset.y * VOXEL_SCALE, part.offset.z * VOXEL_SCALE)
          .applyQuaternion(this._composedQuat);
        const cx = anchor.x + this._offsetVec.x;
        const cy = anchor.y + this._offsetVec.y;
        const cz = anchor.z + this._offsetVec.z;
        const s = part.config.size;
        const he = [s.x, s.y, s.z];
        let hx = 0, hy = 0, hz = 0;
        for (let i = 0; i < 3; i++) {
          this._tempAxis.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0)
            .applyQuaternion(this._composedQuat);
          hx += he[i] * Math.abs(this._tempAxis.x);
          hy += he[i] * Math.abs(this._tempAxis.y);
          hz += he[i] * Math.abs(this._tempAxis.z);
        }
        hx *= VOXEL_SCALE; hy *= VOXEL_SCALE; hz *= VOXEL_SCALE;
        minX = Math.min(minX, cx - hx); maxX = Math.max(maxX, cx + hx);
        minY = Math.min(minY, cy - hy); maxY = Math.max(maxY, cy + hy);
        minZ = Math.min(minZ, cz - hz); maxZ = Math.max(maxZ, cz + hz);
      }
      return { min: new THREE.Vector3(minX, minY, minZ), max: new THREE.Vector3(maxX, maxY, maxZ) };
    }

    const center = this.group.position.clone();

    // For BASE / PROJECT, compute actual center (offset up from group position)
    if (preset.align === BuildPresetAlign.BASE || preset.align === BuildPresetAlign.PROJECT) {
      center.y += this.rotatedHalfY;
    }

    // Compute oriented bounding box projected to AABB
    const size = preset.parts[0].config.size;
    const halfExtents = [size.x, size.y, size.z];
    let halfX = 0, halfY = 0, halfZ = 0;

    for (let i = 0; i < 3; i++) {
      this._tempAxis.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0)
        .applyQuaternion(this._composedQuat);
      halfX += halfExtents[i] * Math.abs(this._tempAxis.x);
      halfY += halfExtents[i] * Math.abs(this._tempAxis.y);
      halfZ += halfExtents[i] * Math.abs(this._tempAxis.z);
    }

    halfX *= VOXEL_SCALE;
    halfY *= VOXEL_SCALE;
    halfZ *= VOXEL_SCALE;

    return {
      min: new THREE.Vector3(center.x - halfX, center.y - halfY, center.z - halfZ),
      max: new THREE.Vector3(center.x + halfX, center.y + halfY, center.z + halfZ),
    };
  }

  /**
   * Set the wireframe to 'too close' warning color.
   */
  setTooCloseWarning(tooClose: boolean): void {
    if (!tooClose) return;
    if (this.wireframe) {
      (this.wireframe.material as THREE.LineBasicMaterial).color.setHex(COLOR_TOO_CLOSE);
    }
    for (const wf of this.partWireframes) {
      (wf.material as THREE.LineBasicMaterial).color.setHex(COLOR_TOO_CLOSE);
    }
    // Normal color is restored by updateColor() in the next update() call
  }

  /**
   * Get the build operation center position (world coordinates).
   * For BASE alignment, this is offset up from the hit point by half the shape height.
   * Returns null if no valid target.
   */
  getTargetPosition(): THREE.Vector3 | null {
    if (!this.isVisible) return null;

    const preset = getBuildPreset();
    const pos = this.group.position.clone();

    // For BASE / PROJECT, the group is at the hit point (base of the shape)
    // but the build operation needs the center, so offset up by the rotated half-Y.
    if (preset.align === BuildPresetAlign.BASE || preset.align === BuildPresetAlign.PROJECT) {
      pos.y += this.rotatedHalfY;
    }

    return pos;
  }

  /**
   * Apply a snap offset to the marker's group position.
   * Called after update() to shift the marker to the snapped position.
   */
  applySnapOffset(delta: THREE.Vector3): void {
    this.group.position.sub(delta);
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    this.clearWireframes();
  }
}
