/**
 * Immutable graph snapshots and UTF-8 JSON download.
 *
 * A snapshot is taken from ONE moment: identity + content are copied together,
 * adjacency is derived from the stored edge set, and the downloadable bytes are
 * the frozen wire body only (no camera, work plane, history, reference-image
 * bytes or local snapshot id).
 *
 * Local metadata lives *outside* the wire document (in `snapshot.local`) so the
 * download stays exactly `request.schema.json` clean.
 *
 * The registry is the read-only interface a later send module (PTG-4) must use
 * instead of reading the live editor store.
 */

import { sha256Hex } from '../persistence/record';
import {
  CONTENT_DIGEST,
  CONTENT_VERSION,
  MAX_BODY_BYTES,
  PROFILE,
  WIRE_VERSION,
  type WireRequest,
} from './types';
import type { ValidationIssue } from './types';

/** Local export diagnostics: never a service receipt, never a wire error. */
export type ExportCode =
  | 'EXPORT_INVALID_DRAFT'
  | 'EXPORT_TOO_LARGE'
  | 'EXPORT_ENCODE_FAILED';

export class ExportError extends Error {
  readonly code: ExportCode;
  readonly issue: ValidationIssue | null;

  constructor(code: ExportCode, message: string, issue: ValidationIssue | null = null) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.issue = issue;
  }
}

/** Local snapshot metadata. Explicitly outside the wire contract. */
export interface SnapshotLocalMeta {
  snapshot_id: string;
  created_at: string;
  producer_instance_id: string;
  graph_id: string;
  frame_id: string;
  revision: number;
  wire_version: typeof WIRE_VERSION;
  content_version: typeof CONTENT_VERSION;
  content_digest: typeof CONTENT_DIGEST;
  profile: typeof PROFILE;
  byte_length: number;
  sha256: string;
  node_count: number;
  edge_count: number;
  source_reference_image_ids: string[];
}

export interface ImmutableSnapshot {
  readonly local: Readonly<SnapshotLocalMeta>;
  /** Exact UTF-8 bytes of the downloadable wire JSON. Never rewritten. */
  readonly bytes: Uint8Array;
  /** Deep-frozen wire body that produced `bytes`. */
  readonly payload: WireRequest;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Deep copy of a wire body so later editor edits can never reach a snapshot. */
export function cloneWireRequest(payload: WireRequest): WireRequest {
  return {
    schema_version: payload.schema_version,
    profile: payload.profile,
    producer: payload.producer,
    producer_instance_id: payload.producer_instance_id,
    graph_id: payload.graph_id,
    revision: payload.revision,
    source: {
      kind: payload.source.kind,
      reference_image_ids: [...payload.source.reference_image_ids],
    },
    coordinate_system: { ...payload.coordinate_system },
    nodes: payload.nodes.map((node) => ({
      id: node.id,
      position: [node.position[0], node.position[1], node.position[2]],
    })),
    adjacency: Object.fromEntries(
      Object.entries(payload.adjacency).map(([key, neighbours]) => [key, [...neighbours]]),
    ),
    n_terminal_node: payload.n_terminal_node,
  };
}

/** Serialize a wire body to UTF-8 bytes; enforce the frozen 1 MiB body limit. */
export function encodeWireRequest(payload: WireRequest): Uint8Array {
  // Stable member order = the schema's declaration order; JSON.stringify of
  // numbers is the shortest round-trip form, i.e. exact binary64.
  const text = JSON.stringify(orderedWire(payload));
  const bytes = new TextEncoder().encode(text);
  assertExportSize(bytes);
  return bytes;
}

function orderedWire(payload: WireRequest): Record<string, unknown> {
  return {
    schema_version: payload.schema_version,
    profile: payload.profile,
    producer: payload.producer,
    producer_instance_id: payload.producer_instance_id,
    graph_id: payload.graph_id,
    revision: payload.revision,
    source: {
      kind: payload.source.kind,
      reference_image_ids: [...payload.source.reference_image_ids],
    },
    coordinate_system: {
      frame_id: payload.coordinate_system.frame_id,
      dimension: payload.coordinate_system.dimension,
      unit: payload.coordinate_system.unit,
      handedness: payload.coordinate_system.handedness,
      axes: payload.coordinate_system.axes,
    },
    nodes: payload.nodes.map((node) => ({
      id: node.id,
      position: [node.position[0], node.position[1], node.position[2]],
    })),
    adjacency: Object.fromEntries(
      Object.entries(payload.adjacency).map(([key, neighbours]) => [key, [...neighbours]]),
    ),
    n_terminal_node: payload.n_terminal_node,
  };
}

/**
 * Frozen body limit: decoded UTF-8 byte length, not JS string length.
 * Equal to the limit is accepted (inclusive bound).
 */
export function assertExportSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new ExportError(
      'EXPORT_TOO_LARGE',
      `快照 UTF-8 字节数 ${bytes.byteLength} 超过契约上限 ${MAX_BODY_BYTES} 字节；请减少结点或坐标位数后重试`,
    );
  }
}

let snapshotCounter = 0;

function nextSnapshotId(now: Date): string {
  snapshotCounter += 1;
  const epoch = now.getTime().toString(36);
  const nonce = snapshotCounter.toString(36).padStart(2, '0');
  const random = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `snap-${epoch}-${nonce}-${random}`;
}

const registry: ImmutableSnapshot[] = [];

/**
 * Freeze a validated wire body into an immutable snapshot.
 * `bytes` are produced once and never regenerated, so a later edit cannot
 * change an existing download.
 */
export async function createSnapshot(
  payload: WireRequest,
  options: { createdAt?: Date; snapshotId?: string } = {},
): Promise<ImmutableSnapshot> {
  const copy = deepFreeze(cloneWireRequest(payload));
  const bytes = encodeWireRequest(copy);
  const digest = await sha256Hex(bytes);
  const createdAt = options.createdAt ?? new Date();
  const snapshot: ImmutableSnapshot = Object.freeze({
    bytes,
    local: Object.freeze({
      snapshot_id: options.snapshotId ?? nextSnapshotId(createdAt),
      created_at: createdAt.toISOString(),
      producer_instance_id: copy.producer_instance_id,
      graph_id: copy.graph_id,
      frame_id: copy.coordinate_system.frame_id,
      revision: copy.revision,
      wire_version: WIRE_VERSION,
      content_version: CONTENT_VERSION,
      content_digest: CONTENT_DIGEST,
      profile: PROFILE,
      byte_length: bytes.byteLength,
      sha256: digest,
      node_count: copy.nodes.length,
      edge_count: Object.values(copy.adjacency).reduce((sum, list) => sum + list.length, 0) / 2,
      source_reference_image_ids: [...copy.source.reference_image_ids],
    }),
    payload: copy,
  });
  registry.push(snapshot);
  return snapshot;
}

/** Read-only snapshot list for later modules (PTG-4); the live store is not exposed. */
export function listSnapshots(): readonly ImmutableSnapshot[] {
  return [...registry];
}

export function latestSnapshot(graphId?: string): ImmutableSnapshot | null {
  for (let index = registry.length - 1; index >= 0; index -= 1) {
    const candidate = registry[index];
    if (graphId === undefined || candidate.local.graph_id === graphId) {
      return candidate;
    }
  }
  return null;
}

export function snapshotById(snapshotId: string): ImmutableSnapshot | null {
  return registry.find((entry) => entry.local.snapshot_id === snapshotId) ?? null;
}

/** Test-only reset. The evidence entry never relies on this for behaviour. */
export function resetSnapshotRegistry(): void {
  registry.length = 0;
  snapshotCounter = 0;
}

export function snapshotFileName(snapshot: ImmutableSnapshot): string {
  return `ptg-graph-${snapshot.local.graph_id}-r${snapshot.local.revision}.json`;
}

export function snapshotBlob(snapshot: ImmutableSnapshot): Blob {
  return new Blob([snapshot.bytes as unknown as BlobPart], { type: 'application/json' });
}

/**
 * Trigger a browser download of the snapshot's exact bytes.
 * Returns the file name used; the bytes are reused verbatim on every click.
 */
export function downloadSnapshot(snapshot: ImmutableSnapshot, doc: Document = document): string {
  const blob = snapshotBlob(snapshot);
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  const fileName = snapshotFileName(snapshot);
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a task to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return fileName;
}

/** Verify that a snapshot's bytes still hash to its recorded digest. */
export async function verifySnapshotBytes(snapshot: ImmutableSnapshot): Promise<boolean> {
  return (await sha256Hex(snapshot.bytes)) === snapshot.local.sha256;
}

/** Decode snapshot bytes as UTF-8 text (used by evidence and re-import tests). */
export function snapshotText(snapshot: ImmutableSnapshot): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes);
}
