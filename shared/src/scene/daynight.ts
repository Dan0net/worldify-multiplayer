/**
 * Day-Night Cycle Helpers
 *
 * Keyframe-based day-night model. The cycle is defined by an array of keyframes, each with
 * an editable time-of-day and a full appearance palette (sun/moon colour+intensity+size, sky
 * zenith/horizon/ground colours, hemisphere fill). `sampleKeyframes` interpolates the whole
 * palette for any time; sun/moon *position* is a procedural arc (not keyframed) scaled by a
 * global `sunHeight`.
 */

import { smoothstep, lerp, lerpColor } from '../util/math.js';

// ============== Clock ==============

/**
 * Format normalized time (0-1) as an HH:MM clock string.
 */
export function formatTimeOfDay(time: number): string {
  const hours = Math.floor(time * 24);
  const minutes = Math.floor((time * 24 - hours) * 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Coarse label for the debug readout, from fixed time windows. Purely cosmetic — the real
 * look is defined by the (editable) keyframes, not these windows.
 */
export function getDayPhaseLabel(time: number): string {
  const t = ((time % 1) + 1) % 1;
  if (t < 0.2 || t >= 0.8) return '🌙 Night';
  if (t < 0.35) return '🌅 Sunrise';
  if (t < 0.65) return '☀️ Day';
  return '🌇 Sunset';
}

// ============== Keyframes ==============

/** A single day-night keyframe: a time-of-day plus the full appearance palette at that time. */
export interface DayNightKeyframe {
  name: string;                // 'Night' | 'Sunrise' | 'Day' | 'Sunset' (label only)
  time: number;                // 0..1 (editable timing)
  sunColor: string; sunIntensity: number; sunSize: number;
  moonColor: string; moonIntensity: number; moonSize: number;
  skyZenithColor: string;      // top of the sky gradient (also drives the hemisphere sky colour)
  skyHorizonColor: string;     // horizon band (authored, not derived)
  groundColor: string;         // below-horizon / hemisphere ground colour
  hemisphereIntensity: number;
}

/** The interpolated palette (a keyframe without its name/time). */
export type SampledKeyframe = Omit<DayNightKeyframe, 'name' | 'time'>;

/**
 * Interpolate the keyframe palette at `time` (0..1). Keyframes may be in any order and at any
 * times — a sorted copy is taken each call and bracketing wraps across the 1.0/0.0 seam.
 */
export function sampleKeyframes(keyframes: DayNightKeyframe[], time: number): SampledKeyframe {
  const ks = keyframes.slice().sort((a, b) => a.time - b.time);
  const n = ks.length;
  const T = ((time % 1) + 1) % 1;

  // Bracket: `lo` = last keyframe at or before T (else the last one, wrapping); `hi` = next.
  let lo = n - 1;
  for (let i = 0; i < n; i++) {
    if (ks[i].time <= T) lo = i;
    else break;
  }
  const hi = (lo + 1) % n;
  const a = ks[lo], b = ks[hi];

  let gap = b.time - a.time;
  if (gap <= 0) gap += 1;              // wrap segment across the 1.0 seam
  let local = T - a.time;
  if (local < 0) local += 1;
  const t = gap < 1e-6 ? 0 : Math.min(1, Math.max(0, local / gap));
  const s = smoothstep(0, 1, t);

  return {
    sunColor: lerpColor(a.sunColor, b.sunColor, s),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, s),
    sunSize: lerp(a.sunSize, b.sunSize, s),
    moonColor: lerpColor(a.moonColor, b.moonColor, s),
    moonIntensity: lerp(a.moonIntensity, b.moonIntensity, s),
    moonSize: lerp(a.moonSize, b.moonSize, s),
    skyZenithColor: lerpColor(a.skyZenithColor, b.skyZenithColor, s),
    skyHorizonColor: lerpColor(a.skyHorizonColor, b.skyHorizonColor, s),
    groundColor: lerpColor(a.groundColor, b.groundColor, s),
    hemisphereIntensity: lerp(a.hemisphereIntensity, b.hemisphereIntensity, s),
  };
}

// ============== Position arc (procedural, not keyframed) ==============

/**
 * Sun elevation (degrees) for a time of day. Noon (0.5) → +sunHeight, midnight → −sunHeight.
 */
export function getSunElevation(time: number, sunHeight: number): number {
  return sunHeight * Math.cos((time - 0.5) * Math.PI * 2);
}

/**
 * Sun azimuth (degrees) for a time of day.
 */
export function getSunAzimuth(time: number): number {
  return ((time * 360) + 90) % 360;
}

// ============== Derived lighting ==============

/**
 * The full set of derived lighting values for a time of day: the interpolated palette plus
 * the procedural sun/moon positions. Applied straight to the scene lights + sky by the client.
 */
export interface DerivedLighting extends SampledKeyframe {
  sunAzimuth: number; sunElevation: number;
  moonAzimuth: number; moonElevation: number;
  sunDistance: number;
}

/**
 * Derive the complete lighting state for `time` from the keyframes + global arc params.
 * Moon is antipodal to the sun. Shared so both the per-frame cycle and the initial seed use
 * one code path.
 */
export function deriveLighting(
  keyframes: DayNightKeyframe[], time: number, sunHeight: number, sunDistance: number
): DerivedLighting {
  const palette = sampleKeyframes(keyframes, time);
  const sunElevation = getSunElevation(time, sunHeight);
  const sunAzimuth = getSunAzimuth(time);
  return {
    ...palette,
    sunAzimuth, sunElevation,
    moonAzimuth: (sunAzimuth + 180) % 360,
    moonElevation: -sunElevation,
    sunDistance,
  };
}
