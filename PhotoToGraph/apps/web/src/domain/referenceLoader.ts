/**
 * Reference-image decoding and load coordination.
 *
 * Decoding is asynchronous. A later file selection must win even if an earlier
 * decode finishes later; the coordinator token makes that deterministic. Only
 * the current request may commit into the store, and stale results are closed
 * (ImageBitmap.close) so temporary resources do not accumulate.
 */

import { counters } from '../diagnostics';

export class ReferenceDecodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReferenceDecodeError';
    this.code = code;
  }
}

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  mimeType: string;
  /** Original encoded bytes; the only persistable form of the resource. */
  bytes: Uint8Array;
}

const SUPPORTED_MIME = new Set(['image/png', 'image/jpeg']);

export function isSupportedImageMime(mime: string): boolean {
  return SUPPORTED_MIME.has(mime);
}

/** Shared decode options: EXIF orientation is applied exactly once per decode. */
const DECODE_OPTIONS: ImageBitmapOptions = {
  imageOrientation: 'from-image',
  premultiplyAlpha: 'none',
  colorSpaceConversion: 'default',
};

async function decodeBytes(bytes: Uint8Array, mimeType: string): Promise<ImageBitmap> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
  try {
    return await createImageBitmap(blob, DECODE_OPTIONS);
  } catch (error) {
    throw new ReferenceDecodeError(
      'DECODE_FAILED',
      `参考图解码失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Decode a local PNG/JPEG file into an orientation-corrected ImageBitmap.
 * `imageOrientation: 'from-image'` applies EXIF orientation before the bitmap
 * dimensions are read, so a rotated JPEG keeps its intended display size.
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  if (!isSupportedImageMime(file.type)) {
    throw new ReferenceDecodeError(
      'UNSUPPORTED_TYPE',
      `仅支持 PNG/JPEG 参考图，收到 ${file.type || '未知类型'}`,
    );
  }
  if (file.size === 0) {
    throw new ReferenceDecodeError('EMPTY_FILE', '参考图文件为空');
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new ReferenceDecodeError('EMPTY_FILE', '参考图文件为空');
  }
  const bitmap = await decodeBytes(bytes, file.type);

  if (!(bitmap.width > 0) || !(bitmap.height > 0)) {
    bitmap.close();
    throw new ReferenceDecodeError('DECODE_FAILED', '参考图解码后尺寸无效');
  }

  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    mimeType: file.type,
    bytes,
  };
}

/**
 * Restore path: decode stored original bytes with the same `from-image` policy.
 *
 * Because the stored bytes are the untouched originals and the policy is
 * applied once per decode, the restored orientation and size match the first
 * load (no double EXIF rotation). Callers must compare the decoded size with
 * the recorded intrinsic size and treat a mismatch as a resource failure.
 */
export async function decodeImageBytes(bytes: Uint8Array, mimeType: string): Promise<DecodedImage> {
  if (!isSupportedImageMime(mimeType)) {
    throw new ReferenceDecodeError('UNSUPPORTED_TYPE', `不支持的类型 ${mimeType || '未知'}，只接受 PNG/JPEG`);
  }
  if (bytes.byteLength === 0) {
    throw new ReferenceDecodeError('EMPTY_FILE', '本地参考图字节为空');
  }
  const bitmap = await decodeBytes(bytes, mimeType);
  if (!(bitmap.width > 0) || !(bitmap.height > 0)) {
    bitmap.close();
    throw new ReferenceDecodeError('DECODE_FAILED', '本地参考图解码后尺寸无效');
  }
  return { bitmap, width: bitmap.width, height: bitmap.height, mimeType, bytes };
}

export type LoadResult =
  | { status: 'committed'; decoded: DecodedImage }
  | { status: 'error'; error: Error }
  | { status: 'stale' };

export interface ReferenceLoadCoordinator {
  begin(): number;
  isCurrent(token: number): boolean;
  run(token: number, file: File): Promise<LoadResult>;
  currentToken(): number;
}

/**
 * Token based coordinator. The caller calls `begin()` for every selection and
 * passes the returned token to `run()`; a result whose token is no longer
 * current is reported as `stale` and its bitmap is closed.
 */
export function createReferenceLoadCoordinator(
  decode: (file: File) => Promise<DecodedImage> = decodeImageFile,
): ReferenceLoadCoordinator {
  let currentToken = 0;

  return {
    begin(): number {
      currentToken += 1;
      return currentToken;
    },
    isCurrent(token: number): boolean {
      return token === currentToken;
    },
    currentToken(): number {
      return currentToken;
    },
    async run(token: number, file: File): Promise<LoadResult> {
      counters.imageDecodeAttempts += 1;
      try {
        const decoded = await decode(file);
        counters.imageDecodeSuccesses += 1;
        if (token !== currentToken) {
          decoded.bitmap.close();
          counters.staleReferenceResults += 1;
          counters.bitmapsClosed += 1;
          return { status: 'stale' };
        }
        return { status: 'committed', decoded };
      } catch (error) {
        if (token !== currentToken) {
          counters.staleReferenceResults += 1;
          return { status: 'stale' };
        }
        counters.imageDecodeFailures += 1;
        return {
          status: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  };
}
