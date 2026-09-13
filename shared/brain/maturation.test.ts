/**
 * Engram maturation — a trace is not the memory it will become.
 *
 * Two things have to be true at once, and they pull against each other:
 *
 *   1. A memory made moments ago must be *outranked* by an established one, so
 *      the memory budget stops being spent on events the model can already read
 *      in the transcript.
 *   2. It must never be *unreachable*, and it must never delay anything the
 *      engine already treats as immediate — a flashbulb memory, an identity
 *      belief, a trauma fragment that intrudes the same night.
 *
 * Plus the migration property that governs every addition to this engine: a
 * brain written before the field existed must score exactly as it did before.
 */
import { describe, expect, it } from 'vitest';
import { emptyBrain } from './defaults';
import {
  FLASHBULB_BOOST, HALF_LIFE_PASSES, MAX_WITHHELD,
  maturationTerm, maturesInstantly, maturity,
} from './maturation';
import { encodeEvent } from './encoding';
import { cueFromContext, recall } from './retrieval';
import type { AppraisedEvent, BrainState, MemoryKind, MemoryNode } from './types';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

function node(
  id: string,
  opts: { kind?: MemoryKind; pass?: number; boost?: number; at?: number; pinned?: boolean; intrusive?: boolean } = {},
): MemoryNode {
  const at = opts.at ?? T0;
  return {
    id,
    kind: opts.kind ?? 'episodic',
    gist: `Rooke said something about the ledger (${id})`,
    encodedAt: at,
    uses: [at],
    useCount: 1,
    permanentBoost: opts.boost ?? 0.7,
    affect: { valence: -0.3, arousal: 0.4, dominance: 0, label: 'sadness' },
    appraisal: {
      novelty: 0.4, pleasantness: -0.3, goalRelevance: 0.4, goalConduciveness: -0.3,
      agency: 'other', intent: -0.3, copingPotential: 0.5, norms: 0, urgency: 0.3,
    },
    vividness: 0.5,
    confidence: 0.6,
    fidelity: 0.8,
    actors: ['Rooke'],
    tags: [],
    contextBinding: 0.7,
    suppressed: 0,
    status: 'active',
    encodedAtPass: opts.pass,
    pinned: opts.pinned,
    intrusive: opts.intrusive,
  };
}

function brainAtPass(updates: number): BrainState {
  const b = emptyBrain('chat', 'wren', 'Scarlet Wren', T0);
  b.stats.updates = updates;
  return b;
}

describe('the curve', () => {
  it('withholds most from a trace one pass old and nothing from a settled one', () => {
    const b = brainAtPass(1);
    expect(maturationTerm(node('fresh', { pass: 0 }), b)).toBeLessThan(-0.3);

    const later = brainAtPass(6);
    expect(maturationTerm(node('old', { pass: 0 }), later)).toBe(0);
  });

  it('settles monotonically', () => {
    const seen: number[] = [];
    for (let pass = 1; pass <= 6; pass++) {
      seen.push(maturity(node('n', { pass: 0 }), brainAtPass(pass)));
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[seen.length - 1]).toBeCloseTo(1, 2);
  });

  it('is half settled at the half-life', () => {
    const b = brainAtPass(HALF_LIFE_PASSES);
    expect(maturity(node('n', { pass: 0 }), b)).toBeCloseTo(0.5, 6);
  });

  it('never withholds more than the ceiling, and never adds activation', () => {
    for (let pass = 0; pass <= 12; pass++) {
      const t = maturationTerm(node('n', { pass: 0 }), brainAtPass(pass));
      expect(t).toBeLessThanOrEqual(0);
      expect(t).toBeGreaterThanOrEqual(-MAX_WITHHELD);
    }
  });

  it('cannot go negative on the pass counter if updates ever rewinds', () => {
    // A repaired or rolled-back `stats.updates` must not produce a boost.
    expect(maturationTerm(node('n', { pass: 9 }), brainAtPass(2))).toBeLessThanOrEqual(0);
    expect(maturity(node('n', { pass: 9 }), brainAtPass(2))).toBeGreaterThan(0);
  });
});

describe('migration: a brain written before this existed is untouched', () => {
  it('treats a node with no encode pass as fully settled', () => {
    expect(maturity(node('legacy'), brainAtPass(0))).toBe(1);
    expect(maturationTerm(node('legacy'), brainAtPass(0))).toBe(0);
    expect(maturationTerm(node('legacy'), brainAtPass(500))).toBe(0);
  });
});

describe('what is available the instant it exists', () => {
  it('exempts identity, sensory, intrusive, pinned and flashbulb traces', () => {
    expect(maturesInstantly(node('i', { kind: 'identity', pass: 0 }))).toBe(true);
    expect(maturesInstantly(node('s', { kind: 'sensory', pass: 0 }))).toBe(true);
    expect(maturesInstantly(node('x', { intrusive: true, pass: 0 }))).toBe(true);
    expect(maturesInstantly(node('p', { pinned: true, pass: 0 }))).toBe(true);
    expect(maturesInstantly(node('f', { boost: FLASHBULB_BOOST, pass: 0 }))).toBe(true);
    expect(maturesInstantly(node('e', { pass: 0 }))).toBe(false);
  });

  it('gives a flashback its full activation on the pass it was formed', () => {
    const b = brainAtPass(1);
    expect(maturationTerm(node('s', { kind: 'sensory', pass: 0 }), b)).toBe(0);
  });
});

describe('what it does to actual recall', () => {
  /**
   * The behaviour the mechanism exists for: a settled memory wins a close
   * contest against one made this scene, so the budget goes to what the model
   * cannot already see in the transcript.
   */
  it('lets an established memory outrank an otherwise identical fresh one', () => {
    const b = brainAtPass(1);
    b.nodes.settled = node('settled', { at: T0 - 2 * DAY });
    b.nodes.settled.gist = 'Rooke lied to her about the ledger';
    b.nodes.fresh = { ...node('fresh', { pass: 0, at: T0 - 2 * DAY }), id: 'fresh' };
    b.nodes.fresh.gist = 'Rooke lied to her about the ledger';

    const cue = cueFromContext({
      recentText: 'Rooke lied about the ledger',
      actors: ['Rooke'],
      brain: b,
      now: T0,
    });
    const result = recall(b, cue, { rng: () => 0.5, includeBelowThreshold: true });
    const settled = result.hits.find((h) => h.node.id === 'settled')!;
    const fresh = result.hits.find((h) => h.node.id === 'fresh')!;

    expect(fresh.breakdown.maturation).toBeLessThan(0);
    expect(settled.breakdown.maturation).toBe(0);
    expect(settled.activation).toBeGreaterThan(fresh.activation);
  });

  it('still keeps the fresh memory well clear of the retrieval floor', () => {
    const b = brainAtPass(1);
    b.nodes.fresh = node('fresh', { pass: 0 });
    const cue = cueFromContext({
      recentText: 'Rooke said something about the ledger',
      actors: ['Rooke'],
      brain: b,
      now: T0 + 60_000,
    });
    const result = recall(b, cue, { rng: () => 0.5 });
    expect(result.hits.map((h) => h.node.id)).toContain('fresh');
    expect(result.hits[0].activation).toBeGreaterThan(b.config.params.threshold);
  });

  it('reports the term in the breakdown so the Mind page can show it', () => {
    const b = brainAtPass(1);
    b.nodes.fresh = node('fresh', { pass: 0 });
    const cue = cueFromContext({ recentText: 'ledger', actors: ['Rooke'], brain: b, now: T0 });
    const [hit] = recall(b, cue, { rng: () => 0.5, includeBelowThreshold: true }).hits;
    expect(hit.breakdown).toHaveProperty('maturation');
    expect(hit.breakdown).toHaveProperty('interference');
  });
});

describe('the encoder stamps the pass', () => {
  it('records which pass laid the trace down', () => {
    const b = brainAtPass(4);
    const event: AppraisedEvent = {
      gist: 'Rooke burned the ledger and admitted he always meant to',
      actors: ['Rooke'],
      tags: [],
      appraisal: {
        novelty: 0.8, pleasantness: -0.8, goalRelevance: 0.9, goalConduciveness: -0.9,
        agency: 'other', intent: -0.8, copingPotential: 0.3, norms: -0.8, urgency: 0.7,
      },
      salience: 0.8,
      identityRelevant: false,
    };
    const result = encodeEvent(b, event, { now: T0, makeId: () => 'n1' });
    expect(result.node?.encodedAtPass).toBe(4);
  });
});
