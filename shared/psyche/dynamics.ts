/**
 * Affect dynamics (§P.2.1, §P.2.2).
 *
 * v1 had one mood EMA with a fixed rate. That cannot express a person, because
 * affective-dynamics research is clear that the *shape* of emotional change —
 * inertia, reactivity, instability, differentiation — carries the signal
 * independently of average intensity.
 *
 * The important move here is that the coupling constants are themselves state.
 * A loaded, depressed character does not merely feel worse; their feelings move
 * differently, stick longer, and are harder for them to name.
 */
import { clamp, clamp01, clampSigned, lerp } from './defaults';
import { bodyCapacity, chronicity } from './body';
import type { Affect, EmotionLabel } from '../brain/types';
import type { AffectDynamics, Condition, Load, Body, PsycheParams } from './types';

/**
 * Recompute the dynamics constants from current state.
 *
 * Called once per scene, before affect is updated, so the character's emotional
 * machinery reflects the condition they are actually in.
 */
export function retuneDynamics(
  dyn: AffectDynamics,
  load: Load,
  body: Body,
  condition: Condition,
  p: PsycheParams,
): AffectDynamics {
  const chronic = chronicity(load);

  // Inertia: depression and load both make feelings stick. High inertia is one of
  // the most robust markers in the emotion-dynamics literature.
  const inertia = clamp01(
    lerp(dyn.inertia, 0.45 + 0.3 * condition.depression.severity + 0.2 * load.level, 0.25),
  );

  // Reactivity: kindling. Each successive blow lands harder while load is high;
  // numbing pulls the other way, which is why depression can look flat and
  // hypervigilance can look explosive in the same person on different days.
  const kindled = 1 + p.kindlingGain * load.level * (chronic - 0.6);
  const numbed = 1 - 0.45 * condition.depression.anhedonia - 0.3 * condition.dissociation.chronic;
  const reactivity = clamp(
    lerp(dyn.reactivity, kindled * numbed * (1 + 0.35 * condition.ptsd.arousal), 0.3),
    0.35, 2.2,
  );

  // Granularity: crisis blurs feeling. This is the field with the most direct
  // prose consequence — see `describeFeeling`.
  const blur = p.granularityLoss * (0.6 * load.level + 0.4 * condition.dissociation.acute)
    + 0.25 * (1 - bodyCapacity(body));
  const target = clamp01(0.75 - blur + 0.2 * condition.growth.severity);
  const granularity = clamp01(
    target > dyn.granularity
      // Recovering the ability to name what you feel is slow; losing it is fast.
      ? dyn.granularity + p.granularityGain
      : lerp(dyn.granularity, target, 0.6),
  );

  return { ...dyn, inertia, reactivity, granularity };
}

export interface EmotionInput {
  /** The affect the appraisal engine derived for this event. */
  event: Affect;
  /** Current diffuse mood. */
  mood: Affect;
}

/**
 * Blend an event's affect into the ongoing mood, using this character's own
 * inertia and reactivity rather than a global constant.
 *
 * Returns both the acute emotion (what they feel *now*, amplified by reactivity)
 * and the updated mood (what they carry out of the moment).
 */
export function applyEmotion(
  dyn: AffectDynamics,
  input: EmotionInput,
): { emotion: Affect; mood: Affect; dynamics: AffectDynamics } {
  const k = dyn.reactivity;
  const emotion: Affect = {
    valence: clampSigned(input.event.valence * k),
    arousal: clamp01(input.event.arousal * Math.max(0.6, k)),
    dominance: clampSigned(input.event.dominance),
    label: input.event.label,
  };

  // Mood is the inertial part: how much of what they were survives what happened.
  const keep = dyn.inertia;
  const mood: Affect = {
    valence: clampSigned(input.mood.valence * keep + emotion.valence * (1 - keep)),
    arousal: clamp01(input.mood.arousal * keep + emotion.arousal * (1 - keep)),
    dominance: clampSigned(input.mood.dominance * keep + emotion.dominance * (1 - keep)),
    label: Math.abs(emotion.valence) > Math.abs(input.mood.valence) ? emotion.label : input.mood.label,
  };

  // Instability is the mean squared successive difference — the dysregulation
  // marker. Tracked as a running mean so it is comparable across chat lengths.
  const diff = mood.valence - dyn.lastValence;
  const samples = dyn.samples + 1;
  const instability = dyn.samples === 0
    ? 0
    : (dyn.instability * dyn.samples + diff * diff) / samples;

  return {
    emotion,
    mood,
    dynamics: { ...dyn, instability: clamp01(instability), lastValence: mood.valence, samples },
  };
}

/**
 * Coarse families used when granularity is low.
 *
 * A person in crisis does not experience "humiliation" as distinct from "shame"
 * as distinct from "grief" — they experience *bad*. Collapsing the label is how
 * that becomes visible in the prose rather than merely tracked in a number.
 */
const COARSE: Record<string, EmotionLabel[]> = {
  bad: ['anger', 'contempt', 'disgust', 'fear', 'horror', 'anxiety', 'sadness', 'grief',
    'shame', 'guilt', 'jealousy', 'humiliation', 'loneliness'],
  good: ['joy', 'affection', 'pride', 'relief', 'amusement', 'desire', 'awe',
    'trust', 'hope', 'gratitude', 'calm'],
  odd: ['surprise', 'confusion', 'neutral'],
};

const COARSE_WORDS: Record<string, string> = {
  bad: 'something bad they cannot name',
  good: 'something good they cannot name',
  odd: 'something they cannot place',
};

/**
 * Render a feeling at the resolution this character can actually perceive it.
 *
 * This is the payoff of tracking granularity: the *same* internal affect is
 * described as "a cold, specific shame about having begged" by an articulate
 * character and "she feels bad and could not tell you why" by one whose capacity
 * to differentiate has collapsed under load.
 */
export function describeFeeling(affect: Affect, granularity: number): string {
  if (granularity > 0.62) {
    const intensity = affect.arousal > 0.75 ? 'overwhelming ' : affect.arousal < 0.25 ? 'faint ' : '';
    return `${intensity}${affect.label}`;
  }
  if (granularity > 0.35) {
    // Middle band: they can locate it in the body, not name it precisely.
    const family = familyOf(affect.label);
    const somatic = affect.arousal > 0.6 ? 'keyed-up' : affect.arousal < 0.3 ? 'heavy' : 'unsettled';
    return `${somatic}, ${family === 'bad' ? 'wrong' : family === 'good' ? 'warm' : 'strange'} — close to ${affect.label}, though they would not put it that way`;
  }
  return COARSE_WORDS[familyOf(affect.label)];
}

export function familyOf(label: EmotionLabel): 'bad' | 'good' | 'odd' {
  if (COARSE.bad.includes(label)) return 'bad';
  if (COARSE.good.includes(label)) return 'good';
  return 'odd';
}

/**
 * Frijda-style action tendency: what this emotion wants the body to *do*.
 *
 * Included because emotion without an action tendency reads as weather rather
 * than as motive. Dominance decides the direction: the same fear is flight in a
 * powerless character and a cornered attack in one who still feels agency.
 */
export function actionTendency(affect: Affect): string {
  const strong = affect.arousal > 0.55;
  const powerful = affect.dominance > 0.15;
  switch (affect.label) {
    case 'anger': return powerful ? 'to go at whoever caused this' : 'to lash out from underneath';
    case 'fear': return powerful ? 'to get in front of it' : 'to get out, now';
    case 'horror': return 'to freeze, then to not look';
    case 'anxiety': return 'to check, and check again';
    case 'disgust': return 'to get away from it and be clean';
    case 'contempt': return 'to dismiss them and be seen doing it';
    case 'sadness': return 'to stop, and be left alone';
    case 'grief': return 'to hold on to what is gone';
    case 'shame': return 'to disappear, to not be looked at';
    case 'humiliation': return 'to erase what just happened, or to make them pay for it';
    case 'guilt': return 'to fix it, or to confess it';
    case 'loneliness': return 'to be near someone, without having to ask';
    case 'jealousy': return 'to guard what is theirs';
    case 'affection': return 'to close the distance';
    case 'desire': return 'to take, or to be taken';
    case 'pride': return 'to be witnessed';
    case 'gratitude': return 'to give something back';
    case 'hope': return 'to reach for it before it goes';
    case 'relief': return 'to sit down and breathe';
    case 'trust': return 'to let their guard down a notch';
    case 'joy': return 'to share it';
    case 'awe': return 'to stay still and keep looking';
    case 'amusement': return 'to laugh, possibly at the wrong moment';
    case 'calm': return 'nothing urgent';
    case 'surprise': return 'to work out what just happened';
    case 'confusion': return 'to ask, if they dare';
    default: return strong ? 'to act, though not clearly on what' : 'nothing pressing';
  }
}
