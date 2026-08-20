import { describe, expect, it } from 'vitest';
import { emptyBrain } from './defaults';
import { ensureRelation } from './personality';
import {
  canonicalizeActors, isPronoun, learnPerson, registerAlias, resolvePerson,
} from './entities';

const T0 = 1_700_000_000_000;

describe('entity canonicalisation (§B.2 #33)', () => {
  it('does not treat a pronoun as a person', () => {
    expect(isPronoun('she')).toBe(true);
    expect(isPronoun('Wren')).toBe(false);
  });

  it('folds a unique first name into the full name already known', () => {
    const b = emptyBrain('c', 'x', 'Seraphina', T0);
    ensureRelation(b, 'Miss Vale', T0);
    b.people['miss vale'].displayName = 'Wren Vale';

    const key = learnPerson(b, 'Wren');
    expect(key).toBe('miss vale');
    expect(resolvePerson(b, 'Wren')).toBe('miss vale');
  });

  it('does not fold an exact cast member into someone with a longer name', () => {
    const b = emptyBrain('c', 'x', 'Scarlet Wren', T0);
    expect(learnPerson(b, 'Wren', { cast: ['Scarlet Wren', 'Wren'] })).toBe('wren');
    expect(b.aliases?.['wren']).toBeUndefined();
  });

  it('refuses to merge two real people who share a token', () => {
    const b = emptyBrain('c', 'x', 'Seraphina', T0);
    ensureRelation(b, 'Wren Vale', T0);
    ensureRelation(b, 'Wren Rooke', T0);
    // "Wren" is now ambiguous.
    expect(learnPerson(b, 'Wren', { cast: ['Wren Vale', 'Wren Rooke'] })).toBe('wren');
    expect(b.aliases?.['wren']).toBeUndefined();
  });

  it('merges relationship records when an alias is registered', () => {
    const b = emptyBrain('c', 'x', 'Seraphina', T0);
    const a = ensureRelation(b, 'Wren', T0);
    a.trust = -0.6;
    a.interactions = 3;
    const c = ensureRelation(b, 'Miss Vale', T0);
    c.trust = -0.2;
    c.interactions = 1;
    registerAlias(b, 'Wren', 'Miss Vale');
    expect(b.people['wren']).toBeUndefined();
    expect(b.people['miss vale'].interactions).toBe(4);
    expect(b.people['miss vale'].trust).toBeCloseTo(-0.6);
  });

  it('canonicalises an actor list without inventing pronouns', () => {
    const b = emptyBrain('c', 'x', 'Seraphina', T0);
    ensureRelation(b, 'Miss Vale', T0);
    b.people['miss vale'].displayName = 'Wren Vale';
    const actors = canonicalizeActors(b, ['Wren', 'she', 'Rooke']);
    expect(actors.some((a) => /wren|vale/i.test(a))).toBe(true);
    expect(actors.some((a) => a.toLowerCase() === 'she')).toBe(false);
    expect(actors).toContain('Rooke');
  });
});
