/**
 * Regulation, coping and defense (§P.4).
 *
 * This is the layer v1 had none of, and it is where the character arc actually
 * happens — because **every move trades relief now against cost later**.
 *
 * Gross's process model orders strategies by where they intervene in the emotion
 * cycle; antecedent-focused moves (reappraisal) are effective now *and* healthy
 * later, while response-focused ones (suppression) and rumination buy relief now
 * and amplify distress over time. Vaillant's hierarchy supplies the second axis:
 * which moves a person can even reach depends on their defensive maturity, which
 * regresses under load and matures slowly with use.
 *
 * The consequence: stress makes people worse at handling stress, and getting
 * better is something a character has to be *given the conditions* to do.
 */
import { clamp, clamp01, clampSigned } from './defaults';
import { bodyCapacity } from './body';
import type { Affect } from '../brain/types';
import type {
  DefenseLevel, ExpressedAffect, PsycheState, RegulationChoice, RegulationMove,
} from './types';

interface MoveSpec {
  /** 0..1 how much felt intensity it removes now. */
  relief: number;
  /** How much it hides from the outside. */
  opacity: number;
  /** Signed load consequence per use. */
  loadDelta: number;
  /** Minimum defense maturity required to reach for it at all. */
  needs: number;
  /**
   * Gerund phrase, because the composer renders it as "they are {description}".
   * A finite verb here produced "they are goes somewhere else" in the prompt.
   */
  description: string;
}

/**
 * The move set. `relief` and `loadDelta` encode the central trade: the moves that
 * feel best in the moment (`avoid`, `dissociate`, `suppress`) are the ones that
 * cost the most afterwards, and the healthiest ones (`reappraise`,
 * `seek_support`) give the least immediate relief.
 */
const MOVES: Record<Exclude<RegulationMove, 'none'>, MoveSpec> = {
  reappraise: {
    relief: 0.45, opacity: 0.15, loadDelta: -0.04, needs: 0.55,
    description: 'reframing what it means before it takes hold',
  },
  seek_support: {
    relief: 0.5, opacity: 0.1, loadDelta: -0.09, needs: 0.5,
    description: 'reaching for someone instead of carrying it alone',
  },
  confront: {
    relief: 0.2, opacity: 0.05, loadDelta: -0.01, needs: 0.45,
    description: 'saying the thing out loud rather than swallowing it',
  },
  ruminate_deliberate: {
    relief: 0, opacity: 0.3, loadDelta: 0.01, needs: 0.6,
    description: 'working at it deliberately, trying to make it mean something',
  },
  distract: {
    relief: 0.4, opacity: 0.45, loadDelta: 0.005, needs: 0.2,
    description: 'putting their attention somewhere else',
  },
  suppress: {
    relief: 0.25, opacity: 0.85, loadDelta: 0.045, needs: 0.25,
    description: 'feeling all of it and showing none of it',
  },
  ruminate_brood: {
    relief: -0.1, opacity: 0.5, loadDelta: 0.05, needs: 0.15,
    description: 'circling the same wound without getting anywhere near the bottom of it',
  },
  avoid: {
    relief: 0.7, opacity: 0.6, loadDelta: 0.035, needs: 0,
    description: 'steering hard away from it',
  },
  dissociate: {
    relief: 0.95, opacity: 0.9, loadDelta: 0.02, needs: 0,
    description: 'going somewhere else and leaving the body behind',
  },
};

/**
 * Vaillant band per move — the single authority, kept out of the spec table so
 * the four-tier union stays honest (there is no "neutral" tier; `distract` sits
 * at the neurotic level because habitual distraction blocks integration).
 */
const LEVEL_OF: Record<Exclude<RegulationMove, 'none'>, DefenseLevel> = {
  reappraise: 'mature', seek_support: 'mature', confront: 'mature',
  ruminate_deliberate: 'mature', distract: 'neurotic', suppress: 'neurotic',
  ruminate_brood: 'neurotic', avoid: 'immature', dissociate: 'immature',
};

/**
 * Effective defense maturity right now.
 *
 * The same person acts out at 3am under load that they would have handled at
 * noon. Regression is acute and recoverable; the underlying baseline moves only
 * through repeated experience.
 */
export function effectiveMaturity(psyche: PsycheState, regressionCap: number): number {
  const strain = 0.6 * psyche.load.level + 0.4 * (1 - bodyCapacity(psyche.body));
  const acute = regressionCap * strain
    + 0.3 * psyche.condition.dissociation.acute;
  return clamp01(psyche.defenseMaturity - acute);
}

export interface RegulationContext {
  /** The emotion actually felt, pre-regulation. */
  felt: Affect;
  /** Is there someone here they could actually reach for. */
  supportAvailable: boolean;
  /** Is it safe to show what they feel. */
  safeToExpress: boolean;
  /** Is this an intrusion from a trauma rather than a fresh event. */
  fromIntrusion?: boolean;
  /** Deterministic tie-break in tests; omit for the natural ranking. */
  jitter?: number;
}

/**
 * Choose how this character handles what they are feeling.
 *
 * Not a random draw and not a fixed rule: a ranking over what is *reachable*
 * (maturity), what is *available* (is anyone there, is it safe to speak), and
 * what the state is screaming for (intensity, load). Low-intensity feeling gets
 * no regulation at all, which matters — a system that always "copes" reads as
 * neurotic rather than as human.
 */
export function chooseRegulation(
  psyche: PsycheState,
  ctx: RegulationContext,
  regressionCap: number,
): RegulationChoice {
  const intensity = clamp01(
    0.6 * ctx.felt.arousal + 0.4 * Math.abs(ctx.felt.valence),
  );
  const maturity = effectiveMaturity(psyche, regressionCap);

  // Mild feeling is simply had. Regulation is for what exceeds the person.
  if (intensity < 0.32 && !ctx.fromIntrusion) {
    return {
      move: 'none', level: 'mature', relief: 0, loadDelta: 0,
      description: 'letting themselves feel it without doing anything about it',
      rationale: 'not intense enough to need managing',
      alternatives: [],
    };
  }

  const need = intensity * (0.7 + 0.6 * psyche.load.level);
  const scored: { move: Exclude<RegulationMove, 'none'>; score: number }[] = [];

  for (const key of Object.keys(MOVES) as (keyof typeof MOVES)[]) {
    const spec = MOVES[key];
    if (maturity < spec.needs) continue;
    if (key === 'seek_support' && !ctx.supportAvailable) continue;
    if (key === 'confront' && !ctx.safeToExpress) continue;

    // Desirability now, minus a long-run penalty this character can only apply if
    // they are mature enough to see past the next thirty seconds.
    const immediate = spec.relief * need;
    const foresight = maturity * Math.max(0, spec.loadDelta) * 6;
    // Habit: people repeat what they have done before, which is how a coping style
    // becomes a personality rather than a per-scene coin flip.
    const habit = 0.12 * recentUse(psyche, key);
    // Attachment shapes reaching for people versus shutting them out.
    const relational = key === 'seek_support'
      ? -0.5 * psyche.attachment.avoidance + 0.2 * psyche.attachment.anxiety
      : key === 'avoid' || key === 'dissociate'
        ? 0.25 * psyche.attachment.avoidance
        : 0;
    // Dissociation is not chosen so much as triggered: it needs overwhelm.
    const gate = key === 'dissociate'
      ? (intensity > 0.8 && ctx.felt.dominance < -0.3 ? 0.5 : -1.5)
      : 0;

    /**
     * Vaillant's hierarchy as a live force rather than a label.
     *
     * Without this, the cheapest defenses win every ranking on raw relief and a
     * mature, supported character dissociates exactly like a broken one — which
     * would make defensive maturity decorative. A developed person does not
     * merely *have* better options, they find the primitive ones distasteful,
     * and that distaste is what regression under load takes away.
     */
    const levelPenalty = LEVEL_OF[key] === 'immature'
      ? 1.2 * maturity
      : LEVEL_OF[key] === 'neurotic'
        ? 0.45 * maturity
        : 0;

    scored.push({
      move: key,
      score: immediate - foresight - levelPenalty + habit + relational + gate
        + (ctx.jitter ?? 0) * hash(key),
    });
  }

  if (!scored.length) {
    return {
      move: 'avoid', level: 'immature', relief: MOVES.avoid.relief, loadDelta: MOVES.avoid.loadDelta,
      description: MOVES.avoid.description,
      rationale: 'nothing else was reachable in this state',
      alternatives: [],
    };
  }

  scored.sort((x, y) => y.score - x.score);
  const winner = scored[0];
  const spec = MOVES[winner.move];

  return {
    move: winner.move,
    level: LEVEL_OF[winner.move],
    relief: spec.relief,
    loadDelta: spec.loadDelta,
    description: spec.description,
    rationale: explain(winner.move, psyche, maturity, ctx),
    alternatives: scored.slice(1, 4).map((s) => s.move),
  };
}

function explain(
  move: RegulationMove,
  psyche: PsycheState,
  maturity: number,
  ctx: RegulationContext,
): string {
  switch (move) {
    case 'dissociate':
      return 'it exceeded what they could stay present for';
    case 'avoid':
      return maturity < 0.3
        ? 'in this state, getting away from it is the only move they have'
        : 'the cheapest relief available, and they took it';
    case 'suppress':
      return ctx.safeToExpress
        ? 'they could have shown it and chose not to'
        : 'it is not safe to show this here';
    case 'seek_support':
      return 'there was someone to reach for, and they were able to reach';
    case 'reappraise':
      return 'they have enough left to think about it differently';
    case 'ruminate_brood':
      return 'they cannot leave it alone and cannot resolve it either';
    case 'ruminate_deliberate':
      return 'they are working at what it means on purpose';
    case 'confront':
      return 'they would rather have it out than carry it';
    default:
      return 'attention went elsewhere';
  }
}

/** How often this move appears in the recent coping record, 0..1. */
function recentUse(psyche: PsycheState, move: RegulationMove): number {
  const recent = psyche.copingHistory.slice(-20);
  if (!recent.length) return 0;
  return recent.filter((c) => c.move === move).length / recent.length;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Split the felt emotion into what is felt and what is shown.
 *
 * The gap is the characterisation. A face that stays level while the hands shake
 * reads as a person; a character whose every feeling is visible reads as a mood
 * ring. `leak` is the tell that gets past the control, and it is deliberately
 * *somatic* — bodies are bad liars.
 */
export function express(felt: Affect, choice: RegulationChoice, granularity: number): ExpressedAffect {
  const spec = choice.move === 'none' ? null : MOVES[choice.move as keyof typeof MOVES];
  const opacity = clamp01(spec?.opacity ?? 0);
  const damp = 1 - opacity;

  const shown: Affect = {
    valence: clampSigned(felt.valence * damp),
    arousal: clamp01(felt.arousal * (choice.move === 'dissociate' ? 0.15 : damp)),
    dominance: clampSigned(
      // Suppression reads as *more* controlled than they are, which is the point.
      choice.move === 'suppress' ? Math.max(felt.dominance, 0.2) : felt.dominance * damp,
    ),
    label: opacity > 0.6 ? 'neutral' : felt.label,
  };

  return {
    felt,
    shown,
    opacity,
    leak: opacity > 0.45 ? leakFor(felt, choice.move) : undefined,
  };
}

function leakFor(felt: Affect, move: RegulationMove): string {
  if (move === 'dissociate') return 'a flatness in the eyes, answers arriving a beat late';
  if (felt.arousal > 0.7) {
    return felt.valence < 0
      ? 'a tightness in the jaw, hands that will not stay still'
      : 'a brightness they are trying to keep off their face';
  }
  if (felt.valence < -0.5) return 'a long pause in the wrong place, a voice pitched too level';
  return 'something held very deliberately still';
}

/**
 * Apply the consequences of a regulation choice to the psyche.
 *
 * Separate from `chooseRegulation` so the caller can decide (or override) the
 * move before paying for it — and so the cost is applied exactly once.
 */
export function applyRegulation(
  psyche: PsycheState,
  choice: RegulationChoice,
  now: number,
  maturityGain: number,
): PsycheState {
  const history = [...psyche.copingHistory, { at: now, move: choice.move, level: choice.level }].slice(-60);

  // Maturity is earned by using a mature move and surviving it, and is eroded —
  // more slowly — by living on the immature ones.
  let defenseMaturity = psyche.defenseMaturity;
  if (choice.level === 'mature' && choice.move !== 'none') {
    defenseMaturity = clamp01(defenseMaturity + maturityGain);
  } else if (choice.level === 'immature') {
    defenseMaturity = clamp01(defenseMaturity - maturityGain * 0.5);
  }

  // Reaching for someone, and it working, is how avoidance loosens.
  const attachment = choice.move === 'seek_support'
    ? {
      anxiety: clamp01(psyche.attachment.anxiety - 0.015),
      avoidance: clamp01(psyche.attachment.avoidance - 0.025),
    }
    : choice.move === 'avoid' || choice.move === 'dissociate'
      ? { ...psyche.attachment, avoidance: clamp01(psyche.attachment.avoidance + 0.008) }
      : psyche.attachment;

  return {
    ...psyche,
    load: { ...psyche.load, level: clamp01(psyche.load.level + choice.loadDelta) },
    defenseMaturity,
    attachment,
    copingHistory: history,
    updatedAt: now,
  };
}

/** Coping style summary for the Mind page: what they habitually do. */
export function describeCopingStyle(psyche: PsycheState): string {
  const recent = psyche.copingHistory.slice(-24);
  if (recent.length < 4) return 'not enough history to say';
  const counts = new Map<RegulationMove, number>();
  for (const c of recent) counts.set(c.move, (counts.get(c.move) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const words: Partial<Record<RegulationMove, string>> = {
    avoid: 'avoidance', dissociate: 'going absent', suppress: 'holding it in',
    ruminate_brood: 'brooding', ruminate_deliberate: 'working it through',
    reappraise: 'reframing', seek_support: 'reaching for people',
    confront: 'confrontation', distract: 'distraction', none: 'simply feeling it',
  };
  return top.map(([m]) => words[m] ?? m).join(', then ');
}

export const REGULATION_SPECS = MOVES;
