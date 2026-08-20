/** Chats & groups CRUD. Chats stored as <id>.meta.json + <id>.jsonl (messages). */
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatMeta, Group } from '../../shared/types';
import { dirs, listJsonFiles, readJson, readJsonl, sanitizeId, writeJsonAtomic, writeJsonl, appendJsonl } from '../storage';
import { loadCharacter } from './library';
import {
  buildTimelineFromMessages,
  createCheckpoint,
  graphViewModel,
  restoreFork,
  TimelineError,
} from '../../shared/engine/timeline';
import { loadTimelineForChat, metaSnapshot, saveTimeline, timelineFile } from './timelineStore';
import { deleteBrainsForChat } from '../brain/store';

export const chats = Router();

const metaFile = (id: string) => path.join(dirs.chats, `${sanitizeId(id)}.meta.json`);
const msgsFile = (id: string) => path.join(dirs.chats, `${sanitizeId(id)}.jsonl`);

export async function loadChatMeta(id: string): Promise<ChatMeta> {
  const meta = await readJson<ChatMeta | null>(metaFile(id), null);
  if (!meta) throw Object.assign(new Error(`Chat not found: ${id}`), { status: 404 });
  return meta;
}

export async function loadMessages(id: string): Promise<ChatMessage[]> {
  return readJsonl<ChatMessage>(msgsFile(id));
}

export async function saveChatMeta(meta: ChatMeta): Promise<void> {
  meta.updatedAt = Date.now();
  await writeJsonAtomic(metaFile(meta.id), meta);
}

export async function appendMessage(chatId: string, msg: ChatMessage): Promise<void> {
  await appendJsonl(msgsFile(chatId), msg);
}

export async function saveMessages(chatId: string, msgs: ChatMessage[]): Promise<void> {
  await writeJsonl(msgsFile(chatId), msgs);
}

export function newMessage(partial: Omit<ChatMessage, 'id' | 'ts'>): ChatMessage {
  return { id: randomUUID(), ts: Date.now(), ...partial };
}

// ---------- chats ----------

/**
 * Mark a conversation as one that actually happened.
 *
 * Called whenever a human sends or a model generates, which is exactly the line
 * between "I opened this character" and "I had a conversation with them".
 * Idempotent and best-effort: never let bookkeeping break a send.
 */
export async function markChatStarted(chatId: string): Promise<void> {
  try {
    const meta = await loadChatMeta(chatId);
    if (meta.started) return;
    meta.started = true;
    await saveChatMeta(meta);
  } catch {
    /* chat vanished mid-flight — nothing to mark */
  }
}

/**
 * Was this chat started, for a meta saved before the flag existed?
 *
 * The greeting is a single AI message appended at creation, so anything beyond
 * that — any human turn, or a second AI turn — means the conversation happened.
 */
export function isStartedTranscript(msgs: Pick<ChatMessage, 'controlledBy'>[]): boolean {
  return msgs.length > 1 || msgs.some((m) => m.controlledBy === 'human');
}

async function inferStarted(meta: ChatMeta): Promise<boolean> {
  try {
    return isStartedTranscript(await loadMessages(meta.id));
  } catch {
    return false;
  }
}

chats.get('/chats', async (req, res) => {
  const all = (await listJsonFiles<ChatMeta>(dirs.chats)).filter((m) => m.id);

  // One-time migration per chat: infer the flag, then persist so later list calls
  // stay a pure metadata read rather than re-opening every transcript.
  for (const meta of all) {
    if (meta.started !== undefined) continue;
    meta.started = await inferStarted(meta);
    await saveChatMeta(meta).catch(() => undefined);
  }

  all.sort((a, b) => b.updatedAt - a.updatedAt);
  // `?all=1` for anything that genuinely needs the unstarted ones too.
  res.json(req.query.all === '1' ? all : all.filter((m) => m.started !== false));
});

chats.post('/chats', async (req, res) => {
  const { characterId, groupId, personaId, title } = req.body as Partial<ChatMeta>;

  /**
   * Reuse the unstarted chat for this character instead of stacking another.
   *
   * Without this, clicking a character ten times leaves ten greeting-only chats
   * on disk. Reuse also means going back to a character resumes the greeting you
   * were just looking at, including whichever alternate greeting you had swiped to.
   */
  if (characterId || groupId) {
    const existing = (await listJsonFiles<ChatMeta>(dirs.chats))
      .filter((m) => m.id && m.started === false
        && (groupId ? m.groupId === groupId : m.characterId === characterId && !m.groupId))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    // Groups matter as much as solos here: an unstarted group chat is hidden from
    // the rail, so without reuse every visit to the group would mint another one.
    if (existing) return res.json(existing);
  }

  const id = randomUUID();
  const meta: ChatMeta = {
    id,
    title: title || 'New chat',
    characterId,
    groupId,
    personaId: personaId || 'default',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // Explicitly false rather than undefined: the list filter and the reuse
    // lookup both need to tell "not started" apart from "saved before the flag".
    started: false,
  };
  await saveChatMeta(meta);

  // Track chat on the group (group chat = group entity)
  if (groupId) {
    try {
      const group = await loadGroup(groupId);
      if (!group.chats.includes(id)) {
        group.chats = [...group.chats, id];
        await writeJsonAtomic(path.join(dirs.groups, `${group.id}.json`), group);
      }
    } catch {
      /* group missing — chat still created; client can recover */
    }
  }

  // seed with greeting for solo chats
  if (characterId) {
    const card = await loadCharacter(characterId);
    if (card.first_mes?.trim()) {
      await appendMessage(id, newMessage({
        speaker: { type: 'character', characterId: card.id, displayName: card.name },
        controlledBy: 'ai',
        text: card.first_mes,
        swipes: [card.first_mes, ...card.alternate_greetings],
        swipeIndex: 0,
      }));
    }
  }
  res.json(meta);
});

chats.get('/chats/:id', async (req, res) => {
  let meta = await loadChatMeta(req.params.id);
  const messages = await loadMessages(req.params.id);
  const loaded = await loadTimelineForChat(meta.id, messages, meta);
  if (loaded.metaDirty) {
    meta = loaded.meta;
    await saveChatMeta(meta);
    await saveTimeline(meta.id, loaded.timeline);
  }
  res.json({
    meta,
    messages,
    timeline: loaded.timeline,
    graph: graphViewModel(messages, loaded.timeline),
  });
});

chats.put('/chats/:id', async (req, res) => {
  const meta = { ...(await loadChatMeta(req.params.id)), ...req.body, id: req.params.id };
  await saveChatMeta(meta);
  res.json(meta);
});

/**
 * Add a character to this chat. Solo chats are promoted to a group in-place
 * (same chat id + messages preserved). Group chats just gain a member.
 */
chats.post('/chats/:id/add-member', async (req, res) => {
  const { characterId } = req.body as { characterId?: string };
  if (!characterId) return res.status(400).json({ error: 'characterId required' });
  const meta = await loadChatMeta(req.params.id);
  const newCard = await loadCharacter(characterId);

  if (meta.groupId) {
    const group = await loadGroup(meta.groupId);
    if (group.members.includes(characterId)) {
      return res.json({ meta, group, promoted: false });
    }
    group.members = [...group.members, characterId];
    await writeJsonAtomic(path.join(dirs.groups, `${group.id}.json`), group);
    meta.updatedAt = Date.now();
    await saveChatMeta(meta);
    return res.json({ meta, group, promoted: false, added: newCard });
  }

  if (!meta.characterId) {
    return res.status(400).json({ error: 'Chat has no solo character to promote from' });
  }
  if (meta.characterId === characterId) {
    return res.status(400).json({ error: 'Character is already in this chat' });
  }

  const solo = await loadCharacter(meta.characterId);
  const groupId = randomUUID();
  const group: Group = {
    id: groupId,
    name: `${solo.name} · ${newCard.name}`,
    members: [meta.characterId, characterId],
    disabledMembers: [],
    turnMode: 'director',
    allowSelfResponses: false,
    playAs: null,
    narratorEnabled: true,
    genesisEnabled: false,
    autoImages: false,
    autoModeDelay: 0,
    generationMode: 'swap',
    generationModeJoinPrefix: '',
    generationModeJoinSuffix: '',
    chats: [meta.id],
    createdAt: Date.now(),
  };
  await writeJsonAtomic(path.join(dirs.groups, `${group.id}.json`), group);

  meta.groupId = groupId;
  meta.characterId = undefined;
  meta.title = meta.title || group.name;
  // If title was just the solo name, refresh to group-style
  if (meta.title === solo.name) meta.title = group.name;
  meta.updatedAt = Date.now();
  await saveChatMeta(meta);

  res.json({ meta, group, promoted: true, added: newCard });
});

chats.delete('/chats/:id', async (req, res) => {
  const id = sanitizeId(req.params.id);
  let meta: ChatMeta | null = null;
  try {
    meta = await loadChatMeta(id);
  } catch {
    /* already gone — still scrub files */
  }

  // Group chat = the group entity. Deleting the chat removes the whole group
  // and every other chat linked to it (one group conversation, not orphan shells).
  if (meta?.groupId) {
    const groupId = sanitizeId(meta.groupId);
    const allChats = (await listJsonFiles<ChatMeta>(dirs.chats)).filter((m) => m.id);
    for (const c of allChats) {
      // Solo chats have no groupId — never call sanitizeId('') (throws "Invalid id").
      const belongs =
        (c.groupId != null && c.groupId !== '' && sanitizeId(String(c.groupId)) === groupId) ||
        sanitizeId(c.id) === id;
      if (!belongs) continue;
      const cid = sanitizeId(c.id);
      await fs.rm(metaFile(cid), { force: true });
      await fs.rm(msgsFile(cid), { force: true });
      await fs.rm(timelineFile(cid), { force: true });
      // Minds belong to the conversation — they do not outlive it.
      await deleteBrainsForChat(cid);
    }
    await fs.rm(path.join(dirs.groups, `${groupId}.json`), { force: true });
    return res.json({ ok: true, deletedGroupId: meta.groupId });
  }

  await fs.rm(metaFile(id), { force: true });
  await fs.rm(msgsFile(id), { force: true });
  await fs.rm(timelineFile(id), { force: true });
  await deleteBrainsForChat(id);
  res.json({ ok: true });
});

/**
 * Replace full message list (edits, deletes, swipes).
 *
 * The client sends the whole array, so an in-place rewrite arrives here looking
 * exactly like a no-op: same id, same position, different words. Diffing against
 * what is on disk is the one place that sees every such rewrite — manual edits,
 * swipe switches, truncations — so the revision counter is stamped here rather
 * than at each of the call sites that could forget to.
 */
chats.put('/chats/:id/messages', async (req, res) => {
  const meta = await loadChatMeta(req.params.id);
  const messages = req.body as ChatMessage[];
  const previous = await loadMessages(meta.id).catch(() => [] as ChatMessage[]);
  const before = new Map(previous.map((m) => [m.id, m]));
  for (const m of messages) {
    const old = before.get(m.id);
    if (!old) continue;
    // Carry the stored revision forward: the client round-trips messages it has
    // never looked inside, and must not be able to reset the counter.
    m.revision = old.revision ?? 0;
    if (old.text !== m.text) m.revision += 1;
  }
  await saveMessages(meta.id, messages);
  const loaded = await loadTimelineForChat(meta.id, messages, meta);
  const timeline = buildTimelineFromMessages(messages, loaded.timeline);
  await saveTimeline(meta.id, timeline);
  if (loaded.metaDirty) await saveChatMeta(loaded.meta);
  else await saveChatMeta(meta);
  res.json({ ok: true, timeline, graph: graphViewModel(messages, timeline) });
});

/** Append a user/manual message without generation. */
chats.post('/chats/:id/messages', async (req, res) => {
  const meta = await loadChatMeta(req.params.id);
  const msg = newMessage(req.body);
  await appendMessage(meta.id, msg);
  // Someone said something: this is a conversation now, not a preview.
  meta.started = true;
  await saveChatMeta(meta);
  res.json(msg);
});

/** Export chat as ST-ish JSONL (header + messages). */
chats.get('/chats/:id/export.jsonl', async (req, res) => {
  const meta = await loadChatMeta(req.params.id);
  const messages = await loadMessages(req.params.id);
  const header = {
    user_name: 'User',
    character_name: meta.title,
    create_date: meta.createdAt,
    chat_metadata: {
      note_prompt: meta.authorsNote?.text,
      note_depth: meta.authorsNote?.depth,
      note_interval: meta.authorsNote?.interval,
      variables: meta.variables,
    },
  };
  const lines = [
    JSON.stringify(header),
    ...messages.map((m) =>
      JSON.stringify({
        name: m.speaker.displayName,
        is_user: m.controlledBy === 'human' && m.speaker.type === 'user',
        is_system: m.speaker.type === 'system' || !!m.hiddenFromPrompt,
        send_date: m.ts,
        mes: m.text,
        swipe_id: m.swipeIndex,
        swipes: m.swipes,
        original_avatar: m.speaker.characterId,
        extra: {
          ...(m.extra ?? {}),
          type: m.speaker.type === 'narrator' ? 'narrator' : undefined,
          hidden: m.hiddenFromPrompt,
        },
      }),
    ),
  ];
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.title)}.jsonl"`);
  res.send(lines.join('\n'));
});

/** Legacy: create checkpoint via timeline engine. */
chats.post('/chats/:id/branches', async (req, res) => {
  try {
    const meta = await loadChatMeta(req.params.id);
    const messages = await loadMessages(req.params.id);
    const loaded = await loadTimelineForChat(meta.id, messages, meta);
    const name = String((req.body as { name?: string }).name || `Branch ${new Date().toLocaleString()}`);
    const result = createCheckpoint(messages, loaded.timeline, {
      name,
      reason: 'checkpoint',
      meta: metaSnapshot(meta),
    });
    await saveTimeline(meta.id, result.timeline);
    await saveChatMeta({ ...meta, branches: undefined });
    const thin = {
      ...meta,
      branches: result.timeline.forks.map((f) => ({
        id: f.id,
        name: f.name,
        createdAt: f.createdAt,
        messages: [] as ChatMessage[],
        parentMessageId: f.tipMessageId,
      })),
    };
    res.json(thin);
  } catch (err) {
    if (err instanceof TimelineError) {
      return res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ error: err.message, code: err.code });
    }
    throw err;
  }
});

/** Legacy restore by branch/fork id. */
chats.post('/chats/:id/branches/:branchId/restore', async (req, res) => {
  try {
    let meta = await loadChatMeta(req.params.id);
    const messages = await loadMessages(req.params.id);
    const loaded = await loadTimelineForChat(meta.id, messages, meta);
    const result = restoreFork(messages, loaded.timeline, req.params.branchId, {
      meta: metaSnapshot(meta),
    });
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
    await saveChatMeta({ ...meta, branches: undefined });
    res.json({ meta, messages: result.messages, timeline: result.timeline });
  } catch (err) {
    if (err instanceof TimelineError) {
      return res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ error: err.message, code: err.code });
    }
    throw err;
  }
});

// ---------- groups ----------

chats.get('/groups', async (_req, res) => {
  res.json(await listJsonFiles<Group>(dirs.groups));
});

chats.post('/groups', async (req, res) => {
  const body = req.body as Partial<Group>;
  const group: Group = {
    id: randomUUID(),
    name: body.name || 'New Group',
    members: body.members ?? [],
    disabledMembers: [],
    turnMode: body.turnMode ?? 'director',
    allowSelfResponses: false,
    playAs: null,
    narratorEnabled: body.narratorEnabled ?? true,
    genesisEnabled: body.genesisEnabled ?? false,
    autoImages: body.autoImages ?? false,
    autoModeDelay: body.autoModeDelay ?? 0,
    generationMode: body.generationMode ?? 'swap',
    generationModeJoinPrefix: body.generationModeJoinPrefix ?? '',
    generationModeJoinSuffix: body.generationModeJoinSuffix ?? '',
    chats: [],
    createdAt: Date.now(),
    ...body,
  } as Group;
  await writeJsonAtomic(path.join(dirs.groups, `${group.id}.json`), group);
  res.json(group);
});

export async function loadGroup(id: string): Promise<Group> {
  const g = await readJson<Group | null>(path.join(dirs.groups, `${sanitizeId(id)}.json`), null);
  if (!g) throw Object.assign(new Error(`Group not found: ${id}`), { status: 404 });
  return g;
}

chats.get('/groups/:id', async (req, res) => res.json(await loadGroup(req.params.id)));

chats.put('/groups/:id', async (req, res) => {
  const group = { ...(await loadGroup(req.params.id)), ...req.body, id: req.params.id };
  await writeJsonAtomic(path.join(dirs.groups, `${group.id}.json`), group);
  res.json(group);
});

chats.delete('/groups/:id', async (req, res) => {
  const groupId = sanitizeId(req.params.id);
  // Deleting the group removes every linked group chat as well
  const allChats = (await listJsonFiles<ChatMeta>(dirs.chats)).filter((m) => m.id);
  let removedChats = 0;
  for (const c of allChats) {
    // Solo chats have no groupId — never call sanitizeId('') (throws "Invalid id").
    if (c.groupId == null || c.groupId === '') continue;
    if (sanitizeId(String(c.groupId)) !== groupId) continue;
    const cid = sanitizeId(c.id);
    await fs.rm(metaFile(cid), { force: true });
    await fs.rm(msgsFile(cid), { force: true });
    await fs.rm(timelineFile(cid), { force: true });
    await deleteBrainsForChat(cid);
    removedChats += 1;
  }
  await fs.rm(path.join(dirs.groups, `${groupId}.json`), { force: true });
  res.json({ ok: true, removedChats });
});
