/**
 * Two-band admission gate — pay for the model only when the cheap score cannot
 * decide (§B.2 #29, §N.6.1).
 *
 * The encoder used to run on every unread stretch, then throw the result away
 * if salience sat below `encodeThreshold`. That is the wrong order: the cutoff
 * is a *cost* decision, and making it after the call is already paid for is
 * how a quiet afternoon of "ok" / "yeah" burns a utility-model call for
 * nothing.
 *
 * OpenHuman's two-band rule is the right shape:
 *
 *   ≥ 0.85   admit from the cheap score — the stretch is obviously memorable
 *   ≤ 0.15   drop — even the heuristic thinks nothing happened
 *   between  escalate — only this band is worth a model call
 *
 * The gate is per *chunk*, not per event: if anything in the stretch is
 * borderline the whole stretch goes to the model, because appraisal needs
 * the surrounding turns. The saving is the common case — uniformly quiet
 * or uniformly loud — where the model would only have confirmed what the
 * lexicon already knew.
 *
 * Pure. No I/O, no clock.
 */
import type { AppraisedEvent } from './types';

/** Cheap salience at or above this is memorable enough to skip the model. */
export const ADMIT_BAND = 0.85;
/** Cheap salience at or below this is forgettable enough to skip the model. */
export const DROP_BAND = 0.15;

/**
 * A stretch shorter than this is never dropped as a whole.
 *
 * The gate is per *chunk*, and a chunk is however many messages the cadence let
 * accumulate — normally six, which the segmenter turns into two candidate
 * events. Two samples is not enough evidence to write off a stretch of story,
 * and the arithmetic made it self-fulfilling: the very first pass reads the
 * whole backlog (eight or more segments, one of which nearly always trips the
 * lexicon) and encodes richly, while every pass after it is two coin flips and
 * usually lands on "nothing happened". That is the "memory formed at first and
 * then stopped" failure, and it is a property of the chunk size rather than of
 * the conversation.
 */
export const MIN_DROPPABLE_SEGMENTS = 4;

export type Admission = 'admit' | 'drop' | 'escalate';

export interface AdmissionDecision {
  action: Admission;
  /** Events the cheap path is willing to keep (admit band only). */
  admitted: AppraisedEvent[];
  /** How many candidate events sat in each band. */
  counts: { admit: number; drop: number; escalate: number };
  /** One line for the audit log. */
  reason: string;
}

/**
 * Classify a single cheap salience score.
 *
 * `lexiconHits` is the scorer's own confidence: with no recognised words the
 * score is a floor constant rather than a judgement, so it may not be used to
 * discard anything. Omitted (the model path, and every caller that predates the
 * field) it is treated as a real score, which is what it is.
 */
export function admitBand(salience: number, lexiconHits?: number): Admission {
  if (!Number.isFinite(salience)) return 'escalate';
  if (salience >= ADMIT_BAND) return 'admit';
  if (salience <= DROP_BAND) return lexiconHits === 0 ? 'escalate' : 'drop';
  return 'escalate';
}

/**
 * Decide whether a stretch of already-cheap-scored events needs a model call.
 *
 * Empty input escalates: the heuristic found nothing to score, which is not
 * the same as scoring everything as forgettable — a long, quietly-written
 * scene can have no lexicon hits and still be worth reading.
 */
export function gateChunk(events: AppraisedEvent[]): AdmissionDecision {
  const counts = { admit: 0, drop: 0, escalate: 0 };
  const admitted: AppraisedEvent[] = [];

  if (!events.length) {
    return {
      action: 'escalate',
      admitted,
      counts,
      reason: 'heuristic found no scoreable events — asking the model',
    };
  }

  for (const event of events) {
    const band = admitBand(event.salience, event.lexiconHits);
    counts[band]++;
    if (band === 'admit') admitted.push(event);
  }

  if (counts.escalate === 0 && counts.admit === 0) {
    // Too small a sample to write off a stretch of story — read it properly.
    if (events.length < MIN_DROPPABLE_SEGMENTS) {
      return {
        action: 'escalate',
        admitted,
        counts,
        reason:
          `${counts.drop} quiet event(s), but only ${events.length} segment(s) — `
          + 'too short a stretch to discard unread',
      };
    }
    return {
      action: 'drop',
      admitted,
      counts,
      reason: `all ${counts.drop} event(s) below the drop band — skipped the model`,
    };
  }

  if (counts.escalate === 0) {
    return {
      action: 'admit',
      admitted,
      counts,
      reason: `${counts.admit} obviously memorable, ${counts.drop} dropped — skipped the model`,
    };
  }

  return {
    action: 'escalate',
    admitted,
    counts,
    reason: `${counts.escalate} borderline event(s) — asking the model`,
  };
}
