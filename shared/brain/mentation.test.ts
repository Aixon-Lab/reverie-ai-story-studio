/**
 * The idle mind.
 *
 * The first group is the most important: an idle loop that is not genuinely free
 * when there is nothing to do cannot be run often enough to matter, and one that
 * produces a development every tick is noise rather than an inner life.
 */
import { describe, expect, it } from 'vitest';
import { TIME_UNIT_MS, emptyBrain, neutralAffect, neutralTraits } from './defaults';
import { emptyPsyche } from '../psyche/defaults';
import { neutralAppraisal } from './emotion';
import { addEdge } from './graph';
import { MIN_TICK_MS, describeMentation, mentate } from './mentation';
import { markEligible } from './synapse';
import type { BrainState, MemoryNode } from './types';

const T0 = 1_700_000_000_000;
const DAY = TIME_UNIT_MS;
const HOUR = 3_600_000;

/** Deterministic uniform sequence — no Math.random anywhere in this file. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * The neutral draw. 0.5 is the *median* of the logistic noise distribution, so
 * it contributes exactly zero — recall ranks on activation alone and the tick
 * is fully deterministic. A draw of 0 would look neutral and is not: it is the
 * extreme negative tail, and it suppresses every memory in the brain.
 */
const neutral = () => 0.5;

function node(over: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'n1',
    kind: 'episodic',
    gist: 'the door was locked from the outside',
    encodedAt: T0 - 3 * DAY,
    uses: [T0 - 3 * DAY],
    useCount: 1,
    permanentBoost: 0.5,
    affect: { ...neutralAffect(), valence: -0.6, arousal: 0.6 },
    appraisal: neutralAppraisal(),
    vividness: 0.6,
    confidence: 0.7,
    fidelity: 0.8,
    actors: ['Rell'],
    tags: ['locked', 'door'],
    contextBinding: 0.7,
    suppressed: 0,
    status: 'active',
    ...over,
  };
}

function brain(nodes: MemoryNode[] = [], mutate: (b: BrainState) => void = () => {}): BrainState {
  const b = emptyBrain('chat', 'char', 'Rell', T0 - 10 * DAY);
  b.psyche = emptyPsyche(neutralTraits(), T0 - 10 * DAY);
  b.stats.lastMentationAt = T0 - DAY;
  for (const n of nodes) b.nodes[n.id] = n;
  mutate(b);
  return b;
}

function populated(count = 6, mutate: (b: BrainState) => void = () => {}): BrainState {
  const nodes = Array.from({ length: count }, (_, i) => node({
    id: `n${i}`,
    gist: `something happened involving the ${['door', 'window', 'cellar', 'gate', 'stair', 'yard'][i % 6]}`,
    encodedAt: T0 - (i + 2) * DAY,
    uses: [T0 - (i + 2) * DAY],
  }));
  return brain(nodes, mutate);
}

describe('the quiet path', () => {
  it('does nothing when barely any time has passed', () => {
    const b = populated();
    b.stats.lastMentationAt = T0 - 60_000;
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(r.quiet).toBe(true);
    expect(r.wandered).toEqual([]);
  });

  it('does nothing to a brain with almost nothing in it', () => {
    // Mood regression against an empty history is drift, not introspection.
    const b = brain([node()]);
    expect(mentate(b, { now: T0, makeId: () => 'x', rng: neutral }).quiet).toBe(true);
  });

  it('leaves the brain completely untouched on a quiet tick', () => {
    const b = populated();
    b.stats.lastMentationAt = T0 - 1000;
    const before = JSON.stringify(b);
    mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(JSON.stringify(b)).toBe(before);
  });

  it('runs anyway when forced', () => {
    const b = populated();
    b.stats.lastMentationAt = T0 - 1000;
    expect(mentate(b, { now: T0, makeId: () => 'x', rng: neutral, force: true }).quiet).toBe(false);
  });

  it('agrees with its own floor', () => {
    const b = populated();
    b.stats.lastMentationAt = T0 - MIN_TICK_MS - 1;
    expect(mentate(b, { now: T0, makeId: () => 'x', rng: neutral }).quiet).toBe(false);
  });

  it('says so plainly', () => {
    const b = populated();
    b.stats.lastMentationAt = T0 - 1000;
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(describeMentation(r, 'Rell')).toBe('Rell was still.');
  });
});

describe('wandering', () => {
  it('surfaces something when the mind is left alone', () => {
    const b = populated();
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(r.wandered.length).toBeGreaterThan(0);
  });

  it('surfaces a handful, not everything it knows', () => {
    const b = populated(30);
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(r.wandered.length).toBeLessThanOrEqual(3);
  });

  it('does not surface the same three things on every tick', () => {
    const rng = seeded(7);
    const b = populated(20);
    const seen = new Set<string>();
    for (let i = 1; i <= 8; i++) {
      b.stats.lastMentationAt = T0 + (i - 1) * 6 * HOUR;
      const r = mentate(b, { now: T0 + i * 6 * HOUR, makeId: () => `x${i}`, rng });
      for (const id of r.wandered) seen.add(id);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('counts as rehearsal — what surfaces gets stronger', () => {
    const b = populated();
    const before = Object.fromEntries(Object.values(b.nodes).map((n) => [n.id, n.useCount]));
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    for (const id of r.wandered) expect(b.nodes[id].useCount).toBeGreaterThan(before[id]);
  });

  it('never surfaces beliefs or self-defining memories as if they were events', () => {
    const b = populated(8, (x) => {
      x.nodes.s1 = node({ id: 's1', kind: 'schema', gist: 'doors are never really locked' });
      x.nodes.i1 = node({ id: 'i1', kind: 'identity', gist: 'the night they got out' });
    });
    for (let i = 1; i <= 6; i++) {
      b.stats.lastMentationAt = T0 + (i - 1) * 6 * HOUR;
      const r = mentate(b, { now: T0 + i * 6 * HOUR, makeId: () => 'x', rng: seeded(i) });
      expect(r.wandered).not.toContain('s1');
      expect(r.wandered).not.toContain('i1');
    }
  });
});

describe('rumination', () => {
  it('leaves a settled character alone', () => {
    const b = populated(8, (x) => {
      x.psyche!.load.level = 0.05;
      x.psyche!.defenseMaturity = 0.9;
    });
    expect(mentate(b, { now: T0, makeId: () => 'x', rng: neutral }).ruminated).toEqual([]);
  });

  it('chews on the raw and unresolved when the character is worn down', () => {
    const b = populated(8, (x) => {
      x.psyche!.load.level = 0.9;
      x.psyche!.defenseMaturity = 0.15;
      x.psyche!.condition.depression.brooding = 0.8;
    });
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(r.ruminated.length).toBeGreaterThan(0);
  });

  it('makes the memory stronger and less accurate, not clearer', () => {
    // The reason rumination maintains rather than resolves.
    const b = populated(8, (x) => {
      x.psyche!.load.level = 0.9;
      x.psyche!.defenseMaturity = 0.1;
      x.psyche!.condition.depression.brooding = 0.9;
    });
    const before = Object.fromEntries(Object.values(b.nodes).map((n) => [n.id, { ...n }]));
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(r.ruminated.length).toBeGreaterThan(0);
    for (const id of r.ruminated) {
      expect(b.nodes[id].permanentBoost).toBeGreaterThan(before[id].permanentBoost);
      expect(b.nodes[id].fidelity).toBeLessThan(before[id].fidelity);
      expect(b.nodes[id].confidence).toBeGreaterThan(before[id].confidence);
    }
  });

  it('costs load, so brooding compounds', () => {
    const b = populated(8, (x) => {
      x.psyche!.load.level = 0.7;
      x.psyche!.defenseMaturity = 0.1;
      x.psyche!.condition.depression.brooding = 0.9;
    });
    // Rest alone would lower load; the point is that brooding claws it back.
    const restOnly = populated(8, (x) => {
      x.psyche!.load.level = 0.7;
      x.psyche!.defenseMaturity = 0.9;
      x.psyche!.condition.depression.brooding = 0;
    });
    mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    mentate(restOnly, { now: T0, makeId: () => 'x', rng: neutral });
    expect(b.psyche!.load.level).toBeGreaterThan(restOnly.psyche!.load.level);
  });

  it('only chews on what actually hurts', () => {
    const b = populated(8, (x) => {
      x.psyche!.load.level = 0.9;
      x.psyche!.defenseMaturity = 0.1;
      for (const n of Object.values(x.nodes)) {
        n.affect = { ...n.affect, valence: 0.7, arousal: 0.7 };
      }
    });
    expect(mentate(b, { now: T0, makeId: () => 'x', rng: neutral }).ruminated).toEqual([]);
  });
});

describe('incubation', () => {
  it('connects things that keep surfacing together', () => {
    const b = brain([
      node({ id: 'a', tags: ['cellar', 'cold'], actors: ['Rell'], gist: 'the cellar door stuck' }),
      node({ id: 'b', tags: ['cellar', 'cold'], actors: ['Rell'], gist: 'the cellar smelled of damp' }),
      node({ id: 'c', tags: ['cellar', 'cold'], actors: ['Rell'], gist: 'the cellar light failed' }),
    ]);
    b.edges = [];
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(r.linked.length).toBeGreaterThan(0);
  });

  it('does not re-link what is already connected', () => {
    const b = brain([
      node({ id: 'a', tags: ['cellar'], gist: 'the cellar door stuck' }),
      node({ id: 'b', tags: ['cellar'], gist: 'the cellar smelled of damp' }),
      node({ id: 'c', tags: ['cellar'], gist: 'the cellar light failed' }),
    ]);
    b.edges = [];
    addEdge(b, 'a', 'b', 'reminds_of', 0.5);
    addEdge(b, 'a', 'c', 'reminds_of', 0.5);
    addEdge(b, 'b', 'c', 'reminds_of', 0.5);
    expect(mentate(b, { now: T0, makeId: () => 'x', rng: neutral }).linked).toEqual([]);
  });

  it('will not connect things with nothing in common', () => {
    const b = brain([
      node({ id: 'a', tags: ['cellar'], actors: ['Rell'], gist: 'cellar door stuck' }),
      node({ id: 'b', tags: ['harbour'], actors: ['Vey'], gist: 'boat left at dawn' }),
      node({ id: 'c', tags: ['orchard'], actors: ['Sim'], gist: 'apples went unpicked' }),
    ]);
    b.edges = [];
    expect(mentate(b, { now: T0, makeId: () => 'x', rng: neutral }).linked).toEqual([]);
  });
});

describe('retroactive revaluation', () => {
  it('lets how things turned out recolour what led there', () => {
    const earlier = node({
      id: 'earlier',
      gist: 'the evening was easy and nobody said anything sharp',
      encodedAt: T0 - 12 * HOUR,
      uses: [T0 - 12 * HOUR],
      affect: { ...neutralAffect(), valence: 0.7, arousal: 0.3 },
    });
    const outcome = node({
      id: 'outcome',
      gist: 'Rell found the letter and understood what the evening had been',
      encodedAt: T0 - 2 * HOUR,
      uses: [T0 - 2 * HOUR],
      affect: { ...neutralAffect(), valence: -0.9, arousal: 0.9 },
    });
    const filler = node({ id: 'f1', encodedAt: T0 - 30 * DAY, uses: [T0 - 30 * DAY] });
    const b = brain([earlier, outcome, filler]);
    // The earlier evening was still on their mind when the letter turned up.
    markEligible(earlier, T0 - 3 * HOUR);

    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(r.revalued).toContain('earlier');
    expect(b.nodes.earlier.affect.valence).toBeLessThan(0.7);
  });

  it('cannot reach back past the eligibility window', () => {
    /**
     * The bound that stops one bad day retroactively poisoning a whole history.
     * This memory was live two months ago and has been out of mind since, so
     * today's outcome has nothing to reach it by.
     */
    const longAgo = node({
      id: 'longAgo',
      encodedAt: T0 - 60 * DAY,
      uses: [T0 - 60 * DAY],
      permanentBoost: 0,
      affect: { ...neutralAffect(), valence: 0.7, arousal: 0.3 },
    });
    const outcome = node({
      id: 'outcome',
      encodedAt: T0 - 2 * HOUR,
      uses: [T0 - 2 * HOUR],
      affect: { ...neutralAffect(), valence: -0.9, arousal: 0.9 },
    });
    const b = brain([longAgo, outcome, node({ id: 'f1', encodedAt: T0 - 4 * DAY })]);
    markEligible(longAgo, T0 - 60 * DAY);

    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(r.revalued).not.toContain('longAgo');
    expect(b.nodes.longAgo.affect.valence).toBeCloseTo(0.7, 6);
  });

  it('does reach a memory that has just come back to them', () => {
    // The other half of the same rule: something you were only just turning
    // over is exactly what a fresh outcome recolours.
    const earlier = node({
      id: 'earlier',
      encodedAt: T0 - 12 * HOUR,
      uses: [T0 - 12 * HOUR],
      affect: { ...neutralAffect(), valence: 0.7, arousal: 0.3 },
    });
    const outcome = node({
      id: 'outcome',
      encodedAt: T0 - 2 * HOUR,
      uses: [T0 - 2 * HOUR],
      affect: { ...neutralAffect(), valence: -0.9, arousal: 0.9 },
    });
    const b = brain([earlier, outcome, node({ id: 'f1', encodedAt: T0 - 4 * DAY })]);
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(r.revalued).toContain('earlier');
  });

  it('never reaches forward in time', () => {
    const later = node({
      id: 'later',
      encodedAt: T0 - HOUR,
      uses: [T0 - HOUR],
      affect: { ...neutralAffect(), valence: 0.7, arousal: 0.3 },
    });
    const outcome = node({
      id: 'outcome',
      encodedAt: T0 - 2 * HOUR,
      uses: [T0 - 2 * HOUR],
      affect: { ...neutralAffect(), valence: -0.9, arousal: 0.9 },
    });
    const b = brain([later, outcome, node({ id: 'f1', encodedAt: T0 - 30 * DAY })]);
    markEligible(later, T0 - HOUR);
    expect(mentate(b, { now: T0, makeId: () => 'x', rng: neutral }).revalued).not.toContain('later');
  });

  it('does nothing when nothing much has happened', () => {
    const b = populated(6, (x) => {
      for (const n of Object.values(x.nodes)) {
        n.affect = { ...n.affect, valence: 0.05, arousal: 0.1 };
      }
    });
    expect(mentate(b, { now: T0, makeId: () => 'x', rng: neutral }).revalued).toEqual([]);
  });
});

describe('mood', () => {
  it('settles toward temperament over an untroubled gap', () => {
    const b = populated(6, (x) => {
      x.mood = { valence: -0.8, arousal: 0.7, dominance: -0.4, label: 'sadness' };
      for (const n of Object.values(x.nodes)) {
        n.affect = { ...n.affect, valence: 0, arousal: 0.05 };
      }
    });
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(r.moodAfter.valence).toBeGreaterThan(r.moodBefore.valence);
  });

  it('does not settle when what surfaced was painful', () => {
    const calm = populated(6, (x) => {
      x.mood = { valence: -0.4, arousal: 0.4, dominance: 0, label: 'sadness' };
      for (const n of Object.values(x.nodes)) n.affect = { ...n.affect, valence: 0, arousal: 0.05 };
    });
    const haunted = populated(6, (x) => {
      x.mood = { valence: -0.4, arousal: 0.4, dominance: 0, label: 'sadness' };
      for (const n of Object.values(x.nodes)) n.affect = { ...n.affect, valence: -0.9, arousal: 0.8 };
    });
    mentate(calm, { now: T0, makeId: () => 'x', rng: neutral });
    mentate(haunted, { now: T0, makeId: () => 'x', rng: neutral });
    expect(haunted.mood.valence).toBeLessThan(calm.mood.valence);
  });
});

describe('bookkeeping', () => {
  it('advances its own clock so the next tick measures the right gap', () => {
    const b = populated();
    mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(b.stats.lastMentationAt).toBe(T0);
    expect(b.stats.mentationTicks).toBe(1);
  });

  it('treats a long absence as one gap, not a hundred', () => {
    const b = populated(6, (x) => { x.mood = { valence: -0.9, arousal: 0.9, dominance: 0, label: 'grief' }; });
    b.stats.lastMentationAt = T0 - 400 * DAY;
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    // Capped: a year away must not arrive as a year of compounded regression.
    expect(r.moodAfter.valence).toBeLessThan(0.5);
  });

  it('describes what it did', () => {
    const b = populated();
    const r = mentate(b, { now: T0, makeId: () => 'x', rng: neutral });
    expect(describeMentation(r, 'Rell')).toMatch(/Rell/);
  });
});
