/**
 * Physics constants shared between client and server
 * 
 * IMPORTANT: All physics-related values must be defined here to ensure
 * client/server consistency and prevent desync bugs.
 */

// ============== Player Movement ==============

/** Base movement speed in meters per second */
export const MOVE_SPEED = 6.0;

/** How fast the movement direction rotates toward the target (radians/sec for exponential smoothing) */
export const DIRECTION_SMOOTH_SPEED = 24;

/** Multiplier applied when sprinting */
export const SPRINT_MULTIPLIER = 1.6;

/** Jump impulse velocity in m/s */
export const JUMP_VELOCITY = 15.0;

// ============== Player Physics ==============

/** Gravity acceleration in m/s² (negative = downward) */
export const GRAVITY = -40.0;

/** Number of physics sub-steps per frame for stability */
export const PHYSICS_STEPS = 5;

// ============== Player Dimensions ==============

/** Total height from feet to eyes in meters */
export const PLAYER_HEIGHT = 1.6;

/** Collision capsule radius in meters */
export const PLAYER_RADIUS = 0.25;

/** Height of capsule line segment (total height minus end caps) */
export const PLAYER_HEIGHT_INNER = PLAYER_HEIGHT - PLAYER_RADIUS * 2;

/** Ground level Y coordinate */
export const GROUND_LEVEL = 0;

// ============== Jump Assist ==============

/** Time after leaving ground where jump is still allowed (seconds) */
export const COYOTE_TIME = 0.15;

/** Time before landing where a jump input is remembered and applied on land (seconds) */
export const JUMP_BUFFER_TIME = 0.1;

// ============== Fall Detection ==============

/** Maximum continuous fall time before triggering respawn (seconds) */
export const MAX_FALL_TIME = 5.0;

// ============== Spawn Constants ==============

/** Height offset above terrain surface when spawning */
export const SPAWN_HEIGHT_OFFSET = 2.0;

/** Height to raycast from when finding terrain surface */
export const SPAWN_RAYCAST_HEIGHT = 200.0;

/** Fallback spawn height when terrain not found (high to let gravity work) */
export const SPAWN_FALLBACK_HEIGHT = 50.0;
