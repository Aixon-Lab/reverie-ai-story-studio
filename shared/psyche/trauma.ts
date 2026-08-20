/**
 * Trauma as a live process (§P.5.1, §P.5.2).
 *
 * v1 made trauma *a kind of node*: high arousal produced a sensory fragment with
 * an `intrusive` flag, and that was the whole model. But trauma is not a storage
 * format, it is a maintenance loop. Ehlers & Clark's answer to "why do some
 * people not recover" is that the memory stays poorly elaborated, the appraisals
 * stay catastrophic, and the coping — suppression, rumination, numbing,
 * persistent dissociation — keeps it that way.
 *
 * So the single most important function here is `processIntrusion`: when
 * something surfaces, what the character *does* about it decides whether the
 * trauma integrates or sensitises. Approach in safety heals. Avoidance makes the
 * next intrusion more likely and more present-tense. Nothing else in this system
 * produces a character arc as directly as that one branch.
 */
import { clamp01, clampSigned, lerp } from './defaults';
import { tokenSet } from '../brain/activation';
import type { Affect, Appraisal, RelationModel } from '../brain/types';
import type {
  PsycheParams, PsycheState, RegulationMove, TraumaTrace,
} from './types';

// ---------- formation ----------

export interface TraumaFormationInput {
  nodeId: string;
  contextNodeId?: string;
  affect: Affect;
  appraisal: Appraisal;
  /** Who did it, when there is a who. */
  perpetrator?: string;
  /** Relation model for the perpetrator, for the betrayal pathway. */
  relation?: RelationModel;
  /** How much the character depended on the perpetrator, 0..1. */
  dependency?: number;
  /** Contextual binding the encoder produced (v1 already computes this). */
  contextBinding: number;
  now: number;
}

/**
 * Which injury is this?
 *
 * The three pathways have genuinely different trajectories, and collapsing them
 * into "trauma" is what makes most systems' trauma feel generic:
 *
 * - **fear** — threat to the body. Produces hypervigilance and threat expectancy.
 * - **betrayal** — harm by a trusted, depended-upon other. Freyd's key variable is
 *   dependency, and the signature is shame and dissociation rather than fear,
 *   with the damage landing on the relational model rather than on threat.
 * - **moral** — something *they* did, or failed to prevent. No hypervigilance at
 *   all; the damage is to self-concept, and the emotion is guilt, not fear.
 */
export function classifyPathway(input: TraumaFormationInput): TraumaTrace['pathway'] {
  const a = input.appraisal;
  if (a.agency === 'self' && a.norms < -0.35) return 'moral';
  const dependency = input.dependency ?? relationDependency(input.relation);
  const violated = input.relation ? Math.max(0, input.relation.trust) : 0;
  if (a.agency === 'other' && a.intent < -0.2 && dependency * (0.4 + violated) > 0.25) {
    return 'betrayal';
  }
  return 'fear';
}

/** How much this character needed the other person — the betrayal multiplier. */
function relationDependency(rel?: RelationModel): number {
  if (!rel) return 0;
  // Needing someone is not the same as liking them: fear and debt bind people to
  // each other every bit as tightly as affection does.
  return clamp01(
    0.4 * Math.max(0, rel.affection) + 0.3 * rel.familiarity
    + 0.2 * Math.max(0, rel.fear) + 0.1 * clamp01(Math.abs(rel.debt)),
  );
}

/**
 * Build the live trace for a newly formed trauma.
 *
 * Betrayal fragments harder than fear does — that is the empirical finding, and
 * it means the memory arrives already less contextualised and therefore more
 * prone to intruding.
 */
export function formTrauma(input: TraumaFormationInput): TraumaTrace {
  const pathway = classifyPathway(input);
  const a = input.appraisal;

  const fragmentation = pathway === 'betrayal' ? 0.65 : pathway === 'moral' ? 0.85 : 1;

  return {
    nodeId: input.nodeId,
    contextNodeId: input.contextNodeId,
    contextBinding: clamp01(input.contextBinding * fragmentation),
    // Fresh trauma is maximally present-tense. Time alone does not reduce this —
    // only elaboration does.
    nowness: clamp01(0.75 + 0.25 * input.affect.arousal),
    elaboration: clamp01(0.15 * input.contextBinding),
    appraisals: {
      // "I should have stopped this" — driven by agency and by norm violation.
      selfBlame: clamp01(
        (a.agency === 'self' ? 0.6 : 0.15)
        + 0.35 * clamp01(-a.norms)
        + (pathway === 'moral' ? 0.3 : 0),
      ),
      worldDanger: clamp01(pathway === 'fear' ? 0.5 + 0.4 * clamp01(-a.pleasantness) : 0.25),
      // "I am permanently changed by this" — the appraisal that predicts chronicity.
      permanentChange: clamp01(0.4 + 0.4 * (1 - a.copingPotential)),
      shame: clamp01(
        (pathway === 'betrayal' ? 0.55 : pathway === 'moral' ? 0.6 : 0.2)
        + 0.3 * clamp01(-a.norms) + 0.2 * clamp01(-input.affect.dominance),
      ),
    },
    avoidanceCount: 0,
    approachCount: 0,
    pathway,
    perpetrator: input.perpetrator,
    encodedAt: input.now,
    intrusionCount: 0,
  };
}

// ---------- intrusion ----------

export interface IntrusionCheck {
  trauma: TraumaTrace;
  /** 0..1 how much the present moment resembles the trauma. */
  cueOverlap: number;
  /** Probability this surfaces right now. */
  probability: number;
}

/**
 * Which traumas are pressing against the present moment.
 *
 * The Brewin imbalance made operational: a strongly encoded sensory trace with
 * weak contextual binding intrudes, and load raises the gain on all of it.
 * Growth lowers it — which is what "healed" looks like mechanically. The trace
 * is still in the graph at full strength; it simply stops arriving uninvited.
 */
export function checkIntrusions(
  psyche: PsycheState,
  cueText: string,
  actorsPresent: string[],
  nodeGist: (nodeId: string) => string,
): IntrusionCheck[] {
  const cue = tokenSet(cueText);
  const actors = new Set(actorsPresent.map((a) => a.toLowerCase()));

  return psyche.traumas
    .map((trauma) => {
      const gist = tokenSet(nodeGist(trauma.nodeId));
      let overlap = jaccard(cue, gist);
      // The person who did it being in the room is the strongest cue there is.
      if (trauma.perpetrator && actors.has(trauma.perpetrator.toLowerCase())) {
        overlap = clamp01(overlap + 0.45);
      }
      const imbalance = (1 - trauma.contextBinding) * trauma.nowness;
      const gain = 0.6 + 0.6 * psyche.load.level - 0.5 * psyche.condition.growth.severity;
      return {
        trauma,
        cueOverlap: overlap,
        probability: clamp01(overlap * imbalance * gain),
      };
    })
    .filter((c) => c.probability > 0.12)
    .sort((a, b) => b.probability - a.probability);
}

/**
 * The loop. What the character does when it surfaces changes the trauma itself.
 *
 * This is the whole design in one function:
 *
 * - approach in safety (reappraise, seek support, confront, deliberate rumination)
 *   → elaboration and context up, nowness down → **fewer intrusions next time**
 * - avoidance (avoid, suppress, dissociate, brooding)
 *   → nowness up, elaboration down → **more intrusions next time**
 *
 * Safety gates the healing branch, and that is not a detail: facing it while
 * still in danger is not processing, it is re-exposure, and it does not help.
 */
export function processIntrusion(
  trauma: TraumaTrace,
  move: RegulationMove,
  opts: { safe: boolean; supported: boolean; now: number },
  p: PsycheParams,
): TraumaTrace {
  const next: TraumaTrace = {
    ...trauma,
    appraisals: { ...trauma.appraisals },
    intrusionCount: trauma.intrusionCount + 1,
    lastIntrusionAt: opts.now,
  };

  const integrative = move === 'reappraise' || move === 'seek_support'
    || move === 'confront' || move === 'ruminate_deliberate';

  if (integrative && opts.safe) {
    // Being *with someone* while you face it is worth more than facing it alone.
    const potency = p.integrationRate * (opts.supported ? 1.4 : 1);
    next.approachCount++;
    next.elaboration = clamp01(next.elaboration + potency);
    next.contextBinding = clamp01(next.contextBinding + potency * 0.8);
    next.nowness = clamp01(next.nowness - potency);
    // The catastrophic meanings loosen as the memory becomes tellable — but
    // slowly, and self-blame is the last to go.
    next.appraisals.permanentChange = clamp01(next.appraisals.permanentChange - potency * 0.7);
    next.appraisals.worldDanger = clamp01(next.appraisals.worldDanger - potency * 0.5);
    next.appraisals.shame = clamp01(next.appraisals.shame - potency * 0.4);
    next.appraisals.selfBlame = clamp01(next.appraisals.selfBlame - potency * 0.25);
    return next;
  }

  if (integrative && !opts.safe) {
    // Facing it in danger: no integration, and it costs something.
    next.approachCount++;
    next.nowness = clamp01(next.nowness + p.sensitisationRate * 0.5);
    return next;
  }

  // Everything else is avoidance in one costume or another.
  next.avoidanceCount++;
  const cost = p.sensitisationRate * (move === 'dissociate' ? 1.5 : move === 'ruminate_brood' ? 1.2 : 1);
  next.nowness = clamp01(next.nowness + cost);
  next.elaboration = clamp01(next.elaboration - cost * 0.6);
  if (move === 'dissociate') {
    // Dissociation at retrieval re-fragments the memory, which is why repeated
    // dissociation produces the classically gappy trauma narrative.
    next.contextBinding = clamp01(next.contextBinding - cost);
  }
  // Avoidance confirms the danger: never disconfirmed, the belief hardens.
  next.appraisals.worldDanger = clamp01(next.appraisals.worldDanger + cost * 0.4);
  next.appraisals.permanentChange = clamp01(next.appraisals.permanentChange + cost * 0.3);
  return next;
}

/**
 * Time and sleep, applied to a trauma between scenes.
 *
 * The asymmetry that makes recovery real: elapsed time softens a memory that has
 * been *elaborated*, and does nothing at all for one that has not. This is why
 * "just give it time" works for some people and not others, and it falls out of
 * the model rather than being asserted by it.
 */
export function restTrauma(trauma: TraumaTrace, scenes: number, slept: boolean): TraumaTrace {
  if (!slept || scenes <= 0) return trauma;
  const workable = trauma.elaboration;
  if (workable < 0.25) return trauma;
  const softening = 0.03 * scenes * workable;
  return {
    ...trauma,
    nowness: clamp01(trauma.nowness - softening),
    contextBinding: clamp01(trauma.contextBinding + softening * 0.5),
  };
}

/**
 * What a trauma does to the relationship with the person who caused it.
 *
 * Trust falls fast and returns slowly — the asymmetry is the point, and it is why
 * betrayal is structurally different from an argument.
 */
export function relationalDamage(
  rel: RelationModel,
  trauma: TraumaTrace,
): Partial<RelationModel> {
  if (trauma.pathway === 'moral') return {};
  const severity = clamp01(0.5 * trauma.nowness + 0.5 * trauma.appraisals.worldDanger);
  return {
    trust: clampSigned(rel.trust - 0.8 * severity),
    fear: clampSigned(rel.fear + 0.5 * severity),
    resentment: clampSigned(rel.resentment + 0.6 * severity),
    affection: clampSigned(
      // Betrayal does not simply delete affection — that is what makes it hurt.
      trauma.pathway === 'betrayal' ? rel.affection * 0.7 : rel.affection - 0.2 * severity,
    ),
  };
}

/**
 * Render an intrusion for the prompt.
 *
 * Present tense, no temporal framing, no "she remembered" — the defining quality
 * of an S-rep is the absence of a sense of pastness, and the prose has to carry
 * that or the mechanism is invisible to the reader.
 */
export function renderIntrusion(trauma: TraumaTrace, gist: string, granularity: number): string {
  const bodily = trauma.nowness > 0.7;
  const frame = bodily
    ? 'It is happening, not being remembered'
    : 'It comes back in pieces';
  const meaning = granularity > 0.5
    ? topAppraisal(trauma)
    : '';
  return `${frame}: ${gist}${meaning ? ` — and with it, ${meaning}` : ''}.`;
}

function topAppraisal(trauma: TraumaTrace): string {
  const entries: [keyof TraumaTrace['appraisals'], string][] = [
    ['selfBlame', 'the certainty that they should have stopped it'],
    ['shame', 'the wish not to be looked at'],
    ['worldDanger', 'the certainty that it is going to happen again'],
    ['permanentChange', 'the sense that they do not get to be who they were'],
  ];
  let best = entries[0];
  let bestVal = -1;
  for (const e of entries) {
    const v = trauma.appraisals[e[0]];
    if (v > bestVal) { bestVal = v; best = e; }
  }
  return bestVal > 0.4 ? best[1] : '';
}

/** How far along the recovery path this trauma is, for the Mind page. */
export function traumaStatus(trauma: TraumaTrace): string {
  if (trauma.nowness > 0.7 && trauma.elaboration < 0.3) return 'raw — not yet a memory, still an event';
  if (trauma.avoidanceCount > trauma.approachCount * 2 && trauma.intrusionCount > 3) {
    return 'entrenched — every time it surfaces they push it away, and it comes back harder';
  }
  if (trauma.elaboration > 0.6 && trauma.nowness < 0.35) return 'integrated — it happened, and it is over';
  if (trauma.approachCount > trauma.avoidanceCount) return 'being worked through';
  return 'unprocessed';
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

export { lerp };
