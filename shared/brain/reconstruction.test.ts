/**
 * Reconstruction: how memory goes wrong, and when it admits it cannot.
 *
 * The rng is always injected and usually pinned to 0, which forces the
 * distortion to fire — the probability gate is tested separately. Without that
 * these would be flaky tests of a stochastic process, which is worse than no
 * tests at all.
 */
import { describe, expect, it } from 'vitest';
import { TIME_UNIT_MS, emptyBrain, neutralAffect } from './defaults';
import { neutralAppraisal } from './emotion';
import { isBeyondRecall, reconstructOnRecall } from './reconstruction';
import { ensureSynapse } from './synapse';
import type { BrainState, MemoryNode } from './types';

const T0 = 1_700_000_000_000;
const DAY = TIME_UNIT_MS;

/** Always distorts: every roll lands at the bottom of its band. */
const always = () => 0;
/** Never distorts: every roll lands at the top. */
const never = () => 0.999999;

/** Pick which distortion `applyOne` reaches for. */
function picks(kind: 'telescope' | 'colour' | 'misattribute' | 'blend'): () => number {
  const branch = { telescope: 0.1, colour: 0.5, misattribute: 0.8, blend: 0.95 }[kind];
  let call = 0;
  return () => {
    call++;
    // 1st roll is the probability gate, 2nd selects the branch, rest are the
    // operator's own randomness.
    if (call === 1) return 0;
    if (call === 2) return branch;
    return 0.5;
  };
}

function node(over: Partial<MemoryNode> = {}): MemoryNode {
  const n: MemoryNode = {
    id: 'n1',
    kind: 'episodic',
    gist: 'Ines promised to come back before the frost',
    encodedAt: T0 - 10 * DAY,
    uses: [T0 - 10 * DAY],
    useCount: 1,
    permanentBoost: 0,
    affect: { ...neutralAffect(), valence: 0.4 },
    appraisal: neutralAppraisal(),
    vividness: 0.5,
    confidence: 0.7,
    // Well below the corruption floor unless a test says otherwise.
    fidelity: 0.2,
    actors: ['Ines'],
    tags: ['promise'],
    contextBinding: 0.6,
    suppressed: 0,
    status: 'active',
    ...over,
  };
  return n;
}

function brain(nodes: MemoryNode[] = []): BrainState {
  const b = emptyBrain('chat', 'char', 'Mara', T0);
  for (const n of nodes) b.nodes[n.id] = n;
  return b;
}

describe('the gate', () => {
  it('leaves an accurate memory completely alone', () => {
    const n = node({ fidelity: 0.95 });
    const b = brain([n]);
    expect(reconstructOnRecall(b, n, T0, { rng: always })).toBeNull();
  });

  it('never touches a pinned memory', () => {
    const n = node({ pinned: true });
    expect(reconstructOnRecall(brain([n]), n, T0, { rng: always })).toBeNull();
  });

  it('never touches a self-defining memory', () => {
    const n = node({ kind: 'identity' });
    expect(reconstructOnRecall(brain([n]), n, T0, { rng: always })).toBeNull();
  });

  it('never touches a trauma fragment', () => {
    // The pathology of an S-rep is that it does *not* drift (§M.8).
    const n = node({ kind: 'sensory' });
    expect(reconstructOnRecall(brain([n]), n, T0, { rng: always })).toBeNull();
  });

  it('does nothing when confabulation is switched off', () => {
    const n = node();
    const b = brain([n]);
    b.config.confabulation = 0;
    expect(reconstructOnRecall(b, n, T0, { rng: always })).toBeNull();
  });

  it('is rare rather than constant', () => {
    const n = node();
    expect(reconstructOnRecall(brain([n]), n, T0, { rng: never })).toBeNull();
  });

  it('raises conviction whenever it does fire', () => {
    // The confidence–accuracy dissociation, made active: each retelling smooths
    // the account and makes it feel more certain.
    const n = node({ confidence: 0.5 });
    reconstructOnRecall(brain([n]), n, T0, { rng: picks('colour') });
    expect(n.confidence).toBeGreaterThan(0.5);
  });
});

describe('temporal telescoping', () => {
  it('moves the felt date without touching the real one', () => {
    const n = node({ encodedAt: T0 - 10 * DAY });
    reconstructOnRecall(brain([n]), n, T0, { rng: picks('telescope') });
    expect(n.encodedAt).toBe(T0 - 10 * DAY);
    expect(n.perceivedAt).toBeDefined();
    expect(n.perceivedAt).not.toBe(n.encodedAt);
  });

  it('pushes a recent event further away (backward telescoping)', () => {
    const n = node({ encodedAt: T0 - 10 * DAY });
    reconstructOnRecall(brain([n]), n, T0, { rng: picks('telescope') });
    expect(n.perceivedAt!).toBeLessThan(n.encodedAt);
  });

  it('pulls a remote event closer (forward telescoping)', () => {
    // The dominant effect for distant events, and why everyone underestimates
    // how long ago things were.
    const n = node({ encodedAt: T0 - 200 * DAY, uses: [T0 - 200 * DAY] });
    reconstructOnRecall(brain([n]), n, T0, { rng: picks('telescope') });
    expect(n.perceivedAt!).toBeGreaterThan(n.encodedAt);
  });

  it('never lets a remote memory drift all the way into the present', () => {
    const n = node({ encodedAt: T0 - 400 * DAY, uses: [T0 - 400 * DAY] });
    for (let i = 0; i < 20; i++) reconstructOnRecall(brain([n]), n, T0, { rng: picks('telescope') });
    expect(n.perceivedAt!).toBeLessThan(T0);
  });

  it('leaves a memory from today alone', () => {
    // Nobody misremembers when something this morning happened.
    const n = node({ encodedAt: T0 - 0.2 * DAY });
    expect(reconstructOnRecall(brain([n]), n, T0, { rng: picks('telescope') })).toBeNull();
  });
});

describe('affective colouring', () => {
  it('drags a memory toward what the character now thinks of the person', () => {
    const n = node({ affect: { ...neutralAffect(), valence: 0.8 } });
    const b = brain([n]);
    b.people.ines = {
      key: 'ines', displayName: 'Ines',
      trust: -0.9, affection: -0.9, fear: 0.2, respect: 0, resentment: 0.8,
      debt: 0, familiarity: 0.8, model: '', interactions: 12,
      firstMetAt: T0 - 100 * DAY, lastSeenAt: T0,
    };
    const d = reconstructOnRecall(b, n, T0, { rng: picks('colour') });
    expect(d?.kind).toBe('coloured');
    // A warm memory of somebody they have come to despise sours.
    expect(n.affect.valence).toBeLessThan(0.8);
    expect(d!.note).toMatch(/Ines/);
  });

  it('falls back to present mood when nobody in particular was involved', () => {
    const n = node({ actors: [], affect: { ...neutralAffect(), valence: 0.8 } });
    const b = brain([n]);
    b.mood = { ...neutralAffect(), valence: -0.9 };
    reconstructOnRecall(b, n, T0, { rng: picks('colour') });
    expect(n.affect.valence).toBeLessThan(0.8);
  });

  it('keeps valence in range', () => {
    const n = node({ affect: { ...neutralAffect(), valence: 0.9 } });
    const b = brain([n]);
    b.mood = { ...neutralAffect(), valence: -1 };
    for (let i = 0; i < 50; i++) reconstructOnRecall(b, n, T0, { rng: picks('colour') });
    expect(n.affect.valence).toBeGreaterThanOrEqual(-1);
    expect(n.affect.valence).toBeLessThanOrEqual(1);
  });
});

describe('source misattribution', () => {
  function pair(): { target: MemoryNode; b: BrainState } {
    const target = node();
    const neighbour = node({
      id: 'n2',
      gist: 'Ines promised to write once she reached the coast',
      actors: ['Noor'],
      tags: ['promise'],
    });
    return { target, b: brain([target, neighbour]) };
  }

  it('swaps in someone who plausibly could have been there', () => {
    const { target, b } = pair();
    const d = reconstructOnRecall(b, target, T0, { rng: picks('misattribute') });
    expect(d?.kind).toBe('misattributed');
    expect(target.actors).toContain('Noor');
    expect(target.actors).not.toContain('Ines');
  });

  it('rewrites the name in the gist so the account stays coherent', () => {
    const { target, b } = pair();
    reconstructOnRecall(b, target, T0, { rng: picks('misattribute') });
    expect(target.gist).toContain('Noor');
    expect(target.gist).not.toContain('Ines');
  });

  it('drops the exact wording, which cannot survive the swap', () => {
    const { target, b } = pair();
    target.verbatim = 'I will be back before the frost';
    reconstructOnRecall(b, target, T0, { rng: picks('misattribute') });
    expect(target.verbatim).toBeUndefined();
  });

  it('does nothing when there is nobody to be confused with', () => {
    const n = node();
    expect(reconstructOnRecall(brain([n]), n, T0, { rng: picks('misattribute') })).toBeNull();
  });

  it('will not borrow from an unrelated memory', () => {
    const target = node();
    const unrelated = node({
      id: 'n2',
      gist: 'the cart lost a wheel on the west road',
      actors: ['Bram'],
      tags: ['travel'],
    });
    const d = reconstructOnRecall(brain([target, unrelated]), target, T0, { rng: picks('misattribute') });
    expect(d).toBeNull();
    expect(target.actors).toEqual(['Ines']);
  });
});

describe('fusion', () => {
  it('merges two similar occasions into one account', () => {
    const target = node();
    const similar = node({
      id: 'n2',
      gist: 'Ines promised to come back before the harvest, then did not',
    });
    const d = reconstructOnRecall(brain([target, similar]), target, T0, { rng: picks('blend') });
    expect(d?.kind).toBe('blended');
    expect(target.gist.length).toBeGreaterThan(node().gist.length);
    expect(target.gist).toMatch(/ — and /);
  });

  it('does nothing without a similar occasion to fuse with', () => {
    const target = node();
    const different = node({ id: 'n2', gist: 'the roof gave way in the storm' });
    expect(reconstructOnRecall(brain([target, different]), target, T0, { rng: picks('blend') })).toBeNull();
  });
});

describe('the record', () => {
  it('keeps what drifted, for the Mind page', () => {
    const n = node();
    reconstructOnRecall(brain([n]), n, T0, { rng: picks('telescope') });
    expect(n.distortions).toHaveLength(1);
    expect(n.distortions![0].kind).toBe('telescoped');
    expect(n.distortions![0].note).toBeTruthy();
  });

  it('does not grow without bound', () => {
    const n = node({ encodedAt: T0 - 200 * DAY });
    for (let i = 0; i < 40; i++) reconstructOnRecall(brain([n]), n, T0, { rng: picks('telescope') });
    expect(n.distortions!.length).toBeLessThanOrEqual(6);
  });
});

describe('abstention', () => {
  it('gives up on a memory whose accuracy and conviction have both gone', () => {
    expect(isBeyondRecall(node({ fidelity: 0.1, confidence: 0.2 }))).toBe(true);
  });

  it('does not give up on something merely inaccurate', () => {
    // Low fidelity with intact conviction is the confident *error*, not a blank.
    expect(isBeyondRecall(node({ fidelity: 0.1, confidence: 0.9 }))).toBe(false);
  });

  it('does not give up on something merely uncertain', () => {
    expect(isBeyondRecall(node({ fidelity: 0.9, confidence: 0.2 }))).toBe(false);
  });

  it('never gives up on a pinned or self-defining memory', () => {
    expect(isBeyondRecall(node({ fidelity: 0, confidence: 0, pinned: true }))).toBe(false);
    expect(isBeyondRecall(node({ fidelity: 0, confidence: 0, kind: 'identity' }))).toBe(false);
  });
});

describe('corruption drives the rate', () => {
  it('fires more often on a badly degraded memory than a slightly worn one', () => {
    const trials = 400;
    const count = (fidelity: number, noise: number) => {
      let fired = 0;
      for (let i = 0; i < trials; i++) {
        const n = node({ fidelity, confidence: 0.9, encodedAt: T0 - 40 * DAY });
        ensureSynapse(n, T0).noise = noise;
        let seed = i / trials;
        const rng = () => {
          const v = seed;
          seed = 0.5;
          return v;
        };
        if (reconstructOnRecall(brain([n]), n, T0, { rng, confabulation: 1 })) fired++;
      }
      return fired;
    };
    expect(count(0.1, 0.9)).toBeGreaterThan(count(0.55, 0.1));
  });
});
