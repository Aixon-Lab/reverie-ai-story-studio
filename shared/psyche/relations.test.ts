/**
 * Attachment, identity and offline mentation (§P.6, §P.7).
 *
 * As with `psyche.test.ts`, each test pins a claim about people rather than a
 * line of code: trust falls faster than it rises, one good week does not undo a
 * history, people meet the same person twice, and time only heals what you have
 * looked at.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, neutralTraits } from '../brain/defaults';
import type { Chapter, MemoryNode } from '../brain/types';
import { DEFAULT_PSYCHE_PARAMS as P, emptyPsyche } from './defaults';
import {
  describeBond, ensureBond, isSupportive, transferPriors, updateBond, updateWorkingModel,
  type Bond,
} from './attachment';
import {
  buildSelfConcept, classifyChapter, describeLifeStory, describeSelfConcept, threatenedBelief,
} from './identity';
import { inferInterlude, mentate } from './mentation';
import type { GraphSummary } from './condition';
import type { PsycheState } from './types';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function bond(over: Partial<Bond> = {}): Bond {
  return {
    key: 'rooke', displayName: 'Rooke', trust: 0.6, affection: 0.5, fear: 0,
    respect: 0.4, resentment: 0, debt: 0, familiarity: 0.7, model: 'a careful man who keeps his word',
    interactions: 20, firstMetAt: NOW - 30 * DAY, lastSeenAt: NOW, ...over,
  };
}

function node(over: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: Math.random().toString(36).slice(2),
    kind: 'episodic',
    gist: 'something happened',
    encodedAt: NOW,
    uses: [NOW],
    useCount: 1,
    permanentBoost: 0.5,
    affect: { valence: 0, arousal: 0.3, dominance: 0, label: 'neutral' },
    appraisal: {
      novelty: 0.4, pleasantness: 0, goalRelevance: 0.5, goalConduciveness: 0,
      agency: 'other', intent: 0, copingPotential: 0.5, norms: 0, urgency: 0.3,
    },
    vividness: 0.5, confidence: 0.7, fidelity: 0.8,
    actors: [], tags: [], contextBinding: 0.6, suppressed: 0, status: 'active',
    ...over,
  };
}

const GRAPH: GraphSummary = {
  nodes: [], selfBeliefs: [], relationTrust: [], goalsFailed: 0, goalsTotal: 0,
};

// ------------------------------------------------------------- attachment

describe('bonds carry a prediction, so betrayal can be a shock (§P.6.1)', () => {
  const psyche = emptyPsyche(neutralTraits());

  it('seeds expectancy from trust for a relationship that predates the layer', () => {
    expect(ensureBond(bond(), psyche).expectancy).toBeCloseTo(0.48, 1);
  });

  it('measures prediction error against what was expected, not against how bad it was', () => {
    const trusted = updateBond(bond({ trust: 0.9 }), psyche, {
      behaviour: -0.9, stakes: 0.9, now: NOW,
    });
    const alreadySuspect = updateBond(bond({ trust: -0.8 }), psyche, {
      behaviour: -0.9, stakes: 0.9, now: NOW,
    });
    // Identical harm. Only one of them is a shock.
    expect(trusted.predictionError).toBeGreaterThan(alreadySuspect.predictionError);
    expect(trusted.rupture).toBe(true);
    expect(alreadySuspect.rupture).toBe(false);
  });

  it('THE ASYMMETRY: trust falls in one moment and returns over many', () => {
    let b = bond({ trust: 0.8 });
    const start = b.trust;
    b = updateBond(b, psyche, { behaviour: -0.9, stakes: 0.9, now: NOW }).bond;
    const afterRupture = b.trust;
    expect(afterRupture).toBeLessThan(start - 0.5);

    // Ten good-faith interactions do not get back to where it was.
    for (let i = 0; i < 10; i++) {
      b = updateBond(b, psyche, { behaviour: 0.8, stakes: 0.6, now: NOW + i * DAY }).bond;
    }
    expect(b.trust).toBeGreaterThan(afterRupture);
    expect(b.trust).toBeLessThan(start);
  });

  it('dependency makes the same betrayal cost more', () => {
    const needed = updateBond(
      bond({ affection: 0.9, familiarity: 0.9, fear: 0.4 }), psyche,
      { behaviour: -0.9, stakes: 0.9, now: NOW },
    );
    const peripheral = updateBond(
      bond({ affection: 0.1, familiarity: 0.2, fear: 0 }), psyche,
      { behaviour: -0.9, stakes: 0.9, now: NOW },
    );
    expect(needed.bond.trust).toBeLessThan(peripheral.bond.trust);
  });

  it('betrayal does not delete the affection, which is what makes it unbearable', () => {
    const after = updateBond(bond({ affection: 0.9, trust: 0.9 }), psyche, {
      behaviour: -0.9, stakes: 0.9, now: NOW,
    }).bond;
    expect(after.affection).toBeGreaterThan(0.5);
    expect(after.trust).toBeLessThan(0);
  });

  it('repair requires repetition, and one bad interaction resets the count', () => {
    let b = bond({ trust: -0.6, expectancy: -0.6 });
    for (let i = 0; i < 4; i++) {
      b = updateBond(b, psyche, { behaviour: 0.8, stakes: 0.6, now: NOW + i * DAY }).bond;
    }
    expect(b.disconfirming).toBe(4);

    b = updateBond(b, psyche, { behaviour: -0.6, stakes: 0.6, now: NOW + 5 * DAY }).bond;
    expect(b.disconfirming).toBe(0);
  });

  it('EARNED SECURITY: sustained good relationships move the global working model', () => {
    let psycheState: PsycheState = {
      ...emptyPsyche(neutralTraits()),
      attachment: { anxiety: 0.8, avoidance: 0.8 },
    };
    let b = bond({ key: 'friend', displayName: 'Tessa', trust: -0.5, expectancy: -0.5, affection: 0.4 });

    for (let i = 0; i < 30; i++) {
      b = updateBond(b, psycheState, { behaviour: 0.8, stakes: 0.6, now: NOW + i * DAY }).bond;
      psycheState = {
        ...psycheState,
        attachment: updateWorkingModel(psycheState, [b]),
      };
    }
    expect(psycheState.attachment.avoidance).toBeLessThan(0.6);
    // But it is slow — nobody is repaired in a month.
    expect(psycheState.attachment.avoidance).toBeGreaterThan(0.05);
  });

  it('one good bond does not outweigh a history of bad ones', () => {
    const state = { ...emptyPsyche(neutralTraits()), attachment: { anxiety: 0.7, avoidance: 0.7 } };
    const bad = [1, 2, 3].map((i) => bond({
      key: `bad${i}`, displayName: `Bad${i}`, attachAvoidance: 0.9, attachAnxiety: 0.8,
      affection: 0.6, familiarity: 0.9,
    }));
    const good = bond({ key: 'good', displayName: 'Good', attachAvoidance: 0.05, attachAnxiety: 0.05, affection: 0.6, familiarity: 0.9 });
    const model = updateWorkingModel(state, [...bad, good]);
    expect(model.avoidance).toBeGreaterThan(0.6);
  });

  it('TRANSFERENCE: a stranger who matches an old model inherits its priors', () => {
    const state = emptyPsyche(neutralTraits());
    const old = bond({
      key: 'kessler', displayName: 'Kessler', trust: -0.9, expectancy: -0.9, fear: 0.7,
      model: 'a powerful man who smiles while he takes things from you',
      interactions: 40,
    });
    const stranger: Bond = {
      key: 'new', displayName: 'Vance', trust: 0, affection: 0, fear: 0, respect: 0,
      resentment: 0, debt: 0, familiarity: 0, model: '', interactions: 0,
      firstMetAt: NOW, lastSeenAt: NOW,
    };
    const { bond: seeded, matched } = transferPriors(
      stranger, [old], state,
      'a powerful man who smiles while he takes things from people',
    );
    expect(matched?.key).toBe('kessler');
    expect(seeded.trust).toBeLessThan(-0.2);
    expect(seeded.transferredFrom).toBe('kessler');
  });

  it('does not transfer onto someone who resembles nobody', () => {
    const state = emptyPsyche(neutralTraits());
    const old = bond({ model: 'a careful man who keeps his word', interactions: 40 });
    const stranger: Bond = { ...bond({ key: 'x', displayName: 'X', model: '', interactions: 0, trust: 0 }) };
    const { matched } = transferPriors(stranger, [old], state, 'a loud woman who sells flowers');
    expect(matched).toBeUndefined();
  });

  it('only counts someone as support if they would actually be reached for', () => {
    const state = emptyPsyche(neutralTraits());
    expect(isSupportive(bond({ trust: 0.6, affection: 0.5, expectancy: 0.5 }), state)).toBe(true);
    // Present, warm, and frightening is not support.
    expect(isSupportive(bond({ trust: 0.6, affection: 0.5, expectancy: 0.5, fear: 0.6 }), state)).toBe(false);
  });

  it('describes the bond in terms a writer can act on', () => {
    const state = emptyPsyche(neutralTraits());
    const wounded = describeBond(bond({ ruptures: 1, dependency: 0.8, affection: 0.7 }), state);
    expect(wounded).toMatch(/still need|hurt/);
  });
});

// ------------------------------------------------------------- identity

describe('narrative identity (§P.6.2)', () => {
  function chapter(over: Partial<Chapter> = {}): Chapter {
    return {
      id: 'c1', title: 'The Ruins', theme: '', startedAt: NOW - 10 * DAY,
      tone: { valence: 0, arousal: 0.3, dominance: 0, label: 'neutral' },
      chatIds: ['chat'], ...over,
    };
  }

  it('reads a chapter that got better as redemption', () => {
    const nodes = [
      node({ chapterId: 'c1', encodedAt: NOW - 9 * DAY, affect: { valence: -0.8, arousal: 0.7, dominance: -0.5, label: 'grief' } }),
      node({ chapterId: 'c1', encodedAt: NOW - 8 * DAY, affect: { valence: -0.6, arousal: 0.6, dominance: -0.3, label: 'sadness' } }),
      node({ chapterId: 'c1', encodedAt: NOW - 2 * DAY, affect: { valence: 0.6, arousal: 0.4, dominance: 0.3, label: 'relief' } }),
      node({ chapterId: 'c1', encodedAt: NOW - DAY, affect: { valence: 0.8, arousal: 0.5, dominance: 0.4, label: 'hope' } }),
    ];
    const arc = classifyChapter(chapter({ endedAt: NOW }), nodes, NOW, DEFAULT_PARAMS);
    expect(arc.kind).toBe('redemption');
    expect(arc.slope).toBeGreaterThan(0);
  });

  it('reads a chapter that got worse as contamination', () => {
    const nodes = [
      node({ chapterId: 'c1', encodedAt: NOW - 9 * DAY, affect: { valence: 0.7, arousal: 0.4, dominance: 0.4, label: 'joy' } }),
      node({ chapterId: 'c1', encodedAt: NOW - 8 * DAY, affect: { valence: 0.6, arousal: 0.3, dominance: 0.3, label: 'calm' } }),
      node({ chapterId: 'c1', encodedAt: NOW - 2 * DAY, affect: { valence: -0.8, arousal: 0.8, dominance: -0.6, label: 'horror' } }),
      node({ chapterId: 'c1', encodedAt: NOW - DAY, affect: { valence: -0.9, arousal: 0.7, dominance: -0.7, label: 'grief' } }),
    ];
    const arc = classifyChapter(chapter({ endedAt: NOW }), nodes, NOW, DEFAULT_PARAMS);
    expect(arc.kind).toBe('contamination');
    expect(arc.telling).toMatch(/and then it was not/);
  });

  it('will not classify a chapter with nothing in it', () => {
    expect(classifyChapter(chapter(), [], NOW, DEFAULT_PARAMS).kind).toBe('unresolved');
  });

  it('MEASURES negative self-concept rather than asserting it', () => {
    const nodes = [
      node({
        kind: 'schema', gist: 'She is something people use and put down',
        affect: { valence: -0.9, arousal: 0.5, dominance: -0.6, label: 'shame' }, permanentBoost: 1.5,
      }),
      node({
        kind: 'identity', gist: 'She could not protect the Green',
        affect: { valence: -0.8, arousal: 0.6, dominance: -0.5, label: 'guilt' }, permanentBoost: 1.4,
      }),
      node({
        kind: 'schema', gist: 'She is good with growing things',
        affect: { valence: 0.5, arousal: 0.3, dominance: 0.3, label: 'pride' }, permanentBoost: 0.4,
      }),
    ];
    const self = buildSelfConcept(nodes, 'Wren', NOW, DEFAULT_PARAMS);
    expect(self.negativity).toBeGreaterThan(0.65);
    expect(self.images[0].conviction).toBeGreaterThan(0.4);
  });

  it('tracks counter-evidence a character has not absorbed', () => {
    const belief = node({
      kind: 'schema', gist: 'Nobody stays when it costs them something',
      affect: { valence: -0.8, arousal: 0.5, dominance: -0.5, label: 'loneliness' }, permanentBoost: 1.2,
    });
    // Two, not one: a single counterexample is dismissible, and the system should
    // only flag a *pattern* the character is declining to look at.
    const contradictions = [
      node({
        gist: 'Nobody stays when it costs them something — but Tessa stayed',
        affect: { valence: 0.7, arousal: 0.5, dominance: 0.2, label: 'affection' },
      }),
      node({
        gist: 'Nobody stays when it costs them something, and Tessa stayed again',
        affect: { valence: 0.6, arousal: 0.4, dominance: 0.2, label: 'gratitude' },
      }),
    ];
    const self = buildSelfConcept([belief, ...contradictions], 'Wren', NOW, DEFAULT_PARAMS);
    expect(self.images[0].counterEvidence.length).toBeGreaterThanOrEqual(2);
    expect(describeSelfConcept(self, 'Wren')).toMatch(/not looking at that/);
  });

  it('names the belief a scene threatens, so a moment can land on something', () => {
    const self = buildSelfConcept([
      node({
        kind: 'schema', gist: 'She is something people use',
        affect: { valence: -0.9, arousal: 0.5, dominance: -0.6, label: 'shame' },
      }),
    ], 'Wren', NOW, DEFAULT_PARAMS);
    const hit = threatenedBelief(self, 'Someone treated her as something other than a thing to use', 0.7);
    expect(hit?.text).toMatch(/people use/);
  });

  it('summarises the life story from its arcs', () => {
    expect(describeLifeStory([
      { chapterId: 'a', title: 'a', kind: 'contamination', slope: -0.6, coherence: 0.5, telling: '' },
      { chapterId: 'b', title: 'b', kind: 'contamination', slope: -0.5, coherence: 0.5, telling: '' },
      { chapterId: 'c', title: 'c', kind: 'stable', slope: 0, coherence: 0.5, telling: '' },
    ])).toMatch(/being ruined/);
  });
});

// ------------------------------------------------------------- mentation

describe('the mind between scenes (§P.7)', () => {
  it('ignores gaps too short to matter', () => {
    expect(inferInterlude(NOW, NOW + 3600_000, true)).toBeNull();
  });

  it('assumes sleep across a gap that spans a night, and caps very long ones', () => {
    expect(inferInterlude(NOW, NOW + 10 * 3600_000, true)?.slept).toBe(true);
    expect(inferInterlude(NOW, NOW + 365 * 24 * 3600_000, true)?.hours).toBe(24 * 14);
  });

  it('recovers load across a safe, restful gap', () => {
    const strained: PsycheState = {
      ...emptyPsyche(neutralTraits()),
      load: { level: 0.8, sustainedScenes: 15, scenesSinceRelief: 15, peak: 0.8 },
      defenseMaturity: 0.7,
    };
    const { psyche, events } = mentate(
      strained, { hours: 72, slept: true, safe: true, supported: true, now: NOW }, GRAPH, P,
    );
    expect(psyche.load.level).toBeLessThan(0.8);
    expect(events.join(' ')).toMatch(/slept/);
  });

  it('does not recover across a gap spent unsafe', () => {
    const strained: PsycheState = {
      ...emptyPsyche(neutralTraits()),
      load: { level: 0.8, sustainedScenes: 15, scenesSinceRelief: 15, peak: 0.8 },
      body: { energy: 0.3, sleepDebt: 0.7, pain: 0.2, safety: 0.1, nourishment: 0.4 },
    };
    const { psyche, events } = mentate(
      strained, { hours: 72, slept: false, safe: false, now: NOW }, GRAPH, P,
    );
    expect(psyche.load.level).toBeGreaterThan(0.75);
    expect(events.join(' ')).toMatch(/never off guard/);
  });

  it('THE FORK: a depleted character broods, a resourced one processes', () => {
    const base = emptyPsyche(neutralTraits());
    const depressed: PsycheState = {
      ...base,
      defenseMaturity: 0.15,
      load: { level: 0.8, sustainedScenes: 20, scenesSinceRelief: 20, peak: 0.8 },
      condition: { ...base.condition, depression: { ...base.condition.depression, severity: 0.8 } },
      dynamics: { ...base.dynamics, granularity: 0.2 },
    };
    const resourced: PsycheState = {
      ...base,
      defenseMaturity: 0.85,
      dynamics: { ...base.dynamics, granularity: 0.8 },
      condition: { ...base.condition, depression: { ...base.condition.depression, severity: 0.3 } },
    };

    const bad = mentate(depressed, { hours: 48, slept: true, safe: true, now: NOW }, GRAPH, P);
    const good = mentate(resourced, { hours: 48, slept: true, safe: true, now: NOW }, GRAPH, P);

    expect(bad.events.join(' ')).toMatch(/could not leave it alone/);
    expect(good.events.join(' ')).toMatch(/deliberately/);
    expect(bad.psyche.copingHistory.some((c) => c.move === 'ruminate_brood')).toBe(true);
    expect(good.psyche.copingHistory.some((c) => c.move === 'ruminate_deliberate')).toBe(true);
  });

  it('TIME HEALS ONLY WHAT HAS BEEN LOOKED AT', () => {
    const base = emptyPsyche(neutralTraits());
    const trauma = {
      nodeId: 'n1', contextBinding: 0.4, nowness: 0.7, elaboration: 0.8,
      appraisals: { selfBlame: 0.5, worldDanger: 0.5, permanentChange: 0.5, shame: 0.5 },
      avoidanceCount: 0, approachCount: 5, pathway: 'fear' as const,
      encodedAt: NOW, intrusionCount: 3,
    };
    const worked: PsycheState = { ...base, defenseMaturity: 0.85, traumas: [trauma] };
    const avoided: PsycheState = {
      ...base,
      defenseMaturity: 0.85,
      traumas: [{ ...trauma, elaboration: 0.05, avoidanceCount: 9, approachCount: 0 }],
    };

    const a = mentate(worked, { hours: 24 * 7, slept: true, safe: true, now: NOW }, GRAPH, P);
    const b = mentate(avoided, { hours: 24 * 7, slept: true, safe: true, now: NOW }, GRAPH, P);

    expect(a.psyche.traumas[0].nowness).toBeLessThan(0.7);
    // A week of peace does nothing for the part they will not look at.
    expect(b.psyche.traumas[0].nowness).toBeGreaterThanOrEqual(trauma.nowness - 0.05);
    expect(b.events.join(' ')).toMatch(/nothing for the part they will not look at|could not leave it alone/);
  });

  it('brooding across a long gap makes it worse, not better', () => {
    const base = emptyPsyche(neutralTraits());
    const stuck: PsycheState = {
      ...base,
      defenseMaturity: 0.1,
      load: { level: 0.75, sustainedScenes: 20, scenesSinceRelief: 20, peak: 0.75 },
      condition: { ...base.condition, depression: { ...base.condition.depression, severity: 0.85 } },
      dynamics: { ...base.dynamics, granularity: 0.15 },
      traumas: [{
        nodeId: 'n1', contextBinding: 0.3, nowness: 0.5, elaboration: 0.1,
        appraisals: { selfBlame: 0.4, worldDanger: 0.5, permanentChange: 0.5, shame: 0.5 },
        avoidanceCount: 8, approachCount: 0, pathway: 'fear' as const,
        encodedAt: NOW, intrusionCount: 5,
      }],
    };
    const { psyche } = mentate(stuck, { hours: 24 * 10, slept: false, safe: true, now: NOW }, GRAPH, P);
    expect(psyche.traumas[0].nowness).toBeGreaterThan(0.5);
    expect(psyche.traumas[0].appraisals.selfBlame).toBeGreaterThan(0.4);
  });

  it('is sub-linear: a year away does not cure what a week could not', () => {
    const base: PsycheState = {
      ...emptyPsyche(neutralTraits()),
      load: { level: 0.9, sustainedScenes: 25, scenesSinceRelief: 25, peak: 0.9 },
    };
    const week = mentate(base, { hours: 24 * 7, slept: true, safe: true, now: NOW }, GRAPH, P).psyche;
    const year = mentate(base, { hours: 24 * 365, slept: true, safe: true, now: NOW }, GRAPH, P).psyche;
    // More time helps more, but not proportionally.
    expect(year.load.level).toBeLessThanOrEqual(week.load.level);
    expect(week.load.level - year.load.level).toBeLessThan(0.5);
  });

  it('keeps everything inside its range across a long, mixed history', () => {
    let psyche = emptyPsyche(neutralTraits());
    for (let i = 0; i < 30; i++) {
      psyche = mentate(psyche, {
        hours: 6 + (i % 5) * 12,
        slept: i % 2 === 0,
        safe: i % 3 !== 0,
        now: NOW + i * DAY,
      }, GRAPH, P).psyche;
    }
    const in01 = (v: number) => v >= 0 && v <= 1;
    expect(in01(psyche.load.level)).toBe(true);
    expect(in01(psyche.defenseMaturity)).toBe(true);
    expect(in01(psyche.dynamics.granularity)).toBe(true);
    expect(in01(psyche.attachment.avoidance)).toBe(true);
    expect(psyche.copingHistory.length).toBeLessThanOrEqual(60);
  });
});
