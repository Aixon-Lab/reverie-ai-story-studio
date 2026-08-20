/**
 * The encoder's output contract is advisory — models break it constantly.
 *
 * Every shape below was costing a whole consolidation pass: valid JSON, no
 * exception raised, zero events extracted, and an audit line reading "nothing
 * worth keeping" that blamed the conversation instead of the model.
 */
import { describe, expect, it } from 'vitest';
import { extractEvents } from './service';

const EVENT = {
  gist: 'Rooke revealed he works for Kessler, and Wren understood she had been sold.',
  appraisal: { novelty: 0.8, goalRelevance: 0.9 },
  salience: 0.7,
};

describe('extractEvents survives the shapes models actually return', () => {
  it('reads the documented contract', () => {
    expect(extractEvents({ events: [EVENT] })).toHaveLength(1);
  });

  it('reads a bare top-level array', () => {
    expect(extractEvents([EVENT])).toHaveLength(1);
  });

  it('reads a renamed key', () => {
    expect(extractEvents({ memories: [EVENT] })).toHaveLength(1);
    expect(extractEvents({ items: [EVENT] })).toHaveLength(1);
    expect(extractEvents({ data: [EVENT] })).toHaveLength(1);
  });

  it('reads a single event returned unwrapped', () => {
    expect(extractEvents({ event: EVENT })).toHaveLength(1);
  });

  it('digs the array out of an arbitrary wrapper', () => {
    const wrapped = { result: { memory: { encodedEvents: [EVENT, EVENT] } } };
    expect(extractEvents(wrapped)).toHaveLength(2);
  });

  it('recognises events whose gist was called something else', () => {
    expect(extractEvents({ events: [{ summary: EVENT.gist }] })).toHaveLength(1);
    expect(extractEvents({ events: [{ text: EVENT.gist }] })).toHaveLength(1);
  });

  it('returns nothing for an honest empty answer', () => {
    expect(extractEvents({ events: [] })).toEqual([]);
    expect(extractEvents({ chapterTitle: 'The Ruins' })).toEqual([]);
  });

  it('is not fooled by unrelated string arrays', () => {
    expect(extractEvents({ tags: ['betrayal', 'ruins'], notes: ['none'] })).toEqual([]);
  });

  it('does not hang on a self-referential object', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(extractEvents(cyclic)).toEqual([]);
  });

  it('tolerates junk', () => {
    expect(extractEvents(null)).toEqual([]);
    expect(extractEvents('nope')).toEqual([]);
    expect(extractEvents(42)).toEqual([]);
  });
});
