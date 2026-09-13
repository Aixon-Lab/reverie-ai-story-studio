/**
 * Holding a position under pressure.
 *
 * Two failures bracket this mechanism and both are worse than doing nothing:
 * a character who folds every time somebody repeats themselves, and one who
 * cannot be moved by an actual argument. Most of what follows is about the
 * second — freshness has to reliably cancel pressure, or this becomes
 * stubbornness with better prose.
 */
import { describe, expect, it } from 'vitest';
import { emptyPsyche } from './defaults';
import { neutralTraits } from '../brain/defaults';
import {
  PRESSURE_FLOOR, assessConviction, freshnessOf, pressureOf, resistanceOf,
} from './conviction';
import type { Bond } from './attachment';
import type { PsycheState } from './types';

const T0 = 1_700_000_000_000;

function psyche(patch: Partial<PsycheState> = {}): PsycheState {
  return { ...emptyPsyche(neutralTraits(), T0), ...patch };
}

function bond(patch: Partial<Bond> = {}): Bond {
  return {
    key: 'rooke',
    displayName: 'Rooke',
    trust: 0.2, affection: 0.2, fear: 0, respect: 0.2, resentment: 0, debt: 0,
    familiarity: 0.6, model: '', interactions: 8,
    firstMetAt: T0, lastSeenAt: T0,
    ...patch,
  };
}

const DEMAND = 'Just give me the ledger. I need the ledger tonight, give it to me.';
const DEMAND_AGAIN = 'Give me the ledger. I need that ledger tonight. Just give it to me.';
const DEMAND_THIRD = 'The ledger. Tonight. I need it, so give me the ledger.';

describe('telling repetition from argument', () => {
  it('sees no pressure in a single turn', () => {
    expect(pressureOf([DEMAND]).pressure).toBe(0);
    expect(pressureOf([]).pressure).toBe(0);
  });

  it('sees no pressure when the conversation is actually moving', () => {
    const moving = pressureOf([
      'Where were you on Tuesday night?',
      'The harbour master says a boat went out at four.',
      'Kessler signed the manifest himself, in his own hand.',
    ]);
    expect(moving.pressure).toBeLessThan(PRESSURE_FLOOR);
  });

  it('registers pressure when the same demand is put again', () => {
    expect(pressureOf([DEMAND, DEMAND_AGAIN]).pressure).toBeGreaterThan(0);
  });

  it('builds as it is repeated', () => {
    const twice = pressureOf([DEMAND, DEMAND_AGAIN]).pressure;
    const thrice = pressureOf([DEMAND, DEMAND_AGAIN, DEMAND_THIRD]).pressure;
    expect(thrice).toBeGreaterThanOrEqual(twice);
  });

  /**
   * The guard that keeps the character persuadable. New material has to cancel
   * pressure, or the mechanism just makes them impossible to talk to.
   */
  it('collapses when the latest turn brings a genuinely new argument', () => {
    const worn = pressureOf([DEMAND, DEMAND_AGAIN, DEMAND_THIRD]).pressure;
    const argued = pressureOf([
      DEMAND,
      DEMAND_AGAIN,
      'Kessler already has a copy. Hiding yours protects nobody now — it only makes you look complicit.',
    ]).pressure;
    expect(argued).toBeLessThan(worn);
    expect(argued).toBeLessThan(PRESSURE_FLOOR);
  });

  it('measures freshness as content the earlier turns did not have', () => {
    expect(freshnessOf('the harbour master signed a manifest', [DEMAND])).toBeGreaterThan(0.5);
    expect(freshnessOf(DEMAND_AGAIN, [DEMAND])).toBeLessThan(0.35);
    expect(freshnessOf('', [DEMAND])).toBe(1);
    expect(freshnessOf(DEMAND, [])).toBe(1);
  });
});

describe('resistance is a property of the character', () => {
  it('holds when they are mature, rested and owe this person nothing', () => {
    const r = resistanceOf(psyche({ defenseMaturity: 0.85 }), bond({ dependency: 0.1 }));
    expect(r.resistance).toBeGreaterThan(0.6);
  });

  it('gives way under load', () => {
    const rested = resistanceOf(psyche({ defenseMaturity: 0.6 })).resistance;
    const worn = resistanceOf(psyche({
      defenseMaturity: 0.6,
      load: { ...emptyPsyche(neutralTraits(), T0).load, level: 0.9 },
    })).resistance;
    expect(worn).toBeLessThan(rested);
  });

  it('gives way to somebody they need', () => {
    const stranger = resistanceOf(psyche(), bond({ dependency: 0.05 })).resistance;
    const needed = resistanceOf(psyche(), bond({ dependency: 0.9 })).resistance;
    expect(needed).toBeLessThan(stranger);
  });

  it('gives way when losing them is the real fear', () => {
    const calm = resistanceOf(psyche(), bond({ attachAnxiety: 0 })).resistance;
    const anxious = resistanceOf(psyche(), bond({ attachAnxiety: 0.9 })).resistance;
    expect(anxious).toBeLessThan(calm);
  });

  it('digs in on resentment', () => {
    const neutral = resistanceOf(psyche(), bond({ resentment: 0 })).resistance;
    const sour = resistanceOf(psyche(), bond({ resentment: 0.8 })).resistance;
    expect(sour).toBeGreaterThan(neutral);
  });

  it('stays inside 0..1 at every extreme', () => {
    const worst = resistanceOf(
      psyche({ defenseMaturity: 0, load: { ...emptyPsyche(neutralTraits(), T0).load, level: 1 } }),
      bond({ dependency: 1, attachAnxiety: 1 }),
    ).resistance;
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe('the line', () => {
  it('says nothing at all when nobody is leaning', () => {
    const c = assessConviction({ theirTurns: [DEMAND], psyche: psyche() });
    expect(c.line).toBe('');
  });

  it('says nothing when the latest turn was a real argument', () => {
    const c = assessConviction({
      theirTurns: [DEMAND, DEMAND_AGAIN, 'Kessler already has a copy, so hiding yours protects nobody.'],
      psyche: psyche(),
    });
    expect(c.line).toBe('');
  });

  it('tells a secure character that being asked twice is not an argument', () => {
    const c = assessConviction({
      theirTurns: [DEMAND, DEMAND_AGAIN, DEMAND_THIRD],
      psyche: psyche({ defenseMaturity: 0.9 }),
      relation: bond({ dependency: 0.05 }),
    });
    expect(c.line).toMatch(/not an argument/);
    expect(c.resistance).toBeGreaterThan(0.6);
  });

  /**
   * The important half. A depleted character who needs this person *should*
   * give ground — the mechanism's job is to make that cost something rather than
   * to forbid it.
   */
  it('lets a depleted character fold, and asks for the cost of folding', () => {
    const c = assessConviction({
      theirTurns: [DEMAND, DEMAND_AGAIN, DEMAND_THIRD],
      psyche: psyche({
        defenseMaturity: 0.1,
        load: { ...emptyPsyche(neutralTraits(), T0).load, level: 0.95 },
      }),
      relation: bond({ dependency: 0.9, attachAnxiety: 0.8 }),
    });
    expect(c.line).toMatch(/wanting to give in/);
    expect(c.line).toMatch(/cost them something/);
  });

  /** Never an instruction to refuse — that is stubbornness, not character. */
  it('never tells the character to disagree', () => {
    for (const maturity of [0, 0.3, 0.6, 1]) {
      const c = assessConviction({
        theirTurns: [DEMAND, DEMAND_AGAIN, DEMAND_THIRD],
        psyche: psyche({ defenseMaturity: maturity }),
      });
      expect(c.line).not.toMatch(/refuse|disagree|say no|do not agree/i);
    }
  });

  it('always allows a new argument to move them, whatever the resistance', () => {
    for (const maturity of [0, 0.5, 1]) {
      const c = assessConviction({
        theirTurns: [DEMAND, DEMAND_AGAIN, DEMAND_THIRD],
        psyche: psyche({ defenseMaturity: maturity }),
      });
      expect(c.line).toMatch(/unless something genuinely new was said/);
    }
  });

  it('works with no relationship at all', () => {
    const c = assessConviction({
      theirTurns: [DEMAND, DEMAND_AGAIN, DEMAND_THIRD],
      psyche: psyche(),
    });
    expect(c.line).not.toBe('');
  });

  it('ignores blank turns rather than reading them as repetition', () => {
    expect(pressureOf(['', '  ', '']).pressure).toBe(0);
  });
});
