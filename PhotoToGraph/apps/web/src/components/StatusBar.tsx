import { usePtgStore } from '../domain/store';
import { formatVec3 } from '../spatial/math';

export function StatusBar() {
  const feedback = usePtgStore((state) => state.feedback);
  const revision = usePtgStore((state) => state.identity.revision);
  const graphId = usePtgStore((state) => state.identity.graph_id);
  const frameId = usePtgStore((state) => state.identity.frame_id);
  const nodes = usePtgStore((state) => state.content.nodes);
  const selectedNodeId = usePtgStore((state) => state.selectedNodeId);
  const saveState = usePtgStore((state) => state.saveState);
  const lastSavedRevision = usePtgStore((state) => state.lastSavedRevision);
  const selected = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const saveLabel =
    saveState === 'saved'
      ? `已保存 r${lastSavedRevision ?? revision}`
      : saveState === 'saving'
        ? '保存中…'
        : saveState === 'failed'
          ? '保存失败'
          : saveState === 'blocked'
            ? '本地存储不可用'
            : '未保存';

  return (
    <footer className={`ptg-status ptg-status-${feedback?.level ?? 'info'}`} data-testid="status-bar">
      <div className="ptg-feedback" data-testid="feedback-message" data-level={feedback?.level ?? 'info'}>
        {feedback ? (
          <>
            <span className="ptg-feedback-code" data-testid="feedback-code">
              [{feedback.code}]
            </span>{' '}
            {feedback.message}
          </>
        ) : (
          '就绪'
        )}
      </div>
      <div className="ptg-status-meta">
        <span data-testid="save-state" data-state={saveState}>
          {saveLabel}
        </span>
        <span data-testid="revision-value">revision {revision}</span>
        <span className="ptg-mono" data-testid="graph-id">
          graph {graphId}
        </span>
        <span className="ptg-mono" data-testid="frame-id">
          frame {frameId}
        </span>
        <span data-testid="status-selected">
          {selected ? `选中 ${selected.id} ${formatVec3(selected.position, 3)}` : '未选中'}
        </span>
      </div>
    </footer>
  );
}
