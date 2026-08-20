/**
 * Skills — global craft documents any character can draw on.
 *
 * A skill is a long, deliberately *broad* document about how to do one thing
 * well (write martial arts action, cook, seduce, manipulate, dance). It is not
 * lore and not a character trait: it is craft knowledge the story can adapt.
 * The same kung-fu skill must serve a Shaolin monk and a college nerd who has
 * never thrown a punch — so skills describe principles, vocabulary and failure
 * modes rather than a fixed script.
 *
 * Two things keep skills cheap:
 *
 * 1. Only the *roster* (name + one line) travels on every turn. The full body
 *    is injected only once a skill has been selected.
 * 2. Selection piggybacks on the reply the model is already writing — it ends
 *    its message with a machine tag — so an armed skill costs zero extra API
 *    calls. See `docs/skills-system.md`.
 */

/** A heading-delimited chunk of a skill body, used for graded trimming. */
export interface SkillSection {
  heading: string;
  body: string;
  tokens: number;
}

/**
 * How a skill is allowed to become active.
 *
 * - `auto`   — the selector decides per scene. The default, and the only mode
 *              that costs nothing when the scene does not call for it.
 * - `always` — injected every turn while enabled. Honest about its price: this
 *              spends its full token cost forever, so the page shows it.
 * - `manual` — never auto-selected; only active where the user pinned it on.
 */
export type SkillMode = 'auto' | 'always' | 'manual';

export interface Skill {
  id: string;
  /** Short human name, e.g. "Martial Arts". Also what the selector returns. */
  name: string;
  /**
   * One line. This is the *entire* basis on which the model decides whether the
   * skill applies, so it should say when it is relevant, not just what it is.
   */
  description: string;
  /** The long document. Markdown; headings become `sections`. */
  body: string;
  enabled: boolean;
  mode: SkillMode;
  /** Cheap local shortlist hints — matched against recent messages. Optional. */
  keywords: string[];
  tags: string[];
  /** 0–100. Higher survives longer when the skill budget is tight. */
  priority: number;
  /**
   * Once selected, stay selected for at least this many turns.
   *
   * Without it a fight scene flickers: the model omits the skill on one turn
   * that happens to be dialogue, the doc drops out, and the choreography
   * degrades mid-exchange.
   */
  stickyTurns: number;
  /** Cached estimate of `body`, so the library can price itself without work. */
  tokens: number;
  sections: SkillSection[];
  /**
   * A compressed version (~60–120 tokens) used when the full body will not fit.
   * Derived on save unless the author wrote one.
   */
  digest: string;
  source: 'manual' | 'import' | 'ai';
  createdAt: number;
  updatedAt: number;
}

export interface SkillsSettings {
  /** Master switch. Off = the app behaves exactly as it did before skills. */
  enabled: boolean;
  /**
   * How active skills get chosen.
   * - `auto`   — model-driven selection (inline tag, scout fallback).
   * - `manual` — only what the user pinned per chat, plus `always` skills.
   * - `off`    — nothing is injected, even `always` skills.
   */
  selection: 'auto' | 'manual' | 'off';
  /** Never inject more than this many skill documents at once. */
  maxActive: number;
  /** Share of usable context skills may occupy. Hard ceiling `MAX_SKILL_SHARE`. */
  shareOfContext: number;
  /** Most skills advertised to the selector in one turn. */
  rosterMax: number;
  /** Ride the selector on the main generation call (no extra request). */
  inlineSelector: boolean;
  /** When the inline tag is missing, spend one cheap call after the turn ends. */
  scoutFallback: boolean;
}

/** One skill armed for the coming turns. */
export interface ActiveSkill {
  id: string;
  /** Message count at which it was first armed. Shown, not used for expiry. */
  since: number;
  /**
   * Message count at which the selector last asked for it — what stickiness is
   * measured from.
   *
   * Measuring from `since` was wrong in exactly the case the feature exists for:
   * a skill armed at message 10 and re-confirmed every turn through message 30
   * was already twenty turns "old", so the first quiet beat dropped it
   * instantly. Stickiness has to protect the most recent confirmation, not the
   * first one. Optional so states written before this field still load.
   */
  lastSeen?: number;
  /** Why the selector picked it, for the chat panel. Short. */
  reason?: string;
}

/** Per-conversation skill state. Lives on ChatMeta. */
export interface ChatSkillState {
  /** Armed by the selector — applies from the next turn onward. */
  active: ActiveSkill[];
  /** Pinned on by the user for this chat, regardless of the selector. */
  forced: string[];
  /** Pinned off by the user for this chat, overriding everything. */
  muted: string[];
  /** Message count at the last selector decision. */
  decidedAt?: number;
  /** Recent decisions, newest first, capped. Shown in the chat panel. */
  log?: { at: number; ids: string[]; reason: string; via: 'inline' | 'scout' | 'manual' }[];
}

/** What the selector returns, however it was obtained. */
export interface SkillDecision {
  ids: string[];
  reason: string;
  via: 'inline' | 'scout' | 'manual';
}

/** Hard ceiling on the share of usable context skills may take. */
export const MAX_SKILL_SHARE = 0.35;

export const DEFAULT_SKILLS_SETTINGS: SkillsSettings = {
  enabled: true,
  selection: 'auto',
  maxActive: 3,
  shareOfContext: 0.25,
  rosterMax: 24,
  inlineSelector: true,
  scoutFallback: true,
};

export function emptyChatSkillState(): ChatSkillState {
  return { active: [], forced: [], muted: [] };
}
