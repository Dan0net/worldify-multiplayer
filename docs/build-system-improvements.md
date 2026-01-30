# Build System Stage 3 Improvements

Code review fixes for KISS, DRY, SOLID compliance.

---

## 1. Add rotation constants & quaternion utility (DRY)

**Files:** `shared/src/voxel/buildPresets.ts`, `shared/src/voxel/buildTypes.ts`

- [ ] Change `BUILD_ROTATION_STEP` from 45 to 22.5 (16 steps instead of 8)
- [ ] Add `BUILD_ROTATION_STEPS = 16` constant
- [ ] Add `yRotationQuat(radians: number): Quat` utility to `buildTypes.ts`
- [ ] Update store rotation clamping: `& 15` instead of `& 7`
- [ ] Update bridge rotation wrapping: `% 16` instead of `% 8`

---

## 2. Fix BuildMarker state mutation (SRP)

**Files:** `client/src/game/build/BuildMarker.ts`, `client/src/game/build/Builder.ts`

- [ ] Remove `storeBridge.setBuildHasValidTarget()` from `BuildMarker.update()`
- [ ] Return `{ hasValidTarget: boolean }` from `BuildMarker.update()`
- [ ] Move state update to `Builder.update()` after calling marker

---

## 3. Fix ChunkMesh preview disposal (Memory Leak)

**File:** `client/src/game/voxel/ChunkMesh.ts`

- [ ] Make `scene` parameter required in `setPreviewActive()`
- [ ] Or: store scene reference when preview mesh is created

---

## 4. Use yRotationQuat utility (DRY)

**File:** `client/src/game/build/BuildPreview.ts`

- [ ] Replace manual quaternion calculation in `createOperation()` with `yRotationQuat()`

---

## 5. Simplify preview state (KISS)

**File:** `client/src/game/build/BuildPreview.ts`

- [ ] Remove `isActive` field
- [ ] Derive from `activePreviewChunks.size > 0` in `hasActivePreview()`

---

## 6. Use registry for apply functions (OCP)

**File:** `shared/src/voxel/drawing.ts`

- [ ] Replace switch in `getApplyFunction()` with `Record<BuildMode, ApplyFunction>` lookup

---

## 7. Inject controls dependency (DIP)

**File:** `client/src/game/build/Builder.ts`

- [ ] Accept `Controls` as constructor parameter instead of importing singleton
- [ ] Update dispose to only clear callback if it matches

---

## Order of Implementation

1. **Task 1** - Foundation (constants + utility)
2. **Task 4** - Use new utility
3. **Task 5** - Simplify state
4. **Task 6** - Registry pattern
5. **Task 2** - BuildMarker SRP fix
6. **Task 3** - Memory leak fix
7. **Task 7** - DI refactor (optional, lower priority)
