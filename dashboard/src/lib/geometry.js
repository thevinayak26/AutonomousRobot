// -----------------------------------------------------------------------------
// geometry.js - small, dependency-free math shared by the map renderer and the
// telemetry layer. Kept in one place so the quaternion convention can never drift
// between tiles.
// -----------------------------------------------------------------------------

/** Yaw (rad, CCW, REP-103) from a geometry_msgs/Quaternion. */
export function quatToYaw(q) {
  if (!q) return 0;
  const { x = 0, y = 0, z = 0, w = 1 } = q;
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

/** Radians → degrees. */
export const toDeg = (rad) => (rad * 180) / Math.PI;

/** Signed fixed-width formatter, e.g. +1.20 / -0.40 - keeps numbers from jumping. */
export const signed = (n, digits = 2) => (n >= 0 ? '+' : '') + n.toFixed(digits);
