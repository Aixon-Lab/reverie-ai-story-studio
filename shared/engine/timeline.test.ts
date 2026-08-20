/** Timeline / branching engine tests */
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatBranch } from '../types';
import {
  applyContinueText,
  applySwipeText,
  branchPointPreview,
  buildTimelineFromMessages,
  createCheckpoint,
  defaultBranchName,
  deleteFork,
  deleteMessageOnPath,
  forkCountByMessage,
  forkFromMessage,
  forksAtMessage,
  graphViewModel,
  migrateLegacyBranches,
  prepareDeepSwipe,
  prepareSwipeSwitch,
  renameFork,
  restoreFork,
  TimelineError,
  validateTimeline,
} from './timeline';

function msg(
  id: string,
  text: string,
  opts: Partial<ChatMessage> & { controlledBy?: 'human' | 'ai' } = {},
): ChatMessage {
  const controlledBy = opts.controlledBy ?? 'ai';
  return {
    id,
    ts: Date.now(),
    speaker: opts.speaker ?? {
      type: controlledBy === 'human' ? 'user' : 'character',
      displayName: controlledBy === 'human' ? 'You' : 'Char',
      characterId: controlledBy === 'ai' ? 'c1' : undefined,
    },
    controlledBy,
    text,
    swipes: opts.swipes ?? [text],
    swipeIndex: opts.swipeIndex ?? 0,
    ...opts,
  };
}

function linear(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      msg('m' + i, (i % 2 === 0 ? 'User ' : 'AI ') + i, {
        controlledBy: i % 2 === 0 ? 'human' : 'ai',
      }),
    );
  }
  return out;
}

describe('buildTimelineFromMessages', () => {
  it('builds parent chain and tip', () => {
    const messages = linear(3);
    const tl = buildTimelineFromMessages(messages);
    expect(tl.tipId).toBe('m2');
    expect(tl.nodes.m0.parentId).toBeNull();
    expect(tl.nodes.m1.parentId).toBe('m0');
    expect(tl.nodes.m2.parentId).toBe('m1');
    expect(validateTimeline(messages, tl)).toEqual([]);
  });

  it('handles empty chat', () => {
    const tl = buildTimelineFromMessages([]);
    expect(tl.tipId).toBeNull();
    expect(Object.keys(tl.nodes)).toHaveLength(0);
  });
});

describe('createCheckpoint', () => {
  it('saves a fork without changing messages', () => {
    const messages = linear(4);
    const tl = buildTimelineFromMessages(messages);
    const r = createCheckpoint(messages, tl, { name: 'Save point' });
    expect(r.messagesChanged).toBe(false);
    expect(r.timeline.forks).toHaveLength(1);
    expect(r.timeline.forks[0].name).toBe('Save point');
    expect(r.timeline.forks[0].messages).toHaveLength(4);
    expect(r.messages).toBe(messages);
  });
});

describe('forkFromMessage', () => {
  it('truncates after fork point and preserves full path', () => {
    const messages = linear(6);
    const tl = buildTimelineFromMessages(messages);
    const r = forkFromMessage(messages, tl, 'm2', { reason: 'manual_fork', name: 'Alt' });
    expect(r.messagesChanged).toBe(true);
    expect(r.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
    expect(r.timeline.forks).toHaveLength(1);
    expect(r.timeline.forks[0].messages).toHaveLength(6);
    expect(r.timeline.tipId).toBe('m2');
  });

  it('checkpoint-only when forking from tip', () => {
    const messages = linear(3);
    const tl = buildTimelineFromMessages(messages);
    const r = forkFromMessage(messages, tl, 'm2', { name: 'Tip save' });
    expect(r.messagesChanged).toBe(false);
    expect(r.messages).toHaveLength(3);
    expect(r.timeline.forks[0].reason).toBe('checkpoint');
  });
});

describe('prepareDeepSwipe', () => {
  it('no-op when target is tip', () => {
    const messages = linear(3);
    messages[2] = msg('m2', 'AI tip', { controlledBy: 'ai' });
    const tl = buildTimelineFromMessages(messages);
    const r = prepareDeepSwipe(messages, tl, 'm2');
    expect(r.messagesChanged).toBe(false);
    expect(r.timeline.forks).toHaveLength(0);
  });

  it('forks and truncates mid-history AI', () => {
    const messages = [
      msg('u0', 'hi', { controlledBy: 'human' }),
      msg('a1', 'hello', { controlledBy: 'ai' }),
      msg('u2', 'more', { controlledBy: 'human' }),
      msg('a3', 'ok', { controlledBy: 'ai' }),
    ];
    const tl = buildTimelineFromMessages(messages);
    const r = prepareDeepSwipe(messages, tl, 'a1', { policy: 'preserve' });
    expect(r.messages.map((m) => m.id)).toEqual(['u0', 'a1']);
    expect(r.timeline.forks[0].reason).toBe('deep_swipe');
    expect(r.timeline.forks[0].messages).toHaveLength(4);
  });

  it('throws NEEDS_CONFIRM under confirm policy', () => {
    const messages = [
      msg('u0', 'hi', { controlledBy: 'human' }),
      msg('a1', 'hello', { controlledBy: 'ai' }),
      msg('u2', 'more', { controlledBy: 'human' }),
    ];
    const tl = buildTimelineFromMessages(messages);
    try {
      prepareDeepSwipe(messages, tl, 'a1', { policy: 'confirm' });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TimelineError);
      expect((e as TimelineError).code).toBe('NEEDS_CONFIRM');
    }
  });

  it('rejects human messages', () => {
    const messages = linear(2);
    const tl = buildTimelineFromMessages(messages);
    expect(() => prepareDeepSwipe(messages, tl, 'm0')).toThrow(TimelineError);
  });
});

describe('prepareSwipeSwitch', () => {
  it('switches swipe on tip without fork', () => {
    const messages = [
      msg('a0', 'v1', { controlledBy: 'ai', swipes: ['v1', 'v2'], swipeIndex: 0 }),
    ];
    const tl = buildTimelineFromMessages(messages);
    const r = prepareSwipeSwitch(messages, tl, 'a0', 1);
    expect(r.messages[0].text).toBe('v2');
    expect(r.messages[0].swipeIndex).toBe(1);
    expect(r.timeline.forks).toHaveLength(0);
  });

  it('preserves future when switching mid-history swipe', () => {
    const messages = [
      msg('a0', 'v1', { controlledBy: 'ai', swipes: ['v1', 'v2'], swipeIndex: 0 }),
      msg('u1', 'next', { controlledBy: 'human' }),
    ];
    const tl = buildTimelineFromMessages(messages);
    const r = prepareSwipeSwitch(messages, tl, 'a0', 1, { policy: 'preserve' });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].text).toBe('v2');
    expect(r.timeline.forks[0].reason).toBe('swipe_switch');
    expect(r.timeline.forks[0].messages).toHaveLength(2);
  });
});

describe('restoreFork', () => {
  it('restores snapshot and auto-saves before_restore', () => {
    const messages = linear(4);
    let tl = buildTimelineFromMessages(messages);
    const cp = createCheckpoint(messages, tl, { name: 'A' });
    tl = cp.timeline;
    const alt = linear(2).map((m, i) => ({ ...m, id: 'x' + i, text: 'alt ' + i }));
    const r = restoreFork(alt, tl, cp.createdForkId!);
    expect(r.messages).toHaveLength(4);
    expect(r.messages[0].id).toBe('m0');
    expect(r.timeline.forks.some((f) => f.reason === 'before_restore')).toBe(true);
  });
});

describe('rename/delete fork', () => {
  it('renames and deletes', () => {
    const messages = linear(2);
    let tl = buildTimelineFromMessages(messages);
    const cp = createCheckpoint(messages, tl, { name: 'Old' });
    tl = cp.timeline;
    tl = renameFork(tl, cp.createdForkId!, 'New Name');
    expect(tl.forks[0].name).toBe('New Name');
    tl = deleteFork(tl, cp.createdForkId!);
    expect(tl.forks).toHaveLength(0);
  });
});

describe('deleteMessageOnPath', () => {
  it('removes message and successors, checkpoints first', () => {
    const messages = linear(5);
    const tl = buildTimelineFromMessages(messages);
    const r = deleteMessageOnPath(messages, tl, 'm2');
    expect(r.messages.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(r.timeline.forks[0].reason).toBe('before_delete');
    expect(r.timeline.forks[0].messages).toHaveLength(5);
  });
});

describe('applySwipeText / applyContinueText', () => {
  it('appends swipe on tip', () => {
    const messages = [msg('a0', 'one', { controlledBy: 'ai' })];
    const next = applySwipeText(messages, 'a0', 'two');
    expect(next[0].swipes).toEqual(['one', 'two']);
    expect(next[0].swipeIndex).toBe(1);
    expect(next[0].text).toBe('two');
  });

  it('updates active swipe slot on continue', () => {
    const messages = [
      msg('a0', 'hello', { controlledBy: 'ai', swipes: ['hello', 'alt'], swipeIndex: 0 }),
    ];
    const next = applyContinueText(messages, 'a0', 'hello world');
    expect(next[0].text).toBe('hello world');
    expect(next[0].swipes![0]).toBe('hello world');
    expect(next[0].swipes![1]).toBe('alt');
  });

  it('rejects swipe apply on non-tip', () => {
    const messages = linear(2);
    messages[0] = msg('m0', 'ai', { controlledBy: 'ai' });
    expect(() => applySwipeText(messages, 'm0', 'x')).toThrow(TimelineError);
  });

  /**
   * The id has to stay stable (the timeline is built on it), so the revision is
   * the only signal that the words under a message changed. Without it the
   * Character Brain's read cursor could never tell that the tip it had already
   * consumed now says something else entirely.
   */
  it('bumps the revision on every in-place rewrite', () => {
    const messages = [msg('a0', 'one', { controlledBy: 'ai' })];
    const swiped = applySwipeText(messages, 'a0', 'two');
    expect(swiped[0].revision).toBe(1);
    const again = applySwipeText(swiped, 'a0', 'three');
    expect(again[0].revision).toBe(2);
    const continued = applyContinueText(again, 'a0', 'three and then some');
    expect(continued[0].revision).toBe(3);
  });
});

describe('migrateLegacyBranches', () => {
  it('imports meta.branches into forks', () => {
    const messages = linear(2);
    const tl = buildTimelineFromMessages(messages);
    const branches: ChatBranch[] = [
      {
        id: 'legacy1',
        name: 'Old checkpoint',
        createdAt: 123,
        messages: linear(1),
        parentMessageId: 'm0',
      },
    ];
    const r = migrateLegacyBranches(tl, branches);
    expect(r.migrated).toBe(true);
    expect(r.clearMetaBranches).toBe(true);
    expect(r.timeline.forks[0].id).toBe('legacy1');
    expect(r.timeline.forks[0].reason).toBe('checkpoint');
  });
});

describe('fork helpers', () => {
  it('indexes forks by fork message and previews branch point', () => {
    const messages = linear(4);
    const tl = buildTimelineFromMessages(messages);
    const r = forkFromMessage(messages, tl, 'm1', { reason: 'manual_fork', name: 'Alt path' });
    expect(forksAtMessage(r.timeline, 'm1')).toHaveLength(1);
    expect(forkCountByMessage(r.timeline).m1).toBe(1);
    const fork = r.timeline.forks[0];
    expect(branchPointPreview(fork, r.messages)).toMatch(/:/);
    expect(defaultBranchName(messages[1], false)).toMatch(/^After /);
    expect(defaultBranchName(messages[3], true)).toMatch(/^Checkpoint /);
  });
});

describe('graphViewModel', () => {
  it('marks tip and swipe counts', () => {
    const messages = [
      msg('a0', 'v1', { controlledBy: 'ai', swipes: ['v1', 'v2'], swipeIndex: 1 }),
      msg('u1', 'ok', { controlledBy: 'human' }),
    ];
    const tl = buildTimelineFromMessages(messages);
    const g = graphViewModel(messages, tl);
    expect(g[0].swipeCount).toBe(2);
    expect(g[0].swipeIndex).toBe(1);
    expect(g[0].canDeepSwipe).toBe(true);
    expect(g[1].isTip).toBe(true);
    expect(g[1].canDeepSwipe).toBe(false);
  });
});
