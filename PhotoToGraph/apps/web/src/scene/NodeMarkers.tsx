import type { ThreeEvent } from '@react-three/fiber';
import { usePtgStore } from '../domain/store';
import { DRAG_THRESHOLD_PX } from './CanvasPointerController';
import { displayPosition } from '../domain/editing';

const NODE_COLOR = '#66d9ff';
const SELECTED_COLOR = '#ffd166';

/**
 * Node markers are a pure projection of the domain node table: the mesh never
 * owns the position, it renders `node.position` from the store keyed by the
 * stable node ID. Clicking selects only in select mode and only for real
 * clicks (camera drags are ignored via R3F's event delta).
 */
export function NodeMarkers() {
  const nodes = usePtgStore((state) => state.content.nodes);
  const selectedNodeId = usePtgStore((state) => state.selectedNodeId);
  const drag = usePtgStore(state => state.drag);

  const handleClick = (nodeId: string) => (event: ThreeEvent<MouseEvent>) => {
    const state = usePtgStore.getState();
    if (state.mode === 'create' || state.drag) {
      return;
    }
    if (event.delta > DRAG_THRESHOLD_PX) {
      return;
    }
    event.stopPropagation();
    state.chooseNode(nodeId);
  };

  return (
    <group>
      {nodes.map((node) => {
        const selected = node.id === selectedNodeId;
        return (
          <group key={node.id} position={displayPosition({ drag }, node)}>
            <mesh onClick={handleClick(node.id)}>
              <sphereGeometry args={[selected ? 0.13 : 0.09, 24, 18]} />
              <meshStandardMaterial
                color={selected ? SELECTED_COLOR : NODE_COLOR}
                emissive={selected ? '#8a6400' : '#0a3b52'}
                emissiveIntensity={0.7}
                roughness={0.35}
                metalness={0.05}
              />
            </mesh>
            {selected ? (
              <mesh>
                <sphereGeometry args={[0.19, 20, 14]} />
                <meshBasicMaterial color={SELECTED_COLOR} wireframe transparent opacity={0.65} />
              </mesh>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}
