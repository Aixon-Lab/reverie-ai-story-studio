/** Timeline file I/O + load/migrate helpers for chats. */
import path from 'node:path';
import type { ChatMessage, ChatMeta, TimelineState } from '../../shared/types';
import {
  buildTimelineFromMessages,
  emptyTimeline,
  migrateLegacyBranches,
} from '../../shared/engine/timeline';
import { dirs, readJson, sanitizeId, writeJsonAtomic } from '../storage';

export const timelineFile = (id: string) =>
  path.join(dirs.chats, `${sanitizeId(id)}.timeline.json`);

export async function loadTimelineRaw(chatId: string): Promise<TimelineState | null> {
  return readJson<TimelineState | null>(timelineFile(chatId), null);
}

export async function saveTimeline(chatId: string, timeline: TimelineState): Promise<void> {
  await writeJsonAtomic(timelineFile(chatId), timeline);
}

/**
 * Load timeline for a chat, rebuilding nodes from messages and migrating legacy meta.branches.
 * Returns updated meta if branches were cleared (caller should persist).
 */
export async function loadTimelineForChat(
  chatId: string,
  messages: ChatMessage[],
  meta: ChatMeta,
): Promise<{ timeline: TimelineState; meta: ChatMeta; metaDirty: boolean }> {
  const existing = await loadTimelineRaw(chatId);
  const hadFile = !!(existing && existing.version === 1);
  let raw = hadFile ? existing! : emptyTimeline();
  let timeline = buildTimelineFromMessages(messages, raw);
  const mig = migrateLegacyBranches(timeline, meta.branches);
  timeline = mig.timeline;
  let metaDirty = false;
  let nextMeta = meta;
  if (mig.clearMetaBranches && meta.branches?.length) {
    nextMeta = { ...meta, branches: undefined };
    metaDirty = true;
  }
  if (!hadFile || mig.migrated) {
    await saveTimeline(chatId, timeline);
  }
  return { timeline, meta: nextMeta, metaDirty };
}

export function metaSnapshot(meta: ChatMeta) {
  return {
    summary: meta.summary,
    variables: meta.variables,
    director: meta.director,
  };
}
