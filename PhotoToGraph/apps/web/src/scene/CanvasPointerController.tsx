import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { counters, lastPointer } from '../diagnostics';
import { resolveActivePlane, usePtgStore } from '../domain/store';
import { clientToNdc } from '../spatial/pointer';
import { rayWorldToGraph } from '../spatial/frame';
import { intersectRayWithPlane } from '../spatial/intersection';
import { SCENE_FRAME } from './Scene';

/** A click that moves more than this many CSS pixels is a camera gesture, not a point. */
export const DRAG_THRESHOLD_PX = 4;

/**
 * Single pointer arbitration for the canvas:
 * - camera drags (any movement over DRAG_THRESHOLD_PX) never create a node;
 * - a click only creates a node in `create` mode;
 * - a pointerup without a matching pointerdown is ignored (duplicate events);
 * - Escape / blur / pointercancel discard the pending gesture.
 */
export function CanvasPointerController() {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    const canvas = gl.domElement;
    let down: { x: number; y: number; pointerId: number; moved: boolean; mode: string; graph: string } | null = null;

    const clearGesture = () => {
      down = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      counters.pointerDowns += 1;
      lastPointer.down = {
        clientX: event.clientX,
        clientY: event.clientY,
        ndcX: null,
        ndcY: null,
      };
      down = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
        moved: false,
        mode: usePtgStore.getState().mode,
        graph: usePtgStore.getState().identity.graph_id,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!down || down.pointerId !== event.pointerId) {
        return;
      }
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > DRAG_THRESHOLD_PX) {
        down.moved = true;
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      counters.pointerUps += 1;
      if (!down || down.pointerId !== event.pointerId) {
        counters.ignoredPointerUps += 1;
        counters.duplicateEventsIgnored += 1;
        // Test/automation duplicate pointer IDs are not active browser pointers.
        // Do not forward them to OrbitControls.releasePointerCapture().
        if (!event.isTrusted && !canvas.hasPointerCapture(event.pointerId)) event.stopImmediatePropagation();
        return;
      }
      const gesture = down;
      down = null;
      if (event.button !== 0) {
        return;
      }
      const moved =
        gesture.moved ||
        Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > DRAG_THRESHOLD_PX;
      if (moved) {
        counters.cameraDragsSuppressedCreations += 1;
        return;
      }

      const state = usePtgStore.getState();
      if (state.mode !== 'create' || gesture.mode !== state.mode || gesture.graph !== state.identity.graph_id || state.drag) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const ndc = clientToNdc(event.clientX, event.clientY, rect);
      lastPointer.up = {
        clientX: event.clientX,
        clientY: event.clientY,
        ndcX: ndc?.x ?? null,
        ndcY: ndc?.y ?? null,
      };
      if (!ndc) {
        state.reportCreationFailure('INVALID_POINTER', '画布 CSS 尺寸无效，无法建立指针射线。');
        return;
      }

      const plane = resolveActivePlane(state);
      if (!plane) {
        state.reportCreationFailure(
          'NO_PLANE',
          '当前没有可用的建点平面（参考图平面未就绪），未建立结点。',
        );
        return;
      }

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
      const rayGraph = rayWorldToGraph(SCENE_FRAME, {
        origin: [
          raycaster.ray.origin.x,
          raycaster.ray.origin.y,
          raycaster.ray.origin.z,
        ],
        direction: [
          raycaster.ray.direction.x,
          raycaster.ray.direction.y,
          raycaster.ray.direction.z,
        ],
      });

      const result = intersectRayWithPlane(rayGraph, plane);
      if (!result.ok) {
        state.reportCreationFailure(result.code, result.message);
        return;
      }
      state.addNodeAtGraphPoint(result.point);
    };

    const onPointerCancel = (event: PointerEvent) => {
      clearGesture();
      usePtgStore.getState().cancelDrag();
      if (!event.isTrusted && !canvas.hasPointerCapture(event.pointerId)) event.stopImmediatePropagation();
    };
    const onWindowBlur = () => {
      clearGesture();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearGesture();
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp, true);
    canvas.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp, true);
      canvas.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [gl, camera]);

  return null;
}
