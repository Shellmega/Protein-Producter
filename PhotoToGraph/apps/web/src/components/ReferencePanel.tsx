import { useCallback, useEffect, useRef, useState } from 'react';
import { usePtgStore, createReferenceSourceId } from '../domain/store';
import { createReferenceLoadCoordinator } from '../domain/referenceLoader';
import { formatVec3 } from '../spatial/math';
import {
  MAX_REFERENCE_SCALE,
  MIN_REFERENCE_SCALE,
  defaultReferencePose,
  imagePlaneSize,
  type ReferencePose,
} from '../spatial/referenceImage';

function parseFiniteNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

interface PoseDraft {
  px: string;
  py: string;
  pz: string;
  rx: string;
  ry: string;
  rz: string;
  scale: string;
}

function poseToDraft(pose: ReferencePose): PoseDraft {
  return {
    px: String(pose.position[0]),
    py: String(pose.position[1]),
    pz: String(pose.position[2]),
    rx: String(pose.rotationDeg[0]),
    ry: String(pose.rotationDeg[1]),
    rz: String(pose.rotationDeg[2]),
    scale: String(pose.scale),
  };
}

function draftToPose(draft: PoseDraft): ReferencePose | null {
  const px = parseFiniteNumber(draft.px);
  const py = parseFiniteNumber(draft.py);
  const pz = parseFiniteNumber(draft.pz);
  const rx = parseFiniteNumber(draft.rx);
  const ry = parseFiniteNumber(draft.ry);
  const rz = parseFiniteNumber(draft.rz);
  const scale = parseFiniteNumber(draft.scale);
  if ([px, py, pz, rx, ry, rz, scale].some((value) => value === null)) {
    return null;
  }
  return {
    position: [px as number, py as number, pz as number],
    rotationDeg: [rx as number, ry as number, rz as number],
    scale: scale as number,
  };
}

export function ReferencePanel() {
  const reference = usePtgStore((state) => state.reference);
  const referenceLoading = usePtgStore((state) => state.referenceLoading);
  const referenceError = usePtgStore((state) => state.referenceError);
  const planeKind = usePtgStore((state) => state.planeKind);
  const setReferencePose = usePtgStore((state) => state.setReferencePose);
  const removeReference = usePtgStore((state) => state.removeReference);
  const requestFocusReference = usePtgStore((state) => state.requestFocusReference);

  const coordinatorRef = useRef(createReferenceLoadCoordinator());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [poseError, setPoseError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PoseDraft>(() => poseToDraft(defaultReferencePose()));

  useEffect(() => {
    if (reference) {
      setDraft(poseToDraft(reference.pose));
    }
  }, [reference?.sourceId, reference?.pose]);

  const handleFile = useCallback(async (file: File) => {
    const coordinator = coordinatorRef.current;
    const token = coordinator.begin();
    const store = usePtgStore.getState();
    store.beginReferenceLoad(token);
    const result = await coordinator.run(token, file);
    if (result.status === 'stale') {
      return;
    }
    if (result.status === 'error') {
      usePtgStore.getState().failReference(token, result.error.message);
      return;
    }
    usePtgStore.getState().commitReference(token, {
      sourceId: createReferenceSourceId(),
      fileName: file.name,
      mimeType: result.decoded.mimeType,
      intrinsicWidth: result.decoded.width,
      intrinsicHeight: result.decoded.height,
      bitmap: result.decoded.bitmap,
      bytes: result.decoded.bytes,
    });
  }, []);

  const applyPose = () => {
    const pose = draftToPose(draft);
    if (!pose) {
      setPoseError('参考图摆放必须是 7 个有限数（位置 3、旋转 3、尺度 1）；已保留原摆放。');
      return;
    }
    const ok = setReferencePose(pose);
    setPoseError(ok ? null : '参考图摆放无效；已保留原摆放。');
  };

  const update = (key: keyof PoseDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setPoseError(null);
  };

  const size = reference
    ? imagePlaneSize(reference.intrinsicWidth, reference.intrinsicHeight, reference.baseWidth)
    : null;

  return (
    <section className="ptg-panel" aria-label="参考图">
      <h2 className="ptg-panel-title">参考图片</h2>

      <div className="ptg-row">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg"
          data-testid="reference-file-input"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) {
              void handleFile(file);
            }
          }}
        />
        <button
          type="button"
          className="ptg-button ptg-button-primary"
          data-testid="reference-choose"
          onClick={() => fileInputRef.current?.click()}
        >
          选择 PNG/JPEG 参考图
        </button>
        {reference ? (
          <button
            type="button"
            className="ptg-button"
            data-testid="reference-remove"
            onClick={removeReference}
          >
            移除参考图
          </button>
        ) : null}
      </div>

      <div className="ptg-status-line" data-testid="reference-status">
        状态：
        {referenceLoading
          ? '解码中…'
          : reference
            ? '已就绪（方向校正后显示）'
            : '空白（未加载参考图）'}
      </div>

      {reference ? (
        <dl className="ptg-kv" data-testid="reference-meta">
          <dt>文件</dt>
          <dd data-testid="reference-file-name">{reference.fileName}</dd>
          <dt>类型</dt>
          <dd>{reference.mimeType}</dd>
          <dt>解码尺寸</dt>
          <dd data-testid="reference-size">
            {reference.intrinsicWidth} × {reference.intrinsicHeight} px
          </dd>
          <dt>长宽比</dt>
          <dd data-testid="reference-aspect">
            {(reference.intrinsicWidth / reference.intrinsicHeight).toFixed(6)}
          </dd>
          <dt>来源 ID</dt>
          <dd data-testid="reference-source-id">{reference.sourceId}</dd>
          <dt>显示尺寸</dt>
          <dd>
            {size
              ? `${(size.width * reference.pose.scale).toFixed(4)} × ${(
                  size.height * reference.pose.scale
                ).toFixed(4)} scene_unit`
              : '—'}
          </dd>
          <dt>平面中心</dt>
          <dd>{formatVec3(reference.pose.position, 4)}</dd>
        </dl>
      ) : null}

      {referenceError ? (
        <div className="ptg-inline-error" data-testid="reference-error">
          {referenceError}
        </div>
      ) : null}

      <div className="ptg-pose-grid">
        <label className="ptg-field">
          <span>位置 X</span>
          <input
            className="ptg-input"
            data-testid="ref-pos-x"
            value={draft.px}
            onChange={(event) => update('px', event.target.value)}
          />
        </label>
        <label className="ptg-field">
          <span>位置 Y</span>
          <input
            className="ptg-input"
            data-testid="ref-pos-y"
            value={draft.py}
            onChange={(event) => update('py', event.target.value)}
          />
        </label>
        <label className="ptg-field">
          <span>位置 Z</span>
          <input
            className="ptg-input"
            data-testid="ref-pos-z"
            value={draft.pz}
            onChange={(event) => update('pz', event.target.value)}
          />
        </label>
        <label className="ptg-field">
          <span>旋转 X°</span>
          <input
            className="ptg-input"
            data-testid="ref-rot-x"
            value={draft.rx}
            onChange={(event) => update('rx', event.target.value)}
          />
        </label>
        <label className="ptg-field">
          <span>旋转 Y°</span>
          <input
            className="ptg-input"
            data-testid="ref-rot-y"
            value={draft.ry}
            onChange={(event) => update('ry', event.target.value)}
          />
        </label>
        <label className="ptg-field">
          <span>旋转 Z°</span>
          <input
            className="ptg-input"
            data-testid="ref-rot-z"
            value={draft.rz}
            onChange={(event) => update('rz', event.target.value)}
          />
        </label>
        <label className="ptg-field">
          <span>
            尺度 {MIN_REFERENCE_SCALE}–{MAX_REFERENCE_SCALE}
          </span>
          <input
            className="ptg-input"
            data-testid="ref-scale"
            value={draft.scale}
            onChange={(event) => update('scale', event.target.value)}
          />
        </label>
      </div>

      <div className="ptg-row">
        <button
          type="button"
          className="ptg-button"
          data-testid="ref-pose-apply"
          onClick={applyPose}
          disabled={!reference}
        >
          应用摆放
        </button>
        <button
          type="button"
          className="ptg-button"
          data-testid="reference-focus"
          onClick={requestFocusReference}
          disabled={!reference}
        >
          视图对准参考图
        </button>
        <span className="ptg-hint">
          建点平面：{planeKind === 'reference' ? '参考图平面' : planeKind.toUpperCase()}
        </span>
      </div>
      {poseError ? (
        <div className="ptg-inline-error" data-testid="ref-pose-error">
          {poseError}
        </div>
      ) : null}
      <p className="ptg-note">
        参考图仅作为场景参考，不执行图像自动识点。摆放属于编辑器状态，不改变已有结点与 revision；
        来源 ID 集合的增删才改变 revision。
      </p>
    </section>
  );
}
