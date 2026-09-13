/**
 * Interference — the forgetting we were not modelling.
 *
 * The engine has two forgetting mechanisms and both are *event-driven*: traces
 * decay with time (`activation.ts`), and rivals that lose a retrieval get
 * suppressed (RIF, `retrieval.ts`). What is missing is the one that dominates
 * in humans. Most forgetting is not decay and not competition at the moment of
 * asking — it is **similar memories blurring into each other at rest**. Five
 * evenings in the same room with the same person do not stay five evenings. The
 * gist survives, the individual episodes stop being separately reachable, and
 * what you finally recall is a composite that never happened.
 *
 * The fan effect in `assocStrength` is related but is not this. Fan measures how
 * many nodes a *cue* points at, so it punishes a popular cue. Interference is a
 * property of the *memory*: a node with four near-twins is hard to single out
 * even when the cue is perfectly specific.
 *
 * Two design commitments:
 *
 *   **Computed offline, read on the hot path.** Pairwise similarity over every
 *   node on every recall would be O(n²) per turn. This runs in the consolidation
 *   pass — the sleep phase, which is exactly where the biology puts it — and
 *   writes one scalar per node. Recall subtracts a stored number.
 *
 *   **Exactly zero unless there is a real near-twin.** Similarity below
 *   `MIN_OVERLAP` contributes nothing at all, so a brain full of distinct
 *   memories is scored exactly as it is today. This is what makes the mechanism
 *   safe to add to brains already on disk: it can only affect the specific
 *   configuration it was built for.
 *
 * Asymmetry follows the standard finding that retroactive interference (new
 * material disrupting old) is stronger than proactive (old disrupting new).
 *
 * Pure. Time is passed in.
 */
import { clamp01, similarity } from './activation';
import { nodeCues, type BrainIndex } from './graph';
import type { BrainState, MemoryNode } from './types';

/** Below this, two memories are simply different and do not interfere at all. */
export const MIN_OVERLAP = 0.34;

/** New material disrupting old. */
const RETROACTIVE = 0.6;
/** Old material disrupting new — real, and weaker. */
const PROACTIVE = 0.4;

/**
 * How much activation the worst-interfered memory can lose.
 *
 * Deliberately smaller than the fade threshold's distance from zero: interference
 * should make a memory hard to single out, never delete it. The composite is
 * still there, and `reconstruction.ts` is what renders the blur.
 */
const MAX_PENALTY = 0.45;

/** Only this many candidates are scored per node — the tail is never the twin. */
const MAX_CANDIDATES = 24;

/**
 * Memories that do not blur.
 *
 * Sensory fragments are the point of trauma: an S-rep that faded into its
 * neighbours would stop intruding, which is the opposite of what trauma does.
 * Identity nodes and pinned nodes are privileged everywhere else in the engine
 * and are privileged here. Schemas are *supposed* to subsume their instances —
 * that is what a generalisation is — so interfering with them would punish the
 * abstraction for doing its job.
 */
export function immuneToInterference(node: MemoryNode): boolean {
  return node.kind === 'sensory'
    || node.kind === 'identity'
    || node.kind === 'schema'
    || node.pinned === true;
}

/**
 * Candidate near-twins for one node, cheaply.
 *
 * Anything that could interfere must share retrieval cues, so the cue index is a
 * sound filter: a node with no cue in common cannot be a near-duplicate. Two
 * shared cues is the same bar `competitorsOf` uses for RIF.
 */
function candidatesFor(index: BrainIndex, node: MemoryNode): string[] {
  const counts = new Map<string, number>();
  for (const cue of nodeCues(node)) {
    for (const id of index.byCue.get(cue) ?? []) {
      if (id === node.id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATES)
    .map(([id]) => id);
}

/**
 * Raw interference load on one node: Σ_j w_j · sim(i, j) over its near-twins.
 *
 * Returned before damping so it can be inspected and tested directly. Zero when
 * nothing is similar enough to count.
 */
export function interferenceLoad(
  brain: BrainState,
  node: MemoryNode,
  index: BrainIndex,
): number {
  if (immuneToInterference(node)) return 0;
  let load = 0;
  for (const id of candidatesFor(index, node)) {
    const other = brain.nodes[id];
    if (!other || other.status === 'dormant') continue;
    if (other.kind === 'sensory') continue;
    const sim = similarity(node.gist, other.gist);
    if (sim < MIN_OVERLAP) continue;
    // Which direction the disruption runs is decided by which memory is newer.
    const weight = other.encodedAt > node.encodedAt ? RETROACTIVE : PROACTIVE;
    load += weight * sim;
  }
  return load;
}

/**
 * Load → the activation a memory actually loses.
 *
 * Logarithmic and capped. The first near-twin costs the most; the tenth barely
 * registers, because by then the memory is already a composite and there is
 * nothing further to lose.
 */
export function interferencePenalty(load: number): number {
  if (load <= 0) return 0;
  return Math.min(MAX_PENALTY, MAX_PENALTY * clamp01(Math.log1p(load) / Math.log1p(3)));
}

/**
 * Recompute stored interference for the whole graph.
 *
 * Called from the consolidation pass, not from recall. Writes `undefined` rather
 * than `0` when there is no interference, so a brain that has never blurred
 * anything carries no extra bytes and reads exactly as it did before.
 */
export function recomputeInterference(brain: BrainState, index: BrainIndex): number {
  let affected = 0;
  for (const node of Object.values(brain.nodes)) {
    const load = interferenceLoad(brain, node, index);
    const penalty = interferencePenalty(load);
    if (penalty > 0) {
      node.interference = penalty;
      affected++;
    } else if (node.interference !== undefined) {
      node.interference = undefined;
    }
  }
  return affected;
}
