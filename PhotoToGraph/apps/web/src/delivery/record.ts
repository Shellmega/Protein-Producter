/**
 * Submission record helpers: build from an immutable snapshot, strict structural
 * validation, local integrity (bytes/SHA/identity) verification, id/key
 * generation and target validation.
 *
 * The record is the durable source of truth for delivery: after creation the
 * exact POST bytes, idempotency key, identity, snapshot metadata and target are
 * immutable. Retries never rebuild a request from the live editor store.
 */

import { sha256Hex } from '../persistence/record';
import type { ImmutableSnapshot } from '../contract/snapshot';
import {
  DELIVERY_FORMAT_VERSION,
  DELIVERY_KIND,
  GET_PATH_TEMPLATE,
  POST_PATH,
  WIRE_ID_PATTERN,
  type DeliveryLocalCode,
  type DeliveryPersistenceCode,
  type AttemptEntry,
  type DeliveryTarget,
  type DeliveryWireState,
  type DeliveryDisplayPhase,
  type StoredReceipt,
  type SubmissionAttempts,
  type SubmissionError,
  type SubmissionIdentity,
  type SubmissionRecordV1,
  type SubmissionSnapshotRef,
  type SubmissionView,
  type WireReceipt,
} from './types';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MESSAGE_LENGTH = 512;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function clamp(text: string): string {
  return text.length <= MAX_MESSAGE_LENGTH ? text : `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

/** Idempotency-Key: frozen ASCII charset, 1..128 chars, one header value. */
export function newIdempotencyKey(now: Date = new Date()): string {
  return `ptg-${now.getTime().toString(36)}-${randomToken(20)}`;
}

export function newSubmissionId(now: Date = new Date()): string {
  return `sub-${now.getTime().toString(36)}-${randomToken(10)}`;
}

export function newOwnerToken(): string {
  return `own-${randomToken(16)}`;
}

export function emptyAttempts(): SubmissionAttempts {
  return {
    initial_sends: 0,
    manual_retries: 0,
    automatic: 0,
    cycle_automatic: 0,
    exhausted: false,
    next_attempt_at: null,
    retry_after_until: null,
    last_attempt_at: null,
    history: [],
  };
}

/* ------------------------------------------------------------------------- */
/* Target                                                                    */
/* ------------------------------------------------------------------------- */

export interface ParsedTarget {
  ok: true;
  target: DeliveryTarget;
}
export interface TargetError {
  ok: false;
  code: DeliveryLocalCode;
  message: string;
}

/**
 * Validate a receiver base URL. Deployment candidates (127.0.0.1:8000 / the
 * Vite origin) are NOT assumed: any absolute http(s) base is accepted and the
 * actual value is what the submission freezes and the evidence records.
 */
export function parseDeliveryTarget(baseUrl: string, mode: 'live' | 'mock', now: Date = new Date()): ParsedTarget | TargetError {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'DLV_TARGET_INVALID', message: '接收基址不能为空。' };
  }
  if (trimmed.length > 512 || /[\s\u0000-\u001f]/.test(trimmed)) {
    return { ok: false, code: 'DLV_TARGET_INVALID', message: '接收基址含空白/控制字符或过长。' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, code: 'DLV_TARGET_INVALID', message: '接收基址不是合法绝对 URL（需要 http:// 或 https://）。' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'DLV_TARGET_INVALID', message: `不支持的协议 ${parsed.protocol}；仅允许 http/https。` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, code: 'DLV_TARGET_INVALID', message: '接收基址不得包含用户名/密码。' };
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, code: 'DLV_TARGET_INVALID', message: '接收基址不得包含查询串或片段。' };
  }
  if (parsed.hostname === '') {
    return { ok: false, code: 'DLV_TARGET_INVALID', message: '接收基址缺少主机名。' };
  }
  let path = parsed.pathname;
  while (path.endsWith('/')) path = path.slice(0, -1);
  if (path !== '' && !path.startsWith('/')) {
    return { ok: false, code: 'DLV_TARGET_INVALID', message: '接收基址路径必须以 / 开头。' };
  }
  if (path.includes('//')) {
    return { ok: false, code: 'DLV_TARGET_INVALID', message: '接收基址路径不得含连续斜杠。' };
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  return {
    ok: true,
    target: {
      base_url: `${origin}${path}`,
      mode,
      saved_at: now.toISOString(),
    },
  };
}

export function sameTarget(a: DeliveryTarget, b: DeliveryTarget): boolean {
  return a.base_url === b.base_url && a.mode === b.mode;
}

export function postUrl(target: DeliveryTarget): string {
  return `${target.base_url}${POST_PATH}`;
}

export function getUrl(target: DeliveryTarget, importId: string): string {
  return `${target.base_url}${GET_PATH_TEMPLATE.replace('{import_id}', encodeURIComponent(importId))}`;
}

/* ------------------------------------------------------------------------- */
/* Build from snapshot                                                       */
/* ------------------------------------------------------------------------- */

export interface BuildSubmissionInput {
  snapshot: ImmutableSnapshot;
  target: DeliveryTarget;
  now?: Date;
  /** Deterministic test hooks; production omits both. */
  submissionId?: string;
  idempotencyKey?: string;
}

/**
 * Freeze a submission from an immutable snapshot.
 * Fails (rather than trusting the snapshot) when the snapshot's recorded
 * SHA-256/length do not match its bytes.
 */
export async function buildSubmission(input: BuildSubmissionInput): Promise<SubmissionRecordV1> {
  const now = input.now ?? new Date();
  const snapshot = input.snapshot;
  const bytes = new Uint8Array(snapshot.bytes);
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== snapshot.local.sha256 || bytes.byteLength !== snapshot.local.byte_length) {
    throw new Error('快照字节与其 SHA-256/长度不一致，拒绝建立提交。');
  }
  const payload = snapshot.payload;
  const identity: SubmissionIdentity = {
    producer_instance_id: payload.producer_instance_id,
    graph_id: payload.graph_id,
    frame_id: payload.coordinate_system.frame_id,
    revision: payload.revision,
    coordinate_system: { ...payload.coordinate_system },
  };
  const edgeCount = Object.values(payload.adjacency).reduce((sum, list) => sum + list.length, 0) / 2;
  const snapshotRef: SubmissionSnapshotRef = {
    snapshot_id: snapshot.local.snapshot_id,
    created_at: snapshot.local.created_at,
    byte_length: bytes.byteLength,
    sha256,
    wire_version: snapshot.local.wire_version,
    content_version: snapshot.local.content_version,
    content_digest: snapshot.local.content_digest,
    profile: snapshot.local.profile,
    node_count: payload.nodes.length,
    edge_count: edgeCount,
    source_reference_image_ids: [...payload.source.reference_image_ids],
  };
  const idempotencyKey = input.idempotencyKey ?? newIdempotencyKey(now);
  if (!WIRE_ID_PATTERN.test(idempotencyKey)) {
    throw new Error(`生成的幂等键不符合冻结字符集：${idempotencyKey}`);
  }
  const iso = now.toISOString();
  return {
    format_version: DELIVERY_FORMAT_VERSION,
    kind: DELIVERY_KIND,
    submission_id: input.submissionId ?? newSubmissionId(now),
    created_at: iso,
    updated_at: iso,
    record_version: 1,
    identity,
    snapshot: snapshotRef,
    bytes,
    idempotency_key: idempotencyKey,
    target: { ...input.target },
    state: 'idle',
    import_id: null,
    receipt: null,
    error: null,
    attempts: emptyAttempts(),
    owner: null,
    verification: { last_get_at: null, last_get_status: null, last_result: null, local_code: null, message: null },
  };
}

/* ------------------------------------------------------------------------- */
/* Strict structural validation                                              */
/* ------------------------------------------------------------------------- */

export interface RecordValidationOk {
  ok: true;
  record: SubmissionRecordV1;
}
export interface RecordValidationFail {
  ok: false;
  code: DeliveryPersistenceCode;
  field: string;
  message: string;
}

class RecordFailure extends Error {
  readonly code: DeliveryPersistenceCode;
  readonly field: string;
  constructor(field: string, message: string, code: DeliveryPersistenceCode = 'DLV_INVALID_RECORD') {
    super(clamp(message));
    this.name = 'RecordFailure';
    this.code = code;
    this.field = field;
  }
}

function fail(field: string, message: string, code?: DeliveryPersistenceCode): never {
  throw new RecordFailure(field, message, code);
}

function obj(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field, `字段 ${field} 必须为对象`);
  return value as Record<string, unknown>;
}

function str(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(field, `字段 ${field} 必须为非空字符串`);
  return value;
}

function nullableStr(value: unknown, field: string, max = 4096): string | null {
  if (value === null) return null;
  return str(value, field, max);
}

function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(field, `字段 ${field} 必须为 ${min}..${max} 的整数`);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field, `字段 ${field} 必须为布尔值`);
  return value;
}

function arr(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(field, `字段 ${field} 必须为不超过 ${max} 项的数组`);
  return value;
}

function isoDate(value: unknown, field: string): string {
  const text = str(value, field, 64);
  if (Number.isNaN(Date.parse(text))) fail(field, `字段 ${field} 必须为 ISO-8601 时间`);
  return text;
}

function wireId(value: unknown, field: string): string {
  const text = str(value, field, 128);
  if (!WIRE_ID_PATTERN.test(text)) fail(field, `字段 ${field} 不符合冻结 ID 字符集`);
  return text;
}

function validateReceipt(raw: unknown, field: string): WireReceipt {
  const receipt = obj(raw, field);
  const keys = Object.keys(receipt).sort();
  const expected = [
    'edge_count',
    'graph_id',
    'import_id',
    'node_count',
    'producer_instance_id',
    'revision',
    'schema_version',
    'status',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${field}`, '回执字段集合与冻结 schema 不一致');
  }
  return {
    import_id: wireId(receipt.import_id, `${field}.import_id`),
    schema_version: str(receipt.schema_version, `${field}.schema_version`, 128),
    producer_instance_id: wireId(receipt.producer_instance_id, `${field}.producer_instance_id`),
    graph_id: wireId(receipt.graph_id, `${field}.graph_id`),
    revision: int(receipt.revision, `${field}.revision`, 1, 9_007_199_254_740_991),
    status: str(receipt.status, `${field}.status`, 64),
    node_count: int(receipt.node_count, `${field}.node_count`, 2, 2048),
    edge_count: int(receipt.edge_count, `${field}.edge_count`, 1, 2047),
  };
}

const STATES: readonly DeliveryWireState[] = ['idle', 'submitting', 'confirmed', 'rejected', 'pending_reconcile'];

function validateAttempts(raw: unknown): SubmissionAttempts {
  const attempts = obj(raw, 'attempts');
  const history = arr(attempts.history, 'attempts.history', 4096).map((entry, index) => {
    const row = obj(entry, `attempts.history[${index}]`);
    const outcome = str(row.outcome, `attempts.history[${index}].outcome`, 32);
    if (!['http', 'network_error', 'timeout', 'storage_error', 'blocked', 'aborted'].includes(outcome)) {
      fail(`attempts.history[${index}].outcome`, '未知的尝试结果');
    }
    const kind = str(row.kind, `attempts.history[${index}].kind`, 32);
    if (!['initial', 'manual', 'automatic', 'reconcile'].includes(kind)) {
      fail(`attempts.history[${index}].kind`, '未知的尝试类型');
    }
    return {
      index: int(row.index, `attempts.history[${index}].index`, 0, 1_000_000),
      kind: kind as AttemptEntry['kind'],
      started_at: isoDate(row.started_at, `attempts.history[${index}].started_at`),
      finished_at: row.finished_at === null ? null : isoDate(row.finished_at, `attempts.history[${index}].finished_at`),
      duration_ms:
        row.duration_ms === null ? null : int(row.duration_ms, `attempts.history[${index}].duration_ms`, 0, 86_400_000),
      outcome: outcome as AttemptEntry['outcome'],
      http_status:
        row.http_status === null ? null : int(row.http_status, `attempts.history[${index}].http_status`, 100, 599),
      wire_code: nullableStr(row.wire_code, `attempts.history[${index}].wire_code`, 64),
      local_code: nullableStr(row.local_code, `attempts.history[${index}].local_code`, 64),
      note: nullableStr(row.note, `attempts.history[${index}].note`, 512),
    };
  });
  return {
    initial_sends: int(attempts.initial_sends, 'attempts.initial_sends', 0, 1_000_000),
    manual_retries: int(attempts.manual_retries, 'attempts.manual_retries', 0, 1_000_000),
    automatic: int(attempts.automatic, 'attempts.automatic', 0, 1_000_000),
    cycle_automatic: int(attempts.cycle_automatic, 'attempts.cycle_automatic', 0, 5),
    exhausted: bool(attempts.exhausted, 'attempts.exhausted'),
    next_attempt_at: attempts.next_attempt_at === null ? null : int(attempts.next_attempt_at, 'attempts.next_attempt_at', 0, Number.MAX_SAFE_INTEGER),
    retry_after_until:
      attempts.retry_after_until === null ? null : int(attempts.retry_after_until, 'attempts.retry_after_until', 0, Number.MAX_SAFE_INTEGER),
    last_attempt_at:
      attempts.last_attempt_at === null ? null : int(attempts.last_attempt_at, 'attempts.last_attempt_at', 0, Number.MAX_SAFE_INTEGER),
    history,
  };
}

function validateError(raw: unknown): SubmissionError | null {
  if (raw === null) return null;
  const error = obj(raw, 'error');
  const source = str(error.source, 'error.source', 16);
  if (source !== 'wire' && source !== 'local') fail('error.source', '错误来源必须为 wire/local');
  return {
    source,
    code: str(error.code, 'error.code', 64),
    message: str(error.message, 'error.message', 512),
    field: nullableStr(error.field, 'error.field', 256),
    node_ids: arr(error.node_ids, 'error.node_ids', 2048).map((id, index) => wireId(id, `error.node_ids[${index}]`)),
    http_status: error.http_status === null ? null : int(error.http_status, 'error.http_status', 100, 599),
    at: isoDate(error.at, 'error.at'),
  };
}

function validateReceiptEnvelope(raw: unknown): StoredReceipt | null {
  if (raw === null) return null;
  const envelope = obj(raw, 'receipt');
  const transport = str(envelope.transport_label, 'receipt.transport_label', 16);
  if (!['simulated', 'live', 'unknown'].includes(transport)) fail('receipt.transport_label', '未知的本地传输标签');
  const receipt = validateReceipt(envelope.receipt, 'receipt.receipt');
  return {
    receipt,
    transport_label: transport as StoredReceipt['transport_label'],
    http_status: int(envelope.http_status, 'receipt.http_status', 100, 599),
    received_at: isoDate(envelope.received_at, 'receipt.received_at'),
    verified_by_get: bool(envelope.verified_by_get, 'receipt.verified_by_get'),
    verified_at: envelope.verified_at === null ? null : isoDate(envelope.verified_at, 'receipt.verified_at'),
  };
}

/** Strict structural validation; returns a copy of the normalized record. */
export function validateSubmissionRecord(raw: unknown): RecordValidationOk | RecordValidationFail {
  try {
    const record = obj(raw, '$');
    if (record.format_version !== DELIVERY_FORMAT_VERSION) {
      fail('format_version', `未知的提交记录版本 ${String(record.format_version)}`, 'DLV_FORMAT_UNKNOWN');
    }
    if (record.kind !== DELIVERY_KIND) fail('kind', '提交记录 kind 不匹配');
    const identityRaw = obj(record.identity, 'identity');
    const cs = obj(identityRaw.coordinate_system, 'identity.coordinate_system');
    if (cs.dimension !== 3 || cs.unit !== 'scene_unit' || cs.handedness !== 'right' || cs.axes !== 'xyz') {
      fail('identity.coordinate_system', '坐标系统字段与冻结值不一致');
    }
    const identity: SubmissionIdentity = {
      producer_instance_id: wireId(identityRaw.producer_instance_id, 'identity.producer_instance_id'),
      graph_id: wireId(identityRaw.graph_id, 'identity.graph_id'),
      frame_id: wireId(identityRaw.frame_id, 'identity.frame_id'),
      revision: int(identityRaw.revision, 'identity.revision', 1, 9_007_199_254_740_991),
      coordinate_system: {
        frame_id: str(cs.frame_id, 'identity.coordinate_system.frame_id', 128),
        dimension: 3,
        unit: 'scene_unit',
        handedness: 'right',
        axes: 'xyz',
      },
    };
    if (identity.frame_id !== identity.coordinate_system.frame_id) fail('identity.frame_id', '图框架与坐标系统框架不一致');

    const snapshotRaw = obj(record.snapshot, 'snapshot');
    const snapshot: SubmissionSnapshotRef = {
      snapshot_id: str(snapshotRaw.snapshot_id, 'snapshot.snapshot_id', 128),
      created_at: isoDate(snapshotRaw.created_at, 'snapshot.created_at'),
      byte_length: int(snapshotRaw.byte_length, 'snapshot.byte_length', 1, 1_048_576),
      sha256: str(snapshotRaw.sha256, 'snapshot.sha256', 64),
      wire_version: str(snapshotRaw.wire_version, 'snapshot.wire_version', 128),
      content_version: str(snapshotRaw.content_version, 'snapshot.content_version', 128),
      content_digest: str(snapshotRaw.content_digest, 'snapshot.content_digest', 64),
      profile: str(snapshotRaw.profile, 'snapshot.profile', 128),
      node_count: int(snapshotRaw.node_count, 'snapshot.node_count', 2, 2048),
      edge_count: int(snapshotRaw.edge_count, 'snapshot.edge_count', 1, 2047),
      source_reference_image_ids: arr(snapshotRaw.source_reference_image_ids, 'snapshot.source_reference_image_ids', 64).map(
        (id, index) => wireId(id, `snapshot.source_reference_image_ids[${index}]`),
      ),
    };
    if (!SHA256_HEX_PATTERN.test(snapshot.sha256)) fail('snapshot.sha256', '快照 SHA-256 必须为 64 位小写十六进制');
    if (!SHA256_HEX_PATTERN.test(snapshot.content_digest)) fail('snapshot.content_digest', '包内容摘要必须为 64 位小写十六进制');
    if (snapshot.edge_count !== snapshot.node_count - 1) fail('snapshot.edge_count', '快照边数必须为结点数减一');

    if (!(record.bytes instanceof Uint8Array)) fail('bytes', '提交记录必须保存原始 UTF-8 字节');
    const bytes = new Uint8Array(record.bytes as Uint8Array);
    if (bytes.byteLength !== snapshot.byte_length) fail('bytes', '提交字节长度与快照记录不一致');

    const targetRaw = obj(record.target, 'target');
    const parsedTarget = parseDeliveryTarget(str(targetRaw.base_url, 'target.base_url', 512), 'live');
    if (!parsedTarget.ok) fail('target.base_url', parsedTarget.message);
    if (parsedTarget.target.base_url !== targetRaw.base_url) fail('target.base_url', '接收基址不是规范化形式');
    const mode = str(targetRaw.mode, 'target.mode', 16);
    if (mode !== 'live' && mode !== 'mock') fail('target.mode', '目标模式必须为 live/mock');

    const state = str(record.state, 'state', 32);
    if (!STATES.includes(state as DeliveryWireState)) fail('state', '未知的提交状态');

    const importId = record.import_id === null ? null : wireId(record.import_id, 'import_id');
    const receipt = validateReceiptEnvelope(record.receipt);
    if (receipt !== null && importId !== null && receipt.receipt.import_id !== importId) {
      fail('receipt.receipt.import_id', '回执 import_id 与记录不一致');
    }
    if (state === 'confirmed' && receipt === null) fail('receipt', 'confirmed 记录必须有已校验回执');

    const ownerRaw = record.owner;
    let owner: SubmissionRecordV1['owner'] = null;
    if (ownerRaw !== null) {
      const ownerObj = obj(ownerRaw, 'owner');
      owner = {
        token: str(ownerObj.token, 'owner.token', 128),
        expires_at: int(ownerObj.expires_at, 'owner.expires_at', 0, Number.MAX_SAFE_INTEGER),
      };
    }

    const verificationRaw = obj(record.verification, 'verification');
    const lastResult = verificationRaw.last_result;
    if (lastResult !== null && !['equivalent', 'mismatch', 'not_found', 'error'].includes(String(lastResult))) {
      fail('verification.last_result', '未知的 GET 核对结果');
    }

    return {
      ok: true,
      record: {
        format_version: DELIVERY_FORMAT_VERSION,
        kind: DELIVERY_KIND,
        submission_id: str(record.submission_id, 'submission_id', 128),
        created_at: isoDate(record.created_at, 'created_at'),
        updated_at: isoDate(record.updated_at, 'updated_at'),
        record_version: int(record.record_version, 'record_version', 1, Number.MAX_SAFE_INTEGER),
        identity,
        snapshot,
        bytes,
        idempotency_key: wireId(record.idempotency_key, 'idempotency_key'),
        target: { base_url: parsedTarget.target.base_url, mode: mode as 'live' | 'mock', saved_at: isoDate(targetRaw.saved_at, 'target.saved_at') },
        state: state as DeliveryWireState,
        import_id: importId,
        receipt,
        error: validateError(record.error),
        attempts: validateAttempts(record.attempts),
        owner,
        verification: {
          last_get_at: verificationRaw.last_get_at === null ? null : isoDate(verificationRaw.last_get_at, 'verification.last_get_at'),
          last_get_status:
            verificationRaw.last_get_status === null
              ? null
              : int(verificationRaw.last_get_status, 'verification.last_get_status', 100, 599),
          last_result: lastResult as SubmissionRecordV1['verification']['last_result'],
          local_code: nullableStr(verificationRaw.local_code, 'verification.local_code', 64),
          message: nullableStr(verificationRaw.message, 'verification.message', 512),
        },
      },
    };
  } catch (error) {
    if (error instanceof RecordFailure) {
      return { ok: false, code: error.code, field: error.field, message: error.message };
    }
    return {
      ok: false,
      code: 'DLV_RECORD_CORRUPT',
      field: '$',
      message: clamp(`提交记录校验异常：${error instanceof Error ? error.message : String(error)}`),
    };
  }
}

/* ------------------------------------------------------------------------- */
/* Local integrity                                                           */
/* ------------------------------------------------------------------------- */

export interface IntegrityResult {
  ok: boolean;
  code: DeliveryLocalCode | null;
  message: string | null;
}

/**
 * Verify the frozen request material before ANY network attempt:
 * bytes length + SHA-256, key charset, and identity/counts re-derived from the
 * exact bytes. A tampered record must never reach the receiver.
 */
export async function verifySubmissionIntegrity(record: SubmissionRecordV1): Promise<IntegrityResult> {
  const bytes = record.bytes;
  if (!WIRE_ID_PATTERN.test(record.idempotency_key)) {
    return { ok: false, code: 'DLV_BYTES_CHANGED', message: '幂等键不符合冻结字符集，拒绝发送。' };
  }
  if (bytes.byteLength !== record.snapshot.byte_length) {
    return { ok: false, code: 'DLV_BYTES_CHANGED', message: '提交字节长度与冻结记录不一致，拒绝发送。' };
  }
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== record.snapshot.sha256) {
    return { ok: false, code: 'DLV_BYTES_CHANGED', message: '提交字节 SHA-256 与冻结记录不一致，拒绝发送。' };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'DLV_BYTES_CHANGED', message: '提交字节不是有效 UTF-8 JSON，拒绝发送。' };
  }
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const adjacency =
    typeof payload.adjacency === 'object' && payload.adjacency !== null
      ? (payload.adjacency as Record<string, string[]>)
      : {};
  const edgeCount =
    Object.values(adjacency).reduce((sum: number, list: string[]) => sum + (Array.isArray(list) ? list.length : 0), 0) / 2;
  const coordinateSystem = (payload.coordinate_system ?? {}) as Record<string, unknown>;
  const mismatches: string[] = [];
  if (payload.schema_version !== record.snapshot.wire_version) mismatches.push('schema_version');
  if (payload.profile !== record.snapshot.profile) mismatches.push('profile');
  if (payload.producer_instance_id !== record.identity.producer_instance_id) mismatches.push('producer_instance_id');
  if (payload.graph_id !== record.identity.graph_id) mismatches.push('graph_id');
  if (payload.revision !== record.identity.revision) mismatches.push('revision');
  if (coordinateSystem.frame_id !== record.identity.frame_id) mismatches.push('frame_id');
  if (nodes.length !== record.snapshot.node_count) mismatches.push('node_count');
  if (edgeCount !== record.snapshot.edge_count) mismatches.push('edge_count');
  if (mismatches.length > 0) {
    return { ok: false, code: 'DLV_BYTES_CHANGED', message: `提交字节与冻结身份/计数不一致：${mismatches.join(',')}。` };
  }
  return { ok: true, code: null, message: null };
}

/* ------------------------------------------------------------------------- */
/* View                                                                      */
/* ------------------------------------------------------------------------- */

export function displayPhase(record: SubmissionRecordV1, now: number): DeliveryDisplayPhase {
  if (record.state === 'confirmed') return 'confirmed';
  if (record.state === 'rejected') return 'rejected';
  if (record.state === 'pending_reconcile') {
    if (record.attempts.exhausted) return 'needs_attention';
    if (record.attempts.next_attempt_at !== null && record.attempts.next_attempt_at > now) return 'waiting_retry';
    return 'needs_attention';
  }
  if (record.state === 'submitting') {
    if (record.attempts.next_attempt_at !== null && record.attempts.next_attempt_at > now) return 'waiting_retry';
    return record.verification.last_get_at !== null || record.import_id !== null ? 'verifying' : 'sending';
  }
  return 'queued';
}

export function toSubmissionView(record: SubmissionRecordV1, now: number = Date.now()): SubmissionView {
  return {
    submission_id: record.submission_id,
    created_at: record.created_at,
    updated_at: record.updated_at,
    graph_id: record.identity.graph_id,
    frame_id: record.identity.frame_id,
    revision: record.identity.revision,
    state: record.state,
    phase: displayPhase(record, now),
    import_id: record.import_id,
    idempotency_key: record.idempotency_key,
    receipt: record.receipt,
    error: record.error,
    target: record.target,
    snapshot: record.snapshot,
    attempts: record.attempts,
    verification: record.verification,
    owner_expires_at: record.owner?.expires_at ?? null,
    transport_label: record.receipt?.transport_label ?? (record.target.mode === 'mock' ? 'simulated' : 'unknown'),
  };
}

/** Local submission reference used in UI labels (never a wire fact). */
export interface SubmissionRef {
  submission_id: string;
  revision: number;
  state: DeliveryWireState;
  import_id: string | null;
}
