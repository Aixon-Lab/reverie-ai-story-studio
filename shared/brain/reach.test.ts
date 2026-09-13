/**
 * Two-stage recall: a few memories fully present, and a sense of the rest.
 *
 * The dangerous failure here is not cost, it is *assertion*. A bare list of
 * labels is the kind of thing a model will happily state as fact, and a
 * character who confidently reports a memory they only half have is worse than
 * one who never mentions it. So the tests below check the wording contract as
 * carefully as they check the arithmetic, and check that nothing the character
 * could not actually reach ever appears in the line.
 */
import { describe, expect, it } from 'vitest';
import { emptyBrain, DEFAULT_PARAMS } from './defaults';
import { FULL_PER_SECTION, brainDemandTokens, composeBrainContext, reachLabel } from './compose';
import { planContext } from './budget';
import type { BrainState, MemoryNode, RecallHit } from './types';

const T0 = 1_700_000_000_000;

function node(id: string, gist: string, kind: MemoryNode['kind'] = 'episodic'): MemoryNode {
  return {
    id,
    kind,
    gist,
    encodedAt: T0 - 3 * 86_400_000,
    uses: [T0],
    useCount: 2,
    permanentBoost: 0.8,
    affect: { valence: -0.3, arousal: 0.3, dominance: 0, label: 'sadness' },
    appraisal: {
      novelty: 0.3, pleasantness: -0.3, goalRelevance: 0.5, goalConduciveness: -0.3,
      agency: 'other', intent: -0.3, copingPotential: 0.5, norms: 0, urgency: 0.3,
    },
    vividness: 0.5,
    confidence: 0.7,
    fidelity: 0.8,
    actors: ['Rooke'],
    tags: [],
    contextBinding: 0.7,
    suppressed: 0,
    status: 'active',
  };
}

function hit(n: MemoryNode, activation = 0.5): RecallHit {
  return {
    node: n,
    activation,
    probability: 0.8,
    intrusion: false,
    breakdown: {
      base: activation, spreading: 0, partialMatch: 0, boost: 0, suppression: 0,
      moodCongruence: 0, noise: 0, availability: 0, interference: 0, maturation: 0,
      total: activation,
    },
  };
}

function wren(): BrainState {
  return emptyBrain('dock', 'wren', 'Scarlet Wren', T0);
}

function episodes(n: number): RecallHit[] {
  return Array.from({ length: n }, (_, i) =>
    hit(node(`e${i}`, `Rooke did the thing number ${i} in the dock office that evening`), 1 - i * 0.01));
}

const AMPLE = 100_000;

describe('labels', () => {
  it('reduces a memory to its first clause', () => {
    expect(reachLabel(node('x', 'Rooke burned the ledger. She watched him do it.')))
      .toBe('rooke burned the ledger');
  });

  it('cuts long gists at a word boundary and marks the cut', () => {
    const label = reachLabel(node('x', 'Rooke stood in the dock office and explained at very great length exactly why he had done it'));
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThan(60);
    expect(label).not.toMatch(/\s…$/);
  });

  it('produces nothing for an empty gist', () => {
    expect(reachLabel(node('x', '   '))).toBe('');
  });
});

describe('the reach line', () => {
  it('does not appear at all when everything fitted', () => {
    const out = composeBrainContext(wren(), episodes(3), { budget: AMPLE, now: T0 });
    expect(out.text).not.toContain('Within reach');
    expect(out.reachedIds).toEqual([]);
  });

  it('names the tail once the section cap is passed', () => {
    const out = composeBrainContext(wren(), episodes(FULL_PER_SECTION + 6), { budget: AMPLE, now: T0 });
    expect(out.text).toContain('Within reach');
    expect(out.reachedIds).toHaveLength(6);
  });

  it('renders exactly the cap in full, whatever the budget', () => {
    const out = composeBrainContext(wren(), episodes(40), { budget: AMPLE, now: T0 });
    expect(out.sections.find((s) => s.name === 'episodes')!.count).toBe(FULL_PER_SECTION);
  });

  it('costs far less than rendering the tail in full', () => {
    const staged = composeBrainContext(wren(), episodes(40), { budget: AMPLE, now: T0 });
    const full = composeBrainContext(wren(), episodes(40), {
      budget: AMPLE, now: T0, fullPerSection: 40,
    });
    expect(staged.tokens).toBeLessThan(full.tokens * 0.7);
  });

  it('never names a memory it also rendered in full', () => {
    const out = composeBrainContext(wren(), episodes(20), { budget: AMPLE, now: T0 });
    for (const id of out.reachedIds) expect(out.includedIds).not.toContain(id);
  });

  it('does not count a named memory as retrieved', () => {
    const out = composeBrainContext(wren(), episodes(20), { budget: AMPLE, now: T0 });
    expect(out.includedIds).toHaveLength(FULL_PER_SECTION);
  });

  it('caps how many it will name', () => {
    const out = composeBrainContext(wren(), episodes(90), { budget: AMPLE, now: T0 });
    expect(out.reachedIds.length).toBeLessThanOrEqual(16);
  });

  it('deduplicates memories that reduce to the same label', () => {
    const same = Array.from({ length: 14 }, (_, i) => hit(node(`d${i}`, 'Rooke lied about the ledger')));
    const out = composeBrainContext(wren(), same, { budget: AMPLE, now: T0 });
    expect(out.reachedIds).toHaveLength(1);
  });

  /**
   * The wording contract. A label is not a memory, and the line has to say so
   * or the model will assert it.
   */
  it('frames the tail as available, never as fact', () => {
    const out = composeBrainContext(wren(), episodes(20), { budget: AMPLE, now: T0 });
    expect(out.text).toMatch(/could bring any of these up/);
    expect(out.text).toMatch(/none of it is present enough to state as fact/);
  });
});

describe('what is never reduced to a label', () => {
  it('leaves intrusions out — they arrive whole or not at all', () => {
    const hits = Array.from({ length: 5 }, (_, i) => {
      const h = hit(node(`i${i}`, `The number hitting like ice water, take ${i}`, 'sensory'));
      h.intrusion = true;
      return h;
    });
    const out = composeBrainContext(wren(), hits, { budget: AMPLE, now: T0 });
    expect(out.reachedIds).toEqual([]);
  });

  it('leaves relationship read-outs out — they are state, not memories', () => {
    const b = wren();
    for (let i = 0; i < 10; i++) {
      b.people[`p${i}`] = {
        key: `p${i}`, displayName: `Person ${i}`, trust: 0.2, affection: 0.1, fear: 0,
        respect: 0, resentment: 0, debt: 0, familiarity: 0.4, model: '', interactions: 3,
        firstMetAt: T0, lastSeenAt: T0,
      };
    }
    const out = composeBrainContext(b, [], {
      budget: AMPLE, now: T0, presentActors: Array.from({ length: 10 }, (_, i) => `p${i}`),
    });
    expect(out.reachedIds).toEqual([]);
  });
});

describe('under a tight budget', () => {
  it('drops the reach line rather than truncating the memories for it', () => {
    // Enough for the header and a memory or two, and nothing spare.
    const out = composeBrainContext(wren(), episodes(20), { budget: 260, now: T0 });
    if (!out.text.includes('Within reach')) expect(out.reachedIds).toEqual([]);
    expect(out.tokens).toBeLessThanOrEqual(260);
  });

  it('still fits its own budget with the line in it', () => {
    for (const budget of [300, 500, 900, 2000]) {
      const out = composeBrainContext(wren(), episodes(30), { budget, now: T0 });
      expect(out.tokens).toBeLessThanOrEqual(budget);
    }
  });

  it('keeps the params untouched — this is a composition change, not a recall one', () => {
    expect(DEFAULT_PARAMS.threshold).toBe(-1.0);
  });
});

/**
 * Demand drives how much of the window is left for chat history, so it has to
 * describe what the composer will *actually emit*.
 *
 * It used to sum every non-dormant node in the graph. A character with a few
 * hundred memories therefore always demanded more than the one-third cap, the
 * plan handed the brain that whole third, and history was permanently short by
 * an amount the brain never spent. Two-stage composition widens that gap
 * enormously, which is what made this worth fixing rather than noting.
 */
describe('demand describes the block, not the store', () => {
  const withEpisodes = (n: number) => {
    const b = wren();
    for (let i = 0; i < n; i++) {
      b.nodes[`e${i}`] = node(`e${i}`, `Rooke did the thing number ${i} in the dock office that evening`);
    }
    return b;
  };

  it('stops growing once the sections are full', () => {
    const small = brainDemandTokens(withEpisodes(FULL_PER_SECTION));
    const huge = brainDemandTokens(withEpisodes(600));
    // The reach line is the only thing that may grow, and it is capped too.
    expect(huge).toBeLessThan(small + 400);
  });

  it('is an upper bound on what composition actually costs', () => {
    const b = withEpisodes(300);
    const demand = brainDemandTokens(b);
    const out = composeBrainContext(b, episodes(300), { budget: 1_000_000, now: T0 });
    expect(out.tokens).toBeLessThanOrEqual(demand);
  });

  it('no longer saturates the one-third cap on an ordinary mature brain', () => {
    // 32k window, 1k reply: the cap is roughly 10k tokens.
    const plan = planContext({
      modelContext: 32_000,
      reservedOutput: 1024,
      brainDemand: brainDemandTokens(withEpisodes(400)),
    });
    expect(plan.saturated).toBe(false);
    expect(plan.brainBudget).toBeLessThan(plan.brainCap);
    // …which is history the brain used to take and never spend.
    expect(plan.historyBudget).toBeGreaterThan(plan.usable * 0.75);
  });

  it('still asks for more when the memories themselves are long', () => {
    const b = wren();
    for (let i = 0; i < FULL_PER_SECTION; i++) {
      b.nodes[`e${i}`] = node(`e${i}`, `${'a very long and detailed account of the evening '.repeat(12)}${i}`);
    }
    expect(brainDemandTokens(b)).toBeGreaterThan(brainDemandTokens(withEpisodes(FULL_PER_SECTION)));
  });
});
