/** Library routes: characters, presets, lorebooks, personas, settings, secrets. */
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readCardPayload, writeCardPayload } from '../../shared/codec/png';
import { parseCard, exportCard } from '../../shared/codec/card';
import { parsePreset, exportPreset, defaultPreset } from '../../shared/codec/preset';
import { parseLorebook, exportLorebook } from '../../shared/codec/lorebook';
import {
  parseInstruct, exportInstruct, parseContext, exportContext,
  parseSysprompt, exportSysprompt, parseReasoning, exportReasoning,
} from '../../shared/codec/formatting';
import type {
  AppSettings, CharacterCard, CharacterPhoto, ContextPreset, InstructPreset, Lorebook,
  Persona, Preset, QuickReplySet, ReasoningPreset, SyspromptPreset,
} from '../../shared/types';
import { MAX_CHARACTER_PHOTOS, MAX_PINNED_MODELS } from '../../shared/types';
import { ensureForcedMessageStyle, defaultMessageStyle } from '../../shared/engine/messageStyle';
import { DEFAULT_SKILLS_SETTINGS } from '../../shared/skills/types';
import { dirs, DATA_DIR, listJsonFiles, readJson, readBlob, writeBlob, sanitizeId, writeJsonAtomic, getSecret, setSecret, listSecretKeys } from '../storage';

export const library = Router();

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');

export const DEFAULT_SETTINGS: AppSettings = {
  textConnection: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
  pinnedModels: [],
  utilityConnection: null,
  // Local-first, strict by default: image understanding happens in-process on
  // this machine, and a local failure stops the scan rather than uploading the
  // picture.
  localVision: { enabled: true, strict: true, maxEdge: 448, idleUnloadMs: 600_000 },
  imageConnection: { provider: null, model: '' },
  activePresetId: 'default',
  activePersonaId: 'default',
  activeInstructId: 'ChatML',
  activeContextId: 'Default',
  activeSyspromptId: 'Blank',
  activeReasoningId: 'Blank',
  instructEnabled: true,
  syspromptEnabled: true,
  reasoningSettings: {
    autoParse: true,
    autoExpand: false,
    addToPrompts: true,
    maxAdditions: 0,
    showHidden: false,
  },
  globalLorebooks: [],
  wiSettings: {
    depth: 4, budgetPercent: 25, recursive: true, caseSensitive: false,
    matchWholeWords: false, minActivations: 0, maxRecursionSteps: 3,
  },
  regexScripts: [],
  messageStyle: defaultMessageStyle(),
  activeQuickReplySetId: 'default',
  globalVariables: {},
  appearance: {
    chatBackground: '',
  },
  brain: {
    enabled: true,
    updateEveryMessages: 6,
    autoUpdate: true,
    // Hard ceiling: memory may never take more than a third of the context.
    shareOfContext: 1 / 3,
    traumaEnabled: true,
    intrusionsEnabled: true,
    autoCreate: true,
  },
  skills: { ...DEFAULT_SKILLS_SETTINGS },
};

export async function loadSettings(): Promise<AppSettings> {
  const s = await readJson<Partial<AppSettings>>(SETTINGS_FILE, {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    wiSettings: { ...DEFAULT_SETTINGS.wiSettings, ...(s.wiSettings ?? {}) },
    reasoningSettings: { ...DEFAULT_SETTINGS.reasoningSettings, ...(s.reasoningSettings ?? {}) },
    regexScripts: s.regexScripts ?? DEFAULT_SETTINGS.regexScripts,
    // Trimmed on read as well as on write: a settings file edited by hand (or
    // written by an older build) must not be able to grow the switcher.
    pinnedModels: (s.pinnedModels ?? []).slice(0, MAX_PINNED_MODELS),
    // Normalize message style (keep user wrappers; heal missing dialogue/action cores)
    messageStyle: ensureForcedMessageStyle(s.messageStyle ?? DEFAULT_SETTINGS.messageStyle),
    globalVariables: { ...DEFAULT_SETTINGS.globalVariables, ...(s.globalVariables ?? {}) },
    localVision: { ...DEFAULT_SETTINGS.localVision!, ...(s.localVision ?? {}) },
    appearance: {
      ...DEFAULT_SETTINGS.appearance,
      ...(s.appearance ?? {}),
    },
    brain: {
      ...DEFAULT_SETTINGS.brain!,
      ...(s.brain ?? {}),
    },
    skills: {
      ...DEFAULT_SETTINGS.skills!,
      ...(s.skills ?? {}),
    },
  };
}

export async function loadPersonas(): Promise<Persona[]> {
  const list = await readJson<Persona[]>(PERSONAS_FILE, []);
  if (!list.length) list.push({ id: 'default', name: 'You', description: '' });
  return list;
}

export async function loadCharacter(id: string): Promise<CharacterCard> {
  const file = path.join(dirs.characters, `${sanitizeId(id)}.json`);
  const card = await readJson<CharacterCard | null>(file, null);
  if (!card) throw Object.assign(new Error(`Character not found: ${id}`), { status: 404 });
  // Heal missing avatar URL if the portrait file exists on disk
  try {
    await fs.access(path.join(dirs.avatars, `${sanitizeId(card.id)}.png`));
    if (!card.avatar || !card.avatar.includes(card.id)) {
      card.avatar = `/api/avatars/${card.id}.png`;
    }
  } catch {
    /* no portrait file */
  }
  return card;
}

export async function loadPreset(id: string): Promise<Preset> {
  const file = path.join(dirs.presets, `${sanitizeId(id)}.json`);
  const p = await readJson<Preset | null>(file, null);
  return p ?? defaultPreset();
}

export async function loadLorebook(id: string): Promise<Lorebook | null> {
  return readJson<Lorebook | null>(path.join(dirs.lorebooks, `${sanitizeId(id)}.json`), null);
}

async function saveCharacter(card: CharacterCard): Promise<void> {
  await writeJsonAtomic(path.join(dirs.characters, `${sanitizeId(card.id)}.json`), card);
}

// ---------- characters ----------

library.get('/characters', async (_req, res) => {
  const cards = await listJsonFiles<CharacterCard>(dirs.characters);
  // Attach avatar URLs when portrait files exist
  for (const card of cards) {
    try {
      await fs.access(path.join(dirs.avatars, `${sanitizeId(card.id)}.png`));
      if (!card.avatar || !String(card.avatar).includes(card.id)) {
        card.avatar = `/api/avatars/${card.id}.png`;
      }
    } catch { /* no file */ }
  }
  cards.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  res.json(cards);
});

/** Import: body {filename, dataBase64} — PNG card or plain JSON. */
library.post('/characters/import', async (req, res) => {
  const { filename, dataBase64 } = req.body as { filename: string; dataBase64: string };
  if (!filename || !dataBase64) return res.status(400).json({ error: 'filename and dataBase64 required' });
  const bytes = Buffer.from(dataBase64, 'base64');
  const id = `${path.parse(sanitizeId(filename)).name}-${randomUUID().slice(0, 8)}`;

  let jsonText: string;
  let avatarSaved = false;
  if (filename.toLowerCase().endsWith('.png')) {
    jsonText = readCardPayload(new Uint8Array(bytes));
    await writeBlob(path.join(dirs.avatars, `${id}.png`), bytes);
    avatarSaved = true;
  } else {
    jsonText = bytes.toString('utf8');
  }
  const card = parseCard(jsonText, id);
  if (avatarSaved) card.avatar = `/api/avatars/${id}.png`;
  await saveCharacter(card);
  res.json(card);
});

library.post('/characters', async (req, res) => {
  const body = req.body as Partial<CharacterCard>;
  const id = body.id ?? `${sanitizeId(body.name || 'character')}-${randomUUID().slice(0, 8)}`;
  const card: CharacterCard = {
    ...parseCard(JSON.stringify({ name: body.name ?? 'New Character' }), id),
    ...body,
    id,
    extensions: body.extensions ?? {},
    createdAt: Date.now(),
  } as CharacterCard;
  await saveCharacter(card);
  res.json(card);
});

library.put('/characters/:id', async (req, res) => {
  const existing = await loadCharacter(req.params.id);
  const card = { ...existing, ...req.body, id: existing.id };
  await saveCharacter(card);
  res.json(card);
});

/** Permanently delete a character card + avatar and strip them from all groups. */
library.delete('/characters/:id', async (req, res) => {
  const id = sanitizeId(req.params.id);
  await fs.rm(path.join(dirs.characters, `${id}.json`), { force: true });
  await fs.rm(path.join(dirs.avatars, `${id}.png`), { force: true });
  // Every photo in the gallery, too — otherwise deleting a character leaves up to
  // ten orphaned files behind and the disk grows forever.
  try {
    for (const f of await fs.readdir(dirs.avatars)) {
      if (f.startsWith(`${id}__`) && f.endsWith('.png')) {
        await fs.rm(path.join(dirs.avatars, f), { force: true });
      }
    }
  } catch { /* avatars dir may not exist yet */ }
  // Remove from every group cast; clear play-as / mute if they pointed at this card
  try {
    const groups = await listJsonFiles<{
      id: string;
      members: string[];
      disabledMembers?: string[];
      playAs?: string | null;
    }>(dirs.groups);
    for (const g of groups) {
      const hadMember = g.members?.includes(id);
      const hadPlayAs = g.playAs === id;
      const hadMute = g.disabledMembers?.includes(id);
      if (!hadMember && !hadPlayAs && !hadMute) continue;
      const next = {
        ...g,
        members: (g.members ?? []).filter((m) => m !== id),
        disabledMembers: (g.disabledMembers ?? []).filter((m) => m !== id),
        playAs: g.playAs === id ? null : g.playAs ?? null,
      };
      await writeJsonAtomic(path.join(dirs.groups, `${sanitizeId(g.id)}.json`), next);
    }
  } catch {
    /* groups cleanup best-effort */
  }
  res.json({ ok: true });
});

// ---------- portraits ----------

/**
 * Photo gallery.
 *
 * Each photo is its own file (`{id}__{photoId}.png`), and the *selected* one is
 * additionally copied to `{id}.png`. That copy is the whole design: `card.avatar`
 * keeps pointing at one stable path, so chat bubbles, group strips, the card
 * list and the SillyTavern PNG export all keep working without knowing a gallery
 * exists. Selecting a different photo is a file copy, not a schema change.
 */
const photoFile = (cardId: string, photoId: string) =>
  path.join(dirs.avatars, `${sanitizeId(cardId)}__${sanitizeId(photoId)}.png`);

const photoUrl = (cardId: string, photoId: string) =>
  `/api/avatars/${cardId}__${photoId}.png`;

/**
 * Adopt a pre-gallery portrait as photo #1.
 *
 * Characters made before this feature have a `{id}.png` and no gallery. Rather
 * than showing them an empty strip that contradicts the portrait they can see,
 * their existing avatar becomes the first entry the moment they add a second.
 */
async function ensureGallery(card: CharacterCard): Promise<CharacterPhoto[]> {
  if (card.photos?.length) return card.photos;
  try {
    const existing = await readBlob(path.join(dirs.avatars, `${sanitizeId(card.id)}.png`));
    const id = randomUUID().slice(0, 8);
    await writeBlob(photoFile(card.id, id), existing);
    card.photos = [{ id, url: photoUrl(card.id, id), addedAt: card.createdAt ?? Date.now() }];
    card.activePhotoId = id;
    return card.photos;
  } catch {
    card.photos = [];
    return card.photos;
  }
}

/**
 * Which photo takes over when the displayed one is deleted.
 *
 * The neighbour that slid into the removed slot, or the one before it at the end
 * of the list. Pure and exported so the rule is testable without touching disk —
 * "delete the portrait and the character goes faceless" is the bug this prevents.
 */
export function promoteAfterDelete<T extends { id: string }>(
  remaining: T[],
  removedIndex: number,
): T | undefined {
  return remaining[removedIndex] ?? remaining[removedIndex - 1];
}

/**
 * Which photo gets dropped when a *replacement* portrait arrives at the cap.
 *
 * Never the one on display: silently deleting the portrait the user is looking
 * at, in order to make room for a new one, is the worst possible reading of
 * "set avatar".
 */
export function pickEvictionVictim<T extends { id: string; addedAt: number }>(
  photos: T[],
  activeId?: string,
): T | undefined {
  const evictable = photos.filter((p) => p.id !== activeId);
  const pool = evictable.length ? evictable : photos;
  return pool.reduce<T | undefined>(
    (oldest, p) => (!oldest || p.addedAt < oldest.addedAt ? p : oldest),
    undefined,
  );
}

/** Copy the selected photo onto the canonical avatar path. */
async function applySelection(card: CharacterCard, photoId: string): Promise<void> {
  const bytes = await readBlob(photoFile(card.id, photoId));
  await writeBlob(path.join(dirs.avatars, `${sanitizeId(card.id)}.png`), bytes);
  card.activePhotoId = photoId;
  // Cache-buster: the URL is unchanged but the bytes behind it are not, and
  // without this the browser keeps showing the previous portrait.
  card.avatar = `/api/avatars/${card.id}.png?v=${Date.now()}`;
}

library.get('/characters/:id/photos', async (req, res) => {
  const card = await loadCharacter(req.params.id);
  const photos = await ensureGallery(card);
  res.json({ photos, activePhotoId: card.activePhotoId, max: MAX_CHARACTER_PHOTOS });
});

/** Add a photo: body {dataBase64, label?, select?}. */
library.post('/characters/:id/photos', async (req, res) => {
  const card = await loadCharacter(req.params.id);
  const { dataBase64, label, select } = req.body as {
    dataBase64?: string; label?: string; select?: boolean;
  };
  if (!dataBase64) return res.status(400).json({ error: 'No image data.' });

  const photos = await ensureGallery(card);
  if (photos.length >= MAX_CHARACTER_PHOTOS) {
    return res.status(400).json({
      error: `${card.name || 'This character'} already has ${MAX_CHARACTER_PHOTOS} photos. Remove one before adding another.`,
    });
  }

  const photoId = randomUUID().slice(0, 8);
  await writeBlob(photoFile(card.id, photoId), Buffer.from(dataBase64, 'base64'));
  photos.push({
    id: photoId,
    url: photoUrl(card.id, photoId),
    addedAt: Date.now(),
    ...(label?.trim() ? { label: label.trim().slice(0, 60) } : {}),
  });

  // The first photo is always shown; later ones only if asked for.
  if (select !== false || photos.length === 1) await applySelection(card, photoId);
  await saveCharacter(card);
  res.json(card);
});

/** Show this photo. */
library.post('/characters/:id/photos/:photoId/select', async (req, res) => {
  const card = await loadCharacter(req.params.id);
  const photos = await ensureGallery(card);
  const photo = photos.find((p) => p.id === req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'That photo is no longer here.' });
  await applySelection(card, photo.id);
  await saveCharacter(card);
  res.json(card);
});

library.delete('/characters/:id/photos/:photoId', async (req, res) => {
  const card = await loadCharacter(req.params.id);
  const photos = await ensureGallery(card);
  const idx = photos.findIndex((p) => p.id === req.params.photoId);
  if (idx === -1) return res.status(404).json({ error: 'That photo is no longer here.' });

  const [removed] = photos.splice(idx, 1);
  await fs.rm(photoFile(card.id, removed.id), { force: true });

  // Deleting the one on display promotes its neighbour rather than leaving the
  // character faceless.
  if (card.activePhotoId === removed.id) {
    const next = promoteAfterDelete(photos, idx);
    if (next) {
      await applySelection(card, next.id);
    } else {
      card.activePhotoId = undefined;
      card.avatar = undefined;
      await fs.rm(path.join(dirs.avatars, `${sanitizeId(card.id)}.png`), { force: true });
    }
  }
  await saveCharacter(card);
  res.json(card);
});

/**
 * Set avatar: body {dataBase64, mime}.
 *
 * Kept for every existing caller (drag-drop, AI generation, the creator flow).
 * It now routes through the gallery so those paths populate it too — otherwise a
 * character could show a portrait that its own photo strip did not contain.
 */
library.post('/characters/:id/avatar', async (req, res) => {
  const card = await loadCharacter(req.params.id);
  const { dataBase64 } = req.body as { dataBase64: string };
  const photos = await ensureGallery(card);

  const photoId = randomUUID().slice(0, 8);
  await writeBlob(photoFile(card.id, photoId), Buffer.from(dataBase64, 'base64'));
  if (photos.length >= MAX_CHARACTER_PHOTOS) {
    // At the cap, the new portrait replaces the oldest unselected one rather than
    // failing: this path is "set the portrait", and it must not start erroring.
    const victim = pickEvictionVictim(photos, card.activePhotoId);
    if (victim) {
      await fs.rm(photoFile(card.id, victim.id), { force: true });
      photos.splice(photos.indexOf(victim), 1);
    }
  }
  photos.push({ id: photoId, url: photoUrl(card.id, photoId), addedAt: Date.now() });

  await applySelection(card, photoId);
  await saveCharacter(card);
  res.json(card);
});

/** Export as ST-compatible PNG (embeds V2+V3 data into the avatar). */
library.get('/characters/:id/export.png', async (req, res) => {
  const card = await loadCharacter(req.params.id);
  const json = JSON.stringify(exportCard(card));
  let pngBytes: Uint8Array;
  try {
    pngBytes = new Uint8Array(await readBlob(path.join(dirs.avatars, `${card.id}.png`)));
  } catch {
    return res.status(400).json({ error: 'Character has no avatar image to embed into. Set an avatar first.' });
  }
  const out = writeCardPayload(pngBytes, json);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(card.name)}.png"`);
  res.send(Buffer.from(out));
});

library.get('/characters/:id/export.json', async (req, res) => {
  const card = await loadCharacter(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(card.name)}.json"`);
  res.json(exportCard(card));
});

library.get('/avatars/:file', async (req, res) => {
  // Strip query/cache-busting; allow id.png or bare id
  const raw = String(req.params.file || '').split('?')[0].replace(/\.png$/i, '');
  const file = path.join(dirs.avatars, `${sanitizeId(raw)}.png`);
  try {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(await readBlob(file));
  } catch {
    res.status(404).end();
  }
});

// ---------- presets ----------

library.get('/presets', async (_req, res) => {
  const presets = await listJsonFiles<Preset>(dirs.presets);
  if (!presets.some((p) => p.id === 'default')) {
    // Persist the built-in default so sampling edits have a real file to write to.
    const def = defaultPreset();
    await writeJsonAtomic(path.join(dirs.presets, 'default.json'), def);
    presets.unshift(def);
  }
  res.json(presets);
});

library.post('/presets/import', async (req, res) => {
  const { filename, json } = req.body as { filename: string; json: Record<string, unknown> };
  const name = path.parse(filename || 'Imported Preset').name;
  const id = `${sanitizeId(name)}-${randomUUID().slice(0, 6)}`;
  const preset = parsePreset(json ?? {}, id, name);
  await writeJsonAtomic(path.join(dirs.presets, `${id}.json`), preset);
  res.json(preset);
});

library.put('/presets/:id', async (req, res) => {
  const preset = req.body as Preset;
  preset.id = sanitizeId(req.params.id);
  await writeJsonAtomic(path.join(dirs.presets, `${preset.id}.json`), preset);
  res.json(preset);
});

library.delete('/presets/:id', async (req, res) => {
  await fs.rm(path.join(dirs.presets, `${sanitizeId(req.params.id)}.json`), { force: true });
  res.json({ ok: true });
});

library.get('/presets/:id/export.json', async (req, res) => {
  const preset = await loadPreset(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(preset.name)}.json"`);
  res.json(exportPreset(preset));
});

// ---------- formatting presets (instruct / context / sysprompt / reasoning) ----------

function formattingRoutes<T extends { id: string; name: string }>(
  mount: string,
  dir: string,
  parse: (raw: Record<string, unknown>, id: string, name: string) => T,
  exportFn: (p: T) => Record<string, unknown>,
) {
  library.get(`/${mount}`, async (_req, res) => {
    res.json(await listJsonFiles<T>(dir));
  });
  /** Create a new preset from body (or empty defaults via parse). */
  library.post(`/${mount}`, async (req, res) => {
    const body = (req.body ?? {}) as Partial<T> & { name?: string };
    const name = body.name?.trim() || 'Untitled';
    const id = `${sanitizeId(name)}-${randomUUID().slice(0, 6)}`;
    const item = parse({ ...(body as object), name }, id, name);
    Object.assign(item, body, { id, name });
    await writeJsonAtomic(path.join(dir, `${item.id}.json`), item);
    res.json(item);
  });
  library.post(`/${mount}/import`, async (req, res) => {
    const { filename, json } = req.body as { filename: string; json: Record<string, unknown> };
    const name = path.parse(filename || 'Imported').name;
    const id = `${sanitizeId(name)}-${randomUUID().slice(0, 6)}`;
    const item = parse(json ?? {}, id, name);
    await writeJsonAtomic(path.join(dir, `${item.id}.json`), item);
    res.json(item);
  });
  library.put(`/${mount}/:id`, async (req, res) => {
    const item = { ...(req.body as T), id: sanitizeId(req.params.id) };
    await writeJsonAtomic(path.join(dir, `${item.id}.json`), item);
    res.json(item);
  });
  library.delete(`/${mount}/:id`, async (req, res) => {
    await fs.rm(path.join(dir, `${sanitizeId(req.params.id)}.json`), { force: true });
    res.json({ ok: true });
  });
  library.get(`/${mount}/:id/export.json`, async (req, res) => {
    const item = await readJson<T | null>(path.join(dir, `${sanitizeId(req.params.id)}.json`), null);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(item.name)}.json"`);
    res.json(exportFn(item));
  });
}

formattingRoutes<InstructPreset>('instruct', dirs.instruct, parseInstruct, exportInstruct);
formattingRoutes<ContextPreset>('context', dirs.context, parseContext, exportContext);
formattingRoutes<SyspromptPreset>('sysprompt', dirs.sysprompt, parseSysprompt, exportSysprompt);
formattingRoutes<ReasoningPreset>('reasoning', dirs.reasoning, parseReasoning, exportReasoning);

// ---------- lorebooks ----------

library.get('/lorebooks', async (_req, res) => {
  res.json(await listJsonFiles<Lorebook>(dirs.lorebooks));
});

library.post('/lorebooks', async (req, res) => {
  const body = req.body as Partial<Lorebook>;
  const name = body.name?.trim() || 'New Lorebook';
  const id = `${sanitizeId(name)}-${randomUUID().slice(0, 6)}`;
  const book: Lorebook = {
    id,
    name,
    entries: body.entries ?? [],
  };
  await writeJsonAtomic(path.join(dirs.lorebooks, `${book.id}.json`), book);
  res.json(book);
});

library.post('/lorebooks/import', async (req, res) => {
  const { filename, json } = req.body as { filename: string; json: Record<string, unknown> };
  const name = path.parse(filename || 'Imported Lorebook').name;
  const id = `${sanitizeId(name)}-${randomUUID().slice(0, 6)}`;
  const book = parseLorebook(json ?? {}, id, name);
  await writeJsonAtomic(path.join(dirs.lorebooks, `${id}.json`), book);
  res.json(book);
});

library.put('/lorebooks/:id', async (req, res) => {
  const book = req.body as Lorebook;
  book.id = sanitizeId(req.params.id);
  await writeJsonAtomic(path.join(dirs.lorebooks, `${book.id}.json`), book);
  res.json(book);
});

library.delete('/lorebooks/:id', async (req, res) => {
  await fs.rm(path.join(dirs.lorebooks, `${sanitizeId(req.params.id)}.json`), { force: true });
  res.json({ ok: true });
});

library.get('/lorebooks/:id/export.json', async (req, res) => {
  const book = await loadLorebook(req.params.id);
  if (!book) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(book.name)}.json"`);
  res.json(exportLorebook(book));
});

// ---------- personas ----------

library.get('/personas', async (_req, res) => res.json(await loadPersonas()));

library.put('/personas', async (req, res) => {
  const personas = req.body as Persona[];
  await writeJsonAtomic(PERSONAS_FILE, personas);
  res.json(personas);
});

// ---------- settings & secrets ----------

library.get('/settings', async (_req, res) => res.json(await loadSettings()));

library.put('/settings', async (req, res) => {
  const prev = await loadSettings();
  const body = req.body as Partial<AppSettings>;
  const merged: AppSettings = {
    ...prev,
    ...body,
    // Deep-merge nested patches so partial appearance updates keep other keys
    appearance: {
      ...prev.appearance,
      ...(body.appearance ?? {}),
    },
    wiSettings: {
      ...prev.wiSettings,
      ...(body.wiSettings ?? {}),
    },
    reasoningSettings: {
      ...prev.reasoningSettings,
      ...(body.reasoningSettings ?? {}),
    },
    /**
     * Nested blocks must merge, not replace.
     *
     * A caller that patches one switch — `{ skills: { enabled: false } }` —
     * would otherwise overwrite the whole object, and since `loadSettings`
     * backfills what is missing, every other choice in it would silently snap
     * back to its default on the next read.
     */
    brain: { ...DEFAULT_SETTINGS.brain!, ...prev.brain, ...(body.brain ?? {}) },
    skills: { ...DEFAULT_SETTINGS.skills!, ...prev.skills, ...(body.skills ?? {}) },
    // Capped on write as well as on read: the switcher is a three-slot control
    // and a client bug must not be able to make it something else.
    pinnedModels: (body.pinnedModels ?? prev.pinnedModels ?? []).slice(0, MAX_PINNED_MODELS),
  };
  // Normalize message style after any patch (preserves custom open/close/pattern)
  merged.messageStyle = ensureForcedMessageStyle(
    body.messageStyle ? { ...prev.messageStyle, ...body.messageStyle } : merged.messageStyle,
  );
  await writeJsonAtomic(SETTINGS_FILE, merged);
  res.json(merged);
});

library.get('/secrets', async (_req, res) => res.json({ keys: await listSecretKeys() }));

library.post('/secrets', async (req, res) => {
  const { key, value } = req.body as { key: string; value: string };
  if (!key) return res.status(400).json({ error: 'key required' });
  await setSecret(key, value ?? '');
  res.json({ ok: true });
});

// ---------- quick replies ----------

library.get('/quick-replies', async (_req, res) => {
  let sets = await listJsonFiles<QuickReplySet>(dirs.quickreplies);
  if (!sets.length) {
    const def: QuickReplySet = {
      id: 'default',
      name: 'Default',
      replies: [],
    };
    await writeJsonAtomic(path.join(dirs.quickreplies, 'default.json'), def);
    sets = [def];
  }
  res.json(sets);
});

library.put('/quick-replies/:id', async (req, res) => {
  const set = { ...(req.body as QuickReplySet), id: sanitizeId(req.params.id) };
  await writeJsonAtomic(path.join(dirs.quickreplies, `${set.id}.json`), set);
  res.json(set);
});

library.post('/quick-replies', async (req, res) => {
  const body = req.body as Partial<QuickReplySet>;
  const name = body.name?.trim() || 'Quick Replies';
  const id = `${sanitizeId(name)}-${randomUUID().slice(0, 6)}`;
  const set: QuickReplySet = { id, name, replies: body.replies ?? [] };
  await writeJsonAtomic(path.join(dirs.quickreplies, `${id}.json`), set);
  res.json(set);
});

library.delete('/quick-replies/:id', async (req, res) => {
  await fs.rm(path.join(dirs.quickreplies, `${sanitizeId(req.params.id)}.json`), { force: true });
  res.json({ ok: true });
});
