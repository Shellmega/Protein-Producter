/**
 * IndexedDB SubmissionRepository.
 *
 * Shares the `ptg-local` database (version 2) with the draft repository but
 * uses its own `submissions` object store: local drafts / reference blobs are
 * never migrated, rewritten or removed by the delivery feature.
 *
 * Every state write is one read-modify-write transaction with a CAS on
 * `record_version`. Two same-origin pages therefore cannot overwrite each
 * other's task content, state is monotonically updated through the state
 * machine gate, and attempt counters stay persisted.
 */

import {
  DELIVERY_DB_NAME,
  DELIVERY_DB_VERSION,
  DELIVERY_META_FORMAT_KEY,
  DELIVERY_META_STORE,
  DELIVERY_FORMAT_VERSION,
  SUBMISSIONS_STORE,
  type CreateSubmissionResult,
  type DeliveryPersistenceCode,
  type InvalidSubmissionRecord,
  type SubmissionRecordV1,
  type SubmissionRepository,
  type UpdateSubmissionResult,
} from './types';
import { validateSubmissionRecord, verifySubmissionIntegrity } from './record';

const DRAFT_STORE = 'drafts';
const BLOB_STORE = 'blobs';
const META_STORE = 'meta';

interface SubmissionRow {
  submission_id: string;
  record: unknown;
}

export interface DeliveryIdbOptions {
  dbName?: string;
  factory?: IDBFactory;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function mapError(error: unknown): DeliveryPersistenceCode {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : null;
  if (name === 'QuotaExceededError') return 'DLV_QUOTA_EXCEEDED';
  if (name === 'AbortError') return 'DLV_TX_ABORTED';
  if (name === 'VersionError' || name === 'InvalidStateError') return 'DLV_STORAGE_UNAVAILABLE';
  return 'DLV_IO_ERROR';
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Create every store this app expects, so the first open can be either module. */
function ensureSchema(database: IDBDatabase, upgrading: boolean): void {
  if (!database.objectStoreNames.contains(DRAFT_STORE)) {
    database.createObjectStore(DRAFT_STORE, { keyPath: 'slot' });
  }
  if (!database.objectStoreNames.contains(BLOB_STORE)) {
    database.createObjectStore(BLOB_STORE, { keyPath: 'key' });
  }
  if (!database.objectStoreNames.contains(META_STORE)) {
    database.createObjectStore(META_STORE, { keyPath: 'k' });
  }
  if (!database.objectStoreNames.contains(SUBMISSIONS_STORE)) {
    database.createObjectStore(SUBMISSIONS_STORE, { keyPath: 'submission_id' });
  }
  if (!database.objectStoreNames.contains(DELIVERY_META_STORE)) {
    database.createObjectStore(DELIVERY_META_STORE, { keyPath: 'k' });
  }
  void upgrading;
}

export function createDeliveryIdbRepository(options: DeliveryIdbOptions = {}): SubmissionRepository {
  const dbName = options.dbName ?? DELIVERY_DB_NAME;
  const factoryImpl = options.factory;
  let db: IDBDatabase | null = null;
  let opening: Promise<void> | null = null;
  let invalid: InvalidSubmissionRecord[] = [];

  function factory(): IDBFactory {
    if (factoryImpl) return factoryImpl;
    if (typeof globalThis.indexedDB === 'undefined') {
      throw new Error('当前环境没有 IndexedDB');
    }
    return globalThis.indexedDB;
  }

  function openDatabase(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory().open(dbName, DELIVERY_DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      request.onupgradeneeded = () => {
        try {
          ensureSchema(request.result, true);
          const tx = request.transaction;
          if (tx !== null) {
            tx.objectStore(DELIVERY_META_STORE).put({ k: DELIVERY_META_FORMAT_KEY, v: DELIVERY_FORMAT_VERSION });
          }
        } catch {
          // A failed upgrade aborts the open request; onerror maps it.
        }
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error('数据库被其它页面占用，无法完成升级'));
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error ?? new Error('IndexedDB 打开失败'));
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          if (db === database) db = null;
        };
        db = database;
        resolve();
      };
    });
  }

  async function open(): Promise<void> {
    if (db !== null) return;
    if (opening === null) {
      opening = openDatabase().finally(() => {
        opening = null;
      });
    }
    await opening;
  }

  function close(): void {
    db?.close();
    db = null;
    opening = null;
  }

  function isOpen(): boolean {
    return db !== null;
  }

  async function database(): Promise<IDBDatabase> {
    if (db === null) await open();
    if (db === null) throw new Error('数据库连接已关闭');
    return db;
  }

  function readRecord(raw: unknown): SubmissionRecordV1 | null {
    const row = raw as { record?: unknown };
    const candidate = row && typeof row === 'object' && 'record' in row ? row.record : raw;
    const validation = validateSubmissionRecord(candidate);
    if (!validation.ok) {
      invalid.push({
        submission_id:
          typeof candidate === 'object' && candidate !== null && typeof (candidate as { submission_id?: unknown }).submission_id === 'string'
            ? ((candidate as { submission_id: string }).submission_id)
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

  async function listAll(): Promise<SubmissionRecordV1[]> {
    invalid = [];
    const databaseHandle = await database();
    const tx = databaseHandle.transaction([SUBMISSIONS_STORE], 'readonly');
    const rows = await requestToPromise(tx.objectStore(SUBMISSIONS_STORE).getAll());
    await txDone(tx);
    const records: SubmissionRecordV1[] = [];
    for (const raw of rows) {
      const record = readRecord(raw);
      if (record === null) continue;
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
      records.push(record);
    }
    return records.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async function listInvalid(): Promise<InvalidSubmissionRecord[]> {
    return [...invalid];
  }

  async function get(submissionId: string): Promise<SubmissionRecordV1 | null> {
    const databaseHandle = await database();
    const tx = databaseHandle.transaction([SUBMISSIONS_STORE], 'readonly');
    const raw = await requestToPromise(tx.objectStore(SUBMISSIONS_STORE).get(submissionId));
    await txDone(tx);
    if (raw === null || raw === undefined) return null;
    const record = readRecord(raw);
    if (record === null) return null;
    const integrity = await verifySubmissionIntegrity(record);
    return integrity.ok ? record : null;
  }

  async function create(record: SubmissionRecordV1): Promise<CreateSubmissionResult> {
    const validation = validateSubmissionRecord(record);
    if (!validation.ok) {
      return { ok: false, code: 'DLV_INVALID_RECORD', message: `${validation.field}: ${validation.message}` };
    }
    let databaseHandle: IDBDatabase;
    try {
      databaseHandle = await database();
    } catch (error) {
      return { ok: false, code: mapError(error), message: messageOf(error) };
    }
    try {
      const tx = databaseHandle.transaction([SUBMISSIONS_STORE], 'readwrite');
      const store = tx.objectStore(SUBMISSIONS_STORE);
      const existing = (await requestToPromise(store.getAll())) as SubmissionRow[];
      const duplicateId = existing.some((row) => row.submission_id === record.submission_id);
      const duplicateKey = existing.some((row) => {
        const candidate = validateSubmissionRecord(row.record);
        if (!candidate.ok) return false;
        const other = candidate.record;
        return (
          (other.identity.producer_instance_id === record.identity.producer_instance_id &&
            other.idempotency_key === record.idempotency_key) ||
          (other.identity.producer_instance_id === record.identity.producer_instance_id &&
            other.identity.graph_id === record.identity.graph_id &&
            other.identity.revision === record.identity.revision &&
            other.snapshot.sha256 === record.snapshot.sha256)
        );
      });
      if (duplicateId || duplicateKey) {
        await txDone(tx).catch(() => undefined);
        return {
          ok: false,
          code: 'DLV_CONFLICT',
          message: '同一快照/幂等键已有提交记录；请复用原提交而不是新建。',
        };
      }
      store.put({ submission_id: record.submission_id, record });
      await txDone(tx);
      return { ok: true, record };
    } catch (error) {
      return { ok: false, code: mapError(error), message: messageOf(error) };
    }
  }

  async function update(
    submissionId: string,
    expectedRecordVersion: number,
    mutate: (current: SubmissionRecordV1) => SubmissionRecordV1 | null,
  ): Promise<UpdateSubmissionResult> {
    let databaseHandle: IDBDatabase;
    try {
      databaseHandle = await database();
    } catch (error) {
      return { ok: false, code: mapError(error), message: messageOf(error) };
    }
    try {
      const tx = databaseHandle.transaction([SUBMISSIONS_STORE], 'readwrite');
      const store = tx.objectStore(SUBMISSIONS_STORE);
      const raw = await requestToPromise(store.get(submissionId));
      if (raw === null || raw === undefined) {
        await txDone(tx).catch(() => undefined);
        return { ok: false, code: 'DLV_CONFLICT', message: '提交记录不存在。' };
      }
      const record = readRecord(raw);
      if (record === null) {
        await txDone(tx).catch(() => undefined);
        return { ok: false, code: 'DLV_RECORD_CORRUPT', message: '提交记录损坏，保持原样。' };
      }
      if (record.record_version !== expectedRecordVersion) {
        await txDone(tx).catch(() => undefined);
        return { ok: false, code: 'DLV_CONFLICT', message: '提交记录已被另一页面更新（CAS 不匹配）。' };
      }
      const next = mutate(record);
      if (next === null) {
        await txDone(tx).catch(() => undefined);
        return { ok: false, code: 'DLV_CONFLICT', message: '状态转换被拒绝。' };
      }
      const frozen = validateSubmissionRecord({ ...next, record_version: record.record_version + 1 });
      if (!frozen.ok) {
        await txDone(tx).catch(() => undefined);
        return { ok: false, code: 'DLV_INVALID_RECORD', message: `${frozen.field}: ${frozen.message}` };
      }
      if (frozen.record.bytes.byteLength !== record.bytes.byteLength || frozen.record.snapshot.sha256 !== record.snapshot.sha256) {
        await txDone(tx).catch(() => undefined);
        return { ok: false, code: 'DLV_BYTES_MISMATCH', message: '禁止修改冻结字节。' };
      }
      const frozenFields = JSON.stringify({
        submission_id: frozen.record.submission_id,
        created_at: frozen.record.created_at,
        identity: frozen.record.identity,
        snapshot: frozen.record.snapshot,
        idempotency_key: frozen.record.idempotency_key,
        target: frozen.record.target,
      });
      const originalFields = JSON.stringify({
        submission_id: record.submission_id,
        created_at: record.created_at,
        identity: record.identity,
        snapshot: record.snapshot,
        idempotency_key: record.idempotency_key,
        target: record.target,
      });
      if (frozenFields !== originalFields) {
        await txDone(tx).catch(() => undefined);
        return { ok: false, code: 'DLV_INVALID_RECORD', message: '禁止修改冻结的身份/快照/键/目标。' };
      }
      store.put({ submission_id: submissionId, record: frozen.record });
      await txDone(tx);
      return { ok: true, record: frozen.record };
    } catch (error) {
      return { ok: false, code: mapError(error), message: messageOf(error) };
    }
  }

  return {
    kind: 'indexeddb',
    open,
    close,
    isOpen,
    listAll,
    listInvalid,
    get,
    create,
    update,
  };
}
