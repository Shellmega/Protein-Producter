import { useMemo, useState } from 'react';
import { usePtgStore } from '../domain/store';
import { buildSnapshot } from '../windowApi';

/**
 * Read-only diagnostics. This is explicitly not the PTG-3 contract export: it
 * exists so the author evidence can read exact binary64 values and counters.
 */
export function DiagnosticsPanel() {
  const revision = usePtgStore((state) => state.identity.revision);
  const nodeCount = usePtgStore((state) => state.content.nodes.length);
  const selectedNodeId = usePtgStore((state) => state.selectedNodeId);
  const planeKind = usePtgStore((state) => state.planeKind);
  const sourceIds = usePtgStore((state) => state.content.source_reference_image_ids);
  const feedback = usePtgStore((state) => state.feedback);
  const [tick, setTick] = useState(0);

  const snapshot = useMemo(
    () => buildSnapshot(),
    // The camera is not reactive here; refresh re-samples it on demand.
    [revision, nodeCount, selectedNodeId, planeKind, sourceIds, feedback, tick],
  );

  return (
    <section className="ptg-panel" aria-label="状态诊断">
      <h2 className="ptg-panel-title">状态诊断（只读）</h2>
      <div className="ptg-row">
        <button
          type="button"
          className="ptg-button"
          data-testid="diagnostics-refresh"
          onClick={() => setTick((value) => value + 1)}
        >
          刷新诊断
        </button>
        <span className="ptg-hint">window.__PTG__.snapshot()</span>
      </div>
      <details className="ptg-diagnostics">
        <summary>展开诊断 JSON</summary>
        <pre data-testid="diagnostics-json">{JSON.stringify(snapshot, null, 2)}</pre>
      </details>
      <p className="ptg-note">
        该诊断不是契约导出，也不包含保存、恢复、发送或回执能力；那些属于 PTG-3/PTG-4。
      </p>
    </section>
  );
}
