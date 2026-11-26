/**
 * Reference-image plane math.
 *
 * Pixel space -> image-local plane space -> reference plane -> graph frame.
 *
 * Pixel conventions: (0, 0) is the top-left of the decoded (orientation
 * corrected) image, +x is right, +y is down. Image-local plane space uses
 * Three.js PlaneGeometry conventions: +x right, +y up, +z towards the viewer.
 * Therefore `y_local = (0.5 - v) * height`.
 *
 * The reference pose (position / Euler XYZ degrees / positive uniform scale)
 * is an editor placement in the graph frame; it never changes node positions.
 */

import {
  isFiniteNumber,
  isFiniteVec3,
  quatRotate,
  type Quat,
  type Vec3,
} from './math';
import {
  applyPose,
  applyPoseInverse,
  poseFromTranslationEulerScale,
  type Pose,
} from './frame';
import type { PlaneSpec } from './planes';

export const REFERENCE_BASE_WIDTH = 4;
export const MIN_REFERENCE_SCALE = 0.1;
export const MAX_REFERENCE_SCALE = 10;
export const MIN_REFERENCE_ASPECT = 1 / 100;
export const MAX_REFERENCE_ASPECT = 100;

export interface ReferencePose {
  position: Vec3;
  rotationDeg: Vec3;
  scale: number;
}

export function defaultReferencePose(): ReferencePose {
  return { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 };
}

export function referencePoseToPose(pose: ReferencePose): Pose {
  return poseFromTranslationEulerScale(pose.position, pose.rotationDeg, pose.scale);
}

export function referenceNormal(pose: ReferencePose): Vec3 {
  return quatRotate(referencePoseToPose(pose).rotation, [0, 0, 1]);
}

export function referencePlane(pose: ReferencePose): PlaneSpec {
  const frame = referencePoseToPose(pose);
  return {
    point: [...pose.position] as Vec3,
    normal: quatRotate(frame.rotation, [0, 0, 1]),
    u: quatRotate(frame.rotation, [1, 0, 0]),
    v: quatRotate(frame.rotation, [0, 1, 0]),
  };
}

/**
 * Unscaled plane geometry size (scene_unit before the pose scale is applied).
 * The aspect ratio is always preserved.
 */
export function imagePlaneSize(
  intrinsicWidth: number,
  intrinsicHeight: number,
  baseWidth = REFERENCE_BASE_WIDTH,
): { width: number; height: number; aspect: number } {
  if (
    !isFiniteNumber(intrinsicWidth) ||
    !isFiniteNumber(intrinsicHeight) ||
    !(intrinsicWidth > 0) ||
    !(intrinsicHeight > 0)
  ) {
    return { width: Number.NaN, height: Number.NaN, aspect: Number.NaN };
  }
  const aspect = intrinsicWidth / intrinsicHeight;
  return { width: baseWidth, height: baseWidth / aspect, aspect };
}

/** Normalized image UV -> graph position on the reference plane. */
export function imageUvToGraph(
  pose: ReferencePose,
  intrinsicWidth: number,
  intrinsicHeight: number,
  u: number,
  v: number,
  baseWidth = REFERENCE_BASE_WIDTH,
): Vec3 {
  const { width, height } = imagePlaneSize(intrinsicWidth, intrinsicHeight, baseWidth);
  const local: Vec3 = [(u - 0.5) * width, (0.5 - v) * height, 0];
  return applyPose(referencePoseToPose(pose), local);
}

/** Pixel (top-left origin, orientation-corrected) -> graph position. */
export function imagePixelToGraph(
  pose: ReferencePose,
  intrinsicWidth: number,
  intrinsicHeight: number,
  pixelX: number,
  pixelY: number,
  baseWidth = REFERENCE_BASE_WIDTH,
): Vec3 {
  return imageUvToGraph(
    pose,
    intrinsicWidth,
    intrinsicHeight,
    pixelX / intrinsicWidth,
    pixelY / intrinsicHeight,
    baseWidth,
  );
}

/** Inverse mapping: graph point on the reference plane -> pixel coordinates. */
export function graphToImagePixel(
  pose: ReferencePose,
  intrinsicWidth: number,
  intrinsicHeight: number,
  point: Vec3,
  baseWidth = REFERENCE_BASE_WIDTH,
): { pixelX: number; pixelY: number; u: number; v: number } | null {
  const { width, height } = imagePlaneSize(intrinsicWidth, intrinsicHeight, baseWidth);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const local = applyPoseInverse(referencePoseToPose(pose), point);
  const u = local[0] / width + 0.5;
  const v = 0.5 - local[1] / height;
  return { pixelX: u * intrinsicWidth, pixelY: v * intrinsicHeight, u, v };
}

export function validateReferencePose(pose: ReferencePose): string | null {
  if (!isFiniteVec3(pose.position)) {
    return '参考图位置必须是 3 个有限数';
  }
  if (!isFiniteVec3(pose.rotationDeg)) {
    return '参考图旋转必须是 3 个有限角度（度）';
  }
  if (!isFiniteNumber(pose.scale)) {
    return '参考图尺度必须是有限数';
  }
  if (pose.scale < MIN_REFERENCE_SCALE || pose.scale > MAX_REFERENCE_SCALE) {
    return `参考图尺度必须在 ${MIN_REFERENCE_SCALE} 到 ${MAX_REFERENCE_SCALE} 之间`;
  }
  const limit = 1_000_000;
  if (pose.position.some((component) => Math.abs(component) > limit)) {
    return `参考图位置绝对值不得超过 ${limit} scene_unit`;
  }
  return null;
}

/** Rotation matrix (row-major) for a reference pose; used by diagnostics. */
export function referenceRotationMatrix(pose: ReferencePose): number[] {
  const q: Quat = referencePoseToPose(pose).rotation;
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
