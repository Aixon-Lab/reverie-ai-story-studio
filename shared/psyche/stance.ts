/**
 * Stance (§N.2.3) — how accommodating this character is willing to be right now.
 *
 * The companion-AI literature is blunt about this: AI partners are excessively
 * agreeable because agreeableness drives engagement, and the sycophancy that
 * results both harms users and destroys believability. It is the single loudest
 * tell that there is nobody there. Real people withhold, disagree, get short,
 * change the subject, and occasionally refuse outright — and they do it as a
 * *function of their state and their history with you*, not at random.
 *
 * Everything needed to price that is already computed elsewhere in the psyche:
 * trust and resentment toward this person, expectancy, allostatic load, defense
 * maturity, current mood, and whether an intrusion just fired. This module spends
 * it. It adds no model calls and roughly forty tokens to the prompt.
 *
 * The output is deliberately a *permission*, not an instruction. "They are under
 * no obligation to be nice here" beats "be hostile", which produces a caricature.
 */
import { clamp01, clampSigned } from './defaults';
import { bodyCapacity } from './body';
import type { Affect, RelationModel } from '../brain/types';
import type { PsycheState } from './types';

export interface StanceInput {
  psyche: PsycheState;
  /** Relationship with whoever they are talking to. */
  relation?: RelationModel;
  /** What they are feeling right now. */
  felt: Affect;
  /** Did a trauma surface this turn. */
  intruded?: boolean;
  /** Is the other person asking for something. */
  askedFor?: boolean;
}

export interface Stance {
  /** 0 nothing offered … 1 fully forthcoming. */
  openness: number;
  /** 0 will not push back … 1 will contradict flatly. */
  friction: number;
  /** 0 endless … 1 out of patience entirely. */
  impatience: number;
  /** 0 answers plainly … 1 says as little as possible. */
  guardedness: number;
  /** The one line that goes in the prompt. */
  line: string;
  /** Why, for the inspector. */
  reasons: string[];
}

/**
 * Compute the stance.
 *
 * Note the asymmetries, which are the part that matters:
 * - warmth is *earned* (trust and affection), not granted by default
 * - depletion costs patience before it costs warmth — tired people get short
 *   before they get cold
 * - resentment produces friction specifically, not general coldness: someone you
 *   resent gets argued with, someone you fear gets nothing
 */
export function computeStance(input: StanceInput): Stance {
  const { psyche, relation, felt } = input;
  const reasons: string[] = [];

  const capacity = bodyCapacity(psyche.body);
  const load = psyche.load.level;
  const rel = relation;

  // --- openness: what they are willing to give -----------------------------
  let openness = 0.5;
  if (rel) {
    openness += 0.35 * Math.max(0, rel.trust) + 0.25 * Math.max(0, rel.affection);
    openness -= 0.3 * Math.max(0, -rel.trust) + 0.25 * Math.max(0, rel.fear);
    if (rel.trust > 0.4) reasons.push(`they trust ${rel.displayName}`);
    if (rel.trust < -0.3) reasons.push(`they do not trust ${rel.displayName}`);
  } else {
    // A stranger is not owed the character's inner life.
    openness -= 0.15;
    reasons.push('a stranger has not earned anything yet');
  }
  openness -= 0.3 * psyche.attachment.avoidance;
  openness -= 0.25 * clamp01(psyche.condition.depression.anhedonia);
  openness -= 0.2 * (1 - capacity);
  if (input.intruded) {
    openness -= 0.3;
    reasons.push('something just surfaced that they do not want to be looking at');
  }

  // --- friction: willingness to push back ----------------------------------
  let friction = 0.25;
  if (rel) {
    friction += 0.45 * Math.max(0, rel.resentment);
    // Fear suppresses friction even when resentment is high — that is what makes
    // a frightened character read as coiled rather than combative.
    friction -= 0.4 * Math.max(0, rel.fear);
    if (rel.resentment > 0.35 && rel.fear < 0.3) reasons.push(`they have something unsettled with ${rel.displayName}`);
  }
  friction += 0.3 * clamp01(psyche.dynamics.reactivity - 1);
  friction += 0.25 * clamp01(-felt.valence) * clamp01(felt.arousal);
  friction += 0.2 * Math.max(0, felt.dominance);
  friction -= 0.2 * psyche.attachment.anxiety;

  // --- impatience: depletion, not dislike ----------------------------------
  const impatience = clamp01(
    0.55 * load + 0.35 * (1 - capacity) + 0.2 * clamp01(psyche.load.sustainedScenes / 15),
  );
  if (impatience > 0.6) reasons.push('there is nothing left in the tank');

  // --- guardedness: what they will not say ---------------------------------
  const guardedness = clamp01(
    0.4 * psyche.condition.ptsd.avoidance
    + 0.3 * psyche.attachment.avoidance
    + 0.25 * clamp01(-(rel?.trust ?? 0))
    + 0.2 * psyche.condition.dissociation.acute,
  );

  const s: Stance = {
    openness: clamp01(openness),
    friction: clamp01(friction),
    impatience,
    guardedness,
    line: '',
    reasons,
  };
  s.line = describeStance(s, rel);
  return s;
}

/**
 * The prompt line.
 *
 * Written as permission and prohibition rather than as a mood label, because a
 * model given "she is irritable" writes irritability as a performance, while a
 * model told "she is under no obligation to make this easy" simply stops being
 * accommodating — which is what we actually want.
 */
function describeStance(s: Stance, rel?: RelationModel): string {
  const bits: string[] = [];
  const who = rel?.displayName ?? 'them';

  if (s.openness < 0.3) {
    bits.push(`they are not inclined to give ${who} much`);
  } else if (s.openness > 0.7) {
    bits.push(`they are genuinely open with ${who}`);
  }

  if (s.friction > 0.55) {
    bits.push('they will contradict, refuse, or say the unwelcome thing rather than smooth it over');
  } else if (s.friction > 0.35) {
    bits.push('they will push back if pushed');
  }

  if (s.impatience > 0.6) bits.push('they have no patience for anything that is not immediate');
  if (s.guardedness > 0.6) bits.push('answers come short, and some do not come at all');

  const core = bits.length
    ? bits.join('; ')
    : 'they are behaving normally toward whoever is in front of them';

  // The universal clause. This is the anti-sycophancy instruction proper, and it
  // is stated for every character in every state — because the failure mode is
  // not "sometimes too nice", it is a constant pull toward agreement.
  return `${core}. They are under no obligation to be agreeable, helpful, or `
    + 'reassuring. Do not have them validate, apologise, or offer comfort unless '
    + 'their state and their history with this person actually warrant it.';
}

/**
 * Does the state warrant refusing outright?
 *
 * Separate from the prose because a hard refusal is a *behaviour*, and the caller
 * may want to know before composing anything. Deliberately conservative: a
 * character who refuses constantly is as unreal as one who never does.
 */
export function wouldRefuse(stance: Stance, request: { intimate?: boolean; costly?: boolean }): boolean {
  const bar = request.intimate ? 0.45 : request.costly ? 0.6 : 0.8;
  return stance.openness < 0.25 && (stance.guardedness > bar || stance.friction > bar);
}

/** Signed summary for the Mind page: −1 hostile … +1 warm. */
export function stanceValence(s: Stance): number {
  return clampSigned(s.openness - 0.6 * s.friction - 0.3 * s.impatience);
}
