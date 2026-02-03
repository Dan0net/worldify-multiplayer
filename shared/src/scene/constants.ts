/**
 * Shared Scene Constants
 * 
 * Single source of truth for material and lighting defaults.
 * Used by both game client and pallet viewer for consistent rendering.
 */

// ============== Material Shader Defaults ==============

/** Default roughness multiplier - applied to roughness texture values */
export const MATERIAL_ROUGHNESS_MULTIPLIER = 1.0;

/** Default metalness multiplier - applied to metalness texture values */
export const MATERIAL_METALNESS_MULTIPLIER = 1.0;

/** Default AO intensity - 0 = no AO effect, 1 = full effect */
export const MATERIAL_AO_INTENSITY = 1.0;

/** Default normal map strength - multiplied with normal map values */
export const MATERIAL_NORMAL_STRENGTH = 1.0;

// ============== Lighting Defaults ==============

/** Ambient light color (hex) */
export const LIGHT_AMBIENT_COLOR = '#ffffff';

/** Ambient light intensity */
export const LIGHT_AMBIENT_INTENSITY = 0.4;

/** Sun light color - warm sunset yellow */
export const LIGHT_SUN_COLOR = '#ffcc00';

/** Main directional light (sun) intensity */
export const LIGHT_SUN_INTENSITY = 3.0;

// ============== Environment/IBL Defaults ==============

/** Environment map intensity for IBL reflections - lower = less washed out colors */
export const ENVIRONMENT_INTENSITY = 0.5;

/** Default skybox preset */
export const DEFAULT_SKYBOX = 'forest';

// ============== Placeholder Texture Defaults ==============
// Values for generated textures when no source texture exists

/** Default AO value (255 = no occlusion, white) */
export const PLACEHOLDER_AO = 255;

/** Default roughness value (200/255 ≈ 0.78 = fairly rough) */
export const PLACEHOLDER_ROUGHNESS = 200;

/** Default metalness value (0 = non-metallic) */
export const PLACEHOLDER_METALNESS = 0;

/** Default normal map color (flat normal pointing up: RGB 128, 128, 255) */
export const PLACEHOLDER_NORMAL = { r: 128, g: 128, b: 255 };

// ============== Day-Night Cycle Defaults ==============

/** Default time of day (0-1, 0.35 = ~8:30am morning light) */
export const DEFAULT_TIME_OF_DAY = 0.35;

/** Default time speed in game-minutes per real-second (0 = paused) */
export const DEFAULT_TIME_SPEED = 0;

/** Sun orbital elevation range (degrees) */
export const SUN_ELEVATION_MIN = -20; // Below horizon at midnight
export const SUN_ELEVATION_MAX = 70;  // Max altitude at noon

/** Sun distance from origin for light positioning */
export const SUN_DISTANCE = 150;

/** Moon light color - cool blue-white */
export const LIGHT_MOON_COLOR = '#6891e3';

/** Moon intensity at peak (when sun is fully down) */
export const LIGHT_MOON_INTENSITY = 4.0;

/** Sun color at different times (interpolated) */
export const SUN_COLOR_NOON = '#fffaf0';     // Warm white at noon
export const SUN_COLOR_GOLDEN = '#ffcc44';   // Golden hour
export const SUN_COLOR_SUNSET = '#ff6633';   // Sunset/sunrise red
export const SUN_COLOR_TWILIGHT = '#334466'; // Twilight blue

/** Ambient color at different times */
export const AMBIENT_COLOR_DAY = '#ffffff';
export const AMBIENT_COLOR_SUNSET = '#ffddcc';
export const AMBIENT_COLOR_NIGHT = '#334466';

/** Ambient intensity range */
export const AMBIENT_INTENSITY_DAY = 0.5;
export const AMBIENT_INTENSITY_NIGHT = 5.0;

/** Hemisphere light - sky color at different times */
export const HEMISPHERE_SKY_DAY = '#87ceeb';      // Light sky blue
export const HEMISPHERE_SKY_SUNSET = '#ff9966';   // Warm orange
export const HEMISPHERE_SKY_NIGHT = '#1a1a2e';    // Dark blue

/** Hemisphere light - ground color at different times */
export const HEMISPHERE_GROUND_DAY = '#3d5c3d';   // Dark green (earth)
export const HEMISPHERE_GROUND_SUNSET = '#2d1f1f'; // Dark reddish brown
export const HEMISPHERE_GROUND_NIGHT = '#0a0a0f'; // Near black

/** Hemisphere light intensity range (replaces ambient light) */
export const HEMISPHERE_INTENSITY_DAY = 1.0;
export const HEMISPHERE_INTENSITY_NIGHT = 0.4;

/** Environment/IBL intensity range (lower at night since we don't change envmap) */
export const ENVIRONMENT_INTENSITY_DAY = 0.5;
export const ENVIRONMENT_INTENSITY_NIGHT = 0.05;

/** Time thresholds (0-1 normalized) for day phases */
export const TIME_SUNRISE_START = 0.2;   // 4:48 AM
export const TIME_SUNRISE_END = 0.3;     // 7:12 AM
export const TIME_SUNSET_START = 0.7;    // 4:48 PM
export const TIME_SUNSET_END = 0.8;      // 7:12 PM
