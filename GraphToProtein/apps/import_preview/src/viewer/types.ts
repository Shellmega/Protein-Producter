/**
 * P4-G fixed-structure viewer: shared types.
 *
 * The viewer is a separate entry point of the existing P4 browser application.
 * It never touches the P4-I draft state, the import adapters or any storage; it
 * consumes one fixed catalog manifest, loads the fixed structure/curve bytes and
 * shows their spatial relation with the saved similarity transform.
 */

import type { Mat3, Vec3 } from "../contract/dto.js";

export const VIEWER_CATALOG_SCHEMA = "gtp-p4g-fixed-viewer-catalog/1";
export const VIEWER_DEBUG_VERSION = "p4g-debug/1";
/** Auxiliary (clearly non-physical) scene-unit remap artifact. */
export const AUX_REMAP_SCHEMA = "gtp-p4g-scene-remap-aux/1";

export type CandidateOrigin = "HISTORICAL_P2_RUN" | "SYNTHETIC_NUMERIC_FIXTURE" | "FUTURE_P5G_TASK";

export interface CatalogSource {
  /** Served URL (written by the build after verifying the declared SHA-256). */
  href: string;
  sha256: string;
  bytes: number;
  dest: string;
  /** Repository-relative read-only path this copy was materialized from. */
  source_path: string;
}

export interface CatalogTransform {
  from_unit: string;
  to_unit: string;
  s: number;
  R: Mat3;
  c: Vec3;
  t: Vec3;
  policy?: string;
  forward?: string;
  inverse?: string;
  name?: string;
}

export interface CatalogAnchor {
  control_point_index: number;
  residue_index0: number;
  residue_number?: number;
}

export interface CatalogCurve {
  present: boolean;
  graph_source_id: string | null;
  condition_source_id: string | null;
  transform_source_id: string | null;
  node_order: string[];
  n_terminal_node: string | null;
  anchors: CatalogAnchor[];
  recorded_checks: {
    source_path?: string;
    bound_round_trip_max?: number;
    round_trip_max_abs_error?: number;
    rotation_orthogonality_residual?: number;
    rotation_determinant?: number;
    precision_limit_exceeded?: boolean;
  } | null;
  synthetic_transform?: CatalogTransform | null;
  /**
   * Present when the catalog itself has a verified reason to keep the line
   * overlay off (for example an explicitly mismatched saved draft revision).
   * The skeleton stays viewable; only the overlay is disabled.
   */
  overlay_disabled_reason?: string | null;
}

export interface CatalogIdentity {
  import_id: string | null;
  draft_id: string | null;
  graph_id: string | null;
  graph_revision: number | null;
  producer_instance_id: string | null;
  frame_id: string | null;
  source_unit: string | null;
  note: string;
}

export interface CatalogRun {
  run_id: string;
  seed: number;
  design_index: number;
  manifest_source_id: string;
  representative_source_id: string | null;
  condition_spec_path: string | null;
}

export interface CatalogModel {
  backend: string | null;
  upstream_commit: string | null;
  weights: string | null;
  contig: string | null;
  diffuser_T: number | null;
  target_length: number | null;
  guide_scale: number | null;
  curve_weight: number | null;
  curve_sigma: number | null;
  device: string | null;
}

export interface CatalogStructure {
  source_id: string;
  format: string;
  unit: string;
  frame: string;
  atom_count: number;
  residue_count: number;
  chain_count: number;
}

export interface CatalogQuality {
  status: string;
  label: string;
  source: string;
  note?: string;
}

/**
 * Service-side identity of a candidate that came from a real local generation
 * task. Absent (`null`) for every fixed historical entry, which is why the
 * historical entries keep rendering exactly as before.
 */
export interface CatalogTaskPublishedResult {
  result_id: string;
  attempt_id: string;
  attempt_number: number;
  manifest_sha256: string;
  total_bytes: number;
  file_count: number;
  current: boolean;
}

export interface CatalogTaskBinding {
  task_id: string;
  attempt_id: string;
  attempt_number: number;
  attempt_count: number;
  snapshot_id: string;
  snapshot_digest: string;
  result_id: string;
  executor_tag: string;
  executor_mode: string;
  is_real_model_output: boolean;
  candidate_quality_status: string;
  import_id: string;
  draft_id: string;
  draft_revision: number;
  graph_revision: number;
  service_base_url: string;
  import_base_url: string | null;
  viewer_url: string;
  result_manifest_sha256: string;
  draft_status: string;
  /** How the page selected this attempt: pinned by attempt, by result, or the task's current attempt. */
  entry_mode: string;
  requested_attempt_id: string | null;
  requested_result_id: string | null;
  /** Every result the backend published for this task (records, not hashes alone). */
  published_results: CatalogTaskPublishedResult[];
}

export interface CatalogCandidate {
  candidate_id: string;
  label: string;
  origin: CandidateOrigin;
  banner: string;
  historical_marker: string | null;
  identity: CatalogIdentity;
  run: CatalogRun | null;
  model: CatalogModel | null;
  structure: CatalogStructure;
  curve: CatalogCurve;
  quality: CatalogQuality;
  task?: CatalogTaskBinding | null;
}

export interface CatalogViewerInfo {
  molstar_version: string;
  molstar_upstream_commit: string;
  pdb_unit: string;
  pdb_frame: string;
  source_unit: string;
  transform_convention: string;
  transform_inverse: string;
}

export interface Catalog {
  schema: string;
  catalog_id: string;
  title?: string;
  materialized_from_commit: string;
  contract: { package: string; profile: string; note?: string };
  viewer: CatalogViewerInfo;
  sources: Record<string, CatalogSource>;
  candidates: CatalogCandidate[];
  provenance_note?: string;
  fault_injection?: { id: string; expected_error_code: string; detail: string };
}

/** A locatable viewer error: code + field + human message + source location. */
export interface ViewerError {
  code: string;
  field: string | null;
  message: string;
  location: string | null;
}

export interface CurvedNode {
  id: string;
  scene: Vec3;
  model: Vec3;
  /** Inverse-mapped `model` (should reproduce `scene` within the bound). */
  recovered: Vec3;
  error: number;
  bound: number;
}

export interface MapResult {
  nodes: CurvedNode[];
  max_error: number;
  max_bound: number;
  rotation_residual: number;
  determinant: number;
  scale: number;
  within_bounds: boolean;
}

export interface AtomRemapSummary {
  atom_count: number;
  max_abs_error: number;
  max_bound: number;
  within_bounds: boolean;
  first_atom: { key: string; model: Vec3; scene: Vec3; recovered: Vec3 } | null;
}

export type ViewFrame = "model" | "scene";
export type LoadState = "idle" | "loading" | "loaded" | "error";

export interface ViewerSnapshot {
  version: string;
  catalogUrl: string;
  catalog: { schema: string; id: string; candidates: number; fault_injection: string | null } | null;
  candidateId: string | null;
  origin: CandidateOrigin | null;
  frame: ViewFrame;
  loadState: LoadState;
  error: ViewerError | null;
  gaps: ViewerError[];
  /** Whether the export controls may act on the currently loaded structure. */
  exportAvailability: { pdb: boolean; aux: boolean; reason: string | null; pdbReason: string | null; auxReason: string | null };
  structure: null | {
    sourceId: string;
    sha256: string;
    bytes: number;
    atomCount: number;
    residueCount: number;
    chainCount: number;
    unit: string;
    frame: string;
  };
  identity: CatalogIdentity | null;
  /** Service-side task identity of a real P5-G task result; `null` for fixed entries. */
  task: CatalogTaskBinding | null;
  run: null | {
    runId: string;
    seed: number;
    designIndex: number;
    exitCode: number | null;
    wallTimeS: number | null;
    startedAtUtc: string | null;
    kind: string | null;
    description: string | null;
    pdbSha256InManifest: string | null;
    representativeMatch: boolean | null;
  };
  curve: null | {
    present: boolean;
    nodeOrder: string[];
    nTerminalNode: string | null;
    nodeCount: number;
    transform: CatalogTransform | null;
    map: MapResult | null;
    graphIdentity: { graph_id: string; revision: number; frame_id: string; n_terminal_node: string } | null;
    overlayEnabled: boolean;
    overlayReason: string | null;
    /** Which coordinates the guide polygon is drawn from. */
    pointsBasis: "saved_draft_revision" | "source_graph" | null;
    /** Saved draft revision whose frozen coordinates the guide uses (task dialect only). */
    pointsRevision: number | null;
    /** Max |forward(source) − preview| over the condition's own frozen point pairs. */
    conditionResidual: number | null;
  };
  /** The 3-D capability, kept apart from the verified data. */
  scene3d: {
    available: boolean;
    rendered: boolean;
    /** Only a really loaded scene may be described as rotatable. */
    rotatable: boolean;
    reason: string | null;
    label: string;
  };
  /** User toggle of the control-polygon line overlay (independent of data availability). */
  overlayVisible: boolean;
  /** Sketch control points vs the anchored Cα atoms, model frame (Å); `null` when no curve. */
  proximity: import("./proximity.js").ProximityResult | null;
  atoms: null | AtomRemapSummary;
  selection: SelectionInfo | null;
  scene: SceneProbe | null;
  exports: {
    pdb: ExportState | null;
    aux: ExportState | null;
  };
  /** Visible result of the last (automatic or manual) export re-check. */
  reloadNotice: ReloadNotice;
  messages: Array<{ level: "info" | "warn" | "error"; text: string; at: string }>;
}

export interface ReloadedAtoms {
  atomCount: number;
  matched: number;
  mismatched: number;
  maxDelta: number;
  tolerance: number;
  ok: boolean;
}

/**
 * One atom-by-atom check of an exported file. The export auto-checks once; each
 * click on "重载导出并逐原子核对" appends another record, so repeated clicks on the
 * same file are distinguishable even when the counts do not change.
 */
export interface ReloadCheck extends ReloadedAtoms {
  /** 1-based number of checks performed on this exported file. */
  attempt: number;
  at: string;
  source: "export" | "button";
  /** Bytes/sha of the file that was actually compared. */
  bytes: number;
  sha256: string;
}

/** The visible outcome of the last check attempt (or why nothing was checked). */
export interface ReloadNotice {
  kind: "idle" | "done" | "unavailable" | "failed";
  text: string;
  at: string | null;
  attempt: number;
}

export interface ExportState {
  kind: "pdb" | "aux";
  filename: string;
  bytes: number;
  sha256: string;
  unit: string;
  reloaded: ReloadedAtoms | null;
  /** Attempt history summary for this file (pdb only). */
  reloadCheck?: ReloadCheck | null;
}

export interface SelectionInfo {
  source: "structure" | "overlay" | "empty";
  atomName: string | null;
  resName: string | null;
  chainId: string | null;
  resSeq: number | null;
  serial: number | null;
  /** Position in the frame Mol* is drawing (model Å, or scene_unit in the source frame). */
  position: Vec3 | null;
  /** Same position mapped back to scene units through the saved inverse transform. */
  scenePosition: Vec3 | null;
  lociSize: number;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  distance: number;
  poseId: number;
}

export interface SceneProbe {
  webgl: boolean;
  renderer: string | null;
  canvas: { width: number; height: number };
  camera: CameraPose;
  visible: boolean;
  structures: number;
  /** Whether the control-polygon guide is currently drawn (user-toggleable line overlay). */
  guideVisible: boolean;
  frame: ViewFrame;
  /** Pointer statistics: proves the click→selection path actually ran. */
  clicks: number;
  lastClickLociSize: number;
  lastClickAt: [number, number] | null;
}
