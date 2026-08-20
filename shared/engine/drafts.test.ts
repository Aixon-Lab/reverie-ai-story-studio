/**
 * Write Me — the one turn where the model speaks as the human player.
 *
 * Everything else in the prompt stack is built around "you are {{char}}", so
 * these tests pin the counter-measures: the POV override, the ban on voicing
 * the cast, the character-label stop strings, and the length slider.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCardPayload } from '../codec/png';
import { parseCard } from '../codec/card';
import { defaultPreset } from '../codec/preset';
import { buildPrompt, type BuildInput } from './promptBuilder';
import {
  DRAFT_LENGTH, clampDraftLength, DEFAULT_DRAFT_LENGTH,
  draftSeedCoverage, draftSeedWords, draftNeedsFidelityRetry, draftFidelityRetryPrompt,
  narratorCard,
} from './agents';
import type { Persona, WIEntry } from '../types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAYA = path.join(ROOT, 'server', 'defaults', 'default_Maya.png');

const persona: Persona = { id: 'p', name: 'Alex', description: 'A curious traveler.' };
const card = parseCard(readCardPayload(new Uint8Array(fs.readFileSync(MAYA))), 'maya');

const baseInput: BuildInput = {
  preset: defaultPreset(),
  card,
  persona,
  history: [
    {
      id: '1', ts: 1,
      speaker: { type: 'character', characterId: 'maya', displayName: 'Maya Calder' },
      controlledBy: 'ai', text: 'Welcome in — what broke?',
    },
    {
      id: '2', ts: 2,
      speaker: { type: 'user', displayName: 'Alex' },
      controlledBy: 'human', text: 'Where am I?',
    },
  ],
  wiEntries: [] as WIEntry[],
  model: 'test-model',
  wiSettings: {
    scanDepth: 4, budgetPercent: 25, recursive: true,
    caseSensitive: false, matchWholeWords: false, maxRecursionSteps: 3,
  },
};

const writeMe = (extra: Partial<BuildInput> = {}) =>
  buildPrompt({ ...baseInput, generationType: 'suggest_user', ...extra });

describe('write me — POV', () => {
  it('opens by overriding the character POV, naming the player as the speaker', () => {
    const plan = writeMe();
    const lock = plan.itemization.find((i) => i.source === 'identityLock');
    expect(lock).toBeTruthy();
    const first = plan.messages[0].content;
    expect(first).toContain('you are Alex');
    expect(first).toMatch(/SUSPENDED/);
  });

  it('forbids voicing the character by name, solo and in a group', () => {
    const solo = writeMe().messages.map((m) => m.content).join('\n');
    expect(solo).toContain('Maya Calder');
    expect(solo).toMatch(/NEVER write as, speak for, or narrate the inner thoughts of: Maya Calder/);

    const other = { ...card, id: 'other', name: 'Kael' };
    const group = writeMe({ group: { memberCards: [card, other] } })
      .messages.map((m) => m.content).join('\n');
    expect(group).toMatch(/Maya Calder, Kael/);
  });

  it('stops at every character label but never at the player\'s own', () => {
    const plan = writeMe();
    expect(plan.stops).toContain('\nMaya Calder:');
    expect(plan.stops).not.toContain('\nAlex:');
  });

  it('drops the card\'s post-history "stay in character" block', () => {
    const withJailbreak = {
      ...card,
      post_history_instructions: 'ALWAYS stay in character as Maya Calder and never write for the user.',
    };
    const joined = writeMe({ card: withJailbreak }).messages.map((m) => m.content).join('\n');
    expect(joined).not.toContain('ALWAYS stay in character as Maya Calder');
  });

  it('closes on the POV, after the format and length reminders', () => {
    const plan = writeMe();
    const sources = plan.itemization.map((i) => i.source);
    const anchor = sources.indexOf('draftAnchor');
    expect(anchor).toBeGreaterThan(-1);
    expect(anchor).toBeGreaterThan(sources.indexOf('suggestUserFinal'));
    expect(anchor).toBeGreaterThan(sources.indexOf('outputLengthCap'));
  });

  it('leaves normal character turns exactly as they were', () => {
    const plan = buildPrompt(baseInput);
    expect(plan.messages[0].content).not.toContain('you are Alex');
    expect(plan.stops).toContain('\nAlex:');
    expect(plan.itemization.some((i) => i.source === 'draftAnchor')).toBe(false);
  });
});

describe('write me — length slider', () => {
  it('clamps junk to the default', () => {
    expect(clampDraftLength(undefined)).toBe(DEFAULT_DRAFT_LENGTH);
    expect(clampDraftLength(0)).toBe(1);
    expect(clampDraftLength(99)).toBe(5);
    expect(clampDraftLength('2')).toBe(2);
  });

  it('grows monotonically so a higher tick is never a shorter draft', () => {
    const ticks = [1, 2, 3, 4, 5] as const;
    for (let i = 1; i < ticks.length; i++) {
      const prev = DRAFT_LENGTH[ticks[i - 1]];
      const next = DRAFT_LENGTH[ticks[i]];
      expect(next.targetWords).toBeGreaterThan(prev.targetWords);
      expect(next.maxTokens).toBeGreaterThan(prev.maxTokens);
    }
  });

  it('puts the chosen length in the prompt', () => {
    const brief = writeMe({ draftLength: 1 }).messages.map((m) => m.content).join('\n');
    const max = writeMe({ draftLength: 5 }).messages.map((m) => m.content).join('\n');
    expect(brief).toContain(DRAFT_LENGTH[1].sentences);
    expect(brief).toContain(`~${DRAFT_LENGTH[1].targetWords} words`);
    expect(max).toContain(DRAFT_LENGTH[5].sentences);
    expect(max).not.toContain(DRAFT_LENGTH[1].sentences);
  });

  it('falls back to the default when the caller sends nothing', () => {
    const joined = writeMe().messages.map((m) => m.content).join('\n');
    expect(joined).toContain(DRAFT_LENGTH[DEFAULT_DRAFT_LENGTH].sentences);
  });
});

describe('write me — the seed is canon', () => {
  const seed = 'I take the gun from the table and walk out the front door.';

  it('frames the seed as a script to render, not an intent to interpret', () => {
    const joined = writeMe({ userHint: seed }).messages.map((m) => m.content).join('\n');
    expect(joined).toContain(seed);
    expect(joined).toMatch(/CANON, NOT A SUGGESTION/);
    expect(joined).toMatch(/RENDER this, not to decide what happens/);
    // The named failure modes, because "be faithful" alone is what stopped working.
    expect(joined).toMatch(/second thoughts/);
    expect(joined).toMatch(/Do NOT reverse, soften, delay, qualify/);
    expect(joined).toMatch(/the script still wins/);
    expect(joined).toMatch(/Do NOT continue past the script's last beat/);
  });

  it('spends the length budget on detail rather than new events', () => {
    const joined = writeMe({ userHint: seed, draftLength: 5 }).messages.map((m) => m.content).join('\n');
    expect(joined).toMatch(/NEVER by adding events of your own/);
    expect(joined).toMatch(/sensory detail, body language/);
  });

  it('repeats the canon rule in the closing anchor', () => {
    const scripted = writeMe({ userHint: seed });
    const anchorIdx = scripted.itemization.findIndex((i) => i.source === 'draftAnchor');
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(scripted.messages.map((m) => m.content).join('\n')).toMatch(/script is canon/);
    expect(writeMe().messages.map((m) => m.content).join('\n')).not.toMatch(/script is canon/);
  });

  it('drops director orders that would argue with the script — but keeps them when there is none', () => {
    const director = {
      preAuthority: 'DIRECTOR: stall the departure this turn.',
      sceneWeave: 'DIRECTOR: the room should feel like a trap.',
      closingMandate: 'DIRECTOR: end on a question.',
    };
    const scripted = writeMe({ userHint: seed, director }).messages.map((m) => m.content).join('\n');
    expect(scripted).not.toContain('stall the departure');
    expect(scripted).not.toContain('end on a question');

    const freehand = writeMe({ director }).messages.map((m) => m.content).join('\n');
    expect(freehand).toContain('stall the departure');
    expect(freehand).toContain('end on a question');
  });

  it('keeps an unseeded draft free to choose the beat', () => {
    const joined = writeMe().messages.map((m) => m.content).join('\n');
    expect(joined).toMatch(/No seed was given/);
    expect(joined).not.toMatch(/CANON, NOT A SUGGESTION/);
  });

  it('sizes the length cap from the Write Me slider, not the preset reply budget', () => {
    const cap = writeMe({ draftLength: 5 }).itemization.find((i) => i.source === 'outputLengthCap');
    expect(cap?.preview).toContain(String(DRAFT_LENGTH[5].maxTokens));
  });
});

describe('write me — seed fidelity check', () => {
  const seed = 'I take the gun from the table and walk out the front door.';

  it('ignores stopwords when deciding what the seed was about', () => {
    const words = draftSeedWords(seed);
    expect(words).toContain('gun');
    expect(words).toContain('table');
    expect(words).toContain('door');
    expect(words).not.toContain('the');
    expect(words).not.toContain('from');
  });

  it('passes a faithful expansion, including inflected forms', () => {
    const draft = [
      'My hand closes around the gun where it lies on the scarred table,',
      'the metal still cold. I walk to the front door and step through it',
      'without looking back, the walking slow and deliberate.',
    ].join(' ');
    expect(draftSeedCoverage(seed, draft).coverage).toBeGreaterThan(0.8);
    expect(draftNeedsFidelityRetry(seed, draft)).toBe(false);
  });

  it('flags a draft that quietly wrote a different beat', () => {
    const drifted = 'I stay where I am, hands flat on my knees, and let the silence stretch between us.';
    expect(draftNeedsFidelityRetry(seed, drifted)).toBe(true);
    expect(draftSeedCoverage(seed, drifted).missing).toContain('gun');
  });

  it('does not second-guess short seeds, which survive as pure paraphrase', () => {
    expect(draftNeedsFidelityRetry('i fly', 'I launch off the ledge into open air.')).toBe(false);
    expect(draftNeedsFidelityRetry('', 'anything at all')).toBe(false);
  });

  it('tells the retry exactly what went missing', () => {
    const drifted = 'I stay where I am and say nothing.';
    const { missing } = draftSeedCoverage(seed, drifted);
    const p = draftFidelityRetryPrompt({ seed, missing, speakerName: 'Alex', kind: 'user' });
    expect(p).toContain(seed);
    expect(p).toContain('gun');
    expect(p).toMatch(/did not follow the player's script/);
    expect(p).toMatch(/no hesitation, no reversal/);
  });
});

describe('impersonate — one character, chosen and forced', () => {
  const other = { ...card, id: 'kael', name: 'Kael' };
  const imp = (extra: Partial<BuildInput> = {}) =>
    buildPrompt({ ...baseInput, generationType: 'impersonate', ...extra });

  it('writes as the card it was handed, and names everyone it may not voice', () => {
    const plan = imp({ group: { memberCards: [card, other] } });
    const joined = plan.messages.map((m) => m.content).join('\n');
    expect(joined).toContain("Write Maya Calder's NEXT full roleplay message");
    expect(joined).toMatch(/never write as, speak for, or narrate the thoughts of Kael, Alex/i);
    // The group identity lock still does its half of the job.
    expect(plan.messages[0].content).toContain('You are Maya Calder');
  });

  it('drafts as the chosen member when the picker hands over a different card', () => {
    const joined = imp({ card: other, group: { memberCards: [card, other] } })
      .messages.map((m) => m.content).join('\n');
    expect(joined).toContain("Write Kael's NEXT full roleplay message");
    expect(joined).toMatch(/narrate the thoughts of Maya Calder, Alex/i);
  });

  it('stops at the other speakers, never at its own label', () => {
    const plan = imp({ group: { memberCards: [card, other] } });
    expect(plan.stops).toContain('\nKael:');
    expect(plan.stops).toContain('\nAlex:');
    expect(plan.stops).not.toContain('\nMaya Calder:');
  });

  it('treats a seed as canon, with characterisation explicitly not a veto', () => {
    const seed = 'She takes the gun from the table and walks out the front door.';
    const joined = imp({ userHint: seed }).messages.map((m) => m.content).join('\n');
    expect(joined).toContain(seed);
    expect(joined).toMatch(/CANON, NOT A SUGGESTION/);
    expect(joined).toMatch(/Maya Calder wouldn't do that/);
    expect(joined).toMatch(/the card only defines how it looks and sounds/);
    expect(joined).toMatch(/NEVER by adding events of your own/);
  });

  it('keeps the free-choice beat when no script is given', () => {
    const joined = imp().messages.map((m) => m.content).join('\n');
    expect(joined).toMatch(/No script was given/);
    expect(joined).not.toMatch(/CANON, NOT A SUGGESTION/);
    // Director steers are useful precisely when the model is choosing.
    expect(
      imp({ director: { closingMandate: 'DIRECTOR: end on a question.' } })
        .messages.map((m) => m.content).join('\n'),
    ).toContain('end on a question');
  });

  it('drops director orders once the player has scripted the beat', () => {
    const joined = imp({
      userHint: 'She walks out.',
      director: { closingMandate: 'DIRECTOR: end on a question.' },
    }).messages.map((m) => m.content).join('\n');
    expect(joined).not.toContain('end on a question');
  });

  it('honours the shared length slider', () => {
    const joined = imp({ draftLength: 5 }).messages.map((m) => m.content).join('\n');
    expect(joined).toContain(DRAFT_LENGTH[5].sentences);
    const cap = imp({ draftLength: 5 }).itemization.find((i) => i.source === 'outputLengthCap');
    expect(cap?.preview).toContain(String(DRAFT_LENGTH[5].maxTokens));
  });

  it('closes on a character anchor, not the player one', () => {
    const joined = imp({ group: { memberCards: [card, other] } })
      .messages.map((m) => m.content).join('\n');
    expect(joined).toMatch(/FINAL CHECK — you are writing as Maya Calder, in first person, and as nobody else/);
    expect(joined).not.toMatch(/you are writing as Alex \(the human player\)/);
  });

  it('tells the character retry that personality governs style, not events', () => {
    const p = draftFidelityRetryPrompt({
      seed: 'She walks out.',
      missing: ['walks'],
      speakerName: 'Maya Calder',
      kind: 'character',
    });
    expect(p).toMatch(/never whether it happens/);
  });
});

/**
 * The Narrator panel shares the rail but not the draft contract.
 *
 * A narrator beat has no speaker to lock, so it must keep taking the narrator
 * identity lock and must never pick up the "you are writing as X" anchor the two
 * character drafts end on. What it does share is the length slider — and only
 * when the panel actually sent one, because automatic narration (turn director,
 * swipe, continue) has to keep the preset's own reply budget.
 */
describe('narrator — the shared length rail', () => {
  const narr = (extra: Partial<BuildInput> = {}) =>
    buildPrompt({ ...baseInput, card: narratorCard(), generationType: 'narrate', ...extra });

  it('puts the chosen length in the beat and caps output to match', () => {
    const plan = narr({ draftLength: 5 });
    const joined = plan.messages.map((m) => m.content).join('\n');
    expect(joined).toContain(DRAFT_LENGTH[5].sentences);
    expect(joined).toContain(`~${DRAFT_LENGTH[5].targetWords} words`);
    const cap = plan.itemization.find((i) => i.source === 'outputLengthCap');
    expect(cap?.preview).toContain(String(DRAFT_LENGTH[5].maxTokens));
  });

  it('overrides the narrator card\'s own "2–6 sentences" when the rail is driving', () => {
    const joined = narr({ draftLength: 1 }).messages.map((m) => m.content).join('\n');
    expect(joined).toMatch(/LENGTH \(overrides any other sentence count above\)/);
    expect(joined).toContain(DRAFT_LENGTH[1].sentences);
    expect(joined).not.toContain(DRAFT_LENGTH[5].sentences);
  });

  it('leaves automatic narration on the preset budget when no rail was sent', () => {
    const plan = narr();
    const joined = plan.messages.map((m) => m.content).join('\n');
    expect(joined).not.toMatch(/LENGTH \(overrides any other sentence count above\)/);
    for (const n of [1, 2, 3, 4, 5] as const) {
      expect(joined).not.toContain(DRAFT_LENGTH[n].sentences);
    }
    const cap = plan.itemization.find((i) => i.source === 'outputLengthCap');
    expect(cap?.preview).toContain(String(baseInput.preset.max_tokens));
  });

  it('stays a narrator turn — third person, no draft speaker anchor', () => {
    const plan = narr({ draftLength: 3, userHint: 'the power cuts out' });
    const joined = plan.messages.map((m) => m.content).join('\n');
    expect(plan.itemization.some((i) => i.source === 'narratorBeat')).toBe(true);
    expect(plan.itemization.some((i) => i.source === 'draftAnchor')).toBe(false);
    expect(joined).toMatch(/Third person present/);
    expect(joined).toContain('the power cuts out');
    // The rail must not talk the narrator into inventing beats around the steer.
    expect(joined).toMatch(/NEVER by adding events of your own/);
  });
});
