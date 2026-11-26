import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { resolveActivePlane, usePtgStore } from '../domain/store';

const PLANE_EXTENT = 6;
const GRID_STEP = 1;

const PLANE_COLORS: Record<'xy' | 'xz' | 'yz', string> = {
  xy: '#4da3ff',
  xz: '#7ee787',
  yz: '#ffb86b',
};

/**
 * Visible current work plane in the graph frame, including its offset.
 * The reference-image plane is drawn by ReferenceImagePlane instead so the
 * visible image is always the actual intersection plane.
 */
export function WorkPlaneVisual() {
  const planeKind = usePtgStore((state) => state.planeKind);
  const planeOffsets = usePtgStore((state) => state.planeOffsets);
  const reference = usePtgStore((state) => state.reference);

  const plane = useMemo(
    () => resolveActivePlane({ planeKind, planeOffsets, reference }),
    [planeKind, planeOffsets, reference],
  );

  const color = planeKind === 'reference' ? '#ffffff' : PLANE_COLORS[planeKind];

  const geometry = useMemo(() => {
    if (!plane || planeKind === 'reference') {
      return null;
    }
    const { point, u, v } = plane;
    const at = (su: number, sv: number): [number, number, number] => [
      point[0] + u[0] * su + v[0] * sv,
      point[1] + u[1] * su + v[1] * sv,
      point[2] + u[2] * su + v[2] * sv,
    ];

    const quad = new THREE.BufferGeometry();
    const e = PLANE_EXTENT;
    const corners = [at(-e, -e), at(e, -e), at(e, e), at(-e, -e), at(e, e), at(-e, e)];
    quad.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3));
    quad.computeVertexNormals();

    const lines: number[] = [];
    for (let i = -PLANE_EXTENT; i <= PLANE_EXTENT; i += GRID_STEP) {
      const a = at(i, -e);
      const b = at(i, e);
      lines.push(...a, ...b);
      const c = at(-e, i);
      const d = at(e, i);
      lines.push(...c, ...d);
    }
    const grid = new THREE.BufferGeometry();
    grid.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));

    return { quad, grid };
  }, [plane, planeKind]);

  useEffect(() => {
    return () => {
      geometry?.quad.dispose();
      geometry?.grid.dispose();
    };
  }, [geometry]);

  if (!plane || planeKind === 'reference' || !geometry) {
    return null;
  }

  return (
    <group>
      <mesh geometry={geometry.quad}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.055}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={geometry.grid}>
        <lineBasicMaterial color={color} transparent opacity={0.32} />
      </lineSegments>
      <mesh position={plane.point}>
        <sphereGeometry args={[0.045, 12, 10]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}
