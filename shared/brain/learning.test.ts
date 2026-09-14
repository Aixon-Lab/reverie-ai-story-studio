import { describe, expect, it } from 'vitest';
import { emptyBrain, normalizeBrain } from './defaults';
import { applyLearning, composeLearning, hasLearningCue, learningStage, normalizeLearning, reconcileLearning, relevantLearning } from './learning';
import { mergeGenerationEffects } from './persist';
import type { TranscriptTurn } from './heuristics';

const lesson = { learner: 'Maya', skill: 'Painting', domain: 'physical', technique: 'Rotate the brush 90 degrees.',
  when: 'Painting an angular mark', outcome: '', mode: 'taught', messageId: 'm1', quote: 'Rotate the brush 90 degrees.' };
const turn: TranscriptTurn = { id: 'm1', speaker: 'Teacher', text: 'Maya, to paint an angular mark: Rotate the brush 90 degrees.', isUser: true };
const makeBrain = () => emptyBrain('chat-a', 'maya', 'Maya', 1000);
let serial = 0;
const id = () => `technique-${++serial}`;
function seeded() { const b = makeBrain(); applyLearning(b, [lesson], [turn], 1000, id); return b; }

describe('experience-derived learning', () => {
  it('stores a precise lesson without manufacturing practice or general mastery', () => {
    const b = seeded();
    expect(b.learnedSkills).toHaveLength(1);
    expect(b.learnedSkills![0].technique).toContain('90');
    expect(learningStage(b.learnedSkills![0])).toBe('understood, untested');
    expect(emptyBrain('other-chat', 'maya', 'Maya').learnedSkills).toBeUndefined();
    expect(emptyBrain('chat-a', 'other-character', 'Lina').learnedSkills).toBeUndefined();
  });

  it.each([
    { learner: 'Lina' }, { messageId: 'missing' }, { quote: 'Rotate it 45 degrees.' },
    { technique: 'Rotate it 45 degrees.' }, { technique: 'Rotate it 9 degrees.' }, { technique: 'Rotate it -90 degrees.' },
    { mode: 'mastered' }, { domain: 'magic' },
    { when: '' }, { technique: 'x'.repeat(421) }, { quote: 123 },
  ])('rejects unsupported or malformed input %j', patch => {
    const b = makeBrain();
    expect(applyLearning(b, [{ ...lesson, ...patch }], [turn], 1000, id)).toBe(0);
    expect(b.learnedSkills).toHaveLength(0);
  });

  it('handles null, scalar and nested garbage without breaking memory', () => {
    const b = makeBrain();
    for (const raw of [null, 42, {}, 'bad', [null, 0, [], {}]]) {
      expect(applyLearning(b, raw, [turn], 1000, id)).toBe(0);
      expect(normalizeLearning(raw)).toEqual([]);
    }
  });

  it('force-reading, retries and paraphrases cannot award the same evidence twice', () => {
    const b = seeded();
    expect(applyLearning(b, [{ ...lesson, mode: 'succeeded' }], [turn], 2000, id)).toBe(0);
    expect(applyLearning(b, [{ ...lesson, technique: 'Turn the brush 90 degrees.' }], [turn], 2000, id)).toBe(0);
    expect(b.learnedSkills![0].evidence).toHaveLength(1);
    expect(learningStage(b.learnedSkills![0])).toBe('understood, untested');
  });

  it('grows through distinct successful attempts, never through retrieval', () => {
    const b = seeded();
    for (let i = 2; i <= 4; i++) {
      const practiced = { ...turn, id: `m${i}`, text: `${turn.text} Maya tries it successfully. Attempt ${i}.` };
      applyLearning(b, [{ ...lesson, mode: 'succeeded', messageId: practiced.id }], [practiced], i * 1000, id);
    }
    expect(b.learnedSkills).toHaveLength(1);
    expect(learningStage(b.learnedSkills![0])).toBe('repeated success');
    const before = JSON.stringify(b.learnedSkills);
    for (let i = 0; i < 20; i++) composeLearning(b, 'Painting an angular mark', 900);
    expect(JSON.stringify(b.learnedSkills)).toBe(before);
  });

  it('tracks unsuccessful practice without pretending it worked', () => {
    const b = seeded();
    const failed = { ...turn, id: 'm2', text: `${turn.text} Maya tries and fails.` };
    applyLearning(b, [{ ...lesson, mode: 'failed', messageId: 'm2' }], [failed], 2000, id);
    expect(learningStage(b.learnedSkills![0])).toBe('needs practice');
  });

  it('accumulates different practice outcomes on the same technique and removes an edited outcome', () => {
    const b = seeded();
    const failed = { ...turn, id: 'm2', text: `${turn.text} The mark smears.` };
    const worked = { ...turn, id: 'm3', text: `${turn.text} The mark is crisp.` };
    applyLearning(b, [{ ...lesson, mode: 'failed', messageId: 'm2', quote: failed.text, outcome: 'The mark smears.' }], [failed], 2000, id);
    applyLearning(b, [{ ...lesson, mode: 'succeeded', messageId: 'm3', quote: worked.text, outcome: 'The mark is crisp.' }], [worked], 3000, id);
    expect(b.learnedSkills).toHaveLength(1);
    expect(b.learnedSkills![0].evidence).toHaveLength(3);
    expect(b.learnedSkills![0].outcome).toBe('The mark is crisp.');
    reconcileLearning(b, [turn, failed]);
    expect(b.learnedSkills![0].outcome).toBe('The mark smears.');
  });

  it('keeps conditions distinct and explicit corrections reversible', () => {
    const b = seeded();
    const oldId = b.learnedSkills![0].id;
    const correction = { ...turn, id: 'm2', text: 'For this angular mark, rotate 45 degrees instead.' };
    applyLearning(b, [{ ...lesson, messageId: 'm2', quote: correction.text, technique: 'Rotate 45 degrees instead.', mode: 'corrected', supersedes: oldId }], [correction], 2000, id);
    expect(b.learnedSkills).toHaveLength(2);
    expect(relevantLearning(b, 'Painting an angular mark').map(t => t.id)).not.toContain(oldId);
    b.learnedSkills![1].muted = true;
    expect(relevantLearning(b, 'Painting an angular mark').map(t => t.id)).toEqual([oldId]);
    b.learnedSkills![1].muted = false;
    expect(reconcileLearning(b, [turn])).toBe(1);
    expect(relevantLearning(b, 'Painting an angular mark').map(t => t.id)).toEqual([oldId]);
  });

  it('invalidates evidence after edits, deletions and branch changes, keeping untouched lessons', () => {
    const b = seeded();
    const source = { ...turn, id: 'm2', text: `${turn.text} Again.` };
    applyLearning(b, [{ ...lesson, messageId: 'm2' }], [source], 2000, id);
    expect(reconcileLearning(b, [{ ...turn, text: `${turn.text} Actually Maya was absent.` }, source])).toBe(1);
    expect(b.learnedSkills![0].evidence.map(e => e.messageId)).toEqual(['m2']);
    expect(reconcileLearning(b, [])).toBe(1);
    expect(b.learnedSkills).toEqual([]);
  });

  it('round-trips saves and migrates old or malformed records without touching existing memory', () => {
    const b = seeded();
    expect(normalizeBrain(JSON.parse(JSON.stringify(b)), b.chatId, b.characterId, b.characterName).learnedSkills).toEqual(b.learnedSkills);
    expect(normalizeBrain({ nodes: {} }, 'a', 'b', 'Maya').learnedSkills).toEqual([]);
    expect(normalizeLearning([{ ...b.learnedSkills![0], evidence: [null, {}] }])).toEqual([]);
  });

  it('concurrent generation cannot revert learned evidence or a user mute', () => {
    const fresh = seeded(), stale = structuredClone(fresh);
    fresh.learnedSkills![0].muted = true;
    const t2 = { ...turn, id: 'm2' };
    applyLearning(fresh, [{ ...lesson, messageId: 'm2' }], [t2], 2000, id);
    mergeGenerationEffects(fresh, stale);
    expect(fresh.learnedSkills![0].muted).toBe(true);
    expect(fresh.learnedSkills![0].evidence).toHaveLength(2);
  });

  it('keeps whole techniques inside the budget and emits nothing irrelevant or muted', () => {
    const b = seeded();
    const full = composeLearning(b, 'Painting an angular mark', 900);
    expect(full.text).toContain('90');
    expect(full.text).toContain('understood, untested');
    for (const cap of [0, 1, 60, full.tokens - 1, full.tokens, 900, NaN, Infinity]) {
      const result = composeLearning(b, 'Painting an angular mark', cap);
      if (Number.isFinite(cap)) expect(result.tokens).toBeLessThanOrEqual(cap);
      if (result.text) expect(result.text).toContain(lesson.technique);
    }
    expect(composeLearning(b, 'A spaceship lands on the moon', 900).text).toBe('');
    b.learnedSkills![0].muted = true;
    expect(composeLearning(b, 'Painting an angular mark', 900).text).toBe('');
  });

  it('recognizes quiet lessons for routing but does not invent anything from cues', () => {
    expect(hasLearningCue('She was taught how to rotate the brush.')).toBe(true);
    expect(hasLearningCue('He demonstrates how to stir rice.')).toBe(true);
    expect(hasLearningCue('Hello, good morning.')).toBe(false);
  });
});
