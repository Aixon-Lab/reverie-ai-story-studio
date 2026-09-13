/**
 * Theory of mind, extended: what somebody could have worked out, and forgetting
 * whether you ever actually said it.
 *
 * Both extensions have an asymmetric failure. Inferring too eagerly makes a
 * character talk themselves into revealing a secret — "they must have guessed by
 * now" — and forgetting too hard makes them guard something the other person
 * demonstrably already knows. The tests below are mostly about those two edges
 * rather than about the happy path.
 */
import { describe, expect, it } from 'vitest';
import {
  KNOWN_CERTAINTY, MAX_INFERRED_CERTAINTY, TOLD_CERTAINTY_FLOOR,
  decayMindModels, describeTheoryOfMind, doesKnow, emptyTheoryOfMind,
  guardedTopics, recordInferred, recordTold, recordWithheld, recordWitnessed,
} from './theoryOfMind';

const T0 = 1_700_000_000_000;

function withWitness() {
  const tom = emptyTheoryOfMind();
  recordWitnessed(tom, {
    nodeId: 'n1',
    gist: 'Rooke took the ledger out of the drawer and put it in his coat',
    present: ['Hughie'],
    cast: ['Hughie', 'Kessler'],
    now: T0,
  });
  return tom;
}

describe('what somebody could have worked out', () => {
  it('is not the same as knowing it', () => {
    const tom = withWitness();
    recordInferred(tom, 'Hughie', {
      nodeId: 'n2', gist: 'The ledger is no longer in the office', at: T0, certainty: 0.4,
    }, T0);

    const v = doesKnow(tom, 'Hughie', { nodeId: 'n2' });
    expect(v.knows).toBe(false);
    expect(v.suspected).toBe(true);
    expect(v.source).toBe('inferred');
  });

  it('is capped below the certainty at which it would count as knowledge', () => {
    const tom = emptyTheoryOfMind();
    recordInferred(tom, 'Hughie', { nodeId: 'n2', gist: 'x y z', at: T0, certainty: 0.99 }, T0);
    expect(tom.minds.hughie.knows[0].certainty).toBeLessThanOrEqual(MAX_INFERRED_CERTAINTY);
    expect(MAX_INFERRED_CERTAINTY).toBeLessThan(KNOWN_CERTAINTY);
  });

  /** The leak this guard exists to prevent. */
  it('refuses to infer something the character is deliberately withholding', () => {
    const tom = emptyTheoryOfMind();
    recordWithheld(tom, 'Hughie', { nodeId: 'secret', gist: 'She signed the forged papers', at: T0 }, T0);
    recordInferred(tom, 'Hughie', { nodeId: 'secret', gist: 'She signed the forged papers', at: T0, certainty: 0.45 }, T0);
    expect(tom.minds.hughie.knows).toHaveLength(0);
    expect(doesKnow(tom, 'Hughie', { nodeId: 'secret' }).knows).toBe(false);
  });

  it('never downgrades something they actually witnessed', () => {
    const tom = withWitness();
    recordInferred(tom, 'Hughie', { nodeId: 'n1', gist: 'whatever', at: T0, certainty: 0.1 }, T0);
    const v = doesKnow(tom, 'Hughie', { nodeId: 'n1' });
    expect(v.knows).toBe(true);
    expect(v.source).toBe('witnessed');
  });

  it('keeps a suspected topic guarded, and says the character cannot be sure', () => {
    const tom = emptyTheoryOfMind();
    recordInferred(tom, 'Hughie', {
      nodeId: 'n2', gist: 'The ledger is gone from the office', at: T0, certainty: 0.4,
    }, T0);

    const guarded = guardedTopics(tom, ['Hughie'], [
      { nodeId: 'n2', gist: 'The ledger is gone from the office' },
    ]);
    expect(guarded).toHaveLength(1);
    expect(guarded[0].suspectedBy).toEqual(['Hughie']);

    const lines = describeTheoryOfMind(tom, ['Hughie'], guarded).join(' ');
    expect(lines).toMatch(/had enough to work out/);
    expect(lines).toMatch(/do not confirm it/);
  });
});

describe('forgetting whether you said it', () => {
  const told = () => {
    const tom = emptyTheoryOfMind();
    recordTold(tom, 'Hughie', {
      nodeId: 'n3', gist: 'Her father owes Kessler eleven thousand', at: T0, certainty: 0.85,
    }, T0);
    return tom;
  };

  it('fades over scenes', () => {
    const tom = told();
    const before = tom.minds.hughie.knows[0].certainty;
    decayMindModels(tom, 20);
    expect(tom.minds.hughie.knows[0].certainty).toBeLessThan(before);
  });

  /**
   * The failure this floor exists to prevent: a belief that decayed away would
   * make the character start guarding a thing they had already said out loud.
   */
  it('never fades far enough to make them think the person does not know', () => {
    const tom = told();
    decayMindModels(tom, 10_000);
    expect(tom.minds.hughie.knows[0].certainty).toBe(TOLD_CERTAINTY_FLOOR);
    expect(doesKnow(tom, 'Hughie', { nodeId: 'n3' }).knows).toBe(true);
    expect(guardedTopics(tom, ['Hughie'], [{ nodeId: 'n3', gist: 'x' }])).toEqual([]);
  });

  it('leaves what they witnessed alone — you do not forget who was in the room', () => {
    const tom = withWitness();
    decayMindModels(tom, 500);
    expect(tom.minds.hughie.knows[0].certainty).toBe(0.95);
  });

  it('leaves a secret alone — keeping one is an active job', () => {
    const tom = emptyTheoryOfMind();
    recordWithheld(tom, 'Hughie', { nodeId: 's', gist: 'the forged papers', at: T0 }, T0);
    decayMindModels(tom, 500);
    expect(tom.minds.hughie.withheld[0].certainty).toBe(0.9);
  });

  it('says so once it is genuinely hazy', () => {
    const tom = told();
    decayMindModels(tom, 40);
    const lines = describeTheoryOfMind(tom, ['Hughie'], []).join(' ');
    expect(lines).toMatch(/cannot remember whether they did/);
    expect(lines).toMatch(/would check rather than assume/);
  });

  it('stays quiet while the telling is still fresh', () => {
    const tom = told();
    decayMindModels(tom, 1);
    expect(describeTheoryOfMind(tom, ['Hughie'], [])).toEqual([]);
  });

  it('does nothing on a zero or negative scene count', () => {
    const tom = told();
    const before = tom.minds.hughie.knows[0].certainty;
    decayMindModels(tom, 0);
    decayMindModels(tom, -5);
    expect(tom.minds.hughie.knows[0].certainty).toBe(before);
  });
});

describe('the ordinary cases still behave', () => {
  it('treats presence as near-certain knowledge', () => {
    expect(doesKnow(withWitness(), 'Hughie', { nodeId: 'n1' })).toMatchObject({
      knows: true, source: 'witnessed',
    });
  });

  it('treats an absent person as not knowing', () => {
    expect(doesKnow(withWitness(), 'Kessler', { nodeId: 'n1' }).knows).toBe(false);
  });

  it('guards a memory from whoever was not there', () => {
    const guarded = guardedTopics(withWitness(), ['Hughie', 'Kessler'], [
      { nodeId: 'n1', gist: 'Rooke took the ledger out of the drawer and put it in his coat' },
    ]);
    expect(guarded[0].hiddenFrom).toEqual(['Kessler']);
    expect(guarded[0].suspectedBy).toEqual([]);
  });
});
