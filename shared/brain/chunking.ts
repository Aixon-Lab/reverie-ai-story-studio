/**
 * Splitting a stretch of conversation into consolidation passes.
 *
 * One pass used to read *everything* unread in a single model call. On a long
 * scene — and always on "re-read all" — that means a prompt the model cannot
 * hold, an answer capped at a few thousand tokens trying to represent hundreds
 * of messages, and a wait with nothing on screen. What came back was one thin
 * summary of an entire history.
 *
 * Chunking fixes both halves: each call is bounded and fast, and each stretch
 * gets the encoder's full attention, so a long conversation yields the memories
 * it actually contains. The chunks are *not* separate minds — every pass loads
 * the same brain, sees what earlier chunks encoded, and extends, merges or
 * contradicts it. The split is only how the reading is paced.
 *
 * Boundaries are message indices, not turn indices, because the read cursor is
 * stored as a message position: a chunk that ends between two messages could
 * never be resumed.
 */

export interface ChunkPlanOptions {
  /**
   * Token cost of each message in the window, in order. Messages that never
   * reach the encoder (hidden, empty) weigh 0 but still occupy a position, so
   * the cursor can land on them.
   */
  weights: number[];
  /** Index in the full message list that `weights[0]` corresponds to. */
  offset?: number;
  /** Transcript tokens a single pass may read. */
  maxTokens: number;
  /** Hard cap on messages per pass, so one chunk stays a readable scene. */
  maxMessages: number;
  /**
   * A trailing chunk smaller than this is folded into the one before it — a
   * whole model call for two leftover lines is worse than a slightly long pass.
   */
  minTailMessages?: number;
}

export interface Chunk {
  /** Absolute message index, inclusive. */
  start: number;
  /** Absolute message index, exclusive — and the cursor position after the pass. */
  end: number;
  tokens: number;
  messages: number;
}

/** How much slack folding a small tail may add to a chunk's token budget. */
const TAIL_FOLD_SLACK = 1.35;

export function planChunks(opts: ChunkPlanOptions): Chunk[] {
  const { weights, maxTokens, maxMessages } = opts;
  const offset = opts.offset ?? 0;
  const minTail = opts.minTailMessages ?? 0;
  if (!weights.length) return [];

  const budget = Math.max(1, maxTokens);
  const cap = Math.max(1, Math.floor(maxMessages));

  const chunks: Chunk[] = [];
  let start = 0;
  let tokens = 0;

  for (let i = 0; i < weights.length; i++) {
    const w = Math.max(0, weights[i] || 0);
    const count = i - start;
    // A single message over budget still has to be read: it becomes its own
    // chunk rather than blocking the walk forever.
    const wouldOverflow = count > 0 && (tokens + w > budget || count >= cap);
    if (wouldOverflow) {
      chunks.push({ start: offset + start, end: offset + i, tokens, messages: count });
      start = i;
      tokens = 0;
    }
    tokens += w;
  }
  chunks.push({
    start: offset + start,
    end: offset + weights.length,
    tokens,
    messages: weights.length - start,
  });

  // Fold a stub tail back into its predecessor when the budget can absorb it.
  if (chunks.length > 1 && minTail > 0) {
    const tail = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (
      tail.messages < minTail
      && prev.tokens + tail.tokens <= budget * TAIL_FOLD_SLACK
      && prev.messages + tail.messages <= cap * TAIL_FOLD_SLACK
    ) {
      chunks.splice(chunks.length - 2, 2, {
        start: prev.start,
        end: tail.end,
        tokens: prev.tokens + tail.tokens,
        messages: prev.messages + tail.messages,
      });
    }
  }

  return chunks;
}

/**
 * Transcript budget for one pass, from the model's real window.
 *
 * The encoder prompt is more than the transcript — the character sheet, the
 * candidate memories it must compare against, the contract — and the answer
 * needs room of its own. What is left over is what a pass may read, held inside
 * sane bounds so a huge window does not recreate the single-giant-call problem
 * it was meant to solve.
 */
export function transcriptBudget(opts: {
  contextTokens: number;
  reservedOutput?: number;
  promptOverhead?: number;
  /** Never read less than this per pass, even on a tiny window. */
  floor?: number;
  /** Never read more than this per pass, however large the window. */
  ceiling?: number;
}): number {
  const output = opts.reservedOutput ?? 3500;
  const overhead = opts.promptOverhead ?? 2500;
  const floor = opts.floor ?? 1200;
  const ceiling = opts.ceiling ?? 8000;
  const usable = Math.floor((opts.contextTokens || 0) - output - overhead);
  return Math.max(floor, Math.min(ceiling, usable));
}
