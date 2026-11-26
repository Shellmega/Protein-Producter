/**
 * In-memory DraftRepository for unit tests.
 *
 * Semantics intentionally mirror the IndexedDB repository:
 * - one logical slot, compare-and-set protection, record + blob saved together,
 * - one-shot fault injection to exercise every failure path deterministically
 *   (including a simulated transaction abort that leaves the previous complete
 *   record intact).
 *
 * The initializer accepts untrusted `unknown` so tests can seed corrupt or
 * future-version records and verify they are preserved, never repaired.
 */

import {
  type DraftRepository,
  type LoadDraftResult,
  type LocalStorageCode,
  type SaveDraftInput,
  type SaveDraftResult,
} from './types';
import {
  checkSaveInput,
  gateSave,
  localMessage,
  sha256Hex,
  summarizeStoredDraft,
  validateStoredDraft,
  verifyContentDigest,
  type ExistingDraftSummary,
} from './record';

export interface MemoryFault {
  mode: 'save-fail' | 'load-fail' | 'abort-after-write' | 'quota';
  code?: LocalStorageCode;
}

export interface MemoryRepository extends DraftRepository {
  /** Inject a one-shot failure for the next matching operation. */
  fault(fault: MemoryFault): void;
  /** Raw stored record (deep clone) for integrity assertions in tests. */
  rawStored(): unknown;
}

interface StoredMemoryBlob {
  bytes: Uint8Array;
  mimeType: string;
  /** null for seeded initial blobs: derived lazily from the bytes on load. */
  sha256: string | null;
}

/** Fixed estimate reported by the memory backend. */
const MEMORY_QUOTA = { usage: 0, quota: 1024 * 1024 } as const;

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

export function createMemoryRepository(initial?: {
  record?: unknown;
  blob?: { bytes: Uint8Array; mimeType: string } | null;
}): MemoryRepository {
  let opened = false;
  let storedRecord: unknown = initial?.record === undefined ? null : cloneValue(initial.record);
  let storedBlob: StoredMemoryBlob | null =
    initial?.blob === undefined || initial.blob === null
      ? null
      : { bytes: cloneBytes(initial.blob.bytes), mimeType: initial.blob.mimeType, sha256: null };
  let pendingFault: MemoryFault | null = null;

  function takeFault(modes: ReadonlyArray<MemoryFault['mode']>): MemoryFault | null {
    if (pendingFault === null || !modes.includes(pendingFault.mode)) return null;
    const fault = pendingFault;
    pendingFault = null;
    return fault;
  }

  async function open(): Promise<void> {
    opened = true;
  }

  function close(): void {
    opened = false;
  }

  function isOpen(): boolean {
    return opened;
  }

  async function ensureOpen(): Promise<void> {
    if (!opened) await open();
  }

  function saveFailure(
    code: LocalStorageCode,
    message: string,
    existing: ExistingDraftSummary | null = null,
  ): SaveDraftResult {
    return { ok: false, code, message: localMessage(message), existing };
  }

  async function loadCurrent(): Promise<LoadDraftResult | null> {
    await ensureOpen();

    const loadFault = takeFault(['load-fail']);
    if (loadFault !== null) {
      return {
        ok: false,
        code: loadFault.code ?? 'LOCAL_IO_ERROR',
        message: localMessage('本地存储读取失败：暂时无法读取本地草稿'),
        rawPreserved: storedRecord !== null,
      };
    }

    if (storedRecord === null) return null;

    const validation = validateStoredDraft(storedRecord);
    if (!validation.ok) {
      return {
        ok: false,
        code: validation.code,
        message: localMessage(`${validation.message}（字段 ${validation.field}）`),
        rawPreserved: true,
      };
    }

    const record = validation.record;

    // Load-time local integrity gate: the recomputed content digest must match
    // the stored one, exactly like the IndexedDB backend (shared helper).
    const digestCheck = await verifyContentDigest(record);
    if (!digestCheck.ok) {
      return {
        ok: false,
        code: digestCheck.code,
        message: digestCheck.message,
        rawPreserved: true,
      };
    }

    if (record.reference === null) {
      return { ok: true, record: cloneValue(record), blobBytes: null };
    }

    if (storedBlob === null) {
      return {
        ok: false,
        code: 'LOCAL_MISSING_BLOB',
        message: localMessage('本地存储：已存草稿引用了参考图，但图片数据缺失'),
        rawPreserved: true,
      };
    }

    // Always re-hash the stored bytes, mirroring the IndexedDB backend: cached
    // metadata must never hide a byte-level corruption.
    const storedSha = await sha256Hex(storedBlob.bytes);
    storedBlob.sha256 = storedSha;
    if (storedSha !== record.reference.blobSha256) {
      return {
        ok: false,
        code: 'LOCAL_BLOB_MISMATCH',
        message: localMessage('本地存储：参考图摘要与草稿记录不一致，图片可能已损坏'),
        rawPreserved: true,
      };
    }
    if (storedBlob.bytes.byteLength !== record.reference.byteLength) {
      return {
        ok: false,
        code: 'LOCAL_BLOB_MISMATCH',
        message: localMessage('本地存储：参考图字节数与草稿记录不一致'),
        rawPreserved: true,
      };
    }

    return {
      ok: true,
      record: cloneValue(record),
      blobBytes: cloneBytes(storedBlob.bytes),
    };
  }

  async function saveCurrent(input: SaveDraftInput): Promise<SaveDraftResult> {
    await ensureOpen();

    const inputCheck = checkSaveInput(input);
    if (!inputCheck.ok) {
      return saveFailure(inputCheck.code, inputCheck.message);
    }

    const gate = gateSave({
      record: input.record,
      existingRaw: storedRecord,
      replaceGraph: input.replaceGraph,
      expected: input.expected,
    });
    if (!gate.allow) {
      return saveFailure(gate.code, gate.message, gate.existing);
    }

    const saveFault = takeFault(['save-fail', 'quota', 'abort-after-write']);
    if (saveFault !== null) {
      if (saveFault.mode === 'quota') {
        return saveFailure(
          saveFault.code ?? 'LOCAL_QUOTA_EXCEEDED',
          '本地存储空间不足：草稿保存失败，请清理浏览器存储后重试',
        );
      }
      if (saveFault.mode === 'save-fail') {
        return saveFailure(saveFault.code ?? 'LOCAL_IO_ERROR', '本地存储写入失败：草稿未保存');
      }
      // abort-after-write: the transaction wrote and then aborted, so nothing
      // commits and the previous complete record remains readable.
      return saveFailure(
        saveFault.code ?? 'LOCAL_TX_ABORTED',
        '本地存储事务已中止：草稿保持上一次完整状态，未被覆盖',
        summarizeStoredDraft(storedRecord),
      );
    }

    // Commit: record and blob become visible together (atomic in memory too).
    storedRecord = cloneValue(input.record);
    storedBlob =
      input.blob === null
        ? null
        : {
            bytes: cloneBytes(input.blob.bytes),
            mimeType: input.blob.mimeType,
            sha256: input.blob.sha256,
          };
    return {
      ok: true,
      generation: input.record.save_generation,
      saved_at: input.record.saved_at,
    };
  }

  async function clearCurrent(): Promise<void> {
    await ensureOpen();
    storedRecord = null;
    storedBlob = null;
  }

  async function estimateQuota(): Promise<{ usage: number; quota: number } | null> {
    return { usage: MEMORY_QUOTA.usage, quota: MEMORY_QUOTA.quota };
  }

  function fault(nextFault: MemoryFault): void {
    pendingFault = nextFault;
  }

  function rawStored(): unknown {
    return storedRecord === null ? null : cloneValue(storedRecord);
  }

  return {
    kind: 'memory',
    open,
    close,
    isOpen,
    loadCurrent,
    saveCurrent,
    clearCurrent,
    estimateQuota,
    fault,
    rawStored,
  };
}
