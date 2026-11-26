import { useState } from 'react';
import { usePtgStore } from '../domain/store';
import { exportSnapshotNow, redownloadLatestSnapshot, validateOnlyNow } from '../contract/exportSession';
import {
  overwriteBlockedRecord,
  persistenceStatus,
  restoreFromStorageNow,
  saveDraftNow,
  saveAsNewLocalGraph,
  startNewGraph,
} from '../persistence/session';

const SAVE_STATE_LABEL: Record<string, string> = {
  idle: '未保存',
  unsaved: '未保存',
  saving: '保存中…',
  saved: '已保存',
  failed: '保存失败',
  blocked: '本地存储不可用',
};

const BOOT_STATUS_LABEL: Record<string, string> = {
  pending: '正在检查本地草稿…',
  empty: '本地无草稿',
  restored: '已从本地恢复',
  blocked: '本地草稿不可恢复',
};

function formatTime(epochMs: number | null): string {
  if (epochMs === null || !Number.isFinite(epochMs)) {
    return '—';
  }
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function PersistencePanel() {
  const bootStatus = usePtgStore((state) => state.bootStatus);
  const saveState = usePtgStore((state) => state.saveState);
  const saveErrorCode = usePtgStore((state) => state.saveErrorCode);
  const saveMessage = usePtgStore((state) => state.saveMessage);
  const lastSavedRevision = usePtgStore((state) => state.lastSavedRevision);
  const lastSavedAt = usePtgStore((state) => state.lastSavedAt);
  const saveGeneration = usePtgStore((state) => state.saveGeneration);
  const revision = usePtgStore((state) => state.identity.revision);
  const graphId = usePtgStore((state) => state.identity.graph_id);
  const producerInstanceId = usePtgStore((state) => state.identity.producer_instance_id);
  const autosaveEnabled = usePtgStore((state) => state.autosaveEnabled);
  const storedRecord = usePtgStore((state) => state.storedRecord);
  const exportState = usePtgStore((state) => state.exportState);
  const selectNode = usePtgStore((state) => state.selectNode);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown> | unknown): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const issueNodeIds = exportState.nodeIds;
  const secondaryNodeIds = exportState.secondaryCode ? [] : [];
  const secret = persistenceStatus();

  return (
    <section className="ptg-panel" aria-label="本地草稿与快照" data-testid="persistence-panel">
      <h2 className="ptg-panel-title">本地草稿与快照</h2>

      <div className="ptg-status-line" data-testid="persistence-boot" data-state={bootStatus}>
        本地存储：{BOOT_STATUS_LABEL[bootStatus] ?? bootStatus}
        {storedRecord
          ? ` · 已存图 ${storedRecord.graphId} revision ${storedRecord.revision}`
          : ''}
      </div>

      <div
        className={`ptg-status-line ptg-save-state ptg-save-${saveState}`}
        data-testid="save-status"
        data-state={saveState}
        data-saved-revision={lastSavedRevision ?? ''}
      >
        保存状态：{SAVE_STATE_LABEL[saveState] ?? saveState}
        {lastSavedRevision !== null ? ` · 已保存 revision ${lastSavedRevision}` : ''}
        {' · '}当前 revision {revision}
      </div>

      <div className="ptg-row">
        <button
          type="button"
          className="ptg-button ptg-button-primary"
          data-testid="save-now"
          disabled={busy || saveState === 'saving' || bootStatus === 'blocked'}
          onClick={() => void run(() => saveDraftNow('manual'))}
        >
          立即保存
        </button>
        <button
          type="button"
          className="ptg-button"
          data-testid="restore-now"
          disabled={busy}
          onClick={() => void run(() => restoreFromStorageNow())}
        >
          恢复已保存草稿
        </button>
        <button
          type="button"
          className="ptg-button"
          data-testid="new-graph"
          disabled={busy}
          onClick={() => void run(async () => {
            startNewGraph();
            await saveAsNewLocalGraph();
          })}
        >
          新建图并保存
        </button>
      </div>

      <div className="ptg-row">
        <label className="ptg-field ptg-field-inline">
          <input
            type="checkbox"
            data-testid="autosave-toggle"
            checked={autosaveEnabled}
            onChange={(event) => usePtgStore.getState().setAutosaveEnabled(event.target.checked)}
          />
          <span>自动保存（本机同 Origin 草稿槽）</span>
        </label>
      </div>

      {saveState === 'failed' && saveErrorCode ? (
        <div className="ptg-inline-error" data-testid="save-error">
          <strong data-testid="save-error-code">{saveErrorCode}</strong> {saveMessage}
          <div className="ptg-row">
            <button
              type="button"
              className="ptg-button"
              data-testid="retry-save"
              disabled={busy}
              onClick={() => void run(() => saveDraftNow('manual'))}
            >
              重试保存
            </button>
          </div>
        </div>
      ) : null}

      {bootStatus === 'blocked' ? (
        <div className="ptg-inline-error" data-testid="boot-error">
          <strong data-testid="boot-error-code">{saveErrorCode}</strong> {saveMessage}
          <div className="ptg-row">
            <button
              type="button"
              className="ptg-button"
              data-testid="overwrite-blocked-record"
              disabled={busy}
              onClick={() => void run(() => overwriteBlockedRecord())}
            >
              用当前图覆盖该记录
            </button>
            <button
              type="button"
              className="ptg-button"
              data-testid="retry-restore"
              disabled={busy}
              onClick={() => void run(() => restoreFromStorageNow())}
            >
              重新读取
            </button>
          </div>
        </div>
      ) : null}

      <dl className="ptg-kv ptg-persistence-meta" data-testid="persistence-meta">
        <dt>producer 实例</dt>
        <dd className="ptg-mono" data-testid="producer-instance-id">{producerInstanceId}</dd>
        <dt>图标识</dt>
        <dd className="ptg-mono" data-testid="persistence-graph-id">{graphId}</dd>
        <dt>保存代次</dt>
        <dd data-testid="save-generation">{saveGeneration}</dd>
        <dt>已保存于</dt>
        <dd data-testid="last-saved-at">{formatTime(lastSavedAt ?? storedRecord?.savedAt ?? null)}</dd>
        <dt>存储实现</dt>
        <dd data-testid="persistence-repository">{secret.repository ?? '不可用'}</dd>
      </dl>

      <h3 className="ptg-subtitle">冻结快照与 JSON 下载</h3>
      <div className="ptg-row">
        <button
          type="button"
          className="ptg-button ptg-button-primary"
          data-testid="validate-draft"
          disabled={busy}
          onClick={() => run(() => validateOnlyNow())}
        >
          校验当前图
        </button>
        <button
          type="button"
          className="ptg-button"
          data-testid="export-snapshot"
          disabled={busy}
          onClick={() => void run(() => exportSnapshotNow())}
        >
          生成快照并下载 JSON
        </button>
        <button
          type="button"
          className="ptg-button"
          data-testid="redownload-snapshot"
          disabled={busy || exportState.snapshotId === null}
          onClick={() => run(() => redownloadLatestSnapshot())}
        >
          重新下载原快照
        </button>
      </div>

      <div
        className="ptg-status-line"
        data-testid="export-status"
        data-state={exportState.status}
      >
        导出：{exportState.status === 'ok' ? '已生成快照并下载（未发送）' : exportState.status === 'valid' ? '校验通过（尚未生成快照）' : exportState.status === 'blocked' ? '已阻止' : '未执行'}
      </div>

      {exportState.status === 'blocked' ? (
        <div className="ptg-inline-error" data-testid="export-error">
          <div>
            <strong data-testid="export-error-code">{exportState.code}</strong>{' '}
            <span data-testid="export-error-field">定位 {exportState.field ?? '$'}</span>
          </div>
          <div data-testid="export-error-message">{exportState.message}</div>
          {exportState.secondaryCode ? (
            <div data-testid="export-error-secondary">
              次要诊断 <strong>{exportState.secondaryCode}</strong>{' '}
              <span>{exportState.secondaryField ?? ''}</span>
              {exportState.secondaryMessage ? <div>{exportState.secondaryMessage}</div> : null}
            </div>
          ) : null}
          {issueNodeIds.length > 0 || secondaryNodeIds.length > 0 ? (
            <div className="ptg-row">
              {issueNodeIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="ptg-button"
                  data-testid={`select-issue-node-${id}`}
                  onClick={() => selectNode(id)}
                >
                  选择问题结点 {id}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {exportState.status === 'ok' && exportState.snapshotId ? (
        <dl className="ptg-kv" data-testid="snapshot-meta">
          <dt>快照标识（wire 外）</dt>
          <dd className="ptg-mono" data-testid="snapshot-id">{exportState.snapshotId}</dd>
          <dt>下载文件</dt>
          <dd className="ptg-mono" data-testid="snapshot-file">{exportState.fileName ?? '—'}</dd>
          <dt>UTF-8 字节</dt>
          <dd data-testid="snapshot-bytes">{exportState.snapshotBytes ?? '—'}</dd>
          <dt>SHA-256</dt>
          <dd className="ptg-mono" data-testid="snapshot-sha256">{exportState.snapshotSha256 ?? '—'}</dd>
        </dl>
      ) : null}

      <p className="ptg-note">
        保存/恢复、校验、导出与相机变化都不改变 graph revision；只有实际图编辑一次 +1。
        本地草稿绑定当前 Origin（不同端口不共享）。JSON 下载只含 schema 字段，不含相机、工作平面、历史或图片字节；
        没有发送动作，界面不会显示“已送达”。
      </p>
    </section>
  );
}
