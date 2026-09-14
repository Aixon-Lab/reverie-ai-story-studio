/** All persistence and provider boundaries mocked: no runtime data or paid calls. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyBrain } from '../../shared/brain/defaults';
import { applyLearning } from '../../shared/brain/learning';
import type { CharacterCard, ChatMessage, TextConnection } from '../../shared/types';

const io = vi.hoisted(() => ({ brain: null as any, response: '', calls: 0, audit: [] as any[], gate: 'escalate', fail: false }));
vi.mock('./store', () => ({
  loadBrain: async () => structuredClone(io.brain),
  loadBrainIfExists: async () => structuredClone(io.brain),
  saveBrain: async (b: any) => { io.brain = structuredClone(b); },
  appendAudit: async (_chat: string, _char: string, entry: any) => { io.audit.push(entry); },
  summarizeReport: () => 'test report',
  withBrainLock: async (_chat: string, _char: string, fn: () => Promise<any>) => fn(),
}));
vi.mock('../providers/text', () => ({ generateOnce: async () => {
  io.calls++; if (io.fail) throw new Error('synthetic provider failure'); return io.response;
} }));
vi.mock('../providers/contextLimits', () => ({ resolveContextLimit: async () => ({ contextTokens: 16384 }) }));
vi.mock('../../shared/brain/admission', () => ({ gateChunk: () => ({ action: io.gate, admitted: [], reason: 'fixture', counts: {} }) }));
import { buildBrainContext, runConsolidation } from './service';

const card = { id: 'maya', name: 'Maya', description: 'An art student', personality: 'Curious' } as CharacterCard;
const conn = {} as TextConnection;
const message = { id: 'm1', ts: 1000, speaker: { type: 'user', displayName: 'Teacher' }, controlledBy: 'human',
  text: 'Maya is taught to rotate the brush 90 degrees when painting an angular mark.' } as ChatMessage;
const lesson = { learner: 'Maya', skill: 'Painting', domain: 'physical', technique: 'Rotate the brush 90 degrees.',
  when: 'Painting an angular mark', outcome: '', mode: 'taught', messageId: 'm1', quote: message.text };
const opts = () => ({ chatId: 'chat-a', messages: [message], card, conn, cast: ['Maya', 'Teacher'], isGroup: false, now: 2000 });
beforeEach(() => {
  io.brain = emptyBrain('chat-a', 'maya', 'Maya', 1000);
  io.response = JSON.stringify({ events: [], learning: [lesson] });
  io.calls = 0; io.audit = []; io.gate = 'escalate'; io.fail = false;
});

describe('learning through the actual memory orchestration', () => {
  it('extracts a quiet lesson through the existing call, saves it and consumes its cursor', async () => {
    io.gate = 'drop';
    const result = await runConsolidation(opts());
    expect(result.encoder).toBe('model');
    expect(io.calls).toBe(1);
    expect(io.brain.learnedSkills).toHaveLength(1);
    expect(io.brain.stats.cursor['chat-a']).toBe(1);
    expect(io.audit.at(-1).detail.learned).toBe(1);
    await runConsolidation(opts());
    expect(io.calls).toBe(1);
    expect(io.brain.learnedSkills[0].evidence).toHaveLength(1);
  });

  it('retries malformed learning instead of accepting a nonempty garbage array', async () => {
    io.response = JSON.stringify({ events: [], learning: [{ ...lesson, messageId: 'invented' }] });
    const result = await runConsolidation(opts());
    expect(io.calls).toBe(2);
    expect(io.brain.learnedSkills).toHaveLength(0);
    expect(result.encoder).toBe('heuristic');
  });

  it('preserves emotional episodes when a model returns only learning', async () => {
    const result = await runConsolidation({ ...opts(), messages: [{ ...message,
      text: `${message.text} Her teacher betrayed her trust and threatened to kill her. Maya screamed in terror and fled.` }] });
    expect(io.calls).toBe(1);
    expect(result.brain.learnedSkills).toHaveLength(1);
    expect(Object.keys(result.brain.nodes).length).toBeGreaterThan(0);
  });

  it('keeps episodic memory working when the provider fails', async () => {
    io.fail = true;
    const result = await runConsolidation({ ...opts(), messages: [{ ...message,
      text: 'Maya was terrified. Her teacher betrayed her trust and threatened to kill her. She screamed in fear and fled.' }] });
    expect(io.calls).toBe(2);
    expect(result.encoder).toBe('heuristic');
    expect(Object.keys(io.brain.nodes).length).toBeGreaterThan(0);
    expect(io.brain.learnedSkills ?? []).toEqual([]);
  });

  it('does not call a provider for unremarkable text that the existing gate drops', async () => {
    io.gate = 'drop';
    await runConsolidation({ ...opts(), messages: [{ ...message, text: 'Good morning. Yes, hello.' }] });
    expect(io.calls).toBe(0);
  });

  it('respects the brain disabled switch', async () => {
    io.brain.config.enabled = false;
    await runConsolidation(opts());
    expect(io.calls).toBe(0);
    expect(io.brain.learnedSkills).toBeUndefined();
  });

  it('injects relevant learning with no generation-time model request and reconciles edits', async () => {
    await runConsolidation(opts());
    const result = await buildBrainContext({ brains: [{ card, brain: structuredClone(io.brain) }],
      history: [message], cast: ['Maya', 'Teacher'], conn, reservedOutput: 1000, now: 3000 });
    expect(result?.text).toContain('LEARNED THROUGH THIS CHAT');
    expect(result?.text).toContain('Rotate the brush 90 degrees.');
    expect(io.calls).toBe(1);
    const edited = await buildBrainContext({ brains: [{ card, brain: structuredClone(io.brain) }],
      history: [{ ...message, text: 'Maya leaves before the lesson.' }], cast: ['Maya', 'Teacher'], conn, reservedOutput: 1000, now: 3000 });
    expect(edited?.text ?? '').not.toContain('LEARNED THROUGH THIS CHAT');
    expect(io.calls).toBe(1);
  });

  it('persists removal of deleted source evidence even with no unread messages', async () => {
    applyLearning(io.brain, [lesson], [{ id: message.id, speaker: 'Teacher', isUser: true, text: message.text }], 1000, () => 't1');
    await runConsolidation({ ...opts(), messages: [] });
    expect(io.brain.learnedSkills).toEqual([]);
    expect(io.calls).toBe(0);
  });
});
