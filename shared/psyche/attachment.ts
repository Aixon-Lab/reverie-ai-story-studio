/**
 * Attachment-grade relationships (§P.6.1).
 *
 * v1's `RelationModel` had trust, affection, fear, respect, resentment, debt.
 * Those are *feelings about* a person. What was missing is the part that makes
 * relationships drive a story:
 *
 * - **expectancy** — what they predict this person will do. Without a stored
 *   prediction there is no prediction *error*, and betrayal is merely a bad event
 *   rather than a shock that reorganises someone.
 * - **attachment anxiety / avoidance** — the two-dimensional adult attachment
 *   representation, held per-relationship and regressing toward a global working
 *   model, so a character can be secure with one person and not with another.
 * - **rupture and repair** — with a hard asymmetry. Trust falls in one moment and
 *   returns over many, and only through evidence that actually disconfirms.
 * - **transference** — a new person who matches an old relational schema inherits
 *   its priors, which is why people keep meeting the same person.
 *
 * Working models are trait-like but revisable by experiences that sharply
 * contradict them; a secure relationship can act as a corrective emotional
 * experience. That is the mechanism for earned security, and it is implemented
 * here as a slow, evidence-gated update rather than as a switch.
 */
import { clamp01, clampSigned, lerp } from './defaults';
import { similarity } from '../brain/activation';
import type { RelationModel } from '../brain/types';
import type { PsycheState } from './types';

/**
 * The relational fields the psyche adds. Stored on `RelationModel` itself rather
 * than in a parallel map, because splitting one person across two objects is how
 * they drift out of sync.
 */
export interface BondFields {
  /** -1 certain they will hurt me … +1 certain they will not. */
  expectancy: number;
  /** 0..1 how much this character needs them — the betrayal multiplier. */
  dependency: number;
  /** Per-relationship attachment, regressing toward the global working model. */
  attachAnxiety: number;
  attachAvoidance: number;
  /** Count of trust-breaking and trust-rebuilding events. */
  ruptures: number;
  repairs: number;
  /** Consecutive interactions that disconfirmed the negative prior. */
  disconfirming: number;
  /** Key of the older relationship whose priors this one inherited. */
  transferredFrom?: string;
}

export type Bond = RelationModel & Partial<BondFields>;

/** Fill in the psyche's fields for a relation that predates this layer. */
export function ensureBond(rel: Bond, psyche: PsycheState): Required<BondFields> {
  return {
    expectancy: rel.expectancy ?? clampSigned(rel.trust * 0.8),
    dependency: rel.dependency ?? clamp01(
      0.4 * Math.max(0, rel.affection) + 0.3 * rel.familiarity
      + 0.2 * Math.max(0, rel.fear) + 0.1 * clamp01(Math.abs(rel.debt)),
    ),
    attachAnxiety: rel.attachAnxiety ?? psyche.attachment.anxiety,
    attachAvoidance: rel.attachAvoidance ?? psyche.attachment.avoidance,
    ruptures: rel.ruptures ?? 0,
    repairs: rel.repairs ?? 0,
    disconfirming: rel.disconfirming ?? 0,
    transferredFrom: rel.transferredFrom ?? '',
  };
}

export interface Interaction {
  /** How the other person actually behaved, -1 harmful … +1 caring. */
  behaviour: number;
  /** Did this touch something that mattered. */
  stakes: number;
  /** Was a commitment kept or broken. */
  promise?: 'kept' | 'broken';
  now: number;
}

export interface BondUpdate {
  bond: Bond;
  /** |expected − actual|, 0..1. The shock, not the harm. */
  predictionError: number;
  /** A trust-breaking event large enough to count. */
  rupture: boolean;
  /** Evidence that disconfirmed a negative prior. */
  repair: boolean;
  /** One line for the audit log. */
  note: string;
}

/**
 * Update a relationship from one interaction.
 *
 * The asymmetry is the whole point and is applied in three places at once: trust
 * falls faster than it rises, expectancy updates faster downward than upward, and
 * repair requires *repetition* where rupture requires only one event. That is not
 * pessimism — it is what makes a rebuilt relationship feel earned instead of
 * reset.
 */
export function updateBond(
  rel: Bond,
  psyche: PsycheState,
  ev: Interaction,
): BondUpdate {
  const b = ensureBond(rel, psyche);
  const stakes = clamp01(ev.stakes);
  const behaviour = clampSigned(ev.behaviour);

  // The shock is the gap between what was expected and what happened, scaled by
  // how much was riding on it.
  const predictionError = clamp01(Math.abs(b.expectancy - behaviour) / 2 * (0.4 + 0.6 * stakes));

  const harmful = behaviour < -0.3;
  const caring = behaviour > 0.3;
  const brokePromise = ev.promise === 'broken';
  const keptPromise = ev.promise === 'kept';

  // A rupture needs harm *and* surprise: being let down by someone you already
  // expected to let you down is disappointing, not shattering.
  const rupture = (harmful || brokePromise)
    && predictionError > 0.25
    && stakes > 0.35;
  // Repair is the mirror, and additionally requires that there was something to
  // repair — kindness from someone you already trust is pleasant, not corrective.
  const repair = (caring || keptPromise)
    && b.expectancy < 0.1
    && stakes > 0.25;

  /**
   * The shock scales the damage.
   *
   * Prediction error is not merely reported — it is the multiplier. Being hurt by
   * someone you had already written off costs far less than the same act from
   * someone you would have vouched for, and that difference is the entire reason
   * expectancy is stored at all.
   */
  const trustFall = rupture
    ? 0.55 * (0.5 + 0.5 * stakes) * (1 + b.dependency) * (0.7 + 0.6 * predictionError)
    : harmful ? 0.12 : 0;
  const trustRise = repair ? 0.09 * (0.5 + 0.5 * stakes) : caring ? 0.03 : 0;

  const next: Bond = {
    ...rel,
    trust: clampSigned(rel.trust - trustFall + trustRise),
    affection: clampSigned(
      // Betrayal by someone loved does not delete the love. That is what makes it
      // unbearable, and it is why "just leave" is not a mechanism.
      rel.affection + (caring ? 0.06 * stakes : 0) - (rupture ? 0.15 * stakes : 0),
    ),
    fear: clampSigned(rel.fear + (rupture ? 0.35 * stakes : 0) - (repair ? 0.06 : 0.01)),
    resentment: clampSigned(rel.resentment + (rupture ? 0.4 * stakes : 0) - (repair ? 0.08 : 0.01)),
    respect: clampSigned(rel.respect + (keptPromise ? 0.08 : 0) - (brokePromise ? 0.2 : 0)),
    interactions: rel.interactions + 1,
    lastSeenAt: ev.now,
    familiarity: clamp01(rel.familiarity + 0.02),

    // Expectancy tracks behaviour, and learns danger faster than safety.
    expectancy: clampSigned(
      behaviour < b.expectancy
        ? lerp(b.expectancy, behaviour, 0.55)
        : lerp(b.expectancy, behaviour, 0.12),
    ),
    dependency: b.dependency,
    ruptures: b.ruptures + (rupture ? 1 : 0),
    repairs: b.repairs + (repair ? 1 : 0),
    // Consecutive: one bad interaction resets the count, which is exactly how
    // trust-rebuilding actually fails.
    disconfirming: repair ? b.disconfirming + 1 : harmful ? 0 : b.disconfirming,
    transferredFrom: b.transferredFrom || undefined,

    // Attachment moves slowly, and only on repeated evidence.
    attachAnxiety: clamp01(
      b.attachAnxiety + (rupture ? 0.08 * stakes : 0) - (b.disconfirming >= 3 ? 0.03 : 0),
    ),
    attachAvoidance: clamp01(
      b.attachAvoidance + (rupture ? 0.1 * stakes : 0) - (b.disconfirming >= 3 ? 0.04 : 0),
    ),
  };

  const note = rupture
    ? `${rel.displayName} did something ${(next.expectancy ?? 0) < b.expectancy ? 'they were not expected to' : 'that confirmed the worst'} — trust fell hard`
    : repair
      ? `${rel.displayName} disconfirmed the expectation (${next.disconfirming} in a row)`
      : `${rel.displayName}: nothing that changed the model`;

  return { bond: next, predictionError, rupture, repair, note };
}

/**
 * Fold per-relationship attachment back into the global working model.
 *
 * The global model is the average of lived relationships weighted by how much
 * each mattered — so one securely-attached friendship does not undo a lifetime,
 * but a sustained one genuinely moves the baseline. This is earned security, and
 * it is deliberately slow.
 */
export function updateWorkingModel(
  psyche: PsycheState,
  bonds: Bond[],
  rate = 0.05,
): { anxiety: number; avoidance: number } {
  const rated = bonds.filter((b) => b.interactions > 3);
  if (!rated.length) return psyche.attachment;

  let wSum = 0;
  let anx = 0;
  let avo = 0;
  for (const b of rated) {
    const f = ensureBond(b, psyche);
    // Weight by how much this person actually matters to them.
    const w = 0.4 * f.dependency + 0.3 * b.familiarity + 0.3 * Math.abs(b.affection);
    wSum += w;
    anx += w * f.attachAnxiety;
    avo += w * f.attachAvoidance;
  }
  if (wSum <= 0) return psyche.attachment;

  return {
    anxiety: clamp01(lerp(psyche.attachment.anxiety, anx / wSum, rate)),
    avoidance: clamp01(lerp(psyche.attachment.avoidance, avo / wSum, rate)),
  };
}

/**
 * Seed a new relationship from the closest old one (§P.6.1, transference).
 *
 * People meet a stranger and treat them like someone else. The match is on the
 * *working model text* — how this character describes people — which is the
 * closest thing the graph has to "the kind of person you are".
 *
 * The character only knows they are doing it if granularity is high; otherwise
 * the prior is simply how the stranger seems to them.
 */
export function transferPriors(
  fresh: Bond,
  existing: Bond[],
  psyche: PsycheState,
  descriptionOfNew: string,
): { bond: Bond; matched?: Bond; aware: boolean } {
  const candidates = existing.filter((b) => b.interactions > 5 && b.model.trim() && b.key !== fresh.key);
  if (!candidates.length || !descriptionOfNew.trim()) return { bond: fresh, aware: false };

  let best: Bond | undefined;
  let bestScore = 0;
  for (const c of candidates) {
    const s = similarity(descriptionOfNew, c.model);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (!best || bestScore < 0.35) return { bond: fresh, aware: false };

  const f = ensureBond(best, psyche);
  // A prior, not a copy: the stranger starts partway toward how the old person
  // ended up, and can still disconfirm it.
  const pull = 0.5 * bestScore;
  return {
    bond: {
      ...fresh,
      trust: clampSigned(lerp(fresh.trust, best.trust, pull)),
      expectancy: clampSigned(lerp(fresh.expectancy ?? 0, f.expectancy, pull)),
      fear: clampSigned(lerp(fresh.fear, best.fear, pull * 0.7)),
      attachAnxiety: clamp01(lerp(f.attachAnxiety, f.attachAnxiety, pull)),
      attachAvoidance: clamp01(lerp(psyche.attachment.avoidance, f.attachAvoidance, pull)),
      transferredFrom: best.key,
    },
    matched: best,
    aware: psyche.dynamics.granularity > 0.6,
  };
}

/** One line about a bond, for the prompt's EXPECT section and the Mind page. */
export function describeBond(rel: Bond, psyche: PsycheState): string {
  const b = ensureBond(rel, psyche);
  const name = rel.displayName;

  if (b.ruptures > 0 && b.disconfirming >= 3) {
    return `${name} broke something and has been steadily proving it will not happen again — they are most of the way to believing it`;
  }
  if (b.ruptures > 0) {
    return b.dependency > 0.5
      ? `${name} hurt them and they still need them, which is its own kind of unbearable`
      : `${name} hurt them, and they are waiting to see it happen again`;
  }
  if (b.transferredFrom) {
    return `${name} reminds them of someone, and they are treating them accordingly`;
  }
  if (b.expectancy > 0.4) return `${name} has been reliable, and is expected to stay that way`;
  if (b.expectancy < -0.4) return `${name} is expected to let them down`;
  return `${name} is still an open question`;
}

/** Is this bond one the character would reach for under stress? */
export function isSupportive(rel: Bond, psyche: PsycheState): boolean {
  const b = ensureBond(rel, psyche);
  return rel.trust > 0.3 && rel.affection > 0.25 && b.expectancy > 0.1 && rel.fear < 0.3;
}
