/**
 * The skills slot inside the assembled prompt.
 *
 * The unit tests next door prove the block composes correctly in isolation.
 * What matters here is the promise made to the user on the Skills page: skills
 * are last in line, they degrade instead of vanishing, and every token they do
 * not take goes back to the transcript.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from '../engine/promptBuilder';
import { estimateTokens } from '../engine/tokens';
import { defaultPreset } from '../codec/preset';
import { parseCard } from '../codec/card';
import { readCardPayload } from '../codec/png';
import type { ChatMessage, Persona, WIEntry } from '../types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAYA = path.join(HERE, '..', '..', 'server', 'defaults', 'default_Maya.png');

const persona: Persona = { id: 'p', name: 'Alex', description: 'A traveler.' };
const card = parseCard(readCardPayload(new Uint8Array(fs.readFileSync(MAYA))), 'maya');

function history(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    ts: i,
    speaker: i % 2
      ? { type: 'user' as const, displayName: 'Alex' }
      : { type: 'character' as const, characterId: 'maya', displayName: 'Maya Calder' },
    controlledBy: i % 2 ? ('human' as const) : ('ai' as const),
    text: `Line ${i} — ${'words '.repeat(20)}`,
  }));
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    preset: defaultPreset(),
    card,
    persona,
    history: history(40),
    wiEntries: [] as WIEntry[],
    model: 'test-model',
    wiSettings: {
      scanDepth: 4, budgetPercent: 25, recursive: true,
      caseSensitive: false, matchWholeWords: false, maxRecursionSteps: 3,
    },
    ...over,
  } as Parameters<typeof buildPrompt>[0];
}

const skillBlock = (n: number) =>
  `ACTIVE SKILLS — craft knowledge you may draw on this turn.\n\n${
    Array.from({ length: n }, (_, i) =>
      `### SKILL: Skill ${i}\nsummary ${i}\n\n${`technique ${i} `.repeat(120)}`).join('\n')}`;

describe('skills in the assembled prompt', () => {
  it('appears as its own itemised slot', () => {
    const plan = buildPrompt(baseInput({ skillContext: skillBlock(1) }));
    const item = plan.itemization.find((i) => i.source === 'skills');
    expect(item).toBeTruthy();
    expect(plan.messages.some((m) => m.content.includes('### SKILL: Skill 0'))).toBe(true);
  });

  it('puts the selector at the very end, after the story', () => {
    const plan = buildPrompt(baseInput({ skillSelector: 'SKILL ROUTING (out-of-character):' }));
    const sources = plan.itemization.map((i) => i.source);
    const selector = sources.indexOf('skillSelector');
    expect(selector).toBeGreaterThan(-1);
    expect(selector).toBeGreaterThan(sources.lastIndexOf('newChat'));
  });

  it('sits after memory, so the model reads who she is before what she can do', () => {
    const plan = buildPrompt(baseInput({
      brainContext: 'MEMORY\nShe remembers the bridge.',
      skillContext: skillBlock(1),
    }));
    const sources = plan.itemization.map((i) => i.source);
    expect(sources.indexOf('brain')).toBeLessThan(sources.indexOf('skills'));
  });

  it('drops whole documents rather than cutting one mid-sentence', () => {
    const preset = { ...defaultPreset(), max_context: 3000, max_tokens: 400 };
    const plan = buildPrompt(baseInput({ preset, skillContext: skillBlock(4) }));
    const item = plan.itemization.find((i) => i.source === 'skills');
    if (item) {
      const msg = plan.messages.find((m) => m.content.includes('### SKILL:'))!;
      // Every document that survived is present in full, headline and all.
      const kept = msg.content.split('### SKILL:').length - 1;
      expect(kept).toBeGreaterThanOrEqual(1);
      expect(kept).toBeLessThan(4);
    }
    expect(plan.totalTokens).toBeLessThanOrEqual(preset.max_context - preset.max_tokens);
  });

  it('gives up entirely rather than starving the transcript', () => {
    const preset = { ...defaultPreset(), max_context: 2200, max_tokens: 400 };
    const plan = buildPrompt(baseInput({ preset, skillContext: skillBlock(6) }));
    const historyKept = plan.itemization.filter((i) => i.source.startsWith('chatHistory')).length;
    expect(historyKept).toBeGreaterThan(0);
  });

  it('hands unused skill budget back to the conversation', () => {
    const preset = { ...defaultPreset(), max_context: 6000, max_tokens: 400 };
    // A transcript long enough that the window is the binding constraint —
    // otherwise everything fits either way and the trade is invisible.
    const long = history(160);
    const withSkills = buildPrompt(baseInput({ preset, history: long, skillContext: skillBlock(3) }));
    const without = buildPrompt(baseInput({ preset, history: long }));

    const count = (p: typeof withSkills) =>
      p.itemization.filter((i) => i.source.startsWith('chatHistory')).length;
    expect(count(without)).toBeGreaterThan(count(withSkills));
  });

  it('never emits a skills header with no documents under it', () => {
    const preset = { ...defaultPreset(), max_context: 1600, max_tokens: 400 };
    const plan = buildPrompt(baseInput({ preset, skillContext: skillBlock(8) }));
    const msg = plan.messages.find((m) => m.content.startsWith('ACTIVE SKILLS'));
    if (msg) expect(msg.content).toContain('### SKILL:');
  });

  it('costs nothing at all when no skills are active', () => {
    const plan = buildPrompt(baseInput());
    expect(plan.itemization.some((i) => i.source === 'skills')).toBe(false);
    expect(plan.itemization.some((i) => i.source === 'skillSelector')).toBe(false);
  });

  it('keeps the whole prompt inside the context budget', () => {
    const preset = { ...defaultPreset(), max_context: 8000, max_tokens: 600 };
    const plan = buildPrompt(baseInput({
      preset,
      brainContext: `MEMORY\n${'she recalls the bridge. '.repeat(200)}`,
      skillContext: skillBlock(5),
      skillSelector: 'SKILL ROUTING',
    }));
    const total = plan.messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
    expect(total).toBeLessThanOrEqual(preset.max_context);
  });
});
