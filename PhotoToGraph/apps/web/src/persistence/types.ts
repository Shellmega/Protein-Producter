/**
 * Local-draft persistence types (PTG-1).
 *
 * This directory is deliberately independent from React, Three.js and the
 * Zustand store: it only knows the serialized record shape, the validation
 * rules and the storage backends. The Lead wires it into the store.
 *
 * Versioning contract:
 * - `format_version` is part of every stored record. A record with a future
 *   version is never rewritten implicitly; the loader reports
 *   LOCAL_FORMAT_UNKNOWN and keeps the raw bytes so a later build can migrate.
 * - Only one logical draft slot (`DRAFT_SLOT`) exists per origin.
 */

export const LOCAL_FORMAT_VERSION = 1;
/** Single logical draft slot per origin. */
export const DRAFT_SLOT = 'current';

/** Content-space (graph frame) coordinate triple, plain binary64 numbers. */
export type ContentTriple = [number, number, number];

/** Editor-only state that is persisted with the draft but never part of the graph revision. */
export interface StoredEditorStateV1 {
  mode: string; // 'select' | 'create' | 'connect' | 'move' (kept as plain string here)
  planeKind: string; // 'xy' | 'xz' | 'yz' | 'reference'
  planeOffsets: { xy: number; xz: number; yz: number };
  selectedNodeId: string | null;
  dragConstraint: string; // 'X' | 'Y' | 'Z' | 'XY' | 'XZ' | 'YZ'
}

export interface StoredCameraV1 {
  position: ContentTriple;
  target: ContentTriple;
}

export interface StoredReferenceMetaV1 {
  sourceId: string;
  fileName: string;
  mimeType: string; // image/png | image/jpeg
  /** Orientation-corrected decoded size. */
  intrinsicWidth: number;
  intrinsicHeight: number;
  baseWidth: number;
  pose: {
    position: ContentTriple;
    rotationDeg: ContentTriple;
    scale: number;
  };
  /**
   * Original encoded bytes are stored untouched; EXIF orientation is applied
   * exactly once on every decode.
   */
  orientationPolicy: 'from-image';
  byteLength: number;
  /** sha256 hex of the encoded bytes. */
  blobSha256: string;
}

export interface StoredContentV1 {
  nodes: { id: string; position: ContentTriple }[];
  edges: [string, string][];
  n_terminal_node: string | null;
  source_reference_image_ids: string[];
}

export interface StoredIdentityV1 {
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
}

export interface StoredDraftV1 {
  format_version: 1;
  kind: 'PTG-local-draft';
  saved_at: string; // ISO-8601
  save_generation: number;
  /** sha256 of stableContentJson(content). */
  content_digest: string;
  identity: StoredIdentityV1;
  content: StoredContentV1;
  editor: StoredEditorStateV1;
  camera: StoredCameraV1 | null;
  reference: StoredReferenceMetaV1 | null;
  /** Equals reference.sourceId when reference != null; null otherwise. */
  blob_key: string | null;
}

/** Stable machine-readable local-storage failure taxonomy. */
export type LocalStorageCode =
  | 'LOCAL_STORAGE_UNAVAILABLE'
  | 'LOCAL_QUOTA_EXCEEDED'
  | 'LOCAL_TX_ABORTED'
  | 'LOCAL_CONFLICT'
  | 'LOCAL_FORMAT_UNKNOWN'
  | 'LOCAL_RECORD_CORRUPT'
  /** Stored local `content_digest` no longer matches the stored `content`. */
  | 'LOCAL_DIGEST_MISMATCH'
  | 'LOCAL_MISSING_BLOB'
  | 'LOCAL_BLOB_MISMATCH'
  | 'LOCAL_IO_ERROR';

/**
 * Thrown only for programming/open misuse (not for expected domain failures):
 * - `open()` rejects with this error when IndexedDB is unavailable or blocked.
 * - `clearCurrent()` rejects with this error because its signature has no
 *   result envelope.
 * All other public methods return their mapped code inside a result object;
 * raw DOMExceptions never escape.
 */
export class LocalPersistenceError extends Error {
  readonly code: LocalStorageCode;
  readonly detail: string | null;

  constructor(code: LocalStorageCode, message: string, detail?: string | null) {
    super(message);
    this.name = 'LocalPersistenceError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** Stored blob record (`blobs` object store). */
export interface StoredBlobV1 {
  key: string;
  bytes: Uint8Array;
  mimeType: string;
  sha256: string;
}

export interface SaveDraftInput {
  record: StoredDraftV1;
  blob: { bytes: Uint8Array; mimeType: string; sha256: string } | null;
  /**
   * Expected current stored state for CAS; null means "no assumption"
   * (only allowed when replaceGraph is true or nothing exists).
   */
  expected: { graph_id: string; revision: number; content_digest: string } | null;
  /** True only for an explicit user action creating a new draft that may replace a different graph id. */
  replaceGraph: boolean;
}

export type SaveDraftResult =
  | { ok: true; generation: number; saved_at: string }
  | {
      ok: false;
      code: LocalStorageCode;
      message: string;
      existing: { graph_id: string; revision: number; content_digest: string; saved_at: string } | null;
    };

export type LoadDraftResult =
  | { ok: true; record: StoredDraftV1; blobBytes: Uint8Array | null }
  | { ok: false; code: LocalStorageCode; message: string; rawPreserved: boolean };

export interface DraftRepository {
  readonly kind: 'indexeddb' | 'memory';
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  /** null = no stored record. */
  loadCurrent(): Promise<LoadDraftResult | null>;
  saveCurrent(input: SaveDraftInput): Promise<SaveDraftResult>;
  /** Explicit user discard only. */
  clearCurrent(): Promise<void>;
  estimateQuota(): Promise<{ usage: number; quota: number } | null>;
}
