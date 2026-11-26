import { usePtgStore } from '../domain/store';
import { planeLabel } from '../spatial/planes';

/** In-canvas overlay: current mode / plane / offset / revision. */
export function ViewportOverlay() {
  const mode = usePtgStore((state) => state.mode);
  const planeKind = usePtgStore((state) => state.planeKind);
  const planeOffsets = usePtgStore((state) => state.planeOffsets);
  const revision = usePtgStore((state) => state.identity.revision);
  const constraint = usePtgStore(state => state.dragConstraint);

  return (
    <div className="ptg-overlay" data-testid="viewport-overlay">
      <div>
        <span className="ptg-overlay-label">模式</span> {{ create: '建点', select: '选择', connect: '连线', move: '移动' }[mode]}
      </div>
      {mode === 'move' ? <div data-testid="constraint-overlay"><span className="ptg-overlay-label">图坐标约束</span> {constraint}</div> : null}
      <div>
        <span className="ptg-overlay-label">平面</span> {planeLabel(planeKind)}
      </div>
      <div>
        <span className="ptg-overlay-label">偏移</span>{' '}
        {planeKind === 'reference' ? '参考图摆放' : planeOffsets[planeKind]}
      </div>
      <div>
        <span className="ptg-overlay-label">revision</span> {revision}
      </div>
      <div className="ptg-overlay-help">拖动 = 相机；滚轮 = 缩放；单击 = 建点/选择</div>
    </div>
  );
}
