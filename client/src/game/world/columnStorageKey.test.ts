import { describe, it, expect } from 'vitest';
import { columnStorageKey } from './WorldManager.js';

/**
 * GUARD: LOD-namespaced persistence keys. Column/chunk coords are level-LOCAL, so tile (tx,tz) covers a
 * 2^L-larger world region at each coarser level. Persisting every level under a shared (tx,tz) key made a
 * coarse tile alias the level-0 tile — on zoom-in to level 0 the stale coarse heights seeded the wrong
 * vertical load range and the surface generated with terraced/wrong-height chunks. Keys must therefore be
 * distinct per level, while level 0 keeps its legacy bare key so worlds saved before LOD persistence load
 * unchanged (no migration).
 */
describe('columnStorageKey', () => {
  it('keeps level 0 on the legacy bare key (back-compat, no migration)', () => {
    expect(columnStorageKey(5, -3, 0)).toBe('5,-3');
    expect(columnStorageKey(5, -3)).toBe('5,-3');   // default level 0
  });

  it('namespaces coarse levels so they never alias level 0 or each other', () => {
    const keys = [0, 1, 2, 3, 4, 5, 6].map((l) => columnStorageKey(5, -3, l));
    expect(new Set(keys).size).toBe(keys.length);   // all distinct
    expect(columnStorageKey(5, -3, 2)).toBe('2:5,-3');
    // A coarse key for one column must not collide with the level-0 key of a different column.
    expect(columnStorageKey(5, -3, 2)).not.toBe(columnStorageKey(2, 5, 0));
  });
});
