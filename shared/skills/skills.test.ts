import { describe, it, expect } from 'vitest';
import {
  applyDecision, composeSkillBlock, createSkillTagFilter, deriveDigest, exportSkillDoc,
  extractSkillTag, hydrateSkill, matchSkillName, parseSkillDoc, planSkillBudget,
  resolveActiveSkills, shortlistSkills, splitSections,
  DEFAULT_SKILLS_SETTINGS, emptyChatSkillState, type Skill,
} from './index';

function makeSkill(over: Partial<Skill> & { id: string; name: string }): Skill {
  const base: Skill = {
    description: `${over.name} description`,
    body: `## One\nalpha body text here\n\n## Two\nbeta body text here`,
    enabled: true,
    mode: 'auto',
    keywords: [],
    tags: [],
    priority: 50,
    stickyTurns: 2,
    tokens: 0,
    sections: [],
    digest: '',
    source: 'manual',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
  return hydrateSkill(base) as Skill;
}

describe('parseSkillDoc', () => {
  it('reads front matter and body', () => {
    const doc = parseSkillDoc(
      '---\nname: Martial Arts\ndescription: When bodies collide.\nkeywords: fight, punch\ntags: action\n---\n\n## Core\nkeep the weight low',
    );
    expect(doc.name).toBe('Martial Arts');
    expect(doc.description).toBe('When bodies collide.');
    expect(doc.keywords).toEqual(['fight', 'punch']);
    expect(doc.tags).toEqual(['action']);
    expect(doc.body.startsWith('## Core')).toBe(true);
  });

  it('falls back to heading and first prose line', () => {
    const doc = parseSkillDoc('# Cooking\n\nHeat is a tool, not a setting.\n\nmore');
    expect(doc.name).toBe('Cooking');
    expect(doc.description).toBe('Heat is a tool, not a setting.');
    expect(doc.body.includes('# Cooking')).toBe(false);
  });

  it('survives a bare paste with no structure at all', () => {
    const doc = parseSkillDoc('just some text', 'notes.txt');
    expect(doc.name).toBe('notes.txt');
    expect(doc.description).toBe('just some text');
  });

  it('round-trips through export', () => {
    const skill = makeSkill({ id: 'a', name: 'Seduction', keywords: ['flirt'], tags: ['social'] });
    const doc = parseSkillDoc(exportSkillDoc(skill));
    expect(doc.name).toBe('Seduction');
    expect(doc.keywords).toEqual(['flirt']);
    expect(doc.body.trim()).toBe(skill.body.trim());
  });
});

describe('sections and digest', () => {
  it('splits on headings', () => {
    const sections = splitSections('## A\nline a\n\n## B\nline b');
    expect(sections.map((s) => s.heading)).toEqual(['A', 'B']);
  });

  it('derives a digest that names what the document covers', () => {
    const body = 'Fighting is weight before impact.\n\n## Stance\nx\n\n## Tells\ny';
    const digest = deriveDigest(body, splitSections(body));
    expect(digest).toContain('weight before impact');
    expect(digest).toContain('Stance');
  });
});

describe('extractSkillTag', () => {
  it('pulls names and strips the tag', () => {
    const r = extractSkillTag('She lunges.\n\n[[SKILLS: Martial Arts, Seduction]]');
    expect(r.found).toBe(true);
    expect(r.names).toEqual(['martial arts', 'seduction']);
    expect(r.text).toBe('She lunges.');
  });

  it('treats none as an empty selection', () => {
    const r = extractSkillTag('Quiet talk.\n[[SKILLS: none]]');
    expect(r.found).toBe(true);
    expect(r.names).toEqual([]);
  });

  it('reports absence so the scout can take over', () => {
    expect(extractSkillTag('no tag here').found).toBe(false);
  });

  it('lets the last tag win when the model corrects itself', () => {
    const r = extractSkillTag('[[SKILLS: cooking]] wait\n[[SKILLS: dancing]]');
    expect(r.names).toEqual(['dancing']);
  });
});

describe('createSkillTagFilter', () => {
  const run = (chunks: string[]) => {
    const f = createSkillTagFilter();
    return chunks.map((c) => f.push(c)).join('') + f.flush();
  };

  it('never emits a tag that arrives split across deltas', () => {
    const out = run(['She ', 'lunges.', '\n\n[[SK', 'ILLS: Mar', 'tial Arts]]']);
    expect(out).toBe('She lunges.');
  });

  it('passes prose through unharmed', () => {
    expect(run(['A ', 'quiet ', 'night.'])).toBe('A quiet night.');
  });

  it('keeps interior whitespace once more prose follows', () => {
    expect(run(['one\n\n', 'two'])).toBe('one\n\ntwo');
  });

  it('releases square brackets that were never a tag', () => {
    expect(run(['note [[not a tag]] end'])).toBe('note [[not a tag]] end');
  });

  it('does not strand a trailing open bracket', () => {
    expect(run(['end ['])).toBe('end [');
  });
});

describe('shortlistSkills', () => {
  it('ranks keyword hits above idle priority', () => {
    const fight = makeSkill({ id: 'f', name: 'Martial Arts', keywords: ['punch'], priority: 10 });
    const cook = makeSkill({ id: 'c', name: 'Cooking', keywords: ['stew'], priority: 90 });
    const list = shortlistSkills({ skills: [cook, fight], recentText: 'he throws a punch', max: 2 });
    expect(list[0].id).toBe('f');
  });

  it('always advertises what is already loaded so it can be dropped', () => {
    const skills = Array.from({ length: 5 }, (_, i) => makeSkill({ id: `s${i}`, name: `S${i}` }));
    const list = shortlistSkills({ skills, recentText: '', activeIds: ['s4'], max: 2 });
    expect(list.map((s) => s.id)).toContain('s4');
  });
});

describe('resolveActiveSkills', () => {
  const settings = { ...DEFAULT_SKILLS_SETTINGS };

  it('injects always-on skills without any decision', () => {
    const skills = [makeSkill({ id: 'a', name: 'A', mode: 'always' })];
    const r = resolveActiveSkills({ skills, state: emptyChatSkillState(), settings, messageCount: 0 });
    expect(r.skills.map((s) => s.id)).toEqual(['a']);
    expect(r.reasons.a).toBe('always');
  });

  it('lets a chat mute override everything', () => {
    const skills = [makeSkill({ id: 'a', name: 'A', mode: 'always' })];
    const state = { ...emptyChatSkillState(), muted: ['a'], forced: ['a'] };
    const r = resolveActiveSkills({ skills, state, settings, messageCount: 0 });
    expect(r.skills).toEqual([]);
  });

  it('honours the maxActive cap but never drops a forced pin', () => {
    const skills = [
      makeSkill({ id: 'a', name: 'A', mode: 'always', priority: 90 }),
      makeSkill({ id: 'b', name: 'B', mode: 'always', priority: 80 }),
      makeSkill({ id: 'c', name: 'C', priority: 10 }),
    ];
    const state = { ...emptyChatSkillState(), forced: ['c'] };
    const r = resolveActiveSkills({ skills, state, settings: { ...settings, maxActive: 2 }, messageCount: 0 });
    expect(r.skills.map((s) => s.id)).toContain('c');
    expect(r.skills).toHaveLength(2);
  });

  it('ignores the selector entirely in manual mode', () => {
    const skills = [makeSkill({ id: 'a', name: 'A' })];
    const state = { ...emptyChatSkillState(), active: [{ id: 'a', since: 0 }] };
    const r = resolveActiveSkills({ skills, state, settings: { ...settings, selection: 'manual' }, messageCount: 5 });
    expect(r.skills).toEqual([]);
  });

  it('injects nothing at all when selection is off', () => {
    const skills = [makeSkill({ id: 'a', name: 'A', mode: 'always' })];
    const r = resolveActiveSkills({
      skills, state: emptyChatSkillState(), settings: { ...settings, selection: 'off' }, messageCount: 0,
    });
    expect(r.skills).toEqual([]);
  });
});

describe('applyDecision', () => {
  const skills = [makeSkill({ id: 'ma', name: 'Martial Arts' }), makeSkill({ id: 'ck', name: 'Cooking' })];

  it('matches loosely written names', () => {
    expect(matchSkillName(skills, 'martial-arts')?.id).toBe('ma');
    expect(matchSkillName(skills, 'Martial Arts')?.id).toBe('ma');
    expect(matchSkillName(skills, 'nonsense')).toBeNull();
  });

  it('keeps a freshly armed skill through one omission', () => {
    let state = applyDecision(emptyChatSkillState(), skills, ['martial arts'], 10, 'fight', 'inline');
    expect(state.active.map((a) => a.id)).toEqual(['ma']);
    state = applyDecision(state, skills, [], 11, 'talking', 'inline');
    expect(state.active.map((a) => a.id)).toEqual(['ma']);
  });

  it('drops it once stickiness has expired', () => {
    let state = applyDecision(emptyChatSkillState(), skills, ['martial arts'], 10, 'fight', 'inline');
    state = applyDecision(state, skills, [], 20, 'over', 'inline');
    expect(state.active).toEqual([]);
  });
});

describe('composeSkillBlock', () => {
  const big = makeSkill({
    id: 'big', name: 'Big', priority: 90,
    body: ['One', 'Two', 'Three', 'Four', 'Five', 'Six']
      .map((h) => `## ${h}\n${`${h.toLowerCase()} `.repeat(40)}`)
      .join('\n\n'),
  });
  const small = makeSkill({ id: 'small', name: 'Small', priority: 10, body: 'short body' });

  it('gives the full document when there is room', () => {
    const r = composeSkillBlock({ skills: [small], budget: 4000 });
    expect(r.levels.small).toBe('full');
    expect(r.text).toContain('short body');
  });

  it('degrades to sections rather than cutting mid-sentence', () => {
    const r = composeSkillBlock({ skills: [big], budget: 320 });
    expect(r.levels.big).toBe('sections');
    expect(r.text).toContain('remaining sections omitted');
  });

  it('keeps every skill at digest level before upgrading any of them', () => {
    const r = composeSkillBlock({ skills: [big, small], budget: 220 });
    expect(r.levels.small).not.toBe('dropped');
    expect(r.text).toContain('Small');
  });

  it('produces nothing at all when the budget is gone', () => {
    const r = composeSkillBlock({ skills: [big], budget: 0 });
    expect(r.text).toBe('');
  });

  it('never exceeds its budget', () => {
    for (const budget of [120, 400, 900, 5000]) {
      const r = composeSkillBlock({ skills: [big, small], budget });
      expect(r.tokens).toBeLessThanOrEqual(budget);
    }
  });
});

describe('planSkillBudget', () => {
  it('caps at the configured share', () => {
    const b = planSkillBudget({ usable: 10_000, fixedPromptTokens: 0, brainTokens: 0, share: 0.25 });
    expect(b).toBe(2500);
  });

  it('never eats the history floor', () => {
    const b = planSkillBudget({ usable: 4000, fixedPromptTokens: 3000, brainTokens: 400, share: 0.25 });
    expect(b).toBe(88);
  });

  it('returns zero rather than a negative when context is already full', () => {
    const b = planSkillBudget({ usable: 2000, fixedPromptTokens: 1800, brainTokens: 400, share: 0.25 });
    expect(b).toBe(0);
  });

  it('is bounded by the hard ceiling even if asked for more', () => {
    const b = planSkillBudget({ usable: 10_000, fixedPromptTokens: 0, brainTokens: 0, share: 0.9 });
    expect(b).toBe(3500);
  });
});

describe('parseSkillDoc — model output shapes', () => {
  const doc = [
    '---',
    'name: Martial Arts',
    'description: When two people are actually trying to hurt each other.',
    'keywords: fight, punch',
    'tags: action',
    '---',
    '',
    '## Core principles',
    'weight lands before the strike does',
  ].join('\n');

  it('unwraps a document the model fenced as markdown', () => {
    // Left fenced, the front matter parses as body and the skill arrives with
    // no description — the one field the router reads.
    const parsed = parseSkillDoc('```markdown\n' + doc + '\n```');
    expect(parsed.name).toBe('Martial Arts');
    expect(parsed.description).toContain('hurt each other');
    expect(parsed.keywords).toEqual(['fight', 'punch']);
  });

  it('unwraps a bare fence too', () => {
    expect(parseSkillDoc('```\n' + doc + '\n```').name).toBe('Martial Arts');
  });

  it('leaves fenced examples inside a body alone', () => {
    const withExample = `${doc}\n\n\`\`\`\nnot the whole document\n\`\`\``;
    const parsed = parseSkillDoc(withExample);
    expect(parsed.name).toBe('Martial Arts');
    expect(parsed.body).toContain('not the whole document');
  });
});

describe('stickiness counts from the last confirmation', () => {
  const skills = [makeSkill({ id: 'ma', name: 'Martial Arts', stickyTurns: 2 })];

  it('keeps a long-running skill alive through one quiet beat', () => {
    let state = applyDecision(emptyChatSkillState(), skills, ['Martial Arts'], 10, 'fight', 'inline');
    for (let at = 11; at <= 30; at++) {
      state = applyDecision(state, skills, ['Martial Arts'], at, 'fight', 'inline');
    }
    expect(state.active[0].since).toBe(10);
    expect(state.active[0].lastSeen).toBe(30);

    state = applyDecision(state, skills, [], 31, 'dialogue', 'inline');
    expect(state.active.map((a) => a.id)).toEqual(['ma']);
  });

  it('reads a state written before lastSeen existed', () => {
    const legacy = { ...emptyChatSkillState(), active: [{ id: 'ma', since: 9 }] };
    const next = applyDecision(legacy, skills, [], 10, 'quiet', 'inline');
    expect(next.active.map((a) => a.id)).toEqual(['ma']);
  });
});
