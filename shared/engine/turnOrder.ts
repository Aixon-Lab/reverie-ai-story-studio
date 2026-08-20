/**
 * Series turn order.
 *
 * The cast is an ordered list of seats and `cursor` is whose turn it is. Three
 * kinds of seat cannot take an AI turn: a muted one, one whose card is gone, and
 * one the human occupies. They are *walked over*, never treated as a turn — a
 * cursor resting on the player's own seat used to end the round with nobody
 * speaking, which looked exactly like the series dying on its own.
 *
 * The cursor is an index, so it also has to be re-anchored whenever the roster
 * changes shape; otherwise removing or dragging a member silently hands the turn
 * to whoever slid into that slot.
 */

export interface SeatContext {
  /** Speaking order, by character id. */
  order: string[];
  /** Character ids whose cards still exist in the chat. */
  present: Iterable<string>;
  /** Muted seats — skipped in every turn mode. */
  muted?: Iterable<string>;
  /** Seats the human occupies — the AI never voices these. */
  human?: Iterable<string>;
  /** Whose turn it is. Out-of-range values wrap. */
  cursor?: number;
}

function set(ids: Iterable<string> | undefined): Set<string> {
  return ids instanceof Set ? ids : new Set(ids ?? []);
}

/** Normalise any cursor (negative, past the end, undefined) to a real index. */
export function normalizeCursor(cursor: number | undefined, length: number): number {
  if (!length) return 0;
  const c = Number.isFinite(cursor) ? Math.trunc(cursor as number) : 0;
  return ((c % length) + length) % length;
}

/** Can the AI speak for this seat? */
export function canSpeak(ctx: SeatContext, id: string): boolean {
  return set(ctx.present).has(id) && !set(ctx.muted).has(id) && !set(ctx.human).has(id);
}

/**
 * The next seat an AI may take, starting at the cursor and wrapping once.
 * `null` when nobody in the cast can speak.
 */
export function nextSpeakerId(ctx: SeatContext): string | null {
  const n = ctx.order.length;
  if (!n) return null;
  const start = normalizeCursor(ctx.cursor, n);
  for (let step = 0; step < n; step++) {
    const id = ctx.order[(start + step) % n];
    if (canSpeak(ctx, id)) return id;
  }
  return null;
}

/** Cursor that resumes the series directly after `id`. */
export function cursorAfterId(order: string[], id: string): number | null {
  const i = order.indexOf(id);
  return i < 0 ? null : (i + 1) % order.length;
}

/**
 * Cursor for a roster that just changed: keep it on the character it pointed at,
 * or — if they are the one who left — on the next survivor in the old order.
 */
export function reanchorCursor(prevOrder: string[], nextOrder: string[], cursor?: number): number {
  if (!prevOrder.length || !nextOrder.length) return 0;
  const start = normalizeCursor(cursor, prevOrder.length);
  for (let step = 0; step < prevOrder.length; step++) {
    const i = nextOrder.indexOf(prevOrder[(start + step) % prevOrder.length]);
    if (i >= 0) return i;
  }
  return 0;
}
