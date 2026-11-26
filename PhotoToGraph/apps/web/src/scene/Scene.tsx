import { Canvas } from '@react-three/fiber';
import { usePtgStore } from '../domain/store';
import { identityPose } from '../spatial/frame';
import { SceneContent } from './SceneContent';

export const DEFAULT_CAMERA_POSITION: [number, number, number] = [7, 6, 9];
export const DEFAULT_CAMERA_TARGET: [number, number, number] = [0, 0, 0];
/** Current UI keeps graph frame == render world. Tests exercise non-identity frames. */
export const SCENE_FRAME = identityPose();

export function Scene() {
  const sceneEpoch = usePtgStore((state) => state.sceneEpoch);

  return (
    <div className="ptg-canvas-wrapper" data-testid="ptg-canvas-wrapper">
      <Canvas
        key={sceneEpoch}
        dpr={[1, 2]}
        camera={{
          position: DEFAULT_CAMERA_POSITION,
          fov: 50,
          near: 0.05,
          far: 10_000_000,
        }}
        gl={{ antialias: true, alpha: false, logarithmicDepthBuffer: true, preserveDrawingBuffer: true }}
        onPointerMissed={() => {
          const state = usePtgStore.getState();
          if (state.mode === 'select') {
            state.selectNode(null);
          }
        }}
      >
        <color attach="background" args={['#0b1016']} />
        <SceneContent />
      </Canvas>
    </div>
  );
}
