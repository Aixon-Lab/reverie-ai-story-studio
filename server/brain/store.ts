/**
 * Brain persistence.
 *
 * A brain is scoped to **one conversation and one character**: the same
 * character in a different chat is a different person who has not lived through
 * what happened here. Files are therefore keyed `{chatId}__{characterId}` under
 * `data/brains/`, with a matching append-only audit log so every mutation the
 * engine made is explainable after the fact. Both go through the normal storage
 * layer, so vault encryption applies automatically.
 *
 * Writes are serialised per brain: consolidation runs in the background and
 * must never interleave with a second pass on the same brain.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  appendJsonl, dirs, readJson, readJsonl, sanitizeId, writeJsonAtomic,
} from '../storage';
import { emptyBrain, normalizeBrain } from '../../shared/brain/defaults';
import type { BrainState, ConsolidationReport } from '../../shared/brain/types';

/** Separator between the two id halves. Neither id may contain it. */
const SEP = '__';

export interface BrainRef {
  chatId: string;
  characterId: string;
}

export function brainKey(chatId: string, characterId: string): string {
  return `${sanitizeId(chatId)}${SEP}${sanitizeId(characterId)}`;
}

/** Inverse of `brainKey`. Character ids may contain `-`, never `__`. */
export function parseBrainKey(key: string): BrainRef | null {
  const at = key.indexOf(SEP);
  if (at <= 0) return null;
  const chatId = key.slice(0, at);
  const characterId = key.slice(at + SEP.length);
  if (!chatId || !characterId) return null;
  return { chatId, characterId };
}

const brainFile = (chatId: string, characterId: string) =>
  path.join(dirs.brains, `${brainKey(chatId, characterId)}.json`);
const logFile = (chatId: string, characterId: string) =>
  path.join(dirs.brains, `${brainKey(chatId, characterId)}.log.jsonl`);

/** Per-brain write queue — background consolidation must not race itself. */
const locks = new Map<string, Promise<unknown>>();
/** Brains with a pass in flight, so a second one can decline instead of queueing. */
const inFlight = new Set<string>();

/**
 * Which brains the current call path already owns.
 *
 * The lock is a promise chain, so taking it twice on one path is a deadlock: the
 * inner acquisition queues behind the outer one, which is waiting for the inner
 * one to return. That is exactly how consolidation runs — `consolidateForChat`
 * takes it through `initBrain` and again through `runConsolidation`, and the
 * automatic paths wrap the lot in `tryWithBrainLock` — so every background pass
 * hung forever and left the brain marked busy, which made every later pass
 * decline too. Tracking ownership per async context makes re-entry a no-op
 * instead of a stall, without loosening the guarantee between separate passes.
 */
const held = new AsyncLocalStorage<Set<string>>();

export function withBrainLock<T>(chatId: string, characterId: string, fn: () => Promise<T>): Promise<T> {
  const key = brainKey(chatId, characterId);
  const owned = held.getStore();
  // Already ours: run straight through rather than queueing behind ourselves.
  if (owned?.has(key)) return fn();

  const prev = locks.get(key) ?? Promise.resolve();
  const run = () => held.run(new Set([...(owned ?? []), key]), fn);
  const next = prev.then(run, run);
  locks.set(key, next.catch(() => undefined));
  return next;
}

/** Is a long-running pass currently holding this brain? */
export function brainBusy(chatId: string, characterId: string): boolean {
  return inFlight.has(brainKey(chatId, characterId));
}

/**
 * Run `fn` only if no other long pass is already working on this brain.
 *
 * Queueing is right for quick writes and wrong for consolidation: a pass makes a
 * model call, so if one stalls, every later pass queues behind it and memory
 * stops forming until the process restarts — with nothing in the log to say so.
 * Declining is strictly better, because the next turn will try again anyway.
 */
export async function tryWithBrainLock<T>(
  chatId: string,
  characterId: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const key = brainKey(chatId, characterId);
  // Re-entry from inside our own pass is not a competing pass: declining there
  // would abandon work we are in the middle of doing.
  if (held.getStore()?.has(key)) return { ran: true, value: await fn() };
  if (inFlight.has(key)) return { ran: false };
  inFlight.add(key);
  try {
    const value = await withBrainLock(chatId, characterId, fn);
    return { ran: true, value };
  } finally {
    inFlight.delete(key);
  }
}

export async function loadBrain(
  chatId: string,
  characterId: string,
  characterName: string,
): Promise<BrainState> {
  const raw = await readJson<Partial<BrainState> | null>(brainFile(chatId, characterId), null);
  if (!raw) return emptyBrain(chatId, characterId, characterName);
  return normalizeBrain(raw, chatId, characterId, characterName);
}

/** Returns null when this character has no brain in this chat yet. */
export async function loadBrainIfExists(chatId: string, characterId: string): Promise<BrainState | null> {
  const raw = await readJson<Partial<BrainState> | null>(brainFile(chatId, characterId), null);
  if (!raw) return null;
  return normalizeBrain(raw, chatId, characterId, raw.characterName ?? characterId);
}

export async function saveBrain(brain: BrainState): Promise<void> {
  brain.updatedAt = Date.now();
  await writeJsonAtomic(brainFile(brain.chatId, brain.characterId), brain);
}

export async function deleteBrain(chatId: string, characterId: string): Promise<void> {
  await fsp.rm(brainFile(chatId, characterId), { force: true });
  await fsp.rm(logFile(chatId, characterId), { force: true });
}

/** Every brain on disk, as (chatId, characterId) pairs. */
export async function listBrainRefs(): Promise<BrainRef[]> {
  let files: string[];
  try {
    files = await fsp.readdir(dirs.brains);
  } catch {
    return [];
  }
  const out: BrainRef[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.log.jsonl')) continue;
    const ref = parseBrainKey(f.replace(/\.json$/, ''));
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Drop every brain belonging to a chat. Called when a chat (or a whole group)
 * is deleted — a mind cannot outlive the conversation it belongs to.
 */
export async function deleteBrainsForChat(chatId: string): Promise<number> {
  const refs = await listBrainRefs();
  let removed = 0;
  for (const ref of refs) {
    if (ref.chatId !== sanitizeId(chatId)) continue;
    await deleteBrain(ref.chatId, ref.characterId);
    removed++;
  }
  return removed;
}

export interface AuditEntry {
  id: string;
  at: number;
  kind: 'init' | 'consolidate' | 'recall' | 'edit' | 'config' | 'error' | 'mentation';
  chatId?: string;
  summary: string;
  detail?: unknown;
}

export async function appendAudit(
  chatId: string,
  characterId: string,
  entry: Omit<AuditEntry, 'id' | 'at'>,
): Promise<void> {
  try {
    await appendJsonl(logFile(chatId, characterId), { id: randomUUID(), at: Date.now(), ...entry });
  } catch {
    // The audit log is a convenience; never let it break a consolidation pass.
  }
}

export async function readAudit(chatId: string, characterId: string, limit = 100): Promise<AuditEntry[]> {
  try {
    const rows = await readJsonl<AuditEntry>(logFile(chatId, characterId));
    return rows.slice(-limit).reverse();
  } catch {
    return [];
  }
}

/** Compact one-line description of a consolidation pass for the audit log. */
export function summarizeReport(r: ConsolidationReport): string {
  const bits: string[] = [];
  if (r.encoded.length) bits.push(`+${r.encoded.length} encoded`);
  if (r.skipped) bits.push(`${r.skipped} too forgettable to keep`);
  if (r.reconsolidated.length) bits.push(`${r.reconsolidated.length} merged into existing memories`);
  if (r.reconsolidationBlocked.length) bits.push(`${r.reconsolidationBlocked.length} resisted change`);
  if (r.traumaFormed.length) bits.push(`${r.traumaFormed.length} traumatic`);
  if (r.semanticised.length) bits.push(`${r.semanticised.length} generalised`);
  if (r.schemasFormed.length) bits.push(`${r.schemasFormed.length} new beliefs`);
  if (r.faded.length) bits.push(`${r.faded.length} faded`);
  if (r.dormant.length) bits.push(`${r.dormant.length} slipped away`);
  if (r.pruned.length) bits.push(`${r.pruned.length} forgotten`);
  const drift = Object.entries(r.traitDrift).filter(([, v]) => Math.abs(v as number) > 0.002);
  if (drift.length) bits.push(`drift: ${drift.map(([k, v]) => `${k}${(v as number) > 0 ? '+' : ''}${(v as number).toFixed(3)}`).join(' ')}`);
  return bits.length ? bits.join(', ') : 'nothing worth keeping';
}
