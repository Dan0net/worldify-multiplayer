/**
 * Day-Night Cycle Controller
 * 
 * Manages time progression and calculates lighting values based on time of day.
 * All state is synced to the Zustand store for UI display and component access.
 */

import { useGameStore, EnvironmentSettings } from '../../state/store';
import { updateShadowCaster, applyEnvironmentSettings } from './Lighting';
import {
  // Solar
  SUN_ELEVATION_MIN,
  SUN_ELEVATION_MAX,
  SUN_COLOR_NOON,
  SUN_COLOR_TWILIGHT,
  LIGHT_SUN_INTENSITY,
  LIGHT_MOON_INTENSITY,
  SUN_GRADIENT_SUNRISE,
  SUN_GRADIENT_SUNSET,
  // Moon thresholds
  MOON_THRESHOLD_INVISIBLE,
  MOON_THRESHOLD_FAINT,
  MOON_THRESHOLD_RISING,
  MOON_THRESHOLD_FULL,
  // Environment
  ENVIRONMENT_INTENSITY_DAY,
  ENVIRONMENT_INTENSITY_NIGHT,
  // Hemisphere
  HEMISPHERE_SKY_DAY,
  HEMISPHERE_SKY_NIGHT,
  HEMISPHERE_SKY_GRADIENT_SUNRISE,
  HEMISPHERE_SKY_GRADIENT_SUNSET,
  HEMISPHERE_GROUND_DAY,
  HEMISPHERE_GROUND_SUNRISE,
  HEMISPHERE_GROUND_SUNSET,
  HEMISPHERE_GROUND_NIGHT,
  HEMISPHERE_INTENSITY_DAY,
  HEMISPHERE_INTENSITY_NIGHT,
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
 * Get sun color using multi-stop gradients for rich sunrise/sunset.
 */
function getSunColor(time: number): string {
  return getPhaseColorGradient(
    time,
    SUN_COLOR_NOON,
    SUN_COLOR_TWILIGHT,
    SUN_GRADIENT_SUNRISE,
    SUN_GRADIENT_SUNSET
  );
}

/**
 * Get sun intensity based on elevation.
 */
function getSunIntensity(elevation: number): number {
  if (elevation <= 0) {
    // Below horizon - fade out
    return Math.max(0, lerp(0.2, 0, -elevation / SUN_ELEVATION_MIN));
  }
  if (elevation < 20) {
    // Low angle - reduced intensity
    return lerp(0.5, LIGHT_SUN_INTENSITY, elevation / 20);
  }
  return LIGHT_SUN_INTENSITY;
}

/**
 * Get moon intensity based on sun elevation.
 * Moon starts early and overlaps with sun for smooth handoff.
 */
function getMoonIntensity(sunElevation: number): number {
  if (sunElevation > MOON_THRESHOLD_INVISIBLE) return 0;
  
  if (sunElevation > MOON_THRESHOLD_FAINT) {
    // Sun 25-45° - moon starts faintly
    const t = (MOON_THRESHOLD_INVISIBLE - sunElevation) / (MOON_THRESHOLD_INVISIBLE - MOON_THRESHOLD_FAINT);
    return lerp(0, LIGHT_MOON_INTENSITY * 0.3, t);
  }
  
  if (sunElevation > MOON_THRESHOLD_RISING) {
    // Sun 10-25° - moon ramping
    const t = (MOON_THRESHOLD_FAINT - sunElevation) / (MOON_THRESHOLD_FAINT - MOON_THRESHOLD_RISING);
    return lerp(LIGHT_MOON_INTENSITY * 0.3, LIGHT_MOON_INTENSITY * 0.6, t);
  }
  
  if (sunElevation > MOON_THRESHOLD_FULL) {
    // Sun -5 to 10° - final ramp
    const t = (MOON_THRESHOLD_RISING - sunElevation) / (MOON_THRESHOLD_RISING - MOON_THRESHOLD_FULL);
    return lerp(LIGHT_MOON_INTENSITY * 0.6, LIGHT_MOON_INTENSITY, t);
  }
  
  return LIGHT_MOON_INTENSITY;
}

// ============== Main Update Function ==============

/**
 * Update the day-night cycle. Call each frame.
 */
export function updateDayNightCycle(deltaMs: number): void {
  const state = useGameStore.getState();
  const env = state.environment;

  if (!(env.dayNightEnabled ?? false)) return;

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
  const sunAzimuth = getSunAzimuth(time);

  // Derived lighting *outputs*. These are applied DIRECTLY to the lights + sky
  // (never written back to the store) — this is what removes the per-frame
  // round-trip. Fields whose auto-flag is off are left untouched, so manual
  // overrides (applied on-change by the debug panel) persist.
  const derived: Partial<EnvironmentSettings> = {};

  if (env.autoSunPosition ?? true) {
    derived.sunAzimuth = sunAzimuth;
    derived.sunElevation = sunElevation;
  }
  if (env.autoSunColor ?? true) {
    derived.sunColor = getSunColor(time);
  }
  if (env.autoSunIntensity ?? true) {
    derived.sunIntensity = getSunIntensity(sunElevation);
  }

  if (env.autoMoonPosition ?? true) {
    derived.moonAzimuth = (sunAzimuth + 180) % 360;
    derived.moonElevation = -sunElevation;
  }
  if (env.autoMoonIntensity ?? true) {
    derived.moonIntensity = getMoonIntensity(sunElevation);
  }

  // Update which light casts shadows based on current intensities
  const effectiveSunIntensity = derived.sunIntensity ?? env.sunIntensity ?? 3.0;
  const effectiveMoonIntensity = derived.moonIntensity ?? env.moonIntensity ?? 0.3;
  updateShadowCaster(effectiveSunIntensity, effectiveMoonIntensity);

  if (env.autoEnvironmentIntensity ?? true) {
    derived.environmentIntensity = getPhaseValue(time, ENVIRONMENT_INTENSITY_DAY, ENVIRONMENT_INTENSITY_NIGHT);
  }

  if (env.hemisphereEnabled ?? true) {
    if (env.autoHemisphereColors ?? true) {
      derived.hemisphereSkyColor = getPhaseColorGradient(
        time, HEMISPHERE_SKY_DAY, HEMISPHERE_SKY_NIGHT,
        HEMISPHERE_SKY_GRADIENT_SUNRISE, HEMISPHERE_SKY_GRADIENT_SUNSET
      );
      derived.hemisphereGroundColor = getPhaseColor(
        time, HEMISPHERE_GROUND_DAY, HEMISPHERE_GROUND_NIGHT,
        HEMISPHERE_GROUND_SUNRISE, HEMISPHERE_GROUND_SUNSET
      );
    }
    if (env.autoHemisphereIntensity ?? true) {
      derived.hemisphereIntensity = getPhaseValue(time, HEMISPHERE_INTENSITY_DAY, HEMISPHERE_INTENSITY_NIGHT);
    }
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
