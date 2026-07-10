/**
 * Imperative build-state accessors for non-React game code (Builder, BuildMarker,
 * player controls). These read the Zustand store via getState() — no reactivity —
 * and replace the computed build getters the old StoreBridge exposed.
 */

import { useGameStore } from './store';
import { getPreset, NONE_PRESET_ID, BUILD_ROTATION_STEP, type BuildPreset } from '@worldify/shared';

/** The active build preset, merged with the slot's config + placement metadata. */
export function getBuildPreset(): BuildPreset {
  const state = useGameStore.getState();
  const id = state.build.presetId;
  const base = getPreset(id);
  const config = state.build.presetConfigs[id];
  const meta = state.build.presetMeta[id];
  if (config && meta) {
    return { ...base, config, align: meta.align, snapShape: meta.snapShape, baseRotation: meta.baseRotation, autoRotateY: meta.autoRotateY };
  }
  if (config) {
    return { ...base, config };
  }
  return base;
}

/** Current build rotation in radians. */
export function getBuildRotationRadians(): number {
  return (useGameStore.getState().build.rotationSteps * BUILD_ROTATION_STEP * Math.PI) / 180;
}

/** Whether a real build preset is selected (not the None slot). */
export function getBuildIsEnabled(): boolean {
  return useGameStore.getState().build.presetId !== NONE_PRESET_ID;
}
