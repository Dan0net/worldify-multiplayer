/**
 * Day-Night Cycle Controller
 * 
 * Manages time progression and calculates lighting values based on time of day.
 * All state is synced to the Zustand store for UI display and component access.
 */

import { useGameStore, EnvironmentSettings, DayNightConfig } from '../../state/store';
import { updateShadowCaster, applyEnvironmentSettings } from './Lighting';
import {
  // Solar
  SUN_ELEVATION_MIN,
  SUN_ELEVATION_MAX,
  SUN_COLOR_TWILIGHT,
  SUN_GRADIENT_SUNRISE,
  SUN_GRADIENT_SUNSET,
  // Moon thresholds
  MOON_THRESHOLD_INVISIBLE,
  MOON_THRESHOLD_FAINT,
  MOON_THRESHOLD_RISING,
  MOON_THRESHOLD_FULL,
  // Hemisphere transitional gradients (day/night endpoints now come from DayNightConfig)
  HEMISPHERE_SKY_GRADIENT_SUNRISE,
  HEMISPHERE_SKY_GRADIENT_SUNSET,
  HEMISPHERE_GROUND_SUNRISE,
  HEMISPHERE_GROUND_SUNSET,
  // Helpers
  lerp,
  getDayPhase,
  getPhaseValue,
  getPhaseColor,
  getPhaseColorGradient,
} from '@worldify/shared';

// ============== Solar Calculations ==============

/**
 * Get sun elevation angle based on time of day.
 * Returns degrees: positive = above horizon, negative = below
 */
function getSunElevation(time: number): number {
  // Time 0.5 = noon (max), 0.0/1.0 = midnight (min)
  const angle = (time - 0.5) * Math.PI * 2;
  const normalized = (Math.cos(angle) + 1) / 2;
  return lerp(SUN_ELEVATION_MIN, SUN_ELEVATION_MAX, normalized);
}

/**
 * Get sun azimuth (horizontal angle) based on time.
 */
function getSunAzimuth(time: number): number {
  return ((time * 360) + 90) % 360;
}

/**
 * Get sun color using multi-stop gradients for rich sunrise/sunset. The noon endpoint
 * comes from the editable day stage config; twilight + gradients stay as shared constants.
 */
function getSunColor(time: number, dayColor: string): string {
  return getPhaseColorGradient(
    time,
    dayColor,
    SUN_COLOR_TWILIGHT,
    SUN_GRADIENT_SUNRISE,
    SUN_GRADIENT_SUNSET
  );
}

/**
 * Get sun intensity based on elevation. `peak` is the editable day-stage noon intensity.
 */
function getSunIntensity(elevation: number, peak: number): number {
  if (elevation <= 0) {
    // Below horizon - fade out
    return Math.max(0, lerp(0.2, 0, -elevation / SUN_ELEVATION_MIN));
  }
  if (elevation < 20) {
    // Low angle - reduced intensity
    return lerp(0.5, peak, elevation / 20);
  }
  return peak;
}

/**
 * Get moon intensity based on sun elevation. `peak` is the editable night-stage intensity.
 * Moon starts early and overlaps with sun for a smooth handoff.
 */
function getMoonIntensity(sunElevation: number, peak: number): number {
  if (sunElevation > MOON_THRESHOLD_INVISIBLE) return 0;

  if (sunElevation > MOON_THRESHOLD_FAINT) {
    // Sun 25-45° - moon starts faintly
    const t = (MOON_THRESHOLD_INVISIBLE - sunElevation) / (MOON_THRESHOLD_INVISIBLE - MOON_THRESHOLD_FAINT);
    return lerp(0, peak * 0.3, t);
  }

  if (sunElevation > MOON_THRESHOLD_RISING) {
    // Sun 10-25° - moon ramping
    const t = (MOON_THRESHOLD_FAINT - sunElevation) / (MOON_THRESHOLD_FAINT - MOON_THRESHOLD_RISING);
    return lerp(peak * 0.3, peak * 0.6, t);
  }

  if (sunElevation > MOON_THRESHOLD_FULL) {
    // Sun -5 to 10° - final ramp
    const t = (MOON_THRESHOLD_RISING - sunElevation) / (MOON_THRESHOLD_RISING - MOON_THRESHOLD_FULL);
    return lerp(peak * 0.6, peak, t);
  }

  return peak;
}

// ============== Main Update Function ==============

/**
 * Update the day-night cycle. Call each frame.
 */
/**
 * Last time-of-day for which we derived + applied lighting. When `timeSpeed === 0`
 * (default) the time never changes, so the derived sun/moon/hemisphere recompute and
 * the apply are pure waste every frame — gate them on an actual time change. Manual
 * env edits (and auto-flag toggles) apply themselves on-change via the debug-panel
 * subscription, so they don't depend on this per-frame path.
 */
let lastAppliedTime = -1;

/**
 * Force the next `updateDayNightCycle` to re-derive even if `timeOfDay` hasn't changed.
 * Called when a `DayNightConfig` stage keyframe is edited, so the change applies live
 * without waiting for the clock to advance — and without re-pushing stale env state.
 */
export function invalidateDayNight(): void {
  lastAppliedTime = -1;
}

export function updateDayNightCycle(deltaMs: number): void {
  const state = useGameStore.getState();
  const env = state.environment;
  const cfg: DayNightConfig = state.dayNightConfig;

  if (!(env.dayNightEnabled ?? false)) {
    lastAppliedTime = -1; // re-apply when the cycle is re-enabled
    return;
  }

  // Advance time — the one *input* that changes. Persisted so the UI clock and
  // the time slider reflect it. (Default timeSpeed is 0, so at rest there is no
  // per-frame store write at all.)
  let time = env.timeOfDay ?? 0.35;
  const timeSpeed = env.timeSpeed ?? 0;
  if (timeSpeed > 0) {
    const minutesElapsed = timeSpeed * (deltaMs / 1000);
    time = (time + minutesElapsed / 1440) % 1;
    if (time < 0) time += 1;
    state.setTimeOfDay(time);
  }

  const sunElevation = getSunElevation(time);

  // Shadow-caster ownership depends on the current effective intensities. Keep this
  // responsive every frame — it's cheap (a compare + a rare swap).
  const effSunIntensity = getSunIntensity(sunElevation, cfg.day.sunIntensity);
  const effMoonIntensity = getMoonIntensity(sunElevation, cfg.night.moonIntensity);
  updateShadowCaster(effSunIntensity, effMoonIntensity);

  // Nothing changed since last frame (static clock + unchanged config) — skip the recompute.
  if (time === lastAppliedTime) return;
  lastAppliedTime = time;

  const sunAzimuth = getSunAzimuth(time);

  // Derived lighting *outputs*, interpolated from the editable day/night stage keyframes
  // (the single source of truth). Applied DIRECTLY to the lights + sky (never written back
  // to the store), so there is no per-frame round-trip and no stale state to re-push.
  const derived: Partial<EnvironmentSettings> = {
    sunAzimuth,
    sunElevation,
    sunColor: getSunColor(time, cfg.day.sunColor),
    sunIntensity: effSunIntensity,
    moonAzimuth: (sunAzimuth + 180) % 360,
    moonElevation: -sunElevation,
    moonColor: cfg.night.moonColor,
    moonIntensity: effMoonIntensity,
    environmentIntensity: getPhaseValue(time, cfg.day.environmentIntensity, cfg.night.environmentIntensity),
  };

  if (env.hemisphereEnabled ?? true) {
    derived.hemisphereSkyColor = getPhaseColorGradient(
      time, cfg.day.hemisphereSkyColor, cfg.night.hemisphereSkyColor,
      HEMISPHERE_SKY_GRADIENT_SUNRISE, HEMISPHERE_SKY_GRADIENT_SUNSET
    );
    derived.hemisphereGroundColor = getPhaseColor(
      time, cfg.day.hemisphereGroundColor, cfg.night.hemisphereGroundColor,
      HEMISPHERE_GROUND_SUNRISE, HEMISPHERE_GROUND_SUNSET
    );
    derived.hemisphereIntensity = getPhaseValue(time, cfg.day.hemisphereIntensity, cfg.night.hemisphereIntensity);
  }

  // Apply the animated values straight to the THREE lights + sky uniforms.
  applyEnvironmentSettings(derived);
}

// ============== Utility Exports ==============

// formatTimeOfDay now lives in @worldify/shared (single definition); re-exported
// here so existing UI imports (`../game/scene/DayNightCycle`) keep working.
export { formatTimeOfDay } from '@worldify/shared';

/**
 * Get current day phase as readable string.
 */
export function getDayPhaseLabel(time: number): string {
  const phase = getDayPhase(time);
  const labels = {
    night: '🌙 Night',
    sunrise: '🌅 Sunrise',
    day: '☀️ Day',
    sunset: '🌇 Sunset',
  };
  return labels[phase];
}
