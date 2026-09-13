/**
 * Prediction error.
 *
 * The mechanism is only worth anything if being wrong is genuinely possible and
 * genuinely counted. Most of this file is therefore about the ways a naive
 * implementation would quietly always be right: scoring a prediction the scene
 * never tested, scoring a shrug, scoring the same prediction twice, or counting
 * a lapse as a hit.
 */
import { describe, expect, it } from 'vitest';
import { emptyBrain } from './defaults';
import { emptyPsyche } from '../psyche/defaults';
import { ensureRelation } from './personality';
import { mergeGenerationEffects } from './persist';
import { consolidate } from './consolidation';
import {
  FORECAST_TTL, MAX_NOVELTY_LIFT, MIN_CONFIDENCE,
  forecastAccuracy, formForecast, resolveForecast, scoreForecast,
} from './forecast';
import type { Bond } from '../psyche/attachment';
import type { AppraisedEvent, BrainState } from './types';

const T0 = 1_700_000_000_000;

function wren(): BrainState {
  const b = emptyBrain('dock', 'wren', 'Scarlet Wren', T0);
  b.psyche = emptyPsyche(b.traits, T0);
  return b;
}

/** Somebody the character knows well and has learned to count on. */
function trusted(b: BrainState, name = 'Rooke'): void {
  const r = ensureRelation(b, name, T0) as Bond;
  r.trust = 0.7;
  r.familiarity = 0.9;
  r.interactions = 12;
  r.expectancy = 0.7;
}

function act(intent: number, actor = 'Rooke', salience = 0.7): AppraisedEvent {
  return {
    gist: `${actor} did something`,
    actors: [actor],
    tags: [],
    appraisal: {
      novelty: 0.3, pleasantness: intent, goalRelevance: 0.7, goalConduciveness: intent,
      agency: 'other', intent, copingPotential: 0.5, norms: intent, urgency: 0.4,
    },
    salience,
    identityRelevant: false,
  };
}

describe('forming a prediction', () => {
  it('predicts nothing when there is nobody known and nothing wanted', () => {
    expect(formForecast(wren(), { present: ['A Stranger'], now: T0 })).toBeNull();
  });

  it('will not commit on the strength of one meeting', () => {
    const b = wren();
    const r = ensureRelation(b, 'Rooke', T0);
    r.interactions = 1;
    r.trust = 0.8;
    expect(formForecast(b, { present: ['Rooke'], now: T0 })).toBeNull();
  });

  it('expects well of somebody it has learned to count on', () => {
    const b = wren();
    trusted(b);
    const f = formForecast(b, { present: ['Rooke'], now: T0 })!;
    expect(f.target).toBe('Rooke');
    expect(f.stance).toBeGreaterThan(0.3);
    expect(f.confidence).toBeGreaterThan(MIN_CONFIDENCE);
  });

  it('is exposed in proportion to how well it thinks it knows them', () => {
    const b = wren();
    trusted(b);
    const known = formForecast(b, { present: ['Rooke'], now: T0 })!.confidence;
    b.people.rooke.familiarity = 0.2;
    const barely = formForecast(b, { present: ['Rooke'], now: T0 })!.confidence;
    expect(known).toBeGreaterThan(barely);
  });

  it('never predicts about the character themselves', () => {
    const b = wren();
    trusted(b, 'Scarlet Wren');
    expect(formForecast(b, { present: ['Scarlet Wren'], now: T0 })).toBeNull();
  });
});

describe('scoring', () => {
  it('records surprise when somebody trusted turns on them', () => {
    const b = wren();
    trusted(b);
    const f = formForecast(b, { present: ['Rooke'], now: T0 })!;
    const outcome = scoreForecast(f, [act(-0.9)], b);
    expect(outcome.tested).toBe(true);
    expect(outcome.surprise).toBeGreaterThan(0.2);
    expect(outcome.stanceError).toBeLessThan(0);
    expect(outcome.note).toMatch(/Rooke/);
  });

  it('records almost nothing when the prediction comes true', () => {
    const b = wren();
    trusted(b);
    const f = formForecast(b, { present: ['Rooke'], now: T0 })!;
    const outcome = scoreForecast(f, [act(f.stance)], b);
    expect(outcome.surprise).toBeCloseTo(0, 5);
    expect(outcome.note).toBe('');
  });

  it('is not tested by a scene the person never acted in', () => {
    const b = wren();
    trusted(b);
    const f = formForecast(b, { present: ['Rooke'], now: T0 })!;
    expect(scoreForecast(f, [act(-0.9, 'Hughie')], b).tested).toBe(false);
  });

  it('is not tested by something that merely happened to them', () => {
    const b = wren();
    trusted(b);
    const f = formForecast(b, { present: ['Rooke'], now: T0 })!;
    const circumstance = { ...act(-0.9) };
    circumstance.appraisal = { ...circumstance.appraisal, agency: 'circumstance' };
    expect(scoreForecast(f, [circumstance], b).tested).toBe(false);
  });

  it('costs more when the stakes were high', () => {
    const b = wren();
    trusted(b);
    const f = formForecast(b, { present: ['Rooke'], now: T0 })!;
    const big = scoreForecast(f, [act(-0.9, 'Rooke', 0.95)], b).surprise;
    const small = scoreForecast(f, [act(-0.9, 'Rooke', 0.05)], b).surprise;
    expect(big).toBeGreaterThan(small);
  });

  it('scores nothing at all for a prediction nobody was confident in', () => {
    const b = wren();
    trusted(b);
    const f = { ...formForecast(b, { present: ['Rooke'], now: T0 })!, confidence: 0.05 };
    expect(scoreForecast(f, [act(-0.9)], b).tested).toBe(false);
  });

  it('follows an alias, so a renamed person still tests the prediction', () => {
    const b = wren();
    trusted(b, 'Wren Vale');
    b.aliases = { 'miss vale': 'wren vale' };
    const f = formForecast(b, { present: ['Wren Vale'], now: T0 })!;
    expect(scoreForecast(f, [act(-0.9, 'Miss Vale')], b).tested).toBe(true);
  });
});

describe('resolving', () => {
  it('lifts the novelty of the events that broke the prediction', () => {
    const b = wren();
    trusted(b);
    b.forecast = formForecast(b, { present: ['Rooke'], now: T0 })!;
    const events = [act(-0.9)];
    const before = events[0].appraisal.novelty;
    resolveForecast(b, events, scoreForecast(b.forecast, events, b));
    expect(events[0].appraisal.novelty).toBeGreaterThan(before);
    expect(events[0].appraisal.novelty).toBeLessThanOrEqual(before + MAX_NOVELTY_LIFT);
  });

  it('does not lift events belonging to somebody else', () => {
    const b = wren();
    trusted(b);
    b.forecast = formForecast(b, { present: ['Rooke'], now: T0 })!;
    const events = [act(-0.9, 'Rooke'), act(-0.9, 'Hughie')];
    resolveForecast(b, events, scoreForecast(b.forecast, events, b));
    expect(events[1].appraisal.novelty).toBe(0.3);
  });

  it('spends a tested prediction so it cannot be scored twice', () => {
    const b = wren();
    trusted(b);
    b.forecast = formForecast(b, { present: ['Rooke'], now: T0 })!;
    const events = [act(-0.9)];
    resolveForecast(b, events, scoreForecast(b.forecast, events, b));
    expect(b.forecast).toBeUndefined();
    expect(b.stats.forecastsTested).toBe(1);
  });

  it('counts a hit as a hit and a miss as a miss', () => {
    const hit = wren();
    trusted(hit);
    hit.forecast = formForecast(hit, { present: ['Rooke'], now: T0 })!;
    const kept = [act(hit.forecast.stance)];
    resolveForecast(hit, kept, scoreForecast(hit.forecast, kept, hit));
    expect(hit.stats.forecastsHit).toBe(1);

    const miss = wren();
    trusted(miss);
    miss.forecast = formForecast(miss, { present: ['Rooke'], now: T0 })!;
    const broken = [act(-0.9)];
    resolveForecast(miss, broken, scoreForecast(miss.forecast, broken, miss));
    expect(miss.stats.forecastsHit ?? 0).toBe(0);
    expect(miss.stats.forecastsTested).toBe(1);
  });

  it('keeps an untested prediction alive, then lets it lapse uncounted', () => {
    const b = wren();
    trusted(b);
    b.forecast = formForecast(b, { present: ['Rooke'], now: T0 })!;
    for (let i = 0; i < FORECAST_TTL; i++) {
      resolveForecast(b, [], scoreForecast(b.forecast, [], b));
    }
    expect(b.forecast).toBeUndefined();
    // A lapse is not evidence about anything, so it must not reach calibration.
    expect(b.stats.forecastsTested ?? 0).toBe(0);
    expect(b.stats.forecastsHit ?? 0).toBe(0);
  });

  it('leaves no note when the character was right', () => {
    const b = wren();
    trusted(b);
    b.forecast = formForecast(b, { present: ['Rooke'], now: T0 })!;
    const events = [act(b.forecast.stance)];
    resolveForecast(b, events, scoreForecast(b.forecast, events, b));
    expect(b.lastSurprise).toBeUndefined();
  });
});

describe('calibration', () => {
  it('says nothing until there is a record worth reading', () => {
    const b = wren();
    expect(forecastAccuracy(b)).toBeNull();
    b.stats.forecastsTested = 4;
    b.stats.forecastsHit = 4;
    expect(forecastAccuracy(b)).toBeNull();
  });

  it('reports the hit rate once there is', () => {
    const b = wren();
    b.stats.forecastsTested = 10;
    b.stats.forecastsHit = 6;
    expect(forecastAccuracy(b)).toBeCloseTo(0.6, 6);
  });
});

describe('surviving a concurrent consolidation', () => {
  it('carries a prediction formed during a generation onto the newer brain', () => {
    const fresh = wren();
    const stale = wren();
    trusted(stale);
    stale.forecast = formForecast(stale, { present: ['Rooke'], now: T0 })!;
    mergeGenerationEffects(fresh, stale);
    expect(fresh.forecast?.target).toBe('Rooke');
  });

  /**
   * The case that would double-count: consolidation scored the prediction while
   * the generation still held a copy of it.
   */
  it('refuses to resurrect a prediction the consolidation already spent', () => {
    const fresh = wren();
    const stale = wren();
    trusted(stale);
    stale.forecast = formForecast(stale, { present: ['Rooke'], now: T0 })!;
    fresh.stats.forecastsTested = 1;
    mergeGenerationEffects(fresh, stale);
    expect(fresh.forecast).toBeUndefined();
  });
});

describe('through a real consolidation pass', () => {
  it('scores before encoding, so surprise can save the memory it belongs to', () => {
    const b = wren();
    trusted(b);
    b.forecast = formForecast(b, { present: ['Rooke'], now: T0 })!;
    let id = 0;
    const report = consolidate(b, {
      events: [act(-0.95)],
      now: T0,
      makeId: () => `n${++id}`,
      cast: ['Rooke'],
      maintenance: true,
    });
    expect(report.surprise).toBeGreaterThan(0);
    expect(b.forecast).toBeUndefined();
    expect(b.lastSurprise?.note).toMatch(/Rooke/);
  });

  it('reports no surprise on a pass with no standing prediction', () => {
    const b = wren();
    let id = 0;
    const report = consolidate(b, {
      events: [act(-0.95)],
      now: T0,
      makeId: () => `n${++id}`,
      cast: ['Rooke'],
      maintenance: true,
    });
    expect(report.surprise).toBeUndefined();
  });
});
