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

/** Raycast a screen NDC point against the terrain; returns the surface hit or null. */
export function raycastMarkerNDC(ndc: { x: number; y: number }, camera: THREE.Camera): THREE.Vector3 | null {
  if (!terrain) return null;
  _ndc.set(ndc.x, ndc.y);
  raycaster.setFromCamera(_ndc, camera);
  // Reach as far as the camera can see. At a coarse LOD zoom the explore camera sits far out (up to
  // ~2 km) and its far plane grows with the zoom, so a fixed 1000 m would fall short of the terrain and
  // taps wouldn't register. Match the camera's far plane so a tap hits whatever is visible.
  raycaster.far = (camera as THREE.PerspectiveCamera).far || 1000;
  const hits = raycaster.intersectObjects(terrain.getSolidMeshes(), false);
  return hits.length > 0 ? hits[0].point.clone() : null;
}

/** Downward raycast at an (x,z) column; returns the surface point or null. */
function raycastColumn(x: number, z: number): THREE.Vector3 | null {
  if (!terrain) return null;
  raycaster.set(new THREE.Vector3(x, SPAWN_RAYCAST_HEIGHT, z), _down);
  raycaster.far = SPAWN_RAYCAST_HEIGHT * 2;
  const hits = raycaster.intersectObjects(terrain.getSolidMeshes(), false);
  return hits.length > 0 ? hits[0].point.clone() : null;
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

/**
 * Scale the marker to keep a constant APPARENT size at coarse LOD zoom. The explore camera sits 2^level
 * further out per level, so a fixed ~1 m ring shrinks to a sub-pixel dot when zoomed out (invisible at
 * level 2+). Scaling the group by 2^level keeps radius/distance constant, so the ring reads the same at
 * every zoom. `scale = 1` at level 0 / play is a no-op.
 */
export function setMarkerScale(scale: number): void {
  if (group) group.scale.setScalar(scale);
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
