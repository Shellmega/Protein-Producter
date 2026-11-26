/**
 * ptg-jcs-1 semantic comparison of a received `source_graph` against the
 * exact frozen snapshot bytes.
 *
 * Contract sources (frozen, read-only):
 * - `spec.md` §6.1 (semantic projection / JCS) and §6.3 (source coordinates
 *   are preserved EXACTLY: binary64 value equality per component, `-0` equals
 *   `0`; there is NO geometric tolerance).
 * - `rules.json` `tolerances.source_graph` = exact, absolute 0.
 *
 * A component change of any size is a content change. The withdrawn tolerance
 * `1e-9 * max(1, max_abs_coordinate)` must never be used here: at coordinate
 * magnitude 1e6 it would hide a 1e-3 edit (spec §6.3 counterexample; identity
 * scenario `valid-tiny-change-large-coords`).
 *
 * `projectSemantics` is implemented in `jcs.ts` (next to the serializer) and
 * re-exported here with the frozen T1 name.
 */

import { canonicalize, projectSemantics, sha256HexUtf8 } from './jcs';

export { projectSemantics };

/** Result of comparing a received source graph to the frozen snapshot. */
export interface SemanticComparison {
  equivalent: boolean;
  /** Human-readable diagnosis; on mismatch it names the first differing path. */
  reason: string;
}

const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function typeLabel(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function displayValue(value: unknown): string {
  if (typeof value === 'number') {
    // Same shortest round-trip form as the canonical serializer, so a message
    // like `1.0001` or `1e-4` matches the bytes of the frozen snapshot.
    return Number.isFinite(value) ? (JSON.stringify(value) as string) : String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value) as string;
  }
  return String(value);
}

/**
 * First difference between two projected JSON values, as a readable path.
 * Returns null when no difference is found (which cannot happen once the
 * canonical serializations differ, but keeps this helper total).
 */
function describeDifference(left: unknown, right: unknown, path: string): string | null {
  if (left === right) {
    return null;
  }
  if (typeof left !== typeof right) {
    return `${path}：类型 ${typeLabel(left)} 与 ${typeLabel(right)} 不同`;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return `${path}：${displayValue(left)} 与 ${displayValue(right)} 不相等（按 binary64 逐分量精确比较，无容差）`;
  }
  if (left === null || right === null) {
    return `${path}：${displayValue(left)} 与 ${displayValue(right)} 不同`;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return `${path}：数组与非数组不同`;
    }
    if (left.length !== right.length) {
      return `${path}：数组长度 ${left.length} 与 ${right.length} 不同`;
    }
    for (let index = 0; index < left.length; index += 1) {
      const child = describeDifference(left[index], right[index], `${path}[${index}]`);
      if (child !== null) {
        return child;
      }
    }
    return null;
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort(compareId);
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(leftRecord, key)) {
        return `${path}.${key}：冻结快照含该成员，source_graph 缺失`;
      }
      if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) {
        return `${path}.${key}：source_graph 含该成员，冻结快照缺失`;
      }
      const child = describeDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
      if (child !== null) {
        return child;
      }
    }
    return null;
  }
  return `${path}：${displayValue(left)} 与 ${displayValue(right)} 不同`;
}

/**
 * Compare a received `source_graph` with the expected snapshot (usually the
 * frozen POST body re-parsed from its exact bytes).
 *
 * Both sides are semantically projected first, so node-array order,
 * adjacency neighbour order, reference-image order and numeric literal form
 * (`7` vs `7.0`) are irrelevant. Every projected value then compares exactly:
 * canonical-JSON equality implies identical binary64 components (`-0` equals
 * `0`). A change as small as 1e-4 in a large coordinate frame is detected.
 */
export function compareSourceGraph(sourceGraph: unknown, expected: unknown): SemanticComparison {
  let projectedReceived: unknown;
  let projectedExpected: unknown;
  try {
    projectedReceived = projectSemantics(sourceGraph);
    projectedExpected = projectSemantics(expected);
  } catch (error) {
    return { equivalent: false, reason: `语义投影失败：${errorMessage(error)}` };
  }

  let receivedCanonical: string;
  let expectedCanonical: string;
  try {
    receivedCanonical = canonicalize(projectedReceived);
    expectedCanonical = canonicalize(projectedExpected);
  } catch (error) {
    return { equivalent: false, reason: `无法规范序列化 source_graph：${errorMessage(error)}` };
  }

  if (receivedCanonical === expectedCanonical) {
    return {
      equivalent: true,
      reason:
        'source_graph 与冻结快照语义等价（nodes 按 id、邻接邻居数组、参考图 ID 已排序；数值逐分量精确相等）',
    };
  }

  const detail =
    describeDifference(projectedReceived, projectedExpected, '$') ??
    '规范化序列化不同但未定位到差异';
  return {
    equivalent: false,
    reason: `source_graph 与冻结快照语义不等价：${detail}`,
  };
}

/**
 * semantic_digest of an arbitrary source graph (projection -> JCS -> SHA-256).
 * Identical semantic content yields the identical digest.
 */
export async function semanticDigestOf(sourceGraph: unknown): Promise<string> {
  return sha256HexUtf8(canonicalize(projectSemantics(sourceGraph)));
}
