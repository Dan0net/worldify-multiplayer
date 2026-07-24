/**
 * SpawnMarker — the explore-mode spawn gizmo.
 *
 * A flat ring on the terrain surface showing where the player will spawn. In explore
 * mode the spawn stays pinned to screen center (or the user taps/drags to move it) and a
 * React Play button — connected to the ring by a fixed-height UI line, not a 3D one —
 * starts 1st-person play there.
 *
 * Module singleton (one marker, one scene), mirroring the `controls` singleton so both
 * the game loop and React UI can drive it without prop threading.
 */

import * as THREE from 'three';
import { PLAYER_HEIGHT, SPAWN_HEIGHT_OFFSET, SPAWN_RAYCAST_HEIGHT } from '@worldify/shared';
import type { TerrainRaycaster } from './TerrainRaycaster';

const RING_INNER = 0.7;
const RING_OUTER = 1.05;
const MARKER_COLOR = 0x38e8ff;

let scene: THREE.Scene | null = null;
let terrain: TerrainRaycaster | null = null;
let group: THREE.Group | null = null;

// Current LOD zoom scale (2^level). The raycast target meshes (getSolidMeshes) are the per-chunk
// data meshes, which live in LEVEL-LOCAL space (0.25 m voxels, 8 m chunk) and carry NO zoom scale —
// only the rendered ChunkGrouper root is scaled by 2^level. Camera + marker live in true-world space.
// So a raycast built in true-world space must be transformed into level-local space (÷ scale) before
// intersecting, and the local hit scaled back (× scale) to true world for placement. 1 = level 0 / Play.
let lodScale = 1;

/** Set the current LOD zoom scale (2^level) so the marker raycasts hit the coarse terrain. */
export function setSpawnLodScale(scale: number): void {
  lodScale = scale > 0 ? scale : 1;
}

let placed = false;
let armed = false;                        // Play requested → next Playing entry uses the marker
const spawnPos = new THREE.Vector3();     // player spawn (surface + player height)
const basePoint = new THREE.Vector3();    // ring position (on surface); Play-button anchor

const raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _down = new THREE.Vector3(0, -1, 0);

/** Build the marker group + add it to the scene (hidden until placed). */
export function initSpawnMarker(s: THREE.Scene, t: TerrainRaycaster): void {
  scene = s;
  terrain = t;
  if (group) return;

  group = new THREE.Group();
  group.renderOrder = 999;
  group.visible = false;

  const mat = new THREE.MeshBasicMaterial({
    color: MARKER_COLOR, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(RING_INNER, RING_OUTER, 40), mat);
  ring.rotation.x = -Math.PI / 2;   // lie flat on the ground
  ring.renderOrder = 999;
  ring.frustumCulled = false;
  group.add(ring);

  scene.add(group);
}

/** Per-LOD-level solid mesh sets to raycast (base disk + coarse rings), each with its 2^level scale.
 *  Falls back to a single set at the current base scale when the terrain has no per-level accessor. */
function levelSets(): { scale: number; meshes: THREE.Object3D[] }[] {
  if (!terrain) return [];
  return terrain.getSolidMeshesByLevel?.() ?? [{ scale: lodScale, meshes: terrain.getSolidMeshes() }];
}

/** Raycast a screen NDC point against the terrain; returns the nearest surface hit or null. Tests every
 *  resident LOD level (base + rings) in its own level-local space, so taps land on ring terrain too. */
export function raycastMarkerNDC(ndc: { x: number; y: number }, camera: THREE.Camera): THREE.Vector3 | null {
  if (!terrain) return null;
  _ndc.set(ndc.x, ndc.y);
  const camFar = (camera as THREE.PerspectiveCamera).far || 1000;
  let best: THREE.Vector3 | null = null;
  let bestDist = Infinity;
  for (const { scale, meshes } of levelSets()) {
    if (!meshes.length) continue;
    // Meshes live in level-local space (÷ scale from true world): transform the true-world camera ray in
    // (divide origin, keep direction), intersect, scale the hit back, and keep the nearest across levels.
    raycaster.setFromCamera(_ndc, camera);
    raycaster.far = camFar / scale;
    if (scale !== 1) raycaster.ray.origin.multiplyScalar(1 / scale);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) continue;
    const pt = hits[0].point.clone().multiplyScalar(scale);
    const d = pt.distanceToSquared(camera.position);
    if (d < bestDist) { bestDist = d; best = pt; }
  }
  return best;
}

/** Downward raycast at an (x,z) column; returns the topmost surface point across LOD levels, or null. */
function raycastColumn(x: number, z: number): THREE.Vector3 | null {
  if (!terrain) return null;
  let best: THREE.Vector3 | null = null;
  let bestY = -Infinity;
  for (const { scale, meshes } of levelSets()) {
    if (!meshes.length) continue;
    // (x,z) true-world → level-local (÷ scale). 200 m start stays above the local surface at every zoom.
    const inv = 1 / scale;
    raycaster.set(new THREE.Vector3(x * inv, SPAWN_RAYCAST_HEIGHT, z * inv), _down);
    raycaster.far = SPAWN_RAYCAST_HEIGHT * 2;
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) continue;
    const pt = hits[0].point.clone().multiplyScalar(scale);
    if (pt.y > bestY) { bestY = pt.y; best = pt; }
  }
  return best;
}

/** Place the marker at a world surface point. */
export function placeMarkerAt(hit: THREE.Vector3): void {
  if (!group) return;
  basePoint.copy(hit);
  spawnPos.set(hit.x, hit.y + PLAYER_HEIGHT + SPAWN_HEIGHT_OFFSET, hit.z);
  group.position.copy(hit);
  group.visible = true;
  placed = true;
}

/** Place from a screen tap (NDC). Returns true if it hit terrain. */
export function placeMarkerFromNDC(ndc: { x: number; y: number }, camera: THREE.Camera): boolean {
  const hit = raycastMarkerNDC(ndc, camera);
  if (!hit) return false;
  placeMarkerAt(hit);
  return true;
}

/** Auto-place at an (x,z) column (e.g. the last player position). Returns true if placed. */
export function placeMarkerAtColumn(x: number, z: number): boolean {
  const hit = raycastColumn(x, z);
  if (!hit) return false;
  placeMarkerAt(hit);
  return true;
}

export function isMarkerPlaced(): boolean { return placed; }
export function getSpawnPosition(): THREE.Vector3 { return spawnPos; }
export function getMarkerBase(): THREE.Vector3 { return basePoint; }

export function setMarkerVisible(v: boolean): void {
  if (group) group.visible = v && placed;
}

/** Arm the marker so the next Playing entry spawns at it (called by the Play button). */
export function armMarkerSpawn(): void { armed = true; }

/** If armed + placed, return the spawn position and clear the arm; else null. */
export function consumeMarkerSpawn(): THREE.Vector3 | null {
  if (!armed || !placed) { armed = false; return null; }
  armed = false;
  return spawnPos.clone();
}

/** Reset placement (e.g. on world switch) so it re-auto-places for the new world. */
export function resetMarker(): void {
  placed = false;
  armed = false;
  if (group) group.visible = false;
}
