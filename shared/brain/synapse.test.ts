/**
 * Synaptic dynamics: priming, habituation, stability, interference, homeostasis.
 *
 * Every test runs on a fixed clock. The calibration cases at the bottom are the
 * important ones — they pin the *behaviour* ("a memory brought up three times in
 * a scene becomes harder to reach than one brought up once"), not the algebra,
 * so the constants can be retuned without rewriting the suite.
 */
import { describe, expect, it } from 'vitest';
import { TIME_UNIT_MS, neutralAffect } from './defaults';
import {
  DEFAULT_SYNAPSE, advanceFidelity, boostStability, corruptionOf, decayProfile,
  effectiveDecay, ensureSynapse, forecastDecay, potentiate, recordSynapticUse, relaxSynapse,
  stpTerm, useSynapse,
} from './synapse';
import type { MemoryKind, MemoryNode } from './types';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

function node(over: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'n1',
    kind: 'episodic',
    gist: 'she left without saying goodbye',
    encodedAt: T0,
    uses: [T0],
    useCount: 1,
    permanentBoost: 0,
    affect: neutralAffect(),
    appraisal: {
      novelty: 0.4, pleasantness: 0, goalRelevance: 0.3, goalConduciveness: 0,
      agency: 'other', intent: 0, copingPotential: 0.5, norms: 0, urgency: 0.2,
    },
    vividness: 0.5,
    confidence: 0.7,
    fidelity: 0.8,
    actors: ['Mara'],
    tags: ['leaving'],
    contextBinding: 0.6,
    suppressed: 0,
    status: 'active',
    ...over,
  };
}

describe('short-term plasticity', () => {
  it('contributes exactly nothing before the memory has ever been used', () => {
    // The invariant that keeps every existing ACT-R threshold valid.
    expect(stpTerm(node(), T0)).toBe(0);
  });

  it('rests at zero even once a synapse exists', () => {
    const n = node();
    ensureSynapse(n, T0);
    expect(stpTerm(n, T0)).toBeCloseTo(0, 10);
  });

  it('primes a memory that was just used', () => {
    const n = node();
    useSynapse(n, T0);
    // A moment later: facilitation is up, resources have barely recovered, but
    // the net effect of one use is that it is easier to reach again.
    expect(stpTerm(n, T0 + MIN)).toBeGreaterThan(0);
  });

  it('depletes a memory used over and over', () => {
    const n = node();
    for (let i = 0; i < 8; i++) useSynapse(n, T0 + i * MIN);
    expect(stpTerm(n, T0 + 8 * MIN)).toBeLessThan(0);
  });

  it('never depletes past the floor, however hard it is flogged', () => {
    const n = node();
    for (let i = 0; i < 200; i++) useSynapse(n, T0 + i * 1000);
    expect(stpTerm(n, T0 + 200_000)).toBeGreaterThanOrEqual(-DEFAULT_SYNAPSE.maxEfficacyPenalty);
  });

  it('recovers to rest after a long enough gap', () => {
    const n = node();
    for (let i = 0; i < 8; i++) useSynapse(n, T0 + i * MIN);
    expect(stpTerm(n, T0 + 7 * 24 * HOUR)).toBeCloseTo(0, 3);
  });

  it('fades priming faster than it recovers depletion', () => {
    // Facilitation is a within-scene effect; fatigue outlasts it. This ordering
    // is what makes a character drop a subject rather than loop on it.
    expect(DEFAULT_SYNAPSE.tauFacilitation).toBeLessThan(DEFAULT_SYNAPSE.tauRecovery);
  });

  it('is disabled entirely by a zero gain', () => {
    const n = node();
    useSynapse(n, T0);
    expect(stpTerm(n, T0 + MIN, { ...DEFAULT_SYNAPSE, efficacyGain: 0 })).toBe(0);
  });

  it('does not mutate the stored state when merely scoring', () => {
    const n = node();
    useSynapse(n, T0);
    const before = { ...n.synapse! };
    stpTerm(n, T0 + 10 * MIN);
    expect(n.synapse).toEqual(before);
  });

  it('relaxes toward baseline rather than past it', () => {
    const n = node();
    const syn = ensureSynapse(n, T0);
    syn.facilitation = 0.9;
    syn.resources = 0.2;
    relaxSynapse(syn, T0 + 30 * 24 * HOUR);
    expect(syn.facilitation).toBeCloseTo(DEFAULT_SYNAPSE.baseUtilisation, 6);
    expect(syn.resources).toBeCloseTo(1, 6);
  });
});

describe('stability', () => {
  it('grows on every retrieval', () => {
    expect(boostStability(1)).toBeGreaterThan(1);
  });

  it('grows with diminishing returns', () => {
    // The second recall of something matters far more than the hundredth.
    const firstRatio = boostStability(1) / 1;
    const laterRatio = boostStability(200) / 200;
    expect(firstRatio).toBeGreaterThan(laterRatio);
  });

  it('makes a rehearsed memory decay more slowly than a neglected one', () => {
    const rehearsed = node({ fidelity: 0.9 });
    const neglected = node({ id: 'n2', fidelity: 0.9 });

    // One is recalled every day for a fortnight; the other is left alone.
    for (let day = 1; day <= 14; day++) recordSynapticUse(rehearsed, T0 + day * TIME_UNIT_MS);

    const end = T0 + 400 * TIME_UNIT_MS;
    advanceFidelity(rehearsed, end);
    advanceFidelity(neglected, end);
    expect(rehearsed.fidelity).toBeGreaterThan(neglected.fidelity);
  });
});

describe('fidelity and interference', () => {
  it('erodes fidelity over time', () => {
    const n = node({ fidelity: 0.9 });
    advanceFidelity(n, T0 + 60 * TIME_UNIT_MS);
    expect(n.fidelity).toBeLessThan(0.9);
    expect(n.fidelity).toBeGreaterThan(0);
  });

  it('does not double-charge when advanced twice with no time between', () => {
    const n = node({ fidelity: 0.9 });
    advanceFidelity(n, T0 + 30 * TIME_UNIT_MS);
    const once = n.fidelity;
    advanceFidelity(n, T0 + 30 * TIME_UNIT_MS);
    expect(n.fidelity).toBe(once);
  });

  it('accumulates noise as fidelity falls', () => {
    const n = node({ fidelity: 0.9 });
    advanceFidelity(n, T0 + 120 * TIME_UNIT_MS);
    expect(n.synapse!.noise).toBeGreaterThan(0);
  });

  it('protects emotional memories from losing accuracy', () => {
    const calm = node({ fidelity: 0.9, affect: { ...neutralAffect(), arousal: 0.05 } });
    const charged = node({ id: 'n2', fidelity: 0.9, affect: { ...neutralAffect(), arousal: 0.95 } });
    advanceFidelity(calm, T0 + 200 * TIME_UNIT_MS);
    advanceFidelity(charged, T0 + 200 * TIME_UNIT_MS);
    expect(charged.fidelity).toBeGreaterThan(calm.fidelity);
  });

  it('forgets an episode faster than the belief drawn from it', () => {
    const episode = node({ kind: 'episodic', fidelity: 0.9 });
    const belief = node({ id: 'n2', kind: 'schema', fidelity: 0.9 });
    advanceFidelity(episode, T0 + 180 * TIME_UNIT_MS);
    advanceFidelity(belief, T0 + 180 * TIME_UNIT_MS);
    expect(belief.fidelity).toBeGreaterThan(episode.fidelity);
  });

  it('reports a pinned memory as uncorrupted however far it has drifted', () => {
    const n = node({ fidelity: 0.1, pinned: true });
    ensureSynapse(n, T0).noise = 0.9;
    expect(corruptionOf(n)).toBe(0);
  });

  it('reports rising corruption as a memory ages', () => {
    const n = node({ fidelity: 0.95 });
    const fresh = corruptionOf(n);
    advanceFidelity(n, T0 + 300 * TIME_UNIT_MS);
    expect(corruptionOf(n)).toBeGreaterThan(fresh);
  });

  it('cleans a trace slightly on retrieval', () => {
    const n = node({ fidelity: 0.5 });
    advanceFidelity(n, T0 + 200 * TIME_UNIT_MS);
    const dirty = n.synapse!.noise;
    expect(dirty).toBeGreaterThan(0);
    recordSynapticUse(n, T0 + 200 * TIME_UNIT_MS);
    expect(n.synapse!.noise).toBeLessThan(dirty);
  });
});

describe('per-kind decay profiles', () => {
  it('leaves episodic activation decay exactly as it was', () => {
    // The reference case: every threshold in DEFAULT_PARAMS was tuned against it.
    expect(effectiveDecay('episodic', 0.5)).toBe(0.5);
  });

  const slower: MemoryKind[] = ['semantic', 'schema', 'identity', 'sensory', 'relational', 'procedural'];
  for (const kind of slower) {
    it(`persists ${kind} longer than episodic`, () => {
      expect(effectiveDecay(kind, 0.5)).toBeLessThan(0.5);
      expect(decayProfile(kind).fidelityDecay).toBeLessThan(decayProfile('episodic').fidelityDecay);
    });
  }

  it('makes identity the most durable kind of all', () => {
    const identity = decayProfile('identity');
    for (const kind of ['episodic', 'semantic', 'relational'] as MemoryKind[]) {
      expect(identity.activationScale).toBeLessThan(decayProfile(kind).activationScale);
    }
  });
});

describe('BCM homeostasis', () => {
  it('lets the first potentiation through undiminished', () => {
    const n = node();
    expect(potentiate(n, 0.05, T0)).toBeCloseTo(0.05, 6);
  });

  it('tapers potentiation as a trace comes to dominate', () => {
    const n = node();
    const first = potentiate(n, 0.05, T0);
    let last = first;
    for (let i = 1; i < 12; i++) last = potentiate(n, 0.05, T0 + i * MIN);
    expect(last).toBeLessThan(first);
  });

  it('bounds permanent boost however many times a memory recurs', () => {
    const n = node();
    for (let i = 0; i < 500; i++) potentiate(n, 0.05, T0 + i * MIN);
    expect(n.permanentBoost).toBeLessThanOrEqual(DEFAULT_SYNAPSE.maxPermanentBoost);
  });

  it('never subtracts from a boost already earned', () => {
    const n = node({ permanentBoost: 1.2 });
    for (let i = 0; i < 40; i++) potentiate(n, 0.05, T0 + i * MIN);
    expect(n.permanentBoost).toBeGreaterThanOrEqual(1.2);
  });
});

describe('behavioural calibration', () => {
  it('makes a memory flogged through a scene harder to reach than one raised once', () => {
    // The habituation requirement, stated as behaviour: this is what stops a
    // character repeating the same anecdote inside a single conversation.
    const flogged = node();
    const mentioned = node({ id: 'n2' });
    for (let i = 0; i < 6; i++) useSynapse(flogged, T0 + i * 4 * MIN);
    useSynapse(mentioned, T0);

    const later = T0 + 26 * MIN;
    expect(stpTerm(flogged, later)).toBeLessThan(stpTerm(mentioned, later));
    // …and specifically, below rest: the character is actively off the subject.
    expect(stpTerm(flogged, later)).toBeLessThan(0);
  });

  it('still warms a memory raised two or three times', () => {
    // Habituation must not be so eager that ordinary emphasis reads as fatigue.
    const n = node();
    for (let i = 0; i < 3; i++) useSynapse(n, T0 + i * 4 * MIN);
    expect(stpTerm(n, T0 + 13 * MIN)).toBeGreaterThan(0);
  });

  it('makes a memory just raised easier to reach again in the same breath', () => {
    // The priming requirement: recall should chain, not restart.
    const primed = node();
    const cold = node({ id: 'n2' });
    useSynapse(primed, T0);
    expect(stpTerm(primed, T0 + 2 * MIN)).toBeGreaterThan(stpTerm(cold, T0 + 2 * MIN));
  });

  it('clears the fatigue of a whole scene by the next day', () => {
    const n = node();
    for (let i = 0; i < 8; i++) useSynapse(n, T0 + i * 3 * MIN);
    const spent = stpTerm(n, T0 + 25 * MIN);
    const nextDay = stpTerm(n, T0 + 24 * HOUR);
    expect(nextDay).toBeGreaterThan(spent);
    expect(nextDay).toBeGreaterThan(-0.1);
  });
});

describe('decay forecast (§B.2 #11)', () => {
  const p = { decay: 0.5, fadeBelow: -0.6, dormantBelow: -1.8 };

  it('predicts a fade time for an ordinary unused episodic', () => {
    const n = node();
    const f = forecastDecay(n, T0, p);
    expect(f.daysToFade).toBeGreaterThan(0);
    expect(f.label.toLowerCase()).toMatch(/fade/);
  });

  it('refuses to forecast fade for identity and pinned traces', () => {
    expect(forecastDecay(node({ kind: 'identity' }), T0, p).fadeInMs).toBeNull();
    expect(forecastDecay(node({ pinned: true }), T0, p).fadeInMs).toBeNull();
  });

  it('says a schema fades when its evidence does, not on the clock', () => {
    expect(forecastDecay(node({ kind: 'schema' }), T0, p).label).toMatch(/evidence/i);
  });
});
