/**
 * Portrait gallery rules.
 *
 * The file copying is uninteresting; these two decisions are not. Both exist to
 * stop the gallery doing something a user would experience as data loss: going
 * faceless after a delete, or having the portrait they are looking at silently
 * evicted to make room.
 */
import { describe, expect, it } from 'vitest';
import { pickEvictionVictim, promoteAfterDelete } from './routes/library';
import { MAX_CHARACTER_PHOTOS } from '../shared/types';

const photo = (id: string, addedAt: number) => ({ id, addedAt });

describe('promoteAfterDelete', () => {
  it('promotes the photo that slid into the removed slot', () => {
    const remaining = [photo('a', 1), photo('c', 3), photo('d', 4)];
    // 'b' was at index 1; 'c' now occupies it.
    expect(promoteAfterDelete(remaining, 1)?.id).toBe('c');
  });

  it('falls back to the previous one when the last photo was removed', () => {
    const remaining = [photo('a', 1), photo('b', 2)];
    expect(promoteAfterDelete(remaining, 2)?.id).toBe('b');
  });

  it('returns nothing when the gallery is now empty', () => {
    expect(promoteAfterDelete([], 0)).toBeUndefined();
  });
});

describe('pickEvictionVictim', () => {
  it('never evicts the photo currently on display', () => {
    const photos = [photo('old', 1), photo('mid', 2), photo('new', 3)];
    // 'old' is the oldest, but it is what the user is looking at.
    expect(pickEvictionVictim(photos, 'old')?.id).toBe('mid');
  });

  it('evicts the oldest of the rest', () => {
    const photos = [photo('a', 5), photo('b', 2), photo('c', 9)];
    expect(pickEvictionVictim(photos, 'c')?.id).toBe('b');
  });

  it('falls back to the active one only when it is the sole photo', () => {
    expect(pickEvictionVictim([photo('only', 1)], 'only')?.id).toBe('only');
  });

  it('handles an empty gallery', () => {
    expect(pickEvictionVictim([], undefined)).toBeUndefined();
  });
});

describe('the cap', () => {
  it('is thirty', () => {
    // Stated in the type so the server, the client and the UI copy cannot drift.
    expect(MAX_CHARACTER_PHOTOS).toBe(30);
  });
});
