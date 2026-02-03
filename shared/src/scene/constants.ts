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

/** Moon light color - soft cool blue */
export const LIGHT_MOON_COLOR = '#aabbdd';

/** Moon intensity at peak - subtle directional, not main light source */
export const LIGHT_MOON_INTENSITY = 0.8;

/** Sun color at different times (interpolated) */
export const SUN_COLOR_NOON = '#fffaf0';     // Warm white at noon
export const SUN_COLOR_GOLDEN = '#ffcc44';   // Golden hour
export const SUN_COLOR_SUNSET = '#ff6633';   // Sunset/sunrise red
export const SUN_COLOR_TWILIGHT = '#334466'; // Twilight blue

/** Sunrise-specific colors (pink/blue morning) */
export const SUN_COLOR_SUNRISE_PINK = '#ffaacc';   // Soft pink dawn
export const SUN_COLOR_SUNRISE_PEACH = '#ffbb88';  // Peach morning

/** Sunset-specific colors (deep orange/purple evening) */
export const SUN_COLOR_SUNSET_DEEP = '#ff4411';    // Deep orange sunset
export const SUN_COLOR_SUNSET_PURPLE = '#993366';  // Purple dusk

/** Ambient color at different times */
export const AMBIENT_COLOR_DAY = '#ffffff';
export const AMBIENT_COLOR_SUNRISE = '#ffeeff';   // Soft pink-tinted morning
export const AMBIENT_COLOR_SUNSET = '#ffccaa';    // Warm orange evening
export const AMBIENT_COLOR_NIGHT = '#334466';

/** Ambient intensity range */
export const AMBIENT_INTENSITY_DAY = 0.5;
export const AMBIENT_INTENSITY_NIGHT = 5.0;

/** Hemisphere light - sky color at different times */
export const HEMISPHERE_SKY_DAY = '#87ceeb';          // Light sky blue
export const HEMISPHERE_SKY_SUNRISE = '#ffccdd';      // Light pink morning
export const HEMISPHERE_SKY_SUNRISE_BLUE = '#aaddff'; // Soft blue morning
export const HEMISPHERE_SKY_SUNSET = '#ff8844';       // Deep orange sunset
export const HEMISPHERE_SKY_SUNSET_PURPLE = '#6644aa';// Purple dusk
export const HEMISPHERE_SKY_NIGHT = '#7799cc';        // Bright moonlit sky (main night fill)

/** Hemisphere light - ground color at different times */
export const HEMISPHERE_GROUND_DAY = '#4a6a4a';       // Green earth
export const HEMISPHERE_GROUND_SUNRISE = '#887766';   // Warm brown morning
export const HEMISPHERE_GROUND_SUNSET = '#553322';    // Deep warm brown
export const HEMISPHERE_GROUND_NIGHT = '#556688';     // Blue-gray ground (bright enough to see)

/** Hemisphere light intensity range (primary fill light) */
export const HEMISPHERE_INTENSITY_DAY = 0.8;
export const HEMISPHERE_INTENSITY_NIGHT = 1.5;    // Main light source at night

/** Environment/IBL intensity range (lower at night since we don't change envmap) */
export const ENVIRONMENT_INTENSITY_DAY = 0.5;
export const ENVIRONMENT_INTENSITY_NIGHT = 0.05;

/** Time thresholds (0-1 normalized) for day phases - longer sunrise/sunset */
export const TIME_SUNRISE_START = 0.15;  // 3:36 AM - early dawn
export const TIME_SUNRISE_END = 0.35;    // 8:24 AM - mid morning
export const TIME_SUNSET_START = 0.65;   // 3:36 PM - afternoon
export const TIME_SUNSET_END = 0.85;     // 8:24 PM - late dusk
