/**
 * World Info activation engine — port of ST semantics:
 * key scan over recent messages, regex keys, selective secondary logic,
 * constant entries, probability rolls, recursion, inclusion groups, budget.
 */
import { WILogic, WIPosition, type WIEntry } from '../types';

export interface WIScanInput {
  entries: WIEntry[]; // all candidate entries (global + character books), already enabled-filtered upstream if desired
  /** newest-last chat texts to scan */
  messages: string[];
  /** extra always-scanned texts (persona/char fields) */
  extraScanText?: string;
  settings: {
    scanDepth: number;
    recursive: boolean;
    caseSensitive: boolean;
    matchWholeWords: boolean;
    budgetTokens: number;
    minActivations?: number;
    maxRecursionSteps?: number;
  };
  countTokens: (text: string) => number;
  random?: () => number;
}

export interface WIScanResult {
  before: WIEntry[];
  after: WIEntry[];
  anTop: WIEntry[];
  anBottom: WIEntry[];
  emTop: WIEntry[];
  emBottom: WIEntry[];
  atDepth: { entry: WIEntry; depth: number; role: 0 | 1 | 2 }[];
  activated: WIEntry[];
  droppedForBudget: WIEntry[];
}

function keyToRegex(key: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(key);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2].includes('g') ? m[2] : m[2]);
  } catch {
    return null;
  }
}

function matchKey(haystack: string, key: string, caseSensitive: boolean, wholeWords: boolean): boolean {
  const re = keyToRegex(key);
  if (re) return re.test(haystack);
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  const k = caseSensitive ? key : key.toLowerCase();
  if (!k.trim()) return false;
  if (wholeWords && !/\s/.test(k)) {
    return new RegExp(`\\b${escapeRe(k)}\\b`, caseSensitive ? '' : 'i').test(haystack);
  }
  return h.includes(k);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function entryMatches(entry: WIEntry, text: string, s: WIScanInput['settings']): boolean {
  const cs = entry.caseSensitive ?? s.caseSensitive;
  const ww = entry.matchWholeWords ?? s.matchWholeWords;
  const primaryHit = entry.key.some((k) => matchKey(text, k, cs, ww));
  if (!primaryHit) return false;
  if (!entry.selective || entry.keysecondary.length === 0) return true;
  const secHits = entry.keysecondary.map((k) => matchKey(text, k, cs, ww));
  const any = secHits.some(Boolean);
  const all = secHits.every(Boolean);
  switch (entry.selectiveLogic) {
    case WILogic.AND_ANY: return any;
    case WILogic.AND_ALL: return all;
    case WILogic.NOT_ANY: return !any;
    case WILogic.NOT_ALL: return !all;
    default: return any;
  }
}

/** Resolve inclusion groups: within each named group, only one entry survives (highest weight roll). */
function resolveGroups(activated: WIEntry[], random: () => number): WIEntry[] {
  const grouped = new Map<string, WIEntry[]>();
  const out: WIEntry[] = [];
  for (const e of activated) {
    const groups = e.group ? e.group.split(',').map((g) => g.trim()).filter(Boolean) : [];
    if (!groups.length) { out.push(e); continue; }
    const gkey = groups[0];
    if (!grouped.has(gkey)) grouped.set(gkey, []);
    grouped.get(gkey)!.push(e);
  }
  for (const [, members] of grouped) {
    const override = members.find((m) => m.groupOverride);
    if (override) { out.push(override); continue; }
    const totalWeight = members.reduce((sum, m) => sum + (m.groupWeight || 100), 0);
    let roll = random() * totalWeight;
    let winner = members[0];
    for (const m of members) {
      roll -= m.groupWeight || 100;
      if (roll <= 0) { winner = m; break; }
    }
    out.push(winner);
  }
  return out;
}

export function scanWorldInfo(input: WIScanInput): WIScanResult {
  const { entries, settings } = input;
  const random = input.random ?? Math.random;
  const active = entries.filter((e) => !e.disable);

  const scanWindow = input.messages.slice(-Math.max(1, settings.scanDepth)).join('\n');
  const baseText = [scanWindow, input.extraScanText ?? ''].join('\n');

  const activatedSet = new Map<number | string, WIEntry>();
  const keyFor = (e: WIEntry) => `${e.uid}:${e.comment}:${e.content.length}`;

  // recursion loop: newly activated content joins the scan text
  let scanText = baseText;
  let loop = 0;
  const maxLoops = Math.max(1, settings.maxRecursionSteps || 5);
  let isRecursionPass = false;

  while (loop < maxLoops) {
    loop += 1;
    let newlyActivated = false;
    for (const entry of active) {
      const k = keyFor(entry);
      if (activatedSet.has(k)) continue;
      if (isRecursionPass && entry.excludeRecursion) continue;
      if (!isRecursionPass && entry.delayUntilRecursion) continue;

      let hit = entry.constant;
      if (!hit && entry.key.length > 0) hit = entryMatches(entry, scanText, settings);
      if (!hit) continue;
      if (entry.useProbability && entry.probability < 100 && random() * 100 >= entry.probability) continue;

      activatedSet.set(k, entry);
      newlyActivated = true;
    }
    if (!settings.recursive || !newlyActivated) break;
    isRecursionPass = true;
    scanText = baseText + '\n' + [...activatedSet.values()]
      .filter((e) => !e.preventRecursion)
      .map((e) => e.content)
      .join('\n');
  }

  let activated = resolveGroups([...activatedSet.values()], random);
  // sort by order desc (ST: higher order = closer / kept under budget first by priority)
  activated.sort((a, b) => b.order - a.order);

  // budget
  const kept: WIEntry[] = [];
  const dropped: WIEntry[] = [];
  let used = 0;
  for (const e of activated) {
    const t = input.countTokens(e.content);
    if (used + t <= settings.budgetTokens || e.constant) {
      kept.push(e);
      used += t;
    } else {
      dropped.push(e);
    }
  }

  const byPos = (p: WIPosition) => kept.filter((e) => e.position === p).sort((a, b) => b.order - a.order);
  return {
    before: byPos(WIPosition.Before),
    after: byPos(WIPosition.After),
    anTop: byPos(WIPosition.ANTop),
    anBottom: byPos(WIPosition.ANBottom),
    emTop: byPos(WIPosition.EMTop),
    emBottom: byPos(WIPosition.EMBottom),
    atDepth: kept
      .filter((e) => e.position === WIPosition.AtDepth)
      .map((e) => ({ entry: e, depth: e.depth, role: e.role })),
    activated: kept,
    droppedForBudget: dropped,
  };
}
