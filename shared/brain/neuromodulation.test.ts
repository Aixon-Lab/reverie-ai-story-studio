/**
 * Neuromodulation: the global gains, and the four couplings they drive.
 *
 * The first test is the load-bearing one. Everything else in this engine was
 * calibrated with no global gain at all, so a character in a neutral state must
 * come out of this module completely unchanged — otherwise every threshold in
 * `DEFAULT_PARAMS` silently means something different.
 */
import { describe, expect, it } from 'vitest';
import { emptyBrain, neutralAffect, neutralTraits } from './defaults';
import { emptyPsyche } from '../psyche/defaults';
import { neutralAppraisal } from './emotion';
import {
  BASELINE, REST_ACETYLCHOLINE, abstractionFactor, contrastTerm, describeModulators,
  gainsOf, modulatorsOf, nodeSalience,
} from './neuromodulation';
import type { BrainState, MemoryNode } from './types';

const T0 = 1_700_000_000_000;

function brain(mutate: (b: BrainState) => void = () => {}): BrainState {
  const b = emptyBrain('chat', 'char', 'Mara', T0);
  b.psyche = emptyPsyche(neutralTraits(), T0);
  mutate(b);
  return b;
}

function node(over: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'n1',
    kind: 'episodic',
    gist: 'something happened',
    encodedAt: T0,
    uses: [T0],
    useCount: 1,
    permanentBoost: 0,
    affect: neutralAffect(),
    appraisal: neutralAppraisal(),
    vividness: 0.4,
    confidence: 0.7,
    fidelity: 0.8,
    actors: [],
    tags: [],
    contextBinding: 0.8,
    suppressed: 0,
    status: 'active',
    ...over,
  };
}

describe('the baseline is inert', () => {
  const g = gainsOf(BASELINE);

  it('leaves every multiplicative gain at 1', () => {
    expect(g.noiseScale).toBeCloseTo(1, 10);
    expect(g.encodingGain).toBeCloseTo(1, 10);
    expect(g.plasticity).toBeCloseTo(1, 10);
    expect(g.moodInertia).toBeCloseTo(1, 10);
    expect(g.congruenceGain).toBeCloseTo(1, 10);
  });

  it('leaves every additive gain at 0', () => {
    expect(g.contrast).toBeCloseTo(0, 10);
    expect(g.thresholdShift).toBeCloseTo(0, 10);
  });

  it('abstracts exactly as the engine always has, during sleep', () => {
    expect(abstractionFactor(gainsOf({ ...BASELINE, acetylcholine: REST_ACETYLCHOLINE }))).toBeCloseTo(1, 10);
  });
});

describe('deriving the modulators', () => {
  it('works on a brain that has no psyche at all', () => {
    const b = brain((x) => { x.psyche = undefined; });
    const m = modulatorsOf(b);
    for (const v of Object.values(m)) expect(Number.isFinite(v)).toBe(true);
  });

  it('raises noradrenaline with arousal', () => {
    const calm = modulatorsOf(brain((b) => { b.mood = { ...neutralAffect(), arousal: 0.05 }; }));
    const keyed = modulatorsOf(brain((b) => { b.mood = { ...neutralAffect(), arousal: 0.95 }; }));
    expect(keyed.noradrenaline).toBeGreaterThan(calm.noradrenaline);
  });

  it('raises noradrenaline when the character is not safe', () => {
    const safe = modulatorsOf(brain((b) => { b.psyche!.body.safety = 1; }));
    const unsafe = modulatorsOf(brain((b) => { b.psyche!.body.safety = 0; }));
    expect(unsafe.noradrenaline).toBeGreaterThan(safe.noradrenaline);
  });

  it('drops dopamine under anhedonia', () => {
    const flat = modulatorsOf(brain((b) => { b.psyche!.condition.depression.anhedonia = 0.9; }));
    expect(flat.dopamine).toBeLessThan(BASELINE.dopamine);
  });

  it('drops serotonin under sustained load', () => {
    // Against the same character unstrained, not against the abstract baseline:
    // a safe, rested character legitimately sits above it.
    const easy = modulatorsOf(brain((b) => { b.psyche!.load.level = 0; }));
    const strained = modulatorsOf(brain((b) => { b.psyche!.load.level = 0.9; }));
    expect(strained.serotonin).toBeLessThan(easy.serotonin);
  });

  it('puts acetylcholine highest in scene and lowest asleep', () => {
    const b = brain();
    expect(modulatorsOf(b, 'engaged').acetylcholine)
      .toBeGreaterThan(modulatorsOf(b, 'idle').acetylcholine);
    expect(modulatorsOf(b, 'idle').acetylcholine)
      .toBeGreaterThan(modulatorsOf(b, 'rest').acetylcholine);
  });

  it('blunts acetylcholine in an exhausted character even mid-scene', () => {
    const rested = modulatorsOf(brain(), 'engaged');
    const spent = modulatorsOf(brain((b) => {
      b.psyche!.body.sleepDebt = 1;
      b.psyche!.body.energy = 0;
    }), 'engaged');
    expect(spent.acetylcholine).toBeLessThan(rested.acetylcholine);
  });

  it('keeps every modulator inside 0..1 at any extreme', () => {
    const wrecked = brain((b) => {
      b.mood = { valence: -1, arousal: 1, dominance: -1, label: 'horror' };
      b.psyche!.load.level = 1;
      b.psyche!.body = { energy: 0, sleepDebt: 1, pain: 1, safety: 0, nourishment: 0 };
      b.psyche!.condition.depression.anhedonia = 1;
      b.psyche!.condition.depression.hopelessness = 1;
      b.psyche!.condition.anxiety.hypervigilance = 1;
    });
    for (const phase of ['engaged', 'idle', 'rest'] as const) {
      for (const v of Object.values(modulatorsOf(wrecked, phase))) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('arousal-biased competition', () => {
  const aroused = gainsOf({ ...BASELINE, noradrenaline: 0.9 });

  it('lifts a charged memory and sinks a neutral one', () => {
    const charged = node({ affect: { valence: -0.8, arousal: 0.9, dominance: -0.5, label: 'fear' } });
    const dull = node({ id: 'n2', affect: { valence: 0, arousal: 0.02, dominance: 0, label: 'neutral' } });
    expect(contrastTerm(charged, aroused)).toBeGreaterThan(0);
    expect(contrastTerm(dull, aroused)).toBeLessThan(0);
  });

  it('leaves a memory of median salience alone at any arousal', () => {
    // The redistribution property: arousal must not inflate the whole field.
    const median = node({
      affect: { valence: 0, arousal: 1, dominance: 0, label: 'surprise' },
      appraisal: { ...neutralAppraisal(), goalRelevance: 0 },
    });
    expect(nodeSalience(median)).toBeCloseTo(0.5, 10);
    expect(contrastTerm(median, aroused)).toBeCloseTo(0, 10);
  });

  it('does nothing at all at baseline arousal', () => {
    const charged = node({ affect: { valence: -0.8, arousal: 0.9, dominance: -0.5, label: 'fear' } });
    expect(contrastTerm(charged, gainsOf(BASELINE))).toBeCloseTo(0, 10);
  });
});

describe('the four couplings', () => {
  it('narrows what reaches awareness under vigilance', () => {
    expect(gainsOf({ ...BASELINE, noradrenaline: 0.95 }).thresholdShift).toBeGreaterThan(0);
  });

  it('widens it again when serotonin is low', () => {
    // Flooded rather than focused — the depressive pattern, not the anxious one.
    expect(gainsOf({ ...BASELINE, serotonin: 0.05 }).thresholdShift).toBeLessThan(0);
  });

  it('stops the mind updating when dopamine bottoms out', () => {
    const flat = gainsOf({ ...BASELINE, dopamine: 0 });
    const driven = gainsOf({ ...BASELINE, dopamine: 1 });
    expect(flat.plasticity).toBeLessThan(1);
    expect(driven.plasticity).toBeGreaterThan(1);
  });

  it('makes feelings stick when serotonin is low', () => {
    expect(gainsOf({ ...BASELINE, serotonin: 0.05 }).moodInertia).toBeGreaterThan(1);
    expect(gainsOf({ ...BASELINE, serotonin: 0.95 }).moodInertia).toBeLessThan(1);
  });

  it('weights mood-congruent recall harder when serotonin is low', () => {
    expect(gainsOf({ ...BASELINE, serotonin: 0.05 }).congruenceGain).toBeGreaterThan(1);
  });

  it('strengthens encoding under arousal and weakens it when depleted', () => {
    expect(gainsOf({ ...BASELINE, noradrenaline: 0.95 }).encodingGain).toBeGreaterThan(1);
    expect(gainsOf({ ...BASELINE, noradrenaline: 0, acetylcholine: 0 }).encodingGain).toBeLessThan(1);
  });

  it('never lets a multiplier reach zero', () => {
    // A gain of 0 would not be "very depressed", it would be a dead engine.
    for (const m of [
      { dopamine: 0, noradrenaline: 0, serotonin: 0, acetylcholine: 0 },
      { dopamine: 1, noradrenaline: 1, serotonin: 1, acetylcholine: 1 },
    ]) {
      const g = gainsOf(m);
      expect(g.plasticity).toBeGreaterThan(0);
      expect(g.encodingGain).toBeGreaterThan(0);
      expect(g.moodInertia).toBeGreaterThan(0);
      expect(g.noiseScale).toBeGreaterThan(0);
      expect(g.congruenceGain).toBeGreaterThan(0);
    }
  });

  it('makes a waking mind slower to abstract than a sleeping one', () => {
    const awake = abstractionFactor(gainsOf(modulatorsOf(brain(), 'engaged')));
    const asleep = abstractionFactor(gainsOf(modulatorsOf(brain(), 'rest')));
    expect(awake).toBeGreaterThan(asleep);
  });
});

describe('read-out', () => {
  it('says something plain about an ordinary state', () => {
    expect(describeModulators(BASELINE)).toBe('even-keeled');
  });

  it('describes a keyed-up, depleted character', () => {
    const text = describeModulators({
      dopamine: 0.1, noradrenaline: 0.9, serotonin: 0.1, acetylcholine: 0.5,
    });
    expect(text).toMatch(/keyed up/);
    expect(text).toMatch(/worth reaching for/);
  });
});
