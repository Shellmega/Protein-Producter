import { useEffect, useLayoutEffect, useMemo, useRef, type ComponentRef } from 'react';
import { TransformControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { usePtgStore } from '../domain/store';

// Drei/three-stdlib wraps the Spline Editor control. Its runtime exposes these
// operational properties; the installed .d.ts marks them private. No fork or
// dependency patch is made. Cancellation also resets the control's gesture.
type RuntimeControl = { dragging: boolean; axis: string | null; reset: () => void; onPointerUp: (event: PointerEvent) => void };

export function GraphTransform() {
  const selected = usePtgStore(s => s.selectedNodeId);
  const mode = usePtgStore(s => s.mode);
  const constraint = usePtgStore(s => s.dragConstraint);
  const nodes = usePtgStore(s => s.content.nodes);
  const node = nodes.find(n => n.id === selected);
  if (mode !== 'move' || !node) return null;
  return <NodeTransform key={`${node.id}:${constraint}`} nodeId={node.id} constraint={constraint} />;
}

function NodeTransform({ nodeId, constraint }: { nodeId: string; constraint: string }) {
  const object = useMemo(() => new THREE.Object3D(), []);
  const controls = useRef<ComponentRef<typeof TransformControls>>(null);
  const token = useRef<number | null>(null);
  const pointerOrigin = useRef<{ x: number; y: number; id: number } | null>(null);
  const pointerAtOrigin = useRef(true);
  const gl = useThree(s => s.gl);
  const orbit = useThree(s => s.controls) as unknown as { enabled: boolean } | null;
  const invalidate = useThree(s => s.invalidate);
  useLayoutEffect(() => {
    const n = usePtgStore.getState().content.nodes.find(n => n.id === nodeId);
    if (n) object.position.set(...n.position);
  }, [nodeId, object]);

  useEffect(() => {
    const canvas = gl.domElement;
    const release = () => {
      token.current = null;
      const c = controls.current as unknown as RuntimeControl | null;
      if (c) {
        c.reset();
        // Installed stdlib onPointerUp removes its document pointermove listener;
        // unlike OrbitControls it does not release a browser pointer capture.
        c.onPointerUp(new PointerEvent('pointerup', { button: 0 }));
        c.dragging = false; c.axis = null;
      }
      canvas.style.touchAction = '';
      if (orbit) orbit.enabled = true;
      const n = usePtgStore.getState().content.nodes.find(n => n.id === nodeId);
      if (n) object.position.set(...n.position);
      invalidate();
    };
    const cancel = () => { usePtgStore.getState().cancelDrag(); release(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    const rememberDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pointerOrigin.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      pointerAtOrigin.current = true;
    };
    const rememberPosition = (e: PointerEvent) => {
      const start = pointerOrigin.current;
      if (start && start.id === e.pointerId) pointerAtOrigin.current = e.clientX === start.x && e.clientY === start.y;
    };
    // Any persistent graph change consumes/cancels the transaction synchronously.
    const unsubscribe = usePtgStore.subscribe((state, previous) => {
      if (previous.drag && !state.drag) release();
      else if (!state.drag && state.content !== previous.content) {
        const n = state.content.nodes.find(n => n.id === nodeId);
        if (n) { object.position.set(...n.position); invalidate(); }
      }
    });
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('pointerdown', rememberDown, true);
    canvas.ownerDocument.addEventListener('pointermove', rememberPosition, true);
    canvas.ownerDocument.addEventListener('pointerup', rememberPosition, true);
    return () => {
      unsubscribe();
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('pointerdown', rememberDown, true);
      canvas.ownerDocument.removeEventListener('pointermove', rememberPosition, true);
      canvas.ownerDocument.removeEventListener('pointerup', rememberPosition, true);
      usePtgStore.getState().cancelDrag();
      release();
    };
  }, [gl, orbit, nodeId, object, invalidate]);

  return <>
    <primitive object={object} />
    <TransformControls ref={controls} object={object} mode="translate" space="world" size={0.85}
      showX={constraint.includes('X')} showY={constraint.includes('Y')} showZ={constraint.includes('Z')}
      onMouseDown={() => { token.current = usePtgStore.getState().beginDrag(nodeId); }}
      onObjectChange={() => {
        const state = usePtgStore.getState();
        if (token.current !== null) {
          // An exact return to the same received pointer coordinates is an
          // exact no-op gesture, despite TC ray/plane recomputation roundoff.
          // This is no epsilon comparison of domain content.
          const point = pointerAtOrigin.current && state.drag ? state.drag.start : object.position.toArray();
          state.previewDrag(token.current, point);
          if (pointerAtOrigin.current) object.position.set(...point);
        }
      }}
      onMouseUp={() => {
        const state = usePtgStore.getState();
        if (token.current !== null) {
          if (pointerAtOrigin.current && state.drag) state.previewDrag(token.current, state.drag.start);
          state.finishDrag(token.current);
        }
      }} />
  </>;
}
