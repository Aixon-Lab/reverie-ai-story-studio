/**
 * Where a mind's settings come from.
 *
 * Three people can have an opinion about how a character remembers: the app
 * (global defaults in the Memory drawer), the conversation (one dial for the
 * whole cast — a group's settings), and the mind itself (its own page). They are
 * layered most-general to most-specific:
 *
 *     defaults  →  global  →  conversation  →  the mind's own config
 *
 * Only the first three are resolved here, because they decide what a *new* mind
 * is born with. Once a mind exists its own config wins outright — otherwise
 * tuning one character would be silently undone by a global change later.
 *
 * This used to not exist at all: every new brain took the hard-coded defaults,
 * so the drawer's "defaults a new mind inherits" inherited nothing.
 */
import type { BrainConfig } from './types';
import { DEFAULT_CONFIG, MAX_BRAIN_SHARE } from './defaults';

/** The settings a human can actually set — `params` are tuned per mind only. */
export type BrainConfigFields = Pick<
  BrainConfig,
  'enabled' | 'autoUpdate' | 'updateEveryMessages' | 'shareOfContext' | 'traumaEnabled'
  | 'intrusionsEnabled' | 'confabulation'
>;

export const CONFIG_FIELDS: (keyof BrainConfigFields)[] = [
  'enabled', 'autoUpdate', 'updateEveryMessages', 'shareOfContext', 'traumaEnabled',
  'intrusionsEnabled', 'confabulation',
];

/** A pass every 1..100 messages; anything else is a typo or a bad migration. */
export function clampCadence(n: unknown, fallback = DEFAULT_CONFIG.updateEveryMessages): number {
  if (!Number.isFinite(n as number)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(n as number)));
}

/** Memory never takes more than a third of the window — enforced here, not in the UI. */
export function clampShare(n: unknown, fallback = DEFAULT_CONFIG.shareOfContext): number {
  if (!Number.isFinite(n as number)) return fallback;
  return Math.max(0, Math.min(MAX_BRAIN_SHARE, n as number));
}

/**
 * How readily a degraded memory drifts into a confident error. 0 = never
 * misremember, only fade; 1 = the full modelled rate.
 */
export function clampConfabulation(n: unknown, fallback = DEFAULT_CONFIG.confabulation): number {
  if (!Number.isFinite(n as number)) return fallback;
  return Math.max(0, Math.min(1, n as number));
}

/** Keep only recognised keys, dropping wrong types instead of storing them. */
export function sanitizeConfigPatch(patch: unknown): Partial<BrainConfigFields> {
  const src = (patch ?? {}) as Record<string, unknown>;
  const out: Partial<BrainConfigFields> = {};
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (typeof src.autoUpdate === 'boolean') out.autoUpdate = src.autoUpdate;
  if (typeof src.traumaEnabled === 'boolean') out.traumaEnabled = src.traumaEnabled;
  if (typeof src.intrusionsEnabled === 'boolean') out.intrusionsEnabled = src.intrusionsEnabled;
  if (Number.isFinite(src.updateEveryMessages as number)) {
    out.updateEveryMessages = clampCadence(src.updateEveryMessages);
  }
  if (Number.isFinite(src.shareOfContext as number)) out.shareOfContext = clampShare(src.shareOfContext);
  if (Number.isFinite(src.confabulation as number)) out.confabulation = clampConfabulation(src.confabulation);
  return out;
}

/**
 * What a mind born right now should start with.
 *
 * `enabled` is deliberately *not* inherited from the global master switch: that
 * switch turns the whole feature off, and a mind created while it is off would
 * otherwise be permanently disabled after the user turns it back on.
 */
export function resolveBrainConfig(layers: {
  global?: Partial<BrainConfigFields> | null;
  chat?: Partial<BrainConfigFields> | null;
}): BrainConfigFields {
  const global = sanitizeConfigPatch(layers.global);
  const chat = sanitizeConfigPatch(layers.chat);
  const pick = <K extends keyof BrainConfigFields>(key: K): BrainConfigFields[K] =>
    (chat[key] ?? global[key] ?? DEFAULT_CONFIG[key]) as BrainConfigFields[K];

  return {
    enabled: (chat.enabled ?? DEFAULT_CONFIG.enabled) as boolean,
    autoUpdate: pick('autoUpdate'),
    updateEveryMessages: clampCadence(pick('updateEveryMessages')),
    shareOfContext: clampShare(pick('shareOfContext')),
    traumaEnabled: pick('traumaEnabled'),
    intrusionsEnabled: pick('intrusionsEnabled'),
    confabulation: clampConfabulation(pick('confabulation')),
  };
}

/**
 * One value per field across a cast, or `undefined` where they disagree — so a
 * group screen can say "mixed" instead of lying about a shared setting.
 */
export function commonConfig(configs: Partial<BrainConfigFields>[]): Partial<BrainConfigFields> {
  const out: Partial<BrainConfigFields> = {};
  if (!configs.length) return out;
  for (const key of CONFIG_FIELDS) {
    const first = configs[0][key];
    if (first === undefined) continue;
    if (configs.every((c) => c[key] === first)) (out as Record<string, unknown>)[key] = first;
  }
  return out;
}
