/**
 * Load-time healing of brains already on disk.
 *
 * Each of these pins a bug that was silently corrupting live characters rather
 * than throwing: a self-relationship in the People list, and a mis-calibrated
 * default that stored brains kept forever because stored params win over
 * defaults.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, normalizeBrain } from './defaults';
import { isSelf } from './consolidation';
import type { BrainState, RelationModel } from './types';

function rel(key: string, displayName: string): RelationModel {
  return {
    key, displayName, trust: 0.2, affection: 0.1, fear: 0, respect: 0,
    resentment: 0, debt: 0, familiarity: 0.5, model: '', interactions: 4,
    firstMetAt: 1, lastSeenAt: 2,
  };
}

function load(raw: Partial<BrainState>, name = 'Scarlet Wren') {
  return normalizeBrain(raw, 'chat', 'char', name);
}

describe('a character never knows themselves as another person', () => {
  it('drops the self-relation an older pass recorded', () => {
    const brain = load({
      characterName: 'Scarlet Wren',
      people: {
        'scarlet wren': rel('scarlet wren', 'Scarlet Wren'),
        'jonas rooke': rel('jonas rooke', 'Jonas Rooke'),
      },
    });
    expect(Object.keys(brain.people)).toEqual(['jonas rooke']);
  });

  /**
   * A first-name-only entry is ambiguous, and load is the wrong place to guess.
   *
   * "Wren" is either Scarlet Wren shortened by the encoder or an NPC actually
   * called Wren, and nothing on disk distinguishes them. Loading must therefore
   * keep it — deleting a real person's relationship is unrecoverable, keeping a
   * stale self-entry for one more pass is not. `consolidate()` resolves it for
   * real, because by then the cast is known.
   */
  it('keeps an ambiguous first-name entry rather than guessing at load', () => {
    const brain = load({
      characterName: 'Scarlet Wren',
      people: { wren: rel('wren', 'Wren'), rooke: rel('rooke', 'Rooke') },
    });
    expect(Object.keys(brain.people).sort()).toEqual(['rooke', 'wren']);
  });

  it('keeps people whose names merely overlap', () => {
    const brain = load({
      characterName: 'Scarlet Wren',
      people: { 'wren ashby': rel('wren ashby', 'Wren Ashby') },
    });
    expect(Object.keys(brain.people)).toEqual(['wren ashby']);
  });

  it('matches the encoder-side guard', () => {
    const brain = load({ characterName: 'Scarlet Wren' });
    expect(isSelf(brain, 'Scarlet Wren')).toBe(true);
    expect(isSelf(brain, 'wren')).toBe(true);
    expect(isSelf(brain, 'WREN')).toBe(true);
    expect(isSelf(brain, 'Rooke')).toBe(false);
    // A blank actor is nobody, and must never open a relationship.
    expect(isSelf(brain, '  ')).toBe(true);
  });

  it('does not match a two-letter name fragment', () => {
    const brain = load({ characterName: 'Jo Vance' }, 'Jo Vance');
    expect(isSelf(brain, 'Jo')).toBe(false);
    expect(isSelf(brain, 'Vance')).toBe(true);
  });
});

describe('superseded parameter defaults are migrated, tuned values are not', () => {
  it('replaces the old drift rate that made personality change invisible', () => {
    const brain = load({ config: { params: { driftRate: 0.035 } } as never });
    expect(brain.config.params.driftRate).toBe(DEFAULT_PARAMS.driftRate);
    expect(DEFAULT_PARAMS.driftRate).toBeGreaterThan(0.035);
  });

  it('replaces the old encode threshold', () => {
    const brain = load({ config: { params: { encodeThreshold: 0.22 } } as never });
    expect(brain.config.params.encodeThreshold).toBe(DEFAULT_PARAMS.encodeThreshold);
  });

  it('leaves a value the user deliberately chose', () => {
    const brain = load({ config: { params: { driftRate: 0.9, encodeThreshold: 0.5 } } as never });
    expect(brain.config.params.driftRate).toBe(0.9);
    expect(brain.config.params.encodeThreshold).toBe(0.5);
  });

  it('fills in every parameter a stored brain is missing', () => {
    const brain = load({});
    for (const key of Object.keys(DEFAULT_PARAMS)) {
      expect(brain.config.params[key as keyof typeof DEFAULT_PARAMS]).toBeTypeOf('number');
    }
  });
});
