/**
 * Appraisal → emotion, and emotion → mood.
 *
 * Implements Scherer's Component Process Model (§5.4): an event does not carry
 * an emotion, it carries appraisal checks, and the *character's own* traits and
 * goals decide what those checks return. This is the mechanism that makes a
 * strong-willed and a timid character feel — and therefore remember — different
 * things about an identical event.
 *
 * Pure functions only.
 */
import { clamp01, clampSigned } from './activation';
import type { Affect, Appraisal, BrainParams, EmotionLabel, TraitVector, WorkingSelf } from './types';

export function neutralAppraisal(): Appraisal {
  return {
    novelty: 0.2,
    pleasantness: 0,
    goalRelevance: 0.2,
    goalConduciveness: 0,
    agency: 'circumstance',
    intent: 0,
    copingPotential: 0.5,
    norms: 0,
    urgency: 0.2,
  };
}

/**
 * Bend a raw appraisal through the character's dispositional lens.
 *
 * The raw appraisal describes the *situation*; this makes it describe the
 * situation **as experienced by this person**. Courage and dominance raise
 * perceived coping potential; volatility raises urgency and novelty shock; low
 * trust darkens attributed intent; conscientiousness sharpens norm violations;
 * low self-worth turns other-blame into self-blame (§5.4, §9.1).
 */
export function personalizeAppraisal(raw: Appraisal, traits: TraitVector, self?: WorkingSelf): Appraisal {
  const t = traits;
  const a: Appraisal = { ...raw };

  a.copingPotential = clamp01(
    raw.copingPotential + 0.28 * t.courage + 0.18 * t.dominance - 0.20 * t.volatility + 0.12 * t.selfWorth,
  );
  a.novelty = clamp01(raw.novelty * (1 - 0.25 * t.openness) + 0.15 * Math.max(0, t.volatility));
  a.urgency = clamp01(raw.urgency + 0.20 * t.volatility - 0.10 * t.conscientiousness);
  a.norms = clampSigned(raw.norms * (1 + 0.35 * Math.max(0, t.conscientiousness)));

  // A distrustful character reads ambiguous acts as hostile.
  if (raw.agency === 'other') {
    a.intent = clampSigned(raw.intent + 0.30 * t.trust - 0.10 * Math.max(0, t.volatility));
  }

  // Low self-worth turns *ambiguous* harm inward — "I must have deserved it".
  // Unmistakable malice is still attributed outward: self-blame distorts blame
  // where blame is uncertain, it does not erase an obvious aggressor.
  if (
    raw.agency === 'other' &&
    raw.goalConduciveness < 0 &&
    t.selfWorth < -0.5 &&
    Math.abs(a.intent) < 0.4
  ) {
    a.agency = 'self';
    a.norms = clampSigned(a.norms - 0.3);
  }

  // Goal relevance rises when the event touches something the working self is on about.
  if (self?.goals?.length) {
    const pressure = Math.min(1, self.goals.filter((g) => g.status === 'active').length / 4);
    a.goalRelevance = clamp01(raw.goalRelevance + 0.15 * pressure);
  }

  a.pleasantness = clampSigned(raw.pleasantness + 0.10 * t.warmth);
  a.goalConduciveness = clampSigned(raw.goalConduciveness);
  return a;
}

/**
 * Appraisal → dimensional affect + a discrete label.
 *
 * Valence follows goal conduciveness first (the CPM's implication check),
 * pleasantness second, normative fit third. Arousal is driven by novelty,
 * relevance, urgency and the extremity of valence. Dominance is coping
 * potential recentred to -1..1 — the axis that separates anger from fear.
 */
export function appraiseToAffect(a: Appraisal, traits?: TraitVector): Affect {
  const valence = clampSigned(
    0.60 * a.goalConduciveness + 0.28 * a.pleasantness + 0.12 * a.norms,
  );
  const extremity = Math.abs(valence);
  const reactivity = traits ? 1 + 0.30 * traits.volatility : 1;
  const arousal = clamp01(
    (0.34 * a.novelty + 0.30 * a.goalRelevance + 0.22 * a.urgency + 0.28 * extremity) * reactivity,
  );
  const dominance = clampSigned(a.copingPotential * 2 - 1);
  return { valence, arousal, dominance, label: labelFor(a, valence, arousal, dominance) };
}

/**
 * Discrete emotion from the appraisal profile.
 *
 * The branch structure is the CPM's own logic: obstructive + other-agency +
 * high power → anger; the same event with low power → fear; self-agency + norm
 * violation → guilt or shame depending on whether the standard broken is
 * personal or social.
 */
function labelFor(a: Appraisal, valence: number, arousal: number, dominance: number): EmotionLabel {
  const strong = dominance > 0.1;
  const relevant = a.goalRelevance > 0.25;

  if (!relevant && arousal < 0.3) return valence > 0.2 ? 'calm' : 'neutral';
  if (a.novelty > 0.8 && Math.abs(valence) < 0.2) return 'surprise';

  if (valence < -0.08) {
    // Overwhelming, inescapable and repellent — the trauma signature (§8).
    if (valence < -0.75 && arousal > 0.85 && a.copingPotential < 0.15) return 'horror';
    if (a.agency === 'self' && a.norms < -0.2) {
      // Personal standard broken → guilt; social standing damaged → shame.
      return a.goalRelevance > 0.6 && dominance < -0.3 ? 'shame' : 'guilt';
    }
    if (a.agency === 'other' && a.intent < -0.15) {
      if (strong) return a.norms < -0.4 ? 'contempt' : 'anger';
      return a.urgency > 0.55 ? 'fear' : 'humiliation';
    }
    if (a.novelty > 0.55 && !strong) return a.urgency > 0.5 ? 'fear' : 'anxiety';
    if (a.pleasantness < -0.5) return 'disgust';
    if (a.goalConduciveness < -0.65 && a.copingPotential < 0.3) {
      return a.goalRelevance > 0.75 ? 'grief' : 'sadness';
    }
    if (a.agency === 'other' && a.intent > 0 && a.goalConduciveness < -0.3) return 'jealousy';
    if (arousal < 0.35) return 'loneliness';
    return strong ? 'anger' : 'sadness';
  }

  if (valence > 0.08) {
    if (a.agency === 'other' && a.intent > 0.3) {
      return a.goalRelevance > 0.6 ? 'gratitude' : 'affection';
    }
    if (a.agency === 'self' && a.norms > 0.25) return 'pride';
    if (a.novelty > 0.65) return arousal > 0.6 ? 'awe' : 'surprise';
    if (a.urgency < 0.25 && a.goalConduciveness > 0.4) return 'relief';
    if (a.goalRelevance > 0.55 && a.copingPotential > 0.6) return 'hope';
    if (a.pleasantness > 0.5) return arousal > 0.55 ? 'joy' : 'amusement';
    return arousal > 0.5 ? 'joy' : 'trust';
  }

  return a.novelty > 0.5 ? 'confusion' : 'neutral';
}

/**
 * Mood is a lagging average of felt emotion that regresses toward a
 * dispositional baseline when nothing is happening (§5.5).
 */
export function updateMood(
  mood: Affect,
  events: Affect[],
  traits: TraitVector,
  p: BrainParams,
  /**
   * Neuromodulatory inertia (`neuromodulation.ts`): above 1, feeling survives
   * longer and regression toward temperament is slower. This is the mechanism
   * behind a mood that will not shift — low serotonin under sustained load —
   * and it is derived from state rather than authored anywhere.
   *
   * Note the sense of `p.moodInertia`: it is the *rate of movement*, so slower
   * regression means dividing by the gain, not multiplying.
   */
  inertiaGain = 1,
): Affect {
  const baseline = dispositionalBaseline(traits);
  const settleRate = p.moodInertia / Math.max(0.1, inertiaGain);
  if (!events.length) {
    return blend(mood, baseline, settleRate * 0.6);
  }
  // Arousal-weighted mean: an intense moment colours the mood more than a dull one.
  let wv = 0, wa = 0, wd = 0, w = 0;
  for (const e of events) {
    const weight = 0.25 + 0.75 * clamp01(e.arousal);
    wv += e.valence * weight;
    wa += e.arousal * weight;
    wd += e.dominance * weight;
    w += weight;
  }
  const mean: Affect = {
    valence: clampSigned(wv / w),
    arousal: clamp01(wa / w),
    dominance: clampSigned(wd / w),
    label: dominantLabel(events),
  };
  // Move toward the felt mean, then always drift a little back toward baseline.
  const moved = blend(mood, mean, p.moodInertia);
  const settled = blend(moved, baseline, settleRate * 0.25);
  return { ...settled, label: mean.label };
}

/** Where this person's mood sits when nothing is happening. */
export function dispositionalBaseline(t: TraitVector): Affect {
  const valence = clampSigned(0.35 * t.warmth + 0.30 * t.selfWorth - 0.25 * t.volatility);
  const arousal = clamp01(0.18 + 0.22 * Math.max(0, t.volatility));
  const dominance = clampSigned(0.45 * t.dominance + 0.35 * t.courage);
  return { valence, arousal, dominance, label: valence > 0.25 ? 'calm' : 'neutral' };
}

function blend(a: Affect, b: Affect, k: number): Affect {
  const f = Math.min(1, Math.max(0, k));
  return {
    valence: clampSigned(a.valence + (b.valence - a.valence) * f),
    arousal: clamp01(a.arousal + (b.arousal - a.arousal) * f),
    dominance: clampSigned(a.dominance + (b.dominance - a.dominance) * f),
    label: a.label,
  };
}

function dominantLabel(events: Affect[]): EmotionLabel {
  let best = events[0];
  for (const e of events) if (e.arousal > best.arousal) best = e;
  return best?.label ?? 'neutral';
}

/**
 * Does this event qualify as trauma? Extreme arousal with low coping potential
 * and negative valence produces the amygdala-up / hippocampus-down profile that
 * yields a strong sensory trace and a weak contextual one (§8).
 */
export function isTraumatic(affect: Affect, appraisal: Appraisal, p: BrainParams): boolean {
  return (
    affect.arousal >= p.traumaArousal &&
    affect.valence <= -0.35 &&
    appraisal.copingPotential <= 0.35
  );
}

/**
 * Context binding at encoding: how well the episode is tied to time, place and
 * sequence. Extreme stress degrades it, which is what makes trauma intrusive
 * rather than narratable (§8).
 */
export function contextBindingFor(affect: Affect, appraisal: Appraisal): number {
  const stressPenalty = Math.max(0, affect.arousal - 0.6) * 1.6;
  const copingBonus = 0.25 * appraisal.copingPotential;
  return clamp01(0.85 - stressPenalty + copingBonus);
}

/** Human-readable emotion for the UI and for the prompt block. */
export function describeAffect(a: Affect): string {
  const intensity = a.arousal > 0.75 ? 'overwhelming' : a.arousal > 0.5 ? 'strong' : a.arousal > 0.25 ? 'clear' : 'faint';
  return `${intensity} ${a.label}`;
}
