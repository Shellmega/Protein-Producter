/**
 * Single editor store.
 *
 * Domain state: `identity` (producer/graph/frame/revision/coordinate system)
 * and `content` (stable-ID node table, undirected edges, nullable N-terminal,
 * transport source image IDs).
 *
 * Editor state: mode, work plane + offsets, selection, feedback, reference
 * image placement/resource, view commands. Editor state never increments the
 * revision.
 *
 * Revision rules implemented here:
 * - each actual node/edge/position/N-terminal change, undo or redo: +1
 * - actual change of the reference-image source ID set: +1
 * - everything else (camera, plane, selection, reference placement, failed
 *   loads, invalid input): unchanged
 * - a new draft gets a new graph_id + frame_id and starts at revision 1
 * Zundo partializes only `content`; successful resource changes are history
 * barriers. Neither reference bitmaps nor editor state enter time travel.
 */

import { create } from 'zustand';
import { temporal } from 'zundo';
import { editingActions, type EditingState } from './editing';
import { positionError } from './geometry';
import { counters } from '../diagnostics';
import {
  formatVec3,
  type Vec3,
} from '../spatial/math';
import {
  MAX_ABS_COORD as SPATIAL_MAX_ABS_COORD,
} from '../spatial/intersection';
import { workPlane, type PlaneKind, type PlaneSpec, type WorkPlaneKind } from '../spatial/planes';
import {
  defaultReferencePose,
  imagePlaneSize,
  REFERENCE_BASE_WIDTH,
  referencePlane,
  validateReferencePose,
  type ReferencePose,
} from '../spatial/referenceImage';
import { createFrameId, createGraphId, createImageSourceId, createNodeId, createProducerInstanceId } from './ids';
import {
  COINCIDENT_EPS,
  MAX_GRAPH_REVISION,
  type EditorMode,
  type Feedback,
  type FeedbackLevel,
  type GraphContent,
  type GraphIdentity,
  type GraphNode,
  type ReferenceImageRecord,
  type ReferenceStatus,
} from './types';

const PRODUCER_INSTANCE_ID = createProducerInstanceId();

/** Unsaved / saving / saved / failed state of the local draft, per save attempt. */
export type SaveUiState = 'idle' | 'unsaved' | 'saving' | 'saved' | 'failed' | 'blocked';
export type BootStatus = 'pending' | 'empty' | 'restored' | 'blocked';

/** What the local draft storage currently holds (never a wire/service fact). */
export interface StoredRecordInfo {
  graphId: string;
  revision: number;
  savedAt: number;
  contentDigest: string;
  saveGeneration: number;
}

export interface ExportUiState {
  status: 'idle' | 'valid' | 'ok' | 'blocked';
  code: string | null;
  message: string | null;
  field: string | null;
  nodeIds: string[];
  /** Secondary graph-semantic diagnostic when a structure error was reported first. */
  secondaryCode: string | null;
  secondaryMessage: string | null;
  secondaryField: string | null;
  secondaryNodeIds: string[];
  snapshotId: string | null;
  snapshotSha256: string | null;
  snapshotBytes: number | null;
  fileName: string | null;
  at: number | null;
}

export function emptyExportState(): ExportUiState {
  return {
    status: 'idle',
    code: null,
    message: null,
    field: null,
    nodeIds: [],
    secondaryCode: null,
    secondaryMessage: null,
    secondaryField: null,
    secondaryNodeIds: [],
    snapshotId: null,
    snapshotSha256: null,
    snapshotBytes: null,
    fileName: null,
    at: null,
  };
}

export interface RestoreSessionInput {
  identity: GraphIdentity;
  content: GraphContent;
  editor: {
    mode: EditorMode;
    planeKind: PlaneKind;
    planeOffsets: Record<WorkPlaneKind, number>;
    selectedNodeId: string | null;
    dragConstraint: string;
  };
  camera: { position: Vec3; target: Vec3 } | null;
  reference: {
    sourceId: string;
    fileName: string;
    mimeType: string;
    intrinsicWidth: number;
    intrinsicHeight: number;
    baseWidth: number;
    pose: ReferencePose;
    bytes: Uint8Array;
    bitmap: ImageBitmap;
  } | null;
  stored: StoredRecordInfo | null;
  notice: { level: FeedbackLevel; code: string; message: string };
}

/** One graph revision step, or null at the frozen maximum (never wraps). */
export function bumpRevision(identity: GraphIdentity): GraphIdentity | null {
  if (!Number.isSafeInteger(identity.revision) || identity.revision >= MAX_GRAPH_REVISION) {
    return null;
  }
  return { ...identity, revision: identity.revision + 1 };
}

function createEmptyContent(): GraphContent {
  return {
    nodes: [],
    edges: [],
    n_terminal_node: null,
    source_reference_image_ids: [],
  };
}

function createIdentity(producerInstanceId: string = PRODUCER_INSTANCE_ID): GraphIdentity {
  return {
    producer_instance_id: producerInstanceId,
    graph_id: createGraphId(),
    frame_id: createFrameId(),
    revision: 1,
    coordinate_system: {
      frame_id: '',
      dimension: 3,
      unit: 'scene_unit',
      handedness: 'right',
      axes: 'xyz',
    },
  };
}

function createDraft(producerInstanceId: string = PRODUCER_INSTANCE_ID): {
  identity: GraphIdentity;
  content: GraphContent;
} {
  const identity = createIdentity(producerInstanceId);
  identity.coordinate_system.frame_id = identity.frame_id;
  return { identity, content: createEmptyContent() };
}

function feedback(
  level: Feedback['level'],
  source: Feedback['source'],
  code: string,
  message: string,
): Feedback {
  return { level, source, code, message, at: Date.now() };
}

function disposeBitmap(bitmap: ImageBitmap | null | undefined): void {
  if (bitmap && typeof bitmap.close === 'function') {
    bitmap.close();
    counters.bitmapsClosed += 1;
  }
}

export interface AddNodeResult {
  ok: boolean;
  nodeId?: string;
  code?: string;
  message?: string;
}

export interface CommitReferenceInput {
  sourceId: string;
  fileName: string;
  mimeType: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
  bitmap: ImageBitmap;
  /** Original encoded bytes; required so the resource is persistable. */
  bytes: Uint8Array;
  pose?: ReferencePose;
  baseWidth?: number;
}

export interface PtgState extends EditingState {
  identity: GraphIdentity;
  content: GraphContent;

  mode: EditorMode;
  planeKind: PlaneKind;
  planeOffsets: Record<WorkPlaneKind, number>;
  selectedNodeId: string | null;
  feedback: Feedback | null;

  reference: ReferenceImageRecord | null;
  referenceLoading: boolean;
  referenceError: string | null;
  referenceToken: number;

  viewResetNonce: number;
  viewFocusNonce: number;
  sceneEpoch: number;
  /** Restored camera pose command for the in-canvas rig (editor state only). */
  viewRestore: { nonce: number; position: Vec3; target: Vec3 } | null;

  /** Persisted producer identity; never reset by module initialisation. */
  producerInstanceId: string;
  bootStatus: BootStatus;
  saveState: SaveUiState;
  saveGeneration: number;
  lastSavedGeneration: number;
  lastSavedRevision: number | null;
  lastSavedAt: number | null;
  saveErrorCode: string | null;
  saveMessage: string | null;
  autosaveEnabled: boolean;
  storedRecord: StoredRecordInfo | null;
  exportState: ExportUiState;

  setMode: (mode: EditorMode) => void;
  setPlaneKind: (kind: PlaneKind) => void;
  setPlaneOffset: (kind: WorkPlaneKind, value: number) => boolean;
  addNodeAtGraphPoint: (point: Vec3) => AddNodeResult;
  reportCreationFailure: (code: string, message: string) => void;
  selectNode: (nodeId: string | null) => boolean;

  beginReferenceLoad: (token: number) => void;
  commitReference: (token: number, input: CommitReferenceInput) => { committed: boolean; stale: boolean };
  failReference: (token: number, message: string) => void;
  setReferencePose: (pose: ReferencePose) => boolean;
  removeReference: () => void;

  newDraft: () => void;
  requestViewReset: () => void;
  requestFocusReference: () => void;
  clearFeedback: () => void;
  dismissReferenceError: () => void;

  /** Persistence bridge actions (the async storage work lives in persistence/session). */
  setBootStatus: (status: BootStatus) => void;
  setAutosaveEnabled: (enabled: boolean) => void;
  markUnsaved: () => void;
  beginSave: (generation: number) => void;
  settleSave: (input: {
    generation: number;
    ok: boolean;
    revision?: number;
    at?: number;
    code?: string;
    message?: string;
    blocked?: boolean;
    /** false when the captured save snapshot no longer matches the live state. */
    unchanged?: boolean;
  }) => void;
  setStoredRecord: (info: StoredRecordInfo | null) => void;
  /**
   * O1: a successful explicit overwrite of a blocked record recovers the SAME
   * session: boot leaves `blocked`, autosave is re-armed and the current graph
   * is recorded as saved. A failed overwrite never calls this, so the block
   * protection and the original record stay in place.
   *
   * `unchanged` is false when the graph/camera/editor state changed while the
   * overwrite was in flight: the write still succeeded (boot must recover) but
   * the newest edits stay unsaved so autosave picks them up.
   */
  recoverFromBlocked: (info: StoredRecordInfo | null, unchanged?: boolean) => void;
  applyRestoredSession: (input: RestoreSessionInput) => void;
  setExportState: (state: ExportUiState) => void;
  resetExportState: () => void;
  requestViewRestore: (position: Vec3, target: Vec3) => void;
}

const initialDraft = createDraft();

export const usePtgStore = create<PtgState>()(temporal((set, get) => ({
  ...editingActions(set, get),
  identity: initialDraft.identity,
  content: initialDraft.content,

  mode: 'create',
  planeKind: 'xy',
  planeOffsets: { xy: 0, xz: 0, yz: 0 },
  selectedNodeId: null,
  feedback: feedback('info', 'system', 'READY', '空白场景已就绪；默认在建点模式，点击画布在工作平面上建立结点。'),

  reference: null,
  referenceLoading: false,
  referenceError: null,
  referenceToken: 0,

  viewResetNonce: 0,
  viewFocusNonce: 0,
  sceneEpoch: 0,
  viewRestore: null,

  producerInstanceId: PRODUCER_INSTANCE_ID,
  bootStatus: 'pending',
  saveState: 'idle',
  saveGeneration: 0,
  lastSavedGeneration: 0,
  lastSavedRevision: null,
  lastSavedAt: null,
  saveErrorCode: null,
  saveMessage: null,
  autosaveEnabled: false,
  storedRecord: null,
  exportState: emptyExportState(),

  setMode: (mode) => {
    set({
      mode,
      drag: null,
      pendingConnection: null,
      feedback: feedback(
        'info',
        'system',
        'MODE',
        mode === 'create'
          ? '已切换到建点模式：在画布上单击当前工作平面即可建点；拖动仍用于相机。'
          : mode === 'connect' ? '连线模式：明确选择两个结点；交叉不会自动连通。' : mode === 'move' ? '移动模式：拖动控件沿图坐标约束移动，Escape 取消；空白处拖动相机。' : '选择模式：单击结点或列表项选择；拖动用于相机。',
      ),
    });
  },

  setPlaneKind: (kind) => {
    const state = get();
    if (kind === 'reference') {
      if (!state.reference) {
        set({
          feedback: feedback('error', 'plane', 'NO_REFERENCE_PLANE', '尚未加载参考图，不能把参考图平面设为建点平面。'),
        });
        return;
      }
      if (state.referenceLoading) {
        set({
          feedback: feedback('error', 'plane', 'REFERENCE_LOADING', '参考图仍在加载，暂不能把参考图平面设为建点平面。'),
        });
        return;
      }
    }
    set({
      planeKind: kind,
      feedback: feedback(
        'info',
        'plane',
        'PLANE_CHANGED',
        kind === 'reference'
          ? '当前建点平面：参考图平面（显示平面与求交平面为同一摆放）。'
          : `当前建点平面：${kind.toUpperCase()} 平面。`,
      ),
    });
  },

  setPlaneOffset: (kind, value) => {
    if (!Number.isFinite(value) || Math.abs(value) > SPATIAL_MAX_ABS_COORD) {
      set({
        feedback: feedback(
          'error',
          'plane',
          'INVALID_OFFSET',
          `偏移必须是绝对值不超过 ${SPATIAL_MAX_ABS_COORD} 的有限数；已保留原偏移。`,
        ),
      });
      return false;
    }
    set((state) => ({
      planeOffsets: { ...state.planeOffsets, [kind]: value },
      feedback: feedback(
        'info',
        'plane',
        'OFFSET_CHANGED',
        `${kind.toUpperCase()} 平面偏移已设为 ${value}（不改变图内容与 revision）。`,
      ),
    }));
    return true;
  },

  addNodeAtGraphPoint: (point) => {
    const invalid = positionError(get().content.nodes, point);
    if (invalid) {
      counters.rejectedCreations += 1;
      set({ feedback: feedback('error', 'create', invalid.code, invalid.message) });
      return { ok: false, code: invalid.code, message: invalid.message };
    }

    const state = get();
    const identity = bumpRevision(state.identity);
    if (!identity) {
      counters.rejectedCreations += 1;
      const message = `修订号已达上限 ${MAX_GRAPH_REVISION}（2^53-1），不能再建立结点；请新建图后继续。原图未改变。`;
      set({ feedback: feedback('error', 'create', 'REVISION_LIMIT', message) });
      return { ok: false, code: 'REVISION_LIMIT', message };
    }

    const existing = new Set(state.content.nodes.map((node) => node.id));
    const nodeId = createNodeId(existing);
    const node: GraphNode = {
      id: nodeId,
      position: [point[0], point[1], point[2]],
    };

    counters.createdNodes += 1;
    set({
      content: {
        ...state.content,
        nodes: [...state.content.nodes, node],
      },
      identity,
      drag: null,
      pendingConnection: null,
      selectedNodeId: nodeId,
      feedback: feedback(
        'success',
        'create',
        'NODE_CREATED',
        `已建立结点 ${nodeId}，图坐标 ${formatVec3(node.position, 6)}；revision → ${identity.revision}。`,
      ),
    });
    return { ok: true, nodeId };
  },

  reportCreationFailure: (code, message) => {
    counters.rejectedCreations += 1;
    set({ feedback: feedback('error', 'create', code, message) });
  },

  selectNode: (nodeId) => {
    if (nodeId !== null && !get().content.nodes.some((node) => node.id === nodeId)) {
      set({
        feedback: feedback('error', 'select', 'UNKNOWN_NODE', `结点 ${nodeId} 不存在，未改变选择。`),
      });
      return false;
    }
    set({
      selectedNodeId: nodeId,
      drag: null,
      feedback: nodeId
        ? feedback('info', 'select', 'SELECTED', `已选择结点 ${nodeId}（选择属于编辑器状态，不改变 revision）。`)
        : feedback('info', 'select', 'SELECTION_CLEARED', '已清除选择。'),
    });
    return true;
  },

  beginReferenceLoad: (token) => {
    set({
      referenceToken: token,
      referenceLoading: true,
      referenceError: null,
      feedback: feedback('info', 'reference', 'REFERENCE_LOADING', '正在解码参考图…'),
    });
  },

  commitReference: (token, input) => {
    const state = get();
    if (token !== state.referenceToken) {
      disposeBitmap(input.bitmap);
      counters.staleReferenceResults += 1;
      return { committed: false, stale: true };
    }

    const pose = input.pose ?? state.reference?.pose ?? defaultReferencePose();
    const poseError = validateReferencePose(pose);
    if (poseError) {
      disposeBitmap(input.bitmap);
      set({
        referenceLoading: false,
        referenceError: poseError,
        feedback: feedback('error', 'reference', 'INVALID_REFERENCE_POSE', poseError),
      });
      return { committed: false, stale: false };
    }

    const planeSize = imagePlaneSize(input.intrinsicWidth, input.intrinsicHeight, input.baseWidth ?? REFERENCE_BASE_WIDTH);
    if (!Number.isFinite(planeSize.width) || !Number.isFinite(planeSize.height)) {
      disposeBitmap(input.bitmap);
      set({
        referenceLoading: false,
        referenceError: '参考图尺寸无效',
        feedback: feedback('error', 'reference', 'INVALID_IMAGE_SIZE', '参考图尺寸无效，保留原状态。'),
      });
      return { committed: false, stale: false };
    }

    const previous = state.reference;
    const previousSourceIds = state.content.source_reference_image_ids;
    const nextSourceIds = [input.sourceId];
    const sourceChanged =
      previousSourceIds.length !== nextSourceIds.length ||
      previousSourceIds.some((id) => !nextSourceIds.includes(id));

    const identity = sourceChanged ? bumpRevision(state.identity) : state.identity;
    if (!identity) {
      disposeBitmap(input.bitmap);
      set({
        referenceLoading: false,
        referenceError: `修订号已达上限 ${MAX_GRAPH_REVISION}，无法提交新的参考图来源`,
        feedback: feedback(
          'error',
          'reference',
          'REVISION_LIMIT',
          `修订号已达上限 ${MAX_GRAPH_REVISION}（2^53-1），不能登记新的参考图来源；请新建图。原状态未改变。`,
        ),
      });
      return { committed: false, stale: false };
    }

    disposeBitmap(previous?.bitmap);

    counters.referenceLoadsCommitted += 1;
    set({
      reference: {
        sourceId: input.sourceId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        intrinsicWidth: input.intrinsicWidth,
        intrinsicHeight: input.intrinsicHeight,
        bitmap: input.bitmap,
        pose,
        baseWidth: input.baseWidth ?? REFERENCE_BASE_WIDTH,
        bytes: input.bytes,
        orientationPolicy: 'from-image',
      },
      content: {
        ...state.content,
        source_reference_image_ids: nextSourceIds,
      },
      identity,
      referenceLoading: false,
      referenceError: null,
      drag: sourceChanged ? null : state.drag,
      pendingConnection: sourceChanged ? null : state.pendingConnection,
      feedback: feedback(
        'success',
        'reference',
        'REFERENCE_COMMITTED',
        `参考图 ${input.fileName} 已提交（${input.intrinsicWidth}×${input.intrinsicHeight}，方向校正后）；来源 ID ${input.sourceId}${
          sourceChanged ? `，revision → ${identity.revision}` : ''
        }。成功加载参考图为历史屏障，已清空撤销/重做。`,
      ),
    });
    usePtgStore.temporal.getState().clear();
    return { committed: true, stale: false };
  },

  failReference: (token, message) => {
    const state = get();
    if (token !== state.referenceToken) {
      counters.staleReferenceResults += 1;
      return;
    }
    set({
      referenceLoading: false,
      referenceError: message,
      feedback: feedback('error', 'reference', 'REFERENCE_FAILED', `${message}（保留先前有效状态）`),
    });
  },

  setReferencePose: (pose) => {
    const state = get();
    if (!state.reference) {
      set({ feedback: feedback('error', 'reference', 'NO_REFERENCE', '尚未加载参考图。') });
      return false;
    }
    const error = validateReferencePose(pose);
    if (error) {
      set({
        referenceError: error,
        feedback: feedback('error', 'reference', 'INVALID_REFERENCE_POSE', `${error}；已保留原摆放。`),
      });
      return false;
    }
    set({
      reference: { ...state.reference, pose },
      referenceError: null,
      feedback: feedback(
        'info',
        'reference',
        'REFERENCE_POSE_CHANGED',
        '参考图摆放已更新（编辑器状态；不改变结点位置与 revision）。',
      ),
    });
    return true;
  },

  removeReference: () => {
    const state = get();
    const hadReference = state.reference !== null;
    const hadSource = state.content.source_reference_image_ids.length > 0;
    const identity = hadSource ? bumpRevision(state.identity) : state.identity;
    if (!identity) {
      set({
        feedback: feedback(
          'error',
          'reference',
          'REVISION_LIMIT',
          `修订号已达上限 ${MAX_GRAPH_REVISION}，不能变更参考图来源；请新建图。原状态未改变。`,
        ),
      });
      return;
    }
    disposeBitmap(state.reference?.bitmap);
    set({
      reference: null,
      referenceLoading: false,
      referenceError: null,
      referenceToken: state.referenceToken + 1,
      drag: hadSource ? null : state.drag,
      pendingConnection: hadSource ? null : state.pendingConnection,
      planeKind: state.planeKind === 'reference' ? 'xy' : state.planeKind,
      content: hadSource ? {
        ...state.content,
        source_reference_image_ids: [],
      } : state.content,
      identity,
      feedback: feedback(
        'info',
        'reference',
        'REFERENCE_REMOVED',
        hadReference
          ? `已移除参考图；revision → ${identity.revision}；历史屏障：已清空撤销/重做。`
          : '当前没有参考图。',
      ),
    });
    if (hadSource) usePtgStore.temporal.getState().clear();
  },

  newDraft: () => {
    const state = get();
    disposeBitmap(state.reference?.bitmap);
    const draft = createDraft(state.producerInstanceId);
    counters.newDrafts += 1;
    set({
      identity: draft.identity,
      content: draft.content,
      producerInstanceId: draft.identity.producer_instance_id,
      mode: 'create',
      planeKind: 'xy',
      planeOffsets: { xy: 0, xz: 0, yz: 0 },
      selectedNodeId: null,
      drag: null,
      pendingConnection: null,
      reference: null,
      referenceLoading: false,
      referenceError: null,
      referenceToken: state.referenceToken + 1,
      sceneEpoch: state.sceneEpoch + 1,
      viewRestore: null,
      // A new graph is a new local identity: nothing has been saved for it yet.
      saveState: 'unsaved',
      lastSavedGeneration: 0,
      lastSavedRevision: null,
      lastSavedAt: null,
      saveErrorCode: null,
      saveMessage: null,
      storedRecord: null,
      exportState: emptyExportState(),
      feedback: feedback(
        'info',
        'draft',
        'NEW_DRAFT',
        `已建立新草稿 ${draft.identity.graph_id} / 框架 ${draft.identity.frame_id}，revision 从 1 开始。`,
      ),
    });
    usePtgStore.temporal.getState().clear();
  },

  requestViewReset: () => {
    counters.viewResets += 1;
    set((state) => ({
      viewResetNonce: state.viewResetNonce + 1,
      feedback: feedback('info', 'camera', 'VIEW_RESET', '已恢复默认视角（相机属于编辑器状态，不改变 revision）。'),
    }));
  },

  requestFocusReference: () => {
    const state = get();
    if (!state.reference) {
      set({ feedback: feedback('error', 'camera', 'NO_REFERENCE', '尚未加载参考图，无法对准。') });
      return;
    }
    counters.referenceFocusRequests += 1;
    set((s) => ({
      viewFocusNonce: s.viewFocusNonce + 1,
      feedback: feedback('info', 'camera', 'VIEW_FOCUS_REFERENCE', '已对准参考图平面（相机属于编辑器状态）。'),
    }));
  },

  clearFeedback: () => set({ feedback: null }),
  dismissReferenceError: () => set({ referenceError: null }),

  setBootStatus: (status) => set({ bootStatus: status }),
  setAutosaveEnabled: (enabled) => set({ autosaveEnabled: enabled }),

  markUnsaved: () => {
    const current = get();
    // Idempotent: an already-dirty state must not emit a store update, otherwise
    // the persistence subscriber would re-enter itself on every notification.
    if (
      current.saveState === 'unsaved' &&
      current.saveErrorCode === null &&
      current.saveMessage === null
    ) {
      return;
    }
    // A failed save keeps its diagnostic until the next attempt; editing again
    // is not a success and must not clear the visible failure.
    if (current.saveState === 'failed') {
      return;
    }
    if (current.saveState === 'saving' || current.saveState === 'blocked') {
      return;
    }
    set({ saveState: 'unsaved', saveErrorCode: null, saveMessage: null });
  },

  beginSave: (generation) => {
    set({
      saveState: 'saving',
      saveGeneration: generation,
      saveErrorCode: null,
      saveMessage: null,
    });
  },

  settleSave: ({ generation, ok, revision, at, code, message, blocked, unchanged }) => {
    set((state) => {
      if (blocked) {
        return {
          saveState: 'blocked',
          saveErrorCode: code ?? 'LOCAL_STORAGE_UNAVAILABLE',
          saveMessage: message ?? null,
        };
      }
      if (!ok) {
        // A late failure from an older attempt must not describe the newest one.
        if (generation !== state.saveGeneration) {
          return {};
        }
        return {
          saveState: 'failed',
          saveErrorCode: code ?? 'LOCAL_IO_ERROR',
          saveMessage: message ?? null,
        };
      }
      // Success may only be claimed for the newest attempt AND the exact state
      // that was captured. An older write landing late cannot mark newer edits
      // as saved.
      const stale = generation !== state.saveGeneration;
      const graphChanged = revision !== undefined && revision !== state.identity.revision;
      if (stale || graphChanged || unchanged === false) {
        return {
          saveState: 'unsaved',
          saveErrorCode: null,
          saveMessage: null,
        };
      }
      return {
        saveState: 'saved',
        lastSavedGeneration: generation,
        lastSavedRevision: revision ?? state.identity.revision,
        lastSavedAt: at ?? Date.now(),
        saveErrorCode: null,
        saveMessage: null,
      };
    });
  },

  setStoredRecord: (info) => set({ storedRecord: info }),

  recoverFromBlocked: (info, unchanged = true) => {
    set((state) => ({
      bootStatus: 'restored',
      autosaveEnabled: true,
      saveErrorCode: null,
      saveMessage: null,
      storedRecord: info,
      saveState: unchanged ? 'saved' : 'unsaved',
      lastSavedGeneration: unchanged
        ? info?.saveGeneration ?? state.saveGeneration
        : state.lastSavedGeneration,
      lastSavedRevision: unchanged
        ? info?.revision ?? state.identity.revision
        : state.lastSavedRevision,
      lastSavedAt: unchanged ? info?.savedAt ?? Date.now() : state.lastSavedAt,
    }));
  },

  applyRestoredSession: (input) => {
    const state = get();
    disposeBitmap(state.reference?.bitmap);
    const finiteOffset = (value: number, fallback: number): number =>
      Number.isFinite(value) && Math.abs(value) <= SPATIAL_MAX_ABS_COORD ? value : fallback;
    const selectedNodeId =
      input.editor.selectedNodeId !== null &&
      input.content.nodes.some((node) => node.id === input.editor.selectedNodeId)
        ? input.editor.selectedNodeId
        : null;
    const identity: GraphIdentity = {
      ...input.identity,
      coordinate_system: {
        ...input.identity.coordinate_system,
        frame_id: input.identity.frame_id,
      },
    };
    set({
      identity,
      content: {
        nodes: input.content.nodes.map((node) => ({
          id: node.id,
          position: [node.position[0], node.position[1], node.position[2]],
        })),
        edges: input.content.edges.map((edge) => [edge[0], edge[1]] as [string, string]),
        n_terminal_node: input.content.n_terminal_node,
        source_reference_image_ids: [...input.content.source_reference_image_ids],
      },
      producerInstanceId: identity.producer_instance_id,
      mode: input.editor.mode,
      planeKind: input.editor.planeKind,
      planeOffsets: {
        xy: finiteOffset(input.editor.planeOffsets.xy, 0),
        xz: finiteOffset(input.editor.planeOffsets.xz, 0),
        yz: finiteOffset(input.editor.planeOffsets.yz, 0),
      },
      selectedNodeId,
      drag: null,
      pendingConnection: null,
      dragConstraint: input.editor.dragConstraint as typeof state.dragConstraint,
      reference: input.reference
        ? {
            sourceId: input.reference.sourceId,
            fileName: input.reference.fileName,
            mimeType: input.reference.mimeType,
            intrinsicWidth: input.reference.intrinsicWidth,
            intrinsicHeight: input.reference.intrinsicHeight,
            bitmap: input.reference.bitmap,
            pose: {
              position: [...input.reference.pose.position],
              rotationDeg: [...input.reference.pose.rotationDeg],
              scale: input.reference.pose.scale,
            },
            baseWidth: input.reference.baseWidth,
            bytes: input.reference.bytes,
            orientationPolicy: 'from-image',
          }
        : null,
      referenceLoading: false,
      referenceError: null,
      referenceToken: state.referenceToken + 1,
      sceneEpoch: state.sceneEpoch + 1,
      viewRestore: input.camera
        ? {
            nonce: (state.viewRestore?.nonce ?? 0) + 1,
            position: [...input.camera.position],
            target: [...input.camera.target],
          }
        : null,
      bootStatus: 'restored',
      saveState: 'saved',
      saveGeneration: input.stored?.saveGeneration ?? 0,
      lastSavedGeneration: input.stored?.saveGeneration ?? 0,
      lastSavedRevision: input.stored?.revision ?? identity.revision,
      lastSavedAt: input.stored?.savedAt ?? null,
      saveErrorCode: null,
      saveMessage: null,
      storedRecord: input.stored,
      exportState: emptyExportState(),
      feedback: feedback(input.notice.level, 'restore', input.notice.code, input.notice.message),
    });
    // Restoring is not an edit: history starts empty and revision is unchanged.
    usePtgStore.temporal.getState().clear();
  },

  setExportState: (state) => set({ exportState: state }),
  resetExportState: () => set({ exportState: emptyExportState() }),

  requestViewRestore: (position, target) => {
    set((state) => ({
      viewRestore: {
        nonce: (state.viewRestore?.nonce ?? 0) + 1,
        position: [position[0], position[1], position[2]],
        target: [target[0], target[1], target[2]],
      },
      feedback: feedback('info', 'camera', 'VIEW_RESTORED', '已恢复保存的相机姿态与目标（编辑器状态）。'),
    }));
  },
}), { partialize: (state) => ({ content: state.content }), equality: (a,b) => a.content === b.content }));

/** Resolve the active creation plane in the graph frame, or null when unavailable. */
export function resolveActivePlane(state: Pick<PtgState, 'planeKind' | 'planeOffsets' | 'reference'>): PlaneSpec | null {
  if (state.planeKind === 'reference') {
    return state.reference ? referencePlane(state.reference.pose) : null;
  }
  return workPlane(state.planeKind, state.planeOffsets[state.planeKind]);
}

export function referenceStatusOf(state: Pick<PtgState, 'reference' | 'referenceLoading'>): ReferenceStatus {
  if (state.referenceLoading) {
    return 'loading';
  }
  return state.reference ? 'ready' : 'empty';
}

export function createReferenceSourceId(): string {
  return createImageSourceId();
}

/** Test-only helper: build a fresh store-independent draft snapshot. */
export function createDraftSnapshot(): { identity: GraphIdentity; content: GraphContent } {
  return createDraft();
}

export const GRAPH_LIMITS = {
  maxAbsCoordinate: SPATIAL_MAX_ABS_COORD,
  coincidentEpsilon: COINCIDENT_EPS,
} as const;

export const STORE_CONSTANTS = {
  producerInstanceId: PRODUCER_INSTANCE_ID,
} as const;
