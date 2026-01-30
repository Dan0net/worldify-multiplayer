/**
 * Physics constants shared between client and server
 * 
 * IMPORTANT: All physics-related values must be defined here to ensure
 * client/server consistency and prevent desync bugs.
 */

// ============== Player Movement ==============

/** Base movement speed in meters per second */
export const MOVE_SPEED = 6.0;

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
