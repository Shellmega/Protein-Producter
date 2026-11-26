/**
 * Small dependency-free vector / quaternion helpers.
 *
 * The PTG domain keeps graph coordinates in plain number tuples so that the
 * coordinate chain (graph frame <-> world <-> object local) can be unit-tested
 * without a WebGL context and without using Three.js math classes as the only
 * source of truth.
 *
 * Conventions:
 * - Vec3 is `[x, y, z]`, right-handed.
 * - Quat is `[x, y, z, w]` (same component order as Three.js `Quaternion`).
 * - Euler angles are degrees, Three.js `Euler` order "XYZ" (q = qx * qy * qz).
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export function vec3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isFiniteVec3(value: readonly number[] | null | undefined): value is Vec3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    isFiniteNumber(value[2])
  );
}

export function isFiniteQuat(value: readonly number[] | null | undefined): value is Quat {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((component) => isFiniteNumber(component))
  );
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (!Number.isFinite(len) || len === 0) {
    return [Number.NaN, Number.NaN, Number.NaN];
  }
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(len) || len === 0) {
    return [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  }
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/**
 * Rotate a vector by a unit quaternion: v + 2w(q x v) + 2(q x (q x v)).
 * This mirrors the standard formula and is independent from Three.js.
 */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Quaternion from Euler angles in degrees, Three.js order "XYZ". */
export function quatFromEulerDegreesXYZ(eulerDeg: Vec3): Quat {
  const halfToRad = Math.PI / 360;
  const x = eulerDeg[0] * halfToRad;
  const y = eulerDeg[1] * halfToRad;
  const z = eulerDeg[2] * halfToRad;
  const qx: Quat = [Math.sin(x), 0, 0, Math.cos(x)];
  const qy: Quat = [0, Math.sin(y), 0, Math.cos(y)];
  const qz: Quat = [0, 0, Math.sin(z), Math.cos(z)];
  return quatNormalize(quatMultiply(quatMultiply(qx, qy), qz));
}

/** Rotation matrix (row-major 3x3) for a unit quaternion. Used by tests/diagnostics. */
export function quatToRotationMatrix(q: Quat): number[] {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}

/** Apply a row-major 3x3 matrix to a vector. */
export function mat3Apply(m: readonly number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function mat3Transpose(m: readonly number[]): number[] {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mat3Determinant(m: readonly number[]): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function formatNumber(value: number, digits = 6): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return value.toFixed(digits);
}

export function formatVec3(value: readonly number[], digits = 6): string {
  return `[${formatNumber(value[0] ?? Number.NaN, digits)}, ${formatNumber(
    value[1] ?? Number.NaN,
    digits,
  )}, ${formatNumber(value[2] ?? Number.NaN, digits)}]`;
}
