import { Line } from '@react-three/drei';
import { usePtgStore } from '../domain/store';
import { displayPosition } from '../domain/editing';

export function GraphEdges() {
  const nodes = usePtgStore(s => s.content.nodes);
  const edges = usePtgStore(s => s.content.edges);
  const drag = usePtgStore(s => s.drag);
  const positions = new Map(nodes.map(n => [n.id, displayPosition({ drag }, n)]));
  return <group>{edges.map(([a,b]) => {
    const p = positions.get(a)!;
    const q = positions.get(b)!;
    return <group key={`${a}|${b}`} position={p}>
      <Line points={[[0,0,0], [q[0]-p[0], q[1]-p[1], q[2]-p[2]]]} color="#7ee787" lineWidth={2} />
    </group>;
  })}</group>;
}
