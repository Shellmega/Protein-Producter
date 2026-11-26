import type { GraphContent } from './types';

export function normalizedEdge(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Derived on demand, never stored as a second topology. */
export function topology(content: GraphContent) {
  const adjacency = Object.fromEntries(content.nodes.map(n => [n.id, [] as string[]]));
  for (const [a, b] of content.edges) {
    adjacency[a]?.push(b);
    adjacency[b]?.push(a);
  }
  for (const neighbors of Object.values(adjacency)) neighbors.sort();
  const seen = new Set<string>();
  let components = 0;
  for (const n of content.nodes) {
    if (seen.has(n.id)) continue;
    components++;
    const queue = [n.id];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...adjacency[id].filter(k => !seen.has(k)));
    }
  }
  const endpoints = Object.keys(adjacency).filter(id => adjacency[id].length === 1);
  const branch = Object.values(adjacency).some(ns => ns.length > 2);
  const openChain = content.nodes.length >= 2 && components === 1 && endpoints.length === 2 && !branch && content.edges.length === content.nodes.length - 1;
  const start = content.n_terminal_node;
  const startValid = start !== null && adjacency[start]?.length === 1;
  const order: string[] = [];
  if (openChain && startValid) {
    let current: string | undefined = start!;
    let previous: string | undefined;
    while (current) {
      order.push(current);
      const next: string | undefined = adjacency[current].find(n => n !== previous);
      previous = current;
      current = next;
    }
  }
  return { adjacency, components, endpoints, branch, openChain, startValid, order };
}
