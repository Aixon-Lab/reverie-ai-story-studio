/**
 * Skill persistence — one JSON file per skill in `data/skills/`.
 *
 * Flat files rather than a single library file: skills are large documents that
 * users will want to copy, back up and hand to each other, and a corrupt write
 * should cost one skill rather than the whole shelf.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Skill } from '../../shared/skills/types';
import { hydrateSkill } from '../../shared/skills/parse';
import { dirs, listJsonFiles, readJson, sanitizeId, writeJsonAtomic } from '../storage';

function fileFor(id: string): string {
  return path.join(dirs.skills, `${sanitizeId(id)}.json`);
}

/** Fill in anything a hand-written or older file is missing. */
export function normalizeSkill(raw: Partial<Skill> & { name?: string }): Skill {
  const now = Date.now();
  const base: Skill = {
    id: raw.id || randomUUID(),
    name: (raw.name ?? 'Untitled skill').trim() || 'Untitled skill',
    description: (raw.description ?? '').trim(),
    body: raw.body ?? '',
    enabled: raw.enabled !== false,
    mode: raw.mode === 'always' || raw.mode === 'manual' ? raw.mode : 'auto',
    keywords: (raw.keywords ?? []).map((k) => String(k).trim()).filter(Boolean),
    tags: (raw.tags ?? []).map((t) => String(t).trim()).filter(Boolean),
    priority: clampInt(raw.priority ?? 50, 0, 100),
    stickyTurns: clampInt(raw.stickyTurns ?? 2, 0, 20),
    tokens: 0,
    sections: [],
    digest: raw.digest ?? '',
    source: raw.source === 'import' || raw.source === 'ai' ? raw.source : 'manual',
    createdAt: raw.createdAt ?? now,
    updatedAt: now,
  };
  return hydrateSkill(base) as Skill;
}

export async function listSkills(): Promise<Skill[]> {
  const raw = await listJsonFiles<Partial<Skill>>(dirs.skills);
  return raw
    .map((s) => normalizeSkill(s))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Only what a turn can actually use — the rest never reaches the prompt path. */
export async function listEnabledSkills(): Promise<Skill[]> {
  return (await listSkills()).filter((s) => s.enabled && s.body.trim());
}

export async function loadSkill(id: string): Promise<Skill | null> {
  const raw = await readJson<Partial<Skill> | null>(fileFor(id), null);
  return raw ? normalizeSkill({ ...raw, id }) : null;
}

export async function saveSkill(skill: Skill): Promise<Skill> {
  const normalized = normalizeSkill(skill);
  await fsp.mkdir(dirs.skills, { recursive: true });
  await writeJsonAtomic(fileFor(normalized.id), normalized);
  return normalized;
}

export async function deleteSkill(id: string): Promise<void> {
  await fsp.rm(fileFor(id), { force: true });
}

function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
