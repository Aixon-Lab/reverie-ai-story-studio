/** Timeline & branching HTTP routes. */
import { Router } from 'express';
import type { TimelineMidHistoryPolicy } from '../../shared/types';
import {
  buildTimelineFromMessages,
  createCheckpoint,
  deleteFork,
  forkFromMessage,
  forkCountWarning,
  graphViewModel,
  prepareDeepSwipe,
  prepareSwipeSwitch,
  renameFork,
  restoreFork,
  TimelineError,
} from '../../shared/engine/timeline';
import { loadSettings } from './library';
import {
  loadChatMeta,
  loadMessages,
  saveChatMeta,
  saveMessages,
} from './chats';
import { loadTimelineForChat, metaSnapshot, saveTimeline } from './timelineStore';

export const timelineRoutes = Router();

function timelineError(res: import('express').Response, err: unknown) {
  if (err instanceof TimelineError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'NEEDS_CONFIRM' ? 409 : err.code === 'BLOCKED' ? 403 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error(err);
  return res.status(500).json({ error: err instanceof Error ? err.message : 'Timeline error' });
}

async function policyForChat(): Promise<TimelineMidHistoryPolicy> {
  try {
    const settings = await loadSettings();
    return settings.timeline?.midHistoryPolicy ?? 'preserve';
  } catch {
    return 'preserve';
  }
}

timelineRoutes.get('/chats/:id/timeline', async (req, res) => {
  try {
    let meta = await loadChatMeta(req.params.id);
    const messages = await loadMessages(req.params.id);
    const loaded = await loadTimelineForChat(meta.id, messages, meta);
    if (loaded.metaDirty) {
      meta = loaded.meta;
      await saveChatMeta(meta);
    } else {
      await saveTimeline(meta.id, loaded.timeline);
    }
    const settings = await loadSettings().catch(() => null);
    const warning = forkCountWarning(loaded.timeline, settings?.timeline?.maxForksWarning ?? 40);
    res.json({
      meta,
      messages,
      timeline: loaded.timeline,
      graph: graphViewModel(messages, loaded.timeline),
      warning,
    });
  } catch (err) {
    timelineError(res, err);
  }
});

timelineRoutes.post('/chats/:id/timeline/checkpoint', async (req, res) => {
  try {
    const meta = await loadChatMeta(req.params.id);
    const messages = await loadMessages(req.params.id);
    const loaded = await loadTimelineForChat(meta.id, messages, meta);
    const name = (req.body as { name?: string })?.name;
    const result = createCheckpoint(messages, loaded.timeline, {
      name,
      reason: 'checkpoint',
      meta: metaSnapshot(meta),
    });
    await saveTimeline(meta.id, result.timeline);
    await saveChatMeta(loaded.metaDirty ? loaded.meta : meta);
    res.json({
      meta: loaded.metaDirty ? loaded.meta : meta,
      messages,
      timeline: result.timeline,
      graph: graphViewModel(messages, result.timeline),
      createdForkId: result.createdForkId,
      warnings: result.warnings,
    });
  } catch (err) {
    timelineError(res, err);
  }
});

timelineRoutes.post('/chats/:id/timeline/fork', async (req, res) => {
  try {
    const { messageId, name } = req.body as { messageId?: string; name?: string };
    if (!messageId) return res.status(400).json({ error: 'messageId required' });
    const meta = await loadChatMeta(req.params.id);
    const messages = await loadMessages(req.params.id);
    const loaded = await loadTimelineForChat(meta.id, messages, meta);
    const result = forkFromMessage(messages, loaded.timeline, messageId, {
      name,
      reason: 'manual_fork',
      meta: metaSnapshot(meta),
    });
    if (result.messagesChanged) await saveMessages(meta.id, result.messages);
    await saveTimeline(meta.id, result.timeline);
    await saveChatMeta(meta);
    res.json({
      meta,
      messages: result.messages,
      timeline: result.timeline,
      graph: graphViewModel(result.messages, result.timeline),
      createdForkId: result.createdForkId,
      warnings: result.warnings,
    });
  } catch (err) {
    timelineError(res, err);
  }
});

timelineRoutes.post('/chats/:id/timeline/restore', async (req, res) => {
  try {
    const { forkId } = req.body as { forkId?: string };
    if (!forkId) return res.status(400).json({ error: 'forkId required' });
    let meta = await loadChatMeta(req.params.id);
    const messages = await loadMessages(req.params.id);
    const loaded = await loadTimelineForChat(meta.id, messages, meta);
    const result = restoreFork(messages, loaded.timeline, forkId, { meta: metaSnapshot(meta) });
    if (result.restoredSnapshot) {
      meta = {
        ...meta,
        summary: result.restoredSnapshot.summary ?? meta.summary,
        variables: result.restoredSnapshot.variables ?? meta.variables,
        director: result.restoredSnapshot.director ?? meta.director,
      };
    }
    await saveMessages(meta.id, result.messages);
    await saveTimeline(meta.id, result.timeline);
    await saveChatMeta(meta);
    res.json({
      meta,
      messages: result.messages,
      timeline: result.timeline,
      graph: graphViewModel(result.messages, result.timeline),
      warnings: result.warnings,
    });
  } catch (err) {
    timelineError(res, err);
  }
});

timelineRoutes.patch('/chats/:id/timeline/forks/:forkId', async (req, res) => {
  try {
    const meta = await loadChatMeta(req.params.id);
    const messages = await loadMessages(req.params.id);
    const loaded = await loadTimelineForChat(meta.id, messages, meta);
    const name = String((req.body as { name?: string }).name ?? '');
    const timeline = renameFork(loaded.timeline, req.params.forkId, name);
    await saveTimeline(meta.id, timeline);
    res.json({ timeline, graph: graphViewModel(messages, timeline) });
  } catch (err) {
    timelineError(res, err);
  }
});

timelineRoutes.delete('/chats/:id/timeline/forks/:forkId', async (req, res) => {
  try {
    const meta = await loadChatMeta(req.params.id);
    const messages = await loadMessages(req.params.id);
    const loaded = await loadTimelineForChat(meta.id, messages, meta);
    const timeline = deleteFork(loaded.timeline, req.params.forkId);
    await saveTimeline(meta.id, timeline);
    res.json({ timeline, graph: graphViewModel(messages, timeline) });
  } catch (err) {
    timelineError(res, err);
  }
});

timelineRoutes.post('/chats/:id/timeline/deep-swipe', async (req, res) => {
  try {
    const { messageId, confirmed, name } = req.body as {
      messageId?: string;
      confirmed?: boolean;
      name?: string;
    };
    if (!messageId) return res.status(400).json({ error: 'messageId required' });
    const meta = await loadChatMeta(req.params.id);
    const messages = await loadMessages(req.params.id);
    const loaded = await loadTimelineForChat(meta.id, messages, meta);
    const policy = await policyForChat();
    const result = prepareDeepSwipe(messages, loaded.timeline, messageId, {
      policy,
      confirmed: !!confirmed,
      name,
      meta: metaSnapshot(meta),
    });
    if (result.messagesChanged) await saveMessages(meta.id, result.messages);
    await saveTimeline(meta.id, result.timeline);
    await saveChatMeta(meta);
    res.json({
      meta,
      messages: result.messages,
      timeline: result.timeline,
      graph: graphViewModel(result.messages, result.timeline),
      createdForkId: result.createdForkId,
      warnings: result.warnings,
      readyMessageId: messageId,
    });
  } catch (err) {
    timelineError(res, err);
  }
});

timelineRoutes.post('/chats/:id/messages/:messageId/swipe', async (req, res) => {
  try {
    const { index, confirmed } = req.body as { index?: number; confirmed?: boolean };
    if (typeof index !== 'number') return res.status(400).json({ error: 'index required' });
    const meta = await loadChatMeta(req.params.id);
    const messages = await loadMessages(req.params.id);
    const loaded = await loadTimelineForChat(meta.id, messages, meta);
    const policy = await policyForChat();
    const result = prepareSwipeSwitch(messages, loaded.timeline, req.params.messageId, index, {
      policy,
      confirmed: !!confirmed,
      meta: metaSnapshot(meta),
    });
    await saveMessages(meta.id, result.messages);
    await saveTimeline(meta.id, result.timeline);
    await saveChatMeta(meta);
    res.json({
      meta,
      messages: result.messages,
      timeline: result.timeline,
      graph: graphViewModel(result.messages, result.timeline),
      createdForkId: result.createdForkId,
      warnings: result.warnings,
    });
  } catch (err) {
    timelineError(res, err);
  }
});
