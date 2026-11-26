import { useEffect, useRef, type ComponentRef } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { usePtgStore } from '../domain/store';
import { DEFAULT_CAMERA_POSITION, DEFAULT_CAMERA_TARGET } from './Scene';

/**
 * Camera controls live inside the Canvas. View commands are editor actions
 * (nonce counters) so the header buttons never need a Three.js handle and
 * camera changes can never touch the graph revision.
 */
export function CameraRig() {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);
  const camera = useThree((state) => state.camera);
  const resetNonce = usePtgStore((state) => state.viewResetNonce);
  const focusNonce = usePtgStore((state) => state.viewFocusNonce);
  const nodeFocusNonce = usePtgStore((state) => state.viewNodeFocusNonce);
  const viewRestore = usePtgStore((state) => state.viewRestore);
  const dragging = usePtgStore(state => state.drag !== null);

  // Restore a persisted camera pose (position + orbit target) as editor state.
  // Runs after mount and on every restore nonce, so a Canvas remount during a
  // session restore still ends on the saved pose.
  useEffect(() => {
    if (!viewRestore) {
      return;
    }
    const controls = controlsRef.current;
    camera.position.set(...viewRestore.position);
    camera.lookAt(...viewRestore.target);
    if (controls) {
      controls.target.set(...viewRestore.target);
      controls.update();
    }
  }, [viewRestore, camera]);

  useEffect(() => {
    if (!nodeFocusNonce) return;
    const state = usePtgStore.getState();
    const node = state.content.nodes.find(n => n.id === state.selectedNodeId);
    if (!node) return;
    const [x,y,z] = node.position;
    camera.position.set(x+7,y+6,z+9);
    camera.lookAt(x,y,z);
    controlsRef.current?.target.set(x,y,z);
    controlsRef.current?.update();
  }, [nodeFocusNonce, camera]);

  useEffect(() => {
    if (resetNonce === 0) {
      return;
    }
    const controls = controlsRef.current;
    camera.position.set(...DEFAULT_CAMERA_POSITION);
    camera.lookAt(...DEFAULT_CAMERA_TARGET);
    if (controls) {
      controls.target.set(...DEFAULT_CAMERA_TARGET);
      controls.update();
    }
  }, [resetNonce, camera]);

  useEffect(() => {
    if (focusNonce === 0) {
      return;
    }
    const reference = usePtgStore.getState().reference;
    if (!reference) {
      return;
    }
    const [x, y, z] = reference.pose.position;
    const controls = controlsRef.current;
    camera.position.set(x + 3, y + 3, z + 5);
    camera.lookAt(x, y, z);
    if (controls) {
      controls.target.set(x, y, z);
      controls.update();
    }
  }, [focusNonce, camera]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={!dragging}
      enableDamping={false}
      enablePan
      enableZoom
      minDistance={0.2}
      maxDistance={4_000_000}
      zoomSpeed={1.2}
      rotateSpeed={0.9}
      panSpeed={0.9}
    />
  );
}
