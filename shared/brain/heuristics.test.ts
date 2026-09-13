/**
 * The offline encoder takes actors straight from speaker names, which is why a
 * narrated beat used to attribute itself to "Narrator" — the one path where no
 * model is involved and nothing else was filtering the label out.
 */
import { describe, expect, it } from 'vitest';
import { heuristicEncode, turnLine, type TranscriptTurn } from './heuristics';

function turn(speaker: string, text: string, isNarration = false): TranscriptTurn {
  return { id: `${speaker}-${text.slice(0, 8)}`, speaker, text, isUser: false, isNarration };
}

describe('narration is story, not a speaker', () => {
  it('renders without a speaker label', () => {
    expect(turnLine(turn('Narrator', 'The door closed.', true))).toBe('[narration] The door closed.');
    expect(turnLine(turn('Wren', 'Get out.'))).toBe('Wren: Get out.');
  });

  it('never lands in the actor list', () => {
    const events = heuristicEncode([
      turn('Narrator', 'The lamp guttered. Somewhere below, a door slammed and stayed shut.', true),
      turn('Rooke', 'You betrayed me. You lied and I trusted you and now she is dead.'),
      turn('Wren', 'I did what I had to do. I am sorry. I am so sorry.'),
    ], 'Wren');

    expect(events.length).toBeGreaterThan(0);
    const actors = events.flatMap((e) => e.actors);
    expect(actors).toContain('Rooke');
    expect(actors.map((a) => a.toLowerCase())).not.toContain('narrator');
  });

  it('still encodes what the narration described', () => {
    const events = heuristicEncode([
      turn('Narrator', 'The fire took the east wing. By dawn there was nothing left to save.', true),
    ], 'Wren');
    expect(events.length).toBe(1);
    // No "Narrator:" prefix on the gist — the gist is the event itself.
    expect(events[0].gist).not.toMatch(/^narrator:/i);
    expect(events[0].gist).toMatch(/fire/i);
  });
});
