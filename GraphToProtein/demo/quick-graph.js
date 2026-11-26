// Bundled against the same immutable PTG checkout as the full editor.
import { usePtgStore } from './src/domain/store';
import { validateDraftForExport } from './src/contract/validate';

const state = usePtgStore.getState;
const edits = [];
export const dots = () => state().content.nodes;
export function clearGraph() {
  edits.length = 0;
  state().newDraft();
}

export function place(position) {
  const nodes = dots();
  const last = nodes.at(-1);
  const created = state().addNodeAtGraphPoint(position);
  if (!created.ok) throw new Error(created.message);
  if (last && !state().connectNodes(last.id, created.nodeId)) {
    state().deleteNode(created.nodeId);
    throw new Error('这两个点无法相连，请换一个位置。');
  }
  if (nodes.length === 1) state().setNTerminal(last.id);
  edits.push({ id: created.nodeId });
  return created.nodeId;
}

export function movePoint(id, position) {
  const previous = dots().find(n => n.id === id)?.position;
  if (previous && position.every((v, i) => v === previous[i])) return;
  if (previous && state().moveNode(id, position)) {
    edits.push({ id, previous });
    return;
  }
  throw new Error(state().feedback?.message || '无法移动这个点。');
}

export function undoEdit() {
  const edit = edits.at(-1);
  if (!edit) return;
  const undone = edit.previous ? state().moveNode(edit.id, edit.previous) : state().deleteNode(edit.id);
  if (!undone) throw new Error('这次编辑无法撤销。');
  edits.pop();
}

export function snapshot() {
  const result = validateDraftForExport(state());
  if (!result.ok) throw new Error(result.primary?.message || '请调整描点的位置。');
  return result.payload;
}
