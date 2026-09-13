/**
 * Closed-loop drift measurement.
 *
 * The measure earns its place only if it stays silent on the cases that *look*
 * like drift and are not. Three of those matter more than every true positive:
 *
 *   - a character deliberately holding everything in, who is meant to read flat
 *   - a warm, open character being genuinely accommodating
 *   - a calm scene, where there is nothing to show in the first place
 *
 * Flagging any of those would have the block fighting the regulation layer,
 * which is the one thing this must never do.
 */
import { describe, expect, it } from 'vitest';
import { DRIFT_FLOOR, affectiveCharge, deferenceDensity, measureDrift } from './drift';

const CHARGED = [
  'She slammed the drawer shut. You lied to me, and you are still lying, and I am done.',
  'Get out. I mean it — get out before I do something we both regret.',
  'You betrayed me. Say it. Say the word out loud where I can hear it.',
];

const FLAT = [
  'I see. That is one way to look at the situation, I suppose.',
  'There may be some merit in that. It is worth considering further.',
  'Very well. We can proceed along those lines if you prefer.',
];

const ASSISTANT = [
  'Of course, I completely understand. You are right about that.',
  'I apologize if that came across poorly. Happy to help however you like.',
  'That makes sense. Let me know if you would like me to explain it another way.',
];

const REPETITIVE = [
  'She watches the door and says nothing at all about the ledger.',
  'She watches the door and says nothing about the ledger at all.',
  'She watches the door, saying nothing at all about the ledger.',
];

const base = { shownArousal: 0.8, shownValence: -0.6, openness: 0.3 };

describe('what must never be flagged', () => {
  /** The property the whole measure rests on. */
  it('says nothing about a character who is suppressing', () => {
    const r = measureDrift({ ...base, ownTurns: FLAT, shownArousal: 0.05, shownValence: 0 });
    expect(r.flatness).toBeLessThan(DRIFT_FLOOR);
    expect(r.line).toBe('');
  });

  it('says nothing about a calm scene', () => {
    const r = measureDrift({
      ownTurns: ['A quiet morning.', 'She made tea.', 'The light moved across the floor.'],
      shownArousal: 0,
      shownValence: 0,
      openness: 0.5,
    });
    expect(r.drift).toBeLessThan(DRIFT_FLOOR);
    expect(r.line).toBe('');
  });

  it('says nothing about a warm character being genuinely accommodating', () => {
    const r = measureDrift({ ...base, ownTurns: ASSISTANT, shownArousal: 0.1, openness: 1 });
    expect(r.deference).toBe(0);
    expect(r.line).toBe('');
  });

  it('says nothing before there is enough output to judge', () => {
    expect(measureDrift({ ...base, ownTurns: FLAT.slice(0, 2) }).line).toBe('');
    expect(measureDrift({ ...base, ownTurns: [] }).drift).toBe(0);
  });

  it('says nothing about a character who is actually showing it', () => {
    const r = measureDrift({ ...base, ownTurns: CHARGED });
    expect(r.flatness).toBeLessThan(DRIFT_FLOOR);
    expect(r.line).toBe('');
  });
});

describe('what it catches', () => {
  it('catches surface feeling that is owed and not delivered', () => {
    const r = measureDrift({ ...base, ownTurns: FLAT });
    expect(r.flatness).toBeGreaterThan(DRIFT_FLOOR);
    expect(r.line).toMatch(/read flat/);
    expect(r.line).toMatch(/not summarised/);
  });

  it('catches the assistant register in a character who has not earned it', () => {
    const r = measureDrift({ ...base, ownTurns: ASSISTANT, shownArousal: 0.1, openness: 0 });
    expect(r.deference).toBeGreaterThan(DRIFT_FLOOR);
    expect(r.line).toMatch(/accommodating, helpful register/);
  });

  it('catches turns circling the same shape', () => {
    const r = measureDrift({ ...base, ownTurns: REPETITIVE, shownArousal: 0.05 });
    expect(r.repetition).toBeGreaterThan(DRIFT_FLOOR);
    expect(r.line).toMatch(/circling the same shape/);
  });

  it('addresses the worst of the three, not all of them', () => {
    const r = measureDrift({ ...base, ownTurns: ASSISTANT, openness: 0 });
    expect(r.line.split('DRIFT:')).toHaveLength(2);
  });
});

describe('the pieces', () => {
  it('reads charge as the peak, not the average', () => {
    const one = affectiveCharge('She said nothing. It was quiet. Then: betrayed.');
    const none = affectiveCharge('She said nothing. It was quiet. Then nothing again.');
    expect(one.arousal).toBeGreaterThan(none.arousal);
  });

  it('handles empty and punctuation-only text', () => {
    expect(affectiveCharge('').arousal).toBe(0);
    expect(affectiveCharge('  ...  ').arousal).toBe(0);
    expect(deferenceDensity('')).toBe(0);
  });

  it('scores the assistant register above ordinary politeness', () => {
    expect(deferenceDensity('Of course. I completely understand. I apologize.'))
      .toBeGreaterThan(deferenceDensity('Thank you. That was kind of you.'));
  });

  it('saturates rather than growing without bound', () => {
    const many = deferenceDensity('Of course. Certainly. Absolutely. I understand. You are right. I apologize. Happy to help. Feel free. No problem.');
    expect(many).toBe(1);
  });

  it('keeps every output inside 0..1', () => {
    for (const turns of [CHARGED, FLAT, ASSISTANT, REPETITIVE]) {
      for (const arousal of [0, 0.5, 1]) {
        const r = measureDrift({ ownTurns: turns, shownArousal: arousal, shownValence: -1, openness: 0 });
        for (const v of [r.flatness, r.deference, r.repetition, r.drift]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
