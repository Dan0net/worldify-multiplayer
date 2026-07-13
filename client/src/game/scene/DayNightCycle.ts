/**
 * Day-Night Cycle Controller
 *
 * Advances the clock and, each frame, derives the full lighting state from `timeOfDay` +
 * the editable `DayNightConfig` keyframes (single source of truth) and applies it directly
 * to the scene lights + sky. The store is not round-tripped per frame.
 */

import { useGameStore } from '../../state/store';
import { updateShadowCaster, applyDerivedLighting } from './Lighting';
import { deriveLighting } from '@worldify/shared';

// ============== Main Update Function ==============

/**
 * Last time-of-day we derived + applied. When the clock is static (`timeSpeed === 0`) the
 * derived palette can't change, so we skip the recompute; a keyframe edit forces a re-derive
 * via `invalidateDayNight()`.
 */
let lastAppliedTime = -1;

/**
 * Force the next `updateDayNightCycle` to re-derive even if `timeOfDay` hasn't changed —
 * called when a keyframe / global cycle setting is edited so the change applies live.
 */
export function invalidateDayNight(): void {
  lastAppliedTime = -1;
}

export function updateDayNightCycle(deltaMs: number): void {
  const state = useGameStore.getState();
  const env = state.environment;
  const cfg = state.dayNightConfig;

  if (!(env.dayNightEnabled ?? false)) {
    lastAppliedTime = -1; // re-apply when the cycle is re-enabled
    return;
  }

  // Advance the clock (the one input that changes). Persisted so the UI clock reflects it.
  let time = env.timeOfDay ?? 0.375;
  const timeSpeed = env.timeSpeed ?? 0;
  if (timeSpeed > 0) {
    const minutesElapsed = timeSpeed * (deltaMs / 1000);
    time = (time + minutesElapsed / 1440) % 1;
    if (time < 0) time += 1;
    state.setTimeOfDay(time);
  }

  const derived = deriveLighting(cfg.keyframes, time, cfg.sunHeight, cfg.sunDistance);

  // Shadow ownership + the pop-free fade run EVERY frame (before the static-clock early
  // return) so a manual time-drag while paused still fades correctly. Cheap: a compare +
  // an elevation-driven intensity ramp, with a rare map swap.
  updateShadowCaster(derived.sunElevation, derived.sunIntensity, derived.moonIntensity);

  // Nothing changed since last frame — skip the palette recompute + apply.
  if (time === lastAppliedTime) return;
  lastAppliedTime = time;

  applyDerivedLighting(derived);
}

// ============== Utility Exports ==============

// formatTimeOfDay / getDayPhaseLabel live in @worldify/shared (single definition);
// re-exported here so existing UI imports keep working.
export { formatTimeOfDay, getDayPhaseLabel } from '@worldify/shared';
