/**
 * IndexedDB DraftRepository.
 *
 * Transaction discipline:
 * - Saving happens in exactly ONE `readwrite` transaction over
 *   `drafts` + `blobs` + `meta`: read the existing draft, apply the shared CAS
 *   gate, then write the record and the blob. Nothing is cleared before the
 *   write, so a quota failure or an abort leaves the previous complete record
 *   intact (IndexedDB rolls the whole transaction back).
 * - Loading validates the raw record before touching the blob; corrupt or
 *   future-version records are reported and never deleted or repaired.
 *
 * Domain failures are returned inside the result envelopes. Raw DOMExceptions
 * never escape. `LocalPersistenceError` is thrown only by `open()` (database
 * unavailable/blocked/upgrade failure) and `clearCurrent()` (its signature has
 * no result envelope).
 */

import {
  DRAFT_SLOT,
  LOCAL_FORMAT_VERSION,
  LocalPersistenceError,
  type DraftRepository,
  type LoadDraftResult,
  type LocalStorageCode,
  type SaveDraftInput,
  type SaveDraftResult,
  type StoredBlobV1,
} from './types';
import {
  checkSaveInput,
  describeError,
  gateSave,
  localMessage,
  sha256Hex,
  validateStoredDraft,
  verifyContentDigest,
} from './record';

const DEFAULT_DB_NAME = 'ptg-local';
/**
 * v2 (PTG-4) adds the delivery stores without touching the draft schema:
 * `submissions` (persistent send tasks) and `delivery_meta`. The upgrade is
 * additive, so an existing v1 draft + reference blob are preserved in place.
 */
const DB_VERSION = 2;
const STORE_DRAFTS = 'drafts';
const STORE_BLOBS = 'blobs';
const STORE_META = 'meta';
const STORE_SUBMISSIONS = 'submissions';
const STORE_DELIVERY_META = 'delivery_meta';
const DELIVERY_FORMAT_VERSION = 1;
const SAVE_STORES = [STORE_DRAFTS, STORE_BLOBS, STORE_META] as const;

export interface IndexedDbRepositoryOptions {
  dbName?: string;
  factory?: IDBFactory;
}

interface StoredDraftRow {
  slot: string;
  record: unknown;
}

interface StoredMetaRow {
  k: string;
  v: unknown;
}

interface LoadRow {
  ok: boolean;
  record: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn a stored slot row into the raw record value. A row without a `record`
 * field is passed through unchanged so validation reports it as corrupt instead
 * of silently replacing it.
 */
function extractStoredRecord(raw: unknown): LoadRow {
  if (isObject(raw) && 'record' in raw) return { ok: true, record: raw.record };
  return { ok: false, record: raw };
}

function readStoredBlob(raw: unknown): StoredBlobV1 | null {
  if (!isObject(raw)) return null;
  const key = raw.key;
  const bytes = raw.bytes;
  const mimeType = raw.mimeType;
  const sha256 = raw.sha256;
  if (typeof key !== 'string' || typeof mimeType !== 'string' || typeof sha256 !== 'string') {
    return null;
  }
  if (!(bytes instanceof Uint8Array)) return null;
  return { key, bytes, mimeType, sha256 };
}

function existingBlobKey(raw: unknown): string | null {
  const validation = validateStoredDraft(raw);
  return validation.ok ? validation.record.blob_key : null;
}

function isQuotaExceeded(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'QuotaExceededError') return true;
  const code = (error as { code?: unknown }).code;
  return code === 22;
}

function toLocalError(
  error: unknown,
  fallbackCode: LocalStorageCode,
  message: string,
): LocalPersistenceError {
  if (error instanceof LocalPersistenceError) return error;
  return new LocalPersistenceError(fallbackCode, localMessage(message), describeError(error));
}

function saveFailure(error: unknown): SaveDraftResult {
  if (error instanceof LocalPersistenceError) {
    return { ok: false, code: error.code, message: error.message, existing: null };
  }
  // A synchronous DOMException raised by a write (quota or an aborted
  // transaction) carries the same meaning as an asynchronous transaction error.
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === 'AbortError' || isQuotaExceeded(error)) {
      return transactionFailure(error);
    }
  }
  return {
    ok: false,
    code: 'LOCAL_IO_ERROR',
    message: localMessage('本地存储保存失败：无法访问本地数据库'),
    existing: null,
  };
}

function loadFailure(error: unknown, rawPreserved: boolean): LoadDraftResult {
  if (error instanceof LocalPersistenceError) {
    return { ok: false, code: error.code, message: error.message, rawPreserved };
  }
  return {
    ok: false,
    code: 'LOCAL_IO_ERROR',
    message: localMessage('本地存储读取失败：无法读取本地草稿'),
    rawPreserved,
  };
}

function transactionFailure(error: unknown): SaveDraftResult {
  if (isQuotaExceeded(error)) {
    return {
      ok: false,
      code: 'LOCAL_QUOTA_EXCEEDED',
      message: localMessage('本地存储空间不足：草稿保存失败，请清理浏览器存储后重试'),
      existing: null,
    };
  }
  if (error instanceof LocalPersistenceError) {
    return { ok: false, code: error.code, message: error.message, existing: null };
  }
  return {
    ok: false,
    code: 'LOCAL_TX_ABORTED',
    message: localMessage('本地存储事务已中止：草稿保持上一次完整状态，未被覆盖'),
    existing: null,
  };
}

export function createIndexedDbRepository(options: IndexedDbRepositoryOptions = {}): DraftRepository {
  const dbName = options.dbName ?? DEFAULT_DB_NAME;
  let db: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;
  let openToken = 0;

  function getFactory(): IDBFactory {
    if (options.factory !== undefined) return options.factory;
    if (typeof globalThis.indexedDB === 'undefined') {
      throw new LocalPersistenceError(
        'LOCAL_STORAGE_UNAVAILABLE',
        localMessage('本地存储不可用：当前环境不支持 IndexedDB'),
      );
    }
    return globalThis.indexedDB;
  }

  function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (message: string, detail: string | null): void => {
        if (settled) return;
        settled = true;
        reject(new LocalPersistenceError('LOCAL_STORAGE_UNAVAILABLE', localMessage(message), detail));
      };

      let request: IDBOpenDBRequest;
      try {
        request = factory.open(dbName, DB_VERSION);
      } catch (error) {
        fail('本地存储不可用：无法打开 IndexedDB', describeError(error));
        return;
      }

      request.onupgradeneeded = () => {
        const database = request.result;
        try {
          if (!database.objectStoreNames.contains(STORE_DRAFTS)) {
            database.createObjectStore(STORE_DRAFTS, { keyPath: 'slot' });
          }
          if (!database.objectStoreNames.contains(STORE_BLOBS)) {
            database.createObjectStore(STORE_BLOBS, { keyPath: 'key' });
          }
          if (!database.objectStoreNames.contains(STORE_META)) {
            database.createObjectStore(STORE_META, { keyPath: 'k' });
          }
          if (!database.objectStoreNames.contains(STORE_SUBMISSIONS)) {
            database.createObjectStore(STORE_SUBMISSIONS, { keyPath: 'submission_id' });
          }
          if (!database.objectStoreNames.contains(STORE_DELIVERY_META)) {
            database.createObjectStore(STORE_DELIVERY_META, { keyPath: 'k' });
          }
          const upgradeTransaction = request.transaction;
          if (upgradeTransaction !== null) {
            const metaRow: StoredMetaRow = { k: 'format_version', v: LOCAL_FORMAT_VERSION };
            upgradeTransaction.objectStore(STORE_META).put(metaRow);
            upgradeTransaction
              .objectStore(STORE_DELIVERY_META)
              .put({ k: 'delivery_format_version', v: DELIVERY_FORMAT_VERSION });
          }
        } catch {
          // A failed upgrade aborts the open request; request.onerror maps it.
        }
      };

      request.onblocked = () => {
        fail('本地存储不可用：数据库被其它页面占用，无法完成升级', null);
      };

      request.onerror = () => {
        fail('本地存储不可用：IndexedDB 打开失败', describeError(request.error));
      };

      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        database.onversionchange = () => {
          database.close();
          if (db === database) {
            db = null;
            openToken += 1;
          }
        };
        resolve(database);
      };
    });
  }

  async function open(): Promise<void> {
    if (db !== null) return;
    const token = openToken;
    if (opening === null) opening = openDatabase(getFactory());
    const pending = opening;
    try {
      const database = await pending;
      if (token !== openToken) {
        database.close();
        return;
      }
      db = database;
    } finally {
      if (opening === pending) opening = null;
    }
  }

  function close(): void {
    openToken += 1;
    opening = null;
    const database = db;
    db = null;
    if (database !== null) database.close();
  }

  function isOpen(): boolean {
    return db !== null;
  }

  async function ensureDatabase(): Promise<IDBDatabase> {
    await open();
    if (db === null) {
      throw new LocalPersistenceError(
        'LOCAL_STORAGE_UNAVAILABLE',
        localMessage('本地存储不可用：数据库连接已关闭'),
      );
    }
    return db;
  }

  async function loadCurrentUnverified(): Promise<LoadDraftResult | null> {
    let database: IDBDatabase;
    try {
      database = await ensureDatabase();
    } catch (error) {
      return loadFailure(error, false);
    }

    return new Promise<LoadDraftResult | null>((resolve) => {
      let outcome: LoadDraftResult | null = null;
      let settled = false;
      const finish = (value: LoadDraftResult | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([STORE_DRAFTS, STORE_BLOBS], 'readonly');
      } catch (error) {
        finish(loadFailure(error, false));
        return;
      }
      transaction.onabort = () => finish(loadFailure(transaction.error, true));
      transaction.oncomplete = () => finish(outcome);

      let drafts: IDBObjectStore;
      let request: IDBRequest;
      try {
        drafts = transaction.objectStore(STORE_DRAFTS);
        request = drafts.get(DRAFT_SLOT);
      } catch (error) {
        finish(loadFailure(error, false));
        return;
      }

      request.onerror = () => {
        outcome = loadFailure(request.error, false);
      };

      request.onsuccess = () => {
        try {
          const raw = request.result as unknown;
          if (raw === null || raw === undefined) {
            outcome = null;
            return;
          }

          const row = extractStoredRecord(raw);
          if (!row.ok) {
            outcome = {
              ok: false,
              code: 'LOCAL_RECORD_CORRUPT',
              message: localMessage('本地存储：草稿槽位数据损坏，无法识别记录'),
              rawPreserved: true,
            };
            return;
          }

          const validation = validateStoredDraft(row.record);
          if (!validation.ok) {
            outcome = {
              ok: false,
              code: validation.code,
              message: localMessage(`${validation.message}（字段 ${validation.field}）`),
              rawPreserved: true,
            };
            return;
          }

          const record = validation.record;
          const reference = record.reference;
          if (reference === null) {
            outcome = { ok: true, record, blobBytes: null };
            return;
          }

          const blobKey = record.blob_key;
          if (blobKey === null) {
            outcome = {
              ok: false,
              code: 'LOCAL_RECORD_CORRUPT',
              message: localMessage('本地存储：参考图元数据与图片存储键不一致'),
              rawPreserved: true,
            };
            return;
          }

          const blobs = transaction.objectStore(STORE_BLOBS);
          const blobRequest = blobs.get(blobKey);
          blobRequest.onerror = () => {
            outcome = loadFailure(blobRequest.error, true);
          };
          blobRequest.onsuccess = () => {
            try {
              const rawBlob = blobRequest.result as unknown;
              if (rawBlob === null || rawBlob === undefined) {
                outcome = {
                  ok: false,
                  code: 'LOCAL_MISSING_BLOB',
                  message: localMessage('本地存储：已存草稿引用了参考图，但图片数据缺失'),
                  rawPreserved: true,
                };
                return;
              }
              const storedBlob = readStoredBlob(rawBlob);
              if (
                storedBlob === null ||
                storedBlob.sha256 !== reference.blobSha256 ||
                storedBlob.bytes.byteLength !== reference.byteLength
              ) {
                outcome = {
                  ok: false,
                  code: 'LOCAL_BLOB_MISMATCH',
                  message: localMessage('本地存储：参考图摘要与草稿记录不一致，图片可能已损坏'),
                  rawPreserved: true,
                };
                return;
              }
              outcome = { ok: true, record, blobBytes: storedBlob.bytes };
            } catch (error) {
              outcome = loadFailure(error, true);
            }
          };
        } catch (error) {
          outcome = loadFailure(error, true);
        }
      };
    });
  }

  /**
   * Load and verify the stored draft. The metadata check inside the unverified
   * loader compares recorded digests; this wrapper additionally
   *
   * 1. recomputes the LOCAL `content_digest` from the stored `content` (shared
   *    helper with the memory backend) and rejects a mismatch with
   *    LOCAL_DIGEST_MISMATCH without rewriting the record, then
   * 2. re-hashes the stored reference-image bytes so a byte-level corruption
   *    cannot be restored silently.
   *
   * The raw record is preserved for recovery in every failure case. (For a
   * record that is both truncated/damaged in the blob and tampered in the
   * content, the blob-level failure is reported first; both are rejected.)
   */
  async function loadCurrent(): Promise<LoadDraftResult | null> {
    const result = await loadCurrentUnverified();
    if (result === null || !result.ok) {
      return result;
    }
    const digestCheck = await verifyContentDigest(result.record);
    if (!digestCheck.ok) {
      return {
        ok: false,
        code: digestCheck.code,
        message: digestCheck.message,
        rawPreserved: true,
      };
    }
    if (!result.blobBytes || result.record.reference === null) {
      return result;
    }
    const actual = await sha256Hex(result.blobBytes);
    if (actual !== result.record.reference.blobSha256) {
      return {
        ok: false,
        code: 'LOCAL_BLOB_MISMATCH',
        message: localMessage('本地存储：参考图字节与草稿记录的摘要不一致，图片可能已损坏'),
        rawPreserved: true,
      };
    }
    return result;
  }

  async function saveCurrent(input: SaveDraftInput): Promise<SaveDraftResult> {
    const inputCheck = checkSaveInput(input);
    if (!inputCheck.ok) {
      return { ok: false, code: inputCheck.code, message: inputCheck.message, existing: null };
    }

    let database: IDBDatabase;
    try {
      database = await ensureDatabase();
    } catch (error) {
      return saveFailure(error);
    }

    return new Promise<SaveDraftResult>((resolve) => {
      let outcome: SaveDraftResult | null = null;
      let settled = false;
      const finish = (value: SaveDraftResult): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(SAVE_STORES, 'readwrite');
      } catch (error) {
        finish(saveFailure(error));
        return;
      }

      let firstError: unknown = null;
      transaction.onabort = () => finish(transactionFailure(transaction.error ?? firstError));
      transaction.onerror = () => {
        if (firstError === null) firstError = transaction.error;
      };
      transaction.oncomplete = () =>
        finish(
          outcome ?? {
            ok: false,
            code: 'LOCAL_TX_ABORTED',
            message: localMessage('本地存储事务已中止：草稿保持上一次完整状态，未被覆盖'),
            existing: null,
          },
        );

      let drafts: IDBObjectStore;
      let readRequest: IDBRequest;
      try {
        drafts = transaction.objectStore(STORE_DRAFTS);
        readRequest = drafts.get(DRAFT_SLOT);
      } catch (error) {
        finish(saveFailure(error));
        return;
      }

      readRequest.onerror = () => {
        if (firstError === null) firstError = readRequest.error;
      };

      readRequest.onsuccess = () => {
        try {
          const rawRow = readRequest.result as unknown;
          const existingRaw: unknown =
            rawRow === null || rawRow === undefined ? null : extractStoredRecord(rawRow).record;
          const gate = gateSave({
            record: input.record,
            existingRaw,
            replaceGraph: input.replaceGraph,
            expected: input.expected,
          });
          if (!gate.allow) {
            outcome = {
              ok: false,
              code: gate.code,
              message: gate.message,
              existing: gate.existing,
            };
            return;
          }

          const previousBlobKey = existingBlobKey(existingRaw);
          const draftRow: StoredDraftRow = { slot: DRAFT_SLOT, record: input.record };
          drafts.put(draftRow);

          const blobs = transaction.objectStore(STORE_BLOBS);
          const nextBlobKey = input.record.blob_key;
          if (input.blob !== null && nextBlobKey !== null) {
            const storedBlob: StoredBlobV1 = {
              key: nextBlobKey,
              bytes: input.blob.bytes,
              mimeType: input.blob.mimeType,
              sha256: input.blob.sha256,
            };
            blobs.put(storedBlob);
          }
          if (previousBlobKey !== null && previousBlobKey !== nextBlobKey) {
            blobs.delete(previousBlobKey);
          }

          outcome = {
            ok: true,
            generation: input.record.save_generation,
            saved_at: input.record.saved_at,
          };
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            // The transaction already finished; the mapped failure below wins.
          }
          finish(saveFailure(error));
        }
      };
    });
  }

  async function clearCurrent(): Promise<void> {
    const database = await ensureDatabase();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([STORE_DRAFTS, STORE_BLOBS], 'readwrite');
      } catch (error) {
        reject(toLocalError(error, 'LOCAL_IO_ERROR', '本地存储：无法开始清除事务'));
        return;
      }

      let firstError: unknown = null;
      transaction.onabort = () => {
        reject(
          toLocalError(
            transaction.error ?? firstError,
            'LOCAL_TX_ABORTED',
            '本地存储事务已中止：草稿未被删除',
          ),
        );
      };
      transaction.onerror = () => {
        if (firstError === null) firstError = transaction.error;
      };
      transaction.oncomplete = () => resolve();

      let drafts: IDBObjectStore;
      let readRequest: IDBRequest;
      try {
        drafts = transaction.objectStore(STORE_DRAFTS);
        readRequest = drafts.get(DRAFT_SLOT);
      } catch (error) {
        reject(toLocalError(error, 'LOCAL_IO_ERROR', '本地存储：无法开始清除事务'));
        return;
      }

      readRequest.onerror = () => {
        if (firstError === null) firstError = readRequest.error;
      };
      readRequest.onsuccess = () => {
        try {
          const rawRow = readRequest.result as unknown;
          const existingRaw: unknown =
            rawRow === null || rawRow === undefined ? null : extractStoredRecord(rawRow).record;
          const blobKey = existingRaw === null ? null : existingBlobKey(existingRaw);
          drafts.delete(DRAFT_SLOT);
          if (blobKey !== null) transaction.objectStore(STORE_BLOBS).delete(blobKey);
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            // The transaction already finished; the rejection below wins.
          }
          reject(toLocalError(error, 'LOCAL_IO_ERROR', '本地存储：无法清除本地草稿'));
        }
      };
    });
  }

  async function estimateQuota(): Promise<{ usage: number; quota: number } | null> {
    if (typeof navigator === 'undefined') return null;
    const storage = navigator.storage;
    if (storage === undefined || typeof storage.estimate !== 'function') return null;
    try {
      const estimate = await storage.estimate();
      return {
        usage: typeof estimate.usage === 'number' ? estimate.usage : 0,
        quota: typeof estimate.quota === 'number' ? estimate.quota : 0,
      };
    } catch {
      return null;
    }
  }

  return {
    kind: 'indexeddb',
    open,
    close,
    isOpen,
    loadCurrent,
    saveCurrent,
    clearCurrent,
    estimateQuota,
  };
}
