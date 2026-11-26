/**
 * Runtime diagnostics for the PTG-1 author evidence.
 *
 * This module only holds counters and read-only handles to the live camera /
 * canvas. The graph state itself lives in the Zustand store; the window hook
 * that exposes a snapshot is installed in `src/windowApi.ts`.
 *
 * Nothing here is part of the graph contract and nothing here is exported to
 * GTP. It exists so that the evidence run can read exact binary64 values and
 * verify camera isolation / resource cleanup without state injection.
 */

export interface DiagnosticsCounters {
  sceneMounts: number;
  sceneUnmounts: number;
  pointerDowns: number;
  pointerUps: number;
  ignoredPointerUps: number;
  cameraDragsSuppressedCreations: number;
  duplicateEventsIgnored: number;
  createdNodes: number;
  rejectedCreations: number;
  imageDecodeAttempts: number;
  imageDecodeSuccesses: number;
  imageDecodeFailures: number;
  referenceLoadsCommitted: number;
  staleReferenceResults: number;
  bitmapsClosed: number;
  texturesDisposed: number;
  referenceObjectUrlsRevoked: number;
  newDrafts: number;
  viewResets: number;
  referenceFocusRequests: number;
  /** PTG-3 local persistence / export counters (local only, never wire facts). */
  localBootAttempts: number;
  localSaveAttempts: number;
  localSavesCommitted: number;
  localSaveFailures: number;
  localConflicts: number;
  localRestoreAttempts: number;
  localRestoresApplied: number;
  localRestoreFailures: number;
  snapshotsCreated: number;
  snapshotDownloads: number;
  exportsBlocked: number;
}

export function createCounters(): DiagnosticsCounters {
  return {
    sceneMounts: 0,
    sceneUnmounts: 0,
    pointerDowns: 0,
    pointerUps: 0,
    ignoredPointerUps: 0,
    cameraDragsSuppressedCreations: 0,
    duplicateEventsIgnored: 0,
    createdNodes: 0,
    rejectedCreations: 0,
    imageDecodeAttempts: 0,
    imageDecodeSuccesses: 0,
    imageDecodeFailures: 0,
    referenceLoadsCommitted: 0,
    staleReferenceResults: 0,
    bitmapsClosed: 0,
    texturesDisposed: 0,
    referenceObjectUrlsRevoked: 0,
    newDrafts: 0,
    viewResets: 0,
    referenceFocusRequests: 0,
    localBootAttempts: 0,
    localSaveAttempts: 0,
    localSavesCommitted: 0,
    localSaveFailures: 0,
    localConflicts: 0,
    localRestoreAttempts: 0,
    localRestoresApplied: 0,
    localRestoreFailures: 0,
    snapshotsCreated: 0,
    snapshotDownloads: 0,
    exportsBlocked: 0,
  };
}

export const counters: DiagnosticsCounters = createCounters();

export interface PointerSample {
  clientX: number;
  clientY: number;
  ndcX: number | null;
  ndcY: number | null;
}

/** Last raw pointer sample, used to separate pointer transport error from ray math error. */
export const lastPointer: { down: PointerSample | null; up: PointerSample | null } = {
  down: null,
  up: null,
};

export function resetCounters(): void {
  Object.assign(counters, createCounters());
  lastPointer.down = null;
  lastPointer.up = null;
}

export interface SceneHandle {
  /** Live camera read-out for evidence (position/quaternion/fov/aspect). */
  readCamera: () => {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    fov: number;
    aspect: number;
    near: number;
    far: number;
    target: [number, number, number] | null;
  } | null;
  /** Canvas CSS rectangle (client coordinates). */
  readCanvasRect: () => { left: number; top: number; width: number; height: number } | null;
  /** Device pixel ratio and drawing buffer size. */
  readViewport: () => {
    devicePixelRatio: number;
    drawingBufferWidth: number;
    drawingBufferHeight: number;
  } | null;
  /** Project a graph-frame point to client (CSS) coordinates. */
  projectGraphPoint: (point: [number, number, number]) => {
    x: number;
    y: number;
    ndc: [number, number, number];
    inFrustum: boolean;
  } | null;
}

let sceneHandle: SceneHandle | null = null;

export function registerSceneHandle(handle: SceneHandle): void {
  sceneHandle = handle;
}

export function unregisterSceneHandle(handle?: SceneHandle): void {
  if (!handle || sceneHandle === handle) {
    sceneHandle = null;
  }
}

export function getSceneHandle(): SceneHandle | null {
  return sceneHandle;
}
