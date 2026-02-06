/**
 * Day-Night Cycle Controller
 * 
 * Manages time progression and calculates lighting values based on time of day.
 * All state is synced to the Zustand store for UI display and component access.
 */

import { useGameStore, EnvironmentSettings } from '../../state/store';
import { updateShadowCaster } from './Lighting';
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
  // Ambient
  AMBIENT_COLOR_DAY,
  AMBIENT_COLOR_SUNRISE,
  AMBIENT_COLOR_SUNSET,
  AMBIENT_COLOR_NIGHT,
  AMBIENT_INTENSITY_DAY,
  AMBIENT_INTENSITY_NIGHT,
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
  
  const updates: Partial<EnvironmentSettings> = {};
  
  // Advance time
  const timeSpeed = env.timeSpeed ?? 0;
  if (timeSpeed > 0) {
    const minutesElapsed = timeSpeed * (deltaMs / 1000);
    let newTime = (env.timeOfDay ?? 0.35) + minutesElapsed / 1440;
    if (newTime >= 1) newTime -= 1;
    if (newTime < 0) newTime += 1;
    updates.timeOfDay = newTime;
  }
  
  const time = updates.timeOfDay ?? env.timeOfDay ?? 0.35;
  const sunElevation = getSunElevation(time);
  const sunAzimuth = getSunAzimuth(time);
  
  // Sun
  if (env.autoSunPosition ?? true) {
    updates.sunAzimuth = sunAzimuth;
    updates.sunElevation = sunElevation;
  }
  if (env.autoSunColor ?? true) {
    updates.sunColor = getSunColor(time);
  }
  if (env.autoSunIntensity ?? true) {
    updates.sunIntensity = getSunIntensity(sunElevation);
  }
  
  // Moon (opposite sun)
  if (env.autoMoonPosition ?? true) {
    updates.moonAzimuth = (sunAzimuth + 180) % 360;
    updates.moonElevation = -sunElevation;
  }
  if (env.autoMoonIntensity ?? true) {
    updates.moonIntensity = getMoonIntensity(sunElevation);
  }
  
  // Update which light casts shadows based on current intensities
  const effectiveSunIntensity = updates.sunIntensity ?? env.sunIntensity ?? 3.0;
  const effectiveMoonIntensity = updates.moonIntensity ?? env.moonIntensity ?? 0.3;
  updateShadowCaster(effectiveSunIntensity, effectiveMoonIntensity);
  
  // Ambient - simple day/night with midpoint color
  if (env.autoAmbientColor ?? true) {
    updates.ambientColor = getPhaseColor(
      time, AMBIENT_COLOR_DAY, AMBIENT_COLOR_NIGHT,
      AMBIENT_COLOR_SUNRISE, AMBIENT_COLOR_SUNSET
    );
  }
  if (env.autoAmbientIntensity ?? true) {
    updates.ambientIntensity = getPhaseValue(time, AMBIENT_INTENSITY_DAY, AMBIENT_INTENSITY_NIGHT);
  }
  
  // Environment intensity
  if (env.autoEnvironmentIntensity ?? true) {
    updates.environmentIntensity = getPhaseValue(time, ENVIRONMENT_INTENSITY_DAY, ENVIRONMENT_INTENSITY_NIGHT);
  }
  
  // Hemisphere light
  if (env.hemisphereEnabled ?? true) {
    if (env.autoHemisphereColors ?? true) {
      updates.hemisphereSkyColor = getPhaseColorGradient(
        time, HEMISPHERE_SKY_DAY, HEMISPHERE_SKY_NIGHT,
        HEMISPHERE_SKY_GRADIENT_SUNRISE, HEMISPHERE_SKY_GRADIENT_SUNSET
      );
      updates.hemisphereGroundColor = getPhaseColor(
        time, HEMISPHERE_GROUND_DAY, HEMISPHERE_GROUND_NIGHT,
        HEMISPHERE_GROUND_SUNRISE, HEMISPHERE_GROUND_SUNSET
      );
    }
    if (env.autoHemisphereIntensity ?? true) {
      updates.hemisphereIntensity = getPhaseValue(time, HEMISPHERE_INTENSITY_DAY, HEMISPHERE_INTENSITY_NIGHT);
    }
  }
  
  if (Object.keys(updates).length > 0) {
    state.setEnvironment(updates);
  }
}

// ============== Utility Exports ==============

/**
 * Format time value (0-1) as HH:MM string.
 */
export function formatTimeOfDay(time: number): string {
  const hours = Math.floor(time * 24);
  const minutes = Math.floor((time * 24 - hours) * 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

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
