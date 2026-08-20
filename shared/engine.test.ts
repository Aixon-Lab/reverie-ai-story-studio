/** Engine tests — run against shipped package fixtures in server/defaults/. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCardPayload, writeCardPayload } from './codec/png';
import { parseCard, exportCard } from './codec/card';
import { parsePreset, exportPreset, defaultPreset } from './codec/preset';
import { parseLorebook } from './codec/lorebook';
import { substituteMacros } from './engine/macros';
import { scanWorldInfo } from './engine/worldinfo';
import { buildPrompt } from './engine/promptBuilder';
import { narratorCard } from './engine/agents';
import { estimateTokens } from './engine/tokens';
import {
  buildMessageStylePrompt,
  buildMessageStyleTailReminder,
  ensureForcedMessageStyle,
  parseMessageStyles,
  patternFromWrappers,
  defaultMessageStyle,
} from './engine/messageStyle';
import { sanitizeAiOutput, splitReasoningFromOutput, truncateAtForeignSpeaker } from './engine/sanitizeOutput';
import { WILogic, WIPosition, type Persona, type WIEntry } from './types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = path.join(ROOT, 'server', 'defaults');
const MAYA = path.join(DEFAULTS, 'default_Maya.png');
const DEFAULT_PRESET = path.join(DEFAULTS, 'presets', 'openai', 'Default.json');
const NORTHLINE = path.join(DEFAULTS, 'Northline.json');

const persona: Persona = { id: 'p', name: 'Alex', description: 'A curious traveler.' };

describe('PNG card codec (shipped starter card)', () => {
  const png = new Uint8Array(fs.readFileSync(MAYA));

  it('reads embedded character data from the starter card', () => {
    const payload = readCardPayload(png);
    const json = JSON.parse(payload);
    expect(json.data?.name ?? json.name).toBe('Maya Calder');
  });

  it('round-trips: write → read preserves data and stays a valid PNG', () => {
    const card = parseCard(readCardPayload(png), 'maya');
    card.creator_notes = 'modified by test';
    const out = writeCardPayload(png, JSON.stringify(exportCard(card)));
    const back = parseCard(readCardPayload(out), 'maya2');
    expect(back.name).toBe('Maya Calder');
    expect(back.creator_notes).toBe('modified by test');
    expect(back.first_mes).toBe(card.first_mes);
    // ccv3 takes precedence and carries spec
    const raw = JSON.parse(readCardPayload(out));
    expect(raw.spec).toBe('chara_card_v3');
  });
});

describe('preset codec (shipped openai Default.json)', () => {
  const raw = JSON.parse(fs.readFileSync(DEFAULT_PRESET, 'utf8'));

  it('parses prompts, order, and utility prompts', () => {
    const p = parsePreset(raw, 'default', 'Default');
    expect(p.prompts.find((x) => x.identifier === 'main')?.content).toContain("{{char}}'s next reply");
    expect(p.prompt_order.map((o) => o.identifier)).toContain('chatHistory');
    expect(p.utility_prompts.group_nudge_prompt).toContain('{{char}}');
    expect(p.temperature).toBe(1);
  });

  it('export preserves unknown provider fields (lossless)', () => {
    const p = parsePreset(raw, 'default', 'Default');
    const out = exportPreset(p);
    expect(out.claude_model).toBe(raw.claude_model);
    expect(out.impersonation_prompt).toBe(raw.impersonation_prompt);
  });
});

describe('lorebook codec (shipped Northline.json)', () => {
  it('parses entries with keys', () => {
    const raw = JSON.parse(fs.readFileSync(NORTHLINE, 'utf8'));
    const book = parseLorebook(raw, 'northline', 'Northline');
    expect(book.entries.length).toBeGreaterThan(0);
    expect(book.entries[0].key.length).toBeGreaterThan(0);
  });
});

describe('macros', () => {
  it('substitutes identity and card macros', () => {
    const out = substituteMacros('Write {{char}} for {{user}}. {{personality}}', {
      char: 'Sera', user: 'Alex', personality: 'kind',
    });
    expect(out).toBe('Write Sera for Alex. kind');
  });
  it('handles variables and pick determinism', () => {
    const vars: Record<string, string> = {};
    substituteMacros('{{setvar::mood::tense}}', { variables: vars });
    expect(vars.mood).toBe('tense');
    const a = substituteMacros('{{pick::x::y::z}}', { chatIdHash: 42 });
    const b = substituteMacros('{{pick::x::y::z}}', { chatIdHash: 42 });
    expect(a).toBe(b);
  });
  it('leaves unknown macros intact', () => {
    expect(substituteMacros('{{someExtensionMacro}}', {})).toBe('{{someExtensionMacro}}');
  });
});

function wiEntry(partial: Partial<WIEntry>): WIEntry {
  return {
    uid: 1, key: [], keysecondary: [], comment: '', content: 'lore', constant: false,
    selective: false, selectiveLogic: WILogic.AND_ANY, order: 100, position: WIPosition.Before,
    disable: false, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false,
    probability: 100, useProbability: true, depth: 4, role: 0, group: '', groupOverride: false,
    groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null,
    ...partial,
  };
}

describe('world info activation', () => {
  const settings = { scanDepth: 4, recursive: true, caseSensitive: false, matchWholeWords: false, budgetTokens: 2000, maxRecursionSteps: 3 };

  it('activates on key match and respects secondary NOT_ANY', () => {
    const res = scanWorldInfo({
      entries: [
        wiEntry({ uid: 1, key: ['dragon'], content: 'Dragons rule.' }),
        wiEntry({ uid: 2, key: ['dragon'], keysecondary: ['friendly'], selective: true, selectiveLogic: WILogic.NOT_ANY, content: 'Dragons are feared.' }),
      ],
      messages: ['I saw a friendly dragon today'],
      settings, countTokens: estimateTokens, random: () => 0.5,
    });
    expect(res.activated.map((e) => e.uid)).toContain(1);
    expect(res.activated.map((e) => e.uid)).not.toContain(2);
  });

  it('recursion: activated content triggers other entries', () => {
    const res = scanWorldInfo({
      entries: [
        wiEntry({ uid: 1, key: ['castle'], content: 'The castle belongs to Queen Mira.' }),
        wiEntry({ uid: 2, key: ['Mira'], content: 'Mira is a tyrant.' }),
      ],
      messages: ['We approach the castle'],
      settings, countTokens: estimateTokens, random: () => 0.5,
    });
    expect(res.activated.length).toBe(2);
  });

  it('constant entries always fire; regex keys work', () => {
    const res = scanWorldInfo({
      entries: [
        wiEntry({ uid: 1, constant: true, content: 'Always here.' }),
        wiEntry({ uid: 2, key: ['/dr[ao]gon/i'], content: 'Regex hit.' }),
      ],
      messages: ['A DRAGON!'],
      settings, countTokens: estimateTokens, random: () => 0.5,
    });
    expect(res.activated.length).toBe(2);
  });
});

describe('prompt builder', () => {
  const preset = defaultPreset();
  const card = parseCard(readCardPayload(new Uint8Array(fs.readFileSync(MAYA))), 'maya');
  const baseInput = {
    preset, card, persona,
    history: [
      { id: '1', ts: 1, speaker: { type: 'character' as const, characterId: 'maya', displayName: 'Maya Calder' }, controlledBy: 'ai' as const, text: 'Welcome in — what broke?' },
      { id: '2', ts: 2, speaker: { type: 'user' as const, displayName: 'Alex' }, controlledBy: 'human' as const, text: 'Where am I?' },
    ],
    wiEntries: [] as WIEntry[],
    model: 'test-model',
    wiSettings: { scanDepth: 4, budgetPercent: 25, recursive: true, caseSensitive: false, matchWholeWords: false, maxRecursionSteps: 3 },
  };

  it('assembles messages with main prompt, description, and history', () => {
    const plan = buildPrompt(baseInput);
    const joined = plan.messages.map((m) => m.content).join('\n---\n');
    expect(joined).toContain('You are Maya Calder'); // macro-substituted main / contract
    expect(joined).toMatch(/FIRST PERSON|first person/);
    expect(joined).toContain(card.description.slice(0, 40));
    expect(plan.messages.some((m) => m.content === 'Where am I?' || m.content.includes('Where am I?'))).toBe(true);
    expect(joined).toMatch(/counter|stage/i); // forbidden listed in contract
    expect(plan.itemization.length).toBeGreaterThan(3);
  });

  it('group mode: identity lock, name prefixes, stop strings, play-as flag', () => {
    const other = { ...card, id: 'other', name: 'Kael' };
    const plan = buildPrompt({
      ...baseInput,
      group: { memberCards: [card, other], playAsName: 'Kael' },
    });
    const first = plan.messages[0].content;
    expect(first).toContain('You are Maya Calder');
    expect(first).toContain('Kael (played by the human user');
    expect(plan.stops).toContain('\nKael:');
    expect(plan.messages.at(-2)?.content ?? plan.messages.map(m => m.content).join()).toBeTruthy();
    const historyMsg = plan.messages.find((m) => m.content.includes('Where am I?'));
    expect(historyMsg?.content).toBe('Alex: Where am I?');
  });

  it('always stops at the user label, even in a solo chat', () => {
    // Without this the model happily continues "Alex: ..." and answers for the
    // player — the classic out-of-turn failure.
    const plan = buildPrompt(baseInput);
    expect(plan.stops).toContain('\nAlex:');
  });

  it('warns the model when it is speaking out of turn', () => {
    // Transcript ends on the character's own line — a forced turn / Skip.
    const outOfTurn = {
      ...baseInput,
      history: [
        baseInput.history[0],
        baseInput.history[1],
        {
          id: '3', ts: 3,
          speaker: { type: 'character' as const, characterId: 'maya', displayName: 'Maya Calder' },
          controlledBy: 'ai' as const,
          text: 'VPN is down on 14.',
        },
      ],
    };
    const plan = buildPrompt(outOfTurn);
    const joined = plan.messages.map((m) => m.content).join('\n');
    expect(plan.itemization.some((i) => i.source === 'turnGuard')).toBe(true);
    expect(joined).toContain('has NOT replied yet');
    expect(joined).toContain("Do NOT write Alex's reply");
  });

  it('does not warn when the user has just spoken', () => {
    const plan = buildPrompt(baseInput); // history ends on the user's line
    expect(plan.itemization.some((i) => i.source === 'turnGuard')).toBe(false);
  });

  it('does not gag the user label when drafting the user\'s own line', () => {
    const plan = buildPrompt({ ...baseInput, generationType: 'suggest_user' });
    expect(plan.stops).not.toContain('\nAlex:');
    expect(plan.itemization.some((i) => i.source === 'turnGuard')).toBe(false);
  });

  it('sends only the swipe on screen, never the alternates behind it', () => {
    // 2/3 selected: the other two variants exist on the message but were not
    // chosen, so the model must never see them as things that were "said".
    const plan = buildPrompt({
      ...baseInput,
      history: [
        {
          ...baseInput.history[0],
          text: 'Second variant.',
          swipes: ['First variant.', 'Second variant.', 'Third variant.'],
          swipeIndex: 1,
        },
        baseInput.history[1],
      ],
    });
    const joined = plan.messages.map((m) => m.content).join('\n');
    expect(joined).toContain('Second variant.');
    expect(joined).not.toContain('First variant.');
    expect(joined).not.toContain('Third variant.');
  });

  it('narrator turns use third-person POV, honor seed, and never first-person cast lock', () => {
    const narr = narratorCard();
    const plan = buildPrompt({
      ...baseInput,
      card: narr,
      generationType: 'narrate',
      userHint: 'a storm rolls in over the cliffs',
      castNames: ['Maya Calder'],
    });
    const joined = plan.messages.map((m) => m.content).join('\n');
    expect(plan.itemization.some((i) => i.source === 'narratorBeat')).toBe(true);
    expect(plan.itemization.some((i) => i.source === 'narratorFinal')).toBe(true);
    expect(plan.itemization.some((i) => i.source === 'messageStyleNarrator')).toBe(true);
    expect(plan.itemization.some((i) => i.source === 'writingContract')).toBe(false);
    expect(joined).toMatch(/THIRD PERSON|third person|omniscient/i);
    expect(joined).toContain('a storm rolls in over the cliffs');
    expect(joined).not.toMatch(/You are Maya Calder/);
    // Must not force first-person character format for narrator
    expect(joined).not.toContain('Write in FIRST PERSON as the speaking character');
    expect(plan.stops).toContain('\nMaya Calder:');
    expect(plan.stops).toContain('\nAlex:');
  });

  it('respects token budget by trimming oldest history', () => {
    const longHistory = Array.from({ length: 200 }, (_, i) => ({
      id: String(i), ts: i, speaker: { type: 'user' as const, displayName: 'Alex' }, controlledBy: 'human' as const,
      text: 'word '.repeat(200),
    }));
    const smallPreset = { ...preset, max_context: 4000, max_tokens: 500 };
    const plan = buildPrompt({ ...baseInput, preset: smallPreset, history: longHistory });
    expect(plan.totalTokens).toBeLessThanOrEqual(3500);
  });

  /**
   * Memory is budgeted against the *model's* window; this budget is the user's
   * own context slider, which is usually smaller. So the block can arrive larger
   * than there is room for, and it used to sit in the un-trimmable `fixed` set —
   * the history loop then kept nothing and the model was sent a memory dump with
   * no conversation under it, leaving it nothing to reply to.
   */
  describe('memory never eats the conversation', () => {
    const hugeBrain = Array.from({ length: 400 }, (_, i) =>
      `- She remembers something that happened, item number ${i}, at some length.`).join('\n');

    it('keeps the transcript when the memory block is larger than the budget', () => {
      const smallPreset = { ...preset, max_context: 4000, max_tokens: 500 };
      const plan = buildPrompt({
        ...baseInput, preset: smallPreset, brainContext: hugeBrain,
      });
      const kept = plan.itemization.filter((i) => i.source.startsWith('chatHistory'));
      expect(kept.length).toBeGreaterThan(0);
      expect(plan.totalTokens).toBeLessThanOrEqual(smallPreset.max_context - smallPreset.max_tokens);
    });

    it('shortens the memory block rather than dropping the last messages', () => {
      const smallPreset = { ...preset, max_context: 4000, max_tokens: 500 };
      const plan = buildPrompt({
        ...baseInput, preset: smallPreset, brainContext: hugeBrain,
      });
      const brain = plan.itemization.find((i) => i.source === 'brain');
      // Either trimmed to fit or dropped outright — never passed through whole.
      if (brain) {
        expect(brain.tokens).toBeLessThan(estimateTokens(hugeBrain));
        expect(plan.messages.some((m) => m.content.includes('memory truncated'))).toBe(true);
      }
      expect(plan.messages.some((m) => m.content.includes('Where am I?'))).toBe(true);
    });

    it('passes a block that fits through untouched', () => {
      const small = '[What Maya Calder carries]\n- She remembers the traveler arriving.';
      const plan = buildPrompt({ ...baseInput, brainContext: small });
      const brain = plan.itemization.find((i) => i.source === 'brain');
      expect(brain).toBeTruthy();
      expect(plan.messages.some((m) => m.content === small)).toBe(true);
    });

    it('reports the scaffolding cost so the caller can size memory up front', () => {
      const plan = buildPrompt(baseInput);
      expect(plan.fixedTokens).toBeGreaterThan(0);
      expect(plan.fixedTokens).toBeLessThanOrEqual(plan.totalTokens);
    });
  });

  it('character system_prompt overrides main with {{original}} passthrough', () => {
    const custom = { ...card, system_prompt: 'CUSTOM RULES. {{original}}' };
    const plan = buildPrompt({ ...baseInput, card: custom });
    const main = plan.messages.map((m) => m.content).join('\n');
    expect(main).toContain('CUSTOM RULES.');
    expect(main).toContain('You are Maya Calder'); // original main via {{original}}
  });

  it('injects message style FORMAT + tail reminder every turn from live rules', () => {
    const style = defaultMessageStyle();
    const plan = buildPrompt({ ...baseInput, messageStyle: style });
    const joined = plan.messages.map((m) => m.content).join('\n---\n');
    expect(joined).toContain('FORMAT (strict');
    expect(joined).toMatch(/FORMAT CHECK/);
    expect(joined).toContain('"');
    expect(joined).toContain('*');
    expect(plan.itemization.some((x) => x.source === 'messageStyle')).toBe(true);
    expect(plan.itemization.some((x) => x.source === 'messageStyle.tail')).toBe(true);
  });

  it('injects Max Tokens as a LENGTH CAP the model must finish under (shorter allowed)', () => {
    const plan = buildPrompt({
      ...baseInput,
      preset: { ...preset, max_tokens: 120 },
    });
    const capItem = plan.itemization.find((x) => x.source === 'outputLengthCap');
    expect(capItem).toBeTruthy();
    const joined = plan.messages.map((m) => m.content).join('\n');
    expect(joined).toContain('LENGTH CAP');
    expect(joined).toContain('120 tokens');
    expect(joined).toMatch(/single word|one word/i);
    expect(joined).toMatch(/Never exceed/i);
    // Tail position: length cap near the end so it stays authoritative
    const lastSources = plan.itemization.slice(-4).map((x) => x.source);
    expect(lastSources).toContain('outputLengthCap');
  });

  it('custom message style wrappers appear in the FORMAT rule', () => {
    const style = {
      rules: [
        {
          id: 'style-dialogue',
          name: 'Dialogue',
          role: 'dialogue' as const,
          open: '「',
          close: '」',
          pattern: '「([\\s\\S]*?)」',
          enabled: true,
          hideWrappers: true,
          fontWeight: 500,
          fontStyle: 'normal' as const,
          color: '#fff',
          defaultForBare: false,
          injectInPrompt: true,
        },
        {
          id: 'style-action',
          name: 'Action',
          role: 'action' as const,
          open: '**',
          close: '**',
          pattern: patternFromWrappers('**', '**'),
          enabled: true,
          hideWrappers: true,
          fontWeight: 400,
          fontStyle: 'italic' as const,
          color: '#aaa',
          defaultForBare: true,
          injectInPrompt: true,
        },
      ],
    };
    const plan = buildPrompt({ ...baseInput, messageStyle: style });
    const joined = plan.messages.map((m) => m.content).join('\n');
    expect(joined).toContain('「');
    expect(joined).toContain('」');
    expect(joined).toContain('**');
    // must not silently force plain " only
    const styleBlock = plan.messages.find((m) => m.content.includes('FORMAT (strict'));
    expect(styleBlock?.content).toContain('「');
  });
});

describe('message style', () => {
  it('defaults: dialogue in quotes, action/thought in asterisks', () => {
    const s = defaultMessageStyle();
    const d = s.rules.find((r) => r.role === 'dialogue')!;
    const a = s.rules.find((r) => r.role === 'action')!;
    expect(d.open).toBe('"');
    expect(d.close).toBe('"');
    expect(a.open).toBe('*');
    expect(a.close).toBe('*');
    expect(a.injectInPrompt).toBe(true);
  });

  it('preserves user custom open/close instead of force-overwriting', () => {
    const custom = ensureForcedMessageStyle({
      rules: [
        {
          id: 'style-dialogue',
          name: 'Dialogue',
          role: 'dialogue',
          open: '「',
          close: '」',
          pattern: '「([^」]*)」',
          enabled: true,
          hideWrappers: true,
          fontWeight: 500,
          fontStyle: 'normal',
          color: '#fff',
          defaultForBare: false,
          injectInPrompt: true,
        },
      ],
    });
    const d = custom.rules.find((r) => r.role === 'dialogue')!;
    expect(d.open).toBe('「');
    expect(d.close).toBe('」');
    // action core still filled in
    expect(custom.rules.some((r) => r.role === 'action')).toBe(true);
  });

  it('parseMessageStyles splits dialogue and action', () => {
    const segs = parseMessageStyles('*I smile.* "Hello." *I wave.*', defaultMessageStyle());
    const roles = segs.map((s) => s.role);
    expect(roles).toContain('dialogue');
    expect(roles).toContain('action');
    expect(segs.find((s) => s.role === 'dialogue')?.text).toBe('Hello.');
  });

  it('buildMessageStylePrompt lists live wrappers only', () => {
    const p = buildMessageStylePrompt(defaultMessageStyle());
    expect(p).toContain('FORMAT (strict');
    expect(p).toMatch(/dialogue/i);
    expect(p).toMatch(/\*/);
    const tail = buildMessageStyleTailReminder(defaultMessageStyle());
    expect(tail).toMatch(/FORMAT CHECK/);
  });

  it('patternFromWrappers handles ** and single *', () => {
    expect(patternFromWrappers('*', '*')).toBe('\\*([^*]*)\\*');
    expect(patternFromWrappers('**', '**')).toContain('\\*\\*');
    expect(patternFromWrappers('「', '」')).toBe('「([\\s\\S]*?)」');
  });

  it('format prompt forbids INTERNAL THOUGHTS meta dumps', () => {
    const p = buildMessageStylePrompt(defaultMessageStyle());
    expect(p).toMatch(/INTERNAL THOUGHTS/i);
    expect(p).toMatch(/in-character thoughts/i);
  });
});

describe('sanitize / hide model reasoning', () => {
  it('strips <think> blocks and keeps in-character prose', () => {
    const raw = `<think>plan the scene</think>\n*I stare at the door.* "I will not beg."`;
    const { visible, reasoning } = splitReasoningFromOutput(raw);
    expect(reasoning).toContain('plan the scene');
    expect(visible).toContain('I stare at the door');
    expect(visible).not.toContain('plan the scene');
    expect(visible).not.toMatch(/<\/?think/i);
    const clean = sanitizeAiOutput(raw);
    expect(clean).toContain('I stare at the door');
    expect(clean).not.toContain('plan the scene');
  });

  it('strips incomplete think tags (streaming)', () => {
    const raw = `*I wait.*\n<think>\nstill reasoning without close`;
    const clean = sanitizeAiOutput(raw);
    expect(clean).toContain('I wait');
    expect(clean).not.toContain('still reasoning');
    expect(clean).not.toMatch(/<think/i);
  });

  it('hides 🧠 INTERNAL THOUGHTS sections like the user report', () => {
    const raw = [
      '*I stare at the door, or what I think is the door in the shadows. I will not beg. I will not panic. Not yet. But the cuffs hum against my wrists, and every second the green light eats at me, I feel a little more like Elin Marsh and a lot less like Skylark.*',
      '',
      '🧠 INTERNAL THOUGHTS',
      "- Elin Marsh | Thoughts: Don't panic don't panic — the model leaked the reasoning line into the visible reply",
    ].join('\n');
    const { visible, reasoning } = splitReasoningFromOutput(raw);
    expect(visible).toContain('I stare at the door');
    expect(visible).toContain('Skylark');
    expect(visible).not.toMatch(/INTERNAL THOUGHTS/i);
    expect(visible).not.toContain("Don't panic");
    expect(reasoning).toMatch(/Don't panic/i);
    const clean = sanitizeAiOutput(raw);
    expect(clean).toContain('I will not beg');
    expect(clean).not.toMatch(/INTERNAL THOUGHTS/i);
    expect(clean).not.toContain('Elin Marsh | Thoughts');
  });

  it('keeps in-character *thoughts* inside action wrappers', () => {
    const raw = `*I won't beg. Not yet. Panic can wait.* "Leave me alone."`;
    const clean = sanitizeAiOutput(raw);
    expect(clean).toContain("I won't beg");
    expect(clean).toContain('Leave me alone');
  });

  it('honors custom reasoning prefix/suffix', () => {
    const raw = `BEGIN_THINK\nhidden plan\nEND_THINK\n*I nod.*`;
    const split = splitReasoningFromOutput(raw, { prefix: 'BEGIN_THINK', suffix: 'END_THINK' });
    expect(split.reasoning).toContain('hidden plan');
    expect(split.visible).toContain('I nod');
    expect(split.visible).not.toContain('hidden plan');
  });
});

describe('foreign speaker truncation (out-of-turn safety net)', () => {
  it('cuts the moment the model starts writing the user', () => {
    const out = truncateAtForeignSpeaker(
      ['I lean against the doorframe, watching you.', 'Alex: I step back nervously.'].join('\n'),
      'Maya Calder',
      ['Alex'],
    );
    expect(out).toBe('I lean against the doorframe, watching you.');
  });

  it('handles bold and italic speaker labels', () => {
    expect(truncateAtForeignSpeaker(['Mine.', '**Alex:** no'].join('\n'), 'Maya Calder', ['Alex'])).toBe('Mine.');
    expect(truncateAtForeignSpeaker(['Mine.', '*Kael:* hi'].join('\n'), 'Maya Calder', ['Kael'])).toBe('Mine.');
  });

  it('leaves the speaker own label alone', () => {
    const text = 'Maya Calder: I speak.';
    expect(truncateAtForeignSpeaker(text, 'Maya Calder', ['Alex'])).toBe(text);
  });

  it('is empty when the whole reply was someone else — caller treats that as a failure', () => {
    expect(truncateAtForeignSpeaker('Alex: I answer for myself.', 'Maya Calder', ['Alex'])).toBe('');
  });

  it('does not fire on a colon inside ordinary prose', () => {
    const text = 'I have one rule: never lie to me.';
    expect(truncateAtForeignSpeaker(text, 'Maya Calder', ['Alex'])).toBe(text);
  });
});
