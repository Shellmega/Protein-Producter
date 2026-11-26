/**
 * In-memory SubmissionRepository with the same CAS/immutability gate as the
 * IndexedDB implementation. Used by unit tests and by evidence fault injection
 * (the browser path uses IndexedDB; this one never ships to production code).
 */

import {
  type DeliveryPersistenceCode,
  type InvalidSubmissionRecord,
  type SubmissionRecordV1,
  type SubmissionRepository,
  type UpdateSubmissionResult,
} from './types';
import { validateSubmissionRecord, verifySubmissionIntegrity } from './record';

export interface MemoryDeliveryFaults {
  /** Fail the next N creates with a storage error (persist-first failure tests). */
  createFailures: number;
  /** Fail the next N updates with a storage error. */
  updateFailures: number;
}

export interface MemoryDeliveryOptions {
  faults?: Partial<MemoryDeliveryFaults>;
  /** Raw rows to seed for corrupt-record tests (stored untouched). */
  initialRows?: unknown[];
}

function cloneRecord(record: SubmissionRecordV1): SubmissionRecordV1 {
  return {
    ...record,
    identity: { ...record.identity, coordinate_system: { ...record.identity.coordinate_system } },
    snapshot: { ...record.snapshot, source_reference_image_ids: [...record.snapshot.source_reference_image_ids] },
    bytes: new Uint8Array(record.bytes),
    target: { ...record.target },
    receipt: record.receipt ? { ...record.receipt, receipt: { ...record.receipt.receipt } } : null,
    error: record.error ? { ...record.error, node_ids: [...record.error.node_ids] } : null,
    attempts: {
      ...record.attempts,
      history: record.attempts.history.map((entry) => ({ ...entry })),
    },
    owner: record.owner ? { ...record.owner } : null,
    verification: { ...record.verification },
  };
}

export function createMemoryDeliveryRepository(options: MemoryDeliveryOptions = {}): SubmissionRepository {
  const rows = new Map<string, unknown>();
  for (const [index, raw] of (options.initialRows ?? []).entries()) {
    rows.set(`seed-${index}`, raw);
  }
  const faults: MemoryDeliveryFaults = {
    createFailures: options.faults?.createFailures ?? 0,
    updateFailures: options.faults?.updateFailures ?? 0,
  };
  let open = false;
  let invalid: InvalidSubmissionRecord[] = [];

  function storageFailure(code: DeliveryPersistenceCode = 'DLV_STORAGE_FAILED'): { ok: false; code: DeliveryPersistenceCode; message: string } {
    return { ok: false, code, message: '注入的本地存储失败（测试/证据）' };
  }

  function read(raw: unknown): SubmissionRecordV1 | null {
    const row = raw as { record?: unknown };
    const candidate = row && typeof row === 'object' && 'record' in row ? row.record : raw;
    const validation = validateSubmissionRecord(candidate);
    if (!validation.ok) {
      invalid.push({
        submission_id:
          typeof candidate === 'object' && candidate !== null && typeof (candidate as { submission_id?: unknown }).submission_id === 'string'
            ? (candidate as { submission_id: string }).submission_id
            : null,
        code: validation.code,
        field: validation.field,
        message: validation.message,
        raw_preserved: true,
      });
      return null;
    }
    return validation.record;
  }

  return {
    kind: 'memory',
    async open() {
      open = true;
    },
    close() {
      open = false;
    },
    isOpen() {
      return open;
    },
    async listAll() {
      invalid = [];
      const out: SubmissionRecordV1[] = [];
      for (const raw of rows.values()) {
        const record = read(raw);
        if (!record) continue;
        const integrity = await verifySubmissionIntegrity(record);
        if (!integrity.ok) {
          invalid.push({
            submission_id: record.submission_id,
            code: 'DLV_BYTES_MISMATCH',
            field: 'bytes',
            message: integrity.message ?? '提交字节完整性校验失败',
            raw_preserved: true,
          });
          continue;
        }
        out.push(cloneRecord(record));
      }
      return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
    async listInvalid() {
      return [...invalid];
    },
    async get(submissionId) {
      const raw = rows.get(submissionId);
      if (raw === undefined) return null;
      const record = read(raw);
      if (!record) return null;
      const integrity = await verifySubmissionIntegrity(record);
      return integrity.ok ? cloneRecord(record) : null;
    },
    async create(record) {
      const validation = validateSubmissionRecord(record);
      if (!validation.ok) return { ok: false, code: 'DLV_INVALID_RECORD', message: `${validation.field}: ${validation.message}` };
      const integrity = await verifySubmissionIntegrity(validation.record);
      if (!integrity.ok) {
        return { ok: false, code: 'DLV_BYTES_MISMATCH', message: integrity.message ?? '提交字节完整性校验失败' };
      }
      if (faults.createFailures > 0) {
        faults.createFailures -= 1;
        return storageFailure();
      }
      const existing = [...rows.values()].map((raw) => read(raw)).filter((item): item is SubmissionRecordV1 => item !== null);
      const duplicate =
        existing.some((other) => other.submission_id === record.submission_id) ||
        existing.some(
          (other) =>
            (other.identity.producer_instance_id === record.identity.producer_instance_id &&
              other.idempotency_key === record.idempotency_key) ||
            (other.identity.producer_instance_id === record.identity.producer_instance_id &&
              other.identity.graph_id === record.identity.graph_id &&
              other.identity.revision === record.identity.revision &&
              other.snapshot.sha256 === record.snapshot.sha256),
        );
      if (duplicate) return { ok: false, code: 'DLV_CONFLICT', message: '同一快照/幂等键已有提交记录。' };
      const copy = cloneRecord(record);
      rows.set(copy.submission_id, { submission_id: copy.submission_id, record: copy });
      return { ok: true, record: cloneRecord(copy) };
    },
    async update(submissionId, expectedRecordVersion, mutate): Promise<UpdateSubmissionResult> {
      if (faults.updateFailures > 0) {
        faults.updateFailures -= 1;
        return storageFailure();
      }
      const raw = rows.get(submissionId);
      if (raw === undefined) return { ok: false, code: 'DLV_CONFLICT', message: '提交记录不存在。' };
      const record = read(raw);
      if (record === null) return { ok: false, code: 'DLV_RECORD_CORRUPT', message: '提交记录损坏，保持原样。' };
      if (record.record_version !== expectedRecordVersion) {
        return { ok: false, code: 'DLV_CONFLICT', message: '提交记录已被另一页面更新（CAS 不匹配）。' };
      }
      const next = mutate(cloneRecord(record));
      if (next === null) return { ok: false, code: 'DLV_CONFLICT', message: '状态转换被拒绝。' };
      const validation = validateSubmissionRecord({ ...next, record_version: record.record_version + 1 });
      if (!validation.ok) return { ok: false, code: 'DLV_INVALID_RECORD', message: `${validation.field}: ${validation.message}` };
      const record2 = validation.record;
      const frozenFields = JSON.stringify([
        record2.submission_id,
        record2.created_at,
        record2.identity,
        record2.snapshot,
        record2.idempotency_key,
        record2.target,
        Array.from(record2.bytes),
      ]);
      const originalFields = JSON.stringify([
        record.submission_id,
        record.created_at,
        record.identity,
        record.snapshot,
        record.idempotency_key,
        record.target,
        Array.from(record.bytes),
      ]);
      if (frozenFields !== originalFields) {
        return { ok: false, code: 'DLV_INVALID_RECORD', message: '禁止修改冻结的身份/快照/键/目标/字节。' };
      }
      rows.set(submissionId, { submission_id: submissionId, record: record2 });
      return { ok: true, record: cloneRecord(record2) };
    },
  };
}

/** Test helper: exhaust create faults after tests mutated them. */
export function resetMemoryDeliveryFaults(faults: MemoryDeliveryFaults): void {
  faults.createFailures = 0;
  faults.updateFailures = 0;
}
