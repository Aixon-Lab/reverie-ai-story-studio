/**
 * Brain addressing.
 *
 * A mind is keyed by `(chatId, characterId)` — the invariant that keeps two
 * conversations with the same character from sharing a memory. These tests
 * touch no disk.
 */
import { describe, it, expect } from 'vitest';
import { brainKey, parseBrainKey } from './store';

describe('brain keys are chat-scoped', () => {
  it('round-trips a uuid chat id and a hyphenated character id', () => {
    const chatId = '0040172b-1368-477e-9207-76e391d76cd5';
    const characterId = 'Scarlet Wren-9dff4016';
    const key = brainKey(chatId, characterId);
    expect(parseBrainKey(key)).toEqual({ chatId, characterId });
  });

  it('gives the same character a different key in a different chat', () => {
    const a = brainKey('chat-a', 'Sera-1234');
    const b = brainKey('chat-b', 'Sera-1234');
    expect(a).not.toBe(b);
    expect(parseBrainKey(a)!.characterId).toBe(parseBrainKey(b)!.characterId);
    expect(parseBrainKey(a)!.chatId).not.toBe(parseBrainKey(b)!.chatId);
  });

  it('survives hyphens in the character id without splitting early', () => {
    const parsed = parseBrainKey(brainKey('c-1', 'a-b-c-d'));
    expect(parsed).toEqual({ chatId: 'c-1', characterId: 'a-b-c-d' });
  });

  it('rejects malformed keys rather than guessing', () => {
    expect(parseBrainKey('no-separator-here')).toBeNull();
    expect(parseBrainKey('__onlyright')).toBeNull();
    expect(parseBrainKey('onlyleft__')).toBeNull();
  });

  it('refuses path traversal in either half', () => {
    expect(() => brainKey('../../etc', 'x')).toThrow();
    expect(() => brainKey('chat', '../secrets')).toThrow();
  });
});
