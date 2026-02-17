/**
 * PresetThumbnailRenderer - Generates thumbnails for build presets/configs.
 *
 * Two rendering paths:
 * - ADD/PAINT/FILL: SurfaceNet voxel mesh with terrain material (WYSIWYG)
 * - SUBTRACT:       Red wireframe matching BuildMarker's shapes
 *
 * Uses the game's existing renderer (same GL context) so all shaders,
 * textures, and materials work identically to in-game rendering.
 *
 * Performance: reusable buffers for voxel grid, pixel readback, ImageData,
 * and bbox corner vectors prevent per-call allocations.
 */

import * as THREE from 'three';
import {
  VOXEL_SCALE,
  CHUNK_SIZE,
  packVoxel,
  sdfFromConfig,
  sdfToWeight,
  applyQuatToVec3,
  invertQuat,
  BuildMode,
  BuildShape,
  type BuildConfig,
  type Quat,
} from '@worldify/shared';
import { meshVoxelsSplit } from '../game/voxel/SurfaceNet';
import { createGeometryFromSurfaceNet } from '../game/voxel/MeshGeometry';
import { getTerrainMaterial, getTransparentTerrainMaterial, getLiquidTerrainMaterial } from '../game/material/TerrainMaterial';
import { getRendererRef } from '../game/quality/QualityManager';

// ============== Constants ==============

const THUMB_SIZE = 256;
/** Must match SurfaceNet's hardcoded cornerOffsets (CHUNK_SIZE + 2 = 34). */
const GRID_SIZE = CHUNK_SIZE + 2;
const GRID_VOXELS = GRID_SIZE * GRID_SIZE * GRID_SIZE;
const PIXEL_BYTES = THUMB_SIZE * THUMB_SIZE * 4;

// ============== Reusable Three.js Objects ==============

let thumbScene: THREE.Scene | null = null;
let thumbCamera: THREE.OrthographicCamera | null = null;
let renderTarget: THREE.WebGLRenderTarget | null = null;

/** Persistent mesh slots (swapped per render, geometry disposed each time) */
let thumbMesh: THREE.Mesh | null = null;
let thumbTransMesh: THREE.Mesh | null = null;
let thumbLiquidMesh: THREE.Mesh | null = null;
let thumbWireframe: THREE.LineSegments | null = null;

/** Persistent wireframe material (reused across SUBTRACT renders) */
let wireframeMat: THREE.LineBasicMaterial | null = null;

/** Offscreen canvas for pixel readback → data URL conversion */
let readbackCanvas: HTMLCanvasElement | null = null;
let readbackCtx: CanvasRenderingContext2D | null = null;

// ============== Reusable Buffers (avoid per-call allocation) ==============

let voxelGrid: Uint16Array | null = null;
let pixelBuf: Uint8Array | null = null;
let imageDataBuf: ImageData | null = null;

/** 8 reusable Vector3s for bbox corner projection */
const corners: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
const _bbox = new THREE.Box3();
const _center = new THREE.Vector3();
const _size = new THREE.Vector3();
const _tempV = new THREE.Vector3();
const _tempQ = new THREE.Quaternion();

/** Cache: config hash → data URL */
const thumbnailCache = new Map<string, string>();

// ============== Setup ==============

function ensureSetup(): void {
  if (thumbScene) return;

  thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const dir = new THREE.DirectionalLight(0xffffff, 6.0);
  dir.position.set(0.8, 2.0, -0.8);
  thumbScene.add(dir);

  thumbCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);

  renderTarget = new THREE.WebGLRenderTarget(THUMB_SIZE, THUMB_SIZE, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
  });

  wireframeMat = new THREE.LineBasicMaterial({
    color: 0xff0000,
    linewidth: 2,
    transparent: true,
    opacity: 0.9,
  });

  readbackCanvas = document.createElement('canvas');
  readbackCanvas.width = THUMB_SIZE;
  readbackCanvas.height = THUMB_SIZE;
  readbackCtx = readbackCanvas.getContext('2d')!;

  // Pre-allocate reusable buffers
  voxelGrid = new Uint16Array(GRID_VOXELS);
  pixelBuf = new Uint8Array(PIXEL_BYTES);
  imageDataBuf = readbackCtx.createImageData(THUMB_SIZE, THUMB_SIZE);
}

// ============== Helpers ==============

/** Remove and dispose all active scene meshes. */
function clearMeshes(): void {
  if (!thumbScene) return;
  if (thumbMesh) { thumbScene.remove(thumbMesh); thumbMesh.geometry.dispose(); thumbMesh = null; }
  if (thumbTransMesh) { thumbScene.remove(thumbTransMesh); thumbTransMesh.geometry.dispose(); thumbTransMesh = null; }
  if (thumbLiquidMesh) { thumbScene.remove(thumbLiquidMesh); thumbLiquidMesh.geometry.dispose(); thumbLiquidMesh = null; }
  if (thumbWireframe) { thumbScene.remove(thumbWireframe); thumbWireframe.geometry.dispose(); thumbWireframe = null; }
}

/**
 * Position the ortho camera and fit its frustum tightly around a world-space AABB.
 * Corners are projected into camera-local space with 10% padding.
 */
function fitCameraToBox(bbox: THREE.Box3, meshOffset: THREE.Vector3): void {
  if (!thumbCamera) return;

  const size = _size;
  bbox.getSize(size);
  const maxExtent = Math.max(size.x, size.y, size.z);
  const camDist = maxExtent * 2;

  thumbCamera.position.set(-camDist * 0.8, camDist * 0.6, -camDist * 0.8);
  thumbCamera.lookAt(0, 0, 0);
  thumbCamera.updateMatrixWorld();

  // Build 8 bbox corners in reusable vectors
  const mn = bbox.min, mx = bbox.max;
  corners[0].set(mn.x, mn.y, mn.z);
  corners[1].set(mx.x, mn.y, mn.z);
  corners[2].set(mn.x, mx.y, mn.z);
  corners[3].set(mx.x, mx.y, mn.z);
  corners[4].set(mn.x, mn.y, mx.z);
  corners[5].set(mx.x, mn.y, mx.z);
  corners[6].set(mn.x, mx.y, mx.z);
  corners[7].set(mx.x, mx.y, mx.z);

  const viewMatrix = thumbCamera.matrixWorldInverse;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < 8; i++) {
    corners[i].add(meshOffset).applyMatrix4(viewMatrix);
    const c = corners[i];
    if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
    if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;
  }

  // Square frustum + 10% padding
  const padX = (maxX - minX) * 0.1;
  const padY = (maxY - minY) * 0.1;
  const halfW = Math.max(maxX - minX + padX * 2, maxY - minY + padY * 2) / 2;
  thumbCamera.left = -halfW;
  thumbCamera.right = halfW;
  thumbCamera.top = halfW;
  thumbCamera.bottom = -halfW;
  thumbCamera.near = -maxZ + 0.01;
  thumbCamera.far = -minZ + 0.01;
  thumbCamera.updateProjectionMatrix();
}

/**
 * Render the thumbnail scene, read pixels back, flip Y, and return a data URL.
 * Temporarily disables tone mapping (ACES compresses brightness too much).
 */
function renderAndReadback(renderer: THREE.WebGLRenderer): string {
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevToneMapping = renderer.toneMapping;
  const prevExposure = renderer.toneMappingExposure;

  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setRenderTarget(renderTarget);
  renderer.autoClear = true;
  renderer.setClearColor(0x000000, 0);
  renderer.render(thumbScene!, thumbCamera!);

  renderer.readRenderTargetPixels(renderTarget!, 0, 0, THUMB_SIZE, THUMB_SIZE, pixelBuf!);

  // Restore renderer state
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.toneMapping = prevToneMapping;
  renderer.toneMappingExposure = prevExposure;
  renderer.setClearColor(0x87ceeb, 1);

  // Flip Y (WebGL reads bottom-up) into reusable ImageData
  const src = pixelBuf!;
  const dst = imageDataBuf!.data;
  for (let y = 0; y < THUMB_SIZE; y++) {
    const srcRow = (THUMB_SIZE - 1 - y) * THUMB_SIZE * 4;
    const dstRow = y * THUMB_SIZE * 4;
    dst.set(src.subarray(srcRow, srcRow + THUMB_SIZE * 4), dstRow);
  }
  readbackCtx!.putImageData(imageDataBuf!, 0, 0);
  return readbackCanvas!.toDataURL('image/png');
}

// ============== Voxel Grid Generation ==============

/**
 * Fill the reusable voxel grid from a BuildConfig SDF.
 * Grid is centered on the shape; rotation is inverse-applied to sample positions.
 */
function fillVoxelGrid(config: BuildConfig, rotation?: Quat): void {
  const data = voxelGrid!;
  data.fill(0);
  const gridCenter = (GRID_SIZE - 1) / 2;
  const invRot = rotation ? invertQuat(rotation) : null;
  const mat = config.material;

  for (let z = 0; z < GRID_SIZE; z++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        let px = (x - gridCenter) * VOXEL_SCALE;
        let py = (y - gridCenter) * VOXEL_SCALE;
        let pz = (z - gridCenter) * VOXEL_SCALE;
        if (invRot) {
          const r = applyQuatToVec3({ x: px, y: py, z: pz }, invRot);
          px = r.x; py = r.y; pz = r.z;
        }
        const sdf = sdfFromConfig({ x: px, y: py, z: pz }, config);
        data[z * GRID_SIZE * GRID_SIZE + y * GRID_SIZE + x] = packVoxel(sdfToWeight(sdf), mat, 0);
      }
    }
  }
}

// ============== Config Hashing ==============

function configHash(config: BuildConfig, rotation?: Quat): string {
  return [
    config.mode,
    config.shape,
    config.size.x, config.size.y, config.size.z,
    config.material,
    config.thickness ?? 0,
    config.closed ?? 1,
    config.arcSweep ?? 0,
    rotation ? `${rotation.x.toFixed(4)},${rotation.y.toFixed(4)},${rotation.z.toFixed(4)},${rotation.w.toFixed(4)}` : '',
  ].join('|');
}

// ============== Wireframe Helpers (SUBTRACT mode) ==============

function createPrismGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const verts = new Float32Array([
    -hw, hh, hd,  -hw, -hh, hd,  hw, -hh, hd,
    -hw, hh, -hd, -hw, -hh, -hd, hw, -hh, -hd,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex([0,1,2, 3,5,4, 1,4,5,1,5,2, 0,3,4,0,4,1, 0,2,5,0,5,3]);
  geo.computeVertexNormals();
  return geo;
}

/** Build wireframe geometry for a config, compute its rotated AABB in _bbox. */
function buildWireframe(config: BuildConfig, rotation?: Quat): THREE.LineSegments {
  const { x: sx, y: sy, z: sz } = config.size;
  const hx = sx * VOXEL_SCALE, hy = sy * VOXEL_SCALE, hz = sz * VOXEL_SCALE;

  let geo: THREE.BufferGeometry;
  switch (config.shape) {
    case BuildShape.SPHERE:   geo = new THREE.IcosahedronGeometry(hx, 1); break;
    case BuildShape.CYLINDER: geo = new THREE.CylinderGeometry(hx, hx, hy * 2, 16); break;
    case BuildShape.PRISM:    geo = createPrismGeometry(hx * 2, hy * 2, hz * 2); break;
    case BuildShape.CUBE:
    default:                  geo = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2); break;
  }

  const edges = new THREE.EdgesGeometry(geo);
  geo.dispose();

  const wf = new THREE.LineSegments(edges, wireframeMat!);
  if (rotation) wf.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

  // Compute rotated AABB
  _bbox.makeEmpty();
  if (rotation) {
    _tempQ.set(rotation.x, rotation.y, rotation.z, rotation.w);
    const pos = edges.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      _tempV.fromBufferAttribute(pos, i).applyQuaternion(_tempQ);
      _bbox.expandByPoint(_tempV);
    }
  } else {
    edges.computeBoundingBox();
    _bbox.copy(edges.boundingBox!);
  }

  return wf;
}

// ============== Main Render Function ==============

/**
 * Render a thumbnail for a BuildConfig.
 * Returns a cached data URL, or null if renderer isn't ready.
 */
export function renderPresetThumbnail(config: BuildConfig, rotation?: Quat): string | null {
  const hash = configHash(config, rotation);
  const cached = thumbnailCache.get(hash);
  if (cached) return cached;

  const renderer = getRendererRef();
  if (!renderer) return null;

  ensureSetup();
  if (!thumbScene || !thumbCamera || !renderTarget || !readbackCtx) return null;

  clearMeshes();

  // ---- SUBTRACT: red wireframe (no SurfaceNet needed) ----
  if (config.mode === BuildMode.SUBTRACT) {
    thumbWireframe = buildWireframe(config, rotation);
    thumbScene.add(thumbWireframe);

    // _bbox already set by buildWireframe; meshOffset = zero (wireframe centered at origin)
    _center.set(0, 0, 0);
    fitCameraToBox(_bbox, _center);

    const url = renderAndReadback(renderer);
    thumbnailCache.set(hash, url);
    return url;
  }

  // ---- ADD / PAINT / FILL: SurfaceNet terrain mesh ----
  fillVoxelGrid(config, rotation);

  const meshOutput = meshVoxelsSplit({ dims: [GRID_SIZE, GRID_SIZE, GRID_SIZE], data: voxelGrid! });
  const { solid, transparent, liquid } = meshOutput;
  if (solid.vertexCount === 0 && transparent.vertexCount === 0 && liquid.vertexCount === 0) return null;

  // Build geometries and accumulate combined AABB
  _bbox.makeEmpty();
  const solidGeo = solid.vertexCount > 0 ? createGeometryFromSurfaceNet(solid) : null;
  const transGeo = transparent.vertexCount > 0 ? createGeometryFromSurfaceNet(transparent) : null;
  const liquidGeo = liquid.vertexCount > 0 ? createGeometryFromSurfaceNet(liquid) : null;
  if (solidGeo) { solidGeo.computeBoundingBox(); _bbox.union(solidGeo.boundingBox!); }
  if (transGeo) { transGeo.computeBoundingBox(); _bbox.union(transGeo.boundingBox!); }
  if (liquidGeo) { liquidGeo.computeBoundingBox(); _bbox.union(liquidGeo.boundingBox!); }

  _bbox.getCenter(_center);
  const ox = -_center.x, oy = -_center.y, oz = -_center.z;

  if (solidGeo) {
    thumbMesh = new THREE.Mesh(solidGeo, getTerrainMaterial());
    thumbMesh.position.set(ox, oy, oz);
    thumbScene.add(thumbMesh);
  }
  if (transGeo) {
    thumbTransMesh = new THREE.Mesh(transGeo, getTransparentTerrainMaterial());
    thumbTransMesh.position.set(ox, oy, oz);
    thumbTransMesh.renderOrder = 1;
    thumbScene.add(thumbTransMesh);
  }
  if (liquidGeo) {
    thumbLiquidMesh = new THREE.Mesh(liquidGeo, getLiquidTerrainMaterial());
    thumbLiquidMesh.position.set(ox, oy, oz);
    thumbLiquidMesh.renderOrder = 2;
    thumbScene.add(thumbLiquidMesh);
  }

  // meshOffset = -center (applied to corners during projection)
  _tempV.set(ox, oy, oz);
  fitCameraToBox(_bbox, _tempV);

  const url = renderAndReadback(renderer);
  thumbnailCache.set(hash, url);
  return url;
}

// ============== Public API ==============

/** Invalidate all cached thumbnails (e.g. when textures reload). */
export function clearThumbnailCache(): void {
  thumbnailCache.clear();
}

/** Dispose all Three.js resources used by the thumbnail renderer. */
export function disposeThumbnailRenderer(): void {
  clearMeshes();
  if (wireframeMat) { wireframeMat.dispose(); wireframeMat = null; }
  if (renderTarget) { renderTarget.dispose(); renderTarget = null; }
  thumbScene = null;
  thumbCamera = null;
  readbackCanvas = null;
  readbackCtx = null;
  voxelGrid = null;
  pixelBuf = null;
  imageDataBuf = null;
  thumbnailCache.clear();
}
