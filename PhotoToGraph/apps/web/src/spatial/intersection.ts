/**
 * Deterministic ray / plane intersection used for graph-space point creation.
 *
 * This is intentionally NOT Three.js `Ray.intersectPlane`: that helper returns
 * the ray origin when the ray is coplanar with the plane, which would create a
 * bogus node. Here every failure mode is classified and reported explicitly.
 *
 * Editor policy (registered in docs/implementation/PTG-1_spatial_scene_v1.md):
 * - NEAR_PARALLEL_EPS = 1e-6: |n·d| is the sine of the ray/plane angle for a
 *   unit normal and unit direction. Below (or equal to) 1e-6 the intersection
 *   is numerically ill-conditioned (a 1e-6 angle at 1 scene_unit distance moves
 *   the hit by ~1e6 scene_units), so the editor rejects it instead of guessing.
 *   The comparison is inclusive (<=) for deterministic boundary behavior.
 * - COPLANAR_EPS = 1e-9 scene_unit: only used when |n·d| is exactly 0 to
 *   distinguish a ray lying in the plane (no unique intersection) from a
 *   separated parallel ray.
 * - MIN_T: the intersection must be in front of the ray origin (t > 0). t == 0
 *   (plane through the camera) is rejected as BEHIND.
 * - MAX_ABS_COORD = 1e6: the candidate contract's coordinate bound, applied to
 *   every component of the resulting graph position (inclusive).
 */

import { dot, isFiniteNumber, isFiniteVec3, length, normalize, sub, type Vec3 } from './math';
import type { PlaneSpec } from './planes';

export const NEAR_PARALLEL_EPS = 1e-6;
export const COPLANAR_EPS = 1e-9;
export const MAX_ABS_COORD = 1_000_000;

export type IntersectionFailureCode =
  | 'NON_FINITE'
  | 'PARALLEL'
  | 'COPLANAR'
  | 'NEAR_PARALLEL'
  | 'BEHIND'
  | 'OUT_OF_RANGE';

export interface RaySpec {
  origin: Vec3;
  direction: Vec3;
}

export interface IntersectionSuccess {
  ok: true;
  point: Vec3;
  /** Distance along the ray direction (scene_unit). */
  t: number;
  /** n·d of the unit normal and unit direction. */
  dot: number;
}

export interface IntersectionFailure {
  ok: false;
  code: IntersectionFailureCode;
  message: string;
  dot?: number;
  t?: number;
}

export type IntersectionResult = IntersectionSuccess | IntersectionFailure;

export function isNearParallelDot(dotValue: number): boolean {
  return Math.abs(dotValue) <= NEAR_PARALLEL_EPS;
}

export function isOutOfRange(point: Vec3): boolean {
  return point.some((component) => Math.abs(component) > MAX_ABS_COORD);
}

export function intersectRayWithPlane(ray: RaySpec, plane: PlaneSpec): IntersectionResult {
  if (!isFiniteVec3(ray.origin) || !isFiniteVec3(ray.direction)) {
    return fail('NON_FINITE', '射线包含非有限数值，未建立结点');
  }
  if (!isFiniteVec3(plane.point) || !isFiniteVec3(plane.normal)) {
    return fail('NON_FINITE', '工作平面包含非有限数值，未建立结点');
  }

  const normalLength = length(plane.normal);
  if (!isFiniteNumber(normalLength) || normalLength === 0) {
    return fail('NON_FINITE', '工作平面法向无效（长度为零或非有限），未建立结点');
  }
  const normal: Vec3 = [
    plane.normal[0] / normalLength,
    plane.normal[1] / normalLength,
    plane.normal[2] / normalLength,
  ];

  const directionLength = length(ray.direction);
  if (!isFiniteNumber(directionLength) || directionLength === 0) {
    return fail('NON_FINITE', '射线方向无效（长度为零或非有限），未建立结点');
  }
  const direction: Vec3 = [
    ray.direction[0] / directionLength,
    ray.direction[1] / directionLength,
    ray.direction[2] / directionLength,
  ];

  const denom = dot(normal, direction);
  const distanceToPlane = Math.abs(dot(normal, sub(ray.origin, plane.point)));

  // |n·d| is the sine of the angle between the ray and the plane. When it is
  // at or below the registered threshold the hit is numerically unstable; if
  // the ray origin also lies in the plane the ray is coplanar (no unique hit).
  if (isNearParallelDot(denom)) {
    if (distanceToPlane <= COPLANAR_EPS) {
      return fail(
        'COPLANAR',
        '射线位于工作平面内，没有唯一交点；请调整视角或平面偏移后重试',
        denom,
      );
    }
    if (denom === 0) {
      return fail('PARALLEL', '射线与工作平面平行，没有交点；请调整视角后重试', denom);
    }
    return fail(
      'NEAR_PARALLEL',
      `射线与工作平面近乎平行（|n·d| = ${Math.abs(denom).toExponential(3)} ≤ ${NEAR_PARALLEL_EPS.toExponential(
        0,
      )}），交点数值不稳定；请调整视角后重试`,
      denom,
    );
  }

  const t = dot(normal, sub(plane.point, ray.origin)) / denom;
  if (!Number.isFinite(t)) {
    return fail('NON_FINITE', '交点参数不是有限数，未建立结点', denom, t);
  }
  if (t <= 0) {
    return fail('BEHIND', '交点位于射线起点或后方，未建立结点；请调整视角后重试', denom, t);
  }

  const point: Vec3 = [
    ray.origin[0] + direction[0] * t,
    ray.origin[1] + direction[1] * t,
    ray.origin[2] + direction[2] * t,
  ];

  if (!isFiniteVec3(point)) {
    return fail('NON_FINITE', '交点坐标不是有限数，未建立结点', denom, t);
  }
  if (isOutOfRange(point)) {
    return fail(
      'OUT_OF_RANGE',
      `交点超出工作范围（坐标绝对值上限 ${MAX_ABS_COORD} scene_unit），未建立结点`,
      denom,
      t,
    );
  }

  return { ok: true, point, t, dot: denom };
}

export function validateGraphPoint(point: Vec3): IntersectionFailure | null {
  if (!isFiniteVec3(point)) {
    return fail('NON_FINITE', '坐标必须是 3 个有限数');
  }
  if (isOutOfRange(point)) {
    return fail(
      'OUT_OF_RANGE',
      `坐标超出工作范围（绝对值上限 ${MAX_ABS_COORD} scene_unit）`,
    );
  }
  return null;
}

function fail(
  code: IntersectionFailureCode,
  message: string,
  dotValue?: number,
  tValue?: number,
): IntersectionFailure {
  return { ok: false, code, message, dot: dotValue, t: tValue };
}

export const INTERSECTION_CODE_LABELS: Record<IntersectionFailureCode, string> = {
  NON_FINITE: '非有限数值',
  PARALLEL: '射线平行',
  COPLANAR: '射线共面',
  NEAR_PARALLEL: '近乎平行',
  BEHIND: '交点在后方',
  OUT_OF_RANGE: '超出范围',
};

/** Project a graph point onto a plane's (u, v) coordinates. Used by diagnostics/tests. */
export function projectPointToPlane(point: Vec3, plane: PlaneSpec): { u: number; v: number; w: number } {
  const rel = sub(point, plane.point);
  return {
    u: dot(rel, normalize(plane.u)),
    v: dot(rel, normalize(plane.v)),
    w: dot(rel, normalize(plane.normal)),
  };
}
