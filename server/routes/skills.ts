/**
 * Skill library routes: CRUD, import/export, AI authoring, per-chat pins.
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Skill } from '../../shared/skills/types';
import { exportSkillDoc, parseSkillDoc, skillAuthorPrompt } from '../../shared/skills';
import { rosterPreview, chatSkillState } from '../skills/service';
import { deleteSkill, listSkills, loadSkill, normalizeSkill, saveSkill } from '../skills/store';
import { generateText, generateTextComplete } from '../providers/text';
import { utilityConnection } from '../providers/router';
import { loadSettings } from './library';
import { loadChatMeta, saveChatMeta } from './chats';
import { runWithPurpose } from '../lib/sessionLog';

export const skillRoutes = Router();

// ------------------------------------------------------------------- CRUD

skillRoutes.get('/skills', async (_req, res) => {
  res.json(await listSkills());
});

skillRoutes.get('/skills/roster', async (_req, res) => {
  // What a turn would actually advertise, so the page can price the selector.
  const skills = (await listSkills()).filter((s) => s.enabled && s.mode !== 'always');
  res.json(rosterPreview(skills));
});

skillRoutes.get('/skills/:id', async (req, res) => {
  const skill = await loadSkill(req.params.id);
  if (!skill) return res.status(404).json({ error: 'No such skill.' });
  res.json(skill);
});

skillRoutes.post('/skills', async (req, res) => {
  const body = req.body as Partial<Skill>;
  const skill = normalizeSkill({ ...body, id: body.id || randomUUID(), createdAt: Date.now() });
  res.json(await saveSkill(skill));
});

skillRoutes.put('/skills/:id', async (req, res) => {
  const existing = await loadSkill(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such skill.' });
  const merged = normalizeSkill({
    ...existing,
    ...(req.body as Partial<Skill>),
    id: existing.id,
    createdAt: existing.createdAt,
    // The digest is derived unless the author wrote one; clearing the body must
    // not leave yesterday's summary behind as the only thing the model sees.
    digest: (req.body as Partial<Skill>).digest ?? '',
  });
  res.json(await saveSkill(merged));
});

skillRoutes.delete('/skills/:id', async (req, res) => {
  await deleteSkill(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------- import / export

skillRoutes.post('/skills/import', async (req, res) => {
  const { filename, text, json } = req.body as {
    filename?: string; text?: string; json?: unknown;
  };

  // A full skill object (a previous export) round-trips exactly.
  if (json && typeof json === 'object') {
    const raw = json as Partial<Skill>;
    if (raw.body) {
      const skill = normalizeSkill({ ...raw, id: randomUUID(), source: 'import', createdAt: Date.now() });
      return res.json(await saveSkill(skill));
    }
  }

  const doc = String(text ?? '');
  if (!doc.trim()) return res.status(400).json({ error: 'Nothing to import — the file or paste was empty.' });

  const fallbackName = (filename ?? '').replace(/\.[^.]+$/, '').trim() || 'Imported skill';
  const parsed = parseSkillDoc(doc, fallbackName);
  const skill = normalizeSkill({
    id: randomUUID(),
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    keywords: parsed.keywords,
    tags: parsed.tags,
    source: 'import',
    createdAt: Date.now(),
  });
  res.json(await saveSkill(skill));
});

skillRoutes.get('/skills/:id/export', async (req, res) => {
  const skill = await loadSkill(req.params.id);
  if (!skill) return res.status(404).json({ error: 'No such skill.' });
  res.json({ filename: `${skill.name.replace(/[^\w -]/g, '_')}.md`, text: exportSkillDoc(skill) });
});

// ------------------------------------------------------------- AI authoring

/**
 * Write a skill from an idea.
 *
 * Streamed, because a good skill document is long enough that a spinner would
 * be a lie about how long this takes. The result is *not* saved automatically —
 * it lands in the editor so the author reads it before it can affect a story.
 */
skillRoutes.post('/skills/generate', async (req, res) => {
  const { idea, depth } = req.body as { idea?: string; depth?: 'brief' | 'standard' | 'deep' };
  if (!idea?.trim()) return res.status(400).json({ error: 'Describe the skill you want first.' });

  const settings = await loadSettings();
  const existing = (await listSkills()).map((s) => s.name);
  const prompt = skillAuthorPrompt({
    idea: idea.trim(),
    depth: depth ?? 'standard',
    existingNames: existing,
  });
  // Authoring is writing, not extraction: it runs on the strong utility model.
  const conn = utilityConnection(settings);
  const maxTokens = depth === 'deep' ? 4000 : depth === 'brief' ? 1400 : 2600;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const messages = [
    { role: 'system' as const, content: prompt.system },
    { role: 'user' as const, content: prompt.user },
  ];
  let full = '';
  try {
    const handle = await runWithPurpose('skill:author', () =>
      generateText(conn, messages, { temperature: 0.6, top_p: 1, max_tokens: maxTokens, stream: true }));
    for await (const delta of handle.deltas) {
      full += delta;
      send('delta', { text: delta });
    }
  } catch (err: any) {
    send('error', { message: err?.message ?? 'Skill generation failed.' });
    return res.end();
  }

  if (!full.trim()) {
    try {
      full = await generateTextComplete(conn, messages, { temperature: 0.6, top_p: 1, max_tokens: maxTokens, stream: false });
    } catch (err: any) {
      send('error', { message: err?.message ?? 'Skill generation returned nothing.' });
      return res.end();
    }
  }

  const parsed = parseSkillDoc(full, idea.trim().slice(0, 60));
  send('done', {
    draft: {
      name: parsed.name,
      description: parsed.description,
      keywords: parsed.keywords,
      tags: parsed.tags,
      body: parsed.body,
      source: 'ai',
    },
  });
  res.end();
});

// ------------------------------------------------------------ per-chat pins

skillRoutes.get('/chats/:chatId/skills', async (req, res) => {
  const meta = await loadChatMeta(req.params.chatId);
  res.json(chatSkillState(meta));
});

/**
 * Pin a skill on or off for one conversation.
 *
 * A pin is deliberately a chat-level fact rather than a global one: "she should
 * always be fighting like this *in this story*" is the common wish, and making
 * it global would leak the same document into every other scene.
 */
skillRoutes.post('/chats/:chatId/skills/pin', async (req, res) => {
  const { skillId, pin } = req.body as { skillId?: string; pin?: 'force' | 'mute' | 'clear' };
  if (!skillId) return res.status(400).json({ error: 'skillId is required.' });

  const meta = await loadChatMeta(req.params.chatId);
  const state = chatSkillState(meta);
  const forced = new Set(state.forced);
  const muted = new Set(state.muted);
  forced.delete(skillId);
  muted.delete(skillId);
  if (pin === 'force') forced.add(skillId);
  if (pin === 'mute') muted.add(skillId);

  meta.skills = { ...state, forced: [...forced], muted: [...muted] };
  await saveChatMeta(meta);
  res.json(meta.skills);
});

/** Forget what the selector armed — the manual reset when a scene has moved on. */
skillRoutes.post('/chats/:chatId/skills/clear', async (req, res) => {
  const meta = await loadChatMeta(req.params.chatId);
  const state = chatSkillState(meta);
  meta.skills = { ...state, active: [], decidedAt: undefined };
  await saveChatMeta(meta);
  res.json(meta.skills);
});
