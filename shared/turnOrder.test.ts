import { describe, it, expect } from 'vitest';
import {
  canSpeak, cursorAfterId, nextSpeakerId, normalizeCursor, reanchorCursor, type SeatContext,
} from './engine/turnOrder';

const cast = ['you', 'rebecca', 'wren'];
const ctx = (over: Partial<SeatContext> = {}): SeatContext => ({
  order: cast,
  present: cast,
  muted: [],
  human: ['you'],
  cursor: 0,
  ...over,
});

describe('series turn order', () => {
  it('walks over your own seat instead of ending the round', () => {
    // Cursor sits on the player: the reply must come from the next AI, not nobody.
    expect(nextSpeakerId(ctx({ cursor: 0 }))).toBe('rebecca');
  });

  it('walks over muted and deleted seats', () => {
    expect(nextSpeakerId(ctx({ cursor: 1, muted: ['rebecca'] }))).toBe('wren');
    expect(nextSpeakerId(ctx({ cursor: 1, present: ['you', 'wren'] }))).toBe('wren');
  });

  it('wraps around the cast exactly once', () => {
    expect(nextSpeakerId(ctx({ cursor: 2 }))).toBe('wren');
    expect(nextSpeakerId(ctx({ cursor: 2, muted: ['wren'] }))).toBe('rebecca');
  });

  it('returns null when nobody can speak', () => {
    expect(nextSpeakerId(ctx({ muted: ['rebecca', 'wren'] }))).toBeNull();
    expect(nextSpeakerId(ctx({ human: ['you', 'rebecca', 'wren'] }))).toBeNull();
    expect(nextSpeakerId(ctx({ order: [], present: [] }))).toBeNull();
    expect(nextSpeakerId(ctx({ order: ['you'], present: ['you'] }))).toBeNull();
  });

  it('survives a cursor that points nowhere real', () => {
    expect(normalizeCursor(undefined, 3)).toBe(0);
    expect(normalizeCursor(-1, 3)).toBe(2);
    expect(normalizeCursor(7, 3)).toBe(1);
    expect(normalizeCursor(0, 0)).toBe(0);
    expect(nextSpeakerId(ctx({ cursor: 99 }))).toBe('rebecca'); // 99 → seat 0 (you) → next AI
    expect(nextSpeakerId(ctx({ cursor: -4 }))).toBe('wren'); // -4 → seat 2
  });

  it('never offers a seat it just rejected', () => {
    const c = ctx({ muted: ['wren'] });
    expect(canSpeak(c, 'wren')).toBe(false);
    expect(canSpeak(c, 'you')).toBe(false);
    expect(canSpeak(c, 'ghost')).toBe(false);
    expect(canSpeak(c, 'rebecca')).toBe(true);
  });

  it('resumes after a forced speaker, wrapping at the end', () => {
    expect(cursorAfterId(cast, 'rebecca')).toBe(2);
    expect(cursorAfterId(cast, 'wren')).toBe(0);
    expect(cursorAfterId(cast, 'ghost')).toBeNull();
  });

  it('keeps the turn on the same character when the roster is reordered', () => {
    // Cursor on 'wren' (index 2); wren moves to the front.
    expect(reanchorCursor(cast, ['wren', 'you', 'rebecca'], 2)).toBe(0);
  });

  it('hands the turn to the next survivor when the cursor holder is removed', () => {
    // Cursor on 'rebecca', who is removed → 'wren' was next in the old order.
    expect(reanchorCursor(cast, ['you', 'wren'], 1)).toBe(1);
    // Cursor on the last seat, removed → wraps to 'you'.
    expect(reanchorCursor(cast, ['you', 'rebecca'], 2)).toBe(0);
  });

  it('falls back to the front when nothing survives', () => {
    expect(reanchorCursor(cast, ['newcomer'], 1)).toBe(0);
    expect(reanchorCursor([], ['a'], 0)).toBe(0);
    expect(reanchorCursor(cast, [], 0)).toBe(0);
  });
});
