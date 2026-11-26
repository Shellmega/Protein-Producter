import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import { counters } from '../diagnostics';
import { registerThreeSceneHandles } from '../windowApi';

/**
 * Registers read-only camera/canvas handles for evidence snapshots and counts
 * scene mounts/unmounts. It never writes into the store.
 */
export function SceneDiagnostics() {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl);
  const controls = useThree((state) => state.controls) as unknown as
    | { target?: THREE.Vector3 }
    | null;

  useEffect(() => {
    counters.sceneMounts += 1;
    return () => {
      counters.sceneUnmounts += 1;
    };
  }, []);

  useEffect(() => {
    const cleanup = registerThreeSceneHandles(camera, gl.domElement, () => {
      const target = controls?.target;
      return target ? [target.x, target.y, target.z] : null;
    });
    return cleanup;
  }, [camera, gl, controls]);

  return null;
}
