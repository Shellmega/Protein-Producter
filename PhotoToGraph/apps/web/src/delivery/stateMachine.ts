/**
 * Frozen delivery state machine and retry policy (spec §7.6 /
 * protocol_cases.json retry_policy).
 *
 * Pure functions only: the session layer owns persistence and network I/O.
 */

import {
  AUTOMATIC_ATTEMPTS_MAX,
  BACKOFF_CAP_SECONDS,
  BACKOFF_SECONDS,
  type DeliveryWireState,
} from './types';

export type RetryAfterParse =
  | { kind: 'delta'; ms: number; raw: string }
  | { kind: 'date'; ms: number; raw: string }
  | { kind: 'invalid'; reason: string; raw: string }
  | { kind: 'absent' };

/**
 * Parse Retry-After: non-negative decimal seconds (possibly fractional) or an
 * HTTP-date. A past date is expired (caller falls back to exponential
 * backoff). Long valid values are NOT clamped to the 30 s backoff cap.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): RetryAfterParse {
  if (value === null || value === undefined) return { kind: 'absent' };
  const raw = value.trim();
  if (raw === '') return { kind: 'invalid', reason: '空值', raw };
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return { kind: 'invalid', reason: '非有限数值', raw };
    return { kind: 'delta', ms: Math.round(seconds * 1000), raw };
  }
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return { kind: 'invalid', reason: '既不是秒数也不是 HTTP-date', raw };
  if (timestamp <= now) return { kind: 'invalid', reason: 'HTTP-date 已过期', raw };
  return { kind: 'date', ms: timestamp - now, raw };
}

/** Delay before automatic attempt number `cycleAutomatic` (0-based). */
export function backoffDelayMs(cycleAutomatic: number): number {
  const index = Math.min(Math.max(0, cycleAutomatic), BACKOFF_SECONDS.length - 1);
  return Math.min(BACKOFF_SECONDS[index], BACKOFF_CAP_SECONDS) * 1000;
}

export interface NextAttemptInput {
  now: number;
  cycleAutomatic: number;
  retryAfter: RetryAfterParse;
}

/** `Retry-After` wins when valid; otherwise frozen exponential backoff. */
export function computeNextAttemptAt(input: NextAttemptInput): { at: number; reason: 'retry_after' | 'backoff' } {
  if (input.retryAfter.kind === 'delta' || input.retryAfter.kind === 'date') {
    return { at: input.now + input.retryAfter.ms, reason: 'retry_after' };
  }
  return { at: input.now + backoffDelayMs(input.cycleAutomatic), reason: 'backoff' };
}

/** True while another automatic attempt is still allowed in this cycle. */
export function automaticBudgetLeft(cycleAutomatic: number): boolean {
  return cycleAutomatic < AUTOMATIC_ATTEMPTS_MAX;
}

export type TransitionReason =
  | 'user_submit'
  | 'manual_retry'
  | 'automatic_retry'
  | 'http_201_200'
  | 'http_4xx'
  | 'http_500'
  | 'http_503_429'
  | 'network_or_timeout'
  | 'invalid_response'
  | 'get_reconcile_ok'
  | 'get_mismatch'
  | 'abort'
  | 'boot_unknown'
  | 'diagnostic';

/**
 * Monotonic transition gate. `confirmed` and `rejected` only move again for an
 * explicit user retry (same frozen key+bytes); `confirmed` is never downgraded.
 */
export function canTransition(
  from: DeliveryWireState,
  to: DeliveryWireState,
  reason: TransitionReason,
): boolean {
  if (from === to) return true;
  switch (from) {
    case 'idle':
      return to === 'submitting' && reason === 'user_submit';
    case 'submitting':
      if (to === 'confirmed' || to === 'rejected' || to === 'pending_reconcile') return true;
      return to === 'submitting' && reason === 'automatic_retry';
    case 'pending_reconcile':
      if (to === 'submitting') {
        return reason === 'manual_retry' || reason === 'automatic_retry' || reason === 'boot_unknown';
      }
      return to === 'confirmed' || to === 'pending_reconcile' || to === 'rejected';
    case 'rejected':
      // Explicit retry is only meaningful for the frozen "500 / manual" path;
      // the session checks the stored error code before calling this.
      return (to === 'submitting' && reason === 'manual_retry') || to === 'rejected';
    case 'confirmed':
      // Never downgraded. Confirmation may record a new verified receipt.
      return to === 'confirmed';
    default:
      return false;
  }
}

export type HttpClass =
  | { kind: 'success'; state: 'confirmed' }
  | { kind: 'rejected'; state: 'rejected' }
  | { kind: 'server_failed'; state: 'rejected' }
  | { kind: 'transient'; state: 'pending_reconcile' }
  | { kind: 'unknown'; state: 'pending_reconcile' };

/** Frozen HTTP classification (500 is a definite failure, not auto-retried). */
export function classifyHttpStatus(status: number): HttpClass {
  if (status === 201 || status === 200) return { kind: 'success', state: 'confirmed' };
  if ([400, 404, 409, 413, 415, 422].includes(status)) return { kind: 'rejected', state: 'rejected' };
  if (status === 500) return { kind: 'server_failed', state: 'rejected' };
  if (status === 503 || status === 429) return { kind: 'transient', state: 'pending_reconcile' };
  return { kind: 'unknown', state: 'pending_reconcile' };
}

/** Whether a rejected result allows a same-key/same-bytes manual retry. */
export function manualRetryAllowed(state: DeliveryWireState, errorCode: string | null): boolean {
  if (state === 'pending_reconcile') return true;
  if (state === 'rejected') {
    // 500 STORAGE_FAILURE / INTERNAL_ERROR: explicit retry with original key+bytes.
    return errorCode === 'STORAGE_FAILURE' || errorCode === 'INTERNAL_ERROR';
  }
  return false;
}
