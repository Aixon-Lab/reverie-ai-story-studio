/**
 * The associative network: indices, fan computation, traversal, link inference.
 *
 * Edges are typed and weighted, and a node's *fan* over a cue is what produces
 * interference — a concept linked to everything stops discriminating (§4.3).
 */
import { similarity, tokenSet } from './activation';
import type { BrainState, EdgeKind, MemoryEdge, MemoryNode } from './types';

export interface BrainIndex {
  /** cue token → node ids that carry it (actors, place, tags, gist tokens) */
  byCue: Map<string, string[]>;
  /** node id → outgoing + incoming edges */
  adjacency: Map<string, MemoryEdge[]>;
  /** cue token → fan (how many nodes it points at) */
  fan: Map<string, number>;
}

/** Cue tokens a node is retrievable by. Actors and places are weighted by repetition. */
export function nodeCues(node: MemoryNode): string[] {
  const cues = new Set<string>();
  for (const a of node.actors ?? []) cues.add(`@${a.toLowerCase()}`);
  if (node.place) cues.add(`#${node.place.toLowerCase()}`);
  for (const t of node.tags ?? []) cues.add(t.toLowerCase());
  for (const t of tokenSet(node.gist)) cues.add(t);
  return [...cues];
}

export function buildIndex(brain: BrainState): BrainIndex {
  const byCue = new Map<string, string[]>();
  const adjacency = new Map<string, MemoryEdge[]>();
  const fan = new Map<string, number>();

  for (const node of Object.values(brain.nodes)) {
    for (const cue of nodeCues(node)) {
      const list = byCue.get(cue);
      if (list) list.push(node.id);
      else byCue.set(cue, [node.id]);
    }
  }
  for (const [cue, ids] of byCue) fan.set(cue, ids.length);

  for (const e of brain.edges) {
    push(adjacency, e.from, e);
    push(adjacency, e.to, e);
  }
  return { byCue, adjacency, fan };
}

function push(map: Map<string, MemoryEdge[]>, key: string, edge: MemoryEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

/** Neighbours one hop out, with the edge weight that got us there. */
export function neighbors(index: BrainIndex, nodeId: string): { id: string; weight: number; kind: EdgeKind }[] {
  const out: { id: string; weight: number; kind: EdgeKind }[] = [];
  for (const e of index.adjacency.get(nodeId) ?? []) {
    const other = e.from === nodeId ? e.to : e.from;
    if (other !== nodeId) out.push({ id: other, weight: e.weight, kind: e.kind });
  }
  return out;
}

export function addEdge(
  brain: BrainState,
  from: string,
  to: string,
  kind: EdgeKind,
  weight = 0.5,
  note?: string,
): MemoryEdge | null {
  if (from === to) return null;
  if (!brain.nodes[from] || !brain.nodes[to]) return null;
  const existing = brain.edges.find(
    (e) => e.kind === kind && ((e.from === from && e.to === to) || (e.from === to && e.to === from)),
  );
  if (existing) {
    // Repeated association strengthens the link, with diminishing returns.
    existing.weight = Math.min(1, existing.weight + (1 - existing.weight) * 0.35);
    if (note && !existing.note) existing.note = note;
    return existing;
  }
  const edge: MemoryEdge = { from, to, kind, weight: Math.min(1, Math.max(0.05, weight)), createdAt: Date.now(), note };
  brain.edges.push(edge);
  return edge;
}

export function removeNodeEdges(brain: BrainState, nodeId: string): void {
  brain.edges = brain.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
}

/**
 * Infer associative links for a freshly encoded node.
 *
 * Shared actors and places are strong binders; semantic overlap is a weaker
 * `reminds_of`. This is what turns a list of events into the network the brief
 * asks for — one action connected to several others, by *typed* relations.
 */
export function autoLink(brain: BrainState, node: MemoryNode, opts: { maxLinks?: number; minSimilarity?: number } = {}): MemoryEdge[] {
  const maxLinks = opts.maxLinks ?? 6;
  const minSim = opts.minSimilarity ?? 0.18;
  const made: MemoryEdge[] = [];

  const candidates: { id: string; score: number; kind: EdgeKind }[] = [];
  const actors = new Set((node.actors ?? []).map((a) => a.toLowerCase()));

  for (const other of Object.values(brain.nodes)) {
    if (other.id === node.id) continue;
    let score = 0;
    let kind: EdgeKind = 'reminds_of';

    const sharedActors = (other.actors ?? []).filter((a) => actors.has(a.toLowerCase()));
    if (sharedActors.length) {
      score += 0.35 * Math.min(1, sharedActors.length / 2);
      kind = 'about_person';
    }
    if (node.place && other.place && node.place.toLowerCase() === other.place.toLowerCase()) {
      score += 0.25;
      if (kind === 'reminds_of') kind = 'at_place';
    }
    const sim = similarity(node.gist, other.gist);
    if (sim >= minSim) score += sim;
    // Recency of the other memory matters: we associate with what is currently alive.
    if (other.status === 'active') score += 0.08;

    if (score >= 0.3) candidates.push({ id: other.id, score, kind });
  }

  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates.slice(0, maxLinks)) {
    const edge = addEdge(brain, node.id, c.id, c.kind, Math.min(0.9, 0.25 + c.score * 0.5));
    if (edge) made.push(edge);
  }
  return made;
}

/** Weight decay for edges that never get traversed — associations fade too. */
export function decayEdges(brain: BrainState, factor = 0.995, floor = 0.04): number {
  let dropped = 0;
  brain.edges = brain.edges.filter((e) => {
    e.weight *= factor;
    if (e.weight < floor) { dropped++; return false; }
    return true;
  });
  return dropped;
}

/** Nodes that compete with this one for the same cues — the RIF victims (§7.4). */
export function competitorsOf(index: BrainIndex, node: MemoryNode, exclude: Set<string>): string[] {
  const counts = new Map<string, number>();
  for (const cue of nodeCues(node)) {
    for (const id of index.byCue.get(cue) ?? []) {
      if (id === node.id || exclude.has(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => id);
}
