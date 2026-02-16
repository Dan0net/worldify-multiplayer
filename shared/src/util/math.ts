/**
 * Common math, color, and 3D geometry utility functions.
 * Used for interpolation, color conversions, easing, and quaternion/vector math.
 */

// ============== 3D Types ==============

/**
 * 3D position/direction vector.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Quaternion for rotation.
 */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

// ============== Quaternion Utilities ==============

/**
 * Create an identity quaternion (no rotation).
 */
export function identityQuat(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

/**
 * Get the inverse (conjugate) of a quaternion.
 * For unit quaternions, conjugate = inverse.
 */
export function invertQuat(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/**
 * Multiply two quaternions: result = a * b
 * Applies rotation b first, then a (standard quaternion composition).
 */
export function multiplyQuats(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * Apply quaternion rotation to a vector.
 * Returns a new vector (does not mutate input).
 */
export function applyQuatToVec3(v: Vec3, q: Quat): Vec3 {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const vx = v.x, vy = v.y, vz = v.z;

  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  // result = v + w * t + cross(q.xyz, t)
  return {
    x: vx + qw * tx + (qy * tz - qz * ty),
    y: vy + qw * ty + (qz * tx - qx * tz),
    z: vz + qw * tz + (qx * ty - qy * tx),
  };
}

/**
 * Create a quaternion for rotation around the X axis.
 * @param radians - The rotation angle in radians
 */
export function xRotationQuat(radians: number): Quat {
  const halfAngle = radians * 0.5;
  return {
    x: Math.sin(halfAngle),
    y: 0,
    z: 0,
    w: Math.cos(halfAngle),
  };
}

/**
 * Create a quaternion for rotation around the Y axis.
 * @param radians - The rotation angle in radians
 */
export function yRotationQuat(radians: number): Quat {
  const halfAngle = radians * 0.5;
  return {
    x: 0,
    y: Math.sin(halfAngle),
    z: 0,
    w: Math.cos(halfAngle),
  };
}

/**
 * Create a quaternion for rotation around the Z axis.
 * @param radians - The rotation angle in radians
 */
export function zRotationQuat(radians: number): Quat {
  const halfAngle = radians * 0.5;
  return {
    x: 0,
    y: 0,
    z: Math.sin(halfAngle),
    w: Math.cos(halfAngle),
  };
}

/**
 * Compose a quaternion from Euler angles (XYZ order).
 * @param xRad - Rotation around X axis in radians
 * @param yRad - Rotation around Y axis in radians
 * @param zRad - Rotation around Z axis in radians
 */
export function eulerToQuat(xRad: number, yRad: number, zRad: number): Quat {
  return multiplyQuats(multiplyQuats(zRotationQuat(zRad), yRotationQuat(yRad)), xRotationQuat(xRad));
}

/**
 * Extract Euler angles (XYZ order) from a quaternion.
 * Returns angles in radians.
 */
export function quatToEuler(q: Quat): { x: number; y: number; z: number } {
  // Roll (X)
  const sinrCosp = 2 * (q.w * q.x + q.y * q.z);
  const cosrCosp = 1 - 2 * (q.x * q.x + q.y * q.y);
  const x = Math.atan2(sinrCosp, cosrCosp);

  // Pitch (Y)
  const sinp = 2 * (q.w * q.y - q.z * q.x);
  const y = Math.abs(sinp) >= 1 ? (Math.sign(sinp) * Math.PI) / 2 : Math.asin(sinp);

  // Yaw (Z)
  const sinyCosp = 2 * (q.w * q.z + q.x * q.y);
  const cosyCosp = 1 - 2 * (q.y * q.y + q.z * q.z);
  const z = Math.atan2(sinyCosp, cosyCosp);

  return { x, y, z };
}

// ============== Interpolation ==============

/**
 * Linear interpolation between two numbers.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Smooth step function for nicer transitions.
 * Returns a value that smoothly interpolates from 0 to 1 as x moves from edge0 to edge1.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Clamp a value between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============== Color Utilities ==============

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse hex color string to RGB components (0-1 range).
 */
export function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { r: 1, g: 1, b: 1 };
  return {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255,
  };
}

/**
 * Convert RGB components (0-1 range) to hex color string.
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) =>
    Math.round(Math.max(0, Math.min(1, c)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Linearly interpolate between two hex color strings.
 */
export function lerpColor(colorA: string, colorB: string, t: number): string {
  const a = hexToRgb(colorA);
  const b = hexToRgb(colorB);
  return rgbToHex(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t
  );
}
