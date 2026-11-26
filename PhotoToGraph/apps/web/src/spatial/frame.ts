/**
 * Affine pose used for the complete coordinate chain.
 *
 * A pose maps coordinates from a child space into its parent space:
 *   parent = translation + scale * rotation * child
 *
 * The same structure is used for:
 * - graph frame -> render world (`sceneFrame`; identity in the current UI),
 * - reference-image plane local -> graph frame (`referencePoseToPose`),
 * - generic parent-object local -> world -> graph fixtures (tests).
 *
 * `scale` is a positive uniform scale. Reflections (det(R) = -1) are not
 * representable here, matching the right-handed graph contract.
 */

import {
  add,
  isFiniteQuat,
  isFiniteVec3,
  isFiniteNumber,
  quatConjugate,
  quatFromEulerDegreesXYZ,
  quatMultiply,
  quatNormalize,
  quatRotate,
  scale as scaleVec,
  sub,
  type Quat,
  type Vec3,
} from './math';

export interface Pose {
  translation: Vec3;
  rotation: Quat;
  scale: number;
}

export function identityPose(): Pose {
  return { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 };
}

export function poseFromTranslationEulerScale(
  translation: Vec3,
  rotationDeg: Vec3,
  scale: number,
): Pose {
  return {
    translation: [...translation] as Vec3,
    rotation: quatFromEulerDegreesXYZ(rotationDeg),
    scale,
  };
}

/** Child space -> parent space. */
export function applyPose(pose: Pose, point: Vec3): Vec3 {
  const rotated = quatRotate(pose.rotation, point);
  return add(scaleVec(rotated, pose.scale), pose.translation);
}

/** Parent space -> child space. */
export function applyPoseInverse(pose: Pose, point: Vec3): Vec3 {
  const rotated = quatRotate(quatConjugate(pose.rotation), sub(point, pose.translation));
  return scaleVec(rotated, 1 / pose.scale);
}

/** Direction (no translation) child space -> parent space; normalized. */
export function applyPoseDirection(pose: Pose, direction: Vec3): Vec3 {
  return quatRotate(pose.rotation, direction);
}

/** Direction parent space -> child space; normalized. */
export function applyPoseInverseDirection(pose: Pose, direction: Vec3): Vec3 {
  return quatRotate(quatConjugate(pose.rotation), direction);
}

/** parent ∘ child: map child-local coordinates straight to the outer space. */
export function composePoses(parent: Pose, child: Pose): Pose {
  return {
    translation: applyPose(parent, child.translation),
    rotation: quatNormalize(quatMultiply(parent.rotation, child.rotation)),
    scale: parent.scale * child.scale,
  };
}

/** Returns null when the pose is usable, otherwise a human-readable reason. */
export function validatePose(pose: Pose): string | null {
  if (!isFiniteVec3(pose.translation)) {
    return '平移分量必须是有限数';
  }
  if (!isFiniteQuat(pose.rotation)) {
    return '旋转四元数必须是有限数';
  }
  const norm = Math.hypot(
    pose.rotation[0],
    pose.rotation[1],
    pose.rotation[2],
    pose.rotation[3],
  );
  if (Math.abs(norm - 1) > 1e-6) {
    return '旋转四元数必须是单位四元数';
  }
  if (!isFiniteNumber(pose.scale) || pose.scale <= 0) {
    return '尺度必须是有限正数';
  }
  return null;
}

/**
 * Convert a ray from world space into graph space.
 * The direction stays unit length; the scale of the scene frame is positive.
 */
export function rayWorldToGraph(
  sceneFrame: Pose,
  ray: { origin: Vec3; direction: Vec3 },
): { origin: Vec3; direction: Vec3 } {
  const origin = applyPoseInverse(sceneFrame, ray.origin);
  const direction = quatRotate(quatConjugate(sceneFrame.rotation), ray.direction);
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!Number.isFinite(len) || len === 0) {
    return { origin, direction: [Number.NaN, Number.NaN, Number.NaN] };
  }
  return {
    origin,
    direction: [direction[0] / len, direction[1] / len, direction[2] / len],
  };
}

/** Convert a graph point into world space. */
export function graphToWorld(sceneFrame: Pose, point: Vec3): Vec3 {
  return applyPose(sceneFrame, point);
}

/** Convert a world point into graph space. */
export function worldToGraph(sceneFrame: Pose, point: Vec3): Vec3 {
  return applyPoseInverse(sceneFrame, point);
}
