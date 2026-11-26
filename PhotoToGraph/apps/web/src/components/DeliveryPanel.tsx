import { useEffect, useState, useSyncExternalStore } from 'react';
import { usePtgStore } from '../domain/store';
import {
  cancelLocalWait,
  configureDeliveryTarget,
  getDeliveryStatus,
  reconcileSubmission,
  refreshDeliveryRecords,
  retrySubmission,
  sendCurrentGraph,
  subscribeDelivery,
  type DeliveryOutcome,
} from '../delivery/session';
import type { SubmissionView } from '../delivery/types';

const STATE_LABEL: Record<string, string> = {
  idle: '未发送',
  submitting: '提交中',
  confirmed: '已确认接收',
  rejected: '已拒绝',
  pending_reconcile: '结果待确认',
};

const PHASE_HINT: Record<string, string> = {
  queued: '已落盘，等待发送',
  sending: '请求发送中（结果未知前不宣称送达）',
  waiting_retry: '等待自动重试',
  verifying: '正在用 GET 核对',
  confirmed: '已确认',
  rejected: '接收端拒绝（不自动重试）',
  needs_attention: '需要人工核对/重试',
  unknown: '结果未知',
};

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const date = new Date(parsed);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatCountdown(at: number | null): string {
  if (at === null) return '—';
  const delta = Math.max(0, at - Date.now());
  if (delta === 0) return '即将';
  return `${Math.ceil(delta / 1000)}s`;
}

function targetModeLabel(mode: 'live' | 'mock'): string {
  return mode === 'mock' ? '测试替身（模拟接收）' : '真实 GTP';
}

function SubmissionCard({ view }: { view: SubmissionView }) {
  const currentGraphId = usePtgStore((state) => state.identity.graph_id);
  const currentRevision = usePtgStore((state) => state.identity.revision);
  const currentNodes = usePtgStore((state) => state.content.nodes);
  const selectNode = usePtgStore((state) => state.selectNode);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const error = view.error;
  const nodeIdsUsable =
    error !== null &&
    error.node_ids.length > 0 &&
    view.graph_id === currentGraphId &&
    view.revision === currentRevision;
  const knownIds = new Set(currentNodes.map((node) => node.id));
  const simulated =
    view.transport_label === 'simulated' || view.target.mode === 'mock' || view.receipt?.transport_label === 'simulated';

  let confirmAllowed = false;
  if (view.state === 'pending_reconcile' || view.state === 'idle') confirmAllowed = true;
  if (view.state === 'rejected') {
    confirmAllowed = view.error?.source === 'wire' && (view.error.code === 'STORAGE_FAILURE' || view.error.code === 'INTERNAL_ERROR');
  }

  return (
    <li className="ptg-delivery-item" data-testid={`delivery-item-${view.revision}`} data-state={view.state} data-phase={view.phase}>
      <div className="ptg-delivery-head">
        <strong>revision {view.revision}</strong>
        <span className="ptg-delivery-state" data-testid={`delivery-state-${view.revision}`}>
          {STATE_LABEL[view.state] ?? view.state}
          {view.state !== 'confirmed' ? ` · ${PHASE_HINT[view.phase] ?? view.phase}` : ''}
        </span>
        {simulated ? (
          <span className="ptg-delivery-mock" data-testid={`delivery-mock-label-${view.revision}`}>
            模拟接收（本地替身，非真实 GTP）
          </span>
        ) : null}
      </div>

      <dl className="ptg-kv ptg-delivery-meta">
        <dt>import_id</dt>
        <dd className="ptg-mono" data-testid={`delivery-import-id-${view.revision}`}>{view.import_id ?? '—'}</dd>
        <dt>目标</dt>
        <dd className="ptg-mono" data-testid={`delivery-target-${view.revision}`}>{view.target.base_url}（{targetModeLabel(view.target.mode)}）</dd>
        <dt>幂等键</dt>
        <dd className="ptg-mono" data-testid={`delivery-key-${view.revision}`}>{view.idempotency_key}</dd>
        <dt>快照字节 / SHA-256</dt>
        <dd className="ptg-mono" data-testid={`delivery-bytes-${view.revision}`}>
          {view.snapshot.byte_length} B · {view.snapshot.sha256.slice(0, 16)}…
        </dd>
        <dt>尝试</dt>
        <dd data-testid={`delivery-attempts-${view.revision}`}>
          初次 {view.attempts.initial_sends} · 人工 {view.attempts.manual_retries} · 自动 {view.attempts.automatic}
          {view.attempts.exhausted ? ' · 自动预算耗尽' : ''}
          {view.attempts.next_attempt_at ? ` · 下次 ${formatCountdown(view.attempts.next_attempt_at)}` : ''}
        </dd>
        <dt>最近更新</dt>
        <dd>{formatTime(view.updated_at)}</dd>
      </dl>

      {view.receipt ? (
        <div className="ptg-delivery-receipt" data-testid={`delivery-receipt-${view.revision}`}>
          回执：状态 <span className="ptg-mono">{view.receipt.receipt.status}</span> · 结点 {view.receipt.receipt.node_count} · 无向边{' '}
          {view.receipt.receipt.edge_count} · HTTP {view.receipt.http_status} ·{' '}
          {view.receipt.verified_by_get ? `GET 已复核 ${formatTime(view.receipt.verified_at)}` : '尚未 GET 复核'}
          <div className="ptg-note">
            “图已接收，待 GTP 配置”——不等于条件就绪或生成成功。
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="ptg-inline-error" data-testid={`delivery-error-${view.revision}`} data-source={error.source}>
          <div>
            <strong data-testid={`delivery-error-code-${view.revision}`}>{error.code}</strong>{' '}
            <span data-testid={`delivery-error-field-${view.revision}`}>定位 {error.field ?? '$'}</span>
            {error.http_status !== null ? <span> · HTTP {error.http_status}</span> : null}
            {error.source === 'local' ? <span> · 本地诊断（非服务错误码）</span> : null}
          </div>
          <div data-testid={`delivery-error-message-${view.revision}`}>{error.message}</div>
          {nodeIdsUsable ? (
            <div className="ptg-row">
              {error.node_ids
                .filter((id) => knownIds.has(id))
                .map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="ptg-button"
                    data-testid={`delivery-select-node-${view.revision}-${id}`}
                    onClick={() => selectNode(id)}
                  >
                    选择问题结点 {id}
                  </button>
                ))}
            </div>
          ) : error.node_ids.length > 0 ? (
            <div className="ptg-note" data-testid={`delivery-error-stale-${view.revision}`}>
              该错误指向 revision {view.revision} 的快照，不套用到当前图（当前 revision {currentRevision}）。
            </div>
          ) : null}
        </div>
      ) : null}

      {view.verification.last_result && view.verification.last_result !== 'equivalent' ? (
        <div className="ptg-note" data-testid={`delivery-verification-${view.revision}`}>
          GET 核对：{view.verification.last_result} · {view.verification.local_code ?? '—'} · {view.verification.message ?? ''}
        </div>
      ) : null}

      <div className="ptg-row">
        <button
          type="button"
          className="ptg-button"
          data-testid={`delivery-retry-${view.revision}`}
          disabled={busy || !confirmAllowed}
          onClick={() => void run(() => retrySubmission(view.submission_id))}
        >
          {view.state === 'rejected' ? '显式重试（原键原字节）' : '立即重试'}
        </button>
        <button
          type="button"
          className="ptg-button"
          data-testid={`delivery-reconcile-${view.revision}`}
          disabled={busy || view.import_id === null}
          onClick={() => void run(() => reconcileSubmission(view.submission_id))}
        >
          GET 核对
        </button>
        <button
          type="button"
          className="ptg-button"
          data-testid={`delivery-cancel-${view.revision}`}
          disabled={!busy && view.phase !== 'sending'}
          onClick={() => cancelLocalWait(view.submission_id)}
        >
          取消本地等待
        </button>
      </div>
    </li>
  );
}
export function DeliveryPanel() {
  const status = useSyncExternalStore(subscribeDelivery, getDeliveryStatus, getDeliveryStatus);
  const [baseUrl, setBaseUrl] = useState(status.target?.base_url ?? 'http://127.0.0.1:18000');
  const [mode, setMode] = useState<'live' | 'mock'>(status.target?.mode ?? 'mock');
  const [targetMessage, setTargetMessage] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DeliveryOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Same-origin second page: converge on persisted state without claiming
    // anything the record does not say. Only terminal/queued states trigger a
    // read; an in-flight local attempt owns its record.
    const timer = setInterval(() => {
      void refreshDeliveryRecords();
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (status.target) {
      setBaseUrl(status.target.base_url);
      setMode(status.target.mode);
    }
  }, [status.target?.base_url, status.target?.mode]);

  const confirmations = status.records.filter((record) => record.state === 'confirmed');
  const currentGraph = usePtgStore((state) => state.identity.graph_id);
  const graphRecords = status.records.filter((record) => record.graph_id === currentGraph);

  const run = async (action: () => Promise<DeliveryOutcome>): Promise<void> => {
    setBusy(true);
    try {
      setOutcome(await action());
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ptg-panel" aria-label="接口发送与回执" data-testid="delivery-panel">
      <h2 className="ptg-panel-title">接口发送与回执（PTG-4）</h2>

      <div className="ptg-status-line" data-testid="delivery-boot" data-state={status.bootStatus}>
        提交记录存储：{status.bootStatus === 'ready' ? '已就绪' : status.bootStatus === 'blocked' ? '不可用（发送已阻止）' : '正在检查…'}
        {status.storage ? ` · ${status.storage}` : ''}
        {status.invalidRecords.length > 0 ? ` · ${status.invalidRecords.length} 条损坏记录原样保留` : ''}
      </div>
      {status.storageMessage ? (
        <div className="ptg-inline-error" data-testid="delivery-storage-error">
          {status.storageMessage}
        </div>
      ) : null}

      <div
        className="ptg-status-line"
        data-testid="delivery-revisions"
        data-current-revision={status.currentRevision}
        data-confirmed-revisions={confirmations.map((record) => record.revision).join(',')}
      >
        当前编辑 revision {status.currentRevision}；已确认送达{' '}
        {confirmations.length === 0
          ? '无'
          : confirmations.map((record) => `r${record.revision}（${record.import_id ?? '—'}）`).join('、')}
        {status.origin ? ` · 页面 Origin ${status.origin}` : ''}
      </div>

      <div className="ptg-row">
        <label className="ptg-field ptg-field-inline">
          <span>接收基址</span>
          <input
            type="text"
            className="ptg-input ptg-mono"
            data-testid="delivery-target-input"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="ptg-field ptg-field-inline">
          <span>模式</span>
          <select
            className="ptg-input"
            data-testid="delivery-target-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value === 'mock' ? 'mock' : 'live')}
          >
            <option value="mock">测试替身（模拟接收）</option>
            <option value="live">真实 GTP</option>
          </select>
        </label>
        <button
          type="button"
          className="ptg-button"
          data-testid="delivery-target-save"
          onClick={() => {
            const result = configureDeliveryTarget(baseUrl, mode);
            setTargetMessage(result.message);
            setOutcome(result);
          }}
        >
          保存目标
        </button>
      </div>
      <div className="ptg-status-line" data-testid="delivery-target-current" data-mode={status.target?.mode ?? 'none'}>
        当前目标：{status.target ? `${status.target.base_url}（${targetModeLabel(status.target.mode)}）` : '未设置'}
        {targetMessage ? ` · ${targetMessage}` : ''}
      </div>
      {status.target?.mode === 'mock' ? (
        <div className="ptg-delivery-mock-banner" data-testid="delivery-mock-banner">
          当前为本地 HTTP 替身模式：界面与回执均标注“模拟接收”，绝不冒充真实 GTP；替身不会由产品入口自动启动。
        </div>
      ) : null}

      <div className="ptg-row">
        <button
          type="button"
          className="ptg-button ptg-button-primary"
          data-testid="delivery-send"
          disabled={busy || status.bootStatus !== 'ready' || status.target === null}
          onClick={() => void run(() => sendCurrentGraph())}
        >
          发送当前图快照
        </button>
      </div>

      {outcome ? (
        <div
          className="ptg-status-line"
          data-testid="delivery-outcome"
          data-ok={outcome.ok ? 'true' : 'false'}
          data-code={outcome.code ?? ''}
        >
          {outcome.ok ? '已执行' : '未执行'}{outcome.code ? `：${outcome.code}` : ''} {outcome.message ?? ''}
        </div>
      ) : null}

      {graphRecords.length === 0 ? (
        <p className="ptg-note" data-testid="delivery-empty">
          当前图还没有发送记录。发送前会先校验并冻结快照，再原子落盘提交记录，最后才发 HTTP 请求。
        </p>
      ) : (
        <ul className="ptg-delivery-list" data-testid="delivery-list">
          {graphRecords.map((view) => (
            <SubmissionCard key={view.submission_id} view={view} />
          ))}
        </ul>
      )}

      {status.invalidRecords.length > 0 ? (
        <div className="ptg-inline-error" data-testid="delivery-invalid-records">
          检测到 {status.invalidRecords.length} 条损坏/未知版本的提交记录，已原样保留并阻止错误发送：
          {status.invalidRecords.map((record) => (
            <div key={`${record.submission_id ?? 'unknown'}-${record.field}`} className="ptg-mono">
              {record.submission_id ?? '(unknown)'} · {record.code} · {record.field} · {record.message}
            </div>
          ))}
        </div>
      ) : null}

      <p className="ptg-note">
        只有 201/200 + 完整回执才显示“已确认接收”；4xx/500 不自动重试；网络错误/超时/503/429 用原键原字节按冻结退避重试（最多 5 次自动）。
        发送、回执、重试与 GET 核对都不改变图 revision 或撤销历史。
      </p>
    </section>
  );
}
