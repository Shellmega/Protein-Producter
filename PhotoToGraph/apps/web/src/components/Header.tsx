import { useEffect, useState } from 'react';
import { usePtgStore } from '../domain/store';
import { saveAsNewLocalGraph, startNewGraph } from '../persistence/session';
import type { WorkPlaneKind } from '../spatial/planes';

const OFFSET_PLANES: WorkPlaneKind[] = ['xy', 'xz', 'yz'];

function parseFiniteNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function Header() {
  const mode = usePtgStore((state) => state.mode);
  const setMode = usePtgStore((state) => state.setMode);
  const planeKind = usePtgStore((state) => state.planeKind);
  const setPlaneKind = usePtgStore((state) => state.setPlaneKind);
  const planeOffsets = usePtgStore((state) => state.planeOffsets);
  const setPlaneOffset = usePtgStore((state) => state.setPlaneOffset);
  const reference = usePtgStore((state) => state.reference);
  const requestViewReset = usePtgStore((state) => state.requestViewReset);

  const [offsetText, setOffsetText] = useState('0');
  const [offsetError, setOffsetError] = useState<string | null>(null);

  useEffect(() => {
    if (planeKind === 'reference') {
      setOffsetText('');
    } else {
      setOffsetText(String(planeOffsets[planeKind]));
    }
    setOffsetError(null);
  }, [planeKind, planeOffsets]);

  const applyOffset = () => {
    if (planeKind === 'reference') {
      setOffsetError('参考图平面没有轴向偏移；请修改参考图摆放。');
      return;
    }
    const value = parseFiniteNumber(offsetText);
    if (value === null) {
      setOffsetError('偏移必须是有限数（例如 0、2.5、-3）；已保留原偏移。');
      return;
    }
    const ok = setPlaneOffset(planeKind, value);
    setOffsetError(ok ? null : '偏移超出允许范围；已保留原偏移。');
  };

  return (
    <header className="ptg-header">
      <div className="ptg-brand">
        <div className="ptg-brand-title">PhotoToGraph</div>
        <div className="ptg-brand-subtitle">PTG-2 先行三维图编辑</div>
      </div>

      <div className="ptg-toolbar" role="toolbar" aria-label="建点与视图控制">
        <div className="ptg-control-group" aria-label="输入模式">
          <span className="ptg-control-label">模式</span>
          <button
            type="button"
            className={`ptg-button ${mode === 'create' ? 'is-active' : ''}`}
            data-testid="mode-create"
            onClick={() => setMode('create')}
          >
            建点
          </button>
          {(['connect', 'move'] as const).map(value => <button key={value} type="button"
            className={`ptg-button ${mode === value ? 'is-active' : ''}`} data-testid={`mode-${value}`} onClick={() => setMode(value)}>
            {value === 'connect' ? '连线' : '移动'}
          </button>)}
          <button
            type="button"
            className={`ptg-button ${mode === 'select' ? 'is-active' : ''}`}
            data-testid="mode-select"
            onClick={() => setMode('select')}
          >
            选择
          </button>
        </div>

        <div className="ptg-control-group" aria-label="工作平面">
          <span className="ptg-control-label">平面</span>
          {OFFSET_PLANES.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`ptg-button ${planeKind === kind ? 'is-active' : ''}`}
              data-testid={`plane-${kind}`}
              onClick={() => setPlaneKind(kind)}
            >
              {kind.toUpperCase()}
            </button>
          ))}
          <button
            type="button"
            className={`ptg-button ${planeKind === 'reference' ? 'is-active' : ''}`}
            data-testid="plane-reference"
            onClick={() => setPlaneKind('reference')}
            title={reference ? '以参考图平面为建点平面' : '需先加载参考图'}
          >
            参考图
          </button>
        </div>

        <div className="ptg-control-group" aria-label="平面偏移">
          <label className="ptg-control-label" htmlFor="plane-offset-input">
            偏移
          </label>
          <input
            id="plane-offset-input"
            data-testid="plane-offset-input"
            className="ptg-input ptg-input-narrow"
            type="text"
            inputMode="decimal"
            value={offsetText}
            disabled={planeKind === 'reference'}
            onChange={(event) => {
              setOffsetText(event.target.value);
              setOffsetError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                applyOffset();
              }
            }}
            aria-label="当前工作平面偏移（scene_unit）"
          />
          <button
            type="button"
            className="ptg-button"
            data-testid="plane-offset-apply"
            onClick={applyOffset}
            disabled={planeKind === 'reference'}
          >
            应用
          </button>
          {planeKind !== 'reference' ? (
            <span className="ptg-hint" data-testid="offset-axis-hint">
              {planeKind.toUpperCase()} 法向 {planeKind === 'xy' ? 'Z' : planeKind === 'xz' ? 'Y' : 'X'} ={' '}
              {planeOffsets[planeKind]}
            </span>
          ) : null}
        </div>

        <div className="ptg-control-group" aria-label="视图">
          <button type="button" className="ptg-button" data-testid="restore-view" onClick={requestViewReset}>
            恢复视角
          </button>
          <button type="button" className="ptg-button" data-testid="new-draft" onClick={() => {
            startNewGraph();
            void saveAsNewLocalGraph();
          }}>
            新建图
          </button>
        </div>
      </div>

      {offsetError ? (
        <div className="ptg-inline-error" data-testid="offset-error">
          {offsetError}
        </div>
      ) : null}
    </header>
  );
}
