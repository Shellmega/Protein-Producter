import { useMemo } from 'react';
import * as THREE from 'three';
import { CameraRig } from './CameraRig';
import { CanvasPointerController } from './CanvasPointerController';
import { NodeMarkers } from './NodeMarkers';
import { ReferenceImagePlane } from './ReferenceImagePlane';
import { SceneDiagnostics } from './SceneDiagnostics';
import { WorkPlaneVisual } from './WorkPlaneVisual';
import { SCENE_FRAME } from './Scene';
import { GraphEdges } from './GraphEdges';
import { GraphTransform } from './GraphTransform';

export function SceneContent() {
  const sceneMatrix = useMemo(() => {
    const matrix = new THREE.Matrix4();
    matrix.compose(
      new THREE.Vector3(...SCENE_FRAME.translation),
      new THREE.Quaternion(...SCENE_FRAME.rotation),
      new THREE.Vector3(SCENE_FRAME.scale, SCENE_FRAME.scale, SCENE_FRAME.scale),
    );
    return matrix;
  }, []);

  return (
    <>
      <SceneDiagnostics />
      <CameraRig />
      <CanvasPointerController />
      <ambientLight intensity={1.15} />
      <directionalLight position={[6, 10, 8]} intensity={1.5} />
      <group matrix={sceneMatrix} matrixAutoUpdate={false}>
        <axesHelper args={[3]} />
        <mesh position={[0, 0, 0]}>
          <sphereGeometry args={[0.035, 12, 10]} />
          <meshBasicMaterial color="#e6edf3" />
        </mesh>
        <WorkPlaneVisual />
        <NodeMarkers />
        <GraphEdges />
        <GraphTransform />
        <ReferenceImagePlane />
      </group>
    </>
  );
}
