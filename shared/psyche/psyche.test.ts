/**
 * Psyche layer tests.
 *
 * These are not coverage tests. Each one pins a *claim the architecture makes
 * about people* — that exhaustion turns anger into fear, that avoidance
 * entrenches trauma while facing it in safety heals, that stress makes people
 * worse at handling stress. If a claim stops holding, the character arc stops
 * being real and the whole layer is decoration.
 */
import { describe, expect, it } from 'vitest';
import type { Appraisal, Affect, RelationModel } from '../brain/types';
import { appraiseToAffect } from '../brain/emotion';
import { neutralTraits } from '../brain/defaults';
import {
  DEFAULT_PSYCHE_PARAMS as P, emptyPsyche, normalizePsyche,
} from './defaults';
import { bodyCapacity, chronicity, stepBody, stepLoad, describeBody } from './body';
import { applyEmotion, describeFeeling, retuneDynamics, actionTendency } from './dynamics';
import { biasAppraisal, updateAttribution } from './bias';
import { chooseRegulation, applyRegulation, effectiveMaturity, express } from './regulation';
import {
  assessCondition, describeCondition, retrievalBias, type GraphSummary,
} from './condition';
import { classifyPathway, formTrauma, processIntrusion, checkIntrusions, restTrauma } from './trauma';
import { stepScene, restScene } from './step';
import { composePsycheBlock } from './compose';
import type { PsycheState } from './types';

const NOW = 1_700_000_000_000;

function appraisal(over: Partial<Appraisal> = {}): Appraisal {
  return {
    novelty: 0.5, pleasantness: 0, goalRelevance: 0.5, goalConduciveness: 0,
    agency: 'other', intent: 0, copingPotential: 0.6, norms: 0, urgency: 0.4,
    ...over,
  };
}

function relation(over: Partial<RelationModel> = {}): RelationModel {
  return {
    key: 'rooke', displayName: 'Rooke', trust: 0.5, affection: 0.3, fear: 0,
    respect: 0.2, resentment: 0, debt: 0, familiarity: 0.6, model: '',
    interactions: 12, firstMetAt: NOW - 1e7, lastSeenAt: NOW, ...over,
  };
}

const EMPTY_GRAPH: GraphSummary = {
  nodes: [], selfBeliefs: [], relationTrust: [], goalsFailed: 0, goalsTotal: 0,
};

// ---------------------------------------------------------------- the body

describe('the body gates coping (§P.2.3)', () => {
  it('is at full capacity when rested, safe and unhurt', () => {
    expect(bodyCapacity(emptyPsyche().body)).toBeGreaterThan(0.6);
  });

  it('collapses capacity when depleted, and never quite to zero', () => {
    const wrecked = { energy: 0.05, sleepDebt: 0.95, pain: 0.9, safety: 0.05, nourishment: 0.1 };
    const cap = bodyCapacity(wrecked);
    expect(cap).toBeLessThan(0.2);
    // People in appalling states still act — they just act badly.
    expect(cap).toBeGreaterThan(0);
  });

  it('THE CENTRAL CLAIM: exhaustion turns the same provocation from anger into fear', () => {
    // Identical event, identical character, different body.
    const provocation = appraisal({
      pleasantness: -0.7, goalConduciveness: -0.8, intent: -0.8,
      agency: 'other', copingPotential: 0.75, urgency: 0.8,
    });

    const rested = emptyPsyche();
    const spent: PsycheState = {
      ...rested,
      body: { energy: 0.08, sleepDebt: 0.9, pain: 0.7, safety: 0.3, nourishment: 0.4 },
    };

    const traits = neutralTraits();
    const a = biasAppraisal(provocation, { psyche: rested, traits, moodValence: 0 });
    const b = biasAppraisal(provocation, { psyche: spent, traits, moodValence: 0 });

    expect(a.biased.copingPotential).toBeGreaterThan(0.5);
    expect(b.biased.copingPotential).toBeLessThan(0.25);

    // Coping potential is the axis Scherer's CPM uses to separate the two, so the
    // derived emotion should actually differ — this is the payoff of the whole
    // body model, and it is checked against the brain's own emotion engine.
    const angry = appraiseToAffect(a.biased, traits);
    const afraid = appraiseToAffect(b.biased, traits);
    expect(angry.label).toBe('anger');
    expect(afraid.label).toBe('fear');
    expect(afraid.dominance).toBeLessThan(angry.dominance);
  });

  it('describes the body only when it is off baseline', () => {
    expect(describeBody(emptyPsyche().body)).toBe('');
    expect(describeBody({ energy: 0.1, sleepDebt: 0.9, pain: 0.9, safety: 0.1, nourishment: 0.2 }))
      .toMatch(/pain|sleep|spent|danger/);
  });
});

// ---------------------------------------------------------------- load

describe('allostatic load accumulates fast and recovers slowly (§P.2.4)', () => {
  it('rises under repeated arousal', () => {
    let psyche = emptyPsyche();
    for (let i = 0; i < 8; i++) {
      psyche = {
        ...psyche,
        load: stepLoad(psyche.load, psyche.body, { arousal: 0.9, threatened: true, safe: false }, P),
      };
    }
    expect(psyche.load.level).toBeGreaterThan(0.6);
    expect(psyche.load.sustainedScenes).toBeGreaterThan(0);
  });

  it('does not recover without safety, however much time passes', () => {
    let load = { level: 0.8, sustainedScenes: 10, scenesSinceRelief: 10, peak: 0.8 };
    const body = { energy: 0.5, sleepDebt: 0.4, pain: 0.2, safety: 0.1, nourishment: 0.5 };
    for (let i = 0; i < 10; i++) load = stepLoad(load, body, { arousal: 0.2, safe: false }, P);
    expect(load.level).toBeGreaterThan(0.75);
  });

  it('recovers with safety, rest and connection together', () => {
    let load = { level: 0.8, sustainedScenes: 10, scenesSinceRelief: 10, peak: 0.8 };
    const body = { energy: 0.8, sleepDebt: 0.1, pain: 0, safety: 0.9, nourishment: 0.9 };
    for (let i = 0; i < 10; i++) {
      load = stepLoad(load, body, { arousal: 0.1, safe: true, slept: true, supported: true }, P);
    }
    expect(load.level).toBeLessThan(0.35);
    // The peak is a scar: it never comes back down.
    expect(load.peak).toBe(0.8);
  });

  it('counts chronicity separately from level', () => {
    const brief = { level: 0.7, sustainedScenes: 1, scenesSinceRelief: 1, peak: 0.7 };
    const long = { level: 0.7, sustainedScenes: 30, scenesSinceRelief: 30, peak: 0.7 };
    expect(chronicity(long)).toBeGreaterThan(chronicity(brief));
  });

  it('sleep debt only clears properly when it is safe to sleep', () => {
    const start = { ...emptyPsyche().body, sleepDebt: 0.9 };
    const safeRest = stepBody(start, { arousal: 0.1, slept: true, safe: true }, P);
    const vigilantRest = stepBody(start, { arousal: 0.1, slept: true, safe: false }, P);
    expect(safeRest.sleepDebt).toBeLessThan(vigilantRest.sleepDebt - 0.2);
  });
});

// ---------------------------------------------------------------- dynamics

describe('affect dynamics are state, not constants (§P.2.2)', () => {
  it('load raises reactivity — each blow lands harder than the last', () => {
    const calm = emptyPsyche();
    const loaded: PsycheState = {
      ...calm,
      load: { level: 0.9, sustainedScenes: 20, scenesSinceRelief: 20, peak: 0.9 },
    };
    const a = retuneDynamics(calm.dynamics, calm.load, calm.body, calm.condition, P);
    const b = retuneDynamics(loaded.dynamics, loaded.load, loaded.body, loaded.condition, P);
    expect(b.reactivity).toBeGreaterThan(a.reactivity);
  });

  it('depression raises inertia — feelings stop moving', () => {
    const base = emptyPsyche();
    const depressed: PsycheState = {
      ...base,
      condition: {
        ...base.condition,
        depression: { ...base.condition.depression, severity: 0.8 },
      },
    };
    const a = retuneDynamics(base.dynamics, base.load, base.body, base.condition, P);
    const b = retuneDynamics(base.dynamics, depressed.load, depressed.body, depressed.condition, P);
    expect(b.inertia).toBeGreaterThan(a.inertia);
  });

  it('high inertia makes a bad mood outlast the event that caused it', () => {
    const sticky = { ...emptyPsyche().dynamics, inertia: 0.9, reactivity: 1 };
    const loose = { ...emptyPsyche().dynamics, inertia: 0.1, reactivity: 1 };
    const bad: Affect = { valence: -0.9, arousal: 0.7, dominance: -0.4, label: 'grief' };
    const good: Affect = { valence: 0.8, arousal: 0.4, dominance: 0.3, label: 'relief' };

    const stuck = applyEmotion(sticky, { event: good, mood: bad }).mood;
    const moved = applyEmotion(loose, { event: good, mood: bad }).mood;
    expect(stuck.valence).toBeLessThan(moved.valence);
    // Something good happened and the sticky character is still in the bad place.
    expect(stuck.valence).toBeLessThan(0);
  });

  it('tracks instability across successive moments', () => {
    let dyn = { ...emptyPsyche().dynamics, inertia: 0.1 };
    const swings: Affect[] = [
      { valence: 0.9, arousal: 0.6, dominance: 0, label: 'joy' },
      { valence: -0.9, arousal: 0.8, dominance: -0.3, label: 'grief' },
      { valence: 0.8, arousal: 0.6, dominance: 0.1, label: 'hope' },
      { valence: -0.85, arousal: 0.9, dominance: -0.5, label: 'horror' },
    ];
    let mood: Affect = { valence: 0, arousal: 0.2, dominance: 0, label: 'neutral' };
    for (const e of swings) {
      const r = applyEmotion(dyn, { event: e, mood });
      dyn = r.dynamics;
      mood = r.mood;
    }
    expect(dyn.instability).toBeGreaterThan(0.3);
  });

  it('THE PROSE PAYOFF: granularity decides whether they can name the feeling', () => {
    const shame: Affect = { valence: -0.7, arousal: 0.6, dominance: -0.5, label: 'shame' };
    expect(describeFeeling(shame, 0.9)).toContain('shame');
    expect(describeFeeling(shame, 0.5)).toMatch(/would not put it that way/);
    // Under crisis they simply feel bad, and a good scene will not have them
    // explaining their shame articulately.
    expect(describeFeeling(shame, 0.1)).toBe('something bad they cannot name');
  });

  it('crisis blurs granularity, and it recovers far more slowly than it is lost', () => {
    const base = emptyPsyche();
    const crisis: PsycheState = {
      ...base,
      load: { level: 0.95, sustainedScenes: 15, scenesSinceRelief: 15, peak: 0.95 },
      body: { energy: 0.1, sleepDebt: 0.9, pain: 0.6, safety: 0.1, nourishment: 0.3 },
    };
    const blurred = retuneDynamics(base.dynamics, crisis.load, crisis.body, crisis.condition, P);
    expect(blurred.granularity).toBeLessThan(base.dynamics.granularity - 0.15);

    const recovering = retuneDynamics(blurred, base.load, base.body, base.condition, P);
    const gained = recovering.granularity - blurred.granularity;
    const lost = base.dynamics.granularity - blurred.granularity;
    expect(gained).toBeLessThan(lost);
  });

  it('gives every emotion an action tendency, split by dominance', () => {
    const cornered = actionTendency({ valence: -0.8, arousal: 0.9, dominance: -0.7, label: 'fear' });
    const capable = actionTendency({ valence: -0.8, arousal: 0.9, dominance: 0.6, label: 'fear' });
    expect(cornered).not.toBe(capable);
  });
});

// ---------------------------------------------------------------- bias

describe('appraisal is bent by who the character has become (§P.3)', () => {
  it('leaves a plain event on a settled person almost untouched', () => {
    const trace = biasAppraisal(appraisal(), {
      psyche: emptyPsyche(), traits: neutralTraits(), moodValence: 0,
    });
    expect(trace.steps.length).toBeLessThanOrEqual(2);
  });

  it('threat expectancy reads ambiguity as hostile and shrinks coping', () => {
    const base = emptyPsyche();
    const hurt: PsycheState = {
      ...base,
      condition: {
        ...base.condition,
        anxiety: { threatExpectancy: 0.8, hypervigilance: 0.8, severity: 0.8 },
      },
    };
    const neutral = appraisal({ intent: 0, urgency: 0.3 });
    const trace = biasAppraisal(neutral, { psyche: hurt, traits: neutralTraits(), moodValence: 0 });
    expect(trace.biased.intent).toBeLessThan(-0.15);
    expect(trace.biased.urgency).toBeGreaterThan(neutral.urgency);
    expect(trace.biased.copingPotential).toBeLessThan(neutral.copingPotential);
    expect(trace.steps.some((s) => s.source === 'threat')).toBe(true);
  });

  it('a soured relationship makes the same act read as malice', () => {
    const psyche = emptyPsyche();
    const traits = neutralTraits();
    const act = appraisal({ intent: 0 });
    const trusted = biasAppraisal(act, { psyche, traits, moodValence: 0, relation: relation() });
    const betrayed = biasAppraisal(act, {
      psyche, traits, moodValence: 0,
      relation: relation({ trust: -0.8, resentment: 0.7, affection: -0.2 }),
    });
    expect(betrayed.biased.intent).toBeLessThan(trusted.biased.intent);
  });

  it('HOPELESSNESS: a depressogenic style rewrites who is at fault', () => {
    const base = emptyPsyche();
    const selfBlaming: PsycheState = {
      ...base,
      attribution: { internal: 0.8, stable: 0.7, global: 0.7 },
    };
    // Plainly done TO them by someone else.
    const doneToThem = appraisal({ agency: 'other', intent: -0.9, goalConduciveness: -0.8 });

    const externalising = biasAppraisal(doneToThem, {
      psyche: { ...base, attribution: { internal: -0.6, stable: -0.3, global: -0.3 } },
      traits: neutralTraits(), moodValence: 0, goalFailure: true,
    });
    const internalising = biasAppraisal(doneToThem, {
      psyche: selfBlaming, traits: neutralTraits(), moodValence: 0, goalFailure: true,
    });

    expect(externalising.biased.agency).toBe('other');
    // The same betrayal, taken as one's own fault — and therefore encoded as a
    // different memory, building a different person.
    expect(internalising.biased.agency).toBe('self');
    expect(internalising.biased.norms).toBeLessThan(-0.3);
    expect(internalising.biased.copingPotential).toBeLessThan(externalising.biased.copingPotential);
  });

  it('anhedonia compresses good news only, leaving bad news at full strength', () => {
    const base = emptyPsyche();
    const flat: PsycheState = {
      ...base,
      condition: {
        ...base.condition,
        depression: { ...base.condition.depression, anhedonia: 0.9 },
      },
    };
    const good = appraisal({ pleasantness: 0.9, goalConduciveness: 0.8 });
    const bad = appraisal({ pleasantness: -0.9, goalConduciveness: -0.8 });

    const goodRead = biasAppraisal(good, { psyche: flat, traits: neutralTraits(), moodValence: 0 });
    const badRead = biasAppraisal(bad, { psyche: flat, traits: neutralTraits(), moodValence: 0 });

    expect(goodRead.biased.pleasantness).toBeLessThan(0.4);
    expect(badRead.biased.pleasantness).toBeLessThan(-0.8);
  });

  it('records why, in words, for every meaningful move', () => {
    const base = emptyPsyche();
    const trace = biasAppraisal(appraisal({ goalConduciveness: -0.8 }), {
      psyche: { ...base, attribution: { internal: 0.9, stable: 0.8, global: 0.8 } },
      traits: neutralTraits(), moodValence: -0.6, goalFailure: true,
    });
    expect(trace.steps.length).toBeGreaterThan(1);
    for (const s of trace.steps) expect(s.why.length).toBeGreaterThan(8);
  });

  it('learned helplessness: repeated uncontrollable failure moves the style', () => {
    let style = { internal: 0, stable: 0, global: 0 };
    for (let i = 0; i < 15; i++) {
      style = updateAttribution(style, { failed: true, controllable: false, ownDoing: false });
    }
    expect(style.stable).toBeGreaterThan(0.4);
    expect(style.global).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------- regulation

describe('regulation trades relief now against cost later (§P.4)', () => {
  const overwhelming: Affect = { valence: -0.9, arousal: 0.9, dominance: -0.6, label: 'horror' };
  const mild: Affect = { valence: -0.2, arousal: 0.2, dominance: 0, label: 'sadness' };

  it('does not regulate a mild feeling at all', () => {
    const choice = chooseRegulation(emptyPsyche(), {
      felt: mild, supportAvailable: true, safeToExpress: true,
    }, P.maturityRegression);
    expect(choice.move).toBe('none');
  });

  it('STRESS MAKES PEOPLE WORSE AT STRESS: load regresses defense maturity', () => {
    const base = emptyPsyche();
    const loaded: PsycheState = {
      ...base,
      load: { level: 0.95, sustainedScenes: 20, scenesSinceRelief: 20, peak: 0.95 },
      body: { energy: 0.1, sleepDebt: 0.9, pain: 0.5, safety: 0.1, nourishment: 0.3 },
    };
    expect(effectiveMaturity(loaded, P.maturityRegression))
      .toBeLessThan(effectiveMaturity(base, P.maturityRegression));
  });

  it('a resourced character reaches for a mature move; a depleted one cannot', () => {
    const base: PsycheState = { ...emptyPsyche(), defenseMaturity: 0.85 };
    const wrecked: PsycheState = {
      ...base,
      defenseMaturity: 0.3,
      load: { level: 0.9, sustainedScenes: 20, scenesSinceRelief: 20, peak: 0.9 },
      body: { energy: 0.1, sleepDebt: 0.85, pain: 0.5, safety: 0.2, nourishment: 0.3 },
    };
    const ctx = { felt: overwhelming, supportAvailable: true, safeToExpress: true };

    const strong = chooseRegulation(base, ctx, P.maturityRegression);
    const weak = chooseRegulation(wrecked, ctx, P.maturityRegression);

    expect(['reappraise', 'seek_support', 'confront', 'ruminate_deliberate']).toContain(strong.move);
    expect(['avoid', 'dissociate', 'suppress', 'ruminate_brood', 'distract']).toContain(weak.move);
  });

  it('avoidant attachment makes reaching for people unavailable even when someone is there', () => {
    const open: PsycheState = {
      ...emptyPsyche(), defenseMaturity: 0.8, attachment: { anxiety: 0.2, avoidance: 0.05 },
    };
    const closed: PsycheState = { ...open, attachment: { anxiety: 0.2, avoidance: 0.95 } };
    const ctx = { felt: overwhelming, supportAvailable: true, safeToExpress: true };
    expect(chooseRegulation(open, ctx, P.maturityRegression).move).toBe('seek_support');
    expect(chooseRegulation(closed, ctx, P.maturityRegression).move).not.toBe('seek_support');
  });

  it('dissociation is triggered by overwhelm, not chosen for comfort', () => {
    const psyche: PsycheState = { ...emptyPsyche(), defenseMaturity: 0.2 };
    const bad = chooseRegulation(psyche, {
      felt: { valence: -0.6, arousal: 0.6, dominance: 0.3, label: 'anger' },
      supportAvailable: false, safeToExpress: true,
    }, P.maturityRegression);
    expect(bad.move).not.toBe('dissociate');

    const unbearable = chooseRegulation(psyche, {
      felt: { valence: -1, arousal: 1, dominance: -0.9, label: 'horror' },
      supportAvailable: false, safeToExpress: false,
    }, P.maturityRegression);
    expect(unbearable.move).toBe('dissociate');
  });

  it('mature moves build maturity; immature ones erode it', () => {
    const base = emptyPsyche();
    const grown = applyRegulation(base, {
      move: 'reappraise', level: 'mature', relief: 0.4, loadDelta: -0.04,
      description: '', rationale: '', alternatives: [],
    }, NOW, P.maturityGain);
    const eroded = applyRegulation(base, {
      move: 'dissociate', level: 'immature', relief: 0.9, loadDelta: 0.02,
      description: '', rationale: '', alternatives: [],
    }, NOW, P.maturityGain);
    expect(grown.defenseMaturity).toBeGreaterThan(base.defenseMaturity);
    expect(eroded.defenseMaturity).toBeLessThan(base.defenseMaturity);
  });

  it('reaching for someone loosens avoidance a little each time', () => {
    let psyche = { ...emptyPsyche(), attachment: { anxiety: 0.5, avoidance: 0.8 } };
    const before = psyche.attachment.avoidance;
    for (let i = 0; i < 10; i++) {
      psyche = applyRegulation(psyche, {
        move: 'seek_support', level: 'mature', relief: 0.5, loadDelta: -0.09,
        description: '', rationale: '', alternatives: [],
      }, NOW + i, P.maturityGain);
    }
    expect(psyche.attachment.avoidance).toBeLessThan(before - 0.15);
  });

  it('FELT VERSUS SHOWN: suppression hides the feeling and leaks somatically', () => {
    const felt: Affect = { valence: -0.9, arousal: 0.85, dominance: -0.4, label: 'humiliation' };
    const shown = express(felt, {
      move: 'suppress', level: 'neurotic', relief: 0.25, loadDelta: 0.045,
      description: '', rationale: '', alternatives: [],
    }, 0.8);
    expect(shown.opacity).toBeGreaterThan(0.7);
    expect(Math.abs(shown.shown.valence)).toBeLessThan(Math.abs(felt.valence) * 0.4);
    // They read as more in control than they are — that is what suppression buys.
    expect(shown.shown.dominance).toBeGreaterThan(felt.dominance);
    expect(shown.leak).toBeTruthy();
  });
});

// ---------------------------------------------------------------- trauma

describe('trauma is a maintenance loop, not a node kind (§P.5.1)', () => {
  const terror = { valence: -0.95, arousal: 0.95, dominance: -0.8, label: 'horror' as const };

  function freshTrauma(over: Partial<Parameters<typeof formTrauma>[0]> = {}) {
    return formTrauma({
      nodeId: 'n1', affect: terror, appraisal: appraisal({
        agency: 'other', intent: -0.9, norms: -0.6, copingPotential: 0.1, pleasantness: -0.9,
      }), contextBinding: 0.3, now: NOW, ...over,
    });
  }

  it('separates the three pathways', () => {
    const fear = classifyPathway({
      nodeId: 'x', affect: terror, contextBinding: 0.3, now: NOW,
      appraisal: appraisal({ agency: 'circumstance', intent: 0 }),
    });
    const betrayal = classifyPathway({
      nodeId: 'x', affect: terror, contextBinding: 0.3, now: NOW,
      appraisal: appraisal({ agency: 'other', intent: -0.8 }),
      relation: relation({ trust: 0.8, affection: 0.7, familiarity: 0.9 }),
    });
    const moral = classifyPathway({
      nodeId: 'x', affect: terror, contextBinding: 0.3, now: NOW,
      appraisal: appraisal({ agency: 'self', norms: -0.8 }),
    });
    expect(fear).toBe('fear');
    expect(betrayal).toBe('betrayal');
    expect(moral).toBe('moral');
  });

  it('betrayal fragments harder and lands as shame rather than danger', () => {
    const fear = freshTrauma({ appraisal: appraisal({ agency: 'circumstance', pleasantness: -0.9 }) });
    const betrayal = freshTrauma({
      relation: relation({ trust: 0.9, affection: 0.8, familiarity: 0.9 }),
      perpetrator: 'Rooke',
    });
    expect(betrayal.contextBinding).toBeLessThan(fear.contextBinding);
    expect(betrayal.appraisals.shame).toBeGreaterThan(fear.appraisals.shame);
    expect(betrayal.appraisals.worldDanger).toBeLessThan(fear.appraisals.worldDanger);
  });

  it('THE ARC, HARMFUL BRANCH: avoidance entrenches it', () => {
    let t = freshTrauma();
    const startNowness = t.nowness;
    for (let i = 0; i < 10; i++) {
      t = processIntrusion(t, 'avoid', { safe: true, supported: false, now: NOW + i }, P);
    }
    expect(t.nowness).toBeGreaterThanOrEqual(startNowness);
    expect(t.elaboration).toBeLessThan(0.1);
    expect(t.appraisals.worldDanger).toBeGreaterThan(freshTrauma().appraisals.worldDanger);
    expect(t.avoidanceCount).toBe(10);
  });

  it('THE ARC, HEALING BRANCH: facing it in safety integrates it', () => {
    let t = freshTrauma();
    for (let i = 0; i < 10; i++) {
      t = processIntrusion(t, 'seek_support', { safe: true, supported: true, now: NOW + i }, P);
    }
    expect(t.nowness).toBeLessThan(0.25);
    expect(t.elaboration).toBeGreaterThan(0.6);
    expect(t.contextBinding).toBeGreaterThan(0.7);
    expect(t.appraisals.permanentChange).toBeLessThan(0.2);
    // Self-blame is the last thing to go, which is true to life.
    expect(t.appraisals.selfBlame).toBeGreaterThan(t.appraisals.permanentChange - 0.05);
  });

  it('facing it while still in danger is re-exposure, not processing', () => {
    let safeT = freshTrauma();
    let unsafeT = freshTrauma();
    for (let i = 0; i < 6; i++) {
      safeT = processIntrusion(safeT, 'confront', { safe: true, supported: false, now: NOW + i }, P);
      unsafeT = processIntrusion(unsafeT, 'confront', { safe: false, supported: false, now: NOW + i }, P);
    }
    expect(unsafeT.nowness).toBeGreaterThan(safeT.nowness);
    expect(unsafeT.elaboration).toBeLessThan(safeT.elaboration);
  });

  it('dissociating at retrieval re-fragments the memory', () => {
    let t = freshTrauma();
    const before = t.contextBinding;
    for (let i = 0; i < 5; i++) {
      t = processIntrusion(t, 'dissociate', { safe: true, supported: false, now: NOW + i }, P);
    }
    expect(t.contextBinding).toBeLessThan(before);
  });

  it('time heals only what has been elaborated', () => {
    const worked = { ...freshTrauma(), elaboration: 0.8, nowness: 0.6 };
    const untouched = { ...freshTrauma(), elaboration: 0.05, nowness: 0.6 };
    const rested = restTrauma(worked, 10, true);
    const stillRaw = restTrauma(untouched, 10, true);
    expect(rested.nowness).toBeLessThan(0.6);
    expect(stillRaw.nowness).toBe(0.6);
  });

  it('intrusions fire on cue overlap, and the perpetrator being present is the loudest cue', () => {
    const psyche: PsycheState = { ...emptyPsyche(), traumas: [freshTrauma({ perpetrator: 'Rooke' })] };
    const gist = () => 'Rooke held up the vial and told her who he worked for';

    const unrelated = checkIntrusions(psyche, 'the greenhouse was quiet and warm', [], gist);
    const present = checkIntrusions(psyche, 'the greenhouse was quiet and warm', ['Rooke'], gist);
    const matching = checkIntrusions(psyche, 'he held up a vial', [], gist);

    expect(unrelated.length).toBe(0);
    expect(present[0].probability).toBeGreaterThan(0);
    expect(matching[0].probability).toBeGreaterThan(0);
  });

  it('growth quiets intrusions without deleting the memory', () => {
    const t = freshTrauma({ perpetrator: 'Rooke' });
    const raw: PsycheState = { ...emptyPsyche(), traumas: [t] };
    const grown: PsycheState = {
      ...raw,
      condition: {
        ...raw.condition,
        growth: { strength: 0.8, relating: 0.6, possibilities: 0.6, appreciation: 0.6, existential: 0.6, severity: 0.8 },
      },
    };
    const gist = () => 'Rooke held up the vial';
    const before = checkIntrusions(raw, 'he held up a vial', ['Rooke'], gist)[0].probability;
    const after = checkIntrusions(grown, 'he held up a vial', ['Rooke'], gist)[0].probability;
    expect(after).toBeLessThan(before);
    // The trauma is still there. That is what healed looks like.
    expect(grown.traumas).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- condition

describe('condition is computed, never authored (§P.5)', () => {
  it('an untouched psyche has no symptoms at all', () => {
    const c = assessCondition(emptyPsyche(), EMPTY_GRAPH, P);
    expect(c.ptsd.severity).toBe(0);
    expect(c.dso.severity).toBe(0);
    expect(c.depression.severity).toBeLessThan(0.2);
  });

  it('PTSD emerges from an unintegrated trauma plus avoidant coping', () => {
    let psyche = emptyPsyche();
    let t = formTrauma({
      nodeId: 'n1',
      affect: { valence: -0.95, arousal: 0.95, dominance: -0.8, label: 'horror' },
      appraisal: appraisal({ agency: 'other', intent: -0.9, copingPotential: 0.1 }),
      contextBinding: 0.2, now: NOW,
    });
    for (let i = 0; i < 12; i++) {
      t = processIntrusion(t, 'avoid', { safe: true, supported: false, now: NOW + i }, P);
      psyche = {
        ...psyche,
        copingHistory: [...psyche.copingHistory, { at: NOW + i, move: 'avoid', level: 'immature' }],
      };
    }
    psyche = {
      ...psyche,
      traumas: [t],
      load: { level: 0.7, sustainedScenes: 12, scenesSinceRelief: 12, peak: 0.7 },
    };
    const c = assessCondition(psyche, EMPTY_GRAPH, P);
    expect(c.ptsd.severity).toBeGreaterThan(0.4);
    expect(c.ptsd.intrusion).toBeGreaterThan(0.3);
    expect(c.ptsd.avoidance).toBeGreaterThan(0.5);
    expect(c.anxiety.threatExpectancy).toBeGreaterThan(0.3);
  });

  it('negative self-concept is measured from the graph, not asserted', () => {
    const damning: GraphSummary = {
      ...EMPTY_GRAPH,
      selfBeliefs: [
        { gist: 'I am something people use', valence: -0.9, strength: 1.4 },
        { gist: 'I could not protect anyone', valence: -0.8, strength: 1.1 },
        { gist: 'I am good with growing things', valence: 0.5, strength: 0.3 },
      ],
    };
    const c = assessCondition(emptyPsyche(), damning, P);
    expect(c.dso.negativeSelfConcept).toBeGreaterThan(0.7);
  });

  it('CPTSD requires the whole triad alongside PTSD, not any one part', () => {
    const base = emptyPsyche();
    const onlyNegSelf: GraphSummary = {
      ...EMPTY_GRAPH,
      selfBeliefs: [{ gist: 'I am worthless', valence: -0.9, strength: 2 }],
    };
    expect(assessCondition(base, onlyNegSelf, P).dso.severity).toBe(0);
  });

  it('hopelessness needs real failures, not merely a pessimistic style', () => {
    const pessimist: PsycheState = {
      ...emptyPsyche(), attribution: { internal: 0.9, stable: 0.9, global: 0.9 },
    };
    const noFailures = assessCondition(pessimist, EMPTY_GRAPH, P);
    const manyFailures = assessCondition(pessimist, { ...EMPTY_GRAPH, goalsFailed: 5, goalsTotal: 6 }, P);
    expect(noFailures.depression.hopelessness).toBeLessThan(0.25);
    expect(manyFailures.depression.hopelessness).toBeGreaterThan(0.5);
  });

  it('OVERGENERAL MEMORY: depression makes recall vaguer', () => {
    const base = emptyPsyche();
    const brooding: PsycheState = {
      ...base,
      copingHistory: Array.from({ length: 20 }, (_, i) => ({
        at: NOW + i, move: 'ruminate_brood' as const, level: 'neurotic' as const,
      })),
      load: { level: 0.7, sustainedScenes: 15, scenesSinceRelief: 15, peak: 0.7 },
    };
    const c = assessCondition(brooding, EMPTY_GRAPH, P);
    expect(c.depression.overgeneralMemory).toBeGreaterThan(0.45);

    const bias = retrievalBias(c, -0.6);
    // They answer with patterns rather than scenes.
    expect(bias.episodicGain).toBeLessThan(0.85);
    expect(bias.generalGain).toBeGreaterThan(1.1);
    expect(bias.positiveGain).toBeLessThan(1);
  });

  it('growth accumulates from deliberate work and survived time', () => {
    const worked: PsycheState = {
      ...emptyPsyche(),
      scenes: 80,
      defenseMaturity: 0.8,
      traumas: [{
        ...formTrauma({
          nodeId: 'n1',
          affect: { valence: -0.9, arousal: 0.9, dominance: -0.7, label: 'horror' },
          appraisal: appraisal(), contextBinding: 0.3, now: NOW,
        }),
        elaboration: 0.85, nowness: 0.2,
      }],
      copingHistory: Array.from({ length: 20 }, (_, i) => ({
        at: NOW + i, move: 'ruminate_deliberate' as const, level: 'mature' as const,
      })),
    };
    const c = assessCondition(worked, EMPTY_GRAPH, P);
    expect(c.growth.severity).toBeGreaterThan(0.4);
    expect(c.growth.strength).toBeGreaterThan(0.3);
  });

  it('describes condition as behaviour, never as diagnosis', () => {
    const psyche: PsycheState = {
      ...emptyPsyche(),
      condition: {
        ...emptyPsyche().condition,
        ptsd: { intrusion: 0.8, avoidance: 0.7, negativeAlterations: 0.6, arousal: 0.7, severity: 0.7 },
        anxiety: { threatExpectancy: 0.7, hypervigilance: 0.7, severity: 0.7 },
      },
    };
    const lines = describeCondition(psyche.condition);
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) {
      expect(l).not.toMatch(/PTSD|disorder|symptom|\d/i);
    }
  });
});

// ---------------------------------------------------------------- the loop

describe('the whole loop, over a life (§P.1)', () => {
  function scene(psyche: PsycheState, over: Partial<Parameters<typeof stepScene>[1]> = {}) {
    return stepScene(psyche, {
      appraisal: appraisal({ pleasantness: -0.6, goalConduciveness: -0.6, intent: -0.5 }),
      deriveAffect: (b) => appraiseToAffect(b, neutralTraits()),
      traits: neutralTraits(),
      mood: { valence: 0, arousal: 0.2, dominance: 0, label: 'neutral' },
      actors: ['Rooke'],
      text: 'he held up the vial',
      nodeGist: () => 'Rooke held up the vial',
      graph: EMPTY_GRAPH,
      cost: { arousal: 0.7, threatened: true, safe: false },
      now: NOW,
      ...over,
    }, P);
  }

  it('runs a single scene and returns everything the prompt needs', () => {
    const r = scene(emptyPsyche());
    expect(r.psyche.scenes).toBe(1);
    expect(r.trace.steps.length).toBeGreaterThanOrEqual(0);
    expect(r.pull.length).toBeGreaterThan(3);
    expect(r.affect.felt).toBeTruthy();
    expect(r.regulation.move).toBeTruthy();
  });

  it('TWENTY BAD SCENES change the person, and the change is not scripted', () => {
    let psyche = emptyPsyche();
    const before = {
      maturity: psyche.defenseMaturity,
      granularity: psyche.dynamics.granularity,
      load: psyche.load.level,
    };
    for (let i = 0; i < 20; i++) {
      psyche = scene(psyche, { now: NOW + i * 1000 }).psyche;
    }
    expect(psyche.load.level).toBeGreaterThan(before.load + 0.3);
    expect(psyche.defenseMaturity).toBeLessThan(before.maturity);
    expect(psyche.dynamics.granularity).toBeLessThan(before.granularity);
    expect(psyche.dynamics.reactivity).toBeGreaterThan(1);
  });

  it('and safety afterwards gives it back — slowly, and not all of it', () => {
    let psyche = emptyPsyche();
    for (let i = 0; i < 20; i++) psyche = scene(psyche, { now: NOW + i * 1000 }).psyche;
    const worst = psyche.load.level;

    for (let i = 0; i < 25; i++) {
      psyche = restScene(psyche, { scenes: 1, slept: true, safe: true, supported: true }, P);
    }
    expect(psyche.load.level).toBeLessThan(worst - 0.3);
    // The peak is remembered even when the level comes down.
    expect(psyche.load.peak).toBeGreaterThanOrEqual(worst);
  });

  it('is deterministic — the same history produces the same person twice', () => {
    const run = () => {
      let p = emptyPsyche(neutralTraits(), NOW);
      for (let i = 0; i < 12; i++) p = scene(p, { now: NOW + i * 1000 }).psyche;
      return p;
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('never produces a value outside its declared range, over a long life', () => {
    let psyche = emptyPsyche();
    for (let i = 0; i < 60; i++) {
      psyche = i % 3 === 0
        ? restScene(psyche, { scenes: 1, slept: true, safe: true }, P)
        : scene(psyche, { now: NOW + i * 1000 }).psyche;
    }
    const c = psyche.condition;
    const in01 = (v: number) => v >= 0 && v <= 1;
    expect(in01(psyche.load.level)).toBe(true);
    expect(in01(psyche.defenseMaturity)).toBe(true);
    expect(in01(psyche.dynamics.granularity)).toBe(true);
    expect(psyche.dynamics.reactivity).toBeGreaterThan(0.3);
    expect(psyche.dynamics.reactivity).toBeLessThanOrEqual(2.2);
    for (const v of [c.ptsd.severity, c.dso.severity, c.depression.severity, c.anxiety.severity]) {
      expect(in01(v)).toBe(true);
    }
    for (const b of Object.values(psyche.body)) expect(in01(b)).toBe(true);
  });
});

// ---------------------------------------------------------------- the prompt

describe('the prompt block (§P.8)', () => {
  function block(psyche: PsycheState) {
    const r = stepScene(psyche, {
      appraisal: appraisal({ pleasantness: -0.8, intent: -0.8, goalConduciveness: -0.8 }),
      deriveAffect: (b) => appraiseToAffect(b, neutralTraits()),
      traits: neutralTraits(),
      mood: { valence: -0.3, arousal: 0.4, dominance: -0.2, label: 'anxiety' },
      actors: ['Rooke'],
      text: 'he held up the vial',
      nodeGist: () => 'Rooke held up the vial and told her who he worked for',
      graph: EMPTY_GRAPH,
      cost: { arousal: 0.8, threatened: true, safe: false },
      now: NOW,
    }, P);
    return composePsycheBlock({
      psyche: r.psyche, name: 'Wren', affect: r.affect, regulation: r.regulation,
      pull: r.pull, intrusions: r.intrusions, params: P,
    });
  }

  it('stays short for a settled character', () => {
    const text = block(emptyPsyche());
    expect(text.split('\n').length).toBeLessThan(8);
  });

  it('carries felt-versus-shown when the character is hiding it', () => {
    const suppressing: PsycheState = {
      ...emptyPsyche(),
      defenseMaturity: 0.35,
      copingHistory: Array.from({ length: 12 }, (_, i) => ({
        at: NOW + i, move: 'suppress' as const, level: 'neurotic' as const,
      })),
    };
    const text = block(suppressing);
    expect(text).toMatch(/FEELING:/);
    expect(text).toMatch(/surface/);
  });

  it('spells out what they will not go near, and what they cannot do', () => {
    let t = formTrauma({
      nodeId: 'n1', perpetrator: 'Rooke',
      affect: { valence: -0.95, arousal: 0.95, dominance: -0.8, label: 'horror' },
      appraisal: appraisal({ agency: 'other', intent: -0.9 }),
      relation: relation({ trust: 0.9, affection: 0.8 }),
      contextBinding: 0.2, now: NOW,
    });
    for (let i = 0; i < 8; i++) {
      t = processIntrusion(t, 'avoid', { safe: false, supported: false, now: NOW + i }, P);
    }
    const wounded: PsycheState = {
      ...emptyPsyche(),
      traumas: [t],
      load: { level: 0.8, sustainedScenes: 15, scenesSinceRelief: 15, peak: 0.8 },
      body: { energy: 0.2, sleepDebt: 0.8, pain: 0.4, safety: 0.15, nourishment: 0.4 },
      attachment: { anxiety: 0.6, avoidance: 0.85 },
    };
    const text = block(wounded);
    expect(text).toMatch(/AVOID:/);
    expect(text).toMatch(/CANNOT:/);
    expect(text).toMatch(/BODY:|CARRYING:/);
  });

  it('never leaks a number or a diagnosis into the prompt', () => {
    const wrecked: PsycheState = {
      ...emptyPsyche(),
      load: { level: 0.9, sustainedScenes: 20, scenesSinceRelief: 20, peak: 0.9 },
      condition: {
        ...emptyPsyche().condition,
        ptsd: { intrusion: 0.8, avoidance: 0.8, negativeAlterations: 0.7, arousal: 0.8, severity: 0.8 },
        depression: { hopelessness: 0.7, anhedonia: 0.7, brooding: 0.6, overgeneralMemory: 0.7, severity: 0.7 },
      },
    };
    const text = block(wrecked);
    expect(text).not.toMatch(/PTSD|CPTSD|diagnos|disorder|0\.\d/i);
  });
});

// ---------------------------------------------------------------- persistence

describe('persistence', () => {
  it('normalises a psyche written by an older version', () => {
    const partial = { version: 1 as const, load: { level: 0.5 } } as unknown as Partial<PsycheState>;
    const p = normalizePsyche(partial);
    expect(p.load.level).toBe(0.5);
    expect(p.load.peak).toBeDefined();
    expect(p.body.energy).toBeDefined();
    expect(p.condition.ptsd.severity).toBe(0);
    expect(p.traumas).toEqual([]);
  });

  it('seeds the starting psyche from temperament', () => {
    const proud = emptyPsyche({ ...neutralTraits(), selfWorth: 0.9, trust: 0.8, conscientiousness: 0.7 });
    const broken = emptyPsyche({ ...neutralTraits(), selfWorth: -0.9, trust: -0.8, volatility: 0.8 });
    // Low self-worth starts closer to self-blame; low trust starts avoidant.
    expect(broken.attribution.internal).toBeGreaterThan(proud.attribution.internal);
    expect(broken.attachment.avoidance).toBeGreaterThan(proud.attachment.avoidance);
    expect(broken.defenseMaturity).toBeLessThan(proud.defenseMaturity);
    expect(broken.dynamics.granularity).toBeLessThan(proud.dynamics.granularity);
  });
});
