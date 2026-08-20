import { describe, expect, it } from 'vitest';
import { emptyBrain } from './defaults';
import {
  WORKING_CAPACITY, WORKING_TTL_MS, evictWorking, holdInMind, holdRecentTurns, liveWorking,
} from './working';

const T0 = 1_700_000_000_000;
let n = 0;
const makeId = () => `w-${++n}`;

describe('working memory store (§B.2 #5)', () => {
  it('holds a beat and refreshes a near-duplicate instead of doubling it', () => {
    const b = emptyBrain('c', 'x', 'Wren', T0);
    holdInMind(b, { gist: 'Rooke put the letter on the table', actors: ['Rooke'], heldAt: T0, salience: 0.4 }, makeId);
    holdInMind(b, { gist: 'Rooke put the letter on the table', actors: ['Rooke'], heldAt: T0 + 1000, salience: 0.6 }, makeId);
    expect(b.working).toHaveLength(1);
    expect(b.working![0].salience).toBe(0.6);
    expect(b.working![0].heldAt).toBe(T0 + 1000);
  });

  it('never keeps more than four items', () => {
    const b = emptyBrain('c', 'x', 'Wren', T0);
    const beats = [
      'Rooke put the letter on the table and stepped back',
      'the greenhouse glass cracked in the cold',
      'she tasted iron and thought of the docks',
      'a cart went past in the alley without stopping',
      'the kettle screamed and nobody moved to lift it',
      'rain started on the skylight in a sudden sheet',
      'he counted the remaining seeds into a paper twist',
      'the portrait over the mantel had been turned to the wall',
    ];
    for (let i = 0; i < beats.length; i++) {
      holdInMind(b, {
        gist: beats[i],
        actors: [],
        heldAt: T0 + i,
        salience: 0.2 + i * 0.05,
      }, makeId);
    }
    expect(liveWorking(b, T0 + 8)).toHaveLength(WORKING_CAPACITY);
    // Highest salience survives.
    expect(b.working!.some((s) => s.gist.includes('portrait'))).toBe(true);
  });

  it('drops a slot that has gone cold', () => {
    const b = emptyBrain('c', 'x', 'Wren', T0);
    holdInMind(b, { gist: 'an old beat from earlier', actors: [], heldAt: T0, salience: 0.9 }, makeId);
    evictWorking(b, T0 + WORKING_TTL_MS + 1);
    expect(b.working).toHaveLength(0);
  });

  it('picks up recent turns as the scene buffer', () => {
    const b = emptyBrain('c', 'x', 'Wren', T0);
    holdRecentTurns(b, [
      { speaker: 'Rooke', text: 'Did you read it?' },
      { speaker: 'Wren', text: 'I have not opened it yet.' },
    ], T0, makeId);
    expect(liveWorking(b, T0).length).toBeGreaterThan(0);
  });
});
