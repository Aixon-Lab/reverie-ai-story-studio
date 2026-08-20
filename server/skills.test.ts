/**
 * Server-side skill rules.
 *
 * The filesystem layer is thin wrappers over already-tested storage helpers.
 * What is worth pinning down is what happens to a skill on the way in — a
 * hand-edited or older file must never reach the prompt path half-formed — and
 * how a routing decision folds into a conversation.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillDoc } from '../shared/skills/parse';
import { normalizeSkill } from './skills/store';
import { chatSkillState, decisionFromTag, recentExcerpt, skillSettings } from './skills/service';
import { emptyChatSkillState } from '../shared/skills/types';
import type { ChatMessage, ChatMeta, AppSettings } from '../shared/types';

describe('normalizeSkill', () => {
  it('fills in everything a bare file is missing', () => {
    const s = normalizeSkill({ name: 'Cooking', body: '## Heat\ncontrol it' });
    expect(s.id).toBeTruthy();
    expect(s.mode).toBe('auto');
    expect(s.enabled).toBe(true);
    expect(s.priority).toBe(50);
    expect(s.tokens).toBeGreaterThan(0);
    expect(s.sections.map((x) => x.heading)).toEqual(['Heat']);
    // A skill with no digest still has a fallback for a tight context window.
    expect(s.digest).toBeTruthy();
  });

  it('clamps values a hand-edited file could put out of range', () => {
    const s = normalizeSkill({ name: 'X', body: 'y', priority: 9999, stickyTurns: -4 });
    expect(s.priority).toBe(100);
    expect(s.stickyTurns).toBe(0);
  });

  it('rejects a nonsense mode rather than passing it through', () => {
    const s = normalizeSkill({ name: 'X', body: 'y', mode: 'whenever' as any });
    expect(s.mode).toBe('auto');
  });

  it('never leaves a skill nameless', () => {
    expect(normalizeSkill({ body: 'y' }).name).toBe('Untitled skill');
  });
});

describe('derived fields never go stale', () => {
  it('re-derives the digest when the document is rewritten', () => {
    // The editor round-trips the whole skill on save, so a trusted digest meant
    // the shrunk version the model sees under pressure described the old body.
    const first = normalizeSkill({ id: 'x', name: 'X', body: 'Heat is a tool.\n\n## Sear\na' });
    expect(first.digest).toContain('Heat is a tool');

    const rewritten = normalizeSkill({ ...first, body: 'Salt is a schedule.\n\n## Brine\nb' });
    expect(rewritten.digest).toContain('Salt is a schedule');
    expect(rewritten.digest).not.toContain('Heat is a tool');
    // The untitled preamble stays its own section, so it survives trimming too.
    expect(rewritten.sections.map((s) => s.heading)).toEqual(['', 'Brine']);
    expect(rewritten.tokens).toBe(normalizeSkill({ id: 'y', name: 'Y', body: rewritten.body }).tokens);
  });
});

describe('chatSkillState', () => {
  it('gives a chat that has never used skills an empty state', () => {
    expect(chatSkillState({} as ChatMeta)).toEqual(emptyChatSkillState());
  });

  it('heals a partially written state', () => {
    const state = chatSkillState({ skills: { active: [{ id: 'a', since: 1 }] } } as ChatMeta);
    expect(state.forced).toEqual([]);
    expect(state.muted).toEqual([]);
  });
});

describe('skillSettings', () => {
  it('defaults on for a settings file written before skills existed', () => {
    const cfg = skillSettings({} as AppSettings);
    expect(cfg.enabled).toBe(true);
    expect(cfg.selection).toBe('auto');
  });

  it('keeps stored choices from the settings file', () => {
    const cfg = skillSettings({ skills: { selection: 'manual' } } as any);
    expect(cfg.selection).toBe('manual');
    expect(cfg.maxActive).toBe(3);
  });
});

describe('decisionFromTag', () => {
  const skills = [
    normalizeSkill({ id: 'ma', name: 'Martial Arts', body: 'x', stickyTurns: 2 }),
    normalizeSkill({ id: 'ck', name: 'Cooking', body: 'x', stickyTurns: 2 }),
  ];

  it('arms a skill the model named', () => {
    const next = decisionFromTag(emptyChatSkillState(), skills, ['Martial Arts'], 4, 'inline');
    expect(next.active.map((a) => a.id)).toEqual(['ma']);
    expect(next.log?.[0].via).toBe('inline');
  });

  it('ignores a name that matches nothing', () => {
    const next = decisionFromTag(emptyChatSkillState(), skills, ['Jousting'], 4, 'inline');
    expect(next.active).toEqual([]);
  });

  it('refreshes lastSeen every time the same skill is re-confirmed', () => {
    // The bug this pins: skipping the write when the set was unchanged froze
    // `lastSeen` at the first arming, so a skill the model asked for on twenty
    // consecutive turns was dropped by the very first omission.
    let state = decisionFromTag(emptyChatSkillState(), skills, ['Cooking'], 4, 'inline');
    state = decisionFromTag(state, skills, ['Cooking'], 12, 'inline');
    expect(state.active[0].since).toBe(4);
    expect(state.active[0].lastSeen).toBe(12);

    // One omission right after a confirmation must not end it.
    state = decisionFromTag(state, skills, [], 13, 'inline');
    expect(state.active.map((a) => a.id)).toEqual(['ck']);
  });

  it('still lets a skill expire once the scene has genuinely moved on', () => {
    let state = decisionFromTag(emptyChatSkillState(), skills, ['Cooking'], 4, 'inline');
    state = decisionFromTag(state, skills, [], 40, 'inline');
    expect(state.active).toEqual([]);
  });

  it('records the first "nothing needed" answer so the chat stops looking undecided', () => {
    const next = decisionFromTag(emptyChatSkillState(), skills, [], 2, 'scout');
    expect(next.decidedAt).toBe(2);
  });
});

describe('recentExcerpt', () => {
  const msg = (i: number, hidden = false): ChatMessage => ({
    id: String(i), ts: i,
    speaker: { type: 'user', displayName: 'Alex' },
    controlledBy: 'human', text: `line ${i}`,
    ...(hidden ? { hiddenFromPrompt: true } : {}),
  });

  it('takes the tail of the conversation, newest last', () => {
    const text = recentExcerpt([msg(1), msg(2), msg(3)], 2);
    expect(text).toBe('Alex: line 2\nAlex: line 3');
  });

  it('skips messages hidden from the prompt', () => {
    // A hidden message is not part of the scene, so it must not steer routing.
    expect(recentExcerpt([msg(1, true), msg(2)], 4)).toBe('Alex: line 2');
  });
});

describe('shipped example skills', () => {
  // They are the answer to "what is a skill supposed to look like", so a broken
  // one is a documentation bug as much as a data bug.
  const dir = path.join(__dirname, 'defaults', 'skills');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));

  it('ships at least one worked example', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} parses into a usable skill`, () => {
      const doc = parseSkillDoc(fs.readFileSync(path.join(dir, file), 'utf8'), file);
      const skill = normalizeSkill({ ...doc, id: file });

      expect(skill.name).toBeTruthy();
      // The description is the entire basis for routing — an empty one is fatal.
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.keywords.length).toBeGreaterThan(3);
      // Sections are the unit of graded trimming; a wall of text cannot degrade.
      expect(skill.sections.length).toBeGreaterThan(3);
      expect(skill.tokens).toBeGreaterThan(300);
      expect(skill.digest).toBeTruthy();
    });
  }
});
