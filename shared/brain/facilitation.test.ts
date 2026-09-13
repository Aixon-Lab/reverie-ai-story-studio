/**
 * Retrieval-induced facilitation only happens when the caller hands the effects
 * pass an index.
 *
 * `applyRetrievalEffects` guards its priming loop on `if (index)`, and the one
 * production call site — `buildBrainContext` — used to omit it. The suppressive
 * half of retrieval competition ran; the facilitatory half never did. Recall
 * could make a neighbour harder to reach and never easier, which is precisely
 * the flatness the synapse layer exists to remove.
 *
 * This pins both halves: the effect exists, and the wiring that carries it.
 */
import { describe, expect, it } from 'vitest';
import { emptyBrain } from './defaults';
import { addEdge } from './graph';
import { cueFromContext, recall, applyRetrievalEffects } from './retrieval';
import { ensureSynapse } from './synapse';
import type { BrainState, MemoryNode } from './types';

const T0 = 1_700_000_000_000;

function node(
  id: string,
  gist: string,
  actors: string[],
  opts: { boost?: number; encodedAt?: number } = {},
): MemoryNode {
  const at = opts.encodedAt ?? T0;
  return {
    id,
    kind: 'episodic',
    gist,
    encodedAt: at,
    uses: [at],
    useCount: 1,
    permanentBoost: opts.boost ?? 1.2,
    affect: { valence: -0.5, arousal: 0.6, dominance: -0.2, label: 'fear' },
    appraisal: {
      novelty: 0.5, pleasantness: -0.4, goalRelevance: 0.6, goalConduciveness: -0.5,
      agency: 'other', intent: -0.5, copingPotential: 0.4, norms: -0.3, urgency: 0.4,
    },
    vividness: 0.6,
    confidence: 0.7,
    fidelity: 0.8,
    actors,
    tags: [],
    contextBinding: 0.7,
    suppressed: 0,
    status: 'active',
  };
}

function brainWithPair(): BrainState {
  const b = emptyBrain('chat', 'wren', 'Scarlet Wren', T0);
  b.nodes.hit = node('hit', 'Rooke burned the ledger in the dock office', ['Rooke']);
  /**
   * Deliberately unreachable on its own: no cue tokens in common with the probe,
   * no emotional boost, and weeks old. It must not clear the threshold, because
   * a neighbour that gets recalled anyway would be primed by the ordinary hit
   * path and prove nothing about facilitation.
   */
  b.nodes.near = node('near', 'A gull on the railing at low tide', ['Gull Keeper'], {
    boost: 0,
    encodedAt: T0 - 40 * 86_400_000,
  });
  addEdge(b, 'hit', 'near', 'reminds_of', 0.8);
  return b;
}

function cueFor(b: BrainState) {
  return cueFromContext({
    recentText: 'Rooke burned the ledger',
    actors: ['Rooke'],
    brain: b,
    now: T0 + 60_000,
  });
}

describe('remembering something primes what it is wired to', () => {
  it('lifts a neighbour that did not itself get recalled', () => {
    const b = brainWithPair();
    const before = ensureSynapse(b.nodes.near, T0).facilitation;

    const result = recall(b, cueFor(b), { rng: () => 0.5 });
    expect(result.hits.some((h) => h.node.id === 'hit')).toBe(true);
    expect(result.hits.some((h) => h.node.id === 'near')).toBe(false);

    applyRetrievalEffects(b, result.hits, result.competitors, T0 + 60_000, result.index, () => 0.5);
    expect(b.nodes.near.synapse!.facilitation).toBeGreaterThan(before);
  });

  it('is lost entirely when the index is not passed — the shape of the old bug', () => {
    const b = brainWithPair();
    const before = ensureSynapse(b.nodes.near, T0).facilitation;
    const result = recall(b, cueFor(b), { rng: () => 0.5 });

    applyRetrievalEffects(b, result.hits, result.competitors, T0 + 60_000, undefined, () => 0.5);
    expect(b.nodes.near.synapse!.facilitation).toBe(before);
  });

  it('recall hands back the index it used, so the caller never has to rebuild one', () => {
    const b = brainWithPair();
    const result = recall(b, cueFor(b), { rng: () => 0.5 });
    expect(result.index.byCue.size).toBeGreaterThan(0);
    expect(result.index.adjacency.get('hit')?.length).toBe(1);
  });

  /** Priming must never *spend* the neighbour — facilitation without depression. */
  it('primes without consuming the neighbour', () => {
    const b = brainWithPair();
    const resources = ensureSynapse(b.nodes.near, T0).resources;
    const result = recall(b, cueFor(b), { rng: () => 0.5 });
    applyRetrievalEffects(b, result.hits, result.competitors, T0 + 60_000, result.index, () => 0.5);
    expect(b.nodes.near.synapse!.resources).toBeCloseTo(resources, 5);
  });
});
