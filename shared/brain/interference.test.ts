/**
 * Interference — memories blurring into each other at rest.
 *
 * The property that has to hold above every other: a graph of *distinct*
 * memories must score exactly as it did before this mechanism existed. The
 * engine's thresholds were calibrated without it, and a term that leaks a small
 * penalty everywhere would shift all of them at once.
 */
import { describe, expect, it } from 'vitest';
import { emptyBrain } from './defaults';
import { buildIndex } from './graph';
import {
  MIN_OVERLAP, immuneToInterference, interferenceLoad, interferencePenalty,
  recomputeInterference,
} from './interference';
import { consolidate } from './consolidation';
import { heuristicEncode } from './heuristics';
import type { BrainState, MemoryKind, MemoryNode } from './types';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

function node(
  id: string,
  gist: string,
  opts: { kind?: MemoryKind; at?: number; actors?: string[]; pinned?: boolean } = {},
): MemoryNode {
  return {
    id,
    kind: opts.kind ?? 'episodic',
    gist,
    encodedAt: opts.at ?? T0,
    uses: [opts.at ?? T0],
    useCount: 1,
    permanentBoost: 0.7,
    affect: { valence: -0.3, arousal: 0.4, dominance: 0, label: 'sadness' },
    appraisal: {
      novelty: 0.4, pleasantness: -0.3, goalRelevance: 0.4, goalConduciveness: -0.3,
      agency: 'other', intent: -0.3, copingPotential: 0.5, norms: 0, urgency: 0.3,
    },
    vividness: 0.5,
    confidence: 0.6,
    fidelity: 0.8,
    actors: opts.actors ?? ['Rooke'],
    tags: [],
    contextBinding: 0.7,
    suppressed: 0,
    status: 'active',
    pinned: opts.pinned,
  };
}

function brainOf(nodes: MemoryNode[]): BrainState {
  const b = emptyBrain('chat', 'wren', 'Scarlet Wren', T0);
  for (const n of nodes) b.nodes[n.id] = n;
  return b;
}

describe('distinct memories do not interfere at all', () => {
  it('scores zero for a graph with nothing similar in it', () => {
    const b = brainOf([
      node('a', 'Rooke burned the ledger in the dock office'),
      node('b', 'A gull settled on the railing at low tide', { actors: ['Nobody'] }),
      node('c', 'The lamp guttered and went out entirely', { actors: ['Nobody'] }),
    ]);
    const index = buildIndex(b);
    for (const n of Object.values(b.nodes)) {
      expect(interferenceLoad(b, n, index)).toBe(0);
    }
    expect(recomputeInterference(b, index)).toBe(0);
    expect(b.nodes.a.interference).toBeUndefined();
  });

  it('leaves the field undefined rather than zero, so nothing new is written', () => {
    const b = brainOf([node('a', 'Rooke burned the ledger in the dock office')]);
    recomputeInterference(b, buildIndex(b));
    expect('interference' in b.nodes.a && b.nodes.a.interference !== undefined).toBe(false);
  });

  it('ignores overlap below the floor', () => {
    expect(interferencePenalty(0)).toBe(0);
    // One near-twin at exactly the floor still counts; anything under it does not.
    const b = brainOf([
      node('a', 'Rooke burned the ledger in the dock office tonight'),
      node('b', 'Rooke burned the ledger in the dock office tonight'),
    ]);
    const load = interferenceLoad(b, b.nodes.a, buildIndex(b));
    expect(load).toBeGreaterThan(MIN_OVERLAP);
  });
});

describe('near-twins blur', () => {
  const twins = () => brainOf([
    node('n1', 'Rooke lied about the ledger in the dock office', { at: T0 }),
    node('n2', 'Rooke lied about the ledger in the dock office again', { at: T0 + DAY }),
    node('n3', 'Rooke lied about the ledger in the dock office once more', { at: T0 + 2 * DAY }),
  ]);

  it('costs a memory activation once it has near-twins', () => {
    const b = twins();
    const affected = recomputeInterference(b, buildIndex(b));
    expect(affected).toBe(3);
    expect(b.nodes.n1.interference!).toBeGreaterThan(0);
  });

  it('weights new-disrupting-old above old-disrupting-new', () => {
    const b = twins();
    const index = buildIndex(b);
    // n1 is oldest: both twins are newer, so all its load is retroactive.
    // n3 is newest: both twins are older, so all its load is proactive.
    expect(interferenceLoad(b, b.nodes.n1, index))
      .toBeGreaterThan(interferenceLoad(b, b.nodes.n3, index));
  });

  it('is capped — the tenth near-twin barely registers', () => {
    expect(interferencePenalty(1000)).toBeLessThanOrEqual(0.45);
    expect(interferencePenalty(1000)).toBeCloseTo(interferencePenalty(100), 3);
    // …and each further twin costs less than the one before it.
    const first = interferencePenalty(1) - interferencePenalty(0.5);
    const later = interferencePenalty(2) - interferencePenalty(1.5);
    expect(first).toBeGreaterThan(later);
  });

  it('clears again when the twins are gone', () => {
    const b = twins();
    recomputeInterference(b, buildIndex(b));
    expect(b.nodes.n1.interference).toBeGreaterThan(0);
    delete b.nodes.n2;
    delete b.nodes.n3;
    recomputeInterference(b, buildIndex(b));
    expect(b.nodes.n1.interference).toBeUndefined();
  });

  it('does not count a dormant twin — it is already out of reach', () => {
    const b = twins();
    const withAll = interferenceLoad(b, b.nodes.n1, buildIndex(b));
    b.nodes.n2.status = 'dormant';
    b.nodes.n3.status = 'dormant';
    expect(interferenceLoad(b, b.nodes.n1, buildIndex(b))).toBeLessThan(withAll);
  });
});

describe('what never blurs', () => {
  it('exempts the kinds the rest of the engine already privileges', () => {
    expect(immuneToInterference(node('s', 'x', { kind: 'sensory' }))).toBe(true);
    expect(immuneToInterference(node('i', 'x', { kind: 'identity' }))).toBe(true);
    expect(immuneToInterference(node('c', 'x', { kind: 'schema' }))).toBe(true);
    expect(immuneToInterference(node('p', 'x', { pinned: true }))).toBe(true);
    expect(immuneToInterference(node('e', 'x'))).toBe(false);
  });

  /**
   * A trauma fragment that faded into its neighbours would stop intruding, which
   * is the opposite of what trauma does.
   */
  it('leaves a sensory fragment fully available among its own near-twins', () => {
    const b = brainOf([
      node('s', 'The number hitting like ice water, her voice thinning', { kind: 'sensory' }),
      node('a', 'The number hitting like ice water, her voice thinning out'),
      node('b', 'The number hitting like ice water, her voice thinning away'),
    ]);
    recomputeInterference(b, buildIndex(b));
    expect(b.nodes.s.interference).toBeUndefined();
    expect(b.nodes.a.interference).toBeGreaterThan(0);
  });

  it('does not let a sensory fragment blur anything else either', () => {
    const b = brainOf([
      node('a', 'Rooke lied about the ledger in the dock office'),
      node('s', 'Rooke lied about the ledger in the dock office', { kind: 'sensory' }),
    ]);
    expect(interferenceLoad(b, b.nodes.a, buildIndex(b))).toBe(0);
  });
});

describe('wiring', () => {
  it('runs on a maintenance pass and reports how many memories it touched', () => {
    const b = emptyBrain('dock', 'wren', 'Scarlet Wren', T0);
    const turns = [
      { id: 'm1', speaker: 'Rooke', text: 'I lied about the ledger. I burned it and I lied.', isUser: true },
      { id: 'm2', speaker: 'Scarlet Wren', text: 'You promised me you would keep it safe for me.', isUser: false },
    ];
    let id = 0;
    const report = consolidate(b, {
      events: heuristicEncode(turns, 'Scarlet Wren'),
      now: T0,
      makeId: () => `n${++id}`,
      cast: ['Rooke'],
      maintenance: true,
    });
    expect(report.interfered).toBeDefined();
  });

  it('is skipped entirely when the pass is not a maintenance pass', () => {
    const b = emptyBrain('dock', 'wren', 'Scarlet Wren', T0);
    let id = 0;
    const report = consolidate(b, {
      events: [],
      now: T0,
      makeId: () => `n${++id}`,
      cast: ['Rooke'],
      maintenance: false,
    });
    expect(report.interfered).toBeUndefined();
  });
});
