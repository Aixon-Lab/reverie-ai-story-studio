/**
 * Neuromodulation — the global gains that make the whole system state-dependent.
 *
 * Every emotional effect in this engine so far is *per-node*: an event is
 * appraised, and the memory it writes gets a bigger `permanentBoost`. That is
 * real, but it is not what arousal does. Arousal changes the operating point of
 * the entire system — how sharply it discriminates, how much reaches awareness,
 * how plastic it is, whether it is laying down new memory or reworking old.
 * A frightened person does not merely encode one memory more strongly; they
 * encode, retrieve and learn *differently*, across the board.
 *
 * Brain-Cog encodes this implicitly (its reward-modulated STDP is ordinary STDP
 * with a global scalar in front, and its brain-area models are wired around
 * neuromodulatory nuclei). We make it explicit — see
 * docs/research/brain-integration-2026.md §B.2 #19.
 *
 * Four modulators, four couplings. Each coupling is a documented effect, not a
 * knob: a pile of arbitrary gains would be worse than none, because it would be
 * untunable and unfalsifiable.
 *
 *   **Noradrenaline → arousal-biased competition.** Under arousal the winner is
 *   amplified and the rest suppressed (Mather & Sutherland; Easterbrook's cue
 *   narrowing). This is why you remember the weapon and not the face. It makes
 *   recall under stress *narrower and more emotional*, not merely stronger.
 *
 *   **Dopamine → plasticity.** Gates how much evidence moves anything: trait
 *   drift, and the willingness to destabilise an existing memory. Low dopamine
 *   is a mind that has stopped updating.
 *
 *   **Serotonin → patience and aversive tolerance.** Sets how long a feeling
 *   sticks and how strongly negative material is preferentially recalled. Low
 *   serotonin is the depressive retrieval bias, and it falls out of load rather
 *   than being authored.
 *
 *   **Acetylcholine → encode-versus-consolidate.** High ACh favours taking in
 *   new input; low ACh favours reworking what is already stored (Hasselmo).
 *   This is the dial between "living the scene" and "sleeping on it", and it is
 *   what makes an idle pass qualitatively different from an active one rather
 *   than just less frequent.
 *
 * Pure. Reads state, returns numbers, touches nothing.
 */
import { clamp01 } from './activation';
import type { Affect, BrainState, MemoryNode, TraitVector } from './types';

// ---------- the modulators ----------

export interface Neuromodulators {
  /** Plasticity and appetitive drive. Baseline 0.5. */
  dopamine: number;
  /** Vigilance and contrast gain. Baseline 0.35 — resting states are not aroused. */
  noradrenaline: number;
  /** Patience, aversive tolerance, mood floor. Baseline 0.5. */
  serotonin: number;
  /** Encode-versus-consolidate balance. Baseline 0.5. */
  acetylcholine: number;
}

export const BASELINE: Neuromodulators = {
  dopamine: 0.5,
  noradrenaline: 0.35,
  serotonin: 0.5,
  acetylcholine: 0.5,
};

/**
 * What the mind is currently doing. Acetylcholine is a *phase* signal, not a
 * mood: the same character mid-scene and mid-sleep is in two different modes.
 */
export type CognitivePhase =
  /** In the scene, taking things in. */
  | 'engaged'
  /** Between turns, nothing arriving — the mentation window. */
  | 'idle'
  /** Offline consolidation: the sleep pass. */
  | 'rest';

// ---------- derivation ----------

/**
 * Derive the modulator levels from everything the character currently is.
 *
 * Degrades safely: a brain with no psyche still gets sensible values from mood
 * and traits alone, because the psyche layer is optional on older brains.
 */
export function modulatorsOf(brain: BrainState, phase: CognitivePhase = 'engaged'): Neuromodulators {
  const mood: Affect = brain.mood;
  const t: TraitVector = brain.traits;
  const psyche = brain.psyche;
  const body = psyche?.body;
  const load = psyche?.load;
  const cond = psyche?.condition;

  // --- noradrenaline: how alert and how threatened ---
  const threat = Math.max(
    cond?.anxiety.hypervigilance ?? 0,
    cond?.anxiety.threatExpectancy ?? 0,
    cond?.ptsd.arousal ?? 0,
  );
  const unsafe = body ? 1 - clamp01(body.safety) : 0;
  const noradrenaline = clamp01(
    BASELINE.noradrenaline
    + 0.45 * clamp01(mood.arousal)
    + 0.30 * threat
    + 0.20 * unsafe
    + 0.10 * clamp01(t.volatility)
    // Being in pain is arousing whether or not anything is happening.
    + 0.15 * clamp01(body?.pain ?? 0),
  );

  // --- dopamine: is anything working out, and is there anything left to spend ---
  const anhedonia = cond?.depression.anhedonia ?? 0;
  const hopeless = cond?.depression.hopelessness ?? 0;
  const dopamine = clamp01(
    BASELINE.dopamine
    + 0.25 * mood.valence
    + 0.15 * clamp01(t.openness)
    - 0.35 * anhedonia
    - 0.20 * hopeless
    - 0.20 * clamp01(load?.level ?? 0)
    - 0.15 * (1 - clamp01(body?.energy ?? 1)),
  );

  // --- serotonin: safety, rest, and the absence of grinding strain ---
  const serotonin = clamp01(
    BASELINE.serotonin
    + 0.25 * clamp01(body?.safety ?? 0.5)
    + 0.15 * clamp01(body?.energy ?? 0.5)
    - 0.35 * clamp01(load?.level ?? 0)
    - 0.25 * hopeless
    - 0.15 * clamp01(cond?.dso.affectDysregulation ?? 0)
    - 0.10 * clamp01(body?.sleepDebt ?? 0),
  );

  /**
   * --- acetylcholine: taking in versus working over ---
   *
   * Phase dominates, because that is what it means. Fatigue lowers it even
   * while engaged — an exhausted character stops encoding well before they stop
   * talking, which is exactly the failure of attention people report.
   */
  const phaseLevel = phase === 'engaged' ? 0.78 : phase === 'idle' ? 0.42 : 0.16;
  const acetylcholine = clamp01(
    phaseLevel
    - 0.20 * clamp01(body?.sleepDebt ?? 0)
    - 0.15 * (1 - clamp01(body?.energy ?? 1))
    - 0.15 * clamp01(psyche?.condition.dissociation.acute ?? 0),
  );

  return { dopamine, noradrenaline, serotonin, acetylcholine };
}

// ---------- gains ----------

/**
 * The multipliers and offsets the rest of the engine reads.
 *
 * All of them are 1 (or 0, for additive terms) at baseline, so a character in a
 * neutral state behaves exactly as they did before this module existed. That is
 * not a nicety — it is what keeps every constant in `DEFAULT_PARAMS` valid and
 * lets the whole mechanism be disabled by pinning the modulators to baseline.
 */
export interface ModulatoryGains {
  /**
   * Arousal-biased competition, in nats per unit of node salience.
   * Positive under arousal: charged memories rise, neutral ones sink.
   */
  contrast: number;
  /** Additive shift on the retrieval threshold. Positive = less reaches awareness. */
  thresholdShift: number;
  /** Multiplier on retrieval noise — how erratic recall is. */
  noiseScale: number;
  /** Multiplier on encoding strength. */
  encodingGain: number;
  /** Multiplier on trait drift and on willingness to rewrite a memory. */
  plasticity: number;
  /** Multiplier on mood inertia: how much of a feeling survives into the next moment. */
  moodInertia: number;
  /** 0 rework what is stored … 1 take in what is arriving. */
  encodeBias: number;
  /** Multiplier on mood-congruent retrieval, especially for negative material. */
  congruenceGain: number;
}

export function gainsOf(m: Neuromodulators): ModulatoryGains {
  const na = m.noradrenaline - BASELINE.noradrenaline;   // −0.35 … +0.65
  const da = m.dopamine - BASELINE.dopamine;             // −0.5 … +0.5
  const ht = m.serotonin - BASELINE.serotonin;           // −0.5 … +0.5

  return {
    // Arousal sharpens the field rather than lifting all of it.
    contrast: 1.1 * na,
    /**
     * Vigilance narrows what reaches awareness (Easterbrook) — fewer memories,
     * more cue-locked. Low serotonin widens it again, which is why a depressed
     * character is flooded rather than focused.
     */
    thresholdShift: 0.45 * Math.max(0, na) + 0.25 * Math.min(0, ht),
    // Stress makes recall erratic; calm makes it steady.
    noiseScale: clamp01(1 + 0.5 * na - 0.2 * ht) || 1,
    // Noradrenaline is the consolidation modulator; exhaustion blunts it.
    encodingGain: Math.max(0.35, 1 + 0.55 * na + 0.25 * (m.acetylcholine - 0.5)),
    // Nothing updates in a mind with no dopamine.
    plasticity: Math.max(0.15, 1 + 0.9 * da),
    // Low serotonin is the mechanism of a feeling that will not shift.
    moodInertia: Math.max(0.4, 1 - 0.6 * ht),
    encodeBias: clamp01(m.acetylcholine),
    // The depressive retrieval bias, derived rather than authored.
    congruenceGain: Math.max(0.5, 1 - 0.8 * ht),
  };
}

/**
 * Acetylcholine during the offline consolidation pass.
 *
 * The reference point for abstraction, and deliberately the *lowest* of the
 * three phases: sleep is when the brain works over what it already has. Making
 * it the reference rather than the midpoint means the existing consolidation
 * behaviour is exactly preserved, and only the newer waking phases deviate.
 */
export const REST_ACETYLCHOLINE = 0.16;

/**
 * Multiplier on how much converging evidence it takes before episodes are
 * abstracted into a generalisation (Hasselmo's encode-versus-consolidate dial).
 *
 * 1.0 during sleep — abstract as readily as the engine always has. Above 1 while
 * awake, because a mind busy taking things in is not simultaneously deciding
 * what they all mean.
 */
export function abstractionFactor(gains: ModulatoryGains): number {
  return Math.max(0.5, 1 + 0.8 * (gains.encodeBias - REST_ACETYLCHOLINE));
}

/** Convenience: derive both in one call. */
export function modulate(brain: BrainState, phase: CognitivePhase = 'engaged'): {
  modulators: Neuromodulators;
  gains: ModulatoryGains;
} {
  const modulators = modulatorsOf(brain, phase);
  return { modulators, gains: gainsOf(modulators) };
}

/**
 * How emotionally charged this memory is, 0..1 — the quantity noradrenaline
 * amplifies and suppresses around.
 *
 * Centred at 0.5 by the caller, so a perfectly average memory is unaffected by
 * arousal and only the tails move.
 */
export function nodeSalience(node: MemoryNode): number {
  const arousal = clamp01(node.affect?.arousal ?? 0);
  const extremity = Math.min(1, Math.abs(node.affect?.valence ?? 0));
  const relevance = clamp01(node.appraisal?.goalRelevance ?? 0);
  return clamp01(0.5 * arousal + 0.3 * extremity + 0.2 * relevance);
}

/**
 * The activation term contributed by arousal-biased competition.
 *
 * Zero for a memory of median salience whatever the arousal, and zero for every
 * memory at baseline arousal — so this only ever redistributes availability, it
 * never inflates the whole field.
 */
export function contrastTerm(node: MemoryNode, gains: ModulatoryGains): number {
  if (!gains.contrast) return 0;
  return gains.contrast * (2 * nodeSalience(node) - 1);
}

/** Plain-language read-out for the Mind page. Never shown to the model. */
export function describeModulators(m: Neuromodulators): string {
  const bits: string[] = [];
  if (m.noradrenaline > 0.62) bits.push('keyed up — narrow, vivid, easily startled');
  else if (m.noradrenaline < 0.22) bits.push('flat and unhurried');
  if (m.dopamine < 0.3) bits.push('nothing feels worth reaching for');
  else if (m.dopamine > 0.72) bits.push('driven, open to changing their mind');
  if (m.serotonin < 0.3) bits.push('raw — feelings stick and the bad ones come first');
  else if (m.serotonin > 0.7) bits.push('settled, hard to rattle');
  if (m.acetylcholine < 0.3) bits.push('turned inward, chewing things over');
  return bits.length ? bits.join('; ') : 'even-keeled';
}
