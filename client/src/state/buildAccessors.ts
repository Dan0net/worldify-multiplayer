/**
 * Imperative build-state accessors for non-React game code (Builder, BuildMarker,
 * player controls). These read the Zustand store via getState() — no reactivity —
 * and replace the computed build getters the old StoreBridge exposed.
 */

import { useGameStore } from './store';
import { getPreset, slotIsEmpty, BUILD_ROTATION_STEP, type BuildPreset } from '@worldify/shared';

/** The active build preset, merged with the slot's config + placement metadata. */
export function getBuildPreset(): BuildPreset {
  const state = useGameStore.getState();
  const id = state.build.presetId;
  const base = getPreset(id);
  const meta = state.build.presetMeta[id];
  if (meta) {
    return {
      ...base,
      align: meta.align,
      snapShape: meta.snapShape,
      baseRotation: meta.baseRotation,
      autoRotateY: meta.autoRotateY,
      parts: meta.parts,
    };
  }
  return base;
}

/** Current build rotation in radians. */
export function getBuildRotationRadians(): number {
  return (useGameStore.getState().build.rotationSteps * BUILD_ROTATION_STEP * Math.PI) / 180;
}

/** Whether build mode is active AND the selected slot has buildable geometry. */
export function getBuildIsEnabled(): boolean {
  const { buildMode, presetId, presetMeta } = useGameStore.getState().build;
  return buildMode && !slotIsEmpty(presetMeta[presetId]);
}
