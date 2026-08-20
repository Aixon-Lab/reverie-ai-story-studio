/**
 * Author's Note expand: the slider must change the length contract and the
 * amount of scene/card context the model actually sees.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types';
import {
  AUTHORS_NOTE_RICHNESS,
  DEFAULT_AUTHORS_NOTE_RICHNESS,
  authorsNoteExpandPrompt,
  authorsNoteExpandRetryPrompt,
  authorsNoteNeedsRetry,
  authorsNoteWordCount,
  clampAuthorsNoteRichness,
  authorsNoteMetaLeak,
  authorsNoteDemetaPrompt,
  stripAuthorsNoteMeta,
} from './agents';

function msg(name: string, text: string): ChatMessage {
  return {
    id: name,
    ts: 1,
    speaker: { type: 'character', displayName: name },
    controlledBy: 'ai',
    text,
  };
}

const longSeed = Array.from({ length: 40 }, (_, i) => `clause-${i}`).join(' ');

describe('richness slider', () => {
  it('defaults to Rich so expansions are no longer the short 80–220 band', () => {
    expect(DEFAULT_AUTHORS_NOTE_RICHNESS).toBe(4);
    expect(AUTHORS_NOTE_RICHNESS[4].minWords).toBeGreaterThan(500);
  });

  it('clamps junk to the default instead of crashing', () => {
    expect(clampAuthorsNoteRichness(undefined)).toBe(4);
    expect(clampAuthorsNoteRichness(0)).toBe(1);
    expect(clampAuthorsNoteRichness(99)).toBe(5);
    expect(clampAuthorsNoteRichness('3')).toBe(3);
  });
});

describe('length contract is in the prompt', () => {
  it('asks for more words at Max than at Brief, and always more than the seed', () => {
    const brief = authorsNoteExpandPrompt({
      seed: longSeed,
      cast: [{ name: 'Vex', description: 'A blade.', personality: 'Dry.', scenario: 'Rain.' }],
      history: [],
      isGroup: false,
      richness: 1,
    });
    const max = authorsNoteExpandPrompt({
      seed: longSeed,
      cast: [{ name: 'Vex', description: 'A blade.', personality: 'Dry.', scenario: 'Rain.' }],
      history: [],
      isGroup: false,
      richness: 5,
    });

    expect(brief.system).toContain('AT LEAST 90 words');
    expect(max.system).toContain('AT LEAST 900 words');
    expect(max.system).toContain('longer than the human seed');
    expect(authorsNoteWordCount(longSeed)).toBe(40);
    expect(brief.system).toContain('40 words');
    expect(brief.user).toContain(longSeed);
    expect(brief.user).toContain('do not shrink it');
  });

  it('grounds the note in seed, cards, summary, director, and transcript', () => {
    const history = [
      msg('Vex', 'She sets the glass down hard enough to ring.'),
      msg('Ada', 'We still have the letter from Northline.'),
    ];
    const p = authorsNoteExpandPrompt({
      seed: 'keep the distrust sharp',
      existingNote: 'old note',
      cast: [{
        name: 'Vex',
        description: 'Scar across the left brow, always wet coat.',
        personality: 'Does not forgive easily.',
        scenario: 'A dockside bar after the raid.',
        creator_notes: 'Never make her cute.',
      }],
      personaName: 'Mara',
      personaDescription: 'Tired courier with a limp.',
      history,
      isGroup: true,
      richness: 4,
      summary: 'They fled Northline after the ledger burned.',
      scenarioOverride: 'Midnight on the quay.',
      director: {
        nudge: { text: 'Someone is listening at the door', intensity: 3, setAtMessage: 2 },
        sceneGoal: { text: 'Get the letter read aloud', status: 'active' },
      },
    });

    expect(p.user).toContain('keep the distrust sharp');
    expect(p.user).toContain('Scar across the left brow');
    expect(p.user).toContain('Does not forgive easily');
    expect(p.user).toContain('Never make her cute');
    expect(p.user).toContain('Mara');
    expect(p.user).toContain('Tired courier');
    expect(p.user).toContain('They fled Northline');
    expect(p.user).toContain('Midnight on the quay');
    expect(p.user).toContain('Someone is listening at the door');
    expect(p.user).toContain('Get the letter read aloud');
    expect(p.user).toContain('the letter from Northline');
    expect(p.user).toContain('glass down hard');
    expect(p.system).toContain('GROUP scene');
  });

  it('sends more card text at higher richness', () => {
    const description = 'X'.repeat(2000);
    const brief = authorsNoteExpandPrompt({
      seed: 'tone',
      cast: [{ name: 'Vex', description, personality: '', scenario: '' }],
      history: [],
      isGroup: false,
      richness: 1,
    });
    const rich = authorsNoteExpandPrompt({
      seed: 'tone',
      cast: [{ name: 'Vex', description, personality: '', scenario: '' }],
      history: [],
      isGroup: false,
      richness: 5,
    });
    const briefXs = (brief.user.match(/X/g) ?? []).length;
    const richXs = (rich.user.match(/X/g) ?? []).length;
    expect(richXs).toBeGreaterThan(briefXs);
    expect(briefXs).toBeLessThanOrEqual(AUTHORS_NOTE_RICHNESS[1].descChars);
  });
});

describe('too-short drafts retry', () => {
  it('retries when a short seed was supposed to grow and the draft is still shorter', () => {
    expect(authorsNoteNeedsRetry('too short', longSeed, 4)).toBe(true);
  });

  it('does not force Brief to outrun an already-long seed — the slider wins', () => {
    const longNote = Array.from({ length: 400 }, (_, i) => `keep-${i}`).join(' ');
    const briefEnough = Array.from({ length: 100 }, (_, i) => `ok-${i}`).join(' ');
    expect(authorsNoteNeedsRetry(briefEnough, longNote, 1)).toBe(false);
  });

  it('retries when the draft is well under the slider floor', () => {
    const short = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    expect(authorsNoteNeedsRetry(short, 'keep tension', 5)).toBe(true);
    expect(authorsNoteNeedsRetry(short, 'keep tension', 1)).toBe(false);
  });

  it('asks the retry pass to meet the same word floor', () => {
    const p = authorsNoteExpandRetryPrompt({
      seed: 'keep the distrust sharp',
      draft: 'Vex should stay wary.',
      richness: 4,
    });
    expect(p.system).toContain('AT LEAST 600 words');
    expect(p.user).toContain('Vex should stay wary');
    expect(p.user).toContain('keep the distrust sharp');
  });
});

describe('the note never narrates its own inputs', () => {
  it('bans seed/prompt talk in both the first pass and the retry', () => {
    const p = authorsNoteExpandPrompt({
      seed: 'she is hiding a knife',
      cast: [{ name: 'Vex', description: '', personality: '', scenario: '' }],
      history: [],
      isGroup: false,
      richness: 3,
    });
    expect(p.system).toContain('NEVER refer to your own inputs');
    expect(p.system).toContain('"the seed"');
    const retry = authorsNoteExpandRetryPrompt({ seed: 'x', draft: 'y', richness: 3 });
    expect(retry.system).toContain('NEVER refer to your own inputs');
  });

  it('detects the phrasings users actually see', () => {
    expect(authorsNoteMetaLeak('As the seed mentions, Vex distrusts him.')).toBe(true);
    expect(authorsNoteMetaLeak('Based on the provided context, keep the tone cold.')).toBe(true);
    expect(authorsNoteMetaLeak('The user wants more tension in this scene.')).toBe(true);
    expect(authorsNoteMetaLeak('Per the instructions, do not resolve the fight.')).toBe(true);
    expect(authorsNoteMetaLeak('According to the summary, they fled Northline.')).toBe(true);
  });

  it('leaves clean guidance alone, including in-story mentions of seeds and prompts', () => {
    expect(authorsNoteMetaLeak('Vex keeps the knife hidden until the door opens.')).toBe(false);
    expect(authorsNoteMetaLeak('The seed vault under the quay is still flooded.')).toBe(false);
    expect(authorsNoteMetaLeak('Let silence prompt her to speak first.')).toBe(false);
  });

  it('scrubs only the offending sentences, and refuses if that guts the note', () => {
    const mixed = [
      'Vex keeps the knife hidden until the door opens.',
      'As the seed mentions, she distrusts him.',
      'Hold the dockside cold and let the letter stay unread for now.',
    ].join(' ');
    const out = stripAuthorsNoteMeta(mixed);
    expect(out).toContain('Vex keeps the knife hidden');
    expect(out).toContain('Hold the dockside cold');
    expect(out).not.toContain('As the seed mentions');

    const mostlyMeta = 'As the seed mentions, she distrusts him. Keep it cold.';
    expect(stripAuthorsNoteMeta(mostlyMeta)).toBe(mostlyMeta);
  });

  it('rewrite pass keeps the length contract and repeats the ban', () => {
    const p = authorsNoteDemetaPrompt({ draft: 'As the seed mentions, Vex distrusts him.', richness: 4 });
    expect(p.system).toContain('NEVER refer to your own inputs');
    expect(p.system).toContain('at least 600 words');
    expect(p.user).toContain('Vex distrusts him');
  });
});
