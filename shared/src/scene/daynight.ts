/**
 * Day-Night Cycle Helpers
 * 
 * DRY utilities for interpolating values based on time of day.
 * Used by client's DayNightCycle controller.
 */

import {
  TIME_SUNRISE_START,
  TIME_SUNRISE_END,
  TIME_SUNSET_START,
  TIME_SUNSET_END,
} from './constants.js';
import { smoothstep, lerp, lerpColor } from '../util/math.js';

// ============== Day Phase ==============

export type DayPhase = 'night' | 'sunrise' | 'day' | 'sunset';

/**
 * Determine the current phase of day from normalized time (0-1).
 */
export function getDayPhase(time: number): DayPhase {
  if (time < TIME_SUNRISE_START || time >= TIME_SUNSET_END) return 'night';
  if (time < TIME_SUNRISE_END) return 'sunrise';
  if (time < TIME_SUNSET_START) return 'day';
  return 'sunset';
}

/**
 * Get the transition progress (0-1) within the current phase.
 * Returns 0 for night/day phases (no transition).
 */
export function getPhaseProgress(time: number): number {
  const phase = getDayPhase(time);
  if (phase === 'sunrise') {
    return smoothstep(TIME_SUNRISE_START, TIME_SUNRISE_END, time);
  }
  if (phase === 'sunset') {
    return smoothstep(TIME_SUNSET_START, TIME_SUNSET_END, time);
  }
  return 0;
}

// ============== Generic Phase Interpolation ==============

/**
 * Get a numeric value that transitions between day and night values.
 * Handles all 4 phases with smooth interpolation.
 */
export function getPhaseValue(
  time: number,
  dayValue: number,
  nightValue: number
): number {
  const phase = getDayPhase(time);
  const t = getPhaseProgress(time);
  
  switch (phase) {
    case 'night': return nightValue;
    case 'day': return dayValue;
    case 'sunrise': return lerp(nightValue, dayValue, t);
    case 'sunset': return lerp(dayValue, nightValue, t);
  }
}

/**
 * Get a color that transitions through a midpoint color during sunrise/sunset.
 * Pattern: night ↔ transition ↔ day
 */
export function getPhaseColor(
  time: number,
  dayColor: string,
  nightColor: string,
  sunriseColor: string,
  sunsetColor: string
): string {
  const phase = getDayPhase(time);
  const t = getPhaseProgress(time);
  
  switch (phase) {
    case 'night': return nightColor;
    case 'day': return dayColor;
    case 'sunrise':
      // night → sunrise → day
      return t < 0.5
        ? lerpColor(nightColor, sunriseColor, t * 2)
        : lerpColor(sunriseColor, dayColor, (t - 0.5) * 2);
    case 'sunset':
      // day → sunset → night
      return t < 0.5
        ? lerpColor(dayColor, sunsetColor, t * 2)
        : lerpColor(sunsetColor, nightColor, (t - 0.5) * 2);
  }
}

// ============== Multi-Stop Gradient ==============

/** A gradient stop: [position 0-1, color] */
export type ColorStop = [number, string];

/**
 * Interpolate through a multi-stop color gradient.
 * Gradient is an array of [t, color] pairs where t is 0-1.
 */
export function lerpColorGradient(t: number, gradient: ColorStop[]): string {
  if (gradient.length === 0) return '#000000';
  if (gradient.length === 1) return gradient[0][1];
  
  // Clamp t to valid range
  t = Math.max(0, Math.min(1, t));
  
  // Find the two stops to interpolate between
  for (let i = 0; i < gradient.length - 1; i++) {
    const [t0, c0] = gradient[i];
    const [t1, c1] = gradient[i + 1];
    
    if (t >= t0 && t <= t1) {
      // Normalize t to this segment
      const segmentT = (t - t0) / (t1 - t0);
      return lerpColor(c0, c1, segmentT);
    }
  }
  
  // Fallback to last color
  return gradient[gradient.length - 1][1];
}

/**
 * Get a color using gradients for sunrise/sunset, with static day/night values.
 */
export function getPhaseColorGradient(
  time: number,
  dayColor: string,
  nightColor: string,
  sunriseGradient: ColorStop[],
  sunsetGradient: ColorStop[]
): string {
  const phase = getDayPhase(time);
  const t = getPhaseProgress(time);
  
  switch (phase) {
    case 'night': return nightColor;
    case 'day': return dayColor;
    case 'sunrise': return lerpColorGradient(t, sunriseGradient);
    case 'sunset': return lerpColorGradient(t, sunsetGradient);
  }
}
