/**
 * Frozen ptg-graph/1.0 wire contract constants and types used by this app.
 *
 * Source of truth: contracts/ptg-graph/v1 (content version
 * `ptg-graph/1.0-draft.gtp.5`, content digest
 * e4589348c39155f06a9dadabb2ec054630450d9e1fbd0a7a3a9529e6309ac1e5, wire
 * `ptg-graph/1.0`, profile `protein_open_chain_v1`, FROZEN/CONFIRMED).
 *
 * This module only declares frozen values. It never mutates the contract copy.
 */

export const WIRE_VERSION = 'ptg-graph/1.0' as const;
export const CONTENT_VERSION = 'ptg-graph/1.0-draft.gtp.5' as const;
export const CONTENT_DIGEST =
  'e4589348c39155f06a9dadabb2ec054630450d9e1fbd0a7a3a9529e6309ac1e5' as const;
export const PROFILE = 'protein_open_chain_v1' as const;
export const PRODUCER = 'PhotoToGraph' as const;

export const MIN_NODE_COUNT = 2;
export const MAX_NODE_COUNT = 2048;
export const MAX_ABS_COORD = 1_000_000;
export const MAX_REVISION = 9_007_199_254_740_991; // 2^53-1
export const MAX_REFERENCE_IMAGE_IDS = 64;
export const MAX_ID_LENGTH = 128;
export const MAX_BODY_BYTES = 1_048_576; // decoded UTF-8 request body limit
export const MAX_JSON_DEPTH = 64;

/** Frozen identifier rule: 1..128 chars, ASCII alnum first, then alnum . _ - */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `rules.field_order`, in order. Index is the frozen rank used for structure errors. */
export const FIELD_ORDER = [
  '$',
  'schema_version',
  'profile',
  'producer',
  'producer_instance_id',
  'graph_id',
  'revision',
  'source',
  'source.kind',
  'source.reference_image_ids',
  'coordinate_system',
  'coordinate_system.frame_id',
  'coordinate_system.dimension',
  'coordinate_system.unit',
  'coordinate_system.handedness',
  'coordinate_system.axes',
  'nodes',
  'nodes[*].id',
  'nodes[*].position',
  'nodes[*].position[*]',
  'adjacency',
  'adjacency.*',
  'adjacency.*[*]',
  'n_terminal_node',
  'headers.Idempotency-Key',
] as const;

/** Rank used for a field that the frozen `field_order` does not name (unknown members). */
export const FIELD_FALLBACK_RANK = 24;

/** `rules.error_registry` priority values for the codes this client can report. */
export const ERROR_PRIORITY: Readonly<Record<string, number>> = {
  JSON_SYNTAX: 10,
  DUPLICATE_JSON_KEY: 11,
  NUMBER_NOT_REPRESENTABLE: 12,
  BODY_TOO_DEEP: 13,
  CONTENT_ENCODING_UNSUPPORTED: 14,
  UNSUPPORTED_MEDIA_TYPE: 15,
  BODY_TOO_LARGE: 16,
  SCHEMA_UNSUPPORTED: 20,
  PROFILE_UNSUPPORTED: 21,
  IDEMPOTENCY_KEY_INVALID: 22,
  FIELD_INVALID: 30,
  FIELD_UNKNOWN: 31,
  COORDINATE_INVALID: 32,
  NODE_COUNT_LIMIT: 33,
  NODE_ID_DUPLICATE: 40,
  ADJACENCY_KEYS: 41,
  UNKNOWN_NODE: 42,
  EDGE_DUPLICATE: 43,
  SELF_LOOP: 44,
  ADJACENCY_ASYMMETRIC: 45,
  COINCIDENT_NODES: 50,
  GRAPH_BRANCH: 60,
  GRAPH_DISCONNECTED: 61,
  GRAPH_CYCLE: 62,
  N_TERMINAL_INVALID: 63,
};

export type WireErrorCode = keyof typeof ERROR_PRIORITY extends never
  ? never
  : string;

export type ContractStage =
  | 'version'
  | 'structure'
  | 'graph'
  | 'geometry'
  | 'topology'
  | 'transport'
  | 'syntax'
  | 'headers'
  | 'identity';

/** A wire-shaped error location. Mirrors contracts/ptg-graph/v1/error.schema.json. */
export interface ContractError {
  code: string;
  message: string;
  node_ids: string[];
  field: string;
}

export interface ValidationIssue extends ContractError {
  stage: ContractStage;
}

export interface WireCoordinateSystem {
  frame_id: string;
  dimension: 3;
  unit: 'scene_unit';
  handedness: 'right';
  axes: 'xyz';
}

export interface WireNode {
  id: string;
  position: [number, number, number];
}

export interface WireSource {
  kind: 'interactive_3d';
  reference_image_ids: string[];
}

/** The exact wire request body this app builds. Only schema-allowed members. */
export interface WireRequest {
  schema_version: typeof WIRE_VERSION;
  profile: typeof PROFILE;
  producer: typeof PRODUCER;
  producer_instance_id: string;
  graph_id: string;
  revision: number;
  source: WireSource;
  coordinate_system: WireCoordinateSystem;
  nodes: WireNode[];
  adjacency: Record<string, string[]>;
  n_terminal_node: string;
}

/** Best-effort candidate body: identical to WireRequest except members that a
 * draft cannot supply (a draft may have no N terminal while still being saved). */
export type WireCandidate = Omit<WireRequest, 'n_terminal_node'> & {
  n_terminal_node: string | null;
};

export const WIRE_KEYS: readonly string[] = [
  'schema_version',
  'profile',
  'producer',
  'producer_instance_id',
  'graph_id',
  'revision',
  'source',
  'coordinate_system',
  'nodes',
  'adjacency',
  'n_terminal_node',
];

export const SOURCE_KEYS: readonly string[] = ['kind', 'reference_image_ids'];
export const COORDINATE_SYSTEM_KEYS: readonly string[] = [
  'frame_id',
  'dimension',
  'unit',
  'handedness',
  'axes',
];
export const NODE_KEYS: readonly string[] = ['id', 'position'];
