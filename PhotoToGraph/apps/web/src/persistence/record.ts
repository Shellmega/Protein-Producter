/**
 * Local-draft record helpers: hashing, canonical content JSON, strict
 * validation and the compare-and-set gate shared by both repositories.
 *
 * Design notes:
 * - `validateStoredDraft` never repairs or normalizes a record. Any invalid
 *   value is reported with its dotted field path so a corruption report points
 *   at the exact field. Numbers are copied as-is (exact binary64 identity).
 * - `stableContentJson` fixes object key order but preserves array order given
 *   by the editor (node order / edge order are meaningful to the editor UI).
 * - The CAS gate is a pure function so IndexedDB and the in-memory test
 *   repository cannot drift apart in their stale-write protection rules.
 */

import {
  LOCAL_FORMAT_VERSION,
  LocalPersistenceError,
  type ContentTriple,
  type LocalStorageCode,
  type SaveDraftInput,
  type StoredCameraV1,
  type StoredContentV1,
  type StoredDraftV1,
  type StoredEditorStateV1,
  type StoredIdentityV1,
  type StoredReferenceMetaV1,
} from './types';

const MAX_MESSAGE_LENGTH = 512;
const HEX_ALPHABET = '0123456789abcdef';
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Clamp a local diagnostic message to the documented 512-character limit. */
export function localMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

/** Best-effort human detail for a caught DOMException or Error (never thrown). */
export function describeError(error: unknown): string | null {
  if (error instanceof Error) return localMessage(`${error.name}: ${error.message}`);
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return localMessage(name);
  }
  return null;
}

/** Lowercase hex sha256 of raw bytes or UTF-8 text (Web Crypto, browser + Node 24). */
export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new LocalPersistenceError(
      'LOCAL_IO_ERROR',
      localMessage('本地存储：当前运行环境缺少 Web Crypto，无法计算草稿摘要'),
    );
  }
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  // TS 5.7+ types typed arrays as Uint8Array<ArrayBufferLike>; WebCrypto accepts
  // any ArrayBufferView at runtime, so narrow through unknown without copying.
  const bufferSource = bytes as unknown as BufferSource;
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest('SHA-256', bufferSource);
  } catch (error) {
    throw new LocalPersistenceError(
      'LOCAL_IO_ERROR',
      localMessage('本地存储：无法计算草稿摘要'),
      describeError(error),
    );
  }
  const view = new Uint8Array(digest);
  let hex = '';
  for (let index = 0; index < view.length; index += 1) {
    const byte = view[index];
    hex += HEX_ALPHABET[byte >> 4] + HEX_ALPHABET[byte & 0x0f];
  }
  return hex;
}

/**
 * Deterministic JSON of the graph content, used for the content digest.
 *
 * Node order and edge order are preserved exactly as given; object keys are
 * emitted in a fixed order. JSON number formatting is the ECMAScript
 * shortest round-trip form, so binary64 values survive exactly.
 */
export function stableContentJson(content: StoredContentV1): string {
  return JSON.stringify({
    nodes: content.nodes.map((node) => ({
      id: node.id,
      position: [node.position[0], node.position[1], node.position[2]],
    })),
    edges: content.edges.map((edge) => [edge[0], edge[1]]),
    n_terminal_node: content.n_terminal_node,
    source_reference_image_ids: [...content.source_reference_image_ids],
  });
}

/** sha256 of the stable content JSON. */
export async function contentDigest(content: StoredContentV1): Promise<string> {
  return sha256Hex(stableContentJson(content));
}

/* ------------------------------------------------------------------------- */
/* Local content-digest gate (load time)                                      */
/* ------------------------------------------------------------------------- */

export type ContentDigestVerification =
  | { ok: true }
  | { ok: false; code: LocalStorageCode; message: string; field: 'content_digest' };

/**
 * Recompute the LOCAL `content_digest` from the validated record and compare it
 * with the stored value. This is the local record-integrity digest
 * (`contentDigest(record.content)`), NOT the wire semantic digest.
 *
 * A mismatch means the stored bytes were modified without updating the digest
 * (or the digest was rewritten); the caller must reject the restore, keep the
 * raw record untouched and keep the current graph intact. This function is
 * shared by the IndexedDB and memory load paths so they cannot diverge.
 */
export async function verifyContentDigest(record: StoredDraftV1): Promise<ContentDigestVerification> {
  let actual: string;
  try {
    actual = await contentDigest(record.content);
  } catch (error) {
    return {
      ok: false,
      code: 'LOCAL_IO_ERROR',
      message: localMessage(
        `本地存储：无法复算草稿内容摘要（${error instanceof Error ? error.message : String(error)}），已拒绝恢复；原记录保留。`,
      ),
      field: 'content_digest',
    };
  }
  if (actual === record.content_digest) return { ok: true };
  return {
    ok: false,
    code: 'LOCAL_DIGEST_MISMATCH',
    message: localMessage(
      '本地存储：草稿内容与记录的本地内容摘要不一致（内容可能已损坏或被改写），已拒绝恢复；原记录未改写、未删除。',
    ),
    field: 'content_digest',
  };
}

/* ------------------------------------------------------------------------- */
/* Strict validation                                                          */
/* ------------------------------------------------------------------------- */

class DraftValidationFailure extends Error {
  readonly code: LocalStorageCode;
  readonly field: string;

  constructor(field: string, message: string, code: LocalStorageCode = 'LOCAL_RECORD_CORRUPT') {
    super(localMessage(message));
    this.name = 'DraftValidationFailure';
    this.code = code;
    this.field = field;
  }
}

function invalid(field: string, message: string, code?: LocalStorageCode): never {
  throw new DraftValidationFailure(field, message, code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, field: string, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) invalid(field, `本地存储：草稿字段 ${label} 必须为对象`);
  return value;
}

function requireArray(value: unknown, field: string, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(field, `本地存储：草稿字段 ${label} 必须为数组`);
  return value;
}

function requireString(
  value: unknown,
  field: string,
  label: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') invalid(field, `本地存储：草稿字段 ${label} 必须为字符串`);
  if (options.allowEmpty !== true && value.length === 0) {
    invalid(field, `本地存储：草稿字段 ${label} 不能为空`);
  }
  return value;
}

function requireExact<T>(value: unknown, expected: T, field: string, label: string): T {
  if (value !== expected) {
    invalid(field, `本地存储：草稿字段 ${label} 必须为 ${String(expected)}`);
  }
  return expected;
}

function requireFiniteNumber(value: unknown, field: string, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // Note: Number.isFinite(-0) is true, so a negative zero position is accepted
    // and preserved exactly; only NaN/Infinity are rejected.
    invalid(field, `本地存储：草稿字段 ${label} 必须为有限数字`);
  }
  return value;
}

function requireSafeInteger(value: unknown, field: string, label: string, minimum: number): number {
  const parsed = requireFiniteNumber(value, field, label);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    invalid(field, `本地存储：草稿字段 ${label} 必须为不小于 ${minimum} 的安全整数`);
  }
  return parsed;
}

function requirePositiveNumber(value: unknown, field: string, label: string): number {
  const parsed = requireFiniteNumber(value, field, label);
  if (!(parsed > 0)) invalid(field, `本地存储：草稿字段 ${label} 必须为大于 0 的数字`);
  return parsed;
}

function requireTriple(value: unknown, field: string, label: string): ContentTriple {
  const triple = requireArray(value, field, label);
  if (triple.length !== 3) invalid(field, `本地存储：草稿字段 ${label} 必须为长度为 3 的数组`);
  return [
    requireFiniteNumber(triple[0], `${field}[0]`, label),
    requireFiniteNumber(triple[1], `${field}[1]`, label),
    requireFiniteNumber(triple[2], `${field}[2]`, label),
  ];
}

function requireSha256(value: unknown, field: string, label: string): string {
  const text = requireString(value, field, label);
  if (!SHA256_HEX_PATTERN.test(text)) {
    invalid(field, `本地存储：草稿字段 ${label} 必须为 64 位小写十六进制字符串`);
  }
  return text;
}

function requireIsoTimestamp(value: unknown, field: string, label: string): string {
  const text = requireString(value, field, label);
  if (Number.isNaN(Date.parse(text))) {
    invalid(field, `本地存储：草稿字段 ${label} 必须为 ISO-8601 时间字符串`);
  }
  return text;
}

function validatePose(value: unknown, field: string): StoredReferenceMetaV1['pose'] {
  const pose = requireObject(value, field, '参考图位姿');
  return {
    position: requireTriple(pose.position, `${field}.position`, '参考图位置'),
    rotationDeg: requireTriple(pose.rotationDeg, `${field}.rotationDeg`, '参考图旋转'),
    scale: requirePositiveNumber(pose.scale, `${field}.scale`, '参考图缩放'),
  };
}

function validateReference(value: unknown, field: string): StoredReferenceMetaV1 | null {
  if (value === null) return null;
  const reference = requireObject(value, field, '参考图元数据');
  const mimeType = requireString(reference.mimeType, `${field}.mimeType`, '参考图类型');
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
    invalid(`${field}.mimeType`, '本地存储：参考图类型仅支持 image/png 或 image/jpeg');
  }
  return {
    sourceId: requireString(reference.sourceId, `${field}.sourceId`, '参考图标识'),
    fileName: requireString(reference.fileName, `${field}.fileName`, '参考图文件名'),
    mimeType,
    intrinsicWidth: requireSafeInteger(reference.intrinsicWidth, `${field}.intrinsicWidth`, '参考图宽度', 1),
    intrinsicHeight: requireSafeInteger(reference.intrinsicHeight, `${field}.intrinsicHeight`, '参考图高度', 1),
    baseWidth: requirePositiveNumber(reference.baseWidth, `${field}.baseWidth`, '参考图基础宽度'),
    pose: validatePose(reference.pose, `${field}.pose`),
    orientationPolicy: requireExact(
      reference.orientationPolicy,
      'from-image',
      `${field}.orientationPolicy`,
      '参考图朝向策略',
    ),
    byteLength: requireSafeInteger(reference.byteLength, `${field}.byteLength`, '参考图字节数', 1),
    blobSha256: requireSha256(reference.blobSha256, `${field}.blobSha256`, '参考图摘要'),
  };
}

function validateCamera(value: unknown, field: string): StoredCameraV1 | null {
  if (value === null) return null;
  const camera = requireObject(value, field, '相机状态');
  return {
    position: requireTriple(camera.position, `${field}.position`, '相机位置'),
    target: requireTriple(camera.target, `${field}.target`, '相机目标'),
  };
}

function validateContent(value: unknown, field: string): StoredContentV1 {
  const content = requireObject(value, field, '图内容');

  const rawNodes = requireArray(content.nodes, `${field}.nodes`, '节点列表');
  const nodes = rawNodes.map((rawNode, index) => {
    const nodeField = `${field}.nodes[${index}]`;
    const node = requireObject(rawNode, nodeField, '节点');
    return {
      id: requireString(node.id, `${nodeField}.id`, '节点标识'),
      position: requireTriple(node.position, `${nodeField}.position`, '节点坐标'),
    };
  });

  const rawEdges = requireArray(content.edges, `${field}.edges`, '边列表');
  const edges = rawEdges.map((rawEdge, index): [string, string] => {
    const edgeField = `${field}.edges[${index}]`;
    const edge = requireArray(rawEdge, edgeField, '边');
    if (edge.length !== 2) invalid(edgeField, '本地存储：边必须为两个节点标识组成的数组');
    return [
      requireString(edge[0], `${edgeField}[0]`, '边起点标识'),
      requireString(edge[1], `${edgeField}[1]`, '边终点标识'),
    ];
  });

  const terminal = content.n_terminal_node;
  const nTerminalNode =
    terminal === null
      ? null
      : requireString(terminal, `${field}.n_terminal_node`, 'N 端节点标识');

  const rawSourceIds = requireArray(
    content.source_reference_image_ids,
    `${field}.source_reference_image_ids`,
    '参考图标识列表',
  );
  const sourceReferenceImageIds = rawSourceIds.map((rawId, index) =>
    requireString(rawId, `${field}.source_reference_image_ids[${index}]`, '参考图标识'),
  );

  return {
    nodes,
    edges,
    n_terminal_node: nTerminalNode,
    source_reference_image_ids: sourceReferenceImageIds,
  };
}

function validateEditor(value: unknown): StoredEditorStateV1 {
  const editor = requireObject(value, 'editor', '编辑器状态');
  const offsets = requireObject(editor.planeOffsets, 'editor.planeOffsets', '工作平面偏移');
  const selectedNodeId = editor.selectedNodeId;
  return {
    mode: requireString(editor.mode, 'editor.mode', '编辑器模式'),
    planeKind: requireString(editor.planeKind, 'editor.planeKind', '工作平面类型'),
    planeOffsets: {
      xy: requireFiniteNumber(offsets.xy, 'editor.planeOffsets.xy', '工作平面偏移'),
      xz: requireFiniteNumber(offsets.xz, 'editor.planeOffsets.xz', '工作平面偏移'),
      yz: requireFiniteNumber(offsets.yz, 'editor.planeOffsets.yz', '工作平面偏移'),
    },
    selectedNodeId:
      selectedNodeId === null
        ? null
        : requireString(selectedNodeId, 'editor.selectedNodeId', '选中节点标识'),
    dragConstraint: requireString(editor.dragConstraint, 'editor.dragConstraint', '拖动约束'),
  };
}

function validateIdentity(value: unknown): StoredIdentityV1 {
  const identity = requireObject(value, 'identity', '图标识');
  const coordinate = requireObject(identity.coordinate_system, 'identity.coordinate_system', '坐标系');
  return {
    producer_instance_id: requireString(
      identity.producer_instance_id,
      'identity.producer_instance_id',
      '生产者实例标识',
    ),
    graph_id: requireString(identity.graph_id, 'identity.graph_id', '图标识'),
    frame_id: requireString(identity.frame_id, 'identity.frame_id', '坐标系标识'),
    revision: requireSafeInteger(identity.revision, 'identity.revision', '图修订号', 1),
    coordinate_system: {
      frame_id: requireString(coordinate.frame_id, 'identity.coordinate_system.frame_id', '坐标系标识'),
      dimension: requireExact(coordinate.dimension, 3, 'identity.coordinate_system.dimension', '坐标维度'),
      unit: requireExact(coordinate.unit, 'scene_unit', 'identity.coordinate_system.unit', '坐标单位'),
      handedness: requireExact(
        coordinate.handedness,
        'right',
        'identity.coordinate_system.handedness',
        '坐标手性',
      ),
      axes: requireExact(coordinate.axes, 'xyz', 'identity.coordinate_system.axes', '坐标轴'),
    },
  };
}

function validateDraftRecord(raw: unknown): StoredDraftV1 {
  const root = requireObject(raw, '', '草稿');

  // Format version is checked first so future records are reported as
  // LOCAL_FORMAT_UNKNOWN instead of a generic corruption.
  const version = root.format_version;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    invalid('format_version', '本地存储：草稿缺少有效的格式版本');
  }
  if (version > LOCAL_FORMAT_VERSION) {
    invalid(
      'format_version',
      `本地存储：草稿格式版本 ${version} 高于当前支持的版本 ${LOCAL_FORMAT_VERSION}`,
      'LOCAL_FORMAT_UNKNOWN',
    );
  }
  if (version < LOCAL_FORMAT_VERSION) {
    invalid(
      'format_version',
      `本地存储：草稿格式版本 ${version} 低于当前支持的版本 ${LOCAL_FORMAT_VERSION}`,
      'LOCAL_FORMAT_UNKNOWN',
    );
  }

  const reference = validateReference(root.reference, 'reference');
  let blobKey: string | null;
  if (root.blob_key === null) {
    blobKey = null;
  } else {
    blobKey = requireString(root.blob_key, 'blob_key', '参考图存储键');
  }
  if (reference === null && blobKey !== null) {
    invalid('blob_key', '本地存储：未引用参考图时 blob_key 必须为 null');
  }
  if (reference !== null && blobKey !== reference.sourceId) {
    invalid('blob_key', '本地存储：blob_key 必须等于参考图的 sourceId');
  }

  return {
    format_version: LOCAL_FORMAT_VERSION,
    kind: requireExact(root.kind, 'PTG-local-draft', 'kind', '草稿类型'),
    saved_at: requireIsoTimestamp(root.saved_at, 'saved_at', '保存时间'),
    save_generation: requireSafeInteger(root.save_generation, 'save_generation', '保存代数', 0),
    content_digest: requireSha256(root.content_digest, 'content_digest', '内容摘要'),
    identity: validateIdentity(root.identity),
    content: validateContent(root.content, 'content'),
    editor: validateEditor(root.editor),
    camera: validateCamera(root.camera, 'camera'),
    reference,
    blob_key: blobKey,
  };
}

export type StoredDraftValidation =
  | { ok: true; record: StoredDraftV1 }
  | { ok: false; code: LocalStorageCode; message: string; field: string };

/**
 * Validate an untrusted stored record.
 *
 * A record is either returned with the same values it was read with (numbers
 * are never rounded or reformatted) or rejected with a dotted field path.
 * This function never mutates its input and never throws for a bad shape.
 */
export function validateStoredDraft(raw: unknown): StoredDraftValidation {
  try {
    return { ok: true, record: validateDraftRecord(raw) };
  } catch (error) {
    if (error instanceof DraftValidationFailure) {
      return { ok: false, code: error.code, message: error.message, field: error.field };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------------- */
/* Draft construction                                                         */
/* ------------------------------------------------------------------------- */

/** Reference metadata minus the derived byte length / digest, plus the bytes. */
export interface BuildStoredDraftReferenceInput
  extends Omit<StoredReferenceMetaV1, 'byteLength' | 'blobSha256'> {
  bytes: Uint8Array;
}

export interface BuildStoredDraftInput {
  identity: StoredIdentityV1;
  content: StoredContentV1;
  editor: StoredEditorStateV1;
  camera: StoredCameraV1 | null;
  reference: BuildStoredDraftReferenceInput | null;
  savedAt?: string;
  generation?: number;
  formatVersion?: 1;
}

/** Blob payload accepted by `SaveDraftInput`. */
export interface DraftBlobPayload {
  bytes: Uint8Array;
  mimeType: string;
  sha256: string;
}

export interface BuiltStoredDraft {
  record: StoredDraftV1;
  blob: DraftBlobPayload | null;
}

function copyTriple(triple: ContentTriple): ContentTriple {
  return [triple[0], triple[1], triple[2]];
}

function copyContent(content: StoredContentV1): StoredContentV1 {
  return {
    nodes: content.nodes.map((node) => ({ id: node.id, position: copyTriple(node.position) })),
    edges: content.edges.map((edge): [string, string] => [edge[0], edge[1]]),
    n_terminal_node: content.n_terminal_node,
    source_reference_image_ids: [...content.source_reference_image_ids],
  };
}

function copyEditor(editor: StoredEditorStateV1): StoredEditorStateV1 {
  return {
    mode: editor.mode,
    planeKind: editor.planeKind,
    planeOffsets: {
      xy: editor.planeOffsets.xy,
      xz: editor.planeOffsets.xz,
      yz: editor.planeOffsets.yz,
    },
    selectedNodeId: editor.selectedNodeId,
    dragConstraint: editor.dragConstraint,
  };
}

function copyCamera(camera: StoredCameraV1 | null): StoredCameraV1 | null {
  if (camera === null) return null;
  return { position: copyTriple(camera.position), target: copyTriple(camera.target) };
}

function copyIdentity(identity: StoredIdentityV1): StoredIdentityV1 {
  return {
    producer_instance_id: identity.producer_instance_id,
    graph_id: identity.graph_id,
    frame_id: identity.frame_id,
    revision: identity.revision,
    coordinate_system: {
      frame_id: identity.coordinate_system.frame_id,
      dimension: identity.coordinate_system.dimension,
      unit: identity.coordinate_system.unit,
      handedness: identity.coordinate_system.handedness,
      axes: identity.coordinate_system.axes,
    },
  };
}

/**
 * Assemble a validated StoredDraftV1 plus its blob payload. Used by tests and
 * by the store integration; the caller still owns editor/camera extraction.
 *
 * Throws LocalPersistenceError('LOCAL_RECORD_CORRUPT') if the assembled record
 * does not satisfy `validateStoredDraft` (programming error, not user data).
 */
export async function buildStoredDraft(input: BuildStoredDraftInput): Promise<BuiltStoredDraft> {
  const content = copyContent(input.content);
  const contentDigestValue = await contentDigest(content);

  let reference: StoredReferenceMetaV1 | null = null;
  let blob: DraftBlobPayload | null = null;
  if (input.reference !== null) {
    const source = input.reference;
    const blobSha256 = await sha256Hex(source.bytes);
    reference = {
      sourceId: source.sourceId,
      fileName: source.fileName,
      mimeType: source.mimeType,
      intrinsicWidth: source.intrinsicWidth,
      intrinsicHeight: source.intrinsicHeight,
      baseWidth: source.baseWidth,
      pose: {
        position: copyTriple(source.pose.position),
        rotationDeg: copyTriple(source.pose.rotationDeg),
        scale: source.pose.scale,
      },
      orientationPolicy: 'from-image',
      byteLength: source.bytes.byteLength,
      blobSha256,
    };
    blob = { bytes: source.bytes, mimeType: source.mimeType, sha256: blobSha256 };
  }

  const record: StoredDraftV1 = {
    format_version: input.formatVersion ?? LOCAL_FORMAT_VERSION,
    kind: 'PTG-local-draft',
    saved_at: input.savedAt ?? new Date().toISOString(),
    save_generation: input.generation ?? 1,
    content_digest: contentDigestValue,
    identity: copyIdentity(input.identity),
    content,
    editor: copyEditor(input.editor),
    camera: copyCamera(input.camera),
    reference,
    blob_key: reference === null ? null : reference.sourceId,
  };

  const validation = validateStoredDraft(record);
  if (!validation.ok) {
    throw new LocalPersistenceError(
      validation.code,
      localMessage(`本地存储：构建的草稿记录无效（字段 ${validation.field}）`),
      validation.field,
    );
  }
  return { record, blob };
}

/* ------------------------------------------------------------------------- */
/* Compare-and-set gate (shared by both repositories)                         */
/* ------------------------------------------------------------------------- */

export interface ExistingDraftSummary {
  graph_id: string;
  revision: number;
  content_digest: string;
  saved_at: string;
}

export type SaveGate =
  | { allow: true }
  | { allow: false; code: LocalStorageCode; message: string; existing: ExistingDraftSummary | null };

function summarize(record: StoredDraftV1): ExistingDraftSummary {
  return {
    graph_id: record.identity.graph_id,
    revision: record.identity.revision,
    content_digest: record.content_digest,
    saved_at: record.saved_at,
  };
}

/** Summary of a stored raw draft, or null when it cannot be validated. */
export function summarizeStoredDraft(raw: unknown): ExistingDraftSummary | null {
  const validation = validateStoredDraft(raw);
  return validation.ok ? summarize(validation.record) : null;
}

function conflict(
  message: string,
  summary: ExistingDraftSummary,
): { allow: false; code: 'LOCAL_CONFLICT'; message: string; existing: ExistingDraftSummary } {
  return { allow: false, code: 'LOCAL_CONFLICT', message: localMessage(message), existing: summary };
}

/**
 * Decide whether a save may proceed.
 *
 * Rules, in order:
 * 1. No existing record: allow (an `expected` snapshot is not required).
 * 2. Existing record is unreadable: refuse LOCAL_RECORD_CORRUPT unless the
 *    caller explicitly replaces the graph (never overwrite silently).
 * 3. Different graph_id: allow only with `replaceGraph`.
 * 4. Same graph_id: a null `expected` snapshot is refused unless replaceGraph
 *    (a second page must prove it loaded the current state); a mismatched
 *    snapshot is LOCAL_CONFLICT (someone saved in between); then revision must
 *    increase, or the identical digest may be rewritten idempotently.
 */
export function gateSave(input: {
  record: StoredDraftV1;
  existingRaw: unknown;
  replaceGraph: boolean;
  expected: SaveDraftInput['expected'];
}): SaveGate {
  const { record, existingRaw, replaceGraph, expected } = input;

  // 1. No stored draft: the first save wins.
  if (existingRaw === null || existingRaw === undefined) return { allow: true };

  // 2. Never implicitly overwrite an unreadable record.
  const existingValidation = validateStoredDraft(existingRaw);
  if (!existingValidation.ok) {
    if (replaceGraph) return { allow: true };
    return {
      allow: false,
      code: 'LOCAL_RECORD_CORRUPT',
      message: localMessage(
        `本地存储：已存草稿无法校验（字段 ${existingValidation.field}），为避免覆盖已拒绝写入；如需替换请使用“新建草稿”`,
      ),
      existing: null,
    };
  }

  const existing = existingValidation.record;
  const summary = summarize(existing);

  // 3. A different graph may only replace the slot on an explicit user action.
  if (existing.identity.graph_id !== record.identity.graph_id) {
    if (replaceGraph) return { allow: true };
    return conflict(
      `本地存储写回冲突：存储中的草稿 graph_id=${existing.identity.graph_id}，revision=${existing.identity.revision}，与本次保存的 graph_id=${record.identity.graph_id} 不相同，已拒绝写入`,
      summary,
    );
  }

  // 4. Same graph: require proof that the caller saved on top of this state.
  if (expected === null && !replaceGraph) {
    return conflict(
      `本地存储写回冲突：存储中已有草稿 graph_id=${existing.identity.graph_id}，revision=${existing.identity.revision}，本次保存未携带已加载版本，已拒绝覆盖`,
      summary,
    );
  }
  if (expected !== null) {
    const snapshotMatches =
      expected.graph_id === existing.identity.graph_id &&
      expected.revision === existing.identity.revision &&
      expected.content_digest === existing.content_digest;
    if (!snapshotMatches) {
      return conflict(
        `本地存储写回冲突：存储中的草稿 graph_id=${existing.identity.graph_id}，revision=${existing.identity.revision} 与本次保存所基于的版本 revision=${expected.revision} 不一致，可能有其它页面写入，已拒绝写入`,
        summary,
      );
    }
  }

  if (record.identity.revision > existing.identity.revision) return { allow: true };
  if (
    record.identity.revision === existing.identity.revision &&
    record.content_digest === existing.content_digest
  ) {
    // Idempotent rewrite of identical content is safe.
    return { allow: true };
  }
  return conflict(
    `本地存储写回冲突：存储中的草稿 graph_id=${existing.identity.graph_id}，revision=${existing.identity.revision} 不低于本次保存的 revision=${record.identity.revision}，已拒绝写入`,
    summary,
  );
}

export type SaveInputCheck =
  | { ok: true }
  | { ok: false; code: LocalStorageCode; message: string; field: string };

/**
 * Validate the incoming record and the record/blob pairing before touching a
 * transaction. This is a programming guard as much as a data guard: the blob
 * digest and byte length must be the ones described by the reference metadata.
 */
export function checkSaveInput(input: SaveDraftInput): SaveInputCheck {
  const validation = validateStoredDraft(input.record);
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      message: localMessage(`本地存储：待保存的草稿记录无效（字段 ${validation.field}）`),
      field: validation.field,
    };
  }

  const record = validation.record;
  const reference = record.reference;
  if (reference === null) {
    if (input.blob !== null) {
      return {
        ok: false,
        code: 'LOCAL_BLOB_MISMATCH',
        message: localMessage('本地存储：草稿未引用参考图，但提交了图片数据'),
        field: 'blob',
      };
    }
    return { ok: true };
  }

  const blob = input.blob;
  if (blob === null) {
    return {
      ok: false,
      code: 'LOCAL_MISSING_BLOB',
      message: localMessage('本地存储：草稿引用了参考图，但缺少图片数据'),
      field: 'blob',
    };
  }
  if (blob.mimeType !== reference.mimeType) {
    return {
      ok: false,
      code: 'LOCAL_BLOB_MISMATCH',
      message: localMessage('本地存储：参考图类型与记录不一致'),
      field: 'blob.mimeType',
    };
  }
  if (blob.bytes.byteLength !== reference.byteLength) {
    return {
      ok: false,
      code: 'LOCAL_BLOB_MISMATCH',
      message: localMessage('本地存储：参考图字节数与记录不一致'),
      field: 'blob.bytes',
    };
  }
  if (blob.sha256 !== reference.blobSha256) {
    return {
      ok: false,
      code: 'LOCAL_BLOB_MISMATCH',
      message: localMessage('本地存储：参考图摘要与记录不一致'),
      field: 'blob.sha256',
    };
  }
  return { ok: true };
}
