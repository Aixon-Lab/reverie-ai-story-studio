/**
 * Read-position regression tests.
 *
 * The bug these exist to prevent: a message *count* used as a cursor survives
 * neither a deleted message nor a deep-swipe fork, and once it points past the
 * end of the transcript the "enough new messages?" gate subtracts to a negative
 * number, which is smaller than any cadence — so consolidation stops for that
 * conversation permanently, with nothing in the log to say why.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared/types';
import { emptyBrain } from '../../shared/brain/defaults';
import { resolveCursor } from './service';

function msgs(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    ts: 1000 + i,
    speaker: { type: 'user', displayName: 'Jonas' },
    controlledBy: 'human',
    text: `line ${i}`,
  })) as unknown as ChatMessage[];
}

const CHAT = 'chat-1';

function brainAt(cursor: number, lastId?: string, extra?: { revision?: number; trail?: string[] }) {
  const brain = emptyBrain(CHAT, 'char-1', 'Wren');
  brain.stats.cursor[CHAT] = cursor;
  if (lastId) brain.stats.cursorMessageId = { [CHAT]: lastId };
  if (extra?.revision !== undefined) brain.stats.cursorRevision = { [CHAT]: extra.revision };
  if (extra?.trail) brain.stats.cursorTrail = { [CHAT]: extra.trail };
  return brain;
}

describe('resolveCursor', () => {
  it('reads from the start when the brain has never looked', () => {
    const c = resolveCursor(emptyBrain(CHAT, 'char-1', 'Wren'), CHAT, msgs(6));
    expect(c).toMatchObject({ start: 0, pending: 6, repaired: false });
  });

  it('resumes after the last consumed message, by id', () => {
    const c = resolveCursor(brainAt(4, 'm3'), CHAT, msgs(10));
    expect(c).toMatchObject({ start: 4, pending: 6, repaired: false });
  });

  it('follows the id even when messages were inserted before it', () => {
    const list = msgs(10);
    list.splice(1, 0, { ...list[0], id: 'inserted' } as ChatMessage);
    // Stored count says 4, but m3 now sits at index 4 — the id wins.
    const c = resolveCursor(brainAt(4, 'm3'), CHAT, list);
    expect(c.start).toBe(5);
    expect(c.pending).toBe(6);
  });

  it('never reports negative pending when history was shortened', () => {
    // The real failure: cursor 25 against a 24-message transcript.
    const c = resolveCursor(brainAt(25), CHAT, msgs(24));
    expect(c.pending).toBe(0);
    expect(c.start).toBe(24);
    expect(c.repaired).toBe(true);
    expect(c.note).toContain('clamped');
  });

  it('recovers when the message it stopped at is gone', () => {
    const c = resolveCursor(brainAt(8, 'deleted-message'), CHAT, msgs(6));
    expect(c.repaired).toBe(true);
    expect(c.start).toBe(6);
    expect(c.pending).toBe(0);
  });

  it('keeps counting new messages after a repair, so the cadence can fire again', () => {
    const repaired = resolveCursor(brainAt(25), CHAT, msgs(24));
    const brain = brainAt(repaired.start, `m${repaired.start - 1}`);
    const c = resolveCursor(brain, CHAT, msgs(28));
    expect(c).toMatchObject({ start: 24, pending: 4, repaired: false });
  });

  /**
   * A swipe, a Continue and an edit all rewrite a message in place and keep its
   * id — so an id-only cursor said "nothing new" forever, and the character went
   * on remembering the swipe the user threw away.
   */
  it('re-reads the tip when it was rewritten in place', () => {
    const list = msgs(10);
    list[9] = { ...list[9], text: 'a completely different reply', revision: 1 };
    const c = resolveCursor(brainAt(10, 'm9', { revision: 0 }), CHAT, list);
    expect(c).toMatchObject({ start: 9, pending: 1, repaired: true, reason: 'rewritten' });
  });

  it('leaves an unchanged tip alone, so the rewind cannot loop', () => {
    const c = resolveCursor(brainAt(10, 'm9', { revision: 3 }), CHAT, [
      ...msgs(9),
      { ...msgs(10)[9], revision: 3 },
    ]);
    expect(c).toMatchObject({ start: 10, pending: 0, repaired: false });
  });

  it('treats a brain written before revisions existed as up to date', () => {
    // No stored revision and no message revision: both read as 0.
    const c = resolveCursor(brainAt(10, 'm9'), CHAT, msgs(10));
    expect(c).toMatchObject({ start: 10, pending: 0, repaired: false });
  });

  /**
   * Deleting a message shifts every later index down by one, so resuming at the
   * stored *count* stepped over exactly one message that had never been read.
   */
  it('resumes exactly after the newest surviving message when the anchor is deleted', () => {
    const list = msgs(10).filter((m) => m.id !== 'm5');
    const c = resolveCursor(brainAt(6, 'm5', { trail: ['m2', 'm3', 'm4', 'm5'] }), CHAT, list);
    // m4 survived, so m6 (now at index 5) is the first unread message.
    expect(c.start).toBe(5);
    expect(list.slice(c.start).map((m) => m.id)).toEqual(['m6', 'm7', 'm8', 'm9']);
    expect(c.reason).toBe('deleted');
  });

  it('falls back to the clamped count when the whole trail is gone', () => {
    const c = resolveCursor(brainAt(8, 'gone', { trail: ['also-gone'] }), CHAT, msgs(6));
    expect(c).toMatchObject({ start: 6, pending: 0, repaired: true, reason: 'deleted' });
  });
});
