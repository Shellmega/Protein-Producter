/**
 * Export entry: validate the committed graph, freeze an immutable snapshot and
 * download its exact UTF-8 JSON bytes.
 *
 * Nothing here sends anything: there is no HTTP call, no receipt and no
 * "delivered" state. The download is produced from the wire body only; camera,
 * work plane, history, reference-image bytes and the local snapshot id stay out
 * of the document.
 */

import { counters } from '../diagnostics';
import { usePtgStore, emptyExportState, type ExportUiState } from '../domain/store';
import {
  ExportError,
  createSnapshot,
  downloadSnapshot,
  latestSnapshot,
  listSnapshots,
  verifySnapshotBytes,
  type ImmutableSnapshot,
} from './snapshot';
import { validateDraftForExport } from './validate';
import type { ValidationIssue } from './types';

export interface ExportOutcome {
  ok: boolean;
  snapshot: ImmutableSnapshot | null;
  state: ExportUiState;
}

function blockedState(issue: ValidationIssue | null, secondary: ValidationIssue | null): ExportUiState {
  return {
    ...emptyExportState(),
    status: 'blocked',
    code: issue?.code ?? 'EXPORT_INVALID_DRAFT',
    message: issue?.message ?? '当前草稿不是有效的开放链，已阻止契约导出；草稿仍可本地保存。',
    field: issue?.field ?? null,
    nodeIds: issue ? [...issue.node_ids] : [],
    secondaryCode: secondary && secondary !== issue ? secondary.code : null,
    secondaryMessage: secondary && secondary !== issue ? secondary.message : null,
    secondaryField: secondary && secondary !== issue ? secondary.field : null,
    secondaryNodeIds: secondary && secondary !== issue ? [...secondary.node_ids] : [],
    at: Date.now(),
  };
}

function failedState(code: string, message: string): ExportUiState {
  return { ...emptyExportState(), status: 'blocked', code, message, at: Date.now() };
}

/**
 * Validate -> freeze -> download. The validation result is the frozen first
 * error; when the structure stage fails first, the first graph-semantic error
 * is reported as a secondary diagnostic so the user still sees where the graph
 * itself is wrong.
 */
export async function exportSnapshotNow(): Promise<ExportOutcome> {
  const store = usePtgStore.getState();
  const validation = validateDraftForExport({
    identity: store.identity,
    content: store.content,
  });
  if (!validation.ok || validation.payload === null) {
    counters.exportsBlocked += 1;
    const state = blockedState(validation.primary, validation.semantic);
    store.setExportState(state);
    usePtgStore.setState({
      feedback: {
        level: 'error',
        source: 'export',
        code: state.code ?? 'EXPORT_INVALID_DRAFT',
        message: `契约导出已阻止：${state.message ?? ''}${state.field ? `（定位 ${state.field}）` : ''}${
          state.secondaryCode ? `；另有图语义诊断 ${state.secondaryCode}（${state.secondaryField ?? ''}）` : ''
        }`,
        at: Date.now(),
      },
    });
    return { ok: false, snapshot: null, state };
  }

  let snapshot: ImmutableSnapshot;
  try {
    snapshot = await createSnapshot(validation.payload);
  } catch (error) {
    const code = error instanceof ExportError ? error.code : 'EXPORT_ENCODE_FAILED';
    const message =
      error instanceof Error ? error.message : '快照生成失败，未产生下载；可重试，图未改变。';
    const state = failedState(code, message);
    store.setExportState(state);
    usePtgStore.setState({
      feedback: { level: 'error', source: 'export', code, message, at: Date.now() },
    });
    return { ok: false, snapshot: null, state };
  }

  const fileName = downloadSnapshot(snapshot);
  counters.snapshotsCreated += 1;
  counters.snapshotDownloads += 1;
  const state: ExportUiState = {
    ...emptyExportState(),
    status: 'ok',
    code: null,
    message: `已生成不可变快照并下载 ${fileName}（图 ${snapshot.local.graph_id} revision ${snapshot.local.revision}）；未发送到任何服务。`,
    snapshotId: snapshot.local.snapshot_id,
    snapshotSha256: snapshot.local.sha256,
    snapshotBytes: snapshot.local.byte_length,
    fileName,
    at: Date.now(),
  };
  store.setExportState(state);
  usePtgStore.setState({
    feedback: {
      level: 'success',
      source: 'export',
      code: 'SNAPSHOT_DOWNLOADED',
      message: `快照 ${snapshot.local.snapshot_id} 已生成并下载（revision ${snapshot.local.revision}，${snapshot.local.byte_length} 字节，SHA-256 ${snapshot.local.sha256.slice(0, 16)}…）。这只是本地下载，不代表已送达任何服务。`,
      at: Date.now(),
    },
  });
  return { ok: true, snapshot, state };
}

/** Validate only (no snapshot, no download). Used by the "校验" control. */
export function validateOnlyNow(): ExportOutcome {
  const store = usePtgStore.getState();
  const validation = validateDraftForExport({
    identity: store.identity,
    content: store.content,
  });
  if (!validation.ok) {
    counters.exportsBlocked += 1;
    const state = blockedState(validation.primary, validation.semantic);
    store.setExportState(state);
    usePtgStore.setState({
      feedback: {
        level: 'error',
        source: 'export',
        code: state.code ?? 'EXPORT_INVALID_DRAFT',
        message: `校验失败：${state.message ?? ''}${state.field ? `（定位 ${state.field}）` : ''}`,
        at: Date.now(),
      },
    });
    return { ok: false, snapshot: null, state };
  }
  const state: ExportUiState = {
    ...emptyExportState(),
    status: 'valid',
    message: `校验通过：${store.content.nodes.length} 个结点、${store.content.edges.length} 条边符合 protein_open_chain_v1；可生成快照下载。`,
    at: Date.now(),
  };
  store.setExportState(state);
  usePtgStore.setState({
    feedback: {
      level: 'success',
      source: 'export',
      code: 'DRAFT_VALID',
      message: '当前图通过冻结契约校验（尚未生成快照）。',
      at: Date.now(),
    },
  });
  return { ok: true, snapshot: null, state };
}

/** Re-download the most recent snapshot bytes without regenerating them. */
export function redownloadLatestSnapshot(): ExportOutcome {
  const store = usePtgStore.getState();
  const snapshot = latestSnapshot();
  if (!snapshot) {
    const state = failedState('EXPORT_NO_SNAPSHOT', '尚未生成快照，没有可重新下载的字节。');
    store.setExportState(state);
    return { ok: false, snapshot: null, state };
  }
  const fileName = downloadSnapshot(snapshot);
  counters.snapshotDownloads += 1;
  const state: ExportUiState = {
    status: 'ok',
    code: null,
    message: `已重新下载原快照 ${snapshot.local.snapshot_id}（字节与首次生成完全相同）。`,
    field: null,
    nodeIds: [],
    secondaryCode: null,
    secondaryMessage: null,
    secondaryField: null,
    secondaryNodeIds: [],
    snapshotId: snapshot.local.snapshot_id,
    snapshotSha256: snapshot.local.sha256,
    snapshotBytes: snapshot.local.byte_length,
    fileName,
    at: Date.now(),
  };
  store.setExportState(state);
  return { ok: true, snapshot, state };
}

/** Read-only access to frozen snapshots (the only interface later senders use). */
export function readOnlySnapshots(): readonly ImmutableSnapshot[] {
  return listSnapshots();
}

/** Select the node ids an issue points at, so the user can inspect the object. */
export function selectIssueNodes(issue: ValidationIssue | null): string[] {
  const selected: string[] = [];
  for (const id of issue?.node_ids ?? []) {
    if (usePtgStore.getState().selectNode(id)) {
      selected.push(id);
    }
  }
  return selected;
}

export { verifySnapshotBytes };
