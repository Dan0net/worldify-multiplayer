/**
 * SpawnMarker — the explore-mode spawn gizmo.
 *
 * A flat ring on the terrain surface + a long vertical line, showing where the player
 * will spawn. In explore mode the user taps the ground to place/move it and a React
 * Play button (anchored to the top of the line) starts 1st-person play there.
 *
 * Module singleton (one marker, one scene), mirroring the `controls` singleton so both
 * the game loop and React UI can drive it without prop threading.
 */

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { PLAYER_HEIGHT, SPAWN_HEIGHT_OFFSET, SPAWN_RAYCAST_HEIGHT } from '@worldify/shared';
import type { TerrainRaycaster } from './TerrainRaycaster';

const LINE_HEIGHT = 7;       // world units the vertical line rises above the surface
const RING_INNER = 0.7;
const RING_OUTER = 1.05;
const MARKER_COLOR = 0x38e8ff;

let scene: THREE.Scene | null = null;
let terrain: TerrainRaycaster | null = null;
let group: THREE.Group | null = null;
let lineMaterial: LineMaterial | null = null;

/** Keep the fat-line's screen-space width correct across viewport resizes. */
function updateLineResolution(): void {
  lineMaterial?.resolution.set(window.innerWidth, window.innerHeight);
}

let placed = false;
let armed = false;                        // Play requested → next Playing entry uses the marker
const spawnPos = new THREE.Vector3();     // player spawn (surface + player height)
const basePoint = new THREE.Vector3();    // ring position (on surface)
const topPoint = new THREE.Vector3();     // top of the vertical line (Play-button anchor)

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

  // Fat line so the vertical marker has real thickness (2px, matching the Play-button
  // outline) — plain THREE.Line ignores linewidth in WebGL and always renders 1px.
  lineMaterial = new LineMaterial({
    color: MARKER_COLOR, linewidth: 2, transparent: true, opacity: 0.85, depthTest: false,
  });
  lineMaterial.resolution.set(window.innerWidth, window.innerHeight);
  const lineGeo = new LineGeometry();
  lineGeo.setPositions([0, 0, 0, 0, LINE_HEIGHT, 0]);
  const line = new Line2(lineGeo, lineMaterial);
  line.renderOrder = 999;
  line.frustumCulled = false;
  group.add(line);

  window.addEventListener('resize', updateLineResolution);
  scene.add(group);
}

/** Raycast a screen NDC point against the terrain; returns the surface hit or null. */
export function raycastMarkerNDC(ndc: { x: number; y: number }, camera: THREE.Camera): THREE.Vector3 | null {
  if (!terrain) return null;
  _ndc.set(ndc.x, ndc.y);
  raycaster.setFromCamera(_ndc, camera);
  raycaster.far = 1000;
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
  topPoint.set(hit.x, hit.y + LINE_HEIGHT, hit.z);
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
export function getMarkerTop(): THREE.Vector3 { return topPoint; }
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
