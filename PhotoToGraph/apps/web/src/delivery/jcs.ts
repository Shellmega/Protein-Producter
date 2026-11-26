/**
 * ptg-jcs-1 canonical JSON: RFC 8785 serialization of the frozen semantic
 * projection, plus the SHA-256 helpers used by the delivery layer.
 *
 * Contract sources (frozen, read-only):
 * - `spec.md` §6.1 (ptg-jcs-1): semantic projection steps 1-4, object member
 *   keys ordered by ascending UTF-16 code units, ECMAScript shortest
 *   round-trip number formatting (`-0` -> `0`), JSON.stringify-compatible
 *   string escaping.
 * - `rules.json` `canonicalization` and `vectors/jcs_vectors.json` (golden
 *   values replayed by `jcs.test.ts`).
 *
 * The semantic projection lives in this module and is re-exported by
 * `semantic.ts`: `semanticDigest`, `semanticDigestOf` and
 * `compareSourceGraph` must all start from the EXACT same projection, and
 * keeping the projection next to the serializer avoids a circular import
 * between `jcs.ts` and `semantic.ts`.
 *
 * Number formatting note: `JSON.stringify(number)` implements ECMAScript
 * `Number::toString` (shortest round-trip), which is exactly what RFC 8785
 * requires; it writes `-0` as `0`, `1e-6` as `0.000001`, `1e-7` as `1e-7` and
 * `1e21` as `1e+21`. Non-finite numbers are not JSON data and are rejected.
 */

import { sha256Hex } from '../persistence/record';

type JsonRecord = Record<string, unknown>;

/* ------------------------------------------------------------------------- */
/* Semantic projection (ptg-jcs-1 §6.1 steps 1-4)                            */
/* ------------------------------------------------------------------------- */

const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep copy a JSON value; throws for values that are not JSON data. */
function cloneJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item));
  }
  if (!isRecord(value)) {
    throw new TypeError('语义投影只支持 JSON 对象与数组');
  }
  const out: JsonRecord = {};
  for (const key of Object.keys(value)) {
    out[key] = cloneJson(value[key]);
  }
  return out;
}

function nodeIdOf(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value.id;
  return typeof id === 'string' ? id : null;
}

/**
 * Step 1: `nodes` sorted ascending by node id, each node staying bound to its
 * own `position` (the whole node object moves, its components do not).
 */
function projectNodes(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return cloneJson(value);
  }
  const entries = value.map((node, index) => ({
    node: cloneJson(node),
    id: nodeIdOf(node),
    index,
  }));
  entries.sort((left, right) => {
    if (left.id === null || right.id === null) {
      return left.index - right.index;
    }
    return compareId(left.id, right.id) || left.index - right.index;
  });
  return entries.map((entry) => entry.node);
}

/**
 * Step 2 / 3: an id array sorted ascending. Only arrays whose elements are all
 * strings (node ids / reference image ids) are reordered; a malformed array is
 * copied as-is so the projection never invents an order.
 */
function projectIdArray(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return cloneJson(value);
  }
  const copy = value.map((item) => cloneJson(item));
  if (copy.every((item) => typeof item === 'string')) {
    return (copy as string[]).sort(compareId);
  }
  return copy;
}

function projectAdjacency(value: unknown): unknown {
  if (!isRecord(value)) {
    return cloneJson(value);
  }
  const out: JsonRecord = {};
  for (const key of Object.keys(value)) {
    out[key] = projectIdArray(value[key]);
  }
  return out;
}

function projectSource(value: unknown): unknown {
  if (!isRecord(value)) {
    return cloneJson(value);
  }
  const out: JsonRecord = {};
  for (const key of Object.keys(value)) {
    out[key] = key === 'reference_image_ids' ? projectIdArray(value[key]) : cloneJson(value[key]);
  }
  return out;
}

/**
 * ptg-jcs-1 semantic projection of a parsed `ptg-graph/1.0` request document.
 *
 * 1. `nodes` sorted by id (node and position stay bound);
 * 2. each `adjacency` neighbour array sorted by id;
 * 3. `source.reference_image_ids` sorted by id;
 * 4. every other member keeps its semantic position (array order and position
 *    component order are preserved).
 *
 * Object member order is irrelevant: the JCS serializer sorts member names.
 * The input is never mutated; every result is a fresh JSON value.
 */
export function projectSemantics(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return cloneJson(payload);
  }
  const out: JsonRecord = {};
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    if (key === 'nodes') {
      out[key] = projectNodes(value);
    } else if (key === 'adjacency') {
      out[key] = projectAdjacency(value);
    } else if (key === 'source') {
      out[key] = projectSource(value);
    } else {
      out[key] = cloneJson(value);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* RFC 8785 canonical serialization                                          */
/* ------------------------------------------------------------------------- */

class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function numberLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(`规范 JSON 不接受非有限数 ${String(value)}`);
  }
  // ECMAScript Number::toString via JSON.stringify: shortest round-trip form,
  // `-0` written as `0` (RFC 8785 §3.2.2.3 and spec §6.1).
  return JSON.stringify(value) as string;
}

function stringLiteral(value: string): string {
  // Same well-formed escaping as ECMAScript JSON.stringify (ES2019+), which
  // RFC 8785 adopts: only control characters, `"` and `\` are escaped; `/` is
  // not escaped; non-ASCII code points are emitted as-is.
  return JSON.stringify(value) as string;
}

function serializeArray(value: readonly unknown[], seen: ReadonlySet<object>): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      throw new CanonicalJsonError('规范 JSON 不接受稀疏数组空位');
    }
    parts.push(serialize(value[index], seen));
  }
  return `[${parts.join(',')}]`;
}

function serializeObject(value: object, seen: ReadonlySet<object>): string {
  if (!isRecord(value)) {
    throw new CanonicalJsonError('规范 JSON 只接受普通 JSON 对象');
  }
  const parts: string[] = [];
  // Ascending UTF-16 code unit order (the default JS string order).
  for (const key of Object.keys(value).sort(compareId)) {
    parts.push(`${stringLiteral(key)}:${serialize(value[key], seen)}`);
  }
  return `{${parts.join(',')}}`;
}

function serialize(value: unknown, seen: ReadonlySet<object>): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return numberLiteral(value);
    case 'string':
      return stringLiteral(value);
    case 'object': {
      if (seen.has(value)) {
        throw new CanonicalJsonError('规范 JSON 不接受循环引用');
      }
      const next = new Set(seen);
      next.add(value);
      if (Array.isArray(value)) {
        return serializeArray(value, next);
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalJsonError('规范 JSON 只接受普通 JSON 对象');
      }
      return serializeObject(value, next);
    }
    default:
      throw new CanonicalJsonError(`类型 ${typeof value} 不能序列化为规范 JSON`);
  }
}

/**
 * RFC 8785 / ptg-jcs-1 canonical JSON of an already-parsed JSON value.
 *
 * - object member keys sorted by ascending UTF-16 code units;
 * - ECMAScript shortest round-trip number literals (`-0` -> `0`);
 * - JSON.stringify-compatible string escaping;
 * - no whitespace; array order preserved.
 *
 * Throws `TypeError` for values that are not JSON data (undefined, functions,
 * symbols, bigint, non-finite numbers, class instances, cycles, sparse arrays).
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new Set<object>());
}

/* ------------------------------------------------------------------------- */
/* Digests                                                                    */
/* ------------------------------------------------------------------------- */

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text` (Web Crypto). */
export async function sha256HexUtf8(text: string): Promise<string> {
  return sha256Hex(text);
}

/**
 * semantic_digest (spec §6.1): semantic projection -> JCS UTF-8 -> SHA-256.
 * Used for content identity; every change of a single binary64 component
 * produces a different digest (no tolerance; `-0` and `0` are the same value).
 */
export async function semanticDigest(value: unknown): Promise<string> {
  return sha256HexUtf8(canonicalize(projectSemantics(value)));
}
