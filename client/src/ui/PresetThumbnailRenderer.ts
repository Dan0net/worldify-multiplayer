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
 * Cache strategy: IndexedDB → in-memory map → GPU render queue (rAF, max 2/frame).
 */

import * as THREE from 'three';
import {
  VOXEL_SCALE,
  CHUNK_SIZE,
  LIGHT_MAX,
  packVoxel,
  sdfFromConfig,
  sdfToWeight,
  applyQuatToVec3,
  invertQuat,
  BuildMode,
  BuildShape,
  DEFAULT_BUILD_PRESETS,
  PRESET_TEMPLATES,
  NONE_PRESET_ID,
  MATERIAL_NAMES,
  materialCubeParts,
  type BuildConfig,
  type BuildPart,
  type Quat,
} from '@worldify/shared';
import { meshVoxelsSplit } from '../game/voxel/SurfaceNet';
import { createGeometryFromSurfaceNet } from '../game/voxel/MeshGeometry';
import { getTerrainMaterial, getTransparentTerrainMaterial, createHeldItemMaterial } from '../game/material/TerrainMaterial';
import { getRendererRef } from '../game/quality/QualityManager';
import { useGameStore } from '../state/store';

// ============== Constants ==============

const THUMB_SIZE = 256;
const GRID_SIZE = CHUNK_SIZE + 2;
const GRID_VOXELS = GRID_SIZE * GRID_SIZE * GRID_SIZE;
const PIXEL_BYTES = THUMB_SIZE * THUMB_SIZE * 4;

// Render budget per frame. When the build menu is open the game is soft-paused,
// so we can spend more of the frame draining the queue for snappy thumbnails.
const MAX_RENDERS_IDLE = 2;
const MAX_RENDERS_MENU_OPEN = 6;

/**
 * Render-queue priority (higher drains first). Interactive previews beat visible
 * slots, which beat the boot-time preload sweep.
 */
export const THUMB_PRIORITY = { PRELOAD: 0, NORMAL: 1, HIGH: 2, PREVIEW: 3 } as const;

function maxRendersThisFrame(): number {
  try {
    return useGameStore.getState().build.menuOpen ? MAX_RENDERS_MENU_OPEN : MAX_RENDERS_IDLE;
  } catch {
    return MAX_RENDERS_IDLE;
  }
}

/** Terrain textures are loaded — thumbnails would render untextured before this. */
function texturesReady(): boolean {
  try {
    const s = useGameStore.getState().textureState;
    return s === 'low' || s === 'high';
  } catch {
    return false;
  }
}

/**
 * Current texture variant, folded into the cache key so low- and high-res
 * thumbnails cache separately and switching quality re-renders instead of
 * serving a stale variant.
 */
function textureVariant(): string {
  try {
    return useGameStore.getState().textureState === 'high' ? 'hi' : 'lo';
  } catch {
    return 'lo';
  }
}

// ============== Reusable Three.js Objects ==============

let thumbScene: THREE.Scene | null = null;
let thumbCamera: THREE.OrthographicCamera | null = null;
let renderTarget: THREE.WebGLRenderTarget | null = null;

let thumbMesh: THREE.Mesh | null = null;
let thumbTransMesh: THREE.Mesh | null = null;
let thumbLiquidMesh: THREE.Mesh | null = null;
let thumbWireframe: THREE.LineSegments | null = null;
let wireframeMat: THREE.LineBasicMaterial | null = null;

// ============== Reusable Buffers ==============

let voxelGrid: Uint32Array | null = null;
let pixelBuf: Uint8Array | null = null;
let imageDataBuf: ImageData | null = null;

const corners: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
const _bbox = new THREE.Box3();
const _center = new THREE.Vector3();
const _size = new THREE.Vector3();
const _tempV = new THREE.Vector3();
const _tempQ = new THREE.Quaternion();

// ============== Cache ==============

/** In-memory cache: config hash → blob URL */
const thumbnailCache = new Map<string, string>();

// ============== IndexedDB Persistence ==============

const THUMB_DB_NAME = 'worldify-thumbnail-cache';
/** Bump this when material textures change to invalidate all cached thumbnails */
const THUMB_DB_VERSION = 2;
const THUMB_STORE = 'thumbnails';

let thumbDbPromise: Promise<IDBDatabase> | null = null;

function openThumbDB(): Promise<IDBDatabase> {
  if (thumbDbPromise) return thumbDbPromise;
  thumbDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(THUMB_DB_NAME, THUMB_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (db.objectStoreNames.contains(THUMB_STORE)) {
        db.deleteObjectStore(THUMB_STORE);
      }
      db.createObjectStore(THUMB_STORE);
    };
  });
  return thumbDbPromise;
}

async function loadFromIDB(hash: string): Promise<string | null> {
  try {
    const db = await openThumbDB();
    const blob: Blob | undefined = await new Promise((resolve, reject) => {
      const tx = db.transaction(THUMB_STORE, 'readonly');
      const req = tx.objectStore(THUMB_STORE).get(hash);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result ?? undefined);
    });
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    thumbnailCache.set(hash, url);
    return url;
  } catch {
    return null;
  }
}

function saveToIDB(hash: string, blob: Blob): void {
  openThumbDB().then(db => {
    const tx = db.transaction(THUMB_STORE, 'readwrite');
    tx.objectStore(THUMB_STORE).put(blob, hash);
  }).catch(() => { /* non-critical */ });
}

async function clearIDB(): Promise<void> {
  try {
    const db = await openThumbDB();
    const tx = db.transaction(THUMB_STORE, 'readwrite');
    tx.objectStore(THUMB_STORE).clear();
  } catch { /* non-critical */ }
}

// ============== Render Queue ==============

interface PendingRender {
  parts: BuildPart[];
  rotation?: Quat;
  hash: string;
  priority: number;
  callbacks: Array<(url: string | null) => void>;
}

const renderQueue: PendingRender[] = [];
const pendingByHash = new Map<string, PendingRender>();
let queueRafId = 0;

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

  voxelGrid = new Uint32Array(GRID_VOXELS);
  pixelBuf = new Uint8Array(PIXEL_BYTES);
  imageDataBuf = new ImageData(THUMB_SIZE, THUMB_SIZE);
}

// ============== Helpers ==============

function clearMeshes(): void {
  if (!thumbScene) return;
  if (thumbMesh) { thumbScene.remove(thumbMesh); thumbMesh.geometry.dispose(); thumbMesh = null; }
  if (thumbTransMesh) { thumbScene.remove(thumbTransMesh); thumbTransMesh.geometry.dispose(); thumbTransMesh = null; }
  if (thumbLiquidMesh) { thumbScene.remove(thumbLiquidMesh); thumbLiquidMesh.geometry.dispose(); thumbLiquidMesh = null; }
  if (thumbWireframe) { thumbScene.remove(thumbWireframe); thumbWireframe.geometry.dispose(); thumbWireframe = null; }
}

function fitCameraToBox(bbox: THREE.Box3, meshOffset: THREE.Vector3): void {
  if (!thumbCamera) return;

  const size = _size;
  bbox.getSize(size);
  const maxExtent = Math.max(size.x, size.y, size.z);
  const camDist = maxExtent * 2;

  thumbCamera.position.set(-camDist * 0.8, camDist * 0.6, -camDist * 0.8);
  thumbCamera.lookAt(0, 0, 0);
  thumbCamera.updateMatrixWorld();

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

function renderAndReadbackImageData(renderer: THREE.WebGLRenderer): ImageData {
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

  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.toneMapping = prevToneMapping;
  renderer.toneMappingExposure = prevExposure;
  renderer.setClearColor(0x87ceeb, 1);

  // Flip Y (WebGL reads bottom-up)
  const src = pixelBuf!;
  const dst = imageDataBuf!.data;
  for (let y = 0; y < THUMB_SIZE; y++) {
    const srcRow = (THUMB_SIZE - 1 - y) * THUMB_SIZE * 4;
    const dstRow = y * THUMB_SIZE * 4;
    dst.set(src.subarray(srcRow, srcRow + THUMB_SIZE * 4), dstRow);
  }

  return new ImageData(new Uint8ClampedArray(dst), THUMB_SIZE, THUMB_SIZE);
}

let encodeCanvas: HTMLCanvasElement | null = null;

function getEncodeCanvas(): HTMLCanvasElement {
  if (!encodeCanvas) {
    encodeCanvas = document.createElement('canvas');
    encodeCanvas.width = THUMB_SIZE;
    encodeCanvas.height = THUMB_SIZE;
  }
  return encodeCanvas;
}

/**
 * Encode ImageData → PNG blob + object URL.
 *
 * Uses a regular <canvas> + toBlob rather than OffscreenCanvas.convertToBlob:
 * the latter is unsupported on iOS/mobile Safari, where it rejects and left
 * every hotbar slot stuck on the fallback glyph. Falls back to toDataURL for
 * any engine where toBlob yields null.
 */
function encodeImageDataToBlobAndUrl(imageData: ImageData): Promise<{ url: string; blob: Blob }> {
  const canvas = getEncodeCanvas();
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('2D context unavailable'));
  ctx.putImageData(imageData, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve({ url: URL.createObjectURL(blob), blob });
        return;
      }
      // toBlob unsupported/failed — synchronous data-URL path.
      try {
        const dataUrl = canvas.toDataURL('image/png');
        fetch(dataUrl)
          .then((r) => r.blob())
          .then((b) => resolve({ url: dataUrl, blob: b }))
          .catch(() => resolve({ url: dataUrl, blob: new Blob() }));
      } catch (err) {
        reject(err);
      }
    }, 'image/png');
  });
}

// ============== Voxel Grid Generation ==============

function fillVoxelGrid(parts: BuildPart[], rotation?: Quat): void {
  const data = voxelGrid!;
  data.fill(0);
  const gridCenter = (GRID_SIZE - 1) / 2;
  const invRot = rotation ? invertQuat(rotation) : null;

  // Union of the most-solid part per voxel (a simple preset is just one zero-offset part).
  const prep = parts.map((p) => ({
    config: p.config,
    ox: p.offset.x * VOXEL_SCALE,
    oy: p.offset.y * VOXEL_SCALE,
    oz: p.offset.z * VOXEL_SCALE,
  }));
  const sampleP = { x: 0, y: 0, z: 0 };

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
        // Keep the most-solid part at this voxel (union of the composite).
        let bestWeight = -Infinity;
        let bestMat = 0;
        for (const p of prep) {
          sampleP.x = px - p.ox; sampleP.y = py - p.oy; sampleP.z = pz - p.oz;
          const w = sdfToWeight(sdfFromConfig(sampleP, p.config));
          if (w > bestWeight) { bestWeight = w; bestMat = p.config.material; }
        }
        // Full voxel light: the terrain shader multiplies output by voxel light,
        // so light=0 renders thumbnails near-black.
        data[z * GRID_SIZE * GRID_SIZE + y * GRID_SIZE + x] = packVoxel(bestWeight, bestMat, LIGHT_MAX);
      }
    }
  }
}

// ============== Config Hashing ==============

function configHash(parts: BuildPart[], rotation?: Quat): string {
  const partsKey = parts
    .map((p) => `${p.config.shape},${p.config.mode},${p.config.material},${p.config.size.x},${p.config.size.y},${p.config.size.z},${p.config.thickness ?? 0},${p.config.closed ?? 1},${p.config.arcSweep ?? 0}@${p.offset.x},${p.offset.y},${p.offset.z}`)
    .join(';');
  return [
    textureVariant(), // low/high textures produce different thumbnails — cache apart
    rotation ? `${rotation.x.toFixed(4)},${rotation.y.toFixed(4)},${rotation.z.toFixed(4)},${rotation.w.toFixed(4)}` : '',
    partsKey,
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

function renderThumbnailToImageData(parts: BuildPart[], rotation: Quat | undefined, renderer: THREE.WebGLRenderer): ImageData | null {
  ensureSetup();
  if (!thumbScene || !thumbCamera || !renderTarget) return null;

  clearMeshes();

  // A single-part SUBTRACT shows the red wireframe; composite/ADD builds render voxels.
  const primary = parts[0].config;
  if (primary.mode === BuildMode.SUBTRACT && parts.length === 1) {
    thumbWireframe = buildWireframe(primary, rotation);
    thumbScene.add(thumbWireframe);
    _center.set(0, 0, 0);
    fitCameraToBox(_bbox, _center);
    return renderAndReadbackImageData(renderer);
  }

  fillVoxelGrid(parts, rotation);

  const meshOutput = meshVoxelsSplit({ dims: [GRID_SIZE, GRID_SIZE, GRID_SIZE], data: voxelGrid! });
  const { solid, transparent, liquid } = meshOutput;
  if (solid.vertexCount === 0 && transparent.vertexCount === 0 && liquid.vertexCount === 0) return null;

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
    // Render the liquid bucket with the opaque terrain material (not the animated water
    // material) so lava shows its orange albedo, opaque and lit, in the static icon.
    thumbLiquidMesh = new THREE.Mesh(liquidGeo, getTerrainMaterial());
    thumbLiquidMesh.position.set(ox, oy, oz);
    thumbLiquidMesh.renderOrder = 2;
    thumbScene.add(thumbLiquidMesh);
  }

  _tempV.set(ox, oy, oz);
  fitCameraToBox(_bbox, _tempV);

  return renderAndReadbackImageData(renderer);
}

// ============== Held-item mesh (first-person arm) ==============

/** Camera-local target for the largest build extent — normalizes any build to one size. */
const HELD_TARGET_SIZE = 0.26;

function normalizeHeldGroup(group: THREE.Group, bbox: THREE.Box3): void {
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxExtent = Math.max(size.x, size.y, size.z) || 1;
  group.scale.setScalar(HELD_TARGET_SIZE / maxExtent);
}

/**
 * Build a THREE.Object3D of a BuildConfig using the same SurfaceNet pipeline as
 * thumbnails — for the first-person held item. Solid/transparent parts use dedicated
 * object-space terrain materials (`createHeldItemMaterial`) seeded with the loaded
 * atlas, so the texture is static in the hand (the shared world material samples by
 * world position and would swim as the player moves) and renders real textures (not
 * the grey a clone would give). Drawing "on top" is handled by the caller's render
 * layer/pass, so no depthTest tricks here. Normalized so any build (1³ or 16³)
 * renders at the same size in the hand. The caller owns disposal of the geometries
 * and the `userData.heldItem`-tagged materials (the liquid part reuses the shared
 * water material — don't dispose that one).
 */
export function createBuildItemMeshes(parts: BuildPart[], rotation?: Quat): THREE.Object3D | null {
  ensureSetup();
  const group = new THREE.Group();

  // A single-part SUBTRACT has no solid mesh — show the same red wireframe the thumbnail uses.
  const primary = parts[0].config;
  if (primary.mode === BuildMode.SUBTRACT && parts.length === 1) {
    const wf = buildWireframe(primary, rotation);
    wf.frustumCulled = false;
    const c = new THREE.Vector3(); _bbox.getCenter(c);
    wf.position.set(-c.x, -c.y, -c.z);
    group.add(wf);
    normalizeHeldGroup(group, _bbox);
    return group;
  }

  fillVoxelGrid(parts, rotation);
  const { solid, transparent, liquid } = meshVoxelsSplit({ dims: [GRID_SIZE, GRID_SIZE, GRID_SIZE], data: voxelGrid! });
  if (solid.vertexCount === 0 && transparent.vertexCount === 0 && liquid.vertexCount === 0) return null;

  _bbox.makeEmpty();
  const solidGeo = solid.vertexCount > 0 ? createGeometryFromSurfaceNet(solid) : null;
  const transGeo = transparent.vertexCount > 0 ? createGeometryFromSurfaceNet(transparent) : null;
  const liquidGeo = liquid.vertexCount > 0 ? createGeometryFromSurfaceNet(liquid) : null;
  if (solidGeo) { solidGeo.computeBoundingBox(); _bbox.union(solidGeo.boundingBox!); }
  if (transGeo) { transGeo.computeBoundingBox(); _bbox.union(transGeo.boundingBox!); }
  if (liquidGeo) { liquidGeo.computeBoundingBox(); _bbox.union(liquidGeo.boundingBox!); }

  const c = new THREE.Vector3(); _bbox.getCenter(c);
  const addMesh = (geo: THREE.BufferGeometry | null, mat: THREE.Material) => {
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(-c.x, -c.y, -c.z);
    mesh.frustumCulled = false;
    group.add(mesh);
  };
  addMesh(solidGeo, solidGeo ? createHeldItemMaterial(false) : getTerrainMaterial());
  addMesh(transGeo, transGeo ? createHeldItemMaterial(true) : getTransparentTerrainMaterial());
  // Liquid (e.g. lava) uses the opaque object-space terrain material too, so it shows its
  // albedo instead of the world-space animated water shader.
  addMesh(liquidGeo, createHeldItemMaterial(false));

  normalizeHeldGroup(group, _bbox);
  return group;
}

// ============== Queue Processing ==============

function processEntry(entry: PendingRender, renderer: THREE.WebGLRenderer): boolean {
  pendingByHash.delete(entry.hash);

  // May have been loaded from IDB since queuing
  const cached = thumbnailCache.get(entry.hash);
  if (cached) {
    for (const cb of entry.callbacks) cb(cached);
    return false;
  }

  let imageData: ImageData | null = null;
  try {
    imageData = renderThumbnailToImageData(entry.parts, entry.rotation, renderer);
  } catch (err) {
    console.warn('[thumbnail] render failed', err);
  }
  if (!imageData) {
    for (const cb of entry.callbacks) cb(null);
    return true;
  }

  const { callbacks, hash } = entry;
  encodeImageDataToBlobAndUrl(imageData)
    .then(({ url, blob }) => {
      thumbnailCache.set(hash, url);
      if (blob.size > 0) saveToIDB(hash, blob);
      for (const cb of callbacks) cb(url);
    })
    .catch((err) => {
      console.warn('[thumbnail] encode failed', err);
      for (const cb of callbacks) cb(null);
    });
  return true;
}

/** Remove and return the highest-priority queued entry (FIFO within a priority). */
function takeNextEntry(): PendingRender | undefined {
  if (renderQueue.length === 0) return undefined;
  let bestIdx = 0;
  for (let i = 1; i < renderQueue.length; i++) {
    if (renderQueue[i].priority > renderQueue[bestIdx].priority) bestIdx = i;
  }
  return renderQueue.splice(bestIdx, 1)[0];
}

function processQueue(): void {
  queueRafId = 0;

  const renderer = getRendererRef();
  // Wait for the renderer AND for terrain textures — rendering earlier produces
  // untextured thumbnails. Entries stay queued and drain once both are ready.
  if (!renderer || !texturesReady()) {
    if (renderQueue.length > 0) {
      queueRafId = requestAnimationFrame(processQueue);
    }
    return;
  }

  const budget = maxRendersThisFrame();
  let rendered = 0;
  while (rendered < budget && renderQueue.length > 0) {
    const entry = takeNextEntry()!;
    if (processEntry(entry, renderer)) rendered++;
  }

  if (renderQueue.length > 0) {
    queueRafId = requestAnimationFrame(processQueue);
  }
}

function scheduleQueue(): void {
  if (!queueRafId) {
    queueRafId = requestAnimationFrame(processQueue);
  }
}

// ============== Public API ==============

/**
 * Get a thumbnail for a build's parts list. Checks in-memory cache, then IndexedDB,
 * then falls back to queued GPU rendering. Callback fires with the blob URL.
 */
export function queueThumbnailRender(
  parts: BuildPart[],
  rotation: Quat | undefined,
  callback: (url: string | null) => void,
  priority: number = THUMB_PRIORITY.NORMAL,
): void {
  const hash = configHash(parts, rotation);

  // 1. In-memory cache — instant
  const cached = thumbnailCache.get(hash);
  if (cached) { callback(cached); return; }

  // 2. Already queued — piggyback (and upgrade its priority if this caller needs it sooner)
  const existing = pendingByHash.get(hash);
  if (existing) {
    existing.callbacks.push(callback);
    if (priority > existing.priority) existing.priority = priority;
    return;
  }

  // 3. Try IndexedDB first, fall back to GPU queue on miss
  const entry: PendingRender = { parts, rotation, hash, priority, callbacks: [callback] };
  pendingByHash.set(hash, entry);

  loadFromIDB(hash).then(url => {
    if (url) {
      // Found in IDB — resolve callbacks, skip GPU render
      pendingByHash.delete(hash);
      for (const cb of entry.callbacks) cb(url);
      return;
    }
    // Not in IDB — queue for GPU render
    renderQueue.push(entry);
    scheduleQueue();
  });
}

/**
 * Warm the cache for every build preset, template, and material at boot so the
 * build menu opens with thumbnails already rendered. Lowest priority, so it
 * never delays an interactive thumbnail; safe to call before the renderer
 * exists (the queue reschedules until it does). Deduped by hash.
 */
export function preloadPresetThumbnails(): void {
  const enqueue = (parts: BuildPart[], rotation?: Quat) =>
    queueThumbnailRender(parts, rotation, () => { /* warm cache only */ }, THUMB_PRIORITY.PRELOAD);

  for (const p of DEFAULT_BUILD_PRESETS) {
    if (p.id === NONE_PRESET_ID) continue;
    enqueue(p.parts, p.baseRotation);
  }
  for (const t of PRESET_TEMPLATES) {
    enqueue(t.parts, t.baseRotation);
  }
  for (let id = 0; id < MATERIAL_NAMES.length; id++) {
    enqueue(materialCubeParts(id));
  }
}

/** Invalidate all cached thumbnails (e.g. when textures reload). */
export function clearThumbnailCache(): void {
  for (const url of thumbnailCache.values()) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  thumbnailCache.clear();
  clearIDB();
}

/** Dispose all Three.js resources used by the thumbnail renderer. */
export function disposeThumbnailRenderer(): void {
  // Cancel pending
  renderQueue.length = 0;
  pendingByHash.clear();
  if (queueRafId) {
    cancelAnimationFrame(queueRafId);
    queueRafId = 0;
  }

  clearMeshes();
  if (wireframeMat) { wireframeMat.dispose(); wireframeMat = null; }
  if (renderTarget) { renderTarget.dispose(); renderTarget = null; }
  thumbScene = null;
  thumbCamera = null;
  voxelGrid = null;
  pixelBuf = null;
  imageDataBuf = null;
  encodeCanvas = null;
  clearThumbnailCache();
}
