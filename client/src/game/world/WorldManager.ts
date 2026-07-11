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

// ============== Types ==============

export interface WorldMeta {
  id: string;
  name: string;
  seed: number;
  createdAt: number;
  lastPlayedAt: number;
}

// ============== IndexedDB ==============

const DB_NAME = 'worldify-worlds';
const DB_VERSION = 2;
const STORE_WORLDS = 'worlds';   // keyPath 'id' → WorldMeta
const STORE_CHUNKS = 'chunks';   // key `${worldId}:${chunkKey}` → Uint16Array
const STORE_SNAPS = 'snaps';     // key worldId → {x,y,z}[]
const STORE_UNDO = 'undo';       // key worldId → UndoEntry[]

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

export async function createWorld(name?: string, seed?: number): Promise<WorldMeta> {
  const existing = await listWorlds();
  const world: WorldMeta = {
    id: crypto.randomUUID(),
    name: name ?? `World ${existing.length + 1}`,
    seed: seed ?? Math.floor(Math.random() * 0x7fffffff),
    createdAt: Date.now(),
    lastPlayedAt: Date.now(),
  };
  await idbPut(STORE_WORLDS, world);
  return world;
}

/** Create a new world AND make it active (rebuilds terrain). */
export async function createAndActivateWorld(name?: string): Promise<WorldMeta> {
  const world = await createWorld(name);
  await setActiveWorld(world.id);
  return world;
}

/** Switch the active world and rebuild the terrain via the registered handler. */
export async function setActiveWorld(id: string): Promise<void> {
  if (activeWorld?.id === id) return;
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
    const tx = db.transaction([STORE_WORLDS, STORE_SNAPS, STORE_CHUNKS, STORE_UNDO], 'readwrite');
    tx.objectStore(STORE_WORLDS).delete(id);
    tx.objectStore(STORE_SNAPS).delete(id);
    tx.objectStore(STORE_UNDO).delete(id);
    const chunkStore = tx.objectStore(STORE_CHUNKS);
    const range = IDBKeyRange.bound(`${id}:`, `${id}:￿`);
    const cur = chunkStore.openKeyCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { chunkStore.delete(c.primaryKey); c.continue(); }
    };
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
  undoStack = (await idbGet<UndoEntry[]>(STORE_UNDO, world.id)) ?? [];
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

export async function loadChunk(key: string): Promise<Uint16Array | null> {
  if (!activeWorld) return null;
  const buf = await idbGet<Uint16Array>(STORE_CHUNKS, `${activeWorld.id}:${key}`);
  return buf ?? null;
}

/** Fire-and-forget save (clones the data — chunk.data is mutated in place). */
export function saveChunk(key: string, data: Uint16Array): void {
  if (!activeWorld) return;
  persistedKeys.add(key);
  idbPut(STORE_CHUNKS, new Uint16Array(data), `${activeWorld.id}:${key}`).catch(() => { /* non-critical */ });
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

// ============== Undo stack (active world) ==============

/** A chunk's voxel data before a build op — enough to reverse it. */
export interface ChunkSnapshot { key: string; data: Uint16Array; }
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
