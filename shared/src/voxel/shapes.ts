/**
 * Signed Distance Functions (SDF) for build shapes.
 * 
 * SDF returns:
 *   negative = inside the shape (solid)
 *   positive = outside the shape (empty)
 *   zero = on the surface
 * 
 * All functions expect position relative to shape center, 
 * already inverse-rotated to shape's local space.
 * 
 * Reference: https://iquilezles.org/articles/distfunctions/
 */

import { BuildConfig, BuildShape, Size3, Vec3 } from './buildTypes.js';

// ============== Primitive SDF Functions ==============

/**
 * Sphere SDF.
 * @param p Position relative to center
 * @param radius Sphere radius
 * @returns Signed distance (negative inside)
 */
export function sdfSphere(p: Vec3, radius: number): number {
  const length = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  return length - radius;
}

/**
 * Box (cube/cuboid) SDF.
 * @param p Position relative to center
 * @param size Half-extents (distance from center to each face)
 * @returns Signed distance (negative inside)
 */
export function sdfBox(p: Vec3, size: Size3): number {
  // Distance to each face
  const dx = Math.abs(p.x) - size.x;
  const dy = Math.abs(p.y) - size.y;
  const dz = Math.abs(p.z) - size.z;

  // Outside distance (when at least one component > 0)
  const outsideX = Math.max(dx, 0);
  const outsideY = Math.max(dy, 0);
  const outsideZ = Math.max(dz, 0);
  const outsideDist = Math.sqrt(outsideX * outsideX + outsideY * outsideY + outsideZ * outsideZ);

  // Inside distance (when all components < 0, use the closest face)
  const insideDist = Math.min(Math.max(dx, dy, dz), 0);

  return outsideDist + insideDist;
}

/**
 * Cylinder SDF (Y-axis aligned).
 * @param p Position relative to center
 * @param radius Cylinder radius
 * @param halfHeight Half the cylinder height
 * @returns Signed distance (negative inside)
 */
export function sdfCylinder(p: Vec3, radius: number, halfHeight: number): number {
  // Distance in XZ plane to cylinder wall
  const xzLength = Math.sqrt(p.x * p.x + p.z * p.z);
  const dRadial = xzLength - radius;
  
  // Distance to top/bottom caps
  const dVertical = Math.abs(p.y) - halfHeight;

  // 2D box SDF in (radial, vertical) space
  const outsideR = Math.max(dRadial, 0);
  const outsideV = Math.max(dVertical, 0);
  const outsideDist = Math.sqrt(outsideR * outsideR + outsideV * outsideV);
  const insideDist = Math.min(Math.max(dRadial, dVertical), 0);

  return outsideDist + insideDist;
}

/**
 * Triangular prism SDF (extruded along Z-axis).
 * Triangle base is in XY plane, right angle at origin.
 * @param p Position relative to corner origin
 * @param sizeX Width along X
 * @param sizeY Height along Y
 * @param sizeZ Depth/extrusion along Z (half-extent)
 * @returns Signed distance (negative inside)
 */
export function sdfPrism(p: Vec3, sizeX: number, sizeY: number, sizeZ: number): number {
  // Shift position so the triangle's center is at origin
  const px = p.x + sizeX / 2;
  const py = p.y + sizeY / 2;

  // Check if point is inside the 2D triangle (right angle at origin)
  const inTriangle = px >= 0 && py >= 0 && (px / sizeX + py / sizeY) <= 1.0;

  // Calculate 2D distance to triangle
  let dxy: number;
  if (inTriangle) {
    // Inside - distance to nearest edge
    const d1 = px;  // Distance to Y-axis
    const d2 = py;  // Distance to X-axis
    // Distance to hypotenuse (line from (sizeX, 0) to (0, sizeY))
    const d3 = ((px / sizeX + py / sizeY - 1.0) * sizeX * sizeY) / 
               Math.sqrt(sizeY * sizeY + sizeX * sizeX);
    dxy = -Math.min(d1, d2, -d3);  // Negative inside
  } else {
    // Outside triangle
    if (px < 0 && py < 0) {
      // Distance to origin corner
      dxy = Math.sqrt(px * px + py * py);
    } else if (px < 0) {
      // Distance to Y-axis
      dxy = -px;
    } else if (py < 0) {
      // Distance to X-axis
      dxy = -py;
    } else {
      // Distance to hypotenuse
      const num = Math.abs((px / sizeX) + (py / sizeY) - 1);
      const denom = Math.sqrt((1 / (sizeX * sizeX)) + (1 / (sizeY * sizeY)));
      dxy = num / denom;
    }
  }

  // Z-axis extrusion (half-extent)
  const dz = Math.abs(p.z) - sizeZ / 2;

  // Combine 2D triangle distance with Z extrusion
  const outsideXY = Math.max(dxy, 0);
  const outsideZ = Math.max(dz, 0);
  const outsideDist = Math.sqrt(outsideXY * outsideXY + outsideZ * outsideZ);
  const insideDist = Math.min(Math.max(dxy, dz), 0);

  return outsideDist + insideDist;
}

// ============== Hollow Shape Modifier ==============

/**
 * Make a shape hollow by subtracting a smaller version.
 * @param distance Original SDF distance
 * @param thickness Wall thickness
 * @returns Hollowed SDF distance
 */
export function hollowSdf(distance: number, thickness: number): number {
  return Math.abs(distance) - thickness;
}

// ============== Arc Sweep Modifier ==============

/**
 * Limit a shape to an arc sweep around the Y-axis.
 * @param p Position (used to calculate angle)
 * @param sdfValue Original SDF value
 * @param arcSweep Arc angle in radians (0 to 2π)
 * @returns Modified SDF value (positive outside arc)
 */
export function arcSweepSdf(p: Vec3, sdfValue: number, arcSweep: number): number {
  // Calculate angle in XZ plane
  const angle = Math.atan2(p.z, p.x);
  // Normalize to 0-2π range
  const normalizedAngle = angle < 0 ? angle + Math.PI * 2 : angle;
  
  // If outside the arc, return positive (outside)
  if (normalizedAngle > arcSweep) {
    return Math.max(sdfValue, 1);  // Force outside
  }
  
  return sdfValue;
}

// ============== Combined Shape Function ==============

/**
 * Calculate SDF for a build configuration.
 * @param p Position relative to build center, in LOCAL shape space (inverse-rotated)
 * @param config Build configuration
 * @returns Signed distance (negative = inside shape)
 */
export function sdfFromConfig(p: Vec3, config: BuildConfig): number {
  let d: number;

  // Calculate base shape SDF
  switch (config.shape) {
    case BuildShape.SPHERE:
      // Sphere uses X as radius
      d = sdfSphere(p, config.size.x);
      break;

    case BuildShape.CUBE:
      d = sdfBox(p, config.size);
      break;

    case BuildShape.CYLINDER:
      // Cylinder: X = radius, Y = half-height
      d = sdfCylinder(p, config.size.x, config.size.y);
      break;

    case BuildShape.PRISM:
      // Prism: X = width, Y = height, Z = depth
      d = sdfPrism(p, config.size.x * 2, config.size.y * 2, config.size.z * 2);
      break;

    default:
      d = sdfBox(p, config.size);  // Fallback to box
  }

  // Apply hollow modifier if thickness is specified
  if (config.thickness !== undefined && config.thickness > 0) {
    // For hollow shapes with open top/bottom, extend the hollow region
    if (config.shape === BuildShape.CYLINDER || config.shape === BuildShape.CUBE) {
      const hollowD = hollowSdf(d, config.thickness);
      if (!config.closed) {
        // Open top/bottom: also cut out the vertical caps
        const capCut = -(Math.abs(p.y) - config.size.y);
        d = Math.min(hollowD, capCut);
      } else {
        d = hollowD;
      }
    } else {
      d = hollowSdf(d, config.thickness);
    }
  }

  // Apply arc sweep if specified
  if (config.arcSweep !== undefined && config.arcSweep > 0 && config.arcSweep < Math.PI * 2) {
    d = arcSweepSdf(p, d, config.arcSweep);
  }

  return d;
}

/**
 * Convert SDF distance to voxel weight.
 * SDF: negative inside, positive outside
 * Weight: positive inside (+0.5), negative outside (-0.5), 0 at surface
 * 
 * @param sdfDistance Signed distance from shape surface
 * @returns Weight value clamped to [-0.5, 0.5]
 */
export function sdfToWeight(sdfDistance: number): number {
  // Invert: SDF negative (inside) -> weight positive (solid)
  // Scale factor determines transition sharpness (1.0 = 1 voxel unit transition)
  const weight = -sdfDistance;
  return Math.max(-0.5, Math.min(0.5, weight));
}
