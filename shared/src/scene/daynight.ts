/**
 * Day-Night Cycle Helpers
 *
 * Keyframe-based day-night model. Four palette keyframes (Night, Sunrise, Day, Sunset) define
 * colours; sun/moon size + intensity + arc are GLOBAL. Timing is a phase-window model: day and
 * night hold flat, with short sunrise/sunset transitions. The sun/moon position arc is reshaped
 * to the day length (so the sun physically rises/sets at the transition centres), and intensity
 * is gated by elevation (0 below the horizon).
 *
 * `deriveLighting(cfg, time)` is the SINGLE source of all lighting math — every consumer
 * (Lighting, SkyDome, effects, shadows) reads its `DerivedLighting` output rather than recomputing
 * positions/intensities, so the signals can never drift apart.
 */

import { smoothstep, lerp, lerpColor, clamp } from '../util/math.js';

// ============== Clock ==============

/** Format normalized time (0-1) as an HH:MM clock string. */
export function formatTimeOfDay(time: number): string {
  const hours = Math.floor(time * 24);
  const minutes = Math.floor((time * 24 - hours) * 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/** Coarse label for the debug readout (cosmetic). */
export function getDayPhaseLabel(time: number): string {
  const t = ((time % 1) + 1) % 1;
  if (t < 0.2 || t >= 0.8) return '🌙 Night';
  if (t < 0.35) return '🌅 Sunrise';
  if (t < 0.65) return '☀️ Day';
  return '🌇 Sunset';
}

// ============== Config types ==============

/** A palette keyframe: the colours + fill at one phase (Night, Sunrise, Day, Sunset). */
export interface DayNightKeyframe {
  name: string;
  sunColor: string;
  moonColor: string;
  skyZenithColor: string;   // top of sky gradient (also the hemisphere sky colour)
  skyHorizonColor: string;  // authored horizon band
  groundColor: string;      // below-horizon / hemisphere ground colour
  hemisphereIntensity: number;
}

/** The interpolated palette (a keyframe without its name). */
export type SampledKeyframe = Omit<DayNightKeyframe, 'name'>;

/**
 * Full day-night configuration. Sun/moon appearance + arc are global; timing is four transition
 * boundaries; `keyframes` are the four phase palettes in fixed order [Night, Sunrise, Day, Sunset].
 */
export interface DayNightConfig {
  sunHeight: number; sunDistance: number; sunSize: number; sunIntensity: number;
  moonHeight: number; moonDistance: number; moonSize: number; moonIntensity: number;
  sunriseStart: number; sunriseEnd: number;   // dawn transition window (0..1)
  sunsetStart: number; sunsetEnd: number;      // dusk transition window (0..1)
  twilightAngle: number;                       // ± elevation band (deg) for the light fade / hand-off overlap
  keyframes: DayNightKeyframe[];               // [Night, Sunrise, Day, Sunset]
}

// The elevation intensity gate spans ±`cfg.twilightAngle` around the horizon. It starts BELOW the
// horizon so a body grazing it still lights the scene (civil twilight) — at elevation 0 each gives
// ~50%, so the antipodal sun↔moon hand-off overlaps instead of going dark. Larger angle = longer,
// softer twilight. Well below the band intensity is still 0 (no "sun lights from under the ground").

/**
 * Clamp the window times into [0, 1) and enforce sunriseStart < sunriseEnd < sunsetStart < sunsetEnd
 * (with a minimum gap), so the phase-window model can never be put in an impossible state. Returns a
 * new config; leaves palettes + globals untouched.
 */
export function normalizeDayNightConfig(cfg: DayNightConfig): DayNightConfig {
  const EPS = 0.001;
  let a = clamp(cfg.sunriseStart, 0, 1 - 4 * EPS);
  let b = clamp(cfg.sunriseEnd, a + EPS, 1 - 3 * EPS);
  let c = clamp(cfg.sunsetStart, b + EPS, 1 - 2 * EPS);
  let d = clamp(cfg.sunsetEnd, c + EPS, 1 - EPS);
  return { ...cfg, sunriseStart: a, sunriseEnd: b, sunsetStart: c, sunsetEnd: d };
}

// ============== Palette sampling (phase windows with holds) ==============

function blend(a: DayNightKeyframe, b: DayNightKeyframe, s: number): SampledKeyframe {
  return {
    sunColor: lerpColor(a.sunColor, b.sunColor, s),
    moonColor: lerpColor(a.moonColor, b.moonColor, s),
    skyZenithColor: lerpColor(a.skyZenithColor, b.skyZenithColor, s),
    skyHorizonColor: lerpColor(a.skyHorizonColor, b.skyHorizonColor, s),
    groundColor: lerpColor(a.groundColor, b.groundColor, s),
    hemisphereIntensity: lerp(a.hemisphereIntensity, b.hemisphereIntensity, s),
  };
}

/**
 * Interpolate the palette at `time`. Day and night hold their palette flat; sunrise/sunset are
 * short transitions that pass through the Sunrise/Sunset palette at their centre.
 */
export function sampleKeyframes(cfg: DayNightConfig, time: number): SampledKeyframe {
  const T = ((time % 1) + 1) % 1;
  const [night, sunrise, day, sunset] = cfg.keyframes;
  const { sunriseStart: a, sunriseEnd: b, sunsetStart: c, sunsetEnd: d } = cfg;

  if (T >= b && T < c) return blend(day, day, 0);            // day hold
  if (T >= a && T < b) {                                     // sunrise: Night→Sunrise→Day
    const u = (T - a) / (b - a);
    return u < 0.5 ? blend(night, sunrise, smoothstep(0, 1, u * 2))
                   : blend(sunrise, day, smoothstep(0, 1, (u - 0.5) * 2));
  }
  if (T >= c && T < d) {                                     // sunset: Day→Sunset→Night
    const u = (T - c) / (d - c);
    return u < 0.5 ? blend(day, sunset, smoothstep(0, 1, u * 2))
                   : blend(sunset, night, smoothstep(0, 1, (u - 0.5) * 2));
  }
  return blend(night, night, 0);                            // night hold (T>=d or T<a)
}

// ============== Position arc (day-length aware) ==============

function windowMids(cfg: DayNightConfig): { srMid: number; ssMid: number } {
  return { srMid: (cfg.sunriseStart + cfg.sunriseEnd) / 2, ssMid: (cfg.sunsetStart + cfg.sunsetEnd) / 2 };
}

/** Sun elevation (deg): a half-sine hump over daylight [srMid, ssMid], negative at night. */
export function getSunElevation(cfg: DayNightConfig, time: number): number {
  const T = ((time % 1) + 1) % 1;
  const { srMid, ssMid } = windowMids(cfg);
  if (T >= srMid && T < ssMid) {
    return cfg.sunHeight * Math.sin(Math.PI * (T - srMid) / (ssMid - srMid));
  }
  const nightLen = (1 + srMid) - ssMid;
  const tn = ((((T - ssMid) % 1) + 1) % 1) / nightLen;
  return -cfg.sunHeight * Math.sin(Math.PI * tn);
}

/** Moon elevation (deg): up at night (own height), below the horizon during the day. */
export function getMoonElevation(cfg: DayNightConfig, time: number): number {
  const T = ((time % 1) + 1) % 1;
  const { srMid, ssMid } = windowMids(cfg);
  if (T >= srMid && T < ssMid) {
    return -cfg.moonHeight * Math.sin(Math.PI * (T - srMid) / (ssMid - srMid));
  }
  const nightLen = (1 + srMid) - ssMid;
  const tn = ((((T - ssMid) % 1) + 1) % 1) / nightLen;
  return cfg.moonHeight * Math.sin(Math.PI * tn);
}

/** Sun azimuth (deg). */
export function getSunAzimuth(time: number): number {
  return ((time * 360) + 90) % 360;
}

// ============== Derived lighting ==============

/** Complete derived lighting for a time of day: palette + positions + effective intensities. */
export interface DerivedLighting extends SampledKeyframe {
  sunAzimuth: number; sunElevation: number;
  moonAzimuth: number; moonElevation: number;
  sunIntensity: number; moonIntensity: number;   // elevation-gated (0 below horizon)
  sunSize: number; moonSize: number;
  sunDistance: number; moonDistance: number;
  time: number;        // normalized 0..1 (for star rotation)
  moonHeight: number;  // for the star-field celestial tilt
}

/** Derive the complete lighting state for `time`. */
export function deriveLighting(cfg: DayNightConfig, time: number): DerivedLighting {
  const T = ((time % 1) + 1) % 1;
  const palette = sampleKeyframes(cfg, T);
  const sunElevation = getSunElevation(cfg, T);
  const moonElevation = getMoonElevation(cfg, T);
  const sunAzimuth = getSunAzimuth(T);
  const tw = Math.max(0.5, cfg.twilightAngle);
  return {
    ...palette,
    sunAzimuth, sunElevation,
    moonAzimuth: (sunAzimuth + 180) % 360, moonElevation,
    sunIntensity: cfg.sunIntensity * smoothstep(-tw, tw, sunElevation),
    moonIntensity: cfg.moonIntensity * smoothstep(-tw, tw, moonElevation),
    sunSize: cfg.sunSize, moonSize: cfg.moonSize,
    sunDistance: cfg.sunDistance, moonDistance: cfg.moonDistance,
    time: T, moonHeight: cfg.moonHeight,
  };
}
