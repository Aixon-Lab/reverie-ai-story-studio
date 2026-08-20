/**
 * Meta-memory — why a belief is held, so it can collapse when its evidence
 * does (§B.2 #7).
 *
 * A schema used to be a conclusion with no memory of what produced it.
 * `instance_of` edges pointed at the parent, but nothing *read* them when
 * those episodes faded or were contradicted, so a belief outlived every
 * reason for holding it. That is the opposite of how people change their
 * minds: they change them when the cases they were counting on fall apart.
 *
 * The warrant is the missing record. It is attached when a semantic or
 * schema is abstracted from episodes, recomputed on maintenance, and when
 * support drops far enough the belief loses conviction — and, if nothing
 * remains, fades. The prompt is never told "this belief is collapsing";
 * it just sees a less certain conclusion, which is how the character
 * actually holds it.
 *
 * Pure. Time is passed in.
 */
import { clamp01 } from './activation';
import { addEdge } from './graph';
import type { BrainState, MemoryNode, Warrant } from './types';

/** Support below this is no longer a reason to hold the belief firmly. */
export const WEAK_SUPPORT = 0.35;
/** Support below this means the belief has nothing left under it. */
export const COLLAPSE_SUPPORT = 0.12;

export function attachWarrant(
  brain: BrainState,
  belief: MemoryNode,
  evidence: MemoryNode[],
  rationale: string,
): Warrant {
  const ids = evidence.map((n) => n.id);
  const warrant: Warrant = {
    rationale: rationale.trim(),
    evidence: ids,
    support: 1,
  };
  belief.warrant = warrant;

  for (const src of evidence) {
    addEdge(brain, belief.id, src.id, 'derived_from', 0.7, 'abstracted from');
    addEdge(brain, src.id, belief.id, 'supports', 0.7);
    // instance_of already exists on the semanticise/schema path; derived_from
    // is the typed warrant edge the collapse pass reads.
  }

  return warrant;
}

/**
 * Re-read every warrant from the evidence that is still standing.
 *
 * An episode that has gone dormant, been contradicted, or been pruned no
 * longer counts. Support is the fraction of listed evidence that is still
 * an active, reasonably faithful trace. Confidence on the belief is then
 * pulled toward that number — never raised by this pass, only lowered,
 * because losing evidence should not make anyone *more* sure.
 */
export function recomputeWarrants(brain: BrainState): { weakened: string[]; collapsed: string[] } {
  const weakened: string[] = [];
  const collapsed: string[] = [];

  for (const node of Object.values(brain.nodes)) {
    const w = node.warrant;
    if (!w || !w.evidence.length) continue;
    if (node.kind !== 'schema' && node.kind !== 'semantic') continue;

    const contradicted = new Set(
      brain.edges
        .filter((e) => e.kind === 'contradicts' && (e.to === node.id || w.evidence.includes(e.to) || w.evidence.includes(e.from)))
        .flatMap((e) => [e.from, e.to]),
    );

    let living = 0;
    const still: string[] = [];
    for (const id of w.evidence) {
      const ev = brain.nodes[id];
      if (!ev) continue;
      still.push(id);
      if (ev.status === 'dormant') continue;
      if (contradicted.has(id)) continue;
      const quality = clamp01(ev.fidelity) * (ev.status === 'faded' ? 0.45 : 1);
      living += quality;
    }
    w.evidence = still;
    const next = still.length ? clamp01(living / still.length) : 0;
    const before = w.support;
    w.support = next;

    if (next < before - 0.04) {
      // Conviction follows the evidence down, never up.
      const drop = (before - next) * 0.55;
      node.confidence = clamp01(node.confidence - drop);
      weakened.push(node.id);
    }

    if (next <= COLLAPSE_SUPPORT) {
      node.confidence = clamp01(Math.min(node.confidence, 0.28));
      if (node.status === 'active' && !node.pinned) node.status = 'faded';
      collapsed.push(node.id);
    } else if (next <= WEAK_SUPPORT && node.confidence > 0.55) {
      node.confidence = clamp01(0.55);
    }
  }

  return { weakened, collapsed };
}

/** One line for the Mind page. Empty when there is no warrant. */
export function describeWarrant(node: MemoryNode): string {
  const w = node.warrant;
  if (!w) return '';
  const n = w.evidence.length;
  const how = w.support > 0.7
    ? 'still well supported'
    : w.support > WEAK_SUPPORT
      ? 'the reasons are thinning'
      : w.support > COLLAPSE_SUPPORT
        ? 'almost nothing left under it'
        : 'the reasons have gone';
  const ev = n === 0 ? 'no remaining cases' : n === 1 ? 'one case' : `${n} cases`;
  return `${w.rationale} — ${ev}, ${how}.`;
}
