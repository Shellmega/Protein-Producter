/**
 * Client-side implementation of the frozen ptg-graph/1.0 validation pipeline.
 *
 * Scope: the request *body* this app builds from its own committed graph state.
 * Raw-byte concerns (transport, strict syntax, headers, identity/conflicts) are
 * not re-implemented here; they belong to the receiving service (PTG-4/5) and
 * to local persistence diagnostics, which use separate LOCAL_* codes.
 *
 * Frozen ordering (contracts/ptg-graph/v1/rules.json):
 * - `stages`: version (2) -> structure (4) -> graph (5) -> geometry (6) ->
 *   topology (7).
 * - structure first error: `field_order`, then error-code priority, then field
 *   text (`first_error_scope.structure`).
 * - graph/geometry/topology first error: `semantic_checks` order; `field_order`
 *   does not apply (R-07). `field` stays an input location, `node_ids` are
 *   sorted ascending and de-duplicated (R-02).
 */

import { coincident } from '../domain/geometry';
import {
  COORDINATE_SYSTEM_KEYS,
  ERROR_PRIORITY,
  FIELD_FALLBACK_RANK,
  FIELD_ORDER,
  ID_PATTERN,
  MAX_ABS_COORD,
  MAX_ID_LENGTH,
  MAX_NODE_COUNT,
  MAX_REFERENCE_IMAGE_IDS,
  MAX_REVISION,
  MIN_NODE_COUNT,
  NODE_KEYS,
  PRODUCER,
  PROFILE,
  SOURCE_KEYS,
  WIRE_KEYS,
  WIRE_VERSION,
  type ContractError,
  type ContractStage,
  type ValidationIssue,
  type WireCandidate,
  type WireNode,
  type WireRequest,
} from './types';

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(
  stage: ContractStage,
  code: string,
  field: string,
  nodeIds: string[],
  message: string,
): ValidationIssue {
  return { code, field, node_ids: uniqueSorted(nodeIds), message, stage };
}

function uniqueSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `rules.field_order` rank for a concrete field path (structure stage only). */
export function fieldRank(field: string): number {
  const exact = FIELD_ORDER.indexOf(field as (typeof FIELD_ORDER)[number]);
  if (exact >= 0) {
    return exact;
  }
  if (/^nodes\[\d+\]\.position\[\d+\]$/.test(field)) {
    return FIELD_ORDER.indexOf('nodes[*].position[*]');
  }
  if (/^nodes\[\d+\]\.position$/.test(field)) {
    return FIELD_ORDER.indexOf('nodes[*].position');
  }
  if (/^nodes\[\d+\]\.id$/.test(field)) {
    return FIELD_ORDER.indexOf('nodes[*].id');
  }
  if (/^adjacency\..+\[\d+\]$/.test(field)) {
    return FIELD_ORDER.indexOf('adjacency.*[*]');
  }
  if (/^adjacency\..+$/.test(field)) {
    return FIELD_ORDER.indexOf('adjacency.*');
  }
  return FIELD_FALLBACK_RANK;
}

function compareStructureIssues(a: ValidationIssue, b: ValidationIssue): number {
  const rankDelta = fieldRank(a.field) - fieldRank(b.field);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  const priorityDelta =
    (ERROR_PRIORITY[a.code] ?? 999) - (ERROR_PRIORITY[b.code] ?? 999);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return a.field < b.field ? -1 : a.field > b.field ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Structure helpers
// ---------------------------------------------------------------------------

function idIssue(
  stage: ContractStage,
  field: string,
  value: unknown,
  message: string,
  nodeIds: string[] = [],
): ValidationIssue | null {
  if (typeof value !== 'string') {
    return issue(stage, 'FIELD_INVALID', field, nodeIds, `${message}：必须是字符串`);
  }
  if (value.length < 1 || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    return issue(
      stage,
      'FIELD_INVALID',
      field,
      nodeIds,
      `${message}：长度须为 1–${MAX_ID_LENGTH}，首字符为 ASCII 字母或数字，其余仅限字母、数字、点、下划线、连字符`,
    );
  }
  return null;
}

function checkUnknownMembers(
  value: JsonObject,
  allowed: readonly string[],
  prefix: string,
  stage: ContractStage,
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const field = prefix === '' ? key : `${prefix}.${key}`;
      out.push(
        issue(stage, 'FIELD_UNKNOWN', field, [], `存在契约未允许的成员 ${field}；请求只允许 schema 字段`),
      );
    }
  }
  return out;
}

function checkReferenceImageIds(value: unknown): ValidationIssue[] {
  const field = 'source.reference_image_ids';
  if (!Array.isArray(value)) {
    return [issue('structure', 'FIELD_INVALID', field, [], '参考图来源 ID 必须是数组')];
  }
  const out: ValidationIssue[] = [];
  if (value.length > MAX_REFERENCE_IMAGE_IDS) {
    out.push(
      issue(
        'structure',
        'FIELD_INVALID',
        field,
        [],
        `参考图来源 ID 最多 ${MAX_REFERENCE_IMAGE_IDS} 个，当前 ${value.length} 个`,
      ),
    );
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const locator = `${field}[${index}]`;
    const invalid = idIssue('structure', locator, item, '参考图来源 ID');
    if (invalid) {
      out.push(invalid);
      return;
    }
    const id = item as string;
    if (seen.has(id)) {
      out.push(
        issue('structure', 'FIELD_INVALID', locator, [], `参考图来源 ID ${id} 重复；数组元素必须唯一`),
      );
    }
    seen.add(id);
  });
  return out;
}

function checkSource(value: unknown): ValidationIssue[] {
  if (!isPlainObject(value)) {
    return [issue('structure', 'FIELD_INVALID', 'source', [], 'source 必须是对象')];
  }
  const out = checkUnknownMembers(value, SOURCE_KEYS, 'source', 'structure');
  if (!('kind' in value)) {
    out.push(issue('structure', 'FIELD_INVALID', 'source.kind', [], '缺少必需字段 source.kind'));
  } else if (value.kind !== 'interactive_3d') {
    out.push(
      issue('structure', 'FIELD_INVALID', 'source.kind', [], 'source.kind 必须为 interactive_3d'),
    );
  }
  if (!('reference_image_ids' in value)) {
    out.push(
      issue('structure', 'FIELD_INVALID', 'source.reference_image_ids', [], '缺少必需字段 source.reference_image_ids'),
    );
  } else {
    out.push(...checkReferenceImageIds(value.reference_image_ids));
  }
  return out;
}

function checkCoordinateSystem(value: unknown): ValidationIssue[] {
  const prefix = 'coordinate_system';
  if (!isPlainObject(value)) {
    return [issue('structure', 'FIELD_INVALID', prefix, [], 'coordinate_system 必须是对象')];
  }
  const out = checkUnknownMembers(value, COORDINATE_SYSTEM_KEYS, prefix, 'structure');
  if (!('frame_id' in value)) {
    out.push(issue('structure', 'FIELD_INVALID', `${prefix}.frame_id`, [], '缺少必需字段 coordinate_system.frame_id'));
  } else {
    const invalid = idIssue('structure', `${prefix}.frame_id`, value.frame_id, '坐标框架标识');
    if (invalid) {
      out.push(invalid);
    }
  }
  const constants: [string, string, unknown][] = [
    [`${prefix}.dimension`, 'dimension', 3],
    [`${prefix}.unit`, 'unit', 'scene_unit'],
    [`${prefix}.handedness`, 'handedness', 'right'],
    [`${prefix}.axes`, 'axes', 'xyz'],
  ];
  for (const [field, key, expected] of constants) {
    if (!(key in value)) {
      out.push(issue('structure', 'FIELD_INVALID', field, [], `缺少必需字段 ${field}`));
    } else if (value[key] !== expected) {
      out.push(
        issue('structure', 'FIELD_INVALID', field, [], `${field} 必须为 ${JSON.stringify(expected)}`),
      );
    }
  }
  return out;
}

function checkNodePosition(value: unknown, index: number): ValidationIssue[] {
  const field = `nodes[${index}].position`;
  if (!Array.isArray(value)) {
    return [issue('structure', 'FIELD_INVALID', field, [], 'position 必须是 3 个数的数组')];
  }
  if (value.length !== 3) {
    return [
      issue('structure', 'FIELD_INVALID', field, [], `position 必须恰有 3 个分量，当前 ${value.length} 个`),
    ];
  }
  const out: ValidationIssue[] = [];
  value.forEach((component, axis) => {
    const locator = `${field}[${axis}]`;
    if (typeof component !== 'number') {
      out.push(issue('structure', 'FIELD_INVALID', locator, [], `${locator} 必须是数值`));
      return;
    }
    if (!Number.isFinite(component) || Math.abs(component) > MAX_ABS_COORD) {
      out.push(
        issue(
          'structure',
          'COORDINATE_INVALID',
          locator,
          [],
          `${locator} 必须是绝对值不超过 ${MAX_ABS_COORD} 的有限数，当前 ${String(component)}`,
        ),
      );
    }
  });
  return out;
}

function checkNodes(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) {
    return [issue('structure', 'FIELD_INVALID', 'nodes', [], 'nodes 必须是数组')];
  }
  const out: ValidationIssue[] = [];
  if (value.length < MIN_NODE_COUNT || value.length > MAX_NODE_COUNT) {
    out.push(
      issue(
        'structure',
        'NODE_COUNT_LIMIT',
        'nodes',
        [],
        `结点数必须在 ${MIN_NODE_COUNT}–${MAX_NODE_COUNT} 之间，当前 ${value.length} 个`,
      ),
    );
  }
  value.forEach((node, index) => {
    const prefix = `nodes[${index}]`;
    if (!isPlainObject(node)) {
      out.push(issue('structure', 'FIELD_INVALID', prefix, [], `${prefix} 必须是对象`));
      return;
    }
    out.push(...checkUnknownMembers(node, NODE_KEYS, prefix, 'structure'));
    const idInvalid = 'id' in node
      ? idIssue('structure', `${prefix}.id`, node.id, '结点标识')
      : issue('structure', 'FIELD_INVALID', `${prefix}.id`, [], `缺少必需字段 ${prefix}.id`);
    if (idInvalid) {
      out.push(idInvalid);
      if (!('position' in node)) {
        out.push(
          issue('structure', 'FIELD_INVALID', `${prefix}.position`, [], `缺少必需字段 ${prefix}.position`),
        );
      } else {
        out.push(...checkNodePosition(node.position, index));
      }
      return;
    }
    const nodeId = node.id as string;
    if (!('position' in node)) {
      // A node identifiable by id but without a position is reported with its
      // id; frozen case invalid-missing-node-position does the same.
      out.push(
        issue(
          'structure',
          'FIELD_INVALID',
          `${prefix}.position`,
          [nodeId],
          `结点 ${nodeId} 缺少必需字段 position`,
        ),
      );
      return;
    }
    out.push(...checkNodePosition(node.position, index));
  });
  return out;
}

function checkAdjacency(value: unknown): ValidationIssue[] {
  if (!isPlainObject(value)) {
    return [issue('structure', 'FIELD_INVALID', 'adjacency', [], 'adjacency 必须是对象')];
  }
  const out: ValidationIssue[] = [];
  const keys = Object.keys(value);
  if (keys.length < MIN_NODE_COUNT || keys.length > MAX_NODE_COUNT) {
    out.push(
      issue(
        'structure',
        'FIELD_INVALID',
        'adjacency',
        [],
        `adjacency 键数必须在 ${MIN_NODE_COUNT}–${MAX_NODE_COUNT} 之间，当前 ${keys.length} 个`,
      ),
    );
  }
  for (const key of keys.sort()) {
    const field = `adjacency.${key}`;
    if (!ID_PATTERN.test(key)) {
      out.push(issue('structure', 'FIELD_INVALID', field, [], `邻接键 ${key} 不是合法标识符`));
      continue;
    }
    const neighbours = value[key];
    if (!Array.isArray(neighbours)) {
      out.push(issue('structure', 'FIELD_INVALID', field, [], `${field} 必须是邻居数组`));
      continue;
    }
    neighbours.forEach((neighbour, index) => {
      const locator = `${field}[${index}]`;
      const invalid = idIssue('structure', locator, neighbour, '邻居标识');
      if (invalid) {
        out.push(invalid);
      }
    });
  }
  return out;
}

/**
 * Structure-stage checks (stage order 4). `schema_version`/`profile` are stage 2
 * and are checked by `checkVersion`; a missing one is reported there.
 */
export function checkStructure(value: unknown): ValidationIssue[] {
  if (!isPlainObject(value)) {
    return [
      issue('structure', 'FIELD_INVALID', '$', [], '请求体必须是 JSON 对象'),
    ];
  }
  const out: ValidationIssue[] = [];
  out.push(...checkUnknownMembers(value, WIRE_KEYS, '', 'structure'));

  if (!('producer' in value)) {
    out.push(issue('structure', 'FIELD_INVALID', 'producer', [], '缺少必需字段 producer'));
  } else if (value.producer !== PRODUCER) {
    out.push(
      issue('structure', 'FIELD_INVALID', 'producer', [], `producer 必须为 ${PRODUCER}`),
    );
  }

  for (const [field, key] of [
    ['producer_instance_id', 'producer_instance_id'],
    ['graph_id', 'graph_id'],
  ] as const) {
    if (!(key in value)) {
      out.push(issue('structure', 'FIELD_INVALID', field, [], `缺少必需字段 ${field}`));
      continue;
    }
    const invalid = idIssue('structure', field, value[key], field === 'graph_id' ? '图标识' : '生产者实例标识');
    if (invalid) {
      out.push(invalid);
    }
  }

  if (!('revision' in value)) {
    out.push(issue('structure', 'FIELD_INVALID', 'revision', [], '缺少必需字段 revision'));
  } else {
    const revision = value.revision;
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision > MAX_REVISION
    ) {
      out.push(
        issue(
          'structure',
          'FIELD_INVALID',
          'revision',
          [],
          `revision 必须是 1–${MAX_REVISION} 的整数`,
        ),
      );
    }
  }

  if (!('source' in value)) {
    out.push(issue('structure', 'FIELD_INVALID', 'source', [], '缺少必需字段 source'));
  } else {
    out.push(...checkSource(value.source));
  }

  if (!('coordinate_system' in value)) {
    out.push(issue('structure', 'FIELD_INVALID', 'coordinate_system', [], '缺少必需字段 coordinate_system'));
  } else {
    out.push(...checkCoordinateSystem(value.coordinate_system));
  }

  if (!('nodes' in value)) {
    out.push(issue('structure', 'FIELD_INVALID', 'nodes', [], '缺少必需字段 nodes'));
  } else {
    out.push(...checkNodes(value.nodes));
  }

  if (!('adjacency' in value)) {
    out.push(issue('structure', 'FIELD_INVALID', 'adjacency', [], '缺少必需字段 adjacency'));
  } else {
    out.push(...checkAdjacency(value.adjacency));
  }

  if (!('n_terminal_node' in value)) {
    out.push(issue('structure', 'FIELD_INVALID', 'n_terminal_node', [], '缺少必需字段 n_terminal_node'));
  } else {
    const invalid = idIssue('structure', 'n_terminal_node', value.n_terminal_node, 'N 端起点');
    if (invalid) {
      out.push(invalid);
    }
  }

  return out.sort(compareStructureIssues);
}

/** Version stage (order 2): `schema_version`, then `profile`. */
export function checkVersion(value: unknown): ValidationIssue | null {
  if (!isPlainObject(value)) {
    return null;
  }
  if (value.schema_version !== WIRE_VERSION) {
    return issue(
      'version',
      'SCHEMA_UNSUPPORTED',
      'schema_version',
      [],
      `schema_version 必须为 ${WIRE_VERSION}`,
    );
  }
  if (value.profile !== PROFILE) {
    return issue(
      'version',
      'PROFILE_UNSUPPORTED',
      'profile',
      [],
      `profile 必须为 ${PROFILE}`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Graph / geometry / topology stages (semantic_checks order 1..11)
// ---------------------------------------------------------------------------

export interface GraphSemanticInput {
  /** Nodes in the array order being validated (array order is serialization only). */
  nodes: { id: string; position: [number, number, number] }[];
  /** Neighbour arrays exactly as supplied; order is not semantic. */
  adjacency: Record<string, string[]>;
  n_terminal_node: string | null;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function degrees(adjacency: Record<string, string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, neighbours] of Object.entries(adjacency)) {
    out[key] = neighbours.length;
  }
  return out;
}

/** First node id (ascending) whose neighbour array lists `predicate` values. */
function firstNodeWith(
  ids: readonly string[],
  adjacency: Record<string, string[]>,
  predicate: (node: string, neighbours: string[]) => boolean,
): string | null {
  for (const id of ids) {
    if (predicate(id, adjacency[id] ?? [])) {
      return id;
    }
  }
  return null;
}

/**
 * Run the frozen semantic checks in order and return the FIRST failing check
 * (empty array when the graph is a valid `protein_open_chain_v1` chain).
 *
 * Structural validity is a precondition: callers must run the structure stage
 * first when they need a contract conclusion. This function is also used for
 * secondary diagnostics on saved drafts, so it tolerates a null N terminal.
 */
export function validateGraphSemantics(input: GraphSemanticInput): ValidationIssue[] {
  const ids = input.nodes.map((node) => node.id);
  const order = [...ids].sort(byId);
  const adjacency = input.adjacency;
  const idSet = new Set(ids);

  // 1. node_id_unique -> NODE_ID_DUPLICATE, field nodes, located by node_ids
  const counts = new Map<string, number>();
  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const duplicated = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(byId);
  if (duplicated.length > 0) {
    return [
      issue(
        'graph',
        'NODE_ID_DUPLICATE',
        'nodes',
        [duplicated[0]],
        `结点标识 ${duplicated[0]} 重复；图内结点 ID 必须唯一`,
      ),
    ];
  }

  // 2. adjacency_key_set -> ADJACENCY_KEYS (extra keys first, then missing ids)
  const adjacencyKeys = Object.keys(adjacency);
  const keySet = new Set(adjacencyKeys);
  const unexpected = adjacencyKeys.filter((key) => !idSet.has(key)).sort(byId);
  if (unexpected.length > 0) {
    return [
      issue(
        'graph',
        'ADJACENCY_KEYS',
        `adjacency.${unexpected[0]}`,
        [unexpected[0]],
        `邻接表含结点集合之外的键 ${unexpected[0]}`,
      ),
    ];
  }
  const missing = order.filter((id) => !keySet.has(id));
  if (missing.length > 0) {
    return [
      issue(
        'graph',
        'ADJACENCY_KEYS',
        'adjacency',
        missing,
        `邻接表缺少结点 ${missing.join(', ')} 的键`,
      ),
    ];
  }

  // 3. neighbour_reference_exists -> UNKNOWN_NODE
  let unknownPick: { node: string; neighbour: string; index: number } | null = null;
  for (const node of order) {
    const neighbours = adjacency[node] ?? [];
    const unknowns = neighbours
      .map((neighbour, index) => ({ neighbour, index }))
      .filter((entry) => !idSet.has(entry.neighbour))
      .sort((a, b) => byId(a.neighbour, b.neighbour) || a.index - b.index);
    const first = unknowns[0];
    if (!first) {
      continue;
    }
    if (unknownPick === null) {
      unknownPick = { node, neighbour: first.neighbour, index: first.index };
      continue;
    }
    // Smallest (referencing node id, unknown neighbour id) pair wins, even if a
    // later array position has the same pair.
  }
  if (unknownPick) {
    return [
      issue(
        'graph',
        'UNKNOWN_NODE',
        `adjacency.${unknownPick.node}[${unknownPick.index}]`,
        [unknownPick.node, unknownPick.neighbour],
        `邻接表引用了不存在的结点 ${unknownPick.neighbour}（位于 ${unknownPick.node} 的邻居表）`,
      ),
    ];
  }

  // 4. neighbour_not_duplicated -> EDGE_DUPLICATE
  const duplicatedNeighbourNode = firstNodeWith(order, adjacency, (_node, neighbours) => {
    const seen = new Set<string>();
    return neighbours.some((neighbour) => {
      if (seen.has(neighbour)) {
        return true;
      }
      seen.add(neighbour);
      return false;
    });
  });
  if (duplicatedNeighbourNode) {
    const neighbours = adjacency[duplicatedNeighbourNode] ?? [];
    const seen = new Set<string>();
    let duplicatedNeighbour = '';
    for (const neighbour of neighbours) {
      if (seen.has(neighbour)) {
        duplicatedNeighbour = neighbour;
        break;
      }
      seen.add(neighbour);
    }
    return [
      issue(
        'graph',
        'EDGE_DUPLICATE',
        `adjacency.${duplicatedNeighbourNode}`,
        [duplicatedNeighbourNode, duplicatedNeighbour],
        `邻接表重复列出邻居 ${duplicatedNeighbour}（结点 ${duplicatedNeighbourNode}）；无向边必须唯一`,
      ),
    ];
  }

  // 5. no_self_loop -> SELF_LOOP
  const selfLoopNode = firstNodeWith(order, adjacency, (node, neighbours) =>
    neighbours.includes(node),
  );
  if (selfLoopNode) {
    return [
      issue('graph', 'SELF_LOOP', `adjacency.${selfLoopNode}`, [selfLoopNode], `结点 ${selfLoopNode} 不能连接自身`),
    ];
  }

  // 6. adjacency_symmetric -> ADJACENCY_ASYMMETRIC
  for (const node of order) {
    const neighbours = [...(adjacency[node] ?? [])].sort(byId);
    for (const neighbour of neighbours) {
      const reverse = adjacency[neighbour] ?? [];
      if (!reverse.includes(node)) {
        return [
          issue(
            'graph',
            'ADJACENCY_ASYMMETRIC',
            `adjacency.${node}`,
            [node, neighbour],
            `邻接表不对称：${node} 列出 ${neighbour}，但 ${neighbour} 未列出 ${node}`,
          ),
        ];
      }
    }
  }

  // 7. no_coincident_control_points -> COINCIDENT_NODES
  for (let i = 0; i < input.nodes.length; i += 1) {
    for (let j = i + 1; j < input.nodes.length; j += 1) {
      if (coincident(input.nodes[i].position, input.nodes[j].position)) {
        return [
          issue(
            'geometry',
            'COINCIDENT_NODES',
            'nodes',
            [input.nodes[i].id, input.nodes[j].id],
            `结点 ${input.nodes[i].id} 与 ${input.nodes[j].id} 重合（平方距离判据，含 8u 余量）`,
          ),
        ];
      }
    }
  }

  const degree = degrees(adjacency);

  // 8. no_branch -> GRAPH_BRANCH
  for (const id of order) {
    if ((degree[id] ?? 0) > 2) {
      return [
        issue(
          'topology',
          'GRAPH_BRANCH',
          `adjacency.${id}`,
          [id],
          `结点 ${id} 的连接数为 ${degree[id]}，开放链要求每个结点连接数不超过 2`,
        ),
      ];
    }
  }

  // 9. connected -> GRAPH_DISCONNECTED (root: N terminal when known, else first id)
  const root =
    input.n_terminal_node !== null && idSet.has(input.n_terminal_node)
      ? input.n_terminal_node
      : order[0];
  const reached = new Set<string>();
  if (root !== undefined) {
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (reached.has(current)) {
        continue;
      }
      reached.add(current);
      for (const neighbour of adjacency[current] ?? []) {
        if (!reached.has(neighbour)) {
          queue.push(neighbour);
        }
      }
    }
  }
  const unreachable = order.filter((id) => !reached.has(id));
  if (unreachable.length > 0) {
    return [
      issue(
        'topology',
        'GRAPH_DISCONNECTED',
        'adjacency',
        unreachable,
        `图不连通：从 ${root ?? '起点'} 无法到达 ${unreachable.join(', ')}`,
      ),
    ];
  }

  // 10. open_chain_not_cycle -> GRAPH_CYCLE
  const endpoints = order.filter((id) => degree[id] === 1);
  const edgeCount = Object.values(degree).reduce((sum, value) => sum + value, 0) / 2;
  if (!(endpoints.length === 2 && edgeCount === ids.length - 1)) {
    return [
      issue(
        'topology',
        'GRAPH_CYCLE',
        'adjacency',
        order.length > 0 ? [order[0]] : [],
        `图不是开放链：需要恰有两个度为 1 的端点，当前 ${endpoints.length} 个端点、${edgeCount} 条边`,
      ),
    ];
  }

  // 11. n_terminal_is_endpoint -> N_TERMINAL_INVALID
  const terminal = input.n_terminal_node;
  if (terminal === null || !idSet.has(terminal)) {
    return [
      issue(
        'topology',
        'N_TERMINAL_INVALID',
        'n_terminal_node',
        terminal === null ? [] : [terminal],
        terminal === null ? '必须指定 N 端起点' : `N 端起点 ${terminal} 不在结点集合中`,
      ),
    ];
  }
  if (degree[terminal] !== 1) {
    return [
      issue(
        'topology',
        'N_TERMINAL_INVALID',
        'n_terminal_node',
        [terminal],
        `N 端 ${terminal} 的连接数为 ${degree[terminal]}；N 端必须是度为 1 的端点`,
      ),
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Building the wire candidate from committed app state
// ---------------------------------------------------------------------------

export interface DraftGraphState {
  identity: {
    producer_instance_id: string;
    graph_id: string;
    frame_id: string;
    revision: number;
    coordinate_system: {
      frame_id: string;
      dimension: 3;
      unit: 'scene_unit';
      handedness: 'right';
      axes: 'xyz';
    };
  };
  content: {
    nodes: { id: string; position: [number, number, number] }[];
    edges: [string, string][];
    n_terminal_node: string | null;
    source_reference_image_ids: string[];
  };
}

/**
 * Derive the adjacency map from the unique undirected edge set.
 *
 * Never drops or de-duplicates: an edge that references an unknown node or a
 * self loop must stay visible to the validator (no silent repair). Neighbour
 * arrays are sorted only because their order is not semantic.
 */
export function adjacencyFromEdges(
  nodes: readonly { id: string }[],
  edges: readonly [string, string][],
): Record<string, string[]> {
  const adjacency: Record<string, string[]> = {};
  for (const node of nodes) {
    adjacency[node.id] = [];
  }
  for (const [a, b] of edges) {
    if (!adjacency[a]) {
      adjacency[a] = [];
    }
    if (!adjacency[b]) {
      adjacency[b] = [];
    }
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  for (const key of Object.keys(adjacency)) {
    adjacency[key].sort(byId);
  }
  return adjacency;
}

/** Exact wire body candidate. Positions keep full binary64 values. */
export function buildRequestCandidate(draft: DraftGraphState): WireCandidate {
  const referenceIds = [...new Set(draft.content.source_reference_image_ids)].sort(byId);
  return {
    schema_version: WIRE_VERSION,
    profile: PROFILE,
    producer: PRODUCER,
    producer_instance_id: draft.identity.producer_instance_id,
    graph_id: draft.identity.graph_id,
    revision: draft.identity.revision,
    source: { kind: 'interactive_3d', reference_image_ids: referenceIds },
    coordinate_system: {
      frame_id: draft.identity.coordinate_system.frame_id,
      dimension: 3,
      unit: 'scene_unit',
      handedness: 'right',
      axes: 'xyz',
    },
    nodes: draft.content.nodes.map((node) => ({
      id: node.id,
      position: [node.position[0], node.position[1], node.position[2]],
    })),
    adjacency: adjacencyFromEdges(draft.content.nodes, draft.content.edges),
    n_terminal_node: draft.content.n_terminal_node,
  };
}

export interface RequestValidation {
  ok: boolean;
  /** Frozen first error across stages (structure wins over semantic). */
  error: ValidationIssue | null;
  structure: ValidationIssue[];
  semantic: ValidationIssue[];
  /** Typed wire body, present only when every stage passed. */
  payload: WireRequest | null;
}

/** Full pipeline over an already-parsed JSON value (version -> structure -> semantics). */
export function validateRequest(value: unknown): RequestValidation {
  const versionError = checkVersion(value);
  if (versionError) {
    return { ok: false, error: versionError, structure: [], semantic: [], payload: null };
  }
  const structure = checkStructure(value);
  if (structure.length > 0) {
    return { ok: false, error: structure[0], structure, semantic: [], payload: null };
  }
  const body = value as WireCandidate;
  const semantic = validateGraphSemantics({
    nodes: body.nodes,
    adjacency: body.adjacency,
    n_terminal_node: body.n_terminal_node,
  });
  if (semantic.length > 0) {
    return { ok: false, error: semantic[0], structure, semantic, payload: null };
  }
  return { ok: true, error: null, structure, semantic, payload: body as WireRequest };
}

export interface DraftExportValidation {
  ok: boolean;
  /** Frozen first error for the export attempt. */
  primary: ValidationIssue | null;
  /** First graph-semantic error even when structure fails first (secondary UI diagnostic). */
  semantic: ValidationIssue | null;
  structure: ValidationIssue[];
  candidate: WireCandidate;
  payload: WireRequest | null;
}

/**
 * Validate the export attempt for the editor's own committed state.
 *
 * `primary` is the frozen first error (structure beats semantics because stage 4
 * precedes stage 5). `semantic` is always the first graph/geometry/topology
 * error, so a draft that is both structurally incomplete and topologically
 * invalid still reports where the graph itself is wrong.
 */
export function validateDraftForExport(draft: DraftGraphState): DraftExportValidation {
  const candidate = buildRequestCandidate(draft);
  const versionError = checkVersion(candidate);
  const structure = versionError ? [] : checkStructure(candidate);
  const semanticIssues = validateGraphSemantics({
    nodes: candidate.nodes,
    adjacency: candidate.adjacency,
    n_terminal_node: candidate.n_terminal_node,
  });
  const semantic = semanticIssues[0] ?? null;
  const primary = versionError ?? structure[0] ?? semantic;
  const ok = primary === null;
  return {
    ok,
    primary,
    semantic,
    structure,
    candidate,
    payload: ok ? (candidate as WireRequest) : null,
  };
}

/** Convert a validation issue to the wire error document shape. */
export function toContractError(value: ValidationIssue | null): ContractError | null {
  if (!value) {
    return null;
  }
  return {
    code: value.code,
    message: value.message,
    node_ids: [...value.node_ids],
    field: value.field,
  };
}

/** Selected node ids for a graph-semantic issue, used for UI object selection. */
export function selectableNodeIds(value: ValidationIssue | null): string[] {
  return value ? [...value.node_ids] : [];
}

export type { WireNode };
