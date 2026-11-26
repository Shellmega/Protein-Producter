/**
 * Pointer -> canvas mapping.
 *
 * The ray must be built from the canvas CSS rectangle, not from window size:
 * the canvas is embedded in a layout with a sidebar, a header and a scrollable
 * page, and the device pixel ratio only affects the drawing buffer.
 */

import { isFiniteNumber } from './math';

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NdcPoint {
  x: number;
  y: number;
}

/**
 * Convert client (CSS) coordinates into normalized device coordinates.
 * Returns null when the rectangle is empty or any input is not finite.
 */
export function clientToNdc(clientX: number, clientY: number, rect: RectLike): NdcPoint | null {
  if (
    !isFiniteNumber(clientX) ||
    !isFiniteNumber(clientY) ||
    !isFiniteNumber(rect.left) ||
    !isFiniteNumber(rect.top) ||
    !isFiniteNumber(rect.width) ||
    !isFiniteNumber(rect.height) ||
    !(rect.width > 0) ||
    !(rect.height > 0)
  ) {
    return null;
  }
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -((clientY - rect.top) / rect.height) * 2 + 1,
  };
}

/** CSS pixels -> world units at a given depth (used by evidence/reporting). */
export function cssPixelsToSceneUnits(pixels: number, viewportHeightPx: number, fovDegrees: number, distance: number): number {
  const fovRadians = (fovDegrees * Math.PI) / 180;
  const worldPerPixel = (2 * distance * Math.tan(fovRadians / 2)) / viewportHeightPx;
  return pixels * worldPerPixel;
}
