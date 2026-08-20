/** ST world info JSON ({entries: {uid: entry}}) <-> internal Lorebook. */
import { WILogic, WIPosition, type Lorebook, type WIEntry, type CharacterBook } from '../types';

type AnyObj = Record<string, any>;

export function parseLorebook(raw: AnyObj, id: string, name: string): Lorebook {
  const entriesRaw: AnyObj = raw.entries ?? {};
  const list: AnyObj[] = Array.isArray(entriesRaw) ? entriesRaw : Object.values(entriesRaw);
  const entries: WIEntry[] = list.map((e, i) => normalizeEntry(e, i));
  return { id, name, entries, raw };
}

export function normalizeEntry(e: AnyObj, fallbackUid: number): WIEntry {
  return {
    uid: numOr(e.uid, fallbackUid),
    key: toArr(e.key ?? e.keys),
    keysecondary: toArr(e.keysecondary ?? e.secondary_keys),
    comment: strOr(e.comment, ''),
    content: strOr(e.content, ''),
    constant: !!e.constant,
    selective: !!e.selective,
    selectiveLogic: numOr(e.selectiveLogic, WILogic.AND_ANY),
    order: numOr(e.order ?? e.insertion_order, 100),
    position: numOr(e.position, WIPosition.Before),
    disable: !!e.disable || e.enabled === false,
    excludeRecursion: !!e.excludeRecursion,
    preventRecursion: !!e.preventRecursion,
    delayUntilRecursion: e.delayUntilRecursion ?? false,
    probability: numOr(e.probability, 100),
    useProbability: e.useProbability !== false,
    depth: numOr(e.depth, 4),
    role: numOr(e.role, 0) as 0 | 1 | 2,
    group: strOr(e.group, ''),
    groupOverride: !!e.groupOverride,
    groupWeight: numOr(e.groupWeight, 100),
    scanDepth: e.scanDepth ?? null,
    caseSensitive: e.caseSensitive ?? null,
    matchWholeWords: e.matchWholeWords ?? null,
    raw: e,
  };
}

/** Convert an embedded character book to WI entries (before_char/after_char -> positions). */
export function bookToEntries(book: CharacterBook): WIEntry[] {
  return book.entries
    .filter((e) => e.enabled)
    .map((e, i) => {
      const ext = (e.extensions ?? {}) as AnyObj;
      return normalizeEntry(
        {
          uid: e.id ?? i,
          key: e.keys,
          keysecondary: e.secondary_keys,
          comment: e.comment,
          content: e.content,
          constant: e.constant,
          selective: e.selective,
          order: e.insertion_order,
          position: ext.position ?? (e.position === 'after_char' ? WIPosition.After : WIPosition.Before),
          disable: false,
          ...ext,
        },
        i,
      );
    });
}

export function exportLorebook(book: Lorebook): AnyObj {
  const entries: AnyObj = {};
  for (const e of book.entries) {
    entries[e.uid] = { ...(e.raw ?? {}), ...e, raw: undefined };
    delete entries[e.uid].raw;
  }
  return { ...(book.raw ?? {}), entries };
}

function toArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
function numOr(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function strOr(v: unknown, d: string): string {
  return typeof v === 'string' ? v : d;
}
