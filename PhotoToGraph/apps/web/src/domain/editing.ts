import { bumpRevision, usePtgStore, type PtgState } from './store';
import { constrainedPosition, positionError, type DragConstraint } from './geometry';
import { normalizedEdge, topology } from './topology';
import { MAX_GRAPH_REVISION, type GraphContent, type GraphIdentity } from './types';
import type { Vec3 } from '../spatial/math';

export interface DragTransaction {
  token: number;
  nodeId: string;
  graphId: string;
  frameId: string;
  revision: number;
  start: [number, number, number];
  preview: [number, number, number];
  constraint: DragConstraint;
}
export interface EditingState {
  pendingConnection: string | null;
  dragConstraint: DragConstraint;
  drag: DragTransaction | null;
  viewNodeFocusNonce: number;
  chooseNode: (id: string) => boolean;
  connectNodes: (a: string, b: string) => boolean;
  deleteEdge: (a: string, b: string) => boolean;
  deleteNode: (id: string) => boolean;
  setNTerminal: (id: string) => boolean;
  moveNode: (id: string, point: Vec3) => boolean;
  setXYZ: (id: string, values: [string, string, string]) => boolean;
  setDragConstraint: (value: DragConstraint) => void;
  beginDrag: (id: string) => number | null;
  previewDrag: (token: number, point: Vec3) => void;
  finishDrag: (token: number) => boolean;
  cancelDrag: () => void;
  undo: () => void;
  redo: () => void;
  requestFocusNode: () => void;
}
let dragToken = 0;

/** Revision cap message shared by every graph mutation. */
export const REVISION_LIMIT_MESSAGE = `修订号已达上限 ${MAX_GRAPH_REVISION}（2^53-1），不能继续修改图；请新建图。原图未改变。`;

export function editPatch(
  state: PtgState,
  content: GraphContent,
  identity: GraphIdentity,
): Partial<PtgState> {
  return {
    content,
    identity,
    selectedNodeId: content.nodes.some(n => n.id === state.selectedNodeId) ? state.selectedNodeId : null,
    pendingConnection: null,
    drag: null,
  };
}

function liveDrag(state: PtgState, drag: DragTransaction) {
  return state.identity.graph_id === drag.graphId && state.identity.frame_id === drag.frameId &&
    state.identity.revision === drag.revision && state.content.nodes.some(n => n.id === drag.nodeId);
}

export function editingActions(set: (patch: Partial<PtgState>) => void, get: () => PtgState): EditingState {
  const message = (code: string, text: string, error = false) => ({
    feedback: { code, message: text, level: error ? 'error' as const : 'info' as const, source: 'system' as const, at: Date.now() },
  });
  const reject = (code: string, text: string) => { set(message(code, text, true)); return false; };
  const commit = (content: GraphContent, code: string, text: string) => {
    const state = get();
    const identity = bumpRevision(state.identity);
    if (!identity) {
      return reject('REVISION_LIMIT', REVISION_LIMIT_MESSAGE);
    }
    set({ ...editPatch(state, content, identity), ...message(code, text) });
    return true;
  };
  const travel = (direction: 'undo' | 'redo') => {
    const before = get();
    const identity = bumpRevision(before.identity);
    if (!identity) {
      reject('REVISION_LIMIT', REVISION_LIMIT_MESSAGE);
      return;
    }
    set({ drag: null, pendingConnection: null });
    const history = usePtgStore.temporal.getState();
    if (!(direction === 'undo' ? history.pastStates : history.futureStates).length) return;
    history[direction](); // Zundo restores only content, bypassing its tracking setter.
    const content = get().content;
    set({ ...editPatch(before, content, identity), ...message(direction.toUpperCase(), `已${direction === 'undo' ? '撤销' : '重做'}一次图编辑；revision 继续递增。`) });
  };
  return {
    pendingConnection: null,
    dragConstraint: 'X',
    drag: null,
    viewNodeFocusNonce: 0,
    chooseNode: (id) => {
      const state = get();
      if (!state.content.nodes.some(n => n.id === id) || state.mode !== 'connect') return state.selectNode(id);
      if (state.pendingConnection) return state.connectNodes(state.pendingConnection, id);
      set({ pendingConnection: id, selectedNodeId: id, ...message('CONNECT_FIRST', '已选连线起点，请明确选择第二个结点；Escape 取消。') });
      return true;
    },
    connectNodes: (a, b) => {
      const state = get();
      set({ pendingConnection: null });
      if (![a,b].every(id => state.content.nodes.some(n => n.id === id))) return reject('UNKNOWN_NODE', '连线结点不存在，未修改图。');
      if (a === b) return reject('SELF_LOOP', '不能连接结点自身，未修改图。');
      const edge = normalizedEdge(a, b);
      if (state.content.edges.some(e => e[0] === edge[0] && e[1] === edge[1])) return reject('EDGE_EXISTS', '已有这条无向边，未重复添加。');
      return commit({ ...state.content, edges: [...state.content.edges, edge].sort((x,y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : 1) }, 'EDGE_ADDED', '已显式连接两个结点。');
    },
    deleteEdge: (a,b) => {
      const state = get();
      const [x,y] = normalizedEdge(a,b);
      const edges = state.content.edges.filter(e => e[0] !== x || e[1] !== y);
      if (edges.length === state.content.edges.length) return reject('UNKNOWN_EDGE', '边不存在，未修改图。');
      return commit({ ...state.content, edges }, 'EDGE_DELETED', '已删除单边，保留两端结点。');
    },
    deleteNode: (id) => {
      const state = get();
      if (!state.content.nodes.some(n => n.id === id)) return reject('UNKNOWN_NODE', '结点不存在，未删除。');
      const wasStart = state.content.n_terminal_node === id;
      const content = { ...state.content, nodes: state.content.nodes.filter(n => n.id !== id),
        edges: state.content.edges.filter(e => !e.includes(id)), n_terminal_node: wasStart ? null : state.content.n_terminal_node };
      return commit(content, 'NODE_DELETED', wasStart ? '已删除结点及关联边；N 端已清空，请重新指定。' : '已删除结点及全部关联边。');
    },
    setNTerminal: (id) => {
      const state = get();
      if (topology(state.content).adjacency[id]?.length !== 1) return reject('INVALID_N_TERMINAL', 'N 端必须是现存且度为 1 的结点。');
      if (state.content.n_terminal_node === id) return false;
      return commit({ ...state.content, n_terminal_node: id }, 'N_TERMINAL_SET', '已设置 N 端，开放链方向由此确定。');
    },
    moveNode: (id, point) => {
      const state = get();
      const node = state.content.nodes.find(n => n.id === id);
      const invalid = node ? positionError(state.content.nodes, point, id) : { code: 'UNKNOWN_NODE', message: '结点不存在，未移动。' };
      if (invalid) return reject(invalid.code, invalid.message);
      if (node!.position.every((v,i) => v === point[i])) return false;
      return commit({ ...state.content, nodes: state.content.nodes.map(n => n.id === id ? { ...n, position: [...point] as [number,number,number] } : n) }, 'NODE_MOVED', '已一次提交 XYZ，保留结点 ID 与边。');
    },
    setXYZ: (id, values) => {
      if (values.some(v => v.trim() === '' || !Number.isFinite(Number(v)))) return reject('INVALID_XYZ', 'XYZ 必须是三个有限数；空串、NaN 和 Infinity 均拒绝，整组未修改。');
      return get().moveNode(id, values.map(Number) as [number,number,number]);
    },
    setDragConstraint: (value) => set({ dragConstraint: value, drag: null }),
    beginDrag: (id) => {
      const state = get();
      const node = state.content.nodes.find(n => n.id === id);
      if (!node || state.mode !== 'move') return null;
      const token = ++dragToken;
      set({ drag: { token, nodeId: id, graphId: state.identity.graph_id, frameId: state.identity.frame_id, revision: state.identity.revision,
        start: [...node.position], preview: [...node.position], constraint: state.dragConstraint } });
      return token;
    },
    previewDrag: (token, point) => {
      const state = get();
      if (!state.drag || state.drag.token !== token) return;
      if (!liveDrag(state, state.drag)) { set({ drag: null }); return; }
      set({ drag: { ...state.drag, preview: constrainedPosition(state.drag.start, point, state.drag.constraint) } });
    },
    finishDrag: (token) => {
      const state = get();
      const drag = state.drag;
      if (!drag || drag.token !== token) return false;
      set({ drag: null }); // Consume before validating; duplicate finish cannot commit.
      if (!liveDrag(state, drag)) return false;
      return get().moveNode(drag.nodeId, drag.preview);
    },
    cancelDrag: () => set({ drag: null, pendingConnection: null }),
    undo: () => travel('undo'),
    redo: () => travel('redo'),
    requestFocusNode: () => set({ viewNodeFocusNonce: get().viewNodeFocusNonce + 1 }),
  };
}

export function displayPosition(state: Pick<PtgState, 'drag'>, node: { id: string; position: Vec3 }): Vec3 {
  return state.drag?.nodeId === node.id ? state.drag.preview : node.position;
}
