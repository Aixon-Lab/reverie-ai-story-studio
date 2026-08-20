/**
 * Appraisal bias pipeline (§P.3).
 *
 * The LLM encoder reports the situation roughly as it happened. This module
 * turns that into *the appraisal this particular character actually made*, by
 * running it through an ordered stack of biases, every one of which is recorded.
 *
 * This is where the journey lives. The same sentence from the same person is
 * read as clumsiness in chapter 1 and as an attack in chapter 9, not because
 * anything was authored, but because threat expectancy rose, a relational prior
 * soured, and coping potential fell with the body. The `AppraisalTrace` exists so
 * that difference can be *shown* rather than asserted.
 */
import { clamp01, clampSigned, lerp } from './defaults';
import { bodyCapacity } from './body';
import type { Appraisal, RelationModel, TraitVector } from '../brain/types';
import type {
  AppraisalTrace, AttributionalStyle, BiasStep, Body, Condition, PsycheState,
} from './types';

export interface BiasInput {
  psyche: PsycheState;
  traits: TraitVector;
  /** Mood valence, for mood-congruent reading. */
  moodValence: number;
  /** Relation model for the agent of this event, when there is one. */
  relation?: RelationModel;
  /** Active schema gists that matched this moment, for the belief bias. */
  activeSchemas?: { gist: string; valence: number; strength: number }[];
  /** True when this event blocks or fails a goal — attributional style only fires there. */
  goalFailure?: boolean;
}

/** Apply every bias in order, returning the biased appraisal plus a full trace. */
export function biasAppraisal(raw: Appraisal, input: BiasInput): AppraisalTrace {
  const steps: BiasStep[] = [];
  let a: Appraisal = { ...raw };

  const set = (
    check: keyof Appraisal,
    value: number | Appraisal['agency'],
    source: BiasStep['source'],
    why: string,
  ) => {
    const before = a[check] as number | string;
    if (before === value) return;
    const write = () => { (a as unknown as Record<string, unknown>)[check] = value; };
    // Only record moves worth reading — sub-noise nudges would bury the real ones.
    if (typeof before === 'number' && typeof value === 'number' && Math.abs(before - value) < 0.02) {
      write();
      return;
    }
    write();
    steps.push({ source, check, before, after: value as number | string, why });
  };

  const { psyche } = input;
  const { condition, dynamics } = psyche;

  // ---- 1. trait bias -------------------------------------------------------
  // A distrustful character reads intent darker; a courageous one keeps more of
  // their sense of control; a volatile one finds everything more urgent.
  if (input.traits) {
    const t = input.traits;
    if (t.trust < 0 && a.agency === 'other') {
      set('intent', clampSigned(a.intent + 0.35 * t.trust), 'trait',
        'they do not assume good faith');
    }
    if (t.courage) {
      set('copingPotential', clamp01(a.copingPotential + 0.12 * t.courage), 'trait',
        t.courage > 0 ? 'they back themselves' : 'they expect to be overwhelmed');
    }
    if (t.volatility > 0) {
      set('urgency', clamp01(a.urgency + 0.15 * t.volatility), 'trait',
        'everything feels like it has to be answered now');
    }
  }

  // ---- 2. mood congruence --------------------------------------------------
  // Being in a bad mood is not merely feeling bad — it changes what you perceive.
  const mv = input.moodValence;
  if (Math.abs(mv) > 0.2) {
    set('pleasantness', clampSigned(a.pleasantness + 0.25 * mv), 'mood',
      mv < 0 ? 'a foul mood makes everything taste worse' : 'a good mood softens it');
    if (mv < 0) {
      set('goalConduciveness', clampSigned(a.goalConduciveness + 0.2 * mv), 'mood',
        'in this mood, nothing looks like it is going their way');
    }
  }

  // ---- 3. threat expectancy (PTSD hypervigilance) --------------------------
  // The characteristic distortion: ambiguity resolves toward danger, and the
  // resources to meet it feel smaller than they are.
  const threat = Math.max(condition.anxiety.threatExpectancy, condition.ptsd.arousal);
  if (threat > 0.15) {
    set('urgency', clamp01(a.urgency + 0.3 * threat), 'threat',
      'they are braced for something to go wrong');
    set('novelty', clamp01(a.novelty + 0.15 * threat), 'threat',
      'hypervigilance makes small changes register as significant');
    set('copingPotential', clamp01(a.copingPotential - 0.25 * threat), 'threat',
      'they do not believe they could handle it if it went badly');
    if (a.agency === 'other' && a.intent > -0.2) {
      set('intent', clampSigned(a.intent - 0.3 * threat), 'threat',
        'ambiguity is read as hostile');
    }
  }

  // ---- 4. relational prior -------------------------------------------------
  // What they expect *this person* to do. Without a prior there is no prediction
  // error, and betrayal is merely a bad event rather than a shock.
  const rel = input.relation;
  if (rel && rel.interactions > 0) {
    if (a.agency === 'other') {
      const prior = 0.5 * rel.trust + 0.3 * rel.affection - 0.4 * rel.resentment - 0.3 * rel.fear;
      set('intent', clampSigned(lerp(a.intent, clampSigned(a.intent + prior), 0.5)), 'relation',
        prior < 0
          ? `they already expect the worst of ${rel.displayName}`
          : `they give ${rel.displayName} the benefit of the doubt`);
      if (rel.fear > 0.3) {
        set('copingPotential', clamp01(a.copingPotential - 0.3 * rel.fear), 'relation',
          `${rel.displayName} frightens them`);
      }
    }
    // Being seen by someone who matters raises the stakes of everything.
    if (Math.abs(rel.affection) > 0.4) {
      set('goalRelevance', clamp01(a.goalRelevance + 0.15 * Math.abs(rel.affection)), 'relation',
        `anything involving ${rel.displayName} matters more`);
    }
  }

  // ---- 5. schema activation ------------------------------------------------
  // Core beliefs do not merely colour the memory afterwards; they decide what the
  // event was *about*.
  const schemas = (input.activeSchemas ?? []).filter((s) => s.strength > 0.2);
  if (schemas.length) {
    const worst = schemas.reduce((x, y) => (x.valence <= y.valence ? x : y));
    const weight = clamp01(worst.strength) * 0.3;
    set('goalRelevance', clamp01(a.goalRelevance + weight), 'schema',
      `it lands on something they already believe: "${worst.gist.slice(0, 70)}"`);
    if (worst.valence < -0.2) {
      set('goalConduciveness', clampSigned(a.goalConduciveness - weight), 'schema',
        'it confirms what they were afraid was true');
    }
  }

  // ---- 6. attributional style ---------------------------------------------
  // Hopelessness theory: internal, stable, global explanations for bad outcomes
  // are what convert adversity into depression. This is the single stage that can
  // *rewrite agency*, and it is the reason two characters build different selves
  // from the same betrayal.
  if (input.goalFailure || a.goalConduciveness < -0.25) {
    const st = psyche.attribution;
    if (st.internal > 0.25 && a.agency !== 'self') {
      // They take it on themselves even when it was plainly done to them.
      set('agency', 'self', 'attribution',
        'they reach for their own fault first, whatever actually happened');
      set('norms', clampSigned(a.norms - 0.5 * st.internal), 'attribution',
        'and read it as evidence of their own failure');
    }
    if (st.stable > 0.25) {
      set('copingPotential', clamp01(a.copingPotential - 0.3 * st.stable), 'attribution',
        'they experience this as permanent, so there is nothing to be done');
    }
    if (st.global > 0.25) {
      set('goalRelevance', clamp01(a.goalRelevance + 0.25 * st.global), 'attribution',
        'one failure is taken as being about their whole life');
    }
  }

  // ---- 7. the body ---------------------------------------------------------
  // The highest-yield coupling in the system: coping potential is what separates
  // fear from anger, and coping potential is scaled by what the body has left.
  const capacity = bodyCapacity(psyche.body);
  if (capacity < 0.92) {
    set('copingPotential', clamp01(a.copingPotential * capacity), 'body',
      capacity < 0.4
        ? 'there is nothing left in the tank to meet this with'
        : 'they are too depleted to meet this the way they normally would');
  }

  // ---- 8. numbing ----------------------------------------------------------
  // Anhedonia compresses *positive* appraisal only, leaving negative intact.
  // Modelling it asymmetrically is what makes a depressed character read as flat
  // rather than as sad.
  const flat = Math.max(condition.depression.anhedonia, condition.dissociation.chronic * 0.6);
  if (flat > 0.15) {
    if (a.pleasantness > 0) {
      set('pleasantness', clampSigned(a.pleasantness * (1 - 0.7 * flat)), 'numbing',
        'good things do not land the way they used to');
    }
    if (a.goalConduciveness > 0) {
      set('goalConduciveness', clampSigned(a.goalConduciveness * (1 - 0.6 * flat)), 'numbing',
        'even progress feels like nothing');
    }
  }

  // Low granularity muddies the *reading* itself: an undifferentiated person is
  // less accurate about what kind of bad this was.
  if (dynamics.granularity < 0.35) {
    const blur = (1 - dynamics.granularity) * 0.25;
    set('novelty', clamp01(lerp(a.novelty, 0.5, blur)), 'numbing',
      'they cannot tell how unusual this is — it is all one texture');
  }

  return { raw, biased: a, steps };
}

/**
 * Update attributional style from lived outcomes.
 *
 * Style is not fixed: repeated uncontrollable failure pushes toward
 * internal/stable/global (learned helplessness), and agency that actually works
 * pulls back the other way. Slow on purpose — this is a months-scale property.
 */
export function updateAttribution(
  style: AttributionalStyle,
  outcome: { failed: boolean; controllable: boolean; ownDoing: boolean },
  rate = 0.04,
): AttributionalStyle {
  const dir = outcome.failed ? 1 : -1;
  const uncontrollable = outcome.failed && !outcome.controllable;
  return {
    internal: clampSigned(style.internal + dir * rate * (outcome.ownDoing ? 1.2 : 0.4)),
    stable: clampSigned(style.stable + dir * rate * (uncontrollable ? 1.5 : 0.5)),
    global: clampSigned(style.global + dir * rate * (uncontrollable ? 1.1 : 0.4)),
  };
}

/** One-line description of the style, for the Mind page. */
export function describeAttribution(style: AttributionalStyle): string {
  const bits: string[] = [];
  bits.push(style.internal > 0.25 ? 'blames themselves' : style.internal < -0.25 ? 'blames others' : 'apportions blame evenly');
  if (style.stable > 0.3) bits.push('expects it never to change');
  if (style.global > 0.3) bits.push('takes one failure as being about everything');
  return bits.join('; ');
}
