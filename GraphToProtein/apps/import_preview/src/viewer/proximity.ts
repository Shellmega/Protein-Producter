/**
 * "How far is the candidate backbone from the sketch?" — the viewer's readout
 * of the distance between each sketch control point and the Cα of the residue
 * the catalog anchors it to, both in the model (Å) frame.
 *
 * Anchors are resolved to a concrete residue before any distance is computed:
 *
 *   * `residue_number` must name exactly one residue in the file (chain and
 *     insertion code included); several candidates are ambiguous.
 *   * `residue_index0` alone is resolved through the **chain order**, which is
 *     only accepted when the file has one chain and its residue numbers are
 *     monotonic; otherwise the evidence is insufficient and the reason says so.
 *
 * Two anchors for the same control point that resolve to different residues are
 * a conflict: the point is marked as not uniquely locatable and excluded from
 * the mean and the maximum. Anchor order never matters.
 *
 * Pure module: no DOM, no network.
 */

import type { PdbAtom } from "./pdb.js";
import type { Vec3 } from "../contract/dto.js";

export interface ProximityAnchor {
  control_point_index: number;
  residue_index0?: number;
  residue_number?: number;
}

export interface ProximityInput {
  /** Sketch control points in N→C order (catalog `curve.node_order`). */
  nodeOrder: string[];
  /** The same points in the model frame, N→C order (curve.map.nodes[].model). */
  sketchModel: Vec3[];
  anchors: ProximityAnchor[];
  atoms: PdbAtom[];
  /** The line overlay's data state: a disabled overlay means no verified mapping. */
  overlayEnabled: boolean;
  overlayReason: string | null;
  /** Draft revision the sketch polygon came from, and the task's frozen revision. */
  pointsRevision: number | null;
  taskDraftRevision: number | null;
}

export interface ProximityPoint {
  index: number;
  nodeId: string;
  /** Anchored residue number, when it could be resolved unambiguously. */
  residue: number | null;
  /** The unique Cα atom, when it was located. */
  ca: { chainId: string; resSeq: number; iCode: string } | null;
  /** Distance in Å, model frame; `null` when this point cannot be measured. */
  distance: number | null;
  reason: string | null;
}

export interface ProximityMax {
  index: number;
  nodeId: string;
  residue: number | null;
  distance: number;
}

export interface ProximityResult {
  unit: "angstrom";
  /** Set when no point can be measured at all. */
  reason: string | null;
  points: ProximityPoint[];
  total: number;
  validCount: number;
  mean: number | null;
  max: ProximityMax | null;
}

interface ResidueRef {
  chainId: string;
  resSeq: number;
  iCode: string;
}

interface ChainView {
  chainId: string;
  residues: ResidueRef[];
  /** The chain order is only usable when residue numbers are monotonic. */
  orderProblem: string | null;
}

interface ResolvedTarget {
  target: ResidueRef | null;
  key: string | null;
  reason: string | null;
}

function distanceBetween(left: Vec3, right: Vec3): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function residueKey(ref: ResidueRef): string {
  return `${ref.chainId || "?"}/${ref.resSeq}${ref.iCode}`;
}

/** Unique residues per chain in file order, with a checkable ordering. */
function chainViews(atoms: PdbAtom[]): ChainView[] {
  const perChain = new Map<string, ResidueRef[]>();
  const seen = new Set<string>();
  for (const atom of atoms) {
    if (atom.record !== "ATOM") continue;
    const key = `${atom.chainId}|${atom.resSeq}|${atom.iCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = perChain.get(atom.chainId) ?? [];
    list.push({ chainId: atom.chainId, resSeq: atom.resSeq, iCode: atom.iCode });
    perChain.set(atom.chainId, list);
  }
  return [...perChain.entries()].map(([chainId, residues]) => {
    let orderProblem: string | null = null;
    for (let index = 1; index < residues.length; index += 1) {
      if (residues[index]!.resSeq < residues[index - 1]!.resSeq) {
        orderProblem = `链 ${chainId || "?"} 的残基编号在文件中不单调（${residues[index - 1]!.resSeq} → ${residues[index]!.resSeq}），无法验证链序`;
        break;
      }
    }
    return { chainId, residues, orderProblem };
  });
}

function resolveAnchor(anchor: ProximityAnchor, chains: ChainView[]): ResolvedTarget {
  const hasNumber = typeof anchor.residue_number === "number" && Number.isInteger(anchor.residue_number);
  if (hasNumber) {
    const residueNumber = anchor.residue_number as number;
    const matches = chains.flatMap((chain) => chain.residues.filter((residue) => residue.resSeq === residueNumber));
    if (matches.length === 0) {
      return { target: null, key: null, reason: `残基 ${residueNumber} 不在结构文件中` };
    }
    if (matches.length > 1) {
      return {
        target: null,
        key: null,
        reason: `残基 ${residueNumber} 的 Cα 无法唯一定位（${matches.length} 个目标：${matches.map(residueKey).join("、")}）`,
      };
    }
    const target = matches[0]!;
    return { target, key: residueKey(target), reason: null };
  }
  const hasIndex = typeof anchor.residue_index0 === "number" && Number.isInteger(anchor.residue_index0);
  if (!hasIndex) {
    return { target: null, key: null, reason: "锚点没有可用的残基编号或链序位置" };
  }
  const index0 = anchor.residue_index0 as number;
  if (chains.length !== 1) {
    return {
      target: null,
      key: null,
      reason: `只有 residue_index0=${index0}，文件有 ${chains.length} 条链，无法确定按哪条链的链序定位`,
    };
  }
  const chain = chains[0]!;
  if (chain.orderProblem) return { target: null, key: null, reason: chain.orderProblem };
  if (index0 < 0 || index0 >= chain.residues.length) {
    return {
      target: null,
      key: null,
      reason: `residue_index0=${index0} 超出链 ${chain.chainId || "?"} 的残基范围（共 ${chain.residues.length} 个）`,
    };
  }
  const target = chain.residues[index0]!;
  return { target, key: residueKey(target), reason: null };
}

export function computeProximity(input: ProximityInput): ProximityResult {
  const total = input.nodeOrder.length;
  const empty = (reason: string): ProximityResult => ({
    unit: "angstrom",
    reason,
    points: [],
    total,
    validCount: 0,
    mean: null,
    max: null,
  });

  if (input.pointsRevision !== null && input.taskDraftRevision !== null && input.pointsRevision !== input.taskDraftRevision) {
    return empty(`无法计算：修订不符（线稿依据 r${input.pointsRevision}，任务冻结 r${input.taskDraftRevision}）`);
  }
  if (!input.overlayEnabled) {
    return empty(`无法计算：线稿叠加不可用（${input.overlayReason ?? "缺少回映资料或锚点"}）`);
  }
  if (total === 0 || input.sketchModel.length !== total) {
    return empty("无法计算：没有可用的草图控制点");
  }
  if (input.anchors.length === 0) {
    return empty("无法计算：缺少锚点映射（清单未声明控制点与残基的对应关系）");
  }

  const byIndex = new Map<number, ProximityAnchor[]>();
  for (const anchor of input.anchors) {
    const list = byIndex.get(anchor.control_point_index) ?? [];
    list.push(anchor);
    byIndex.set(anchor.control_point_index, list);
  }
  const chains = chainViews(input.atoms);

  const points: ProximityPoint[] = input.nodeOrder.map((nodeId, index) => {
    const anchors = byIndex.get(index) ?? [];
    if (anchors.length === 0) {
      return { index, nodeId, residue: null, ca: null, distance: null, reason: "未映射：没有对应的锚点" };
    }
    const resolved = anchors.map((anchor) => resolveAnchor(anchor, chains));
    const failure = resolved.find((entry) => entry.reason !== null);
    if (failure) {
      return { index, nodeId, residue: null, ca: null, distance: null, reason: failure.reason };
    }
    const keys = [...new Set(resolved.map((entry) => entry.key))];
    if (keys.length > 1) {
      return {
        index,
        nodeId,
        residue: null,
        ca: null,
        distance: null,
        reason: `同一控制点有 ${keys.length} 个冲突锚点（${keys.join("、")}），无法唯一定位`,
      };
    }
    const target = resolved[0]!.target!;
    const candidates = input.atoms.filter(
      (atom) =>
        atom.record === "ATOM" &&
        atom.atomName.trim() === "CA" &&
        atom.altLoc.trim() === "" &&
        atom.chainId === target.chainId &&
        atom.resSeq === target.resSeq &&
        atom.iCode === target.iCode,
    );
    if (candidates.length === 0) {
      return { index, nodeId, residue: target.resSeq, ca: null, distance: null, reason: `残基 ${residueKey(target)} 没有可定位的 Cα` };
    }
    if (candidates.length > 1) {
      return {
        index,
        nodeId,
        residue: target.resSeq,
        ca: null,
        distance: null,
        reason: `残基 ${residueKey(target)} 的 Cα 无法唯一定位（${candidates.length} 个）`,
      };
    }
    const atom = candidates[0]!;
    const ca: Vec3 = [atom.x, atom.y, atom.z];
    return {
      index,
      nodeId,
      residue: target.resSeq,
      ca: { chainId: atom.chainId, resSeq: atom.resSeq, iCode: atom.iCode },
      distance: distanceBetween(input.sketchModel[index]!, ca),
      reason: null,
    };
  });

  const valid = points.filter((point) => point.distance !== null);
  if (valid.length === 0) {
    const first = points.find((point) => point.reason !== null);
    return { ...empty(`无法计算：${first?.reason ?? "没有可定位的 Cα"}`), points, total };
  }
  const mean = valid.reduce((sum, point) => sum + (point.distance ?? 0), 0) / valid.length;
  let maxPoint = valid[0]!;
  for (const point of valid) {
    if ((point.distance ?? 0) > (maxPoint.distance ?? 0)) maxPoint = point;
  }
  return {
    unit: "angstrom",
    reason: null,
    points,
    total,
    validCount: valid.length,
    mean,
    max: { index: maxPoint.index, nodeId: maxPoint.nodeId, residue: maxPoint.residue, distance: maxPoint.distance ?? 0 },
  };
}
