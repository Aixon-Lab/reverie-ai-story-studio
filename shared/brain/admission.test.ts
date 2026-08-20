import { describe, expect, it } from 'vitest';
import { ADMIT_BAND, DROP_BAND, MIN_DROPPABLE_SEGMENTS, admitBand, gateChunk } from './admission';
import type { AppraisedEvent } from './types';
import { neutralAppraisal } from './emotion';
import { elaborationSalience } from './heuristics';

function ev(
  salience: number,
  gist = 'something happened in the scene today',
  lexiconHits = 3,
): AppraisedEvent {
  return {
    gist,
    actors: [],
    tags: [],
    appraisal: neutralAppraisal(),
    salience,
    lexiconHits,
  };
}

/** A dull stretch the cheap scorer actually read — long enough to write off. */
function dullStretch(): AppraisedEvent[] {
  return Array.from({ length: MIN_DROPPABLE_SEGMENTS }, () => ev(0.1));
}

describe('two-band admission gate (§B.2 #29)', () => {
  it('admits at the high band, drops at the low band, escalates in between', () => {
    expect(admitBand(ADMIT_BAND)).toBe('admit');
    expect(admitBand(0.99)).toBe('admit');
    expect(admitBand(DROP_BAND)).toBe('drop');
    expect(admitBand(0)).toBe('drop');
    expect(admitBand(0.5)).toBe('escalate');
  });

  it('will not drop on a score the lexicon had no evidence for', () => {
    // Zero recognised words means the score is a floor constant, not a verdict.
    // Treating the two as the same is what stopped memory forming in prose that
    // never happens to use one of the lexicon's ~120 trigger words.
    expect(admitBand(0.05, 0)).toBe('escalate');
    expect(admitBand(0.05, 1)).toBe('drop');
    // A loud stretch is still admitted on the cheap score alone.
    expect(admitBand(0.9, 0)).toBe('admit');
  });

  it('skips the model when everything is forgettable', () => {
    const d = gateChunk(dullStretch());
    expect(d.action).toBe('drop');
    expect(d.admitted).toHaveLength(0);
  });

  it('refuses to write off a stretch too short to judge', () => {
    // The cadence hands the gate ~6 messages, which segment into two candidate
    // events. Two samples decided the fate of the whole conversation: the first
    // pass reads the entire backlog and encodes, every pass after it is two coin
    // flips and lands on "nothing happened".
    const d = gateChunk(dullStretch().slice(0, MIN_DROPPABLE_SEGMENTS - 1));
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/too short a stretch/);
  });

  it('skips the model when everything is obviously memorable', () => {
    const d = gateChunk([ev(0.9, 'he betrayed her in front of everyone'), ev(0.88)]);
    expect(d.action).toBe('admit');
    expect(d.admitted).toHaveLength(2);
  });

  it('asks the model when anything is borderline', () => {
    const d = gateChunk([ev(0.9), ev(0.4), ev(0.05)]);
    expect(d.action).toBe('escalate');
    expect(d.admitted).toHaveLength(1);
  });

  it('never lets sheer substance admit a stretch without a model call', () => {
    // `elaborationSalience` is the offline stand-in for elaboration when the
    // affect lexicon is silent. Substance means "not nothing", never "memorable"
    // — so however dense a stretch is, it must still be read, not waved through.
    expect(elaborationSalience(Number.MAX_SAFE_INTEGER)).toBeLessThan(ADMIT_BAND);
    expect(admitBand(elaborationSalience(10_000), 0)).toBe('escalate');
    // And it stays out of the drop band as soon as there is real material.
    expect(elaborationSalience(6)).toBeLessThanOrEqual(DROP_BAND);
    expect(elaborationSalience(40)).toBeGreaterThan(DROP_BAND);
  });

  it('escalates an empty stretch rather than silently dropping it', () => {
    // Heuristic found nothing to score — that is not the same as scoring
    // everything as forgettable. A quietly written scene can still matter.
    expect(gateChunk([]).action).toBe('escalate');
  });
});
