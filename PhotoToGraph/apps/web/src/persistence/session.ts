/**
 * Store <-> IndexedDB bridge for the local draft.
 *
 * Responsibilities:
 * - boot: probe storage, load the single local draft slot, verify structure and
 *   reference resource, then replace editor state in ONE step;
 * - autosave/manual save with an independent save generation per attempt;
 * - compare-and-set so two same-origin pages can never silently write different
 *   content for the same producer + graph + revision;
 * - explicit recovery paths for a corrupt/unknown/failed record: the raw record
 *   is preserved until the user explicitly discards or replaces it.
 *
 * All graph math and rendering stay in the domain/scene modules; this module is
 * the only place that knows about asynchrony and storage.
 */

import { decodeImageBytes } from '../domain/referenceLoader';
import {
  type GraphContent,
  type GraphIdentity,
  type ReferenceImageRecord,
} from '../domain/types';
import {
  usePtgStore,
  type ExportUiState,
  type PtgState,
  type SaveUiState,
  type StoredRecordInfo,
} from '../domain/store';
import { getSceneHandle } from '../diagnostics';
import { counters } from '../diagnostics';
import type { Vec3 } from '../spatial/math';
import {
  buildStoredDraft,
  createIndexedDbRepository,
  type DraftRepository,
  type LocalStorageCode,
  type SaveDraftResult,
  type StoredCameraV1,
  type StoredContentV1,
  type StoredDraftV1,
  type StoredEditorStateV1,
  type StoredIdentityV1,
  type StoredReferenceMetaV1,
} from './index';

export type { SaveUiState };

export interface PersistenceOutcome {
  ok: boolean;
  code: string | null;
  message: string | null;
  /** True when an explicit operation found nothing in storage. */
  empty?: boolean;
}

const AUTOSAVE_DELAY_MS = 450;

let repository: DraftRepository | null = null;
let bootstrapPromise: Promise<PersistenceOutcome> | null = null;
let unsubscribe: (() => void) | null = null;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<PersistenceOutcome> | null = null;
let queued = false;
let expected: { graph_id: string; revision: number; content_digest: string } | null = null;
let lastSavedSignature: string | null = null;
let stopped = false;

export function resetPersistenceForTests(): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  unsubscribe?.();
  unsubscribe = null;
  repository?.close();
  repository = null;
  bootstrapPromise = null;
  inFlight = null;
  queued = false;
  expected = null;
  lastSavedSignature = null;
  stopped = false;
}

/**
 * Unit-test seam: install an already-open repository and the store subscription
 * without going through the browser boot path (Node has no IndexedDB, and the
 * overwrite/autosave recovery rules are storage-backend independent). The
 * application never calls this; tests call `resetPersistenceForTests()` first.
 */
export function installRepositoryForTests(repo: DraftRepository): void {
  repository?.close();
  repository = repo;
  unsubscribe?.();
  unsubscribe = usePtgStore.subscribe(handleStoreChange);
  stopped = false;
}

function state(): PtgState {
  return usePtgStore.getState();
}

function feedback(level: 'info' | 'success' | 'error', code: string, message: string): void {
  // Route persistence messages through the shared feedback line.
  usePtgStore.setState({
    feedback: { level, source: 'persistence', code, message, at: Date.now() },
  });
}

// ---------------------------------------------------------------------------
// Snapshot of the current editor state
// ---------------------------------------------------------------------------

export interface SaveCapture {
  generation: number;
  signature: string;
  identity: GraphIdentity;
  content: GraphContent;
  editor: StoredEditorStateV1;
  camera: StoredCameraV1 | null;
  reference: ReferenceImageRecord | null;
  referenceBytes: Uint8Array | null;
}

function cloneContent(content: GraphContent): GraphContent {
  return {
    nodes: content.nodes.map((node) => ({
      id: node.id,
      position: [node.position[0], node.position[1], node.position[2]],
    })),
    edges: content.edges.map((edge) => [edge[0], edge[1]] as [string, string]),
    n_terminal_node: content.n_terminal_node,
    source_reference_image_ids: [...content.source_reference_image_ids],
  };
}

function cloneIdentity(identity: GraphIdentity): GraphIdentity {
  return {
    producer_instance_id: identity.producer_instance_id,
    graph_id: identity.graph_id,
    frame_id: identity.frame_id,
    revision: identity.revision,
    coordinate_system: { ...identity.coordinate_system },
  };
}

export function readCameraPose(): { position: Vec3; target: Vec3 } | null {
  const camera = getSceneHandle()?.readCamera();
  if (!camera || !camera.target) {
    return null;
  }
  const position = camera.position;
  const target = camera.target;
  if (![...position, ...target].every((value) => Number.isFinite(value))) {
    return null;
  }
  return { position: [...position], target: [...target] };
}

function editorStateOf(current: PtgState): StoredEditorStateV1 {
  return {
    mode: current.mode,
    planeKind: current.planeKind,
    planeOffsets: { ...current.planeOffsets },
    selectedNodeId: current.selectedNodeId,
    dragConstraint: current.dragConstraint,
  };
}

function referenceKey(reference: ReferenceImageRecord | null): string {
  if (!reference) {
    return 'none';
  }
  const pose = reference.pose;
  return `${reference.sourceId}:${pose.position.join(',')}:${pose.rotationDeg.join(',')}:${pose.scale}`;
}

/**
 * Signature split. The camera part can be temporarily unavailable while the
 * canvas unmounts/remounts (new graph, scene restore); an empty camera key is a
 * wildcard so a remount cannot make a successful save look stale.
 */
interface SignatureParts {
  graph: string;
  camera: string;
}

function signatureParts(current: PtgState = state()): SignatureParts {
  const graph = [
    current.identity.producer_instance_id,
    current.identity.graph_id,
    current.identity.frame_id,
    current.identity.revision,
    current.content.nodes.length,
    current.content.edges.length,
    current.content.n_terminal_node ?? '-',
    current.content.source_reference_image_ids.join('+'),
    referenceKey(current.reference),
    current.mode,
    current.planeKind,
    `${current.planeOffsets.xy},${current.planeOffsets.xz},${current.planeOffsets.yz}`,
    current.selectedNodeId ?? '-',
    current.dragConstraint,
  ].join('|');
  const pose = readCameraPose();
  const camera = pose
    ? `${pose.position.map((v) => v.toPrecision(17)).join(',')}|${pose.target.map((v) => v.toPrecision(17)).join(',')}`
    : '';
  return { graph, camera };
}

const SIGNATURE_SEPARATOR = '#camera:';

function signatureKey(parts: SignatureParts): string {
  return `${parts.graph}${SIGNATURE_SEPARATOR}${parts.camera}`;
}

function parseSignature(key: string): SignatureParts {
  const index = key.lastIndexOf(SIGNATURE_SEPARATOR);
  if (index < 0) {
    return { graph: key, camera: '' };
  }
  return { graph: key.slice(0, index), camera: key.slice(index + SIGNATURE_SEPARATOR.length) };
}

/** Camera is compared only when both sides know it (remount race tolerance). */
function sameSignature(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  const left = parseSignature(a);
  const right = parseSignature(b);
  if (left.graph !== right.graph) {
    return false;
  }
  if (left.camera === '' || right.camera === '') {
    return true;
  }
  return left.camera === right.camera;
}

/** Cheap view/graph fingerprint: a change means the local draft is stale. */
export function currentSignature(current: PtgState = state()): string {
  return signatureKey(signatureParts(current));
}

export function captureSave(generation: number): SaveCapture {
  const current = state();
  return {
    generation,
    signature: currentSignature(current),
    identity: cloneIdentity(current.identity),
    content: cloneContent(current.content),
    editor: editorStateOf(current),
    camera: readCameraPose(),
    reference: current.reference,
    referenceBytes: current.reference ? new Uint8Array(current.reference.bytes) : null,
  };
}

function hasPersistableContent(current: PtgState): boolean {
  return (
    current.content.nodes.length > 0 ||
    current.content.edges.length > 0 ||
    current.reference !== null ||
    current.identity.revision > 1 ||
    current.content.n_terminal_node !== null
  );
}

// ---------------------------------------------------------------------------
// Local diagnostics (never wire/service codes)
// ---------------------------------------------------------------------------

export type LocalDiagnosticCode =
  | LocalStorageCode
  | 'LOCAL_DISABLED'
  | 'RESTORE_INVALID_CONTENT'
  | 'RESTORE_REFERENCE_MISMATCH';

function localMessage(code: LocalDiagnosticCode, detail: string): string {
  return `本地草稿（${code}）：${detail}`;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

interface RestoredContentCheck {
  ok: boolean;
  message?: string;
}

/** Refuse to restore a record that would violate editor invariants (no repair). */
export function checkRestoredContent(content: StoredContentV1): RestoredContentCheck {
  const ids = new Set<string>();
  for (const node of content.nodes) {
    if (ids.has(node.id)) {
      return { ok: false, message: `结点 ID ${node.id} 重复，拒绝恢复` };
    }
    ids.add(node.id);
    for (const value of node.position) {
      if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) {
        return { ok: false, message: `结点 ${node.id} 坐标非法，拒绝恢复` };
      }
    }
  }
  const seenEdges = new Set<string>();
  for (const [a, b] of content.edges) {
    if (!ids.has(a) || !ids.has(b)) {
      return { ok: false, message: `边 ${a}–${b} 引用了不存在的结点，拒绝恢复` };
    }
    if (a === b) {
      return { ok: false, message: `边 ${a}–${b} 是自环，拒绝恢复` };
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenEdges.has(key)) {
      return { ok: false, message: `边 ${a}–${b} 重复，拒绝恢复` };
    }
    seenEdges.add(key);
  }
  if (content.n_terminal_node !== null && !ids.has(content.n_terminal_node)) {
    return { ok: false, message: `N 端 ${content.n_terminal_node} 不在结点集合中，拒绝恢复` };
  }
  return { ok: true };
}

interface RestoredReference {
  sourceId: string;
  fileName: string;
  mimeType: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
  baseWidth: number;
  pose: { position: Vec3; rotationDeg: Vec3; scale: number };
  bytes: Uint8Array;
  bitmap: ImageBitmap;
}

function identityFromRecord(record: StoredDraftV1): GraphIdentity {
  const identity = record.identity as StoredIdentityV1;
  return {
    producer_instance_id: identity.producer_instance_id,
    graph_id: identity.graph_id,
    frame_id: identity.frame_id,
    revision: identity.revision,
    coordinate_system: { ...identity.coordinate_system },
  };
}

function blockBoot(code: LocalDiagnosticCode, message: string): PersistenceOutcome {
  usePtgStore.setState({
    bootStatus: 'blocked',
    autosaveEnabled: false,
    saveState: 'blocked',
    saveErrorCode: code,
    saveMessage: message,
  });
  feedback('error', code, message);
  return { ok: false, code, message };
}

async function restoreWithEditorState(): Promise<PersistenceOutcome> {
  if (!repository) {
    return blockBoot('LOCAL_DISABLED', localMessage('LOCAL_DISABLED', '没有可用的 IndexedDB。'));
  }
  const loaded = await repository.loadCurrent();
  if (loaded === null) {
    usePtgStore.setState({ bootStatus: 'empty', autosaveEnabled: true, saveState: 'unsaved' });
    return { ok: true, code: null, message: '本地无已保存草稿。', empty: true };
  }
  if (!loaded.ok) {
    return blockBoot(loaded.code, localMessage(loaded.code, loaded.message));
  }
  const record = loaded.record;
  const contentCheck = checkRestoredContent(record.content);
  if (!contentCheck.ok) {
    return blockBoot('RESTORE_INVALID_CONTENT', localMessage('RESTORE_INVALID_CONTENT', contentCheck.message ?? ''));
  }
  let reference: RestoredReference | null = null;
  if (record.reference) {
    const bytes = loaded.blobBytes;
    if (!bytes) {
      return blockBoot('LOCAL_MISSING_BLOB', localMessage('LOCAL_MISSING_BLOB', '参考图字节缺失，无法恢复；原记录未删除。'));
    }
    try {
      const decoded = await decodeImageBytes(bytes, record.reference.mimeType);
      if (
        decoded.width !== record.reference.intrinsicWidth ||
        decoded.height !== record.reference.intrinsicHeight
      ) {
        decoded.bitmap.close();
        return blockBoot(
          'RESTORE_REFERENCE_MISMATCH',
          localMessage('RESTORE_REFERENCE_MISMATCH', '参考图方向/尺寸与记录不一致；原记录与当前图保留。'),
        );
      }
      reference = {
        sourceId: record.reference.sourceId,
        fileName: record.reference.fileName,
        mimeType: record.reference.mimeType,
        intrinsicWidth: record.reference.intrinsicWidth,
        intrinsicHeight: record.reference.intrinsicHeight,
        baseWidth: record.reference.baseWidth,
        pose: {
          position: [...record.reference.pose.position],
          rotationDeg: [...record.reference.pose.rotationDeg],
          scale: record.reference.pose.scale,
        },
        bytes: new Uint8Array(bytes),
        bitmap: decoded.bitmap,
      };
    } catch (error) {
      return blockBoot(
        'RESTORE_REFERENCE_MISMATCH',
        localMessage(
          'RESTORE_REFERENCE_MISMATCH',
          `参考图解码失败：${error instanceof Error ? error.message : String(error)}；原记录与当前图保留。`,
        ),
      );
    }
  }

  const identity = identityFromRecord(record);
  state().applyRestoredSession({
    identity,
    content: cloneContent(record.content as GraphContent),
    editor: {
      mode: record.editor.mode as PtgState['mode'],
      planeKind: record.editor.planeKind as PtgState['planeKind'],
      planeOffsets: { ...record.editor.planeOffsets },
      selectedNodeId: record.editor.selectedNodeId,
      dragConstraint: record.editor.dragConstraint,
    },
    camera: record.camera ? { position: [...record.camera.position], target: [...record.camera.target] } : null,
    reference,
    stored: {
      graphId: record.identity.graph_id,
      revision: record.identity.revision,
      savedAt: Date.parse(record.saved_at),
      contentDigest: record.content_digest,
      saveGeneration: record.save_generation,
    },
    notice: {
      level: 'success',
      code: 'LOCAL_DRAFT_RESTORED',
      message: `已恢复本地草稿 ${record.identity.graph_id}（revision ${record.identity.revision}）；运行时撤销/重做已清空。`,
    },
  });
  expected = {
    graph_id: identity.graph_id,
    revision: identity.revision,
    content_digest: record.content_digest,
  };
  lastSavedSignature = currentSignature();
  usePtgStore.setState({ autosaveEnabled: true });
  return { ok: true, code: null, message: '已恢复本地草稿。' };
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function editorForRecord(save: SaveCapture): StoredEditorStateV1 {
  return save.editor;
}

async function buildRecord(save: SaveCapture): Promise<{
  record: StoredDraftV1;
  blob: { bytes: Uint8Array; mimeType: string; sha256: string } | null;
}> {
  const reference = save.reference;
  const meta: (Omit<StoredReferenceMetaV1, 'byteLength' | 'blobSha256'> & { bytes: Uint8Array }) | null =
    reference && save.referenceBytes
      ? {
          sourceId: reference.sourceId,
          fileName: reference.fileName,
          mimeType: reference.mimeType,
          intrinsicWidth: reference.intrinsicWidth,
          intrinsicHeight: reference.intrinsicHeight,
          baseWidth: reference.baseWidth,
          pose: {
            position: [...reference.pose.position],
            rotationDeg: [...reference.pose.rotationDeg],
            scale: reference.pose.scale,
          },
          orientationPolicy: 'from-image',
          bytes: save.referenceBytes,
        }
      : null;
  const built = await buildStoredDraft({
    identity: save.identity,
    content: save.content,
    editor: editorForRecord(save),
    camera: save.camera,
    reference: meta,
    generation: save.generation,
  });
  return built;
}

async function performSave(reason: 'manual' | 'auto' | 'new-graph' | 'overwrite'): Promise<PersistenceOutcome> {
  if (!repository) {
    const message = localMessage('LOCAL_DISABLED', '没有可用的 IndexedDB，无法保存；当前图仍可编辑与导出。');
    usePtgStore.setState({ saveState: 'blocked', saveErrorCode: 'LOCAL_DISABLED', saveMessage: message });
    feedback('error', 'LOCAL_DISABLED', message);
    return { ok: false, code: 'LOCAL_DISABLED', message };
  }
  const generation = state().saveGeneration + 1;
  state().beginSave(generation);
  const save = captureSave(generation);
  let built;
  try {
    built = await buildRecord(save);
  } catch (error) {
    const message = localMessage(
      'LOCAL_IO_ERROR',
      `保存前编码失败：${error instanceof Error ? error.message : String(error)}`,
    );
    state().settleSave({ generation, ok: false, code: 'LOCAL_IO_ERROR', message });
    feedback('error', 'LOCAL_IO_ERROR', message);
    return { ok: false, code: 'LOCAL_IO_ERROR', message };
  }
  const replaceGraph = reason === 'new-graph' || reason === 'overwrite';
  const result: SaveDraftResult = await repository.saveCurrent({
    record: built.record,
    blob: built.blob,
    expected: replaceGraph ? null : expected,
    replaceGraph,
  });
  if (result.ok) {
    expected = {
      graph_id: built.record.identity.graph_id,
      revision: built.record.identity.revision,
      content_digest: built.record.content_digest,
    };
    const unchanged = sameSignature(currentSignature(), save.signature);
    // Record the signature BEFORE settling: the settle update notifies the
    // store subscriber, which must already see "this state is saved".
    if (unchanged) {
      lastSavedSignature = save.signature;
    }
    state().settleSave({
      generation,
      ok: true,
      revision: save.identity.revision,
      at: Date.parse(result.saved_at),
      unchanged,
    });
    const info: StoredRecordInfo = {
      graphId: built.record.identity.graph_id,
      revision: built.record.identity.revision,
      savedAt: Date.parse(built.record.saved_at),
      contentDigest: built.record.content_digest,
      saveGeneration: generation,
    };
    usePtgStore.setState({ storedRecord: info, autosaveEnabled: true });
    // O1: an explicit overwrite of a blocked/corrupt record recovers the same
    // session in place — boot leaves `blocked`, autosave is re-armed and the
    // next edit autosaves without a manual refresh. This only runs after the
    // write actually committed; failed overwrites keep the block protection.
    if (reason === 'overwrite' && state().bootStatus === 'blocked') {
      state().recoverFromBlocked(info, unchanged);
    }
    counters.localSavesCommitted += 1;
    feedback(
      'success',
      'LOCAL_DRAFT_SAVED',
      unchanged
        ? `本地草稿已保存：图 ${info.graphId} revision ${info.revision}（generation ${generation}）。`
        : `本地草稿已写入图 ${info.graphId} revision ${info.revision}，但保存期间又有新编辑；当前状态尚未保存。`,
    );
    return { ok: true, code: null, message: '已保存本地草稿。' };
  }
  state().settleSave({
    generation,
    ok: false,
    code: result.code,
    message: result.message,
  });
  counters.localSaveFailures += 1;
  let message = localMessage(result.code, result.message);
  if (result.code === 'LOCAL_CONFLICT' && result.existing) {
    message = localMessage(
      'LOCAL_CONFLICT',
      `另一页面/更早版本已保存 图 ${result.existing.graph_id} revision ${result.existing.revision}（内容不同）。已拒绝覆盖；请刷新恢复后再编辑，或新建图另存。当前图仍在内存中，未丢失。`,
    );
    usePtgStore.setState({ saveState: 'failed', saveErrorCode: result.code, saveMessage: message });
  }
  feedback('error', result.code, message);
  return { ok: false, code: result.code, message };
}

export async function saveDraftNow(reason: 'manual' | 'auto' = 'manual'): Promise<PersistenceOutcome> {
  if (stopped) {
    return { ok: false, code: 'LOCAL_DISABLED', message: '本地保存已停止。' };
  }
  if (reason === 'auto' && sameSignature(currentSignature(), lastSavedSignature)) {
    return { ok: true, code: null, message: '没有需要保存的变化。' };
  }
  if (inFlight) {
    queued = true;
    return inFlight;
  }
  inFlight = performSave(reason);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
    if (queued) {
      queued = false;
      scheduleAutosave(0);
    }
  }
}

/** Explicit user action: keep the current graph but write it as a new local graph. */
export async function saveAsNewLocalGraph(): Promise<PersistenceOutcome> {
  return performSave('new-graph');
}

/** Explicit user action after a blocked/corrupt load: overwrite that record. */
export async function overwriteBlockedRecord(): Promise<PersistenceOutcome> {
  return performSave('overwrite');
}

/**
 * Explicit "new graph" control: create a fresh graph identity, then write it as
 * the local draft slot (allowed to replace the previous graph id). Autosave is
 * silenced in between so the fresh draft cannot race the explicit write.
 */
export function startNewGraph(): void {
  state().newDraft();
  expected = null;
  lastSavedSignature = currentSignature();
}

// ---------------------------------------------------------------------------
// Autosave scheduling
// ---------------------------------------------------------------------------

function scheduleAutosave(delayMs = AUTOSAVE_DELAY_MS): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
  }
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void saveDraftNow('auto');
  }, delayMs);
}

function adoptCameraBaselineIfUnknown(): void {
  if (lastSavedSignature === null) {
    return;
  }
  const saved = parseSignature(lastSavedSignature);
  if (saved.camera !== '') {
    return;
  }
  const current = signatureParts();
  if (current.camera === '') {
    return;
  }
  lastSavedSignature = signatureKey({ graph: saved.graph, camera: current.camera });
}

function handleStoreChange(): void {
  if (stopped || !state().autosaveEnabled) {
    return;
  }
  const bootStatus = state().bootStatus;
  if (bootStatus === 'pending' || bootStatus === 'blocked') {
    return;
  }
  adoptCameraBaselineIfUnknown();
  if (sameSignature(currentSignature(), lastSavedSignature)) {
    return;
  }
  if (bootStatus === 'empty' && !hasPersistableContent(state())) {
    return;
  }
  if (state().saveState === 'saving') {
    // A save is already in flight; it will settle and the next notification
    // decides whether another autosave is needed.
    return;
  }
  if (state().saveState === 'failed') {
    // Do not auto-retry a failed write (a conflict would otherwise storm the
    // store); the diagnostic stays visible and the user retries explicitly.
    return;
  }
  state().markUnsaved();
  scheduleAutosave();
}

// ---------------------------------------------------------------------------
// Boot / shutdown
// ---------------------------------------------------------------------------

export async function bootstrapPersistence(): Promise<PersistenceOutcome> {
  // React StrictMode mounts, cleans up and mounts again: a later bootstrap must
  // re-arm this module instead of staying permanently "stopped".
  stopped = false;
  if (bootstrapPromise) {
    if (!unsubscribe && repository) {
      unsubscribe = usePtgStore.subscribe(handleStoreChange);
    }
    return bootstrapPromise;
  }
  bootstrapPromise = (async (): Promise<PersistenceOutcome> => {
    if (typeof indexedDB === 'undefined') {
      return blockBoot(
        'LOCAL_DISABLED',
        localMessage('LOCAL_DISABLED', '此浏览器会话没有 IndexedDB；本地草稿不可用，图仍可编辑与导出。'),
      );
    }
    const repo = createIndexedDbRepository();
    try {
      await repo.open();
    } catch (error) {
      return blockBoot(
        'LOCAL_STORAGE_UNAVAILABLE',
        localMessage(
          'LOCAL_STORAGE_UNAVAILABLE',
          `无法打开本地存储：${error instanceof Error ? error.message : String(error)}；本地保存不可用。`,
        ),
      );
    }
    repository = repo;
    // Subscribe only after the repository is open; before this point autosave
    // stays disabled so the first launch can never overwrite a stored record
    // with the empty in-memory draft.
    unsubscribe = usePtgStore.subscribe(handleStoreChange);
    return restoreWithEditorState();
  })();
  return bootstrapPromise;
}

export function stopPersistence(): void {
  stopped = true;
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  unsubscribe?.();
  unsubscribe = null;
}

/** Manual "恢复已保存草稿" control (also used after a blocked boot). */
export async function restoreFromStorageNow(): Promise<PersistenceOutcome> {
  if (!repository) {
    const outcome = await bootstrapPersistence();
    if (!outcome.ok && outcome.code !== null) {
      return outcome;
    }
  }
  if (!repository) {
    return { ok: false, code: 'LOCAL_DISABLED', message: '本地存储不可用。' };
  }
  const outcome = await restoreWithEditorState();
  if (!outcome.ok) {
    counters.localRestoreFailures += 1;
  }
  return outcome;
}

/** Evidence/diagnostics read-only view of the persistence bridge. */
export function persistenceStatus(): {
  repository: 'indexeddb' | 'memory' | null;
  bootStatus: PtgState['bootStatus'];
  saveState: SaveUiState;
  saveGeneration: number;
  lastSavedRevision: number | null;
  lastSavedAt: number | null;
  saveErrorCode: string | null;
  saveMessage: string | null;
  autosaveEnabled: boolean;
  storedRecord: StoredRecordInfo | null;
  exportState: ExportUiState;
  signature: string;
  savedSignature: string | null;
  autosaveTimerActive: boolean;
  saveInFlight: boolean;
  stopped: boolean;
} {
  const current = state();
  return {
    repository: repository ? repository.kind : null,
    bootStatus: current.bootStatus,
    saveState: current.saveState,
    saveGeneration: current.saveGeneration,
    lastSavedRevision: current.lastSavedRevision,
    lastSavedAt: current.lastSavedAt,
    saveErrorCode: current.saveErrorCode,
    saveMessage: current.saveMessage,
    autosaveEnabled: current.autosaveEnabled,
    storedRecord: current.storedRecord,
    exportState: current.exportState,
    signature: currentSignature(current),
    savedSignature: lastSavedSignature,
    autosaveTimerActive: autosaveTimer !== null,
    saveInFlight: inFlight !== null,
    stopped,
  };
}
