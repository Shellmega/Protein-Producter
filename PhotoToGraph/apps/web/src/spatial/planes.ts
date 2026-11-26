/**
 * Work-plane definitions in the graph frame.
 *
 * XY plane: normal +Z, offset moves along +Z, in-plane axes (X, Y)
 * XZ plane: normal +Y, offset moves along +Y, right-handed basis (X, -Z)
 * YZ plane: normal +X, offset moves along +X, in-plane axes (Y, Z)
 *
 * The reference-image plane is defined by its own pose (see referenceImage.ts);
 * it is a fourth creation plane, never silently substituted for a work plane.
 */

import { type Vec3 } from './math';

export type WorkPlaneKind = 'xy' | 'xz' | 'yz';
export type PlaneKind = WorkPlaneKind | 'reference';

export interface PlaneSpec {
  /** A point on the plane, graph frame. */
  point: Vec3;
  /** Unit normal, graph frame. */
  normal: Vec3;
  /** In-plane axis u, graph frame. */
  u: Vec3;
  /** In-plane axis v, graph frame. */
  v: Vec3;
}

export interface WorkPlaneDefinition {
  kind: WorkPlaneKind;
  label: string;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
  offsetAxisLabel: 'X' | 'Y' | 'Z';
}

export const WORK_PLANES: Record<WorkPlaneKind, WorkPlaneDefinition> = {
  xy: {
    kind: 'xy',
    label: 'XY 平面',
    normal: [0, 0, 1],
    u: [1, 0, 0],
    v: [0, 1, 0],
    offsetAxisLabel: 'Z',
  },
  xz: {
    kind: 'xz',
    label: 'XZ 平面',
    normal: [0, 1, 0],
    u: [1, 0, 0],
    v: [0, 0, -1],
    offsetAxisLabel: 'Y',
  },
  yz: {
    kind: 'yz',
    label: 'YZ 平面',
    normal: [1, 0, 0],
    u: [0, 1, 0],
    v: [0, 0, 1],
    offsetAxisLabel: 'X',
  },
};

export function workPlane(kind: WorkPlaneKind, offset: number): PlaneSpec {
  const def = WORK_PLANES[kind];
  return {
    point: [
      def.normal[0] * offset,
      def.normal[1] * offset,
      def.normal[2] * offset,
    ],
    normal: [...def.normal] as Vec3,
    u: [...def.u] as Vec3,
    v: [...def.v] as Vec3,
  };
}

export function planeLabel(kind: PlaneKind): string {
  if (kind === 'reference') {
    return '参考图平面';
  }
  return WORK_PLANES[kind].label;
}

export function planeKindDisplayName(kind: PlaneKind): string {
  return planeLabel(kind);
}
