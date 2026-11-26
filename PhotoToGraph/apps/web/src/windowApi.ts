/**
 * Read-only `window.__PTG__` diagnostics hook.
 *
 * Scope: author evidence and debugging only. It reads the live store, the live
 * camera/canvas, the local persistence status and the immutable snapshot
 * registry; it cannot inject graph state, mutate the revision, create nodes or
 * trigger a save. Normal user operation always goes through the page controls.
 * This is explicitly NOT a contract export: exports go through the frozen
 * snapshot module, whose bytes are read back through `snapshotText` here.
 */

import * as THREE from 'three';
import { counters, getSceneHandle, lastPointer, registerSceneHandle, unregisterSceneHandle } from './diagnostics';
import { usePtgStore, resolveActivePlane, referenceStatusOf } from './domain/store';
import { formatVec3 } from './spatial/math';
import { imagePlaneSize, imagePixelToGraph, referencePlane } from './spatial/referenceImage';
import { identityPose } from './spatial/frame';
import { MAX_ABS_COORD, NEAR_PARALLEL_EPS } from './spatial/intersection';
import { topology } from './domain/topology';
import { displayPosition } from './domain/editing';
import { COINCIDENCE } from './domain/geometry';
import { listSnapshots, snapshotById, snapshotText } from './contract/snapshot';
import { persistenceStatus } from './persistence/session';
import { deliveryRecordsForDiagnostics, getDeliveryStatus } from './delivery/session';

export interface PtgWindowApi {
  readonly kind: 'PTG-1-read-only-diagnostics';
  readonly version: string;
  snapshot: () => unknown;
  projectGraphPoint: (point: [number, number, number]) => unknown;
  imagePixelToGraph: (pixelX: number, pixelY: number) => [number, number, number] | null;
  activePlane: () => unknown;
  canvasRect: () => unknown;
  snapshots: () => unknown;
  snapshotText: (snapshotId: string) => string | null;
  persistence: () => unknown;
  delivery: () => unknown;
  deliveryRecords: () => unknown;
}

declare global {
  interface Window {
    __PTG__?: PtgWindowApi;
  }
}

export const WINDOW_API_VERSION = 'ptg4-delivery-0.4.0';

export function buildSnapshot(): Record<string, unknown> {
  const state = usePtgStore.getState();
  const handle = getSceneHandle();
  const camera = handle?.readCamera() ?? null;
  const rect = handle?.readCanvasRect() ?? null;
  const viewport = handle?.readViewport() ?? null;
  const plane = resolveActivePlane(state);
  const reference = state.reference;
  const planeSize = reference
    ? imagePlaneSize(reference.intrinsicWidth, reference.intrinsicHeight, reference.baseWidth)
    : null;

  return {
    kind: 'PTG-1-read-only-diagnostics',
    version: WINDOW_API_VERSION,
    sampledAt: new Date().toISOString(),
    sceneFrame: {
      // Current UI keeps graph frame == render world; the transform code path
      // supports non-identity fixtures (see unit tests).
      graphToWorld: identityPose(),
      note: 'UI 使用单位变换；完整变换函数由 S05 单元测试以非单位夹具验证',
    },
    graph: {
      producer_instance_id: state.identity.producer_instance_id,
      graph_id: state.identity.graph_id,
      frame_id: state.identity.frame_id,
      revision: state.identity.revision,
      coordinate_system: state.identity.coordinate_system,
      nodes: state.content.nodes.map((node) => ({ id: node.id, position: [...node.position] })),
      edges: state.content.edges.map((edge) => [...edge]),
      n_terminal_node: state.content.n_terminal_node,
      source_reference_image_ids: [...state.content.source_reference_image_ids],
    },
    editor: {
      drag: state.drag ? structuredClone(state.drag) : null,
      dragConstraint: state.dragConstraint,
      pendingConnection: state.pendingConnection,
      mode: state.mode,
      planeKind: state.planeKind,
      planeLabel: state.planeKind === 'reference' ? '参考图平面' : `${state.planeKind.toUpperCase()} 平面`,
      planeOffset:
        state.planeKind === 'reference'
          ? null
          : state.planeOffsets[state.planeKind],
      planeOffsets: { ...state.planeOffsets },
      selectedNodeId: state.selectedNodeId,
      referenceStatus: referenceStatusOf(state),
      referenceError: state.referenceError,
      reference: reference
        ? {
            sourceId: reference.sourceId,
            fileName: reference.fileName,
            mimeType: reference.mimeType,
            intrinsicWidth: reference.intrinsicWidth,
            intrinsicHeight: reference.intrinsicHeight,
            baseWidth: reference.baseWidth,
            orientationPolicy: reference.orientationPolicy,
            byteLength: reference.bytes.byteLength,
            pose: {
              position: [...reference.pose.position],
              rotationDeg: [...reference.pose.rotationDeg],
              scale: reference.pose.scale,
            },
            planeSize: planeSize ? { ...planeSize } : null,
            displayedPlaneSize: planeSize
              ? {
                  width: planeSize.width * reference.pose.scale,
                  height: planeSize.height * reference.pose.scale,
                }
              : null,
          }
        : null,
      referenceToken: state.referenceToken,
      sceneEpoch: state.sceneEpoch,
    },
    plane: plane
      ? {
          point: [...plane.point],
          normal: [...plane.normal],
          u: [...plane.u],
          v: [...plane.v],
          label: formatVec3(plane.point, 6),
        }
      : null,
    feedback: state.feedback
      ? { level: state.feedback.level, code: state.feedback.code, message: state.feedback.message }
      : null,
    camera,
    canvasRect: rect,
    viewport,
    window: {
      innerWidth: typeof window === 'undefined' ? null : window.innerWidth,
      innerHeight: typeof window === 'undefined' ? null : window.innerHeight,
      scrollX: typeof window === 'undefined' ? null : window.scrollX,
      scrollY: typeof window === 'undefined' ? null : window.scrollY,
      devicePixelRatio: typeof window === 'undefined' ? null : window.devicePixelRatio,
    },
    counters: { ...counters },
    persistence: persistenceStatus(),
    snapshots: listSnapshots().map((snapshot) => ({ ...snapshot.local })),
    history: {
      past: usePtgStore.temporal.getState().pastStates.length,
      future: usePtgStore.temporal.getState().futureStates.length,
    },
    topology: topology(state.content),
    display: {
      nodes: state.content.nodes.map(n => ({ id: n.id, position: [...displayPosition(state,n)] })),
      edges: state.content.edges.map(([a,b]) => ({ endpoints: [a,b], positions: [a,b].map(id => [...displayPosition(state, state.content.nodes.find(n => n.id === id)!)]) })),
    },
    lastPointer: {
      down: lastPointer.down ? { ...lastPointer.down } : null,
      up: lastPointer.up ? { ...lastPointer.up } : null,
    },
    limits: {
      maxAbsCoordinate: MAX_ABS_COORD,
      nearParallelEps: NEAR_PARALLEL_EPS,
      coincidence: COINCIDENCE,
    },
  };
}

export function installWindowApi(): () => void {
  const api: PtgWindowApi = {
    kind: 'PTG-1-read-only-diagnostics',
    version: WINDOW_API_VERSION,
    snapshot: () => buildSnapshot(),
    projectGraphPoint: (point) => getSceneHandle()?.projectGraphPoint(point) ?? null,
    imagePixelToGraph: (pixelX, pixelY) => {
      const reference = usePtgStore.getState().reference;
      if (!reference) {
        return null;
      }
      return imagePixelToGraph(
        reference.pose,
        reference.intrinsicWidth,
        reference.intrinsicHeight,
        pixelX,
        pixelY,
        reference.baseWidth,
      );
    },
    activePlane: () => {
      const state = usePtgStore.getState();
      const plane = resolveActivePlane(state);
      return plane ? { ...plane, label: formatVec3(plane.point, 6) } : null;
    },
    canvasRect: () => getSceneHandle()?.readCanvasRect() ?? null,
    snapshots: () => listSnapshots().map((snapshot) => ({ ...snapshot.local })),
    snapshotText: (snapshotId) => {
      const snapshot = snapshotById(snapshotId);
      return snapshot ? snapshotText(snapshot) : null;
    },
    persistence: () => persistenceStatus(),
    delivery: () => getDeliveryStatus(),
    deliveryRecords: () => deliveryRecordsForDiagnostics(),
  };
  window.__PTG__ = api;
  return () => {
    if (window.__PTG__ === api) {
      delete window.__PTG__;
    }
  };
}

/** Used by the Scene to register camera/canvas reads. */
export function registerThreeSceneHandles(
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
  controlsTarget: () => [number, number, number] | null,
): () => void {
  const handle = {
    readCamera: () => {
      const position = camera.position;
      const quaternion = camera.quaternion;
      const target = controlsTarget();
      if (!Number.isFinite(position.x) || !Number.isFinite(quaternion.w)) {
        return null;
      }
      return {
        position: [position.x, position.y, position.z] as [number, number, number],
        quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] as [
          number,
          number,
          number,
          number,
        ],
        fov: camera.fov,
        aspect: camera.aspect,
        near: camera.near,
        far: camera.far,
        target,
        matrixWorld: camera.matrixWorld.elements.slice(),
        projectionMatrix: camera.projectionMatrix.elements.slice(),
        matrixWorldInverse: camera.matrixWorldInverse.elements.slice(),
      };
    },
    readCanvasRect: () => {
      const rect = canvas.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    },
    readViewport: () => ({
      devicePixelRatio: window.devicePixelRatio,
      drawingBufferWidth: canvas.width,
      drawingBufferHeight: canvas.height,
    }),
    projectGraphPoint: (point: [number, number, number]) => {
      const rect = canvas.getBoundingClientRect();
      const vector = new THREE.Vector3(point[0], point[1], point[2]).project(camera);
      return {
        x: rect.left + (vector.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-vector.y * 0.5 + 0.5) * rect.height,
        ndc: [vector.x, vector.y, vector.z] as [number, number, number],
        inFrustum: vector.z >= -1 && vector.z <= 1,
      };
    },
  };
  registerSceneHandle(handle);
  return () => {
    unregisterSceneHandle(handle);
  };
}

export function referencePlaneForDiagnostics(): ReturnType<typeof referencePlane> | null {
  const reference = usePtgStore.getState().reference;
  return reference ? referencePlane(reference.pose) : null;
}
