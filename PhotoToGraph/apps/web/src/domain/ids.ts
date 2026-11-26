/**
 * Stable identifier generation.
 *
 * IDs are random (not array indexes) so a node keeps its identity across
 * selection, camera movement, re-renders and future edits. The character set
 * matches the candidate contract identifier rule:
 * ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
 */

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createProducerInstanceId(): string {
  return `ptg-inst-${randomHex(8)}`;
}

export function createGraphId(): string {
  return `graph-${randomHex(8)}`;
}

export function createFrameId(): string {
  return `frame-${randomHex(8)}`;
}

export function createImageSourceId(): string {
  return `img-${randomHex(8)}`;
}

export function createNodeId(existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = `n-${randomHex(8)}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('无法生成唯一结点 ID');
}

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
