/**
 * Fetch transport for the frozen receiver.
 *
 * Hard rules:
 * - Only `Content-Type` (application/json) and `Idempotency-Key` are sent on a
 *   POST; no camera/image/local metadata ever leaves the page.
 * - A timeout is an UNKNOWN outcome. A missing HTTP status (fetch rejection)
 *   is classified `network_error` and likewise remains UNKNOWN: it is never
 *   reported as "not written", and a CORS failure is not diagnosed as one.
 * - Response headers are captured case-insensitively; cross-origin headers are
 *   only readable when the receiver exposes them (deployment requirement, not
 *   a wire-contract change).
 */

import type { HttpRequestSpec, HttpTransport, TransportOutcome } from './types';

export interface FetchTransportOptions {
  /** Injected for unit tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function createFetchTransport(options: FetchTransportOptions = {}): HttpTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      async request(): Promise<TransportOutcome> {
        return { kind: 'network_error', message: '当前运行环境没有 fetch。', duration_ms: 0 };
      },
    };
  }
  return {
    async request(spec: HttpRequestSpec): Promise<TransportOutcome> {
      const controller = new AbortController();
      const started = Date.now();
      let timedOut = false;
      let externallyAborted = false;
      const onExternalAbort = (): void => {
        externallyAborted = true;
        controller.abort();
      };
      if (spec.signal) {
        if (spec.signal.aborted) {
          return { kind: 'aborted', message: '本地等待已取消：结果未知。', duration_ms: 0 };
        }
        spec.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, spec.timeoutMs);
      try {
        const init: RequestInit = {
          method: spec.method,
          headers: spec.headers,
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
        };
        if (spec.body !== null) {
          init.body = spec.body as unknown as BodyInit;
        }
        const response = await fetchImpl(spec.url, init);
        const duration = Date.now() - started;
        let headers: Record<string, string> | null = null;
        try {
          headers = {};
          response.headers.forEach((value, key) => {
            headers![key.toLowerCase()] = value;
          });
        } catch {
          headers = null;
        }
        let bytes: Uint8Array | null = null;
        let text = '';
        try {
          const buffer = await response.arrayBuffer();
          bytes = new Uint8Array(buffer);
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            // Invalid UTF-8: keep raw bytes, but do not pretend it decoded.
            text = new TextDecoder('utf-8').decode(bytes);
          }
        } catch {
          bytes = null;
          text = '';
        }
        return { kind: 'response', response: { status: response.status, headers, bytes, text, duration_ms: duration } };
      } catch (error) {
        const duration = Date.now() - started;
        if (timedOut) {
          return {
            kind: 'timeout',
            message: `请求超时（${spec.timeoutMs} ms）：结果未知，不能判定服务端未写入。`,
            duration_ms: duration,
          };
        }
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            kind: 'aborted',
            message: externallyAborted ? '本地等待已取消：结果未知，不能宣称服务端回滚。' : '本地等待已取消：结果未知。',
            duration_ms: duration,
          };
        }
        return {
          kind: 'network_error',
          message: `网络层未返回 HTTP 状态（结果未知，可能是连接/浏览器策略问题，不能判定服务端未写入）：${describeError(error)}`,
          duration_ms: duration,
        };
      } finally {
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

/** Read-only low-level fetch for evidence/diagnostic tooling (never used by UI). */
export async function probeUrl(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TransportOutcome> {
  return createFetchTransport({ fetchImpl }).request({
    method: 'GET',
    url,
    headers: {},
    body: null,
    timeoutMs,
  });
}
