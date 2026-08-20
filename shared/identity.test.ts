import { describe, it, expect } from 'vitest';
import { humanSeatId, humanSeatIds, personaCharacterId, personaIdForCharacter } from './engine/identity';
import type { Persona } from './types';

const members = [
  { id: 'danny', name: 'Danny Rooke' },
  { id: 'rebecca', name: 'Rebecca' },
  { id: 'wren', name: 'Wren' },
];

const persona = (over: Partial<Persona>): Persona => ({
  id: 'p-1', name: 'Alex', description: '', ...over,
});

describe('persona ↔ character identity', () => {
  it('reads the character id back out of a minted persona', () => {
    expect(personaCharacterId(persona({ id: personaIdForCharacter('danny') }))).toBe('danny');
    expect(personaCharacterId(persona({ id: 'p-1' }))).toBeNull();
    expect(personaCharacterId(persona({ id: 'from-' }))).toBeNull();
  });

  it('claims the cast seat of the character you became', () => {
    const seats = humanSeatIds({
      members,
      playAs: null,
      persona: persona({ id: personaIdForCharacter('danny'), name: 'Danny Rooke' }),
    });
    expect(seats).toEqual(['danny']);
  });

  it('matches by name when the persona was not minted from the card', () => {
    const seats = humanSeatIds({ members, playAs: null, persona: persona({ name: 'rebecca ' }) });
    expect(seats).toEqual(['rebecca']);
  });

  it('holds both the play-as seat and the persona seat, without duplicates', () => {
    expect(
      humanSeatIds({ members, playAs: 'wren', persona: persona({ id: personaIdForCharacter('danny') }) }),
    ).toEqual(['wren', 'danny']);
    expect(
      humanSeatIds({ members, playAs: 'danny', persona: persona({ id: personaIdForCharacter('danny') }) }),
    ).toEqual(['danny']);
  });

  it('ignores seats that are not in the cast', () => {
    expect(
      humanSeatIds({ members, playAs: 'ghost', persona: persona({ id: personaIdForCharacter('nobody') }) }),
    ).toEqual([]);
  });

  it('names the persona as the seat that is you when play-as disagrees', () => {
    expect(
      humanSeatId({ members, playAs: 'wren', persona: persona({ id: personaIdForCharacter('danny') }) }),
    ).toBe('danny');
    expect(humanSeatId({ members, playAs: 'wren', persona: persona({ name: 'Alex' }) })).toBe('wren');
    expect(humanSeatId({ members, playAs: null, persona: persona({ name: 'Alex' }) })).toBeNull();
  });
});
