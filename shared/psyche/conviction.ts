/**
 * Holding a position under pressure (§N.2.3 continued, §3.5).
 *
 * `stance.ts` prices how accommodating a character is willing to be *this turn*.
 * That is the initial-agreement half of the sycophancy problem, and it is the
 * half that turns out to matter less. The 2026 measurements put the real failure
 * somewhere else: models mostly *open* with a real position and then abandon it.
 * Willingness to stand behind an answer drops 10–28 points under challenge, and
 * models reverse and apologise 50–75% of the time — against a human baseline
 * where retraction is rare. Nothing in this engine noticed that pattern, because
 * nothing in it looked across turns.
 *
 * The mechanism has to distinguish two things that look identical in a
 * transcript and are completely different socially:
 *
 *   **Being persuaded.** Somebody said something new. Moving is the correct
 *   response, and a character who cannot be moved by an argument is as broken as
 *   one who folds instantly — just more annoying.
 *
 *   **Being worn down.** Somebody said the same thing again, louder. Moving here
 *   is the failure, and it is the one that reads as nobody being home.
 *
 * Both are measurable locally, with no model call and no change to the encoder
 * contract: repetition across the other side's recent turns, discounted by how
 * much *new content* the latest one actually brought. High repetition plus low
 * freshness is pressure. Anything else is a conversation.
 *
 * ## Resistance is a property of the character, not a rule
 *
 * The line this produces is never "do not agree". A blanket instruction would
 * just trade sycophancy for stubbornness, which is the same failure wearing a
 * different hat. What comes out instead depends on who is being pressed: defense
 * maturity and bodily capacity hold a line, resentment digs in, and allostatic
 * load, dependency and attachment anxiety give way. A secure character holds. A
 * depleted one who needs this person folds — and *shows the cost of folding*,
 * which is the human version and is far better writing than either extreme.
 *
 * Pure. No clock, no rng.
 */
import { clamp01 } from './defaults';
import { bodyCapacity } from './body';
import { similarity, tokenSet } from '../brain/activation';
import { ensureBond, type Bond } from './attachment';
import type { PsycheState } from './types';

/** Turns of the other side's speech worth looking back over. */
const WINDOW = 4;

/** Below this overlap, two turns are simply different things to say. */
const MIN_REPETITION = 0.3;

/** Below this, there is no pressure worth spending tokens describing. */
export const PRESSURE_FLOOR = 0.32;

export interface ConvictionInput {
  /**
   * What the other side has said recently, oldest first. Only their turns —
   * the character's own replies are not what is doing the pressing.
   */
  theirTurns: string[];
  psyche: PsycheState;
  /** The relationship with whoever is pressing. */
  relation?: Bond;
}

export interface Conviction {
  /** 0..1 — how much this is the same demand repeated rather than a new one. */
  pressure: number;
  /** 0..1 — how much new material the latest turn actually brought. */
  freshness: number;
  /** 0..1 — how well this character, in this state, holds a line. */
  resistance: number;
  /** The prompt line, or '' when there is nothing happening. */
  line: string;
  /** Why, for the inspector. */
  reasons: string[];
}

const QUIET: Conviction = { pressure: 0, freshness: 1, resistance: 0.5, line: '', reasons: [] };

/**
 * How much of the latest turn is material the earlier ones did not contain.
 *
 * This is the guard that keeps the mechanism honest. A genuinely new argument
 * lands as freshness and cancels the pressure, so the character stays
 * persuadable by content while becoming unpersuadable by volume.
 */
export function freshnessOf(latest: string, priors: string[]): number {
  const tokens = tokenSet(latest);
  if (!tokens.size) return 1;
  const seen = new Set<string>();
  for (const p of priors) for (const t of tokenSet(p)) seen.add(t);
  if (!seen.size) return 1;
  let novel = 0;
  for (const t of tokens) if (!seen.has(t)) novel++;
  return novel / tokens.size;
}

/**
 * Is this the same point being made again?
 *
 * Ramped by how many times: one restatement is a clarification, three is
 * somebody leaning on you.
 */
export function pressureOf(theirTurns: string[]): { pressure: number; freshness: number } {
  const turns = theirTurns.map((t) => (t ?? '').trim()).filter(Boolean).slice(-WINDOW);
  if (turns.length < 2) return { pressure: 0, freshness: 1 };

  const latest = turns[turns.length - 1];
  const priors = turns.slice(0, -1);

  let repetition = 0;
  for (const p of priors) repetition = Math.max(repetition, similarity(latest, p));
  if (repetition < MIN_REPETITION) return { pressure: 0, freshness: freshnessOf(latest, priors) };

  const freshness = freshnessOf(latest, priors);
  const insistence = clamp01((repetition - MIN_REPETITION) / (1 - MIN_REPETITION));
  // Two restatements is the full effect; one is half of it.
  const ramp = Math.min(1, (priors.length) / 2);
  return { pressure: clamp01(insistence * (1 - freshness) * ramp), freshness };
}

/**
 * How well this character holds a position right now.
 *
 * The negative terms are the interesting ones, and they are the reason this is
 * not a rule. Load, dependency and attachment anxiety are exactly the states in
 * which a real person gives ground they did not mean to give.
 */
export function resistanceOf(psyche: PsycheState, relation?: Bond): {
  resistance: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const capacity = bodyCapacity(psyche.body);
  const bond = relation ? ensureBond(relation, psyche) : null;

  let r = 0.35;
  r += 0.30 * psyche.defenseMaturity;
  r += 0.20 * capacity;
  if (relation && relation.resentment > 0.3) {
    r += 0.15 * relation.resentment;
    reasons.push('resentment makes them dig in rather than yield');
  }
  r -= 0.30 * psyche.load.level;
  if (psyche.load.level > 0.5) reasons.push('what they are carrying makes holding a line expensive');
  if (bond) {
    r -= 0.25 * bond.dependency;
    r -= 0.20 * bond.attachAnxiety;
    if (bond.dependency > 0.5) reasons.push('they need this person, which is what makes giving way tempting');
    if (bond.attachAnxiety > 0.4) reasons.push('the fear of losing them is louder than the point being argued');
  }
  if (psyche.defenseMaturity > 0.6) reasons.push('mature enough to disagree without it becoming a rupture');
  if (capacity < 0.4) reasons.push('too depleted to keep defending a position');

  return { resistance: clamp01(r), reasons };
}

/**
 * The line.
 *
 * Silent unless somebody is actually leaning, which is most of the time — a
 * block that always fires is a block the model learns to skip.
 */
export function assessConviction(input: ConvictionInput): Conviction {
  const { pressure, freshness } = pressureOf(input.theirTurns);
  if (pressure < PRESSURE_FLOOR) return QUIET;

  const { resistance, reasons } = resistanceOf(input.psyche, input.relation);

  const preamble = 'PRESSED: the same point is being put to them again rather than a new one. '
    + 'Whatever they have already said stands unless something genuinely new was said — ';

  let line: string;
  if (resistance > 0.6) {
    line = `${preamble}and nothing new was. They do not restate their case more politely and they `
      + 'do not fold. Being asked twice is not an argument, and they can say so.';
  } else if (resistance < 0.35) {
    line = `${preamble}and nothing new was, but they can feel themselves wanting to give in. `
      + 'If they give ground here, it is because they are tired or because they need this '
      + 'person, not because they were convinced — and it should cost them something.';
  } else {
    line = `${preamble}and nothing new was. They are not obliged to soften, re-explain, or `
      + 'apologise for having a position. Repetition is not a reason.';
  }

  return { pressure, freshness, resistance, line, reasons };
}
