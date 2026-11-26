/**
 * PTG-4 delivery session: persist-first submission, network attempts, frozen
 * retry policy, GET reconciliation, same-origin two-page coordination and boot
 * resume.
 *
 * Invariants (see docs/implementation/PTG-4_delivery_v1.md and spec §7):
 * - A request is only ever built from a frozen submission record; the live
 *   editor store is read once (to freeze a new snapshot) and never again.
 * - The record (exact bytes + SHA-256 + key + identity + target) is committed
 *   to storage before the first fetch. Storage failure => zero network.
 * - Every state write is a CAS read-modify-write; `confirmed` is never
 *   downgraded by a late/duplicate/failed request.
 * - Only the owner lease performs requests; budgets are persisted.
 */

import { counters } from '../diagnostics';
import { usePtgStore } from '../domain/store';
import { listSnapshots, createSnapshot, type ImmutableSnapshot } from '../contract/snapshot';
import { validateDraftForExport } from '../contract/validate';
import type { ValidationIssue } from '../contract/types';
import {
  DELIVERY_TARGET_STORAGE_KEY,
  OWNER_LEASE_MS,
  REQUEST_TIMEOUT_MS,
  type DeliveryLocalCode,
  type DeliveryStatusView,
  type DeliveryTarget,
  type HttpTransport,
  type InvalidSubmissionRecord,
  type SubmissionError,
  type SubmissionRecordV1,
  type SubmissionRepository,
  type SubmissionView,
  type StoredReceipt,
  type TransportOutcome,
  type WireErrorBody,
} from './types';
import {
  buildSubmission,
  emptyAttempts,
  getUrl,
  newOwnerToken,
  parseDeliveryTarget,
  postUrl,
  toSubmissionView,
  verifySubmissionIntegrity,
} from './record';
import { createDeliveryIdbRepository } from './idb';
import { createMemoryDeliveryRepository } from './memory';
import { createFetchTransport } from './transport';
import { parseErrorBody, parseReceipt, parseReadResponse } from './receipts';
import {
  automaticBudgetLeft,
  canTransition,
  classifyHttpStatus,
  computeNextAttemptAt,
  manualRetryAllowed,
  parseRetryAfter,
  type TransitionReason,
} from './stateMachine';

const MAX_HISTORY = 200;
const CONFIRM_VERIFY_DELAY_MS = 50;

export interface DeliveryOutcome {
  ok: boolean;
  code: string | null;
  message: string | null;
  record: SubmissionRecordV1 | null;
  /** Frozen validation issue when the source graph cannot be exported. */
  issue: ValidationIssue | null;
}

interface AttemptMeta {
  kind: 'initial' | 'manual' | 'automatic' | 'reconcile';
  started_at: string;
  started_ms: number;
}

let repository: SubmissionRepository | null = null;
let transport: HttpTransport = createFetchTransport();
let target: DeliveryTarget | null = null;
let targetSource: 'default' | 'stored' = 'default';
let records: SubmissionRecordV1[] = [];
let invalidRecords: InvalidSubmissionRecord[] = [];
let bootStatus: 'pending' | 'ready' | 'blocked' = 'pending';
let storageMessage: string | null = null;
let bootstrapPromise: Promise<void> | null = null;
let stopped = false;
let ownerToken = newOwnerToken();
let lastStorageError: SubmissionError | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const activeAttempts = new Set<string>();
const abortControllers = new Map<string, AbortController>();
const verifiedThisBoot = new Set<string>();
const confirmVerifyScheduled = new Set<string>();
let visibilityWired = false;
let memoryFallback: SubmissionRepository | null = null;

let statusVersion = 0;
let statusCache: { version: number; view: DeliveryStatusView } | null = null;
const listeners = new Set<() => void>();
let graphRevisionSubscription: (() => void) | null = null;
let watchedGraphRevision: number | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function notify(): void {
  statusVersion += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must not break delivery state updates.
    }
  }
}

export function subscribeDelivery(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentRevision(): number {
  try {
    return usePtgStore.getState().identity.revision;
  } catch {
    return 0;
  }
}

/**
 * Keep `DeliveryStatusView.currentRevision` bound to the live graph revision.
 *
 * The view is cached by `statusVersion`, and a graph edit is not a delivery
 * event, so without this watch the cached revision would only refresh on the
 * next delivery notify (panel poll, send, receipt) — i.e. the panel could show
 * an older revision than the editor, exactly as observed before the send.
 *
 * This watches the revision field only: it invalidates the cached view and
 * notifies UI subscribers, nothing else. Editing still never sends, schedules,
 * retries or writes a submission record.
 */
function watchGraphRevision(): void {
  if (graphRevisionSubscription !== null) return;
  watchedGraphRevision = currentRevision();
  try {
    graphRevisionSubscription = usePtgStore.subscribe((state) => {
      const revision = state.identity.revision;
      if (revision === watchedGraphRevision) return;
      watchedGraphRevision = revision;
      statusCache = null;
      notify();
    });
  } catch {
    graphRevisionSubscription = null;
    watchedGraphRevision = null;
  }
}

function unwatchGraphRevision(): void {
  if (graphRevisionSubscription === null) return;
  try {
    graphRevisionSubscription();
  } finally {
    graphRevisionSubscription = null;
    watchedGraphRevision = null;
  }
}

export function getDeliveryStatus(): DeliveryStatusView {
  if (statusCache !== null && statusCache.version === statusVersion) return statusCache.view;
  const now = Date.now();
  let origin = '';
  try {
    origin = typeof window === 'undefined' ? '' : window.location.origin;
  } catch {
    origin = '';
  }
  const view: DeliveryStatusView = {
    target,
    targetSource,
    storage: repository ? repository.kind : null,
    bootStatus,
    storageMessage,
    records: records.map((record) => toSubmissionView(record, now)),
    currentRevision: currentRevision(),
    inFlight: activeAttempts.size > 0,
    lastError: lastStorageError,
    origin,
    invalidRecords: [...invalidRecords],
    pendingTimerCount: timers.size,
  };
  statusCache = { version: statusVersion, view };
  return view;
}

/* ------------------------------------------------------------------------- */
/* Test / evidence hooks (never used by the normal UI flow)                  */
/* ------------------------------------------------------------------------- */

export interface DeliveryTestHooks {
  repository?: SubmissionRepository;
  transport?: HttpTransport;
  target?: DeliveryTarget | null;
  now?: () => number;
}

/** Reset module state. Unit tests only; production boot never calls it. */
export function resetDeliveryForTests(hooks: DeliveryTestHooks = {}): void {
  unwatchGraphRevision();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  for (const controller of abortControllers.values()) controller.abort();
  abortControllers.clear();
  activeAttempts.clear();
  verifiedThisBoot.clear();
  confirmVerifyScheduled.clear();
  repository?.close();
  repository = hooks.repository ?? null;
  transport = hooks.transport ?? createFetchTransport();
  target = hooks.target ?? null;
  targetSource = hooks.target ? 'stored' : 'default';
  records = [];
  invalidRecords = [];
  bootStatus = 'pending';
  storageMessage = null;
  bootstrapPromise = null;
  stopped = false;
  ownerToken = newOwnerToken();
  lastStorageError = null;
  statusCache = null;
  statusVersion += 1;
  memoryFallback = null;
  notify();
}

export function setDeliveryTransportForTests(next: HttpTransport): void {
  transport = next;
}

export function deliveryRecordsForDiagnostics(): unknown[] {
  return records.map((record) => ({
    ...record,
    bytes_hex: Array.from(record.bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    attempts: { ...record.attempts, history: record.attempts.history.slice(-40) },
  }));
}

/* ------------------------------------------------------------------------- */
/* Target                                                                    */
/* ------------------------------------------------------------------------- */

function loadStoredTarget(): void {
  target = null;
  targetSource = 'default';
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(DELIVERY_TARGET_STORAGE_KEY);
    if (raw === null) return;
    const parsed = JSON.parse(raw) as { base_url?: unknown; mode?: unknown };
    if (typeof parsed.base_url !== 'string') return;
    const mode = parsed.mode === 'mock' ? 'mock' : 'live';
    const result = parseDeliveryTarget(parsed.base_url, mode);
    if (result.ok) {
      target = result.target;
      targetSource = 'stored';
    }
  } catch {
    target = null;
    targetSource = 'default';
  }
}

export function configureDeliveryTarget(baseUrl: string, mode: 'live' | 'mock'): DeliveryOutcome {
  const parsed = parseDeliveryTarget(baseUrl, mode);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code, message: parsed.message, record: null, issue: null };
  }
  target = parsed.target;
  targetSource = 'stored';
  try {
    localStorage.setItem(DELIVERY_TARGET_STORAGE_KEY, JSON.stringify({ base_url: parsed.target.base_url, mode }));
  } catch {
    // A blocked localStorage only means the choice is not remembered.
  }
  notify();
  return { ok: true, code: null, message: `已设置接收基址 ${parsed.target.base_url}（${mode === 'mock' ? '测试替身' : '真实 GTP'}）`, record: null, issue: null };
}

export function deliveryTarget(): DeliveryTarget | null {
  return target;
}

/* ------------------------------------------------------------------------- */
/* Bootstrap                                                                 */
/* ------------------------------------------------------------------------- */

function localError(code: DeliveryLocalCode | string, message: string, httpStatus: number | null = null): SubmissionError {
  return { source: 'local', code, message, field: null, node_ids: [], http_status: httpStatus, at: nowIso() };
}

function wireError(error: WireErrorBody, httpStatus: number | null): SubmissionError {
  return {
    source: 'wire',
    code: error.code,
    message: error.message,
    field: error.field,
    node_ids: [...error.node_ids],
    http_status: httpStatus,
    at: nowIso(),
  };
}

function storageError(code: string, message: string): void {
  lastStorageError = localError(code, message);
  storageMessage = message;
  notify();
}

export function bootstrapDelivery(): Promise<void> {
  // React StrictMode mounts, cleans up and mounts again. The cleanup calls
  // stopDelivery(), so a later bootstrap must re-arm this module instead of
  // leaving every attempt short-circuited by `stopped`.
  const wasStopped = stopped;
  stopped = false;
  watchGraphRevision();
  if (bootstrapPromise !== null) {
    const resumed = wasStopped ? bootstrapPromise.then(() => resumeAfterBoot()) : bootstrapPromise;
    return resumed;
  }
  bootstrapPromise = (async () => {
    if (target === null) loadStoredTarget();
    if (repository === null) {
      try {
        repository = createDeliveryIdbRepository();
        await repository.open();
      } catch (error) {
        repository = null;
        bootStatus = 'blocked';
        storageMessage = `无法打开本地提交记录存储：${error instanceof Error ? error.message : String(error)}；发送已阻止（避免无法恢复的未知送达）。`;
        notify();
        return;
      }
    } else {
      try {
        await repository.open();
      } catch (error) {
        bootStatus = 'blocked';
        storageMessage = `无法打开本地提交记录存储：${error instanceof Error ? error.message : String(error)}；发送已阻止。`;
        notify();
        return;
      }
    }
    try {
      records = await repository.listAll();
      invalidRecords = await repository.listInvalid();
      bootStatus = 'ready';
      storageMessage = null;
    } catch (error) {
      bootStatus = 'blocked';
      storageMessage = `读取本地提交记录失败：${error instanceof Error ? error.message : String(error)}；发送已阻止以保护证据。`;
      notify();
      return;
    }
    notify();
    wireResumeHooks();
    void resumeAfterBoot();
  })();
  return bootstrapPromise;
}

function wireResumeHooks(): void {
  if (visibilityWired || typeof document === 'undefined') return;
  visibilityWired = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void resumeDueSchedules();
  });
  window.addEventListener('online', () => {
    void resumeDueSchedules();
  });
}

async function resumeAfterBoot(): Promise<void> {
  if (stopped) return;
  for (const record of [...records]) {
    if (record.state === 'idle') {
      // Record was committed before the very first request (persist-first), but
      // the request was never started: resume the initial send with the same key.
      scheduleTimer(record.submission_id, Date.now());
      continue;
    }
    if (record.state === 'submitting') {
      // Persisted before the request (or the process died mid-request): the
      // result is unknown. Keep the same key/bytes and retry/reconcile.
      const updated = await updateRecord(record.submission_id, (current) => {
        if (current.state !== 'submitting') return null;
        const next = { ...current, updated_at: nowIso(), owner: null };
        if (!canTransition(current.state, 'pending_reconcile', 'boot_unknown')) return null;
        next.state = 'pending_reconcile';
        next.error = localError(
          'DLV_UNKNOWN_STATUS',
          '页面关闭/重载前请求结果未知；已保留原键与原字节，将以同一请求核对或重试。',
        );
        next.attempts = {
          ...current.attempts,
          exhausted: !automaticBudgetLeft(current.attempts.cycle_automatic) && current.import_id === null,
          next_attempt_at:
            current.import_id !== null || !automaticBudgetLeft(current.attempts.cycle_automatic)
              ? null
              : Date.now(),
          retry_after_until: null,
        };
        return next;
      });
      if (updated) {
        if (updated.import_id !== null) {
          void performGet(updated.submission_id, 'reconcile');
        } else if (updated.attempts.next_attempt_at !== null) {
          scheduleTimer(updated.submission_id, updated.attempts.next_attempt_at);
        }
      }
      continue;
    }
    if (record.state === 'pending_reconcile') {
      if (record.import_id !== null) {
        scheduleTimer(record.submission_id, Date.now());
      } else if (record.attempts.exhausted) {
        continue;
      } else {
        scheduleTimer(record.submission_id, Math.max(Date.now(), record.attempts.next_attempt_at ?? Date.now()));
      }
      continue;
    }
    if (record.state === 'confirmed' && !verifiedThisBoot.has(record.submission_id) && !confirmVerifyScheduled.has(record.submission_id)) {
      confirmVerifyScheduled.add(record.submission_id);
      scheduleTimer(record.submission_id, Date.now() + CONFIRM_VERIFY_DELAY_MS);
    }
  }
}

async function resumeDueSchedules(): Promise<void> {
  const now = Date.now();
  for (const record of [...records]) {
    if (record.state === 'confirmed') {
      if (!verifiedThisBoot.has(record.submission_id) && !confirmVerifyScheduled.has(record.submission_id)) {
        confirmVerifyScheduled.add(record.submission_id);
        scheduleTimer(record.submission_id, now);
      }
      continue;
    }
    if (record.state !== 'pending_reconcile' && record.state !== 'idle') continue;
    if (record.attempts.exhausted) continue;
    const due = record.attempts.next_attempt_at;
    if (due === null) continue;
    if (due <= now) {
      if (record.import_id !== null) {
        void performGet(record.submission_id, 'reconcile');
      } else {
        scheduleTimer(record.submission_id, now);
      }
    } else {
      scheduleTimer(record.submission_id, due);
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Record list helpers                                                       */
/* ------------------------------------------------------------------------- */

function upsertRecord(record: SubmissionRecordV1): void {
  const index = records.findIndex((item) => item.submission_id === record.submission_id);
  if (index >= 0) records[index] = record;
  else records.push(record);
  records = [...records];
  statusCache = null;
}

async function currentRecord(submissionId: string): Promise<SubmissionRecordV1 | null> {
  const local = records.find((record) => record.submission_id === submissionId);
  if (local) return local;
  if (!repository) return null;
  return repository.get(submissionId);
}

async function refreshRecords(): Promise<void> {
  if (!repository) return;
  records = await repository.listAll();
  invalidRecords = await repository.listInvalid();
  statusCache = null;
  notify();
}

/**
 * CAS read-modify-write loop. The mutator receives the latest persisted record
 * and returns the next one (or null to abort). A concurrent page write makes
 * the loop re-read instead of overwriting.
 */
async function updateRecord(
  submissionId: string,
  mutate: (current: SubmissionRecordV1) => SubmissionRecordV1 | null,
): Promise<SubmissionRecordV1 | null> {
  if (!repository) return null;
  for (let attempts = 0; attempts < 6; attempts += 1) {
    const current = await currentRecord(submissionId);
    if (current === null) return null;
    let produced: SubmissionRecordV1 | null = null;
    const result = await repository.update(submissionId, current.record_version, (latest) => {
      produced = mutate(latest);
      return produced;
    });
    if (result.ok) {
      upsertRecord(result.record);
      notify();
      return result.record;
    }
    if (result.code === 'DLV_CONFLICT') {
      await refreshRecords();
      continue;
    }
    lastStorageError = localError(result.code, `本地提交记录写入失败：${result.message}`);
    notify();
    return null;
  }
  lastStorageError = localError('DLV_CONFLICT', '提交记录持续被另一页面更新，本次操作未应用。');
  notify();
  return null;
}

/* ------------------------------------------------------------------------- */
/* Snapshot capture                                                          */
/* ------------------------------------------------------------------------- */

async function snapshotFor(payload: import('../contract/types').WireRequest): Promise<ImmutableSnapshot> {
  const serialized = JSON.stringify(payload);
  for (const snapshot of listSnapshots()) {
    if (snapshot.local.graph_id === payload.graph_id && snapshot.local.revision === payload.revision) {
      try {
        if (JSON.stringify(snapshot.payload) === serialized) return snapshot;
      } catch {
        // ignore and continue
      }
    }
  }
  counters.snapshotsCreated += 1;
  return createSnapshot(payload);
}

/* ------------------------------------------------------------------------- */
/* Public operations                                                         */
/* ------------------------------------------------------------------------- */

export async function sendCurrentGraph(): Promise<DeliveryOutcome> {
  await bootstrapDelivery();
  if (bootStatus !== 'ready' || repository === null) {
    return {
      ok: false,
      code: 'DLV_NOT_SENT_STORAGE',
      message: storageMessage ?? '本地提交记录存储不可用，未发送（避免无法恢复的未知送达）。',
      record: null,
      issue: null,
    };
  }
  const current = usePtgStore.getState();
  const validation = validateDraftForExport({ identity: current.identity, content: current.content });
  if (!validation.ok || validation.payload === null) {
    return {
      ok: false,
      code: 'DLV_NOT_SENT_INVALID_GRAPH',
      message: `当前图未通过冻结校验，未建立提交也未发送：${validation.primary?.message ?? '未知校验错误'}`,
      record: null,
      issue: validation.primary,
    };
  }
  if (target === null) {
    return {
      ok: false,
      code: 'DLV_TARGET_INVALID',
      message: '尚未设置接收基址；请先填写并保存目标地址。',
      record: null,
      issue: null,
    };
  }
  let snapshot: ImmutableSnapshot;
  try {
    snapshot = await snapshotFor(validation.payload);
  } catch (error) {
    return {
      ok: false,
      code: 'DLV_NOT_SENT_NO_SNAPSHOT',
      message: `无法生成不可变快照：${error instanceof Error ? error.message : String(error)}`,
      record: null,
      issue: validation.primary,
    };
  }

  const existing = records.find(
    (record) =>
      record.identity.graph_id === snapshot.payload.graph_id &&
      record.identity.revision === snapshot.payload.revision &&
      record.snapshot.sha256 === snapshot.local.sha256,
  );
  if (existing) {
    if (existing.state === 'confirmed') {
      return { ok: true, code: null, message: `该修订已确认，复用原回执 import_id=${existing.import_id ?? '—'}`, record: existing, issue: null };
    }
    if (existing.state === 'rejected') {
      return {
        ok: false,
        code: existing.error?.code ?? 'DLV_RECEIPT_MISMATCH',
        message: '该快照已被接收端拒绝；请修改图（产生新修订与新幂等键）后再发送。',
        record: existing,
        issue: null,
      };
    }
    if (existing.state === 'idle' || (existing.state === 'pending_reconcile' && !existing.attempts.exhausted)) {
      void performAttempt(existing.submission_id, existing.state === 'idle' ? 'initial' : 'manual');
    }
    return { ok: true, code: null, message: '复用同修订同字节的既有提交；未新建幂等键。', record: existing, issue: null };
  }

  let record: SubmissionRecordV1;
  try {
    record = await buildSubmission({ snapshot, target });
  } catch (error) {
    return {
      ok: false,
      code: 'DLV_NOT_SENT_NO_SNAPSHOT',
      message: `无法从快照建立提交：${error instanceof Error ? error.message : String(error)}`,
      record: null,
      issue: null,
    };
  }
  record.state = 'submitting';
  record.attempts = { ...emptyAttempts(), last_attempt_at: Date.now() };
  record.owner = null;
  const created = await repository.create(record);
  if (!created.ok) {
    if (created.code === 'DLV_CONFLICT') {
      await refreshRecords();
      const raced = records.find(
        (item) =>
          item.identity.graph_id === record.identity.graph_id &&
          item.identity.revision === record.identity.revision &&
          item.snapshot.sha256 === record.snapshot.sha256,
      );
      if (raced) {
        if (raced.state === 'idle') void performAttempt(raced.submission_id, 'initial');
        return { ok: true, code: null, message: '另一页面已建立相同提交，复用其原键与原字节。', record: raced, issue: null };
      }
    }
    const message = `本地提交记录落盘失败（${created.code}）：未发送任何网络请求。${created.message}`;
    storageError(created.code, message);
    return { ok: false, code: created.code, message, record: null, issue: null };
  }
  upsertRecord(created.record);
  notify();
  await performAttempt(created.record.submission_id, 'initial');
  return {
    ok: true,
    code: null,
    message: '提交记录已先落盘，随后已发送；请查看提交状态。',
    record: (await currentRecord(created.record.submission_id)) ?? created.record,
    issue: null,
  };
}

export async function retrySubmission(submissionId: string): Promise<DeliveryOutcome> {
  await bootstrapDelivery();
  const record = await currentRecord(submissionId);
  if (record === null) {
    return { ok: false, code: 'DLV_CONFLICT', message: '提交记录不存在。', record: null, issue: null };
  }
  if (record.state === 'confirmed') {
    return { ok: true, code: null, message: '该提交已确认；无需重试。', record, issue: null };
  }
  if (!manualRetryAllowed(record.state, record.error?.code ?? null) && record.state !== 'idle') {
    return {
      ok: false,
      code: record.error?.code ?? 'DLV_RETRY_EXHAUSTED',
      message:
        record.state === 'rejected'
          ? '该结果不允许自动或手动重试；请修改图以产生新修订与新幂等键。'
          : '当前状态不允许手动重试。',
      record,
      issue: null,
    };
  }
  if (record.import_id !== null && record.receipt === null) {
    await performGet(submissionId, 'reconcile');
  } else {
    await performAttempt(submissionId, 'manual');
  }
  return {
    ok: true,
    code: null,
    message: '已使用原幂等键与原字节发起一次显式重试；结果见状态。',
    record: await currentRecord(submissionId),
    issue: null,
  };
}

export async function reconcileSubmission(submissionId: string): Promise<DeliveryOutcome> {
  await bootstrapDelivery();
  const record = await currentRecord(submissionId);
  if (record === null) {
    return { ok: false, code: 'DLV_CONFLICT', message: '提交记录不存在。', record: null, issue: null };
  }
  if (record.import_id === null) {
    return { ok: false, code: 'DLV_IMPORT_NOT_FOUND', message: '该提交尚无 import_id，无法 GET 核对。', record, issue: null };
  }
  await performGet(submissionId, 'reconcile');
  return {
    ok: true,
    code: null,
    message: '已对该 import_id 执行 GET 核对；结果见状态与诊断。',
    record: await currentRecord(submissionId),
    issue: null,
  };
}

export function cancelLocalWait(submissionId: string): DeliveryOutcome {
  const controller = abortControllers.get(submissionId);
  if (!controller) {
    return { ok: false, code: 'DLV_ABORTED', message: '当前没有可取消的本地等待。', record: null, issue: null };
  }
  controller.abort();
  return { ok: true, code: null, message: '已取消本地等待；服务端是否写入仍未知，不做回滚声明。', record: null, issue: null };
}

/* ------------------------------------------------------------------------- */
/* Attempts                                                                  */
/* ------------------------------------------------------------------------- */

function scheduleTimer(submissionId: string, at: number): void {
  const existing = timers.get(submissionId);
  if (existing !== undefined) {
    clearTimeout(existing);
    timers.delete(submissionId);
  }
  const delay = Math.max(0, Math.min(at - Date.now(), 2_000_000_000));
  const timer = setTimeout(() => {
    timers.delete(submissionId);
    void runScheduled(submissionId);
  }, delay);
  timers.set(submissionId, timer);
}

async function runScheduled(submissionId: string): Promise<void> {
  if (stopped) return;
  const record = await currentRecord(submissionId);
  if (record === null) return;
  if (record.state === 'confirmed') {
    confirmVerifyScheduled.delete(submissionId);
    if (!verifiedThisBoot.has(submissionId)) {
      verifiedThisBoot.add(submissionId);
      await performGet(submissionId, 'reconcile');
    }
    return;
  }
  if (record.state !== 'pending_reconcile' && record.state !== 'idle') return;
  if (record.import_id !== null) {
    await performGet(submissionId, 'reconcile');
    return;
  }
  if (record.attempts.exhausted) return;
  if (!automaticBudgetLeft(record.attempts.cycle_automatic)) {
    await updateRecord(submissionId, (current) => {
      if (current.state !== 'pending_reconcile') return null;
      return {
        ...current,
        updated_at: nowIso(),
        attempts: { ...current.attempts, exhausted: true, next_attempt_at: null },
      };
    });
    return;
  }
  await performAttempt(submissionId, record.state === 'idle' ? 'initial' : 'automatic');
}

function appendHistory(record: SubmissionRecordV1, entry: SubmissionRecordV1['attempts']['history'][number]): SubmissionRecordV1['attempts']['history'] {
  const history = [...record.attempts.history, entry];
  return history.length > MAX_HISTORY ? history.slice(history.length - MAX_HISTORY) : history;
}

interface BeginAttemptResult {
  record: SubmissionRecordV1 | null;
  ownerBusy: boolean;
  exhausted: boolean;
  corrupt: boolean;
}

/** Acquire the owner lease and move the record into `submitting`. */
async function beginAttempt(submissionId: string, kind: AttemptMeta['kind']): Promise<BeginAttemptResult> {
  const flags = { ownerBusy: false, exhausted: false, corrupt: false };
  const updated = await updateRecord(submissionId, (current) => {
    const now = Date.now();
    if (current.state === 'confirmed') return null;
    if (current.owner !== null && current.owner.token !== ownerToken && current.owner.expires_at > now) {
      flags.ownerBusy = true;
      return null;
    }
    if (kind === 'automatic' && !automaticBudgetLeft(current.attempts.cycle_automatic)) {
      flags.exhausted = true;
      return null;
    }
    const reason: TransitionReason =
      kind === 'manual' ? 'manual_retry' : kind === 'automatic' ? 'automatic_retry' : 'user_submit';
    if (!canTransition(current.state, 'submitting', reason)) {
      flags.corrupt = true;
      return null;
    }
    const attempts = { ...current.attempts };
    if (kind === 'manual') {
      attempts.manual_retries += 1;
      attempts.cycle_automatic = 0;
      attempts.exhausted = false;
    } else if (kind === 'automatic') {
      attempts.automatic += 1;
      attempts.cycle_automatic += 1;
    } else {
      // Persist-first may have already persisted the user's send intent; count
      // each frozen snapshot's initial send once, including after a crash resume.
      if (attempts.initial_sends === 0) attempts.initial_sends += 1;
    }
    attempts.last_attempt_at = now;
    attempts.next_attempt_at = null;
    attempts.retry_after_until = null;
    return {
      ...current,
      updated_at: new Date(now).toISOString(),
      state: 'submitting',
      error: null,
      owner: { token: ownerToken, expires_at: now + OWNER_LEASE_MS },
      attempts,
    };
  });
  return { record: updated, ...flags };
}

function historyEntry(
  record: SubmissionRecordV1,
  meta: AttemptMeta,
  _outcome: TransportOutcome | null,
  extra: {
    outcome: SubmissionRecordV1['attempts']['history'][number]['outcome'];
    httpStatus: number | null;
    wireCode: string | null;
    localCode: string | null;
    note: string | null;
  },
): SubmissionRecordV1['attempts']['history'][number] {
  const finished = Date.now();
  return {
    index: record.attempts.history.length + 1,
    kind: meta.kind,
    started_at: meta.started_at,
    finished_at: new Date(finished).toISOString(),
    duration_ms: finished - meta.started_ms,
    outcome: extra.outcome,
    http_status: extra.httpStatus,
    wire_code: extra.wireCode,
    local_code: extra.localCode,
    note: extra.note,
  };
}

interface OutcomePatch {
  state?: SubmissionRecordV1['state'];
  error?: SubmissionError | null;
  importId?: string | null;
  receipt?: SubmissionRecordV1['receipt'] | null | undefined;
  attemptsPatch?: Partial<SubmissionRecordV1['attempts']>;
  historyEntry: SubmissionRecordV1['attempts']['history'][number];
  verification?: SubmissionRecordV1['verification'];
  /**
   * GET contradiction (200 mismatch or 404) may revoke a stored confirmation:
   * the receiver no longer matches the receipt we recorded, so keeping
   * "confirmed" would be a silent claim. Late request results never use this.
   */
  allowRevokeConfirmed?: boolean;
}

async function applyAttemptOutcome(submissionId: string, patch: OutcomePatch): Promise<void> {
  const updated = await updateRecord(submissionId, (current) => {
    const next: SubmissionRecordV1 = { ...current, updated_at: nowIso(), owner: null };
    if (patch.state !== undefined && patch.state !== current.state) {
      const reason: TransitionReason =
        patch.state === 'confirmed'
          ? 'http_201_200'
          : patch.state === 'rejected'
            ? current.state === 'rejected'
              ? 'diagnostic'
              : patch.error?.http_status === 500
                ? 'http_500'
                : 'http_4xx'
            : 'network_or_timeout';
      const allowed =
        canTransition(current.state, patch.state, reason) ||
        (current.state === 'submitting' && patch.state === 'pending_reconcile') ||
        (patch.allowRevokeConfirmed === true && current.state === 'confirmed');
      if (allowed) {
        next.state = patch.state;
      } else if (current.state !== 'confirmed' && current.state !== 'rejected') {
        return null;
      }
      // confirmed/rejected stay as-is; the diagnostic fields below are still
      // persisted so a late failure can never silently downgrade them.
    }
    next.error = patch.error === undefined ? current.error : patch.error;
    if (patch.importId !== undefined) next.import_id = patch.importId;
    if (patch.receipt !== undefined) next.receipt = patch.receipt;
    if (patch.verification !== undefined) next.verification = patch.verification;
    next.attempts = {
      ...current.attempts,
      ...(patch.attemptsPatch ?? {}),
      history: appendHistory(current, patch.historyEntry),
    };
    return next;
  });
  if (updated !== null && updated.state === 'pending_reconcile' && updated.attempts.next_attempt_at !== null) {
    scheduleTimer(submissionId, updated.attempts.next_attempt_at);
  }
}

async function performAttempt(submissionId: string, kind: AttemptMeta['kind']): Promise<void> {
  if (stopped || activeAttempts.has(submissionId)) return;
  const meta: AttemptMeta = { kind, started_at: nowIso(), started_ms: Date.now() };
  activeAttempts.add(submissionId);
  abortControllers.set(submissionId, new AbortController());
  notify();
  try {
    const prepared = await beginAttempt(submissionId, kind);
    if (prepared.record === null) {
      if (prepared.exhausted) {
        await updateRecord(submissionId, (current) => {
          if (current.state === 'confirmed') return null;
          return { ...current, updated_at: nowIso(), attempts: { ...current.attempts, exhausted: true, next_attempt_at: null } };
        });
      }
      if (prepared.ownerBusy) {
        // Another page holds an unexpired lease. Retry shortly after it expires
        // instead of giving up silently (controlled owner-expiry recovery).
        const latest = await currentRecord(submissionId);
        if (latest !== null && latest.state !== 'confirmed' && latest.state !== 'rejected') {
          scheduleTimer(submissionId, (latest.owner?.expires_at ?? Date.now()) + 250);
        }
      }
      return;
    }
    const record = prepared.record;
    const integrity = await verifySubmissionIntegrity(record);
    if (!integrity.ok) {
      await applyAttemptOutcome(submissionId, {
        state: 'pending_reconcile',
        error: localError(integrity.code ?? 'DLV_BYTES_CHANGED', integrity.message ?? '提交字节完整性校验失败'),
        attemptsPatch: { exhausted: true, next_attempt_at: null, last_attempt_at: Date.now() },
        historyEntry: historyEntry(record, meta, null, {
          outcome: 'blocked',
          httpStatus: null,
          wireCode: null,
          localCode: integrity.code ?? 'DLV_BYTES_CHANGED',
          note: integrity.message,
        }),
      });
      return;
    }
    const controller = abortControllers.get(submissionId);
    const outcome = await transport.request({
      method: 'POST',
      url: postUrl(record.target),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': record.idempotency_key },
      body: record.bytes,
      timeoutMs: REQUEST_TIMEOUT_MS,
      signal: controller?.signal,
    });
    await applyPostOutcome(submissionId, record, meta, outcome);
  } finally {
    activeAttempts.delete(submissionId);
    abortControllers.delete(submissionId);
    notify();
  }
}

function transportLabel(record: SubmissionRecordV1, headers: Record<string, string> | null): 'simulated' | 'live' | 'unknown' {
  const mockHeader = headers?.['x-ptg-mock-mode'];
  if (mockHeader !== undefined && mockHeader.toLowerCase().includes('simulat')) return 'simulated';
  if (record.target.mode === 'mock') return 'simulated';
  return 'live';
}

async function applyPostOutcome(
  submissionId: string,
  record: SubmissionRecordV1,
  meta: AttemptMeta,
  outcome: TransportOutcome,
): Promise<void> {
  const expectation = {
    producer_instance_id: record.identity.producer_instance_id,
    graph_id: record.identity.graph_id,
    frame_id: record.identity.frame_id,
    revision: record.identity.revision,
    node_count: record.snapshot.node_count,
    edge_count: record.snapshot.edge_count,
    wire_version: record.snapshot.wire_version,
    known_import_id: record.import_id,
  };

  if (outcome.kind === 'network_error' || outcome.kind === 'timeout' || outcome.kind === 'aborted') {
    const localCode: DeliveryLocalCode =
      outcome.kind === 'timeout' ? 'DLV_UNKNOWN_STATUS' : outcome.kind === 'aborted' ? 'DLV_ABORTED' : 'DLV_UNKNOWN_STATUS';
    const now = Date.now();
    const retryAfter = { kind: 'absent' } as const;
    const budget = automaticBudgetLeft(record.attempts.cycle_automatic);
    const next = budget && outcome.kind !== 'aborted' ? computeNextAttemptAt({ now, cycleAutomatic: record.attempts.cycle_automatic, retryAfter }) : null;
    await applyAttemptOutcome(submissionId, {
      state: 'pending_reconcile',
      error: localError(localCode, outcome.message),
      attemptsPatch: {
        exhausted: next === null ? true : record.attempts.exhausted,
        next_attempt_at: next?.at ?? null,
        last_attempt_at: now,
      },
      historyEntry: historyEntry(record, meta, outcome, {
        outcome: outcome.kind,
        httpStatus: null,
        wireCode: null,
        localCode,
        note: outcome.message,
      }),
    });
    return;
  }

  const response = outcome.response;
  const cls = classifyHttpStatus(response.status);
  if (cls.kind === 'success') {
    const parsed = parseReceipt(response.text, expectation);
    if (parsed.ok) {
      const label = transportLabel(record, response.headers);
      const receipt: StoredReceipt = {
        receipt: parsed.receipt,
        transport_label: label,
        http_status: response.status,
        received_at: nowIso(),
        verified_by_get: false,
        verified_at: null,
      };
      await applyAttemptOutcome(submissionId, {
        state: 'confirmed',
        error: null,
        importId: parsed.receipt.import_id,
        receipt,
        attemptsPatch: { exhausted: false, next_attempt_at: null, retry_after_until: null, last_attempt_at: Date.now() },
        verification: { last_get_at: null, last_get_status: null, last_result: null, local_code: null, message: null },
        historyEntry: historyEntry(record, meta, outcome, {
          outcome: 'http',
          httpStatus: response.status,
          wireCode: null,
          localCode: null,
          note: `已绑定 import_id=${parsed.receipt.import_id}`,
        }),
      });
      return;
    }
    await applyAttemptOutcome(submissionId, {
      state: 'pending_reconcile',
      error: localError(parsed.code, parsed.message, response.status),
      attemptsPatch: { exhausted: true, next_attempt_at: null, last_attempt_at: Date.now() },
      historyEntry: historyEntry(record, meta, outcome, {
        outcome: 'http',
        httpStatus: response.status,
        wireCode: null,
        localCode: parsed.code,
        note: parsed.message,
      }),
    });
    return;
  }

  const errorParsed = parseErrorBody(response.text);
  if (cls.kind === 'rejected' || cls.kind === 'server_failed') {
    await applyAttemptOutcome(submissionId, {
      state: 'rejected',
      error: errorParsed.ok
        ? wireError(errorParsed.error, response.status)
        : localError('DLV_ERROR_BODY_INVALID', `HTTP ${response.status} 的错误体不符合冻结 error schema：${errorParsed.message}`, response.status),
      attemptsPatch: { exhausted: false, next_attempt_at: null, retry_after_until: null, last_attempt_at: Date.now() },
      historyEntry: historyEntry(record, meta, outcome, {
        outcome: 'http',
        httpStatus: response.status,
        wireCode: errorParsed.ok ? errorParsed.error.code : null,
        localCode: errorParsed.ok ? null : 'DLV_ERROR_BODY_INVALID',
        note: errorParsed.ok ? errorParsed.error.message : errorParsed.message,
      }),
    });
    return;
  }

  if (cls.kind === 'transient') {
    const now = Date.now();
    const retryAfter = parseRetryAfter(response.headers?.['retry-after'] ?? null, now);
    const budget = automaticBudgetLeft(record.attempts.cycle_automatic);
    const next = budget ? computeNextAttemptAt({ now, cycleAutomatic: record.attempts.cycle_automatic, retryAfter }) : null;
    await applyAttemptOutcome(submissionId, {
      state: 'pending_reconcile',
      error: errorParsed.ok
        ? wireError(errorParsed.error, response.status)
        : localError('DLV_ERROR_BODY_INVALID', `HTTP ${response.status} 的错误体不符合冻结 error schema：${errorParsed.message}`, response.status),
      attemptsPatch: {
        exhausted: next === null ? true : false,
        next_attempt_at: next?.at ?? null,
        retry_after_until: next?.reason === 'retry_after' ? next.at : null,
        last_attempt_at: now,
      },
      historyEntry: historyEntry(record, meta, outcome, {
        outcome: 'http',
        httpStatus: response.status,
        wireCode: errorParsed.ok ? errorParsed.error.code : null,
        localCode: next?.reason === 'retry_after' ? null : null,
        note: next === null ? '自动重试预算已耗尽' : `下次自动尝试于 ${new Date(next.at).toISOString()}（${next.reason}）`,
      }),
    });
    return;
  }

  // Unknown HTTP status: keep the unknown result visible, do not retry blindly.
  await applyAttemptOutcome(submissionId, {
    state: 'pending_reconcile',
    error: localError(
      'DLV_UNKNOWN_STATUS',
      `收到契约未定义的 HTTP ${response.status}；结果未知，保留原键/原字节与诊断，等待契约明确。`,
      response.status,
    ),
    attemptsPatch: { exhausted: true, next_attempt_at: null, last_attempt_at: Date.now() },
    historyEntry: historyEntry(record, meta, outcome, {
      outcome: 'http',
      httpStatus: response.status,
      wireCode: null,
      localCode: 'DLV_UNKNOWN_STATUS',
      note: 'unknown HTTP status',
    }),
  });
}

/* ------------------------------------------------------------------------- */
/* GET reconciliation                                                        */
/* ------------------------------------------------------------------------- */

async function performGet(submissionId: string, kind: 'reconcile'): Promise<void> {
  if (stopped || activeAttempts.has(submissionId)) return;
  const current = await currentRecord(submissionId);
  if (current === null || current.import_id === null) return;
  const meta: AttemptMeta = { kind, started_at: nowIso(), started_ms: Date.now() };
  activeAttempts.add(submissionId);
  const controller = new AbortController();
  abortControllers.set(submissionId, controller);
  notify();
  try {
    const record = await updateRecord(submissionId, (latest) => {
      const now = Date.now();
      if (latest.owner !== null && latest.owner.token !== ownerToken && latest.owner.expires_at > now) return null;
      return { ...latest, updated_at: new Date(now).toISOString(), owner: { token: ownerToken, expires_at: now + OWNER_LEASE_MS } };
    });
    if (record === null) return;
    const integrity = await verifySubmissionIntegrity(record);
    if (!integrity.ok) {
      await applyAttemptOutcome(submissionId, {
        state: 'pending_reconcile',
        error: localError(integrity.code ?? 'DLV_BYTES_CHANGED', integrity.message ?? '提交字节完整性校验失败'),
        attemptsPatch: { exhausted: true, next_attempt_at: null },
        historyEntry: historyEntry(record, meta, null, {
          outcome: 'blocked',
          httpStatus: null,
          wireCode: null,
          localCode: integrity.code ?? 'DLV_BYTES_CHANGED',
          note: integrity.message,
        }),
      });
      return;
    }
    const outcome = await transport.request({
      method: 'GET',
      url: getUrl(record.target, record.import_id as string),
      headers: {},
      body: null,
      timeoutMs: REQUEST_TIMEOUT_MS,
      signal: controller.signal,
    });
    await applyGetOutcome(submissionId, record, meta, outcome);
  } finally {
    activeAttempts.delete(submissionId);
    abortControllers.delete(submissionId);
    notify();
  }
}

async function applyGetOutcome(
  submissionId: string,
  record: SubmissionRecordV1,
  meta: AttemptMeta,
  outcome: TransportOutcome,
): Promise<void> {
  const expectation = {
    producer_instance_id: record.identity.producer_instance_id,
    graph_id: record.identity.graph_id,
    frame_id: record.identity.frame_id,
    revision: record.identity.revision,
    node_count: record.snapshot.node_count,
    edge_count: record.snapshot.edge_count,
    wire_version: record.snapshot.wire_version,
    known_import_id: record.import_id as string,
  };
  const baseVerification = { last_get_at: nowIso(), last_get_status: null as number | null };

  if (outcome.kind !== 'response') {
    const localCode: DeliveryLocalCode = outcome.kind === 'timeout' ? 'DLV_GET_ERROR' : 'DLV_GET_ERROR';
    await applyAttemptOutcome(submissionId, {
      error: localError(localCode, `GET 核对未得到 HTTP 结果（结果未知）：${outcome.message}`),
      verification: { ...baseVerification, last_result: 'error', local_code: localCode, message: outcome.message },
      attemptsPatch: { last_attempt_at: Date.now() },
      historyEntry: historyEntry(record, meta, outcome, {
        outcome: outcome.kind,
        httpStatus: null,
        wireCode: null,
        localCode,
        note: outcome.message,
      }),
    });
    return;
  }

  const response = outcome.response;
  if (response.status === 200) {
    const parsed = parseReadResponse(response.text, expectation, record.bytes);
    if (parsed.ok && parsed.equivalent) {
      const label = transportLabel(record, response.headers);
      const receipt: StoredReceipt = {
        receipt: parsed.receipt,
        transport_label: label,
        http_status: 200,
        received_at: record.receipt?.received_at ?? nowIso(),
        verified_by_get: true,
        verified_at: nowIso(),
      };
      await applyAttemptOutcome(submissionId, {
        state: 'confirmed',
        error: null,
        importId: parsed.receipt.import_id,
        receipt,
        verification: { last_get_at: nowIso(), last_get_status: 200, last_result: 'equivalent', local_code: null, message: null },
        attemptsPatch: { exhausted: false, next_attempt_at: null },
        historyEntry: historyEntry(record, meta, outcome, {
          outcome: 'http',
          httpStatus: 200,
          wireCode: null,
          localCode: null,
          note: 'GET 回读的源图与冻结快照语义等价',
        }),
      });
      return;
    }
    const code = parsed.ok ? 'DLV_GET_MISMATCH' : parsed.code;
    const message = parsed.ok ? parsed.reason : parsed.message;
    const lastResult = parsed.ok ? 'mismatch' : parsed.code === 'DLV_GET_MISMATCH' ? 'mismatch' : 'error';
    await applyAttemptOutcome(submissionId, {
      state: 'pending_reconcile',
      error: localError(code, `GET 核对不一致：${message}`, 200),
      verification: { last_get_at: nowIso(), last_get_status: 200, last_result: lastResult, local_code: code, message },
      attemptsPatch: { exhausted: true, next_attempt_at: null },
      allowRevokeConfirmed: true,
      historyEntry: historyEntry(record, meta, outcome, {
        outcome: 'http',
        httpStatus: 200,
        wireCode: null,
        localCode: code,
        note: message,
      }),
    });
    return;
  }

  if (response.status === 404) {
    const err = parseErrorBody(response.text);
    await applyAttemptOutcome(submissionId, {
      state: 'pending_reconcile',
      error: localError(
        'DLV_IMPORT_NOT_FOUND',
        `GET 返回 404 IMPORT_NOT_FOUND：接收端未找到 import_id=${record.import_id}；保留原记录与回执证据，不做成功声明。`,
        404,
      ),
      verification: { last_get_at: nowIso(), last_get_status: 404, last_result: 'not_found', local_code: 'DLV_IMPORT_NOT_FOUND', message: err.ok ? err.error.message : 'IMPORT_NOT_FOUND' },
      attemptsPatch: { exhausted: true, next_attempt_at: null },
      allowRevokeConfirmed: true,
      historyEntry: historyEntry(record, meta, outcome, {
        outcome: 'http',
        httpStatus: 404,
        wireCode: err.ok ? err.error.code : null,
        localCode: 'DLV_IMPORT_NOT_FOUND',
        note: 'import_id 未找到',
      }),
    });
    return;
  }

  // Other statuses keep the confirmation state (network/5xx uncertainty) but
  // never claim a new success.
  const err = parseErrorBody(response.text);
  await applyAttemptOutcome(submissionId, {
    error: localError('DLV_GET_ERROR', `GET 核对返回 HTTP ${response.status}；保留原状态与诊断。`, response.status),
    verification: {
      last_get_at: nowIso(),
      last_get_status: response.status,
      last_result: 'error',
      local_code: 'DLV_GET_ERROR',
      message: err.ok ? err.error.message : `HTTP ${response.status}`,
    },
    attemptsPatch: { last_attempt_at: Date.now() },
    historyEntry: historyEntry(record, meta, outcome, {
      outcome: 'http',
      httpStatus: response.status,
      wireCode: err.ok ? err.error.code : null,
      localCode: 'DLV_GET_ERROR',
      note: `HTTP ${response.status}`,
    }),
  });
}

/* ------------------------------------------------------------------------- */
/* Read-only helpers for tests / evidence                                    */
/* ------------------------------------------------------------------------- */

/** Re-read persisted submissions (used by the panel so two pages converge). */
export async function refreshDeliveryRecords(): Promise<void> {
  if (stopped || repository === null || bootStatus !== 'ready' || activeAttempts.size > 0) return;
  try {
    records = await repository.listAll();
    invalidRecords = await repository.listInvalid();
    statusCache = null;
    notify();
  } catch {
    // A transient read failure keeps the last known view; no state is claimed.
  }
}

export async function listDeliveryRecords(): Promise<SubmissionRecordV1[]> {
  if (repository === null) return [...records];
  return repository.listAll();
}

export function isDeliveryReady(): boolean {
  return bootStatus === 'ready';
}

export function deliveryBootStatus(): 'pending' | 'ready' | 'blocked' {
  return bootStatus;
}

export function deliveryRecordView(submissionId: string): SubmissionView | null {
  const record = records.find((item) => item.submission_id === submissionId);
  return record ? toSubmissionView(record, Date.now()) : null;
}

export function stopDelivery(): void {
  stopped = true;
  unwatchGraphRevision();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  for (const controller of abortControllers.values()) controller.abort();
  abortControllers.clear();
}

/** Test helper: create a memory-backed delivery session target. */
export function _installMemoryRepositoryForTests(faults?: { createFailures?: number; updateFailures?: number }): SubmissionRepository {
  memoryFallback = createMemoryDeliveryRepository({ faults });
  repository = memoryFallback;
  return memoryFallback;
}
