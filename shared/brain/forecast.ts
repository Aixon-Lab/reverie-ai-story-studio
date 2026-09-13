/**
 * Prediction error — surprise that is measured rather than reported.
 *
 * The engine has had a `novelty` field since the beginning and it has always
 * been a number the encoder model *asserted*. That is not surprise. Surprise is
 * the gap between what you expected and what happened, and without a stored
 * expectation there is nothing to take a gap from — only an adjective the model
 * chose after the fact, which is exactly the thing an LLM is worst at
 * calibrating.
 *
 * So the character commits, before the turn, to a small and entirely structural
 * prediction, and the consolidation pass scores it. Nothing is generated: both
 * halves are read off state the engine already maintains.
 *
 *   **stance** — how they expect this person to act toward them next. Comes from
 *   the attachment layer's `expectancy`, which is already the one real stored
 *   prediction in the system, tempered by trust and fear.
 *
 *   **progress** — whether they expect their own objective to advance. Comes
 *   from the intention's urgency against what the body has left.
 *
 * Both are continuous and signed, and both are scored against quantities the
 * appraisal already produces (`appraisal.intent`, and `scoreIntention`'s
 * progress). That is the point of choosing them: a categorical forecast would
 * need a matcher, and a matcher is where this kind of mechanism goes wrong.
 *
 * ## What the error is spent on
 *
 * Deliberately narrow. Surprise lifts the **novelty** of the events that caused
 * it, which is the encoding gate every serious memory model puts it at — a
 * violated expectation is the definition of something worth keeping. It does
 * *not* touch relationships or traits: `attachment.ts` already runs its own
 * expectancy-error loop for rupture and repair, and adding a second one would
 * double-count the same disappointment.
 *
 * The other half of the payoff is a sentence. *"She had been sure he would
 * fold."* Nothing else in this engine produces that, and it costs one line.
 *
 * ## Being wrong has to be possible
 *
 * A forecast the scene never tested is not scored, kept for another pass, and
 * eventually dropped unscored. Counting untested predictions as hits would make
 * the calibration statistic meaningless, and that statistic is the only way to
 * tell whether this mechanism is doing anything at all.
 *
 * Pure. Time is passed in.
 */
import { clamp01, clampSigned } from './activation';
import { ensureBond } from '../psyche/attachment';
import { resolvePerson } from './entities';
import type { AppraisedEvent, BrainState, SceneForecast } from './types';

/** Passes a forecast may go untested before it is simply stale. */
export const FORECAST_TTL = 3;

/**
 * Confidence below this is not really a prediction.
 *
 * A character with no view of somebody has not predicted anything about them,
 * and scoring a shrug as a hit or a miss would be noise in both directions.
 */
export const MIN_CONFIDENCE = 0.15;

/** Absolute error above this counts as having been wrong. */
export const MISS_THRESHOLD = 0.5;

/**
 * How much a violated expectation may lift an event's novelty.
 *
 * Capped well below 1: surprise makes something *more* memorable, it does not
 * make an unremarkable exchange formative. The gate in `salienceOf` weights
 * novelty at 0.12, so this is worth at most a few points of salience — enough to
 * carry a borderline event over the line, never enough to admit filler.
 */
export const MAX_NOVELTY_LIFT = 0.45;

/**
 * Form the prediction the character is about to be tested on.
 *
 * Returns `null` when there is nothing to predict — no one to predict about and
 * no objective in play — which is the correct and common outcome early in a
 * conversation. A forecast is never invented to have one.
 */
export function formForecast(
  brain: BrainState,
  ctx: { present: string[]; now: number },
): SceneForecast | null {
  const self = brain.characterName.trim().toLowerCase();
  const other = ctx.present.find((n) => n.trim().toLowerCase() !== self);

  let target: string | undefined;
  let stance = 0;
  let confidence = 0;

  if (other) {
    const rel = brain.people[resolvePerson(brain, other)];
    /**
     * Familiarity *is* the confidence. You cannot be surprised by a stranger in
     * the way you can be surprised by someone you thought you knew, and that
     * asymmetry is most of what makes betrayal land.
     */
    if (rel && rel.interactions > 1) {
      /**
       * `expectancy` when the psyche has been seeded, and its own fallback
       * otherwise. A brain from before the psyche layer still has trust, so it
       * can still hold an expectation — it simply holds a coarser one.
       */
      const expectancy = brain.psyche
        ? ensureBond(rel, brain.psyche).expectancy
        : clampSigned(rel.trust * 0.8);
      target = rel.displayName || other;
      stance = clampSigned(0.7 * expectancy + 0.3 * rel.trust - 0.4 * Math.max(0, rel.fear));
      confidence = clamp01(0.25 + 0.6 * rel.familiarity);
    }
  }

  const intention = brain.intention;
  const capacity = brain.psyche ? clamp01(brain.psyche.body.energy) : 0.6;
  // Someone driving hard at something, with the capacity to, expects to get it.
  const progress = intention && intention.status === 'active' && intention.ttl > 0
    ? clampSigned(intention.urgency * (2 * capacity - 1))
    : 0;

  if (confidence < MIN_CONFIDENCE && progress === 0) return null;

  return {
    target,
    stance,
    confidence,
    progress,
    intentionId: intention?.id,
    madeAt: ctx.now,
    ttl: FORECAST_TTL,
  };
}

export interface ForecastOutcome {
  /** 0..1 — how badly the world diverged from what was expected. */
  surprise: number;
  /** Was the prediction actually put to the test this pass? */
  tested: boolean;
  /** Signed error on the stance call: positive means better than expected. */
  stanceError: number;
  /** One line for the prompt, or '' when nothing worth saying happened. */
  note: string;
}

const NOTHING: ForecastOutcome = { surprise: 0, tested: false, stanceError: 0, note: '' };

/**
 * Score a standing forecast against what actually happened.
 *
 * Pure read — it does not mutate the brain. `resolveForecast` does the writing,
 * so the scoring itself stays trivially testable.
 */
export function scoreForecast(
  forecast: SceneForecast | undefined,
  events: AppraisedEvent[],
  brain: BrainState,
): ForecastOutcome {
  if (!forecast || forecast.confidence < MIN_CONFIDENCE) return NOTHING;
  const target = forecast.target?.trim().toLowerCase();
  if (!target) return NOTHING;

  // Only acts this person actually committed can test a prediction about them.
  const theirs = events.filter(
    (e) => e.appraisal.agency === 'other'
      && e.actors.some((a) => resolvePerson(brain, a) === resolvePerson(brain, target)),
  );
  if (!theirs.length) return NOTHING;

  const stakes = clamp01(
    theirs.reduce((s, e) => s + Math.max(e.salience, e.appraisal.goalRelevance), 0) / theirs.length,
  );
  const actual = clampSigned(
    theirs.reduce((s, e) => s + e.appraisal.intent, 0) / theirs.length,
  );

  const stanceError = clampSigned(actual - forecast.stance);
  /**
   * Confidence and stakes both scale it, because both are what makes being wrong
   * *cost* something. Being casually mistaken about a stranger over nothing is
   * not a surprise, it is a Tuesday.
   */
  const surprise = clamp01(
    (Math.abs(stanceError) / 2) * forecast.confidence * (0.45 + 0.55 * stakes),
  );

  return {
    surprise,
    tested: true,
    stanceError,
    note: noteFor(forecast, stanceError, surprise),
  };
}

/**
 * The sentence. Only written when the character was meaningfully wrong — a
 * prediction that came true is not news and should cost no tokens.
 */
function noteFor(forecast: SceneForecast, stanceError: number, surprise: number): string {
  if (surprise < 0.12 || Math.abs(stanceError) < MISS_THRESHOLD) return '';
  const who = forecast.target ?? 'they';
  const sure = forecast.confidence > 0.65 ? 'had been sure' : 'had expected';
  if (stanceError < 0) {
    return forecast.stance > 0.15
      ? `They ${sure} ${who} would be better than this.`
      : `They expected little from ${who}, and got less.`;
  }
  return forecast.stance < -0.15
    ? `They ${sure} ${who} would let them down, and ${who} did not.`
    : `${who} went further for them than they had any reason to expect.`;
}

/**
 * Apply the outcome: fold surprise into the events, and retire the forecast.
 *
 * Novelty is lifted rather than overwritten. The encoder's own reading of how
 * unexpected something was is still evidence — it simply is not the only
 * evidence any more, and it can now be corrected upward by a prediction the
 * character actually made.
 */
export function resolveForecast(
  brain: BrainState,
  events: AppraisedEvent[],
  outcome: ForecastOutcome,
): void {
  const forecast = brain.forecast;
  if (!forecast) return;

  if (!outcome.tested) {
    // Untested is not wrong. Keep it for another pass, then let it lapse.
    forecast.ttl -= 1;
    if (forecast.ttl <= 0) brain.forecast = undefined;
    return;
  }

  const stats = brain.stats;
  stats.forecastsTested = (stats.forecastsTested ?? 0) + 1;
  if (Math.abs(outcome.stanceError) < MISS_THRESHOLD) {
    stats.forecastsHit = (stats.forecastsHit ?? 0) + 1;
  }

  if (outcome.surprise > 0) {
    const target = forecast.target?.trim().toLowerCase();
    for (const event of events) {
      if (event.appraisal.agency !== 'other') continue;
      if (target && !event.actors.some((a) => resolvePerson(brain, a) === resolvePerson(brain, target))) continue;
      event.appraisal.novelty = clamp01(
        event.appraisal.novelty + MAX_NOVELTY_LIFT * outcome.surprise,
      );
    }
  }

  brain.lastSurprise = outcome.note
    ? { note: outcome.note, surprise: outcome.surprise, at: forecast.madeAt }
    : undefined;
  // A tested forecast is spent. The next turn forms a fresh one.
  brain.forecast = undefined;
}

/**
 * 0..1 — how often this mind's predictions about people turn out right.
 *
 * `null` until there is enough of a record to mean anything. This is the number
 * that says whether the mechanism is calibrated: near 1 means the taxonomy is
 * too coarse to ever be wrong, near 0 means it is noise.
 */
export function forecastAccuracy(brain: BrainState): number | null {
  const tested = brain.stats.forecastsTested ?? 0;
  if (tested < 5) return null;
  return (brain.stats.forecastsHit ?? 0) / tested;
}
