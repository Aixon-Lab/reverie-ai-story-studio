/**
 * Reverie desk — a platform assistant with the open story on its desk.
 *
 * Same text connection as chat. Text only: no portraits, no photo bytes.
 * Memory is read with mutate:false so asking "what happened" does not rewrite
 * a character's mind.
 */
import { Router } from 'express';
import type { CharacterCard, ChatMessage } from '../../shared/types';
import { bookToEntries } from '../../shared/codec/lorebook';
import { scanWorldInfo } from '../../shared/engine/worldinfo';
import { estimateTokens } from '../../shared/engine/tokens';
import {
  cardToAssistantMember,
  packAssistantContext,
  stripImagePayloads,
} from '../../shared/engine/assistantContext';
import { composeBrainContext } from '../../shared/brain/compose';
import { cueFromContext, recall } from '../../shared/brain/retrieval';
import { generateText, generateTextComplete } from '../providers/text';
import { resolveContextLimit } from '../providers/contextLimits';
import { runWithPurpose } from '../lib/sessionLog';
import { loadSettings, loadPersonas, loadCharacter, loadPreset, loadLorebook } from './library';
import { loadChatMeta, loadMessages, loadGroup } from './chats';
import { loadBrainIfExists } from '../brain/store';
import { chatSkillState } from '../skills/service';
import { listSkills } from '../skills/store';

export const assistant = Router();

const MAX_QUESTION = 8000;
const MAX_HISTORY = 24;

type HistTurn = { role: 'user' | 'assistant'; content: string };

function asHistory(raw: unknown): HistTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: HistTurn[] = [];
  for (const row of raw.slice(-MAX_HISTORY)) {
    if (!row || typeof row !== 'object') continue;
    const role = (row as HistTurn).role === 'assistant' ? 'assistant' : 'user';
    const content = stripImagePayloads(String((row as HistTurn).content ?? '')).slice(0, MAX_QUESTION);
    if (!content.trim()) continue;
    out.push({ role, content });
  }
  return out;
}

async function deskFor(chatId: string | undefined, question: string) {
  const settings = await loadSettings();
  const personas = await loadPersonas();
  const persona = personas.find((p) => p.id === settings.activePersonaId) ?? personas[0];
  const preset = await loadPreset(settings.activePresetId);

  if (!chatId) {
    return {
      settings,
      preset,
      pack: packAssistantContext({
        hasChat: false,
        persona: persona ? { name: persona.name, description: persona.description } : undefined,
        characters: [],
        transcript: [],
        brains: [],
        lore: [],
        skills: [],
        budgetTokens: 3000,
      }),
    };
  }

  let meta;
  try {
    meta = await loadChatMeta(chatId);
  } catch {
    return deskFor(undefined, question);
  }

  const history = await loadMessages(chatId);
  const visible = history.filter((m) => !m.hiddenFromPrompt && m.text?.trim());

  let memberCards: CharacterCard[] = [];
  let group = undefined as Awaited<ReturnType<typeof loadGroup>> | undefined;
  if (meta.groupId) {
    group = await loadGroup(meta.groupId);
    memberCards = (await Promise.all(group.members.map((id) => loadCharacter(id).catch(() => null))))
      .filter((c): c is CharacterCard => !!c);
  } else if (meta.characterId) {
    const card = await loadCharacter(meta.characterId).catch(() => null);
    if (card) memberCards = [card];
  }

  let youCard: CharacterCard | undefined = persona
    ? memberCards.find((c) =>
        persona.id === `from-${c.id}` || c.name === persona.name)
    : undefined;
  if (!youCard && persona?.id.startsWith('from-')) {
    youCard = await loadCharacter(persona.id.slice(5)).catch(() => undefined) ?? undefined;
  }

  const castNames = [
    persona?.name,
    ...memberCards.map((c) => c.name),
  ].filter((n): n is string => !!n);

  const brains: { name: string; text: string }[] = [];
  if (settings.brain?.enabled !== false) {
    for (const card of memberCards) {
      try {
        const brain = await loadBrainIfExists(chatId, card.id);
        if (!brain) continue;
        const recentText = visible.slice(-8).map((m) => `${m.speaker.displayName}: ${m.text}`).join('\n');
        const cue = cueFromContext({
          recentText: `${recentText}\n${question}`,
          actors: castNames,
          brain,
          extraKeywords: question.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
        });
        const recalled = recall(brain, cue, { mutate: false, limit: 18 });
        const composed = composeBrainContext(brain, recalled.hits, {
          budget: 900,
          now: Date.now(),
          presentActors: castNames.filter((n) => n !== card.name),
          withHeader: false,
        });
        if (composed.text.trim()) brains.push({ name: card.name, text: composed.text });
      } catch (err) {
        console.error('[assistant] brain inspect failed', card.id, err);
      }
    }
  }

  const wiEntries = [];
  for (const bookId of settings.globalLorebooks ?? []) {
    const book = await loadLorebook(bookId);
    if (book) wiEntries.push(...book.entries);
  }
  for (const c of memberCards) {
    if (c.character_book) wiEntries.push(...bookToEntries(c.character_book));
    const world = c.extensions?.world;
    if (typeof world === 'string' && world) {
      const linked = await loadLorebook(world).catch(() => null);
      if (linked) wiEntries.push(...linked.entries);
    }
  }

  const scanTexts = visible.slice(-12).map((m) => m.text);
  const wi = scanWorldInfo({
    entries: wiEntries,
    messages: [...scanTexts, question, meta.authorsNote?.text ?? ''],
    extraScanText: [persona?.description, youCard?.description, youCard?.personality].filter(Boolean).join('\n'),
    settings: {
      scanDepth: settings.wiSettings?.depth ?? 12,
      recursive: settings.wiSettings?.recursive ?? true,
      caseSensitive: settings.wiSettings?.caseSensitive ?? false,
      matchWholeWords: settings.wiSettings?.matchWholeWords ?? false,
      budgetTokens: 1200,
      maxRecursionSteps: settings.wiSettings?.maxRecursionSteps ?? 3,
    },
    countTokens: estimateTokens,
    random: () => 0.5,
  });
  const lore = wi.activated.map((e) => e.content).filter(Boolean);

  let skills: { name: string; description?: string }[] = [];
  try {
    const state = chatSkillState(meta);
    const ids = [...new Set([
      ...state.active.map((a) => a.id),
      ...state.forced,
    ])].filter((id) => !state.muted.includes(id));
    if (ids.length) {
      const lib = await listSkills();
      skills = ids.map((id) => {
        const s = lib.find((x) => x.id === id);
        return { name: s?.name ?? id, description: s?.description };
      });
    }
  } catch {
    skills = [];
  }

  const limit = await resolveContextLimit(settings.textConnection);
  const window = Math.min(limit.contextTokens, preset.max_context || limit.contextTokens);
  const reserved = Math.min(1200, Math.max(256, preset.max_tokens || 800));
  const budget = Math.max(1600, Math.floor((window - reserved) * 0.72));

  const pack = packAssistantContext({
    hasChat: true,
    chatTitle: meta.title,
    persona: persona ? { name: persona.name, description: persona.description } : undefined,
    youCard: youCard ? cardToAssistantMember(youCard) : undefined,
    characters: memberCards.map(cardToAssistantMember),
    authorsNote: meta.authorsNote?.text,
    scenarioOverride: meta.scenarioOverride,
    summary: meta.summary,
    variables: meta.variables,
    director: meta.director
      ? {
          nudge: meta.director.nudge?.text,
          intensity: meta.director.nudge?.intensity,
          sceneGoal: meta.director.sceneGoal?.text,
          cutTo: meta.director.cutTo,
          prefer: meta.director.prefer,
        }
      : undefined,
    transcript: visible.map((m: ChatMessage) => ({
      name: m.speaker.displayName,
      text: m.text,
    })),
    brains,
    lore,
    skills,
    budgetTokens: budget,
  });

  return { settings, preset, pack };
}

assistant.post('/assistant', async (req, res) => {
  const question = stripImagePayloads(String(req.body?.question ?? '')).trim().slice(0, MAX_QUESTION);
  if (!question) return res.status(400).json({ error: 'Ask a question first.' });
  const chatId = typeof req.body?.chatId === 'string' && req.body.chatId.trim()
    ? String(req.body.chatId).trim()
    : undefined;
  const prior = asHistory(req.body?.history);

  let desk;
  try {
    desk = await deskFor(chatId, question);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'Could not load the story desk.' });
  }

  const { settings, preset, pack } = desk;
  const messages = [
    { role: 'system' as const, content: pack.system },
    ...prior.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: question },
  ];

  const maxTokens = Math.min(1200, Math.max(256, Math.floor(preset.max_tokens || 800)));
  const genParams = {
    temperature: Math.min(preset.temperature ?? 0.7, 0.5),
    top_p: preset.top_p ?? 1,
    max_tokens: maxTokens,
    stream: true as const,
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let full = '';
  let aborted = false;
  let streamHandle: Awaited<ReturnType<typeof generateText>> | null = null;
  const markAborted = () => {
    if (aborted) return;
    aborted = true;
    try { streamHandle?.abort(); } catch { /* ignore */ }
  };
  res.on('close', () => {
    if (!res.writableEnded) markAborted();
  });

  try {
    streamHandle = await runWithPurpose('assistant:desk', () =>
      generateText(settings.textConnection, messages, genParams));
    if (aborted) {
      streamHandle.abort();
      if (!res.writableEnded) res.end();
      return;
    }
    for await (const delta of streamHandle.deltas) {
      if (aborted) break;
      full += delta;
      if (delta) send('delta', { text: delta });
    }
  } catch (err: any) {
    if (!res.writableEnded) {
      send('error', { message: err?.message ?? 'The desk could not reach the model.' });
      res.end();
    }
    return;
  }

  if (aborted) {
    if (!res.writableEnded) res.end();
    return;
  }

  if (!full.trim()) {
    try {
      full = await generateTextComplete(settings.textConnection, messages, {
        ...genParams,
        stream: false,
      });
      if (full) send('delta', { text: full });
    } catch (err: any) {
      send('error', { message: err?.message ?? 'The model returned nothing.' });
      return res.end();
    }
  }

  send('done', { text: full, tokens: pack.tokens });
  res.end();
});
