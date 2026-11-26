import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { counters } from '../diagnostics';
import { usePtgStore } from '../domain/store';
import { imagePlaneSize, referencePoseToPose } from '../spatial/referenceImage';

/**
 * Reference image on its own plane.
 *
 * - The plane is placed by the reference pose (graph frame position / Euler
 *   XYZ rotation / positive uniform scale).
 * - The texture is built from the decoded, orientation-corrected bitmap via a
 *   2D canvas so UV orientation is explicit and testable.
 * - The mesh is not pickable for node selection; the image is a visual
 *   reference only and never receives creation clicks by itself.
 */
export function ReferenceImagePlane() {
  const reference = usePtgStore((state) => state.reference);

  const size = useMemo(
    () =>
      reference
        ? imagePlaneSize(reference.intrinsicWidth, reference.intrinsicHeight, reference.baseWidth)
        : null,
    [reference],
  );

  const quaternion = useMemo(() => {
    if (!reference) {
      return null;
    }
    const pose = referencePoseToPose(reference.pose);
    return new THREE.Quaternion(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
  }, [reference]);

  const texture = useMemo(() => {
    if (!reference) {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = reference.intrinsicWidth;
    canvas.height = reference.intrinsicHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.drawImage(reference.bitmap, 0, 0);
    const nextTexture = new THREE.CanvasTexture(canvas);
    nextTexture.colorSpace = THREE.SRGBColorSpace;
    nextTexture.flipY = true;
    nextTexture.needsUpdate = true;
    return nextTexture;
  }, [reference]);

  useEffect(() => {
    return () => {
      if (texture) {
        texture.dispose();
        counters.texturesDisposed += 1;
      }
    };
  }, [texture]);

  const borderGeometry = useMemo(() => {
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
      return null;
    }
    const w = size.width / 2;
    const h = size.height / 2;
    const z = 0.01;
    const points = [
      [-w, -h, z],
      [w, -h, z],
      [w, h, z],
      [-w, h, z],
      [-w, -h, z],
      // direction marker: image +Y (top) tick
      [0, h, z],
      [0, h + Math.max(0.25, h * 0.12), z],
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
    return geometry;
  }, [size]);

  useEffect(() => {
    return () => {
      borderGeometry?.dispose();
    };
  }, [borderGeometry]);

  if (!reference || !size || !quaternion || !texture || !borderGeometry) {
    return null;
  }

  return (
    <group
      position={reference.pose.position}
      quaternion={quaternion}
      scale={reference.pose.scale}
    >
      <mesh raycast={() => null} renderOrder={2}>
        <planeGeometry args={[size.width, size.height]} />
        <meshBasicMaterial map={texture} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <lineSegments geometry={borderGeometry} renderOrder={3}>
        <lineBasicMaterial color="#e6edf3" transparent opacity={0.9} />
      </lineSegments>
      <mesh position={[0, 0, 0.02]} raycast={() => null} renderOrder={4}>
        <planeGeometry args={[size.width, size.height]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.03}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
