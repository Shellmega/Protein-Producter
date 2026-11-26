import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { usePtgStore } from '../domain/store';
import { topology } from '../domain/topology';
import type { DragConstraint } from '../domain/geometry';
import type { GraphNode } from '../domain/types';

export function GraphEditorPanel() {
  const content = usePtgStore(s => s.content);
  const selected = usePtgStore(s => s.selectedNodeId);
  const constraint = usePtgStore(s => s.dragConstraint);
  const pending = usePtgStore(s => s.pendingConnection);
  const past = useStore(usePtgStore.temporal, s => s.pastStates.length);
  const future = useStore(usePtgStore.temporal, s => s.futureStates.length);
  const t = topology(content);
  const node = content.nodes.find(n => n.id === selected);
  return <section className="ptg-panel" aria-label="图编辑">
    <h2 className="ptg-panel-title">图编辑</h2>
    <div className="ptg-row">
      <button className="ptg-button" data-testid="undo" disabled={!past} onClick={() => usePtgStore.getState().undo()}>撤销 ({past})</button>
      <button className="ptg-button" data-testid="redo" disabled={!future} onClick={() => usePtgStore.getState().redo()}>重做 ({future})</button>
    </div>
    <p className="ptg-note">连线模式：在画布或列表依次选择两个结点。交叉不会自动连通。{pending ? `等待第二点（起点 ${pending}）` : ''}</p>
    <label className="ptg-field"><span>拖动约束 · 固定图坐标</span>
      <select className="ptg-input" data-testid="drag-constraint" value={constraint} onChange={e => usePtgStore.getState().setDragConstraint(e.target.value as DragConstraint)}>
        {['X','Y','Z','XY','XZ','YZ'].map(c => <option key={c}>{c}</option>)}
      </select>
    </label>
    <p className="ptg-note">移动模式拖彩色轴/面控件；受限坐标保持原值。Escape / 失焦取消。空白处拖动相机。</p>
    {node ? <XYZEditor key={node.id} node={node} /> : <p className="ptg-note">先选择一个结点以输入 XYZ、删除或指定 N 端。</p>}
    <div className="ptg-row">
      <button className="ptg-button" data-testid="delete-node" disabled={!node} onClick={() => node && usePtgStore.getState().deleteNode(node.id)}>删除选中结点</button>
      <button className="ptg-button" data-testid="set-n-terminal" disabled={!node} onClick={() => node && usePtgStore.getState().setNTerminal(node.id)}>设为 N 端</button>
      <button className="ptg-button" data-testid="focus-node" disabled={!node} onClick={() => usePtgStore.getState().requestFocusNode()}>聚焦结点</button>
    </div>
    <div className="ptg-topology" data-testid="topology-status">
      <p>结点 {content.nodes.length} · 边 {content.edges.length} · 连通分量 {t.components}</p>
      <p>{t.openChain ? '开放链' : '草稿（允许断连、分支或闭环）'}</p>
      <p data-testid="n-terminal-status">N 端：{content.n_terminal_node ?? '未指定'}{content.n_terminal_node && !t.startValid ? ' · 草稿起点待修正（当前度不为 1）' : ''}</p>
      {t.order.length ? <p data-testid="chain-order">N → C：{t.order.join(' → ')}</p> : null}
    </div>
    <details><summary>边与只读邻接</summary>
      <ul className="ptg-edge-list" data-testid="edge-list">{content.edges.map(([a,b]) => <li key={`${a}|${b}`}>
        <span>{a} ↔ {b}</span><button className="ptg-button" data-testid={`delete-edge-${a}-${b}`} onClick={() => usePtgStore.getState().deleteEdge(a,b)}>删边</button>
      </li>)}</ul>
      <pre data-testid="derived-adjacency">{JSON.stringify(t.adjacency, null, 2)}</pre>
    </details>
    <p className="ptg-note">参考图成功加载、替换或移除会清空撤销/重做。图片摆放不影响历史。快捷键 Ctrl/Cmd+Z、Shift+Z / Ctrl+Y；Delete 删选中结点（文本框使用自己的按键）。</p>
  </section>;
}

function XYZEditor({ node }: { node: GraphNode }) {
  const revision = usePtgStore(s => s.identity.revision);
  const [values, setValues] = useState<[string,string,string]>(() => node.position.map(String) as [string,string,string]);
  const reset = () => setValues(node.position.map(String) as [string,string,string]);
  useEffect(reset, [node.position, revision]);
  return <form className="ptg-xyz-editor" data-testid="xyz-editor" onSubmit={e => {
    e.preventDefault();
    usePtgStore.getState().setXYZ(node.id, values);
  }}>
    <p className="ptg-note">XYZ · {node.id} · ±1e6 scene_unit。Enter 整组提交；Escape 恢复字段；切换结点丢弃未提交输入。</p>
    {['X','Y','Z'].map((axis,i) => <label className="ptg-field" key={axis}><span>{axis}</span><input className="ptg-input" type="text" inputMode="decimal" data-testid={`xyz-${axis.toLowerCase()}`} value={values[i]}
      onChange={e => setValues(v => v.map((s,j) => j === i ? e.target.value : s) as [string,string,string])}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); reset(); } }} /></label>)}
    <button className="ptg-button" data-testid="xyz-apply" type="submit">应用 XYZ</button>
  </form>;
}
