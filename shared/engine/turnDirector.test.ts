/**
 * Reading the Turn Director's answer.
 *
 * The director is a model, so its output is a suggestion, not a fact. These pin
 * the cases where accepting it uncritically ended a scene in silence: a pick the
 * group has switched off, a name nobody in the cast answers to, and a reasoning
 * model that thinks in JSON before it answers in JSON.
 */
import { describe, expect, it } from 'vitest';
import { parseTurnDecision } from './agents';

const CAST = ['Vex', 'Ada Lovelace'];

describe('picks the scene can honour', () => {
  it('accepts a cast member, case-insensitively', () => {
    const d = parseTurnDecision('{"next":"vex","reason":"They were asked a question."}', CAST);
    expect(d?.next).toBe('Vex');
    expect(d?.urgency).toBe('reply');
  });

  it('accepts USER', () => {
    expect(parseTurnDecision('{"next":"USER"}', CAST)?.next).toBe('USER');
  });

  it('rejects a name nobody answers to, so the caller can fall back', () => {
    expect(parseTurnDecision('{"next":"Nobody"}', CAST)).toBeNull();
  });
});

describe('options that are switched off are not options', () => {
  it('refuses NARRATOR when the group has no narrator', () => {
    expect(parseTurnDecision('{"next":"NARRATOR"}', CAST, { narratorEnabled: false })).toBeNull();
  });

  it('still allows NARRATOR when the group has one', () => {
    expect(parseTurnDecision('{"next":"NARRATOR"}', CAST, { narratorEnabled: true })?.next)
      .toBe('NARRATOR');
  });

  it('drops an unasked-for new character when Genesis is off', () => {
    const d = parseTurnDecision(
      '{"next":"Vex","new_character_needed":{"hint":"a bartender"}}',
      CAST,
      { genesisEnabled: false },
    );
    expect(d?.new_character_needed).toBeNull();
  });

  it('keeps it when Genesis is on', () => {
    const d = parseTurnDecision(
      '{"next":"Vex","new_character_needed":{"hint":"a bartender"}}',
      CAST,
      { genesisEnabled: true },
    );
    expect(d?.new_character_needed).toEqual({ hint: 'a bartender' });
  });
});

describe('alternates are names, not free text', () => {
  it('keeps only cast members', () => {
    const d = parseTurnDecision(
      '{"next":"Vex","alternates":["Ada Lovelace","USER","Someone Else"]}',
      CAST,
    );
    expect(d?.alternates).toEqual(['Ada Lovelace']);
  });
});

describe('a model that thinks out loud in JSON', () => {
  it('finds the answer object rather than spanning to the last brace', () => {
    const raw = [
      '{"thought":"Vex has not spoken in a while, and Ada just addressed them."}',
      'Here is my decision:',
      '{"next":"Vex","reason":"Ada addressed them directly.","urgency":"reply"}',
    ].join('\n');
    expect(parseTurnDecision(raw, CAST)?.next).toBe('Vex');
  });

  it('reads a fenced answer', () => {
    const raw = '```json\n{"next":"Ada Lovelace","reason":"Her turn."}\n```';
    expect(parseTurnDecision(raw, CAST)?.next).toBe('Ada Lovelace');
  });

  it('returns null on genuinely unusable output', () => {
    expect(parseTurnDecision('I think Vex should go next.', CAST)).toBeNull();
    expect(parseTurnDecision('', CAST)).toBeNull();
  });
});
