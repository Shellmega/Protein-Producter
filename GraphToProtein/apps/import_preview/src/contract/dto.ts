/**
 * Frontend DTOs for the internal interface `gtp-import-preview/1.0`.
 *
 * Authority: docs/interfaces/GTP_import_preview_v1.md (main coordinator owns it).
 * This file is the P4-I client view only. It imports no Python/SQL type and does
 * not redefine backend semantics; the P5-I service is authoritative.
 */

export type Vec3 = [number, number, number];
export type Mat3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

export const API_VERSION = "gtp-import-preview/1.0" as const;
export type ApiVersion = typeof API_VERSION;

/** Frozen receipt, receipt.schema.json (wire `ptg-graph/1.0`). */
export interface Receipt {
  import_id: string;
  schema_version: string;
  producer_instance_id: string;
  graph_id: string;
  revision: number;
  status: "imported_needs_configuration";
  node_count: number;
  edge_count: number;
}

export const GRAPH_SCHEMA_VERSION = "ptg-graph/1.0" as const;
export const GRAPH_PROFILE = "protein_open_chain_v1" as const;
export const GRAPH_UNIT = "scene_unit" as const;

export interface SourceNode {
  id: string;
  position: Vec3;
}

/** Frozen source graph snapshot returned by the GET. */
export interface SourceGraph {
  schema_version: string;
  profile: string;
  producer: string;
  producer_instance_id: string;
  graph_id: string;
  revision: number;
  source: {
    kind: string;
    reference_image_ids: string[];
  };
  coordinate_system: {
    frame_id: string;
    dimension: number;
    unit: string;
    handedness: string;
    axes: string;
  };
  nodes: SourceNode[];
  adjacency: Record<string, string[]>;
  n_terminal_node: string;
}

export interface GetImportResponse {
  receipt: Receipt;
  source_graph: SourceGraph;
}

export interface PreviewTransform {
  center: Vec3;
  rotation: Mat3;
  scale: number;
  translation: Vec3;
}

/** Inverse map parameters fixed by the interface. */
export interface PreviewTransformInverse {
  center: Vec3;
  rotation_transpose: Mat3;
  scale_inverse: number;
  translation: Vec3;
}

export interface DraftConfig {
  node_positions: Record<string, Vec3>;
  n_terminal_node: string;
  target_residue_count: number | null;
  preview_transform: PreviewTransform;
  requested_model_scale_angstrom_per_scene_unit: number | null;
}

export interface PointError {
  node_id: string;
  error: number;
  bound_rt: number;
}

export interface QuadMeasure {
  indices: number[];
  signed_triple_product: number;
  leg_lengths: Vec3;
  normalised_triple_product: number;
  hand: 1 | -1 | null;
  stable: boolean;
  degenerate: boolean;
}

export interface PreviewGeometry {
  degenerate: boolean;
  hand: 1 | -1 | null;
  max_roundtrip_error: number;
  max_roundtrip_bound: number;
  precision_limit_exceeded: boolean;
  point_errors: PointError[];
  quads: QuadMeasure[];
}

export interface DraftPreview {
  node_positions: Record<string, Vec3>;
  chain_order: string[];
  transform_inverse: PreviewTransformInverse;
  geometry: PreviewGeometry;
}

export interface SourceBinding {
  schema_version: string;
  producer_instance_id: string;
  graph_id: string;
  revision: number;
  frame_id: string;
  semantic_digest: string;
  contract_package_digest: string;
}

export type ConfigurationStatus = "incomplete" | "configured_unverified";

/** Response body of the draft save route and of the revision read route. */
export interface DraftRevision {
  api_version: ApiVersion;
  draft_id: string;
  draft_revision: number;
  import_id: string;
  source_binding: SourceBinding;
  config: DraftConfig;
  preview: DraftPreview;
  configuration_status: ConfigurationStatus;
  model_condition_status: "PENDING";
}

export interface DraftMeta {
  draft_id: string;
  latest_revision: number;
}

export interface DraftMetaList {
  api_version: ApiVersion;
  import_id: string;
  drafts: DraftMeta[];
}

export interface SaveDraftRequest {
  api_version: ApiVersion;
  draft_id: string | null;
  expected_revision: number;
  mutation_id: string;
  config: DraftConfig;
}

/** Error envelope returned by the draft routes. */
export interface ApiErrorEnvelope {
  api_version: ApiVersion;
  error: {
    code: string;
    field: string | null;
    message: string;
    import_id: string | null;
    draft_id: string | null;
  };
}

/** Wire-level error shape of the frozen import route (spec §5.3). */
export interface WireErrorEnvelope {
  error: {
    code: string;
    message: string;
    node_ids: string[];
    field: string;
  };
}

/** Normalised error surfaced to the UI and to evidence. */
export interface ApiError {
  code: string;
  field: string | null;
  message: string;
  import_id: string | null;
  draft_id: string | null;
  http_status: number | null;
  /** True when the response did not come from a real receiver. */
  simulated: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };
