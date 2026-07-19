/**
 * WorldManager — local multi-world save/load.
 *
 * Each world has its own seed and its own persisted chunks + snap points, stored
 * in IndexedDB. The active world's chunks are persisted as they are generated
 * (and overwritten on edit) so the world is fully reproduced on reload. The last
 * active world id is remembered in localStorage and restored on page load.
 *
 * Local (offline) mode only — the server path is unaffected.
 */

import type { CaveConfig, TerrainLayerConfig } from '@worldify/shared';

// ============== Types ==============

export interface WorldMeta {
  id: string;
  name: string;
  seed: number;
  createdAt: number;
  lastPlayedAt: number;
  /** Last player position + look, restored on load / world switch (optional). */
  lastPos?: { x: number; y: number; z: number };
  lastYaw?: number;
  lastPitch?: number;
  /** Persisted time-of-day (0-1), restored on load / world switch (optional). */
  timeOfDay?: number;
  /** Per-world cave generation settings, chosen at creation (optional → engine defaults). */
  caveConfig?: CaveConfig;
  /** Per-world base-terrain layer settings, chosen at creation (optional → engine defaults). */
  terrainConfig?: TerrainLayerConfig;
}

/** Player position + look snapshot for persistence. */
export interface PlayerPose { x: number; y: number; z: number; yaw: number; pitch: number; }

// ============== IndexedDB ==============

const DB_NAME = 'worldify-worlds';
// v3: voxel word widened 16-bit → 32-bit. Old Uint16Array chunk records are
// migrated lazily on load (see loadChunk) — no onupgradeneeded rewrite needed.
const DB_VERSION = 4;
const STORE_WORLDS = 'worlds';   // keyPath 'id' → WorldMeta
const STORE_CHUNKS = 'chunks';   // key `${worldId}:${chunkKey}` → Uint32Array
const STORE_SNAPS = 'snaps';     // key worldId → {x,y,z}[]
const STORE_UNDO = 'undo';       // key worldId → UndoEntry[]
const STORE_COLUMNS = 'columns'; // key `${worldId}:${tx},${tz}` → SavedColumn (stamp-corrected heights)

const ACTIVE_WORLD_KEY = 'worldify-active-world';
const DEFAULT_SEED = 12345;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_WORLDS)) db.createObjectStore(STORE_WORLDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) db.createObjectStore(STORE_CHUNKS);
      if (!db.objectStoreNames.contains(STORE_SNAPS)) db.createObjectStore(STORE_SNAPS);
      if (!db.objectStoreNames.contains(STORE_UNDO)) db.createObjectStore(STORE_UNDO);
      if (!db.objectStoreNames.contains(STORE_COLUMNS)) db.createObjectStore(STORE_COLUMNS);
    };
  });
  return dbPromise;
}

function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return openDB().then(db => new Promise<T | undefined>((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result as T | undefined);
  }));
}

function idbPut(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  return openDB().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbGetAll<T>(store: string): Promise<T[]> {
  return openDB().then(db => new Promise<T[]>((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result as T[]);
  }));
}

// ============== Module state ==============

let activeWorld: WorldMeta | null = null;
/** Bare chunk keys ("cx,cy,cz") persisted for the ACTIVE world — sync existence check. */
let persistedKeys = new Set<string>();
/** Undo stack for the ACTIVE world (before-images of build ops), persisted to IDB. */
let undoStack: UndoEntry[] = [];
const UNDO_MAX = 20;
/** Called after the active world changes so the game can rebuild the terrain. */
let onWorldSwitch: (() => void) | null = null;

export function setWorldSwitchHandler(cb: () => void): void {
  onWorldSwitch = cb;
}

/** Supplies the current player pose so the OUTGOING world can be saved on switch. */
let posProvider: (() => PlayerPose) | null = null;

export function setPlayerPosProvider(cb: () => PlayerPose): void {
  posProvider = cb;
}

/** Supplies the current time-of-day so the OUTGOING world can be saved on switch. */
let timeProvider: (() => number) | null = null;

export function setTimeOfDayProvider(cb: () => number): void {
  timeProvider = cb;
}

/** Listeners notified when the world list or active world changes (for UI refresh). */
const worldsChangedCbs = new Set<() => void>();

export function subscribeWorldsChanged(cb: () => void): () => void {
  worldsChangedCbs.add(cb);
  return () => { worldsChangedCbs.delete(cb); };
}

function notifyWorldsChanged(): void {
  for (const cb of worldsChangedCbs) { try { cb(); } catch { /* ignore */ } }
}

// ============== World lifecycle ==============

export async function initWorlds(): Promise<WorldMeta> {
  try {
    const worlds = await listWorlds();
    if (worlds.length === 0) {
      activeWorld = await createWorld('World 1', DEFAULT_SEED);
    } else {
      const savedId = localStorage.getItem(ACTIVE_WORLD_KEY);
      activeWorld =
        worlds.find(w => w.id === savedId) ??
        worlds.slice().sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)[0];
    }
    await activate(activeWorld);
    return activeWorld;
  } catch (e) {
    // IndexedDB unavailable (e.g. private mode): fall back to an in-memory world
    // so the game still boots — it just regenerates from the seed each load.
    console.warn('[WorldManager] persistence unavailable, using in-memory world', e);
    activeWorld = { id: 'default', name: 'World 1', seed: DEFAULT_SEED, createdAt: Date.now(), lastPlayedAt: Date.now() };
    persistedKeys = new Set();
    persistedColumnKeys = new Set();
    return activeWorld;
  }
}

export function listWorlds(): Promise<WorldMeta[]> {
  return idbGetAll<WorldMeta>(STORE_WORLDS);
}

export function getActiveWorld(): WorldMeta | null {
  return activeWorld;
}

export function getActiveWorldSeed(): number {
  return activeWorld?.seed ?? DEFAULT_SEED;
}

/** The active world's cave settings (undefined → engine defaults). */
export function getActiveWorldCaveConfig(): CaveConfig | undefined {
  return activeWorld?.caveConfig;
}

/** The active world's base-terrain layer settings (undefined → engine defaults). */
export function getActiveWorldTerrainConfig(): TerrainLayerConfig | undefined {
  return activeWorld?.terrainConfig;
}

/** A fresh random world seed (31-bit), matching createWorld's default. */
export function randomWorldSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** The default name a new world would get ("World N"), for pre-filling the create dialog. */
export async function nextWorldName(): Promise<string> {
  return `World ${(await listWorlds()).length + 1}`;
}

export async function createWorld(
  name?: string, seed?: number, caveConfig?: CaveConfig, terrainConfig?: TerrainLayerConfig,
): Promise<WorldMeta> {
  const existing = await listWorlds();
  const world: WorldMeta = {
    id: crypto.randomUUID(),
    name: name?.trim() || `World ${existing.length + 1}`,
    seed: seed ?? randomWorldSeed(),
    createdAt: Date.now(),
    lastPlayedAt: Date.now(),
    ...(caveConfig ? { caveConfig } : {}),
    ...(terrainConfig ? { terrainConfig } : {}),
  };
  await idbPut(STORE_WORLDS, world);
  return world;
}

/** Create a new world AND make it active (rebuilds terrain). */
export async function createAndActivateWorld(
  name?: string, seed?: number, caveConfig?: CaveConfig, terrainConfig?: TerrainLayerConfig,
): Promise<WorldMeta> {
  const world = await createWorld(name, seed, caveConfig, terrainConfig);
  await setActiveWorld(world.id);
  return world;
}

/** Switch the active world and rebuild the terrain via the registered handler. */
export async function setActiveWorld(id: string): Promise<void> {
  if (activeWorld?.id === id) return;
  // Snapshot the OUTGOING world's player pose before we swap active worlds — activate()
  // reassigns `activeWorld`, so this must run first (the game-side switch handler is
  // too late). Writes the current (old) world; activate() then loads the new one's pose.
  if (activeWorld && posProvider) {
    const p = posProvider();
    savePlayerPos(p);
  }
  if (activeWorld && timeProvider) {
    saveTimeOfDay(timeProvider());
  }
  const world = await idbGet<WorldMeta>(STORE_WORLDS, id);
  if (!world) return;
  await activate(world);
  onWorldSwitch?.();
}

export async function deleteWorld(id: string): Promise<void> {
  const worlds = await listWorlds();
  if (worlds.length <= 1) return; // never delete the last world
  const db = await openDB();
  // Remove meta + snaps + all chunk rows for this world.
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_WORLDS, STORE_SNAPS, STORE_CHUNKS, STORE_UNDO, STORE_COLUMNS], 'readwrite');
    tx.objectStore(STORE_WORLDS).delete(id);
    tx.objectStore(STORE_SNAPS).delete(id);
    tx.objectStore(STORE_UNDO).delete(id);
    const range = IDBKeyRange.bound(`${id}:`, `${id}:￿`);
    for (const storeName of [STORE_CHUNKS, STORE_COLUMNS]) {
      const store = tx.objectStore(storeName);
      const cur = store.openKeyCursor(range);
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { store.delete(c.primaryKey); c.continue(); }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  // If we deleted the active world, activate the most-recently-played remaining one.
  if (activeWorld?.id === id) {
    const remaining = (await listWorlds()).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
    await activate(remaining[0]);
    onWorldSwitch?.();
  }
}

/** Internal: set active world, persist last-active id, touch lastPlayedAt, preload keys. */
async function activate(world: WorldMeta): Promise<void> {
  activeWorld = world;
  world.lastPlayedAt = Date.now();
  try { localStorage.setItem(ACTIVE_WORLD_KEY, world.id); } catch { /* ignore */ }
  await idbPut(STORE_WORLDS, world);
  await preloadChunkKeys(world.id);
  await preloadColumnKeys(world.id);
  undoStack = (await idbGet<UndoEntry[]>(STORE_UNDO, world.id)) ?? [];
  notifyWorldsChanged();
}

async function preloadChunkKeys(worldId: string): Promise<void> {
  persistedKeys = new Set();
  const db = await openDB();
  const range = IDBKeyRange.bound(`${worldId}:`, `${worldId}:￿`);
  await new Promise<void>((resolve, reject) => {
    const req = db.transaction(STORE_CHUNKS, 'readonly').objectStore(STORE_CHUNKS).getAllKeys(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const prefix = `${worldId}:`;
      for (const k of req.result as string[]) persistedKeys.add(k.slice(prefix.length));
      resolve();
    };
  });
}

// ============== Chunk persistence (active world) ==============

/** Sync: is this chunk already persisted for the active world? */
export function hasChunk(key: string): boolean {
  return persistedKeys.has(key);
}

export async function loadChunk(key: string): Promise<Uint32Array | null> {
  if (!activeWorld) return null;
  const buf = await idbGet<Uint16Array | Uint32Array>(STORE_CHUNKS, `${activeWorld.id}:${key}`);
  if (!buf) return null;
  // Migrate legacy 16-bit records: widen element-wise into 32-bit words (block/spare
  // bits become 0; both light channels are recomputed client-side on ingest anyway).
  return buf.BYTES_PER_ELEMENT === 4 ? (buf as Uint32Array) : new Uint32Array(buf);
}

/** Fire-and-forget save (clones the data — chunk.data is mutated in place). */
export function saveChunk(key: string, data: Uint32Array): void {
  if (!activeWorld) return;
  persistedKeys.add(key);
  idbPut(STORE_CHUNKS, new Uint32Array(data), `${activeWorld.id}:${key}`).catch(() => { /* non-critical */ });
}

// ============== Column-heights persistence (active world) ==============
//
// The stamp-corrected surface heights/materials for a tile column. Persisted the first time a column
// is generated so revisiting an explored world reads its heights from IDB (~instant) instead of
// re-running the full worker generateColumn/generateTile (which re-carves caves just to measure the
// surface) on every column. Keyed `${worldId}:${tx},${tz}`.

export interface SavedColumn { heights: Int16Array; materials: Uint8Array; }

let persistedColumnKeys = new Set<string>();

async function preloadColumnKeys(worldId: string): Promise<void> {
  persistedColumnKeys = new Set();
  const db = await openDB();
  const range = IDBKeyRange.bound(`${worldId}:`, `${worldId}:￿`);
  await new Promise<void>((resolve, reject) => {
    const req = db.transaction(STORE_COLUMNS, 'readonly').objectStore(STORE_COLUMNS).getAllKeys(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const prefix = `${worldId}:`;
      for (const k of req.result as string[]) persistedColumnKeys.add(k.slice(prefix.length));
      resolve();
    };
  });
}

/** Sync: are this column's heights already persisted for the active world? */
export function hasColumn(tx: number, tz: number): boolean {
  return persistedColumnKeys.has(`${tx},${tz}`);
}

export async function loadColumn(tx: number, tz: number): Promise<SavedColumn | null> {
  if (!activeWorld) return null;
  const rec = await idbGet<SavedColumn>(STORE_COLUMNS, `${activeWorld.id}:${tx},${tz}`);
  return rec ?? null;
}

/** Fire-and-forget save of a column's stamp-corrected heights/materials. */
export function saveColumn(tx: number, tz: number, heights: Int16Array, materials: Uint8Array): void {
  if (!activeWorld) return;
  const ck = `${tx},${tz}`;
  persistedColumnKeys.add(ck);
  idbPut(STORE_COLUMNS, { heights: new Int16Array(heights), materials: new Uint8Array(materials) } as SavedColumn,
    `${activeWorld.id}:${ck}`).catch(() => { /* non-critical */ });
}

// ============== Snap-point persistence (active world) ==============

export interface SnapPoint { x: number; y: number; z: number; }

export async function loadSnapPoints(): Promise<SnapPoint[]> {
  if (!activeWorld) return [];
  return (await idbGet<SnapPoint[]>(STORE_SNAPS, activeWorld.id)) ?? [];
}

export function saveSnapPoints(points: SnapPoint[]): void {
  if (!activeWorld) return;
  idbPut(STORE_SNAPS, points, activeWorld.id).catch(() => { /* non-critical */ });
}

// ============== Player-pose persistence (active world) ==============

/**
 * Persist the player's position + look on the active world's meta row (fire-and-forget).
 * Stored as fields on WorldMeta so no schema change is needed; loaded back in activate().
 */
export function savePlayerPos(pose: PlayerPose): void {
  if (!activeWorld) return;
  activeWorld.lastPos = { x: pose.x, y: pose.y, z: pose.z };
  activeWorld.lastYaw = pose.yaw;
  activeWorld.lastPitch = pose.pitch;
  idbPut(STORE_WORLDS, activeWorld).catch(() => { /* non-critical */ });
}

/** The active world's saved player pose, or null if it has none (e.g. a new world). */
export function loadPlayerPos(): PlayerPose | null {
  const w = activeWorld;
  if (!w || !w.lastPos) return null;
  return { x: w.lastPos.x, y: w.lastPos.y, z: w.lastPos.z, yaw: w.lastYaw ?? 0, pitch: w.lastPitch ?? 0 };
}

/** Persist the active world's time-of-day (0-1), fire-and-forget. */
export function saveTimeOfDay(timeOfDay: number): void {
  if (!activeWorld) return;
  activeWorld.timeOfDay = timeOfDay;
  idbPut(STORE_WORLDS, activeWorld).catch(() => { /* non-critical */ });
}

/** The active world's saved time-of-day, or null if it has none. */
export function loadTimeOfDay(): number | null {
  return activeWorld?.timeOfDay ?? null;
}

// ============== Undo stack (active world) ==============

/** A chunk's voxel data before a build op — enough to reverse it. */
export interface ChunkSnapshot { key: string; data: Uint32Array; }
export type UndoEntry = ChunkSnapshot[];

export function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  while (undoStack.length > UNDO_MAX) undoStack.shift();
  saveUndo();
}

export function popUndo(): UndoEntry | undefined {
  const entry = undoStack.pop();
  saveUndo();
  return entry;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

function saveUndo(): void {
  if (!activeWorld) return;
  idbPut(STORE_UNDO, undoStack, activeWorld.id).catch(() => { /* non-critical */ });
}
