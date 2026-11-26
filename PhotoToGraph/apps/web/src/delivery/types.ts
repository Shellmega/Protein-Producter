/**
 * PTG-4 delivery layer: persistent submission records, transport outcomes and
 * the local (wire-external) delivery diagnostics.
 *
 * Design boundaries:
 * - A submission is created ONLY from an immutable PTG-3 snapshot. Its exact
 *   UTF-8 wire bytes, Idempotency-Key, identity and target are frozen into the
 *   record BEFORE the first request is sent (`persist first, then request`).
 * - The submission record lives in its own IndexedDB object store; the local
 *   draft slot / reference blobs are never touched or migrated.
 * - The record's `state` uses the frozen wire state machine
 *   `idle -> submitting -> confirmed | rejected | pending_reconcile`.
 *   UI sub-phases are display-only and never change the wire state.
 * - Every local diagnostic code is prefixed `DLV_` and can never be mistaken
 *   for a wire error code (frozen registry in error.schema.json).
 */

/** Submission record format; a future format must bump this explicitly. */
export const DELIVERY_FORMAT_VERSION = 1;
export const DELIVERY_KIND = 'PTG-submission';

/** Delivery records share the `ptg-local` database but not the draft slot. */
export const DELIVERY_DB_NAME = 'ptg-local';
export const DELIVERY_DB_VERSION = 2;
export const SUBMISSIONS_STORE = 'submissions';
export const DELIVERY_META_STORE = 'delivery_meta';
export const DELIVERY_META_FORMAT_KEY = 'delivery_format_version';
export const DELIVERY_TARGET_STORAGE_KEY = 'ptg-delivery-target';

/** Frozen receiver paths (spec §7.1). Deployment candidates, not assumptions. */
export const POST_PATH = '/api/v1/sketch-imports';
export const GET_PATH_TEMPLATE = '/api/v1/sketch-imports/{import_id}';

/** Frozen retry policy (spec §7.6, protocol_cases.json retry_policy). */
export const AUTOMATIC_ATTEMPTS_MAX = 5;
export const BACKOFF_SECONDS = [1, 2, 4, 8, 16] as const;
export const BACKOFF_CAP_SECONDS = 30;

/** Local request timeout. A timeout is an UNKNOWN outcome, not "not delivered". */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Owner lease for same-origin two-page coordination (renewed per attempt). */
export const OWNER_LEASE_MS = 60_000;

/** Frozen Idempotency-Key / import_id character set (1..128 chars). */
export const WIRE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type DeliveryWireState = 'idle' | 'submitting' | 'confirmed' | 'rejected' | 'pending_reconcile';

/** Display-only sub-phase; never persisted as a wire state. */
export type DeliveryDisplayPhase =
  | 'queued'
  | 'sending'
  | 'waiting_retry'
  | 'verifying'
  | 'confirmed'
  | 'rejected'
  | 'needs_attention'
  | 'unknown';

export type DeliveryTargetMode = 'live' | 'mock';

export interface DeliveryTarget {
  /** Absolute base URL, validated: http(s), no credentials, no query/hash. */
  base_url: string;
  mode: DeliveryTargetMode;
  /** Local time the user saved this target. Outside the wire contract. */
  saved_at: string;
}

/** Identity copied from the snapshot; frozen for the life of the submission. */
export interface SubmissionIdentity {
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

/** Local snapshot metadata copied into the submission (wire-external). */
export interface SubmissionSnapshotRef {
  snapshot_id: string;
  created_at: string;
  byte_length: number;
  /** SHA-256 of the exact POST body bytes. */
  sha256: string;
  wire_version: string;
  content_version: string;
  /** Package content digest (NOT a wire semantic digest). */
  content_digest: string;
  profile: string;
  node_count: number;
  edge_count: number;
  source_reference_image_ids: string[];
}

/** Exact receipt fields (receipt.schema.json); no additional members allowed. */
export interface WireReceipt {
  import_id: string;
  schema_version: string;
  producer_instance_id: string;
  graph_id: string;
  revision: number;
  status: string;
  node_count: number;
  edge_count: number;
}

/** A validated wire error object (error.schema.json). */
export interface WireErrorBody {
  code: string;
  message: string;
  node_ids: string[];
  field: string;
}

export interface SubmissionError {
  /** 'wire' = parsed from the frozen error schema; 'local' = client diagnostic. */
  source: 'wire' | 'local';
  code: string;
  message: string;
  field: string | null;
  node_ids: string[];
  http_status: number | null;
  at: string;
}

export type AttemptKind = 'initial' | 'manual' | 'automatic' | 'reconcile';
export type AttemptOutcome =
  | 'http'
  | 'network_error'
  | 'timeout'
  | 'storage_error'
  | 'blocked'
  | 'aborted';

export interface AttemptEntry {
  index: number;
  kind: AttemptKind;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  outcome: AttemptOutcome;
  http_status: number | null;
  wire_code: string | null;
  local_code: string | null;
  note: string | null;
}

export interface SubmissionAttempts {
  /** Initial user submissions of this frozen snapshot (usually 1). */
  initial_sends: number;
  /** Explicit user retries after a rejected(500)/pending/exhausted result. */
  manual_retries: number;
  /** Automatic retries across all cycles (never reset). */
  automatic: number;
  /** Automatic attempts used in the current user-initiated cycle (0..5). */
  cycle_automatic: number;
  /** True once the current cycle exhausted its automatic budget. */
  exhausted: boolean;
  next_attempt_at: number | null;
  retry_after_until: number | null;
  last_attempt_at: number | null;
  history: AttemptEntry[];
}

/** Local receipt envelope: wire receipt + local-only transport labels. */
export interface StoredReceipt {
  receipt: WireReceipt;
  /** Local label; NEVER sent to the receiver and never part of the wire body. */
  transport_label: 'simulated' | 'live' | 'unknown';
  /** Local HTTP status that produced this receipt (200/201). */
  http_status: number;
  received_at: string;
  /** True when this receipt was confirmed by a GET read-back. */
  verified_by_get: boolean;
  verified_at: string | null;
}

export interface SubmissionVerification {
  last_get_at: string | null;
  last_get_status: number | null;
  last_result: 'equivalent' | 'mismatch' | 'not_found' | 'error' | null;
  local_code: string | null;
  message: string | null;
}

export interface SubmissionOwner {
  token: string;
  expires_at: number;
}

export interface SubmissionRecordV1 {
  format_version: 1;
  kind: 'PTG-submission';
  submission_id: string;
  created_at: string;
  updated_at: string;
  /** Monotonic CAS version; every successful update increments it. */
  record_version: number;
  identity: SubmissionIdentity;
  snapshot: SubmissionSnapshotRef;
  /** EXACT original POST body bytes. Immutable; verified on every send. */
  bytes: Uint8Array;
  idempotency_key: string;
  target: DeliveryTarget;
  state: DeliveryWireState;
  import_id: string | null;
  receipt: StoredReceipt | null;
  error: SubmissionError | null;
  attempts: SubmissionAttempts;
  owner: SubmissionOwner | null;
  verification: SubmissionVerification;
}

export interface SubmissionList {
  readonly records: readonly SubmissionRecordV1[];
}

export type DeliveryPersistenceCode =
  | 'DLV_STORAGE_UNAVAILABLE'
  | 'DLV_QUOTA_EXCEEDED'
  | 'DLV_TX_ABORTED'
  | 'DLV_STORAGE_FAILED'
  | 'DLV_CONFLICT'
  | 'DLV_RECORD_CORRUPT'
  | 'DLV_FORMAT_UNKNOWN'
  | 'DLV_BYTES_MISMATCH'
  | 'DLV_INVALID_RECORD'
  | 'DLV_IO_ERROR';

export type CreateSubmissionResult =
  | { ok: true; record: SubmissionRecordV1 }
  | { ok: false; code: DeliveryPersistenceCode; message: string };

export type UpdateSubmissionResult =
  | { ok: true; record: SubmissionRecordV1 }
  | { ok: false; code: DeliveryPersistenceCode; message: string };

/**
 * Submission repository. Implementations MUST:
 * - run every read-modify-write in one transaction (CAS on `record_version`);
 * - never delete/overwrite an existing submission when asked to create;
 * - never mutate the frozen `bytes`/`idempotency_key`/`target`/`snapshot`;
 * - keep corrupt/unknown rows readable as raw and report them instead of
 *   silently clearing them.
 */
export interface InvalidSubmissionRecord {
  submission_id: string | null;
  code: DeliveryPersistenceCode;
  field: string;
  message: string;
  /** Raw payload is left untouched in storage for recovery/inspection. */
  raw_preserved: true;
}

export interface SubmissionRepository {
  readonly kind: 'indexeddb' | 'memory';
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  listAll(): Promise<SubmissionRecordV1[]>;
  /** Structurally/digest-invalid rows discovered during the last scan. */
  listInvalid(): Promise<InvalidSubmissionRecord[]>;
  get(submissionId: string): Promise<SubmissionRecordV1 | null>;
  create(record: SubmissionRecordV1): Promise<CreateSubmissionResult>;
  /**
   * Compare-and-set update. `mutate` receives the current record in the same
   * transaction and must return the next record (or null to abort with
   * DLV_CONFLICT). `record_version` is incremented by the repository.
   */
  update(
    submissionId: string,
    expectedRecordVersion: number,
    mutate: (current: SubmissionRecordV1) => SubmissionRecordV1 | null,
  ): Promise<UpdateSubmissionResult>;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface HttpRequestSpec {
  method: 'POST' | 'GET';
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  timeoutMs: number;
  /** Local cancellation only; aborting never claims the server rolled back. */
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Lower-cased header lookup; null when the runtime cannot read headers. */
  headers: Record<string, string> | null;
  /** Exact response bytes when readable. */
  bytes: Uint8Array | null;
  /** UTF-8 decode of `bytes` (non-fatal; caller validates). */
  text: string;
  duration_ms: number;
}

export type TransportOutcome =
  | { kind: 'response'; response: TransportResponse }
  | { kind: 'network_error'; message: string; duration_ms: number }
  | { kind: 'timeout'; message: string; duration_ms: number }
  | { kind: 'aborted'; message: string; duration_ms: number };

export interface HttpTransport {
  request(spec: HttpRequestSpec): Promise<TransportOutcome>;
}

// ---------------------------------------------------------------------------
// Local delivery diagnostics (never wire codes)
// ---------------------------------------------------------------------------

export type DeliveryLocalCode =
  | 'DLV_TARGET_INVALID'
  | 'DLV_TARGET_UNREACHABLE'
  | 'DLV_NOT_SENT_INVALID_GRAPH'
  | 'DLV_NOT_SENT_NO_SNAPSHOT'
  | 'DLV_NOT_SENT_STORAGE'
  | 'DLV_BYTES_CHANGED'
  | 'DLV_UNKNOWN_STATUS'
  | 'DLV_INVALID_RESPONSE'
  | 'DLV_RECEIPT_MISMATCH'
  | 'DLV_RECEIPT_INVALID'
  | 'DLV_ERROR_BODY_INVALID'
  | 'DLV_GET_MISMATCH'
  | 'DLV_GET_INVALID'
  | 'DLV_IMPORT_NOT_FOUND'
  | 'DLV_GET_ERROR'
  | 'DLV_RETRY_EXHAUSTED'
  | 'DLV_ABORTED'
  | 'DLV_OFFLINE'
  | 'DLV_CORRUPT_RECORD'
  | 'DLV_FORMAT_UNKNOWN'
  | 'DLV_OWNER_BUSY';

/** Read-only status snapshot exposed to the UI and evidence diagnostics. */
export interface DeliveryStatusView {
  target: DeliveryTarget | null;
  targetSource: 'default' | 'stored';
  storage: 'indexeddb' | 'memory' | null;
  bootStatus: 'pending' | 'ready' | 'blocked';
  storageMessage: string | null;
  records: readonly SubmissionView[];
  /** Structurally/digest-invalid persisted rows (raw preserved). */
  invalidRecords: readonly InvalidSubmissionRecord[];
  /** Number of active local retry timers (diagnostic only). */
  pendingTimerCount: number;
  /** Current editor revision, for the "currently editing rN" display. */
  currentRevision: number;
  /** True while at least one local request is in flight. */
  inFlight: boolean;
  lastError: SubmissionError | null;
  origin: string;
}

export interface SubmissionView {
  submission_id: string;
  created_at: string;
  updated_at: string;
  graph_id: string;
  frame_id: string;
  revision: number;
  state: DeliveryWireState;
  phase: DeliveryDisplayPhase;
  import_id: string | null;
  /** Frozen Idempotency-Key; shown locally for evidence, never re-generated. */
  idempotency_key: string;
  receipt: StoredReceipt | null;
  error: SubmissionError | null;
  target: DeliveryTarget;
  snapshot: SubmissionSnapshotRef;
  attempts: SubmissionAttempts;
  verification: SubmissionVerification;
  owner_expires_at: number | null;
  /** Local-only: mock label shown next to a receipt that did not come from GTP. */
  transport_label: 'simulated' | 'live' | 'unknown';
}
