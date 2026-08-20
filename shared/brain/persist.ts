/**
 * Merge what a generation changed onto a brain that may have been written
 * by a concurrent consolidation pass.
 *
 * Lives here, not in the server, so it is pure and the lived-behaviour
 * suite can pin it without loading providers.
 */
import type { BrainState } from './types';

/**
 * Re-apply retrieval and volition writes onto a freshly loaded brain.
 *
 * Retrieval used to persist four fields and silently drop everything the
 * new layer writes — synapse, distortions, intention, steer, working
 * memory. Those writes are the whole point of the layer.
 *
 * Still conservative about *nodes*: a memory consolidation wrote while
 * we were generating is never overwritten, and a node that was pruned
 * in the meantime is not resurrected.
 */
export function mergeGenerationEffects(fresh: BrainState, stale: BrainState): void {
  for (const [id, staleNode] of Object.entries(stale.nodes)) {
    const node = fresh.nodes[id];
    if (!node) continue;
    if (staleNode.useCount > node.useCount) {
      node.useCount = staleNode.useCount;
      node.uses = staleNode.uses;
      node.lastRetrievedAt = staleNode.lastRetrievedAt;
      if (node.status !== 'active') node.status = staleNode.status;
      if (staleNode.synapse) node.synapse = staleNode.synapse;
      if (staleNode.distortions) node.distortions = staleNode.distortions;
      if (staleNode.perceivedAt) node.perceivedAt = staleNode.perceivedAt;
      node.fidelity = staleNode.fidelity;
      node.confidence = staleNode.confidence;
      node.gist = staleNode.gist;
      node.actors = staleNode.actors;
      node.affect = staleNode.affect;
      node.contextBinding = staleNode.contextBinding;
      node.intrusive = staleNode.intrusive;
      if (staleNode.verbatim === undefined) node.verbatim = undefined;
    }
    node.suppressed = Math.max(node.suppressed ?? 0, staleNode.suppressed ?? 0);
  }
  fresh.stats.totalRecalls = Math.max(fresh.stats.totalRecalls, stale.stats.totalRecalls);

  mergeIntention(fresh, stale);
  mergeSteer(fresh, stale);

  if (stale.working?.length) {
    const staleNewest = Math.max(...stale.working.map((s) => s.heldAt));
    const freshNewest = fresh.working?.length
      ? Math.max(...fresh.working.map((s) => s.heldAt))
      : 0;
    if (staleNewest >= freshNewest) fresh.working = stale.working;
  }

  if (stale.aliases && Object.keys(stale.aliases).length) {
    fresh.aliases = { ...(fresh.aliases ?? {}), ...stale.aliases };
  }
}

function mergeIntention(fresh: BrainState, stale: BrainState): void {
  if (!stale.intention) return;
  const f = fresh.intention;
  if (!f || stale.intention.formedAt > f.formedAt) {
    fresh.intention = stale.intention;
    return;
  }
  if (f.id !== stale.intention.id) return;
  f.ttl = Math.min(f.ttl, stale.intention.ttl);
  if (stale.intention.status !== 'active' && f.status === 'active') {
    f.status = stale.intention.status;
    f.progress = stale.intention.progress;
  } else if (Math.abs(stale.intention.progress) > Math.abs(f.progress)) {
    f.progress = stale.intention.progress;
  }
}

function mergeSteer(fresh: BrainState, stale: BrainState): void {
  if (!stale.steer) return;
  const f = fresh.steer;
  if (!f || stale.steer.setAt > f.setAt) {
    fresh.steer = stale.steer;
    return;
  }
  if (stale.steer.setAt === f.setAt && stale.steer.text === f.text) {
    f.ttl = Math.min(f.ttl, stale.steer.ttl);
  }
}
