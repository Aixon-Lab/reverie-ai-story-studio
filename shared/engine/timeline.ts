/**
 * Pure timeline / branching engine.
 * Active path stays a linear ChatMessage[]; forks are full path snapshots with metadata.
 */
import type {
  ChatBranch,
  ChatMessage,
  ChatMeta,
  DirectorState,
  TimelineFork,
  TimelineForkReason,
  TimelineGraphNode,
  TimelineMidHistoryPolicy,
  TimelineNodeMeta,
  TimelineState,
} from '../types';

export class TimelineError extends Error {
  constructor(
    message: string,
    public code:
      | 'NOT_FOUND'
      | 'NEEDS_CONFIRM'
      | 'BLOCKED'
      | 'EMPTY'
      | 'BUSY_STATE'
      | 'INVALID',
  ) {
    super(message);
    this.name = 'TimelineError';
  }
}

export interface PathSnapshotExtras {
  summary?: string;
  variables?: Record<string, string>;
  director?: DirectorState;
}

export interface TimelineOpResult {
  timeline: TimelineState;
  messages: ChatMessage[];
  /** True when active path messages changed (truncate/restore). */
  messagesChanged: boolean;
  warnings: string[];
  /** Fork created by this op, if any. */
  createdForkId?: string;
}

const PREVIEW_LEN = 96;
const NAME_MAX = 80;

function cloneMessages(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.map((m) => ({
    ...m,
    speaker: { ...m.speaker },
    swipes: m.swipes ? [...m.swipes] : undefined,
    extra: m.extra ? { ...m.extra } : undefined,
  }));
}

function clampName(name: string, fallback: string): string {
  const t = name.trim() || fallback;
  return t.length > NAME_MAX ? t.slice(0, NAME_MAX) : t;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `tl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function previewText(text: string, max = PREVIEW_LEN): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

export function emptyTimeline(): TimelineState {
  return { version: 1, nodes: {}, tipId: null, forks: [], viewingForkId: null };
}

/** Build parent chain from a linear active path. */
export function buildTimelineFromMessages(
  messages: ChatMessage[],
  existing?: TimelineState | null,
): TimelineState {
  const nodes: Record<string, TimelineNodeMeta> = {};
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    nodes[m.id] = {
      id: m.id,
      parentId: i === 0 ? null : messages[i - 1].id,
      fromParentSwipe: i === 0 ? undefined : messages[i - 1].swipeIndex ?? 0,
    };
  }
  return {
    version: 1,
    nodes,
    tipId: messages.at(-1)?.id ?? null,
    forks: existing?.forks ? [...existing.forks] : [],
    viewingForkId: existing?.viewingForkId ?? null,
  };
}

/** Rebuild edges after bulk edit/delete; keep forks intact. */
export function reindexFromMessages(
  messages: ChatMessage[],
  timeline: TimelineState,
): TimelineState {
  return buildTimelineFromMessages(messages, timeline);
}

/** Migrate legacy meta.branches full dumps into timeline forks (once). */
export function migrateLegacyBranches(
  timeline: TimelineState,
  branches: ChatBranch[] | undefined,
): { timeline: TimelineState; migrated: boolean; clearMetaBranches: boolean } {
  if (!branches?.length) {
    return { timeline, migrated: false, clearMetaBranches: false };
  }
  const existingIds = new Set(timeline.forks.map((f) => f.id));
  const added: TimelineFork[] = [];
  for (const b of branches) {
    if (existingIds.has(b.id)) continue;
    added.push({
      id: b.id,
      name: b.name || `Checkpoint ${new Date(b.createdAt).toLocaleString()}`,
      createdAt: b.createdAt || Date.now(),
      reason: 'checkpoint',
      tipMessageId: b.parentMessageId ?? b.messages.at(-1)?.id,
      forkMessageId: b.parentMessageId,
      messages: cloneMessages(b.messages ?? []),
    });
  }
  if (!added.length) {
    return { timeline, migrated: false, clearMetaBranches: true };
  }
  return {
    timeline: { ...timeline, forks: [...timeline.forks, ...added] },
    migrated: true,
    clearMetaBranches: true,
  };
}

export function pathPreview(messages: ChatMessage[], maxChars = 140): string {
  if (!messages.length) return '(empty)';
  const last = messages[messages.length - 1];
  const who = last.speaker.displayName || last.speaker.type;
  return `${messages.length} msgs · ${who}: ${previewText(last.text, maxChars)}`;
}

/** Forks that split at / were saved against a given message id. */
export function forksAtMessage(timeline: TimelineState, messageId: string): TimelineFork[] {
  return timeline.forks.filter(
    (f) => f.forkMessageId === messageId || (!f.forkMessageId && f.tipMessageId === messageId),
  );
}

/** Count of forks keyed by fork point message id (for message badges). */
export function forkCountByMessage(timeline: TimelineState | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!timeline?.forks?.length) return out;
  for (const f of timeline.forks) {
    const key = f.forkMessageId || f.tipMessageId;
    if (!key) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Human label for where a fork split: speaker + short preview of the fork-point message.
 * Prefers the message still on the active path; falls back to the fork's own snapshot.
 */
export function branchPointPreview(
  fork: TimelineFork,
  activeMessages?: ChatMessage[] | null,
  maxChars = 72,
): string {
  const pointId = fork.forkMessageId || fork.tipMessageId;
  if (!pointId) return 'Unknown split point';
  const fromActive = activeMessages?.find((m) => m.id === pointId);
  const fromFork = fork.messages.find((m) => m.id === pointId);
  const msg = fromActive ?? fromFork ?? fork.messages.at(-1);
  if (!msg) return 'Unknown split point';
  const who = msg.speaker.displayName || msg.speaker.type;
  return `${who}: ${previewText(msg.text, maxChars)}`;
}

/** Default name when the user branches from a message. */
export function defaultBranchName(message: ChatMessage | undefined, isTip: boolean): string {
  if (isTip) return `Checkpoint ${new Date().toLocaleString()}`;
  const who = message?.speaker.displayName?.trim() || 'message';
  return `After ${who} · ${new Date().toLocaleTimeString()}`;
}

export function graphViewModel(
  messages: ChatMessage[],
  timeline: TimelineState,
): TimelineGraphNode[] {
  const tipId = timeline.tipId ?? messages.at(-1)?.id ?? null;
  return messages.map((m, index) => {
    const swipeCount = Math.max(m.swipes?.length ?? 1, 1);
    const isTip = m.id === tipId;
    return {
      id: m.id,
      parentId: timeline.nodes[m.id]?.parentId ?? (index === 0 ? null : messages[index - 1]?.id ?? null),
      index,
      speakerName: m.speaker.displayName,
      speakerType: m.speaker.type,
      controlledBy: m.controlledBy,
      preview: previewText(m.text),
      swipeCount,
      swipeIndex: m.swipeIndex ?? 0,
      hiddenFromPrompt: m.hiddenFromPrompt,
      isTip,
      canDeepSwipe: m.controlledBy === 'ai' && m.speaker.type !== 'system',
    };
  });
}

function snapshotExtras(meta?: Pick<ChatMeta, 'summary' | 'variables' | 'director'> | null): PathSnapshotExtras | undefined {
  if (!meta) return undefined;
  const snap: PathSnapshotExtras = {};
  if (meta.summary !== undefined) snap.summary = meta.summary;
  if (meta.variables !== undefined) snap.variables = { ...meta.variables };
  if (meta.director !== undefined) snap.director = meta.director ? { ...meta.director } : undefined;
  if (!snap.summary && !snap.variables && !snap.director) return undefined;
  return snap;
}

export function createCheckpoint(
  messages: ChatMessage[],
  timeline: TimelineState,
  opts: {
    name?: string;
    reason?: TimelineForkReason;
    forkMessageId?: string;
    meta?: Pick<ChatMeta, 'summary' | 'variables' | 'director'> | null;
  } = {},
): TimelineOpResult {
  const reason = opts.reason ?? 'checkpoint';
  const name = clampName(
    opts.name ?? '',
    reason === 'checkpoint'
      ? `Checkpoint ${new Date().toLocaleString()}`
      : `${reason} ${new Date().toLocaleTimeString()}`,
  );
  const fork: TimelineFork = {
    id: newId(),
    name,
    createdAt: Date.now(),
    reason,
    tipMessageId: messages.at(-1)?.id,
    forkMessageId: opts.forkMessageId ?? messages.at(-1)?.id,
    messages: cloneMessages(messages),
    snapshot: snapshotExtras(opts.meta),
  };
  const next: TimelineState = {
    ...timeline,
    nodes: { ...timeline.nodes },
    forks: [...timeline.forks, fork],
  };
  const synced = buildTimelineFromMessages(messages, next);
  return {
    timeline: synced,
    messages,
    messagesChanged: false,
    warnings: messages.length === 0 ? ['Saved an empty checkpoint.'] : [],
    createdForkId: fork.id,
  };
}

/**
 * Snapshot full current path, then truncate active path to messageId (inclusive).
 */
export function forkFromMessage(
  messages: ChatMessage[],
  timeline: TimelineState,
  messageId: string,
  opts: {
    name?: string;
    reason?: TimelineForkReason;
    meta?: Pick<ChatMeta, 'summary' | 'variables' | 'director'> | null;
    /** If true, only checkpoint when message is already tip (no truncate). */
    checkpointIfTip?: boolean;
  } = {},
): TimelineOpResult {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) throw new TimelineError('Message not found on active path.', 'NOT_FOUND');

  const isTip = idx === messages.length - 1;
  if (isTip && opts.checkpointIfTip !== false) {
    return createCheckpoint(messages, timeline, {
      name: opts.name,
      reason: opts.reason ?? 'checkpoint',
      forkMessageId: messageId,
      meta: opts.meta,
    });
  }

  const warnings: string[] = [];
  let tl = timeline;
  let createdForkId: string | undefined;

  if (idx < messages.length - 1 || messages.length > 0) {
    const cp = createCheckpoint(messages, tl, {
      name: opts.name ?? `Branch before ${new Date().toLocaleTimeString()}`,
      reason: opts.reason ?? 'manual_fork',
      forkMessageId: messageId,
      meta: opts.meta,
    });
    tl = cp.timeline;
    createdForkId = cp.createdForkId;
    warnings.push(...cp.warnings);
  }

  const truncated = cloneMessages(messages.slice(0, idx + 1));
  const synced = buildTimelineFromMessages(truncated, tl);
  return {
    timeline: synced,
    messages: truncated,
    messagesChanged: !isTip,
    warnings,
    createdForkId,
  };
}

/**
 * Prepare deep swipe: if target is not tip, fork+truncate so target becomes tip.
 */
export function prepareDeepSwipe(
  messages: ChatMessage[],
  timeline: TimelineState,
  messageId: string,
  opts: {
    policy?: TimelineMidHistoryPolicy;
    confirmed?: boolean;
    name?: string;
    meta?: Pick<ChatMeta, 'summary' | 'variables' | 'director'> | null;
  } = {},
): TimelineOpResult {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) throw new TimelineError('Message not found on active path.', 'NOT_FOUND');
  const msg = messages[idx];
  if (msg.controlledBy !== 'ai') {
    throw new TimelineError('Only AI messages can be deep-swiped.', 'INVALID');
  }

  const policy = opts.policy ?? 'preserve';
  const hasDescendants = idx < messages.length - 1;

  if (!hasDescendants) {
    return {
      timeline: buildTimelineFromMessages(messages, timeline),
      messages,
      messagesChanged: false,
      warnings: [],
    };
  }

  if (policy === 'block') {
    throw new TimelineError(
      'Deep swipe mid-history is blocked. Use "Branch from here" first, or change timeline policy.',
      'BLOCKED',
    );
  }
  if (policy === 'confirm' && !opts.confirmed) {
    throw new TimelineError(
      'Deep swipe will save the current future as a branch and remove messages after this point. Confirm to continue.',
      'NEEDS_CONFIRM',
    );
  }

  return forkFromMessage(messages, timeline, messageId, {
    name: opts.name ?? `Before deep swipe ${new Date().toLocaleTimeString()}`,
    reason: 'deep_swipe',
    meta: opts.meta,
    checkpointIfTip: false,
  });
}

/**
 * Change active swipe on a message. Mid-history with descendants → policy.
 */
export function prepareSwipeSwitch(
  messages: ChatMessage[],
  timeline: TimelineState,
  messageId: string,
  newIndex: number,
  opts: {
    policy?: TimelineMidHistoryPolicy;
    confirmed?: boolean;
    meta?: Pick<ChatMeta, 'summary' | 'variables' | 'director'> | null;
  } = {},
): TimelineOpResult {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) throw new TimelineError('Message not found on active path.', 'NOT_FOUND');

  const msg = messages[idx];
  const swipes = msg.swipes?.length ? msg.swipes : [msg.text];
  if (newIndex < 0 || newIndex >= swipes.length) {
    throw new TimelineError('Swipe index out of range.', 'INVALID');
  }

  const hasDescendants = idx < messages.length - 1;
  const swipeChanged = (msg.swipeIndex ?? 0) !== newIndex;
  const policy = opts.policy ?? 'preserve';
  const warnings: string[] = [];
  let tl = timeline;
  let working = messages;
  let createdForkId: string | undefined;
  let messagesChanged = false;

  if (hasDescendants && swipeChanged) {
    if (policy === 'block') {
      throw new TimelineError(
        'Changing swipe mid-history is blocked while later messages exist.',
        'BLOCKED',
      );
    }
    if (policy === 'confirm' && !opts.confirmed) {
      throw new TimelineError(
        'Changing this swipe will save the current future as a branch and remove later messages. Confirm to continue.',
        'NEEDS_CONFIRM',
      );
    }
    const forked = forkFromMessage(working, tl, messageId, {
      name: `Before swipe switch ${new Date().toLocaleTimeString()}`,
      reason: 'swipe_switch',
      meta: opts.meta,
      checkpointIfTip: false,
    });
    tl = forked.timeline;
    working = forked.messages;
    createdForkId = forked.createdForkId;
    messagesChanged = forked.messagesChanged;
    warnings.push(...forked.warnings);
  }

  const nextMsgs = working.map((m) => {
    if (m.id !== messageId) return m;
    const list = m.swipes?.length ? m.swipes : [m.text];
    return {
      ...m,
      swipes: list,
      swipeIndex: newIndex,
      text: list[newIndex],
    };
  });

  return {
    timeline: buildTimelineFromMessages(nextMsgs, tl),
    messages: nextMsgs,
    messagesChanged: messagesChanged || swipeChanged,
    warnings,
    createdForkId,
  };
}

export function restoreFork(
  currentMessages: ChatMessage[],
  timeline: TimelineState,
  forkId: string,
  opts: {
    meta?: Pick<ChatMeta, 'summary' | 'variables' | 'director'> | null;
    skipBeforeSnapshot?: boolean;
  } = {},
): TimelineOpResult & { restoredSnapshot?: PathSnapshotExtras } {
  const fork = timeline.forks.find((f) => f.id === forkId);
  if (!fork) throw new TimelineError('Branch not found.', 'NOT_FOUND');

  let tl = timeline;
  const warnings: string[] = [];
  let createdForkId: string | undefined;

  if (!opts.skipBeforeSnapshot) {
    const before = createCheckpoint(currentMessages, tl, {
      name: `Before restore ${new Date().toLocaleTimeString()}`,
      reason: 'before_restore',
      meta: opts.meta,
    });
    tl = before.timeline;
    createdForkId = before.createdForkId;
    warnings.push(...before.warnings);
  }

  const restored = cloneMessages(fork.messages);
  const synced = buildTimelineFromMessages(restored, {
    ...tl,
    viewingForkId: null,
  });

  return {
    timeline: synced,
    messages: restored,
    messagesChanged: true,
    warnings,
    createdForkId,
    restoredSnapshot: fork.snapshot,
  };
}

export function renameFork(timeline: TimelineState, forkId: string, name: string): TimelineState {
  const idx = timeline.forks.findIndex((f) => f.id === forkId);
  if (idx === -1) throw new TimelineError('Branch not found.', 'NOT_FOUND');
  const forks = [...timeline.forks];
  forks[idx] = { ...forks[idx], name: clampName(name, forks[idx].name) };
  return { ...timeline, forks };
}

export function deleteFork(timeline: TimelineState, forkId: string): TimelineState {
  const forks = timeline.forks.filter((f) => f.id !== forkId);
  if (forks.length === timeline.forks.length) {
    throw new TimelineError('Branch not found.', 'NOT_FOUND');
  }
  return {
    ...timeline,
    forks,
    viewingForkId: timeline.viewingForkId === forkId ? null : timeline.viewingForkId,
  };
}

/**
 * Delete a message and all active-path successors.
 */
export function deleteMessageOnPath(
  messages: ChatMessage[],
  timeline: TimelineState,
  messageId: string,
  opts: {
    preserveFuture?: boolean;
    meta?: Pick<ChatMeta, 'summary' | 'variables' | 'director'> | null;
  } = {},
): TimelineOpResult {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) throw new TimelineError('Message not found on active path.', 'NOT_FOUND');

  let tl = timeline;
  let createdForkId: string | undefined;
  const warnings: string[] = [];
  const hasFuture = idx < messages.length - 1;

  if (opts.preserveFuture !== false && (hasFuture || messages.length > 0)) {
    const cp = createCheckpoint(messages, tl, {
      name: `Before delete ${new Date().toLocaleTimeString()}`,
      reason: 'before_delete',
      forkMessageId: messageId,
      meta: opts.meta,
    });
    tl = cp.timeline;
    createdForkId = cp.createdForkId;
    warnings.push(...cp.warnings);
  }

  const next = cloneMessages(messages.slice(0, idx));
  return {
    timeline: buildTimelineFromMessages(next, tl),
    messages: next,
    messagesChanged: true,
    warnings,
    createdForkId,
  };
}

export function afterAppend(
  messages: ChatMessage[],
  timeline: TimelineState,
): TimelineState {
  return buildTimelineFromMessages(messages, timeline);
}

export function applySwipeText(
  messages: ChatMessage[],
  messageId: string,
  text: string,
): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) throw new TimelineError('Message not found on active path.', 'NOT_FOUND');
  if (idx !== messages.length - 1) {
    throw new TimelineError('Can only apply a new swipe on the tip message. Prepare deep swipe first.', 'INVALID');
  }
  return messages.map((m, i) => {
    if (i !== idx) return m;
    const base = m.swipes?.length ? m.swipes : [m.text];
    const swipes = [...base, text];
    return {
      ...m,
      swipes,
      swipeIndex: swipes.length - 1,
      text,
      // Same id, different words — anything that already read this message needs
      // to know (see `ChatMessage.revision`).
      revision: (m.revision ?? 0) + 1,
    };
  });
}

/** Keep swipes[] in sync when continue extends tip text. */
export function applyContinueText(
  messages: ChatMessage[],
  messageId: string,
  fullText: string,
): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) throw new TimelineError('Message not found on active path.', 'NOT_FOUND');
  if (idx !== messages.length - 1) {
    throw new TimelineError('Continue only applies to the tip message.', 'INVALID');
  }
  return messages.map((m, i) => {
    if (i !== idx) return m;
    const swipes = m.swipes?.length ? [...m.swipes] : [m.text];
    const si = m.swipeIndex ?? 0;
    const safeIdx = Math.min(Math.max(si, 0), swipes.length - 1);
    swipes[safeIdx] = fullText;
    return { ...m, text: fullText, swipes, swipeIndex: safeIdx, revision: (m.revision ?? 0) + 1 };
  });
}

export function validateTimeline(
  messages: ChatMessage[],
  timeline: TimelineState,
): string[] {
  const issues: string[] = [];
  const ids = new Set(messages.map((m) => m.id));
  if (timeline.tipId && !ids.has(timeline.tipId) && messages.length) {
    issues.push(`tipId ${timeline.tipId} not on active path`);
  }
  if (!timeline.tipId && messages.length) {
    issues.push('missing tipId');
  }
  for (const m of messages) {
    if (!timeline.nodes[m.id]) issues.push(`missing node for ${m.id}`);
  }
  for (const [id, node] of Object.entries(timeline.nodes)) {
    if (!ids.has(id)) issues.push(`orphan node ${id}`);
    if (node.parentId && ids.has(id)) {
      const idx = messages.findIndex((m) => m.id === id);
      if (idx > 0 && messages[idx - 1].id !== node.parentId) {
        issues.push(`parent mismatch for ${id}`);
      }
    }
  }
  for (const f of timeline.forks) {
    if (!f.messages) issues.push(`fork ${f.id} missing messages`);
  }
  return issues;
}

export function forkCountWarning(
  timeline: TimelineState,
  maxWarning = 40,
): string | null {
  if (timeline.forks.length >= maxWarning) {
    return `You have ${timeline.forks.length} saved branches. Consider deleting old ones to save disk.`;
  }
  return null;
}

export function findMessageIndex(messages: ChatMessage[], messageId: string): number {
  return messages.findIndex((m) => m.id === messageId);
}

export function isTip(messages: ChatMessage[], messageId: string): boolean {
  return messages.at(-1)?.id === messageId;
}
