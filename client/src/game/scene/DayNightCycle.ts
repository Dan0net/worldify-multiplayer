/**
 * Day-Night Cycle Controller
 * 
 * Manages time progression and calculates lighting values based on time of day.
 * All state is synced to the Zustand store for UI display and component access.
 * 
 * Features:
 * - Time progression (configurable speed)
 * - Sun position/color/intensity based on solar angle
 * - Moon position/intensity (opposite sun)
 * - Ambient light color/intensity transitions
 * - Individual override toggles for debugging
 */

import { useGameStore, EnvironmentSettings } from '../../state/store';
import {
  SUN_ELEVATION_MIN,
  SUN_ELEVATION_MAX,
  SUN_COLOR_NOON,
  SUN_COLOR_GOLDEN,
  SUN_COLOR_SUNSET,
  SUN_COLOR_TWILIGHT,
  AMBIENT_COLOR_DAY,
  AMBIENT_COLOR_SUNSET,
  AMBIENT_COLOR_NIGHT,
  AMBIENT_INTENSITY_DAY,
  AMBIENT_INTENSITY_NIGHT,
  ENVIRONMENT_INTENSITY_DAY,
  ENVIRONMENT_INTENSITY_NIGHT,
  HEMISPHERE_SKY_DAY,
  HEMISPHERE_SKY_SUNSET,
  HEMISPHERE_SKY_NIGHT,
  HEMISPHERE_GROUND_DAY,
  HEMISPHERE_GROUND_SUNSET,
  HEMISPHERE_GROUND_NIGHT,
  HEMISPHERE_INTENSITY_DAY,
  HEMISPHERE_INTENSITY_NIGHT,
  TIME_SUNRISE_START,
  TIME_SUNRISE_END,
  TIME_SUNSET_START,
  TIME_SUNSET_END,
  LIGHT_SUN_INTENSITY,
  LIGHT_MOON_INTENSITY,
  lerp,
  smoothstep,
  lerpColor,
} from '@worldify/shared';



// ============== Solar Calculations ==============

/**
 * Get sun elevation angle based on time of day.
 * Returns degrees: positive = above horizon, negative = below
 */
function getSunElevation(time: number): number {
  // Time 0.5 = noon (max elevation), 0.0/1.0 = midnight (min elevation)
  // Use cosine for smooth sinusoidal motion
  const angle = (time - 0.5) * Math.PI * 2; // Shift so noon = 0
  const normalized = Math.cos(angle); // -1 at midnight, +1 at noon
  
  // Map to elevation range
  return lerp(SUN_ELEVATION_MIN, SUN_ELEVATION_MAX, (normalized + 1) / 2);
}

/**
 * Get sun azimuth (horizontal angle) based on time.
 * East at sunrise, South at noon, West at sunset
 */
function getSunAzimuth(time: number): number {
  // 0.25 = 6am (east = 90°), 0.5 = noon (south = 180°), 0.75 = 6pm (west = 270°)
  return ((time * 360) + 90) % 360;
}

/**
 * Determine the current phase of day
 */
type DayPhase = 'night' | 'sunrise' | 'day' | 'sunset';

function getDayPhase(time: number): DayPhase {
  if (time < TIME_SUNRISE_START || time >= TIME_SUNSET_END) return 'night';
  if (time < TIME_SUNRISE_END) return 'sunrise';
  if (time < TIME_SUNSET_START) return 'day';
  return 'sunset';
}

/**
 * Get sun color based on elevation/time
 */
function getSunColor(time: number, _elevation: number): string {
  const phase = getDayPhase(time);
  
  switch (phase) {
    case 'night':
      return SUN_COLOR_TWILIGHT;
      
    case 'sunrise': {
      // Transition: twilight → sunset → golden → noon
      const t = smoothstep(TIME_SUNRISE_START, TIME_SUNRISE_END, time);
      if (t < 0.3) {
        return lerpColor(SUN_COLOR_TWILIGHT, SUN_COLOR_SUNSET, t / 0.3);
      } else if (t < 0.7) {
        return lerpColor(SUN_COLOR_SUNSET, SUN_COLOR_GOLDEN, (t - 0.3) / 0.4);
      } else {
        return lerpColor(SUN_COLOR_GOLDEN, SUN_COLOR_NOON, (t - 0.7) / 0.3);
      }
    }
    
    case 'day':
      // Full day is mostly noon color, slight golden tint near edges
      // Start at NOON (matching sunrise end) and stay NOON
      return SUN_COLOR_NOON;
      
    case 'sunset': {
      // Transition: noon → golden → sunset → twilight
      const t = smoothstep(TIME_SUNSET_START, TIME_SUNSET_END, time);
      if (t < 0.3) {
        return lerpColor(SUN_COLOR_NOON, SUN_COLOR_GOLDEN, t / 0.3);
      } else if (t < 0.7) {
        return lerpColor(SUN_COLOR_GOLDEN, SUN_COLOR_SUNSET, (t - 0.3) / 0.4);
      } else {
        return lerpColor(SUN_COLOR_SUNSET, SUN_COLOR_TWILIGHT, (t - 0.7) / 0.3);
      }
    }
  }
}

/**
 * Get sun intensity based on elevation
 */
function getSunIntensity(elevation: number): number {
  if (elevation <= 0) {
    // Below horizon - fade out
    return Math.max(0, lerp(0.2, 0, -elevation / SUN_ELEVATION_MIN));
  } else if (elevation < 20) {
    // Low angle - reduced intensity
    return lerp(0.5, LIGHT_SUN_INTENSITY, elevation / 20);
  }
  // Full intensity above 20°
  return LIGHT_SUN_INTENSITY;
}

/**
 * Get moon intensity based on sun elevation (moon visible when sun is down)
 * Moon starts rising earlier during twilight to prevent dark gaps
 */
function getMoonIntensity(sunElevation: number): number {
  if (sunElevation > 10) {
    // Sun is high - moon is invisible
    return 0;
  } else if (sunElevation > 0) {
    // Sun is low (0-10°) - moon starts to appear
    return lerp(0, LIGHT_MOON_INTENSITY * 0.3, (10 - sunElevation) / 10);
  } else if (sunElevation > -10) {
    // Twilight (-10 to 0°) - moon ramps up
    return lerp(LIGHT_MOON_INTENSITY * 0.3, LIGHT_MOON_INTENSITY, -sunElevation / 10);
  }
  // Full night - full moon intensity
  return LIGHT_MOON_INTENSITY;
}

/**
 * Get ambient light color based on time
 */
function getAmbientColor(time: number): string {
  const phase = getDayPhase(time);
  
  switch (phase) {
    case 'night':
      return AMBIENT_COLOR_NIGHT;
    case 'sunrise': {
      const t = smoothstep(TIME_SUNRISE_START, TIME_SUNRISE_END, time);
      if (t < 0.5) {
        return lerpColor(AMBIENT_COLOR_NIGHT, AMBIENT_COLOR_SUNSET, t * 2);
      }
      return lerpColor(AMBIENT_COLOR_SUNSET, AMBIENT_COLOR_DAY, (t - 0.5) * 2);
    }
    case 'day':
      return AMBIENT_COLOR_DAY;
    case 'sunset': {
      const t = smoothstep(TIME_SUNSET_START, TIME_SUNSET_END, time);
      if (t < 0.5) {
        return lerpColor(AMBIENT_COLOR_DAY, AMBIENT_COLOR_SUNSET, t * 2);
      }
      return lerpColor(AMBIENT_COLOR_SUNSET, AMBIENT_COLOR_NIGHT, (t - 0.5) * 2);
    }
  }
}

/**
 * Get ambient intensity based on time
 */
function getAmbientIntensity(time: number): number {
  const phase = getDayPhase(time);
  
  switch (phase) {
    case 'night':
      return AMBIENT_INTENSITY_NIGHT;
    case 'sunrise': {
      const t = smoothstep(TIME_SUNRISE_START, TIME_SUNRISE_END, time);
      return lerp(AMBIENT_INTENSITY_NIGHT, AMBIENT_INTENSITY_DAY, t);
    }
    case 'day':
      return AMBIENT_INTENSITY_DAY;
    case 'sunset': {
      const t = smoothstep(TIME_SUNSET_START, TIME_SUNSET_END, time);
      return lerp(AMBIENT_INTENSITY_DAY, AMBIENT_INTENSITY_NIGHT, t);
    }
  }
}

/**
 * Get environment/IBL intensity based on time.
 * Lower at night since we don't change the environment map yet.
 */
function getEnvironmentIntensity(time: number): number {
  const phase = getDayPhase(time);
  
  switch (phase) {
    case 'night':
      return ENVIRONMENT_INTENSITY_NIGHT;
    case 'sunrise': {
      const t = smoothstep(TIME_SUNRISE_START, TIME_SUNRISE_END, time);
      return lerp(ENVIRONMENT_INTENSITY_NIGHT, ENVIRONMENT_INTENSITY_DAY, t);
    }
    case 'day':
      return ENVIRONMENT_INTENSITY_DAY;
    case 'sunset': {
      const t = smoothstep(TIME_SUNSET_START, TIME_SUNSET_END, time);
      return lerp(ENVIRONMENT_INTENSITY_DAY, ENVIRONMENT_INTENSITY_NIGHT, t);
    }
  }
}

/**
 * Get hemisphere sky color based on time.
 * Transitions from dark blue at night to warm tones at sunset to light blue during day.
 */
function getHemisphereSkyColor(time: number): string {
  const phase = getDayPhase(time);
  
  switch (phase) {
    case 'night':
      return HEMISPHERE_SKY_NIGHT;
    case 'sunrise': {
      const t = smoothstep(TIME_SUNRISE_START, TIME_SUNRISE_END, time);
      if (t < 0.5) {
        return lerpColor(HEMISPHERE_SKY_NIGHT, HEMISPHERE_SKY_SUNSET, t * 2);
      }
      return lerpColor(HEMISPHERE_SKY_SUNSET, HEMISPHERE_SKY_DAY, (t - 0.5) * 2);
    }
    case 'day':
      return HEMISPHERE_SKY_DAY;
    case 'sunset': {
      const t = smoothstep(TIME_SUNSET_START, TIME_SUNSET_END, time);
      if (t < 0.5) {
        return lerpColor(HEMISPHERE_SKY_DAY, HEMISPHERE_SKY_SUNSET, t * 2);
      }
      return lerpColor(HEMISPHERE_SKY_SUNSET, HEMISPHERE_SKY_NIGHT, (t - 0.5) * 2);
    }
  }
}

/**
 * Get hemisphere ground color based on time.
 * Dark earth tones that shift slightly based on sky color.
 */
function getHemisphereGroundColor(time: number): string {
  const phase = getDayPhase(time);
  
  switch (phase) {
    case 'night':
      return HEMISPHERE_GROUND_NIGHT;
    case 'sunrise': {
      const t = smoothstep(TIME_SUNRISE_START, TIME_SUNRISE_END, time);
      if (t < 0.5) {
        return lerpColor(HEMISPHERE_GROUND_NIGHT, HEMISPHERE_GROUND_SUNSET, t * 2);
      }
      return lerpColor(HEMISPHERE_GROUND_SUNSET, HEMISPHERE_GROUND_DAY, (t - 0.5) * 2);
    }
    case 'day':
      return HEMISPHERE_GROUND_DAY;
    case 'sunset': {
      const t = smoothstep(TIME_SUNSET_START, TIME_SUNSET_END, time);
      if (t < 0.5) {
        return lerpColor(HEMISPHERE_GROUND_DAY, HEMISPHERE_GROUND_SUNSET, t * 2);
      }
      return lerpColor(HEMISPHERE_GROUND_SUNSET, HEMISPHERE_GROUND_NIGHT, (t - 0.5) * 2);
    }
  }
}

/**
 * Get hemisphere light intensity based on time.
 * Never drops below night level - twilight maintains higher intensity.
 */
function getHemisphereIntensity(time: number): number {
  const phase = getDayPhase(time);
  
  // Minimum intensity is night level - we never go darker
  const minIntensity = HEMISPHERE_INTENSITY_NIGHT;
  
  switch (phase) {
    case 'night':
      return HEMISPHERE_INTENSITY_NIGHT;
    case 'sunrise': {
      const t = smoothstep(TIME_SUNRISE_START, TIME_SUNRISE_END, time);
      // Start at night intensity, ramp up to day
      // Use max() to ensure we never dip below night level
      return Math.max(minIntensity, lerp(HEMISPHERE_INTENSITY_NIGHT, HEMISPHERE_INTENSITY_DAY, t));
    }
    case 'day':
      return HEMISPHERE_INTENSITY_DAY;
    case 'sunset': {
      const t = smoothstep(TIME_SUNSET_START, TIME_SUNSET_END, time);
      // Ramp from day to night, never below night level
      return Math.max(minIntensity, lerp(HEMISPHERE_INTENSITY_DAY, HEMISPHERE_INTENSITY_NIGHT, t));
    }
  }
}

// ============== Main Update Function ==============

/**
 * Update the day-night cycle.
 * Call this each frame from the game loop.
 * 
 * @param deltaMs - Time since last frame in milliseconds
 */
export function updateDayNightCycle(deltaMs: number): void {
  const state = useGameStore.getState();
  const env = state.environment;
  
  // Skip if day-night cycle is disabled (default to false if undefined)
  if (!(env.dayNightEnabled ?? false)) return;
  
  // Build updates object
  const updates: Partial<EnvironmentSettings> = {};
  
  // Advance time if speed > 0
  const timeSpeed = env.timeSpeed ?? 0;
  if (timeSpeed > 0) {
    // timeSpeed is in game-minutes per real-second
    // 1 game day = 24 * 60 = 1440 minutes = 1.0 timeOfDay
    const minutesElapsed = timeSpeed * (deltaMs / 1000);
    const dayFraction = minutesElapsed / 1440;
    let newTime = (env.timeOfDay ?? 0.35) + dayFraction;
    
    // Wrap around at midnight
    if (newTime >= 1) newTime -= 1;
    if (newTime < 0) newTime += 1;
    
    updates.timeOfDay = newTime;
  }
  
  // Use current or updated time for calculations
  const time = updates.timeOfDay ?? env.timeOfDay ?? 0.35;
  
  // Calculate sun position
  const sunElevation = getSunElevation(time);
  const sunAzimuth = getSunAzimuth(time);
  
  // Apply auto-calculated values if enabled (default to true)
  if (env.autoSunPosition ?? true) {
    updates.sunAzimuth = sunAzimuth;
    updates.sunElevation = sunElevation;
  }
  
  if (env.autoSunColor ?? true) {
    updates.sunColor = getSunColor(time, sunElevation);
  }
  
  if (env.autoSunIntensity ?? true) {
    updates.sunIntensity = getSunIntensity(sunElevation);
  }
  
  if (env.autoMoonPosition ?? true) {
    // Moon is opposite sun
    updates.moonAzimuth = (sunAzimuth + 180) % 360;
    updates.moonElevation = -sunElevation;
  }
  
  if (env.autoMoonIntensity ?? true) {
    updates.moonIntensity = getMoonIntensity(sunElevation);
  }
  
  if (env.autoAmbientColor ?? true) {
    updates.ambientColor = getAmbientColor(time);
  }
  
  if (env.autoAmbientIntensity ?? true) {
    updates.ambientIntensity = getAmbientIntensity(time);
  }
  
  if (env.autoEnvironmentIntensity ?? true) {
    updates.environmentIntensity = getEnvironmentIntensity(time);
  }
  
  // Hemisphere light (only if enabled)
  if (env.hemisphereEnabled ?? true) {
    if (env.autoHemisphereColors ?? true) {
      updates.hemisphereSkyColor = getHemisphereSkyColor(time);
      updates.hemisphereGroundColor = getHemisphereGroundColor(time);
    }
    
    if (env.autoHemisphereIntensity ?? true) {
      updates.hemisphereIntensity = getHemisphereIntensity(time);
    }
  }
  
  // Apply updates to store if any
  if (Object.keys(updates).length > 0) {
    state.setEnvironment(updates);
  }
}

/**
 * Format time value (0-1) as HH:MM string.
 */
export function formatTimeOfDay(time: number): string {
  const hours = Math.floor(time * 24);
  const minutes = Math.floor((time * 24 - hours) * 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Get current day phase as readable string
 */
export function getDayPhaseLabel(time: number): string {
  const phase = getDayPhase(time);
  switch (phase) {
    case 'night': return '🌙 Night';
    case 'sunrise': return '🌅 Sunrise';
    case 'day': return '☀️ Day';
    case 'sunset': return '🌇 Sunset';
  }
}
