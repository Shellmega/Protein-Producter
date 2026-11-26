import { usePtgStore } from '../domain/store';
import { formatVec3 } from '../spatial/math';

/**
 * Node table. Rows are stable-ID keyed and always selectable, which
 * is the supported way to select a node that is occluded in the 3D view.
 * XYZ editing is in GraphEditorPanel; connection mode routes explicit choices.
 */
export function NodeList() {
  const nodes = usePtgStore((state) => state.content.nodes);
  const selectedNodeId = usePtgStore((state) => state.selectedNodeId);
  const selectNode = usePtgStore((state) => state.chooseNode);

  return (
    <section className="ptg-panel" aria-label="结点列表">
      <h2 className="ptg-panel-title">
        结点列表 <span className="ptg-count" data-testid="node-count">{nodes.length}</span>
      </h2>
      {nodes.length === 0 ? (
        <p className="ptg-note" data-testid="node-list-empty">
          当前草稿没有结点。使用建点模式在可见工作平面上单击即可建立非共面点集。
        </p>
      ) : (
        <ul className="ptg-node-list" data-testid="node-list">
          {nodes.map((node) => {
            const selected = node.id === selectedNodeId;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  className={`ptg-node-row ${selected ? 'is-selected' : ''}`}
                  data-testid={`node-item-${node.id}`}
                  data-node-id={node.id}
                  data-selected={selected ? 'true' : 'false'}
                  onClick={() => selectNode(node.id)}
                  title={`${node.id}  ${node.position[0]} ${node.position[1]} ${node.position[2]}`}
                >
                  <span className="ptg-node-id">{node.id}</span>
                  <span className="ptg-node-xyz" data-testid={`node-xyz-${node.id}`}>
                    {formatVec3(node.position, 6)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {selectedNodeId ? <SelectedNodeDetail nodeId={selectedNodeId} /> : null}
    </section>
  );
}

function SelectedNodeDetail({ nodeId }: { nodeId: string }) {
  const node = usePtgStore((state) => state.content.nodes.find((candidate) => candidate.id === nodeId));

  if (!node) {
    return null;
  }

  return (
    <div className="ptg-selected" data-testid="selected-node-detail">
      <div className="ptg-selected-title">当前选中 · 完整精度</div>
      <div className="ptg-selected-id" data-testid="selected-node-id">
        {node.id}
      </div>
      <div className="ptg-selected-xyz" data-testid="selected-node-xyz">
        X {node.position[0]}
        <br />
        Y {node.position[1]}
        <br />
        Z {node.position[2]}
      </div>
    </div>
  );
}
