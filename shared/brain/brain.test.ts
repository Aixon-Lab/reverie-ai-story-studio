/**
 * Character Brain engine tests.
 *
 * These assert the *laws* from docs/research/human-memory-architecture.md, not
 * implementation details — if a refactor keeps the psychology right, these keep
 * passing.
 */
import { describe, it, expect } from 'vitest';
import {
  addTrace, ageIn, assocStrength, baseLevel, emotionalBoost, recallProbability,
  similarity, verbatimStrength,
} from './activation';
import { DEFAULT_PARAMS, MAX_BRAIN_SHARE, TIME_UNIT_MS, emptyBrain, neutralTraits, normalizeBrain } from './defaults';
import { appraiseToAffect, contextBindingFor, isTraumatic, personalizeAppraisal, updateMood, neutralAppraisal } from './emotion';
import { encodeEvent } from './encoding';
import { consolidate, destabilisationThreshold, predictionError } from './consolidation';
import { cueFromContext, recall } from './retrieval';
import { planContext } from './budget';
import { composeBrainContext } from './compose';
import { applyDrift, dispositionFromText, traitPressure, updateRelation } from './personality';
import { heuristicEncode } from './heuristics';
import type { Appraisal, AppraisedEvent, BrainState, MemoryNode } from './types';

const DAY = TIME_UNIT_MS;
const T0 = 1_700_000_000_000;

function node(over: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: over.id ?? 'n1',
    kind: 'episodic',
    gist: 'something happened',
    encodedAt: T0,
    uses: [T0],
    useCount: 1,
    permanentBoost: 0,
    affect: { valence: 0, arousal: 0.2, dominance: 0, label: 'neutral' },
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

function appraisal(over: Partial<Appraisal> = {}): Appraisal {
  return { ...neutralAppraisal(), ...over };
}

function event(over: Partial<AppraisedEvent> = {}): AppraisedEvent {
  return {
    gist: 'an event of some importance occurred',
    actors: [],
    tags: [],
    appraisal: appraisal(),
    salience: 0.5,
    ...over,
  };
}

let idSeq = 0;
const makeId = () => `id-${++idSeq}`;

// ---------------------------------------------------------------- activation

describe('forgetting follows a power law, not an exponential (§3.1)', () => {
  const p = DEFAULT_PARAMS;

  it('decays monotonically with age', () => {
    const n = node();
    const a1 = baseLevel(n, T0 + DAY, p);
    const a7 = baseLevel(n, T0 + 7 * DAY, p);
    const a30 = baseLevel(n, T0 + 30 * DAY, p);
    expect(a1).toBeGreaterThan(a7);
    expect(a7).toBeGreaterThan(a30);
  });

  it("obeys Jost's law: the same absolute delay costs an old memory less than a young one", () => {
    const n = node();
    const youngLoss = baseLevel(n, T0 + 1 * DAY, p) - baseLevel(n, T0 + 8 * DAY, p);
    const oldLoss = baseLevel(n, T0 + 200 * DAY, p) - baseLevel(n, T0 + 207 * DAY, p);
    expect(oldLoss).toBeLessThan(youngLoss);
  });

  it('is not exponential: the decay ratio itself shrinks over time', () => {
    const n = node();
    // For an exponential, equal time steps give equal *ratios* of retention.
    const s = (days: number) => Math.exp(baseLevel(n, T0 + days * DAY, p));
    const early = s(2) / s(1);
    const late = s(200) / s(199);
    expect(late).toBeGreaterThan(early);
  });
});

describe('repetition and spacing (§3.3, §4.1)', () => {
  const p = DEFAULT_PARAMS;

  it('repeated encounters strengthen a memory', () => {
    const once = node();
    const many = node({ uses: [T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY], useCount: 4 });
    const now = T0 + 10 * DAY;
    expect(baseLevel(many, now, p)).toBeGreaterThan(baseLevel(once, now, p));
  });

  it('spaced repetition beats massed repetition of the same count', () => {
    const now = T0 + 60 * DAY;
    const massed = node({ uses: [T0, T0 + 60_000, T0 + 120_000, T0 + 180_000], useCount: 4 });
    const spaced = node({ uses: [T0, T0 + 5 * DAY, T0 + 15 * DAY, T0 + 30 * DAY], useCount: 4 });
    expect(baseLevel(spaced, now, p)).toBeGreaterThan(baseLevel(massed, now, p));
  });

  it('shows diminishing returns — the tenth repetition adds less than the second', () => {
    const now = T0 + 20 * DAY;
    const at = (n: number) => baseLevel(
      node({ uses: Array.from({ length: n }, (_, i) => T0 + i * DAY), useCount: n }),
      now,
      p,
    );
    expect(at(2) - at(1)).toBeGreaterThan(at(10) - at(9));
  });

  it('addTrace caps stored history but keeps the true count', () => {
    const n = node();
    const params = { ...DEFAULT_PARAMS, maxTraceHistory: 8 };
    for (let i = 0; i < 40; i++) addTrace(n, T0 + i * 1000, params);
    expect(n.uses.length).toBeLessThanOrEqual(8);
    expect(n.useCount).toBe(41);
    expect(Number.isFinite(baseLevel(n, T0 + 5 * DAY, params))).toBe(true);
  });
});

describe('emotion modulates durability (§5.1)', () => {
  it('an arousing memory outlives a flat one', () => {
    const p = DEFAULT_PARAMS;
    const calm = node();
    const intense = node({
      affect: { valence: -0.8, arousal: 0.95, dominance: -0.5, label: 'fear' },
      permanentBoost: emotionalBoost({ valence: -0.8, arousal: 0.95, dominance: -0.5, label: 'fear' }, p),
    });
    const now = T0 + 365 * DAY;
    expect(baseLevel(intense, now, p)).toBeGreaterThan(baseLevel(calm, now, p));
    // And it is still actually retrievable a year later.
    expect(recallProbability(baseLevel(intense, now, p), p)).toBeGreaterThan(0.5);
    expect(recallProbability(baseLevel(calm, now, p), p)).toBeLessThan(0.5);
  });
});

describe('interference: a cue linked to everything discriminates nothing (§4.3)', () => {
  it('associative strength falls with fan', () => {
    expect(assocStrength(1, DEFAULT_PARAMS)).toBeGreaterThan(assocStrength(20, DEFAULT_PARAMS));
  });
});

describe('verbatim fades far faster than gist (§7.3)', () => {
  it('drops below the retention floor while the gist is still strong', () => {
    const p = DEFAULT_PARAMS;
    const n = node();
    expect(verbatimStrength(n, T0 + 0.2 * DAY, p)).toBeGreaterThan(p.verbatimFloor);
    expect(verbatimStrength(n, T0 + 30 * DAY, p)).toBeLessThan(p.verbatimFloor);
    // The memory itself is still perfectly available at that point.
    expect(baseLevel(n, T0 + 30 * DAY, p)).toBeGreaterThan(p.dormantBelow);
  });

  it('emotional arousal protects surface detail for longer (flashbulb)', () => {
    const p = DEFAULT_PARAMS;
    const flat = node();
    const vivid = node({ affect: { valence: -0.9, arousal: 0.95, dominance: -0.4, label: 'horror' } });
    const now = T0 + 5 * DAY;
    expect(verbatimStrength(vivid, now, p)).toBeGreaterThan(verbatimStrength(flat, now, p));
  });
});

// ------------------------------------------------------------------- emotion

describe('appraisal is person-relative — the individuality mechanism (§5.4)', () => {
  const threat = appraisal({
    novelty: 0.7, pleasantness: -0.6, goalRelevance: 0.9,
    goalConduciveness: -0.8, agency: 'other', intent: -0.7,
    copingPotential: 0.5, norms: -0.5, urgency: 0.8,
  });

  it('a strong-willed character meets an identical threat with anger', () => {
    const brave = emptyBrain('chat1', 'c', 'Brave');
    brave.traits = { ...brave.traits, courage: 0.9, dominance: 0.8, volatility: -0.3, selfWorth: 0.6 };
    const a = personalizeAppraisal(threat, brave.traits, brave.workingSelf);
    const felt = appraiseToAffect(a, brave.traits);
    expect(a.copingPotential).toBeGreaterThan(threat.copingPotential);
    expect(felt.dominance).toBeGreaterThan(0);
    expect(['anger', 'contempt']).toContain(felt.label);
  });

  it('a timid character meets the same threat with fear', () => {
    const timid = emptyBrain('chat1', 'c', 'Timid');
    timid.traits = { ...timid.traits, courage: -0.85, dominance: -0.6, volatility: 0.6, selfWorth: -0.4 };
    const a = personalizeAppraisal(threat, timid.traits, timid.workingSelf);
    const felt = appraiseToAffect(a, timid.traits);
    expect(a.copingPotential).toBeLessThan(threat.copingPotential);
    expect(felt.dominance).toBeLessThan(0);
    expect(['fear', 'anxiety', 'humiliation']).toContain(felt.label);
  });

  it('a distrustful character reads ambiguous intent as more hostile', () => {
    const ambiguous = appraisal({ agency: 'other', intent: 0, goalConduciveness: -0.3 });
    const trusting = emptyBrain('chat1', 'a', 'A');
    trusting.traits = { ...trusting.traits, trust: 0.8 };
    const paranoid = emptyBrain('chat1', 'b', 'B');
    paranoid.traits = { ...paranoid.traits, trust: -0.8 };
    expect(personalizeAppraisal(ambiguous, paranoid.traits).intent)
      .toBeLessThan(personalizeAppraisal(ambiguous, trusting.traits).intent);
  });
});

describe('mood is a lagging average that returns to baseline (§5.5)', () => {
  it('moves toward what was felt, then settles back when nothing happens', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const grim = { valence: -0.9, arousal: 0.8, dominance: -0.5, label: 'grief' as const };
    const after = updateMood(brain.mood, [grim, grim], brain.traits, DEFAULT_PARAMS);
    expect(after.valence).toBeLessThan(brain.mood.valence);

    let settling = after;
    for (let i = 0; i < 25; i++) settling = updateMood(settling, [], brain.traits, DEFAULT_PARAMS);
    expect(Math.abs(settling.valence)).toBeLessThan(Math.abs(after.valence));
  });
});

// ------------------------------------------------------------------ encoding

describe('encoding is selective — most of experience is discarded (§2.2)', () => {
  it('drops a forgettable exchange', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const result = encodeEvent(
      brain,
      event({ salience: 0.05, appraisal: appraisal({ goalRelevance: 0.05, novelty: 0.05, urgency: 0 }) }),
      { now: T0, makeId },
    );
    expect(result.skipped).toBe(true);
    expect(Object.keys(brain.nodes)).toHaveLength(0);
  });

  it('keeps a consequential one and boosts it by arousal', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const result = encodeEvent(
      brain,
      event({
        salience: 0.85,
        appraisal: appraisal({
          novelty: 0.8, goalRelevance: 0.9, goalConduciveness: -0.8,
          agency: 'other', intent: -0.8, urgency: 0.8, norms: -0.7,
        }),
      }),
      { now: T0, makeId },
    );
    expect(result.skipped).toBe(false);
    expect(result.node!.permanentBoost).toBeGreaterThan(0.5);
  });

  it('marks identity-relevant events and never lets them fade', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const r = encodeEvent(brain, event({ salience: 0.9, identityRelevant: true }), { now: T0, makeId });
    expect(r.node!.kind).toBe('identity');
    consolidate(brain, { events: [], now: T0 + 3650 * DAY, makeId });
    expect(brain.nodes[r.node!.id].status).toBe('active');
  });
});

describe('trauma encodes differently (§8)', () => {
  const traumatic = appraisal({
    novelty: 0.95, pleasantness: -0.95, goalRelevance: 1,
    goalConduciveness: -1, agency: 'other', intent: -0.9,
    copingPotential: 0.02, norms: -0.9, urgency: 1,
  });

  it('splits into a strong sensory trace and a weakened contextual one', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    brain.traits = { ...brain.traits, courage: -0.4, volatility: 0.5 };
    const felt = appraiseToAffect(personalizeAppraisal(traumatic, brain.traits), brain.traits);
    expect(isTraumatic(felt, personalizeAppraisal(traumatic, brain.traits), DEFAULT_PARAMS)).toBe(true);

    const r = encodeEvent(
      brain,
      event({ salience: 1, appraisal: traumatic, detail: 'the smell of wet iron and a door that would not open' }),
      { now: T0, makeId },
    );
    expect(r.sensory).toBeTruthy();
    expect(r.sensory!.intrusive).toBe(true);
    expect(r.sensory!.place).toBeUndefined();          // no spatiotemporal binding
    expect(r.sensory!.contextBinding).toBeLessThan(0.4);
    expect(r.sensory!.permanentBoost).toBeGreaterThan(r.node!.permanentBoost);
  });

  it('extreme stress degrades context binding', () => {
    const calm = contextBindingFor({ valence: 0.1, arousal: 0.2, dominance: 0.2, label: 'calm' }, appraisal());
    const overwhelming = contextBindingFor(
      { valence: -0.9, arousal: 0.98, dominance: -0.9, label: 'horror' },
      appraisal({ copingPotential: 0.02 }),
    );
    expect(overwhelming).toBeLessThan(calm);
  });

  it('an intrusive trace fires on a matching cue even below threshold', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const r = encodeEvent(
      brain,
      event({
        salience: 1,
        appraisal: traumatic,
        detail: 'wet iron, a door that would not open',
        tags: ['iron', 'door'],
      }),
      { now: T0, makeId },
    );
    expect(r.sensory).toBeTruthy();
    const cue = cueFromContext({
      recentText: 'the door smells of wet iron',
      actors: [],
      brain,
      now: T0 + 900 * DAY,
    });
    const hits = recall(brain, cue, { rng: () => 0.5 }).hits;
    expect(hits.some((h) => h.node.id === r.sensory!.id && h.intrusion)).toBe(true);
    // Intrusions arrive first — they are not chosen.
    expect(hits[0].intrusion).toBe(true);
  });
});

// ------------------------------------------------------------- consolidation

describe('consolidation transforms rather than deletes (§7, §13.1)', () => {
  it('derives a semantic gist from repeated similar episodes and weakens the parents', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const gists = [
      'Kira promised to meet at the bridge and never came',
      'Kira promised to meet at the docks and never came',
      'Kira promised to meet at the inn and never came',
    ];
    for (const gist of gists) {
      encodeEvent(brain, event({ gist, salience: 0.7, actors: ['Kira'] }), { now: T0, makeId });
    }
    const before = Object.values(brain.nodes).map((n) => n.permanentBoost);

    const report = consolidate(brain, { events: [], now: T0 + 3 * DAY, makeId });

    expect(report.semanticised.length).toBeGreaterThan(0);
    const semantic = Object.values(brain.nodes).filter((n) => n.kind === 'semantic');
    expect(semantic.length).toBeGreaterThan(0);
    expect(semantic[0].place).toBeUndefined();       // decontextualised
    // The episodes still exist — transformation, not transfer.
    expect(Object.values(brain.nodes).filter((n) => n.kind === 'episodic')).toHaveLength(3);
    const after = Object.values(brain.nodes).filter((n) => n.kind === 'episodic').map((n) => n.permanentBoost);
    expect(Math.max(...after)).toBeLessThanOrEqual(Math.max(...before));
    // And they are wired to the generalisation.
    expect(brain.edges.some((e) => e.kind === 'instance_of')).toBe(true);
  });

  it('a recurring event adds a trace instead of a duplicate node', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const gist = 'Marek lied about where he had been that night';
    encodeEvent(brain, event({ gist, salience: 0.7, actors: ['Marek'] }), { now: T0, makeId });
    const id = Object.keys(brain.nodes)[0];

    consolidate(brain, {
      events: [event({ gist, salience: 0.7, actors: ['Marek'] })],
      now: T0 + 2 * DAY,
      makeId,
    });

    expect(Object.keys(brain.nodes)).toHaveLength(1);
    expect(brain.nodes[id].useCount).toBe(2);
  });
});

describe('reconsolidation needs prediction error, scaled by strength and age (§6)', () => {
  it('a strong old conviction resists a weak challenge', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const conviction = node({
      id: 'conv',
      gist: 'my brother saved my life in the flood',
      permanentBoost: 2.4,
      uses: Array.from({ length: 12 }, (_, i) => T0 + i * 30 * DAY),
      useCount: 12,
    });
    brain.nodes.conv = conviction;
    const now = T0 + 400 * DAY;

    const weak = event({ gist: 'my brother saved my life in the flood, more or less' });
    expect(predictionError(conviction, weak))
      .toBeLessThan(destabilisationThreshold(conviction, now, brain));

    const strong = event({
      gist: 'my brother stood on the bank and watched me go under',
      appraisal: appraisal({ goalConduciveness: -0.9, agency: 'other', intent: -0.8 }),
      updates: [{ nodeId: 'conv', kind: 'contradicts' }],
    });
    expect(predictionError(conviction, strong))
      .toBeGreaterThan(destabilisationThreshold(conviction, now, brain));
  });

  it('pinned memories can never be rewritten', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    brain.nodes.p = node({ id: 'p', pinned: true });
    expect(destabilisationThreshold(brain.nodes.p, T0, brain)).toBe(Infinity);
  });

  it('rewriting costs accuracy but not conviction', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    brain.nodes.n1 = node({ id: 'n1', gist: 'she said she would stay', fidelity: 0.9, confidence: 0.8 });
    consolidate(brain, {
      events: [event({
        gist: 'she said she would stay only until spring',
        updates: [{ nodeId: 'n1', kind: 'extends', newGist: 'she said she would stay only until spring' }],
      })],
      now: T0 + 2 * DAY,
      makeId,
    });
    expect(brain.nodes.n1.fidelity).toBeLessThan(0.9);
    expect(brain.nodes.n1.verbatim).toBeUndefined();
    expect(brain.nodes.n1.gist).toContain('spring');
  });
});

describe('forgetting suppresses before it deletes (§3.2)', () => {
  it('walks a trivial memory active → faded → dormant without losing it', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    // Just over the encoding threshold: worth keeping today, not worth keeping forever.
    const encoded = encodeEvent(
      brain,
      event({
        gist: 'a passing remark about the weather',
        salience: 0.45,
        appraisal: appraisal({ goalRelevance: 0.35 }),
      }),
      { now: T0, makeId },
    );
    expect(encoded.skipped).toBe(false);
    const id = encoded.node!.id;

    consolidate(brain, { events: [], now: T0 + 20 * DAY, makeId });
    expect(['faded', 'dormant']).toContain(brain.nodes[id]?.status ?? 'gone');

    // Still reachable with a strong, specific cue — the tip-of-the-tongue state.
    const found = recall(brain, cueFromContext({
      recentText: 'a passing remark about the weather', actors: [], brain, now: T0 + 20 * DAY,
    }), { includeBelowThreshold: true, rng: () => 0.5 });
    expect(found.hits.some((h) => h.node.id === id)).toBe(true);
  });

  it('never prunes identity, schema or trauma nodes', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    brain.nodes.i = node({ id: 'i', kind: 'identity' });
    brain.nodes.s = node({ id: 's', kind: 'schema' });
    brain.nodes.t = node({ id: 't', kind: 'sensory', intrusive: true });
    consolidate(brain, { events: [], now: T0 + 10_000 * DAY, makeId });
    expect(brain.nodes.i).toBeTruthy();
    expect(brain.nodes.s).toBeTruthy();
    expect(brain.nodes.t).toBeTruthy();
  });
});

// ------------------------------------------------------------------ recall

describe('retrieval (§4.2, §7.4)', () => {
  function populated(): BrainState {
    const brain = emptyBrain('chat1', 'c', 'C');
    encodeEvent(brain, event({
      gist: 'Kira handed over the ledger in the harbour warehouse',
      salience: 0.8, actors: ['Kira'], place: 'warehouse', tags: ['ledger', 'harbour'],
    }), { now: T0, makeId });
    encodeEvent(brain, event({
      gist: 'a long dull argument about grain prices',
      salience: 0.4, actors: ['Tomas'], tags: ['grain'],
    }), { now: T0, makeId });
    return brain;
  }

  it('a matching cue outranks an unrelated memory', () => {
    const brain = populated();
    const res = recall(brain, cueFromContext({
      recentText: 'the ledger from the harbour', actors: ['Kira'], brain, now: T0 + DAY,
    }), { rng: () => 0.5 });
    expect(res.hits[0].node.gist).toContain('ledger');
  });

  it('being present as an actor lifts activation', () => {
    const brain = populated();
    const withKira = recall(brain, cueFromContext({ recentText: 'we talk', actors: ['Kira'], brain, now: T0 + DAY }), { rng: () => 0.5 });
    const without = recall(brain, cueFromContext({ recentText: 'we talk', actors: [], brain, now: T0 + DAY }), { rng: () => 0.5 });
    const a = withKira.hits.find((h) => h.node.gist.includes('ledger'))!.activation;
    const b = without.hits.find((h) => h.node.gist.includes('ledger'))!.activation;
    expect(a).toBeGreaterThan(b);
  });

  it('retrieval strengthens what was recalled and suppresses its competitors', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    for (const g of ['Kira at the bridge', 'Kira at the docks', 'Kira at the inn']) {
      encodeEvent(brain, event({ gist: g, salience: 0.7, actors: ['Kira'], tags: ['kira'] }), { now: T0, makeId });
    }
    const target = Object.values(brain.nodes).find((n) => n.gist.includes('bridge'))!;
    const before = target.useCount;

    recall(brain, cueFromContext({ recentText: 'Kira at the bridge', actors: ['Kira'], brain, now: T0 + DAY }),
      { limit: 1, mutate: true, rng: () => 0.5 });

    expect(brain.nodes[target.id].useCount).toBeGreaterThan(before);
    const suppressedOthers = Object.values(brain.nodes).filter((n) => n.id !== target.id && (n.suppressed ?? 0) > 0);
    expect(suppressedOthers.length).toBeGreaterThan(0);
  });

  it('mood-congruent memories surface preferentially', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    encodeEvent(brain, event({ gist: 'a warm evening by the fire', salience: 0.7, appraisal: appraisal({ pleasantness: 0.9, goalConduciveness: 0.8 }) }), { now: T0, makeId });
    encodeEvent(brain, event({ gist: 'a cold night on the road', salience: 0.7, appraisal: appraisal({ pleasantness: -0.9, goalConduciveness: -0.8 }) }), { now: T0, makeId });

    brain.mood = { valence: -0.9, arousal: 0.4, dominance: -0.2, label: 'sadness' };
    const grim = recall(brain, cueFromContext({ recentText: 'a night', actors: [], brain, now: T0 + DAY }), { rng: () => 0.5 });
    const cold = grim.hits.find((h) => h.node.gist.includes('cold'))!;
    const warm = grim.hits.find((h) => h.node.gist.includes('warm'))!;
    expect(cold.breakdown.moodCongruence).toBeGreaterThan(warm.breakdown.moodCongruence);
  });

  it('a formative memory is still available years later, even a traumatic one', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const r = encodeEvent(brain, event({
      gist: 'Kira sold the route and Sera was taken in the night',
      salience: 1,
      identityRelevant: true,
      actors: ['Kira'],
      detail: 'wet iron and a door that would not open',
      appraisal: appraisal({
        novelty: 0.95, pleasantness: -0.95, goalRelevance: 1, goalConduciveness: -1,
        agency: 'other', intent: -0.95, copingPotential: 0.02, norms: -0.95, urgency: 1,
      }),
    }), { now: T0, makeId });
    expect(r.node!.kind).toBe('identity');
    expect(r.sensory).toBeTruthy();       // trauma split still happened

    const hits = recall(brain, cueFromContext({
      recentText: 'Kira steps out of the dark', actors: ['Kira'], brain, now: T0 + 800 * DAY,
    }), { rng: () => 0.5 }).hits;
    expect(hits.some((h) => h.node.id === r.node!.id)).toBe(true);

    const out = composeBrainContext(brain, hits, { budget: 4000, now: T0 + 800 * DAY, presentActors: ['Kira'] });
    expect(out.text).toContain('Formative');
  });

  it('debug recall does not mutate the brain', () => {
    const brain = populated();
    const before = JSON.stringify(brain.nodes);
    recall(brain, cueFromContext({ recentText: 'ledger', actors: [], brain, now: T0 + DAY }), { rng: () => 0.5 });
    expect(JSON.stringify(brain.nodes)).toBe(before);
  });
});

// ------------------------------------------------------------------ budget

describe('context budget — the one-third rule (§5 of the spec)', () => {
  it('never gives the brain more than a third of usable context', () => {
    const plan = planContext({ modelContext: 200_000, reservedOutput: 4_000, share: 1, brainDemand: 10_000_000 });
    expect(plan.brainBudget / plan.usable).toBeLessThanOrEqual(MAX_BRAIN_SHARE + 1e-9);
    expect(plan.historyBudget).toBeGreaterThan(0);
  });

  it('takes only what it needs when memory is still small', () => {
    const plan = planContext({ modelContext: 200_000, reservedOutput: 4_000, brainDemand: 900 });
    expect(plan.brainBudget).toBe(900);
    // Everything else goes to the conversation.
    expect(plan.historyBudget).toBe(plan.usable - 900);
  });

  it('regrows on a bigger model and shrinks on a smaller one', () => {
    const demand = 10_000_000;
    const small = planContext({ modelContext: 8_192, reservedOutput: 1_024, brainDemand: demand });
    const large = planContext({ modelContext: 1_000_000, reservedOutput: 1_024, brainDemand: demand });
    expect(large.brainBudget).toBeGreaterThan(small.brainBudget);
    expect(large.brainBudget / large.usable).toBeLessThanOrEqual(MAX_BRAIN_SHARE + 1e-9);
    expect(small.brainBudget / small.usable).toBeLessThanOrEqual(MAX_BRAIN_SHARE + 1e-9);
  });

  it('leaves room for the conversation even on a tiny window', () => {
    const plan = planContext({ modelContext: 4_096, reservedOutput: 1_024, brainDemand: 999_999, fixedPromptTokens: 1_200 });
    expect(plan.historyBudget).toBeGreaterThanOrEqual(512);
  });

  it('respects the user preset context when it is smaller than the model window', () => {
    const byModel = planContext({ modelContext: 1_000_000, reservedOutput: 1_024, brainDemand: 999_999 });
    const byPreset = planContext({ modelContext: 16_000, reservedOutput: 1_024, brainDemand: 999_999 });
    expect(byPreset.brainBudget).toBeLessThan(byModel.brainBudget);
  });
});

describe('consolidation forgets to stay inside its budget', () => {
  it('demotes the weakest memories when the active footprint exceeds the cap', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    for (let i = 0; i < 40; i++) {
      encodeEvent(brain, event({
        gist: `event number ${i} in which a reasonably long thing happened to someone somewhere`,
        salience: 0.4 + (i % 7) * 0.05,
      }), { now: T0 + i * 1000, makeId });
    }
    const activeBefore = Object.values(brain.nodes).filter((n) => n.status === 'active').length;
    consolidate(brain, {
      events: [],
      now: T0 + DAY,
      makeId,
      activeTokenCap: 120,
      countTokens: (t) => Math.ceil(t.length / 4),
    });
    const activeAfter = Object.values(brain.nodes).filter((n) => n.status === 'active').length;
    expect(activeAfter).toBeLessThan(activeBefore);
    // Nothing was destroyed, just made less available.
    expect(Object.keys(brain.nodes).length).toBeGreaterThanOrEqual(activeBefore);
  });
});

// ------------------------------------------------------------------ compose

describe('composition renders memory at the resolution the trace supports (§7.3)', () => {
  it('quotes exactly when the trace is sharp and hedges when it is not', () => {
    const brain = emptyBrain('chat1', 'c', 'Sera');
    const sharp = node({
      id: 'sharp',
      gist: 'she promised to come back before the frost',
      verbatim: 'I will be back before the frost, I swear it',
      permanentBoost: 2.5,
      fidelity: 0.9,
    });
    const hazy = node({ id: 'hazy', gist: 'a quarrel over money', fidelity: 0.2, confidence: 0.3 });
    brain.nodes.sharp = sharp;
    brain.nodes.hazy = hazy;

    const hits = recall(brain, cueFromContext({ recentText: 'frost money', actors: [], brain, now: T0 + 0.5 * DAY }),
      { includeBelowThreshold: true, rng: () => 0.5 }).hits;
    const out = composeBrainContext(brain, hits, { budget: 4000, now: T0 + 0.5 * DAY });

    expect(out.text).toContain('before the frost, I swear it');
    expect(out.text).toMatch(/hazy|something about|only the shape/i);
  });

  it('honours its token budget', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    for (let i = 0; i < 60; i++) {
      brain.nodes[`n${i}`] = node({ id: `n${i}`, gist: `a memory numbered ${i} with a fair amount of text in it`, permanentBoost: 2 });
    }
    const hits = recall(brain, cueFromContext({ recentText: 'memory', actors: [], brain, now: T0 + DAY }), { rng: () => 0.5 }).hits;
    const out = composeBrainContext(brain, hits, { budget: 220, now: T0 + DAY });
    expect(out.tokens).toBeLessThanOrEqual(220);
  });

  it('surfaces intrusions before anything else', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    brain.nodes.t = node({
      id: 't', kind: 'sensory', intrusive: true, contextBinding: 0.1,
      gist: 'wet iron and a door that will not open',
      detail: 'wet iron and a door that will not open',
      tags: ['iron', 'door'], permanentBoost: 3,
    });
    brain.nodes.o = node({ id: 'o', gist: 'an ordinary afternoon', permanentBoost: 1 });
    const hits = recall(brain, cueFromContext({ recentText: 'the iron door', actors: [], brain, now: T0 + DAY }), { rng: () => 0.5 }).hits;
    const out = composeBrainContext(brain, hits, { budget: 4000, now: T0 + DAY });
    expect(out.text).toContain('Unbidden');
    expect(out.text.indexOf('Unbidden')).toBeLessThan(out.text.indexOf('an ordinary afternoon'));
  });
});

// -------------------------------------------------------------- personality

describe('personality drifts, bounded by disposition (§9.3)', () => {
  it('accumulated betrayal erodes trust but never past the bound', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    brain.disposition = { ...brain.disposition, trust: 0.6 };
    brain.traits = { ...brain.disposition };

    const betrayal = node({
      affect: { valence: -0.85, arousal: 0.9, dominance: -0.4, label: 'anger' },
      appraisal: appraisal({ agency: 'other', intent: -0.9, goalConduciveness: -0.9, goalRelevance: 0.9, copingPotential: 0.2 }),
    });

    for (let i = 0; i < 200; i++) applyDrift(brain, [traitPressure(betrayal)], DEFAULT_PARAMS);

    expect(brain.traits.trust).toBeLessThan(brain.disposition.trust);
    expect(brain.traits.trust).toBeGreaterThanOrEqual(brain.disposition.trust - DEFAULT_PARAMS.maxDrift - 1e-6);
  });

  it('regresses toward disposition once the evidence stops', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    brain.disposition = { ...brain.disposition, courage: 0.5 };
    brain.traits = { ...brain.disposition, courage: 0.05 };
    for (let i = 0; i < 200; i++) applyDrift(brain, [], DEFAULT_PARAMS);
    expect(brain.traits.courage).toBeGreaterThan(0.05);
  });

  it('single events do not rewrite a person', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const before = { ...brain.traits };
    applyDrift(brain, [traitPressure(node({
      affect: { valence: -0.8, arousal: 0.8, dominance: -0.5, label: 'fear' },
      appraisal: appraisal({ goalConduciveness: -0.8, copingPotential: 0.1, goalRelevance: 0.9 }),
    }))], DEFAULT_PARAMS);
    for (const axis of Object.keys(before) as (keyof typeof before)[]) {
      expect(Math.abs(brain.traits[axis] - before[axis])).toBeLessThan(0.06);
    }
  });
});

describe('a brain knows whether its baseline was ever built', () => {
  it('starts with no disposition source, so it can be repaired later', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    expect(brain.dispositionSource).toBe('none');
    expect(Object.values(brain.disposition).every((v) => v === 0)).toBe(true);
  });

  it('infers a source for brains written before the field existed', () => {
    const legacyWithAnchor = normalizeBrain(
      { disposition: { ...neutralTraits(), courage: 0.6 } } as any,
      'chat1', 'c', 'C',
    );
    expect(legacyWithAnchor.dispositionSource).toBe('lexicon');

    const legacyBlank = normalizeBrain({ nodes: {} } as any, 'chat1', 'c', 'C');
    expect(legacyBlank.dispositionSource).toBe('none');
  });

  it('a zero anchor leaves appraisal neutral — which is why it must be repaired', () => {
    const blank = emptyBrain('chat1', 'c', 'Blank');
    const threat = appraisal({
      goalConduciveness: -0.8, agency: 'other', intent: -0.7,
      copingPotential: 0.5, goalRelevance: 0.9, urgency: 0.8,
    });
    // With no temperament, the personalised appraisal is the raw one.
    const a = personalizeAppraisal(threat, blank.traits, blank.workingSelf);
    expect(a.copingPotential).toBeCloseTo(threat.copingPotential, 6);
  });
});

describe('relationships update asymmetrically (§9.2)', () => {
  it('trust falls faster than it rises', () => {
    const brain = emptyBrain('chat1', 'c', 'C');
    const harm = node({
      affect: { valence: -0.8, arousal: 0.8, dominance: -0.3, label: 'anger' },
      appraisal: appraisal({ agency: 'other', intent: -0.8, goalConduciveness: -0.8 }),
    });
    const help = node({
      affect: { valence: 0.8, arousal: 0.8, dominance: 0.3, label: 'gratitude' },
      appraisal: appraisal({ agency: 'other', intent: 0.8, goalConduciveness: 0.8 }),
    });

    updateRelation(brain, 'Kira', harm, T0);
    const afterHarm = brain.people.kira.trust;
    const brain2 = emptyBrain('chat1', 'c', 'C');
    updateRelation(brain2, 'Kira', help, T0);
    const afterHelp = brain2.people.kira.trust;

    expect(Math.abs(afterHarm)).toBeGreaterThan(Math.abs(afterHelp));
  });

  it('reads a disposition out of card text', () => {
    const timid = dispositionFromText('A timid, anxious apprentice, always nervous, easily frightened.');
    const bold = dispositionFromText('A fearless, commanding captain — bold, proud and utterly self-assured.');
    expect(timid.courage).toBeLessThan(0);
    expect(bold.courage).toBeGreaterThan(0);
    expect(bold.dominance).toBeGreaterThan(timid.dominance);
    expect(bold.selfWorth).toBeGreaterThan(timid.selfWorth);
  });
});

// ------------------------------------------------------------------ offline

describe('offline fallback keeps the brain growing without a model', () => {
  it('segments turns and produces usable appraised events', () => {
    const events = heuristicEncode([
      { id: '1', speaker: 'Kira', text: 'You betrayed me. You lied about all of it.', isUser: false },
      { id: '2', speaker: 'Sera', text: 'I had no choice. They would have killed you.', isUser: true },
      { id: '3', speaker: 'Kira', text: 'Then you should have let them.', isUser: false },
    ], 'Sera');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].appraisal.goalConduciveness).toBeLessThan(0);
    expect(events[0].salience).toBeGreaterThan(DEFAULT_PARAMS.encodeThreshold);
  });

  it('produces nothing from empty small talk', () => {
    const events = heuristicEncode([
      { id: '1', speaker: 'A', text: 'Hm.', isUser: false },
      { id: '2', speaker: 'B', text: 'Yes.', isUser: true },
    ], 'A');
    expect(events).toHaveLength(0);
  });
});

// -------------------------------------------------------------------- misc

describe('helpers', () => {
  it('ageIn floors at MIN_AGE so a fresh memory cannot be infinitely strong', () => {
    expect(Number.isFinite(ageIn(T0, T0))).toBe(true);
    expect(ageIn(T0, T0)).toBeGreaterThan(0);
  });

  it('similarity is symmetric and bounded', () => {
    const a = 'the ledger in the harbour warehouse';
    const b = 'a ledger found in the warehouse';
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 10);
    expect(similarity(a, a)).toBe(1);
    expect(similarity(a, 'entirely unrelated vocabulary regarding pastry')).toBeLessThan(0.2);
  });
});
