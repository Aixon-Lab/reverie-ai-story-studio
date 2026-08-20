/**
 * Emergent clinical condition (§P.5).
 *
 * **Nothing in this file is ever authored.** Every symptom is a function of the
 * memory graph plus the coping record. That is the architectural commitment that
 * makes a character feel *discovered* rather than configured: nobody sets
 * "PTSD: on". A character develops intrusions because a high-arousal event was
 * encoded with poor contextual binding and has since been avoided every time it
 * surfaced — which is the actual mechanism.
 *
 * The read-out then feeds back as bias (see `bias.ts`) and as gain (see
 * `dynamics.ts`), closing the loop that lets a character get worse, or better,
 * on their own.
 */
import { clamp01, lerp } from './defaults';
import { chronicity } from './body';
import type { MemoryNode } from '../brain/types';
import type {
  Condition, PsycheParams, PsycheState, RegulationMove, TraumaTrace,
} from './types';

/** Everything the read-out needs from the brain graph. */
export interface GraphSummary {
  /** Active or faded nodes only — dormant material is not driving anything. */
  nodes: MemoryNode[];
  /** Self-schemas with their sign, from schema/identity nodes about the self. */
  selfBeliefs: { gist: string; valence: number; strength: number }[];
  /** Per-person trust, for the relational-disturbance read. */
  relationTrust: number[];
  /** How many goals are currently blocked or abandoned. */
  goalsFailed: number;
  goalsTotal: number;
}

const AVOIDANT: RegulationMove[] = ['avoid', 'suppress', 'dissociate', 'distract'];
const INTEGRATIVE: RegulationMove[] = ['reappraise', 'seek_support', 'confront', 'ruminate_deliberate'];

/**
 * Recompute the whole condition.
 *
 * Called once per consolidation pass. Deliberately a full recompute rather than
 * an incremental update: symptoms should track the *current* state of the graph,
 * so that healing shows up as surely as harm does. An incremental version would
 * accumulate drift and could never fully come down.
 */
export function assessCondition(
  psyche: PsycheState,
  graph: GraphSummary,
  p: PsycheParams,
): Condition {
  const traumas = psyche.traumas;
  const load = psyche.load;
  const coping = psyche.copingHistory.slice(-30);
  const avoidRate = rate(coping, AVOIDANT);
  const integrateRate = rate(coping, INTEGRATIVE);
  const broodRate = rate(coping, ['ruminate_brood']);

  // ---- PTSD -------------------------------------------------------------
  // Intrusion is driven by the Brewin imbalance: strong sensory trace, weak
  // context. Nowness is what makes it a symptom rather than a memory.
  const intrusion = clamp01(
    mean(traumas.map((t) => (1 - t.contextBinding) * t.nowness)) * (0.7 + 0.5 * load.level),
  );
  // Avoidance is measured from behaviour, not asserted.
  const avoidance = clamp01(
    0.6 * avoidRate + 0.4 * mean(traumas.map((t) => ratio(t.avoidanceCount, t.approachCount))),
  );
  // Ehlers & Clark's negative appraisals of the event and its sequelae.
  const negativeAlterations = clamp01(
    mean(traumas.map((t) =>
      0.35 * t.appraisals.selfBlame + 0.25 * t.appraisals.worldDanger
      + 0.25 * t.appraisals.permanentChange + 0.15 * t.appraisals.shame))
    * 0.7 + 0.3 * negativeSelfConcept(graph),
  );
  const arousal = clamp01(
    0.5 * load.level * chronicity(load) * 0.7 + 0.5 * intrusion,
  );
  const ptsdSeverity = traumas.length
    ? clamp01(0.3 * intrusion + 0.25 * avoidance + 0.25 * negativeAlterations + 0.2 * arousal)
    : 0;

  // ---- depression --------------------------------------------------------
  // Hopelessness theory: the attributional style applied to actual failures is
  // what converts adversity into depression — style alone is not enough, and
  // failure alone is not enough.
  const failureRate = graph.goalsTotal ? graph.goalsFailed / graph.goalsTotal : 0;
  const style = psyche.attribution;
  const hopelessness = clamp01(
    failureRate * (0.4 + 0.3 * pos(style.stable) + 0.3 * pos(style.global))
    + 0.3 * pos(style.internal) * failureRate
    + 0.2 * clamp01(load.scenesSinceRelief / 25),
  );
  const anhedonia = clamp01(
    0.5 * hopelessness + 0.3 * psyche.condition.dissociation.chronic
    + 0.2 * clamp01(load.sustainedScenes / 20),
  );
  // CaR-FA-X: capture-and-rumination, functional avoidance and impaired control
  // jointly reduce autobiographical specificity. All three are things we track.
  const overgeneralMemory = clamp01(
    0.4 * broodRate + 0.35 * avoidRate + 0.25 * clamp01(load.level),
  );
  const depressionSeverity = clamp01(
    0.35 * hopelessness + 0.3 * anhedonia + 0.2 * broodRate + 0.15 * overgeneralMemory,
  );

  // ---- anxiety -----------------------------------------------------------
  const threatExpectancy = clamp01(
    0.45 * intrusion + 0.3 * mean(traumas.map((t) => t.appraisals.worldDanger))
    + 0.25 * (1 - psyche.body.safety),
  );
  const hypervigilance = clamp01(0.6 * threatExpectancy + 0.4 * arousal);
  const anxietySeverity = clamp01(0.5 * threatExpectancy + 0.5 * hypervigilance);

  // ---- dissociation ------------------------------------------------------
  const dissociateRate = rate(coping, ['dissociate']);
  const betrayalWeight = clamp01(
    traumas.filter((t) => t.pathway === 'betrayal').length / Math.max(1, traumas.length),
  );
  const chronicDissociation = clamp01(
    lerp(psyche.condition.dissociation.chronic, 0.6 * dissociateRate + 0.4 * betrayalWeight, 0.3),
  );

  // ---- CPTSD / DSO -------------------------------------------------------
  // ICD-11 puts *both* poles under this heading: heightened reactivity and
  // violent outbursts, but equally emotional numbing, inability to feel pleasure,
  // and prolonged dissociative states under stress. Scoring only volatility would
  // miss the shut-down presentation entirely — which is the commoner one after
  // prolonged, inescapable harm.
  const affectDysregulation = clamp01(
    0.3 * psyche.dynamics.instability * 3
    + 0.2 * clamp01(psyche.dynamics.reactivity - 1)
    + 0.25 * (1 - psyche.defenseMaturity)
    + 0.25 * Math.max(chronicDissociation, anhedonia),
  );
  const negSelf = negativeSelfConcept(graph);
  const relationalDisturbance = clamp01(
    0.4 * psyche.attachment.avoidance + 0.25 * psyche.attachment.anxiety
    + 0.35 * clamp01(-mean(graph.relationTrust)),
  );
  // The triad only becomes CPTSD alongside real PTSD load, and only when all
  // three are present — that conjunction is the diagnostic shape.
  const triad = [affectDysregulation, negSelf, relationalDisturbance];
  const dsoSeverity = triad.every((v) => v > p.dsoThreshold) && ptsdSeverity > 0.35
    ? clamp01(mean(triad) * clamp01(ptsdSeverity + 0.3))
    : 0;

  // ---- growth ------------------------------------------------------------
  // Deliberate rumination, elaboration, and survived time — not the absence of
  // the scar. The trauma stays in the graph; what changes is its nowness.
  const deliberate = rate(coping, ['ruminate_deliberate']);
  const elaborated = mean(traumas.map((t) => t.elaboration));
  const survived = clamp01(psyche.scenes / 60);
  const growthBase = clamp01(
    (0.4 * deliberate + 0.3 * integrateRate + 0.3 * elaborated) * survived,
  );
  const growth = {
    // Personal strength grows from having coped, not from having been spared.
    strength: clamp01(growthBase * (0.6 + 0.4 * psyche.defenseMaturity)),
    relating: clamp01(growthBase * (1 - psyche.attachment.avoidance)),
    possibilities: clamp01(growthBase * (1 - hopelessness)),
    appreciation: clamp01(growthBase * (0.5 + 0.5 * psyche.body.safety)),
    existential: clamp01(growthBase * clamp01(elaborated)),
    severity: growthBase,
  };

  return {
    ptsd: { intrusion, avoidance, negativeAlterations, arousal, severity: ptsdSeverity },
    dso: {
      affectDysregulation,
      negativeSelfConcept: negSelf,
      relationalDisturbance,
      severity: dsoSeverity,
    },
    depression: {
      hopelessness, anhedonia, brooding: broodRate, overgeneralMemory,
      severity: depressionSeverity,
    },
    anxiety: { threatExpectancy, hypervigilance, severity: anxietySeverity },
    dissociation: {
      acute: psyche.condition.dissociation.acute,
      chronic: chronicDissociation,
    },
    growth,
  };
}

/**
 * Negative self-concept, measured rather than asserted: the balance of strength
 * between beliefs about the self that are damning and beliefs that are not.
 */
function negativeSelfConcept(graph: GraphSummary): number {
  if (!graph.selfBeliefs.length) return 0;
  let neg = 0;
  let pos = 0;
  for (const b of graph.selfBeliefs) {
    const w = Math.max(0, b.strength);
    if (b.valence < -0.1) neg += w * Math.abs(b.valence);
    else if (b.valence > 0.1) pos += w * b.valence;
  }
  const total = neg + pos;
  return total > 0 ? clamp01(neg / total) : 0;
}

/**
 * How this condition should bend memory retrieval.
 *
 * The most striking single symptom we can render: as depression deepens, recall
 * loses specificity, and the character answers "what happened?" with
 * *"it's always like that"* instead of with a scene. A memory system that gets
 * measurably vaguer as its owner gets more depressed is the kind of detail that
 * makes people believe the rest of it.
 */
export interface RetrievalBias {
  /** Multiplier on episodic node activation. <1 suppresses specific memories. */
  episodicGain: number;
  /** Multiplier on semantic/schema activation. >1 favours generalities. */
  generalGain: number;
  /** Multiplier on positively-valenced memories (mood congruence + anhedonia). */
  positiveGain: number;
  /** Extra activation for threat-related material. */
  threatGain: number;
  /** Probability weight on intrusions firing at all. */
  intrusionGain: number;
}

export function retrievalBias(condition: Condition, moodValence: number): RetrievalBias {
  const og = condition.depression.overgeneralMemory;
  return {
    episodicGain: lerp(1, 0.45, og),
    generalGain: lerp(1, 1.5, og),
    // Mood-congruent recall, sharpened by anhedonia: good memories become both
    // harder to reach and less rewarding when reached.
    positiveGain: clamp01(
      lerp(1, 0.5, clamp01(-moodValence)) * (1 - 0.35 * condition.depression.anhedonia),
    ),
    threatGain: 1 + 0.6 * condition.anxiety.hypervigilance,
    intrusionGain: clamp01(condition.ptsd.intrusion * (1 - 0.5 * condition.growth.severity)),
  };
}

/**
 * Plain-language read of the condition, for the Mind page and the prompt.
 *
 * Written as description of a person, never as diagnosis: "cannot stop scanning
 * the room" rather than "hypervigilance 0.7". The numbers are for the engine; the
 * words are what a reader should recognise.
 */
export function describeCondition(condition: Condition): string[] {
  const out: string[] = [];
  const c = condition;

  if (c.ptsd.intrusion > 0.45) {
    out.push(c.ptsd.intrusion > 0.7
      ? 'it keeps happening to them, not in memory but now, without warning'
      : 'pieces of it arrive uninvited');
  }
  if (c.ptsd.avoidance > 0.5) out.push('they will not go near certain subjects, and will change the topic to avoid them');
  if (c.anxiety.hypervigilance > 0.5) out.push('they are reading the room for threat continuously and cannot stop');
  if (c.depression.anhedonia > 0.5) out.push('nothing good reaches them properly any more');
  if (c.depression.hopelessness > 0.5) out.push('they have stopped believing that effort changes outcomes');
  if (c.depression.overgeneralMemory > 0.5) out.push('their memories have gone vague — they answer with patterns rather than scenes');
  if (c.dissociation.chronic > 0.45) out.push('they leave, without going anywhere, when it gets to be too much');
  if (c.dso.negativeSelfConcept > 0.6) out.push('they take themselves to be fundamentally diminished');
  if (c.dso.relationalDisturbance > 0.55) out.push('closeness itself now reads as exposure');
  if (c.dso.severity > 0.4) out.push('the damage has reached who they take themselves to be, not only what they remember');
  if (c.growth.severity > 0.4) {
    out.push(c.growth.strength > 0.5
      ? 'they have come out the other side of something and know it'
      : 'something in them has started to reorganise around what happened');
  }
  return out;
}

// ---------- small helpers ----------

function rate(history: { move: RegulationMove }[], moves: RegulationMove[]): number {
  if (!history.length) return 0;
  return history.filter((h) => moves.includes(h.move)).length / history.length;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function ratio(a: number, b: number): number {
  const total = a + b;
  return total > 0 ? a / total : 0;
}

function pos(v: number): number {
  return Math.max(0, v);
}

/** Convenience for callers that only have the trauma list. */
export function worstTrauma(traumas: TraumaTrace[]): TraumaTrace | null {
  if (!traumas.length) return null;
  return traumas.reduce((a, b) =>
    (1 - a.contextBinding) * a.nowness >= (1 - b.contextBinding) * b.nowness ? a : b);
}
