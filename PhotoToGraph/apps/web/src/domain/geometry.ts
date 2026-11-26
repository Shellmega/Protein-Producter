import type { GraphNode } from './types';
import type { Vec3 } from '../spatial/math';
import { validateGraphPoint } from '../spatial/intersection';

// gtp.4 spec §2.4 / vectors; A-GTP3-01 overrides the erroneous rules.u.
// Each JS arithmetic operation rounds to binary64. Do not reassociate or use
// hypot/sqrt, a fused multiply-add, formatted decimals or Number.EPSILON as u.
export const COINCIDENCE = {
  u: 2 ** -53,
  tau: 1e-6,
  slack: 1 + 8 * 2 ** -53,
  limitSquared: (1e-6 * 1e-6) * (1 + 8 * 2 ** -53),
  window: 1e-6 * (1 + 8 * 2 ** -53),
} as const;

export function coincident(p: Vec3, q: Vec3): boolean {
  const dx = p[0] - q[0];
  // Conservative broad phase W (not tau). No pair rejected below can escape.
  if (Math.abs(dx) > COINCIDENCE.window) return false;
  const dy = p[1] - q[1];
  const dz = p[2] - q[2];
  const xx = dx * dx;
  const yy = dy * dy;
  const zz = dz * dz;
  const xy = xx + yy;
  const s = xy + zz;
  return s <= COINCIDENCE.limitSquared;
}

/** The only creation/movement validity gate. `exclude` is a stable node ID. */
export function positionError(nodes: GraphNode[], point: Vec3, exclude?: string) {
  const invalid = validateGraphPoint(point);
  if (invalid) return invalid;
  const other = nodes.find(n => n.id !== exclude && coincident(n.position, point));
  return other ? { code: 'COINCIDENT', message: `与结点 ${other.id} 重合（平方距离及 8u 余量），已保留原图。` } : null;
}

export type DragConstraint = 'X' | 'Y' | 'Z' | 'XY' | 'XZ' | 'YZ';
export function constrainedPosition(start: Vec3, next: Vec3, constraint: DragConstraint): [number, number, number] {
  return [constraint.includes('X') ? next[0] : start[0],
    constraint.includes('Y') ? next[1] : start[1],
    constraint.includes('Z') ? next[2] : start[2]];
}
