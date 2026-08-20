/**
 * Skills on the generation path.
 *
 * Everything here is designed to fail quietly. Skills make a good reply better;
 * they must never be why a reply does not happen. Every entry point returns an
 * empty result on error rather than throwing into the turn.
 */
import type { AppSettings, ChatMessage, ChatMeta, Persona } from '../../shared/types';
import type { ChatSkillState, Skill, SkillsSettings } from '../../shared/skills/types';
import { DEFAULT_SKILLS_SETTINGS, emptyChatSkillState } from '../../shared/skills/types';
import {
  applyDecision, buildSkillRoster, composeSkillBlock, matchSkillName, planSkillBudget,
  resolveActiveSkills, shortlistSkills, skillScoutPrompt, skillSelectorTail, splitList,
} from '../../shared/skills';
import { estimateTokens } from '../../shared/engine/tokens';
import { generateOnce } from '../providers/text';
import { runRouted } from '../providers/router';
import { resolveContextLimit } from '../providers/contextLimits';
import { listEnabledSkills } from './store';

export function skillSettings(settings: AppSettings): SkillsSettings {
  return { ...DEFAULT_SKILLS_SETTINGS, ...(settings.skills ?? {}) };
}

export function chatSkillState(meta: ChatMeta): ChatSkillState {
  const s = meta.skills;
  if (!s) return emptyChatSkillState();
  return {
    active: s.active ?? [],
    forced: s.forced ?? [],
    muted: s.muted ?? [],
    decidedAt: s.decidedAt,
    log: s.log ?? [],
  };
}

/** How much recent transcript the shortlist and the scout look at. */
const EXCERPT_MESSAGES = 8;

export function recentExcerpt(history: ChatMessage[], count = EXCERPT_MESSAGES): string {
  return history
    .filter((m) => !m.hiddenFromPrompt)
    .slice(-count)
    .map((m) => `${m.speaker.displayName}: ${m.text}`)
    .join('\n');
}

export interface SkillTurn {
  /** Composed ACTIVE SKILLS block, or empty. */
  block: string;
  /** Selector tail for the inline router, or empty. */
  selector: string;
  /** Skills injected this turn — what the UI reports as "in use". */
  used: Skill[];
  /** Skills advertised to the selector — the answer space for the reply tag. */
  roster: Skill[];
  /** Every enabled skill, so a decision can be matched back to an id. */
  all: Skill[];
  levels: Record<string, 'full' | 'sections' | 'digest' | 'dropped'>;
  budget: number;
}

const EMPTY_TURN: SkillTurn = {
  block: '', selector: '', used: [], roster: [], all: [], levels: {}, budget: 0,
};

export interface PrepareInput {
  settings: AppSettings;
  meta: ChatMeta;
  history: ChatMessage[];
  characterName: string;
  /** Tokens the fixed scaffolding costs, from the probe build. */
  fixedPromptTokens: number;
  /** Tokens memory already claimed — skills queue behind it. */
  brainTokens: number;
  reservedOutput: number;
  presetMaxContext: number;
  /** Skip the selector on turns whose output is not a normal reply. */
  allowSelector: boolean;
}

/**
 * Everything a turn needs from the skill system, in one pass.
 *
 * The two halves are independent on purpose: a turn can inject documents
 * without asking for a new decision (a continue, a swipe) and can ask for a
 * decision while injecting nothing (the first turn of a fresh chat).
 */
export async function prepareSkillTurn(input: PrepareInput): Promise<SkillTurn> {
  const cfg = skillSettings(input.settings);
  if (!cfg.enabled || cfg.selection === 'off') return EMPTY_TURN;

  let all: Skill[];
  try {
    all = await listEnabledSkills();
  } catch (err) {
    console.error('[skills] could not read the library, continuing without skills:', err);
    return EMPTY_TURN;
  }
  if (!all.length) return EMPTY_TURN;

  const state = chatSkillState(input.meta);
  const resolved = resolveActiveSkills({
    skills: all,
    state,
    settings: cfg,
    messageCount: input.history.length,
  });

  // ---- what gets injected now ----
  // The model's real window, not the preset slider: a skill budget that ignores
  // the model would either waste a million-token context or overflow a small one.
  const modelContext = await resolveContextLimit(input.settings.textConnection)
    .then((l) => l.contextTokens)
    .catch(() => input.presetMaxContext);
  const usable = Math.max(
    1024,
    Math.min(modelContext, input.presetMaxContext) - input.reservedOutput,
  );
  const budget = planSkillBudget({
    usable,
    fixedPromptTokens: input.fixedPromptTokens,
    brainTokens: input.brainTokens,
    share: cfg.shareOfContext,
  });
  const composed = composeSkillBlock({ skills: resolved.skills, budget });

  // ---- what gets decided for next turn ----
  let selector = '';
  let roster: Skill[] = [];
  if (input.allowSelector && cfg.selection === 'auto' && cfg.inlineSelector) {
    roster = shortlistSkills({
      // `always` skills are already loaded, and `manual` ones are ignored by
      // resolution — advertising either spends roster tokens on an answer that
      // can change nothing.
      skills: all.filter((s) => s.mode === 'auto'),
      recentText: recentExcerpt(input.history, 4),
      activeIds: state.active.map((a) => a.id),
      max: cfg.rosterMax,
    });
    if (roster.length) {
      selector = skillSelectorTail({
        roster,
        activeNames: resolved.skills.map((s) => s.name),
        characterName: input.characterName,
      });
    }
  }

  return {
    block: composed.text,
    selector,
    used: resolved.skills.filter((s) => composed.levels[s.id] && composed.levels[s.id] !== 'dropped'),
    roster,
    all,
    levels: composed.levels,
    budget,
  };
}

/**
 * Fold a routing decision into chat state.
 *
 * Always returns the new state, even when the same skills came back again. An
 * earlier version skipped the write as an optimisation, which quietly broke
 * stickiness: re-confirming a skill is exactly what refreshes `lastSeen`, so
 * skipping the write left the timestamp frozen at the first arming and the next
 * omission dropped a skill the model had been asking for every single turn.
 * Chat meta is written on every turn regardless, so there was nothing to save.
 */
export function decisionFromTag(
  state: ChatSkillState,
  skills: Skill[],
  names: string[],
  at: number,
  via: 'inline' | 'scout',
): ChatSkillState {
  const matched = names.map((n) => matchSkillName(skills, n)).filter(Boolean) as Skill[];
  const reason = matched.length
    ? `scene calls for ${matched.map((s) => s.name).join(', ')}`
    : 'no skill needed';
  return applyDecision(state, skills, names, at, reason, via);
}

/**
 * The fallback path: one cheap call, after the reply is already on screen.
 *
 * Only runs when the model declined to emit a tag. It exists so the feature
 * works on models that ignore trailing instructions — the cost is one small
 * request on a turn that has already completed, which the user never waits for.
 */
export async function scoutSkills(input: {
  settings: AppSettings;
  turn: SkillTurn;
  history: ChatMessage[];
  characterName: string;
  persona: Persona;
}): Promise<string[] | null> {
  const cfg = skillSettings(input.settings);
  if (!cfg.enabled || cfg.selection !== 'auto' || !cfg.scoutFallback) return null;

  const roster = input.turn.roster.length
    ? input.turn.roster
    : shortlistSkills({
        skills: input.turn.all.filter((s) => s.mode === 'auto'),
        recentText: recentExcerpt(input.history, 4),
        max: cfg.rosterMax,
      });
  if (!roster.length) return null;

  const prompt = skillScoutPrompt({
    roster,
    activeNames: input.turn.used.map((s) => s.name),
    excerpt: recentExcerpt(input.history),
    characterName: input.characterName,
    personaName: input.persona.name,
  });

  try {
    const { value } = await runRouted(
      input.settings,
      'extract',
      (conn) => generateOnce(conn, prompt.system, prompt.user, { maxTokens: 60, temperature: 0 }),
      // A classifier that answers with a paragraph has not understood the task.
      (text) => typeof text === 'string' && text.trim().length > 0 && estimateTokens(text) < 60,
    );
    const cleaned = String(value).replace(/^[^:]*:/, '').trim();
    if (/^\s*none\b/i.test(cleaned)) return [];
    return splitList(cleaned).slice(0, Math.max(1, cfg.maxActive));
  } catch (err) {
    console.error('[skills] scout failed, keeping the previous selection:', err);
    return null;
  }
}

/** Roster preview for the UI, so the page can show what a turn would advertise. */
export function rosterPreview(skills: Skill[]): { text: string; tokens: number } {
  const text = buildSkillRoster(skills);
  return { text, tokens: estimateTokens(text) };
}
