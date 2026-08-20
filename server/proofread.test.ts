/**
 * `cleanProofread` is the last line of defence for the Fix-spelling button.
 *
 * The feature's whole promise is "it does not write for you", so a model that
 * ignores the brief and continues the scene must never have its output pasted
 * over the user's draft. When in doubt, the original wins.
 */
import { describe, expect, it } from 'vitest';
import { cleanProofread } from './routes/generate';

describe('cleanProofread', () => {
  const original = 'i steped forwerd and grabed her wrist';

  it('returns the correction', () => {
    expect(cleanProofread('I stepped forward and grabbed her wrist.', original))
      .toBe('I stepped forward and grabbed her wrist.');
  });

  it('strips code fences', () => {
    expect(cleanProofread('```\nI stepped forward.\n```', original)).toBe('I stepped forward.');
  });

  it('strips a chatty preamble', () => {
    expect(cleanProofread('Here is the corrected message: I stepped forward.', original))
      .toBe('I stepped forward.');
    expect(cleanProofread('Sure! Corrected text:\nI stepped forward.', original))
      .toBe('I stepped forward.');
  });

  it('unwraps a whole-answer quote the model added', () => {
    expect(cleanProofread('"I stepped forward."', original)).toBe('I stepped forward.');
  });

  it('keeps roleplay dialogue quotes the writer used', () => {
    const dialogue = '"dont touch me" *she snarled*';
    const fixed = '"Don\'t touch me." *She snarled.*';
    expect(cleanProofread(fixed, dialogue)).toBe(fixed);
  });

  it('keeps quotes when the whole draft was one quoted line', () => {
    const quoted = '"dont you dare"';
    expect(cleanProofread('"Don\'t you dare."', quoted)).toBe('"Don\'t you dare."');
  });

  it('allows closing an unfinished thought', () => {
    const unfinished = 'I reach for the vial and';
    const completed = 'I reach for the vial and twist the cap open.';
    expect(cleanProofread(completed, unfinished)).toBe(completed);
  });

  it('rejects a model that continued the scene, keeping the draft intact', () => {
    const runaway =
      'I stepped forward and grabbed her wrist. She twisted away from me, vines '
      + 'erupting from the cracked stone as the mercenaries opened fire, and the whole '
      + 'chamber shook with the force of the collapsing ceiling while Kessler watched.';
    expect(cleanProofread(runaway, original)).toBe(original);
  });

  it('returns empty for an empty model response, so the caller can report it', () => {
    expect(cleanProofread('', original)).toBe('');
    expect(cleanProofread('   ```  ```  ', original)).toBe('');
  });

  it('does not reject legitimate growth on a very short draft', () => {
    // 1.8× of "no." is tiny; the 120-char floor is what keeps this usable.
    expect(cleanProofread('No.', 'no')).toBe('No.');
  });
});
