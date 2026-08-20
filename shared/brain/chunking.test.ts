import { describe, expect, it } from 'vitest';
import { planChunks, transcriptBudget, type Chunk } from './chunking';

const flat = (n: number, w: number) => Array.from({ length: n }, () => w);

/** Chunks must tile the window exactly: no gap, no overlap, nothing dropped. */
function expectContiguous(chunks: Chunk[], from: number, to: number) {
  expect(chunks[0].start).toBe(from);
  expect(chunks[chunks.length - 1].end).toBe(to);
  for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end);
  for (const c of chunks) expect(c.end).toBeGreaterThan(c.start);
}

describe('consolidation chunking', () => {
  it('reads a short stretch in a single pass', () => {
    const chunks = planChunks({ weights: flat(6, 100), maxTokens: 5000, maxMessages: 40 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ start: 0, end: 6, messages: 6, tokens: 600 });
  });

  it('splits on the token budget and covers every message', () => {
    const chunks = planChunks({ weights: flat(20, 500), maxTokens: 2000, maxMessages: 100 });
    // 4 messages per 2000-token pass.
    expect(chunks).toHaveLength(5);
    expect(chunks.every((c) => c.tokens <= 2000)).toBe(true);
    expectContiguous(chunks, 0, 20);
  });

  it('splits on the message cap even when the text is tiny', () => {
    const chunks = planChunks({ weights: flat(25, 5), maxTokens: 100_000, maxMessages: 10 });
    expect(chunks.map((c) => c.messages)).toEqual([10, 10, 5]);
    expectContiguous(chunks, 0, 25);
  });

  it('keeps an over-budget message rather than looping or dropping it', () => {
    const chunks = planChunks({ weights: [100, 9000, 100], maxTokens: 1000, maxMessages: 50 });
    expectContiguous(chunks, 0, 3);
    // The giant message is alone in its own pass.
    const big = chunks.find((c) => c.tokens >= 9000)!;
    expect(big.messages).toBe(1);
  });

  it('reports absolute message positions so the cursor can resume', () => {
    const chunks = planChunks({ weights: flat(9, 400), offset: 120, maxTokens: 1200, maxMessages: 50 });
    expectContiguous(chunks, 120, 129);
    expect(chunks[0]).toMatchObject({ start: 120, end: 123 });
  });

  it('folds a stub tail into the previous pass', () => {
    // 9 messages, 4 per pass → 4/4/1; a whole model call for one line is waste.
    const chunks = planChunks({
      weights: flat(9, 500), maxTokens: 2000, maxMessages: 40, minTailMessages: 2,
    });
    expect(chunks.map((c) => c.messages)).toEqual([4, 5]);
    expectContiguous(chunks, 0, 9);
  });

  it('leaves the tail alone when folding would badly overrun the budget', () => {
    // 4/4/3 — absorbing three more full-size messages is a 75% overrun, refused.
    const chunks = planChunks({
      weights: flat(11, 500), maxTokens: 2000, maxMessages: 40, minTailMessages: 4,
    });
    expect(chunks.map((c) => c.messages)).toEqual([4, 4, 3]);
    expectContiguous(chunks, 0, 11);
  });

  it('counts zero-weight messages so the cursor can land on them', () => {
    // Hidden messages weigh nothing but still occupy positions.
    const chunks = planChunks({
      weights: [0, 0, 900, 900, 0], maxTokens: 1000, maxMessages: 50,
    });
    expectContiguous(chunks, 0, 5);
  });

  it('has nothing to do for an empty window', () => {
    expect(planChunks({ weights: [], maxTokens: 4000, maxMessages: 40 })).toEqual([]);
  });

  it('sizes the transcript budget from the real window, within bounds', () => {
    expect(transcriptBudget({ contextTokens: 128_000 })).toBe(8000); // ceiling
    expect(transcriptBudget({ contextTokens: 8_000 })).toBe(2000);
    expect(transcriptBudget({ contextTokens: 4_000 })).toBe(1200); // floor
    expect(transcriptBudget({ contextTokens: 0 })).toBe(1200);
  });
});
