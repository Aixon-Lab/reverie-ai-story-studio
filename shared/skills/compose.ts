/**
 * Skill selection and budgeting.
 *
 * Three jobs, in the order a turn needs them:
 *
 * 1. `shortlistSkills` — which skills are even worth *advertising* to the model
 *    this turn. Cheap, local, no model call.
 * 2. `resolveActiveSkills` — which armed skills actually apply now, once the
 *    user's per-chat pins, stickiness and the `maxActive` cap have had their say.
 * 3. `composeSkillBlock` — turn those into one prompt block that fits the
 *    tokens available, degrading rather than vanishing.
 */
import { estimateTokens } from '../engine/tokens';
import type { ActiveSkill, ChatSkillState, Skill, SkillsSettings } from './types';
import { MAX_SKILL_SHARE } from './types';

// ------------------------------------------------------------- shortlisting

export interface ShortlistInput {
  skills: Skill[];
  /** Recent transcript text used for keyword scoring. Newest last. */
  recentText: string;
  /** Already-armed skill ids — always advertised so the model can drop them. */
  activeIds?: string[];
  max: number;
}

/**
 * Rank candidates for the roster.
 *
 * Keyword hits dominate because they are evidence from the actual scene; the
 * author's priority only breaks ties. Armed skills are pinned in regardless:
 * a roster that omits what is currently active gives the model no way to say
 * "the fight is over" — omission is how a skill gets dropped.
 */
export function shortlistSkills(input: ShortlistInput): Skill[] {
  const active = new Set(input.activeIds ?? []);
  const haystack = ` ${input.recentText.toLowerCase()} `;

  const scored = input.skills.map((s) => {
    let score = s.priority / 100;
    for (const kw of s.keywords) {
      const k = kw.trim().toLowerCase();
      if (k.length < 3) continue;
      if (haystack.includes(k)) score += 3;
    }
    for (const tag of s.tags) {
      if (tag.length >= 3 && haystack.includes(tag.toLowerCase())) score += 1;
    }
    if (haystack.includes(s.name.toLowerCase())) score += 2;
    if (active.has(s.id)) score += 100;
    return { skill: s, score };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(1, input.max))
    .map((x) => x.skill);
}

/**
 * The roster line the selector sees. Name and one line — nothing else.
 *
 * This is what makes the whole system affordable: twenty skills cost roughly
 * 300 tokens per turn, and only the ones actually chosen ever cost more.
 */
export function buildSkillRoster(skills: Skill[]): string {
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
}

// ---------------------------------------------------------------- resolving

export interface ResolveInput {
  skills: Skill[];
  state: ChatSkillState;
  settings: SkillsSettings;
  /** Current message count — stickiness is measured against `active.since`. */
  messageCount: number;
}

export interface ResolvedSkills {
  skills: Skill[];
  /** Why each one is here, for the chat panel and the prompt inspector. */
  reasons: Record<string, 'always' | 'forced' | 'selected' | 'sticky'>;
}

/**
 * Decide what is injected *this* turn.
 *
 * Precedence, strongest first: a mute always wins (the user said no), then a
 * force (the user said yes), then `always` skills, then whatever the selector
 * armed. Stickiness only matters for the armed set — it keeps a skill alive
 * for a few turns after selection so a scene does not lose its choreography on
 * one quiet beat.
 */
export function resolveActiveSkills(input: ResolveInput): ResolvedSkills {
  const { settings, state } = input;
  const byId = new Map(input.skills.map((s) => [s.id, s]));
  const muted = new Set(state.muted ?? []);
  const reasons: Record<string, 'always' | 'forced' | 'selected' | 'sticky'> = {};
  const picked: Skill[] = [];

  const add = (skill: Skill | undefined, why: 'always' | 'forced' | 'selected' | 'sticky') => {
    if (!skill || muted.has(skill.id) || reasons[skill.id]) return;
    if (!skill.enabled) return;
    reasons[skill.id] = why;
    picked.push(skill);
  };

  if (settings.selection === 'off' || !settings.enabled) return { skills: [], reasons: {} };

  // Forced first: a pin should never be pushed out by the cap.
  for (const id of state.forced ?? []) add(byId.get(id), 'forced');
  for (const skill of input.skills) {
    if (skill.mode === 'always') add(skill, 'always');
  }
  if (settings.selection === 'auto') {
    for (const a of state.active ?? []) {
      const skill = byId.get(a.id);
      if (!skill || skill.mode === 'manual') continue;
      const age = input.messageCount - lastSeenOf(a);
      add(skill, age >= skill.stickyTurns ? 'sticky' : 'selected');
    }
  }

  const cap = Math.max(1, settings.maxActive);
  const kept = picked
    .sort((a, b) => rank(reasons[a.id]) - rank(reasons[b.id]) || b.priority - a.priority)
    .slice(0, cap);

  const keptReasons: ResolvedSkills['reasons'] = {};
  for (const s of kept) keptReasons[s.id] = reasons[s.id];
  return { skills: kept, reasons: keptReasons };
}

function rank(why: string): number {
  return why === 'forced' ? 0 : why === 'always' ? 1 : why === 'sticky' ? 2 : 3;
}

/**
 * Fold a fresh decision into chat state.
 *
 * Names are matched loosely (case, punctuation and spacing) because the model
 * is echoing a human-readable roster, not ids — "Martial Arts", "martial-arts"
 * and "martial arts" are the same answer, and rejecting two of the three would
 * make selection look broken at random.
 */
export function applyDecision(
  state: ChatSkillState,
  skills: Skill[],
  names: string[],
  at: number,
  reason: string,
  via: 'inline' | 'scout' | 'manual',
): ChatSkillState {
  const wanted = new Set<string>();
  for (const raw of names) {
    const match = matchSkillName(skills, raw);
    if (match) wanted.add(match.id);
  }

  const previous = new Map((state.active ?? []).map((a) => [a.id, a]));
  // A re-confirmed skill keeps its original `since` (that is when the scene
  // turned) but refreshes `lastSeen`, which is what expiry counts from.
  const active: ActiveSkill[] = [...wanted].map((id) => {
    const prior = previous.get(id);
    return prior
      ? { ...prior, lastSeen: at }
      : { id, since: at, lastSeen: at, reason };
  });

  // Stickiness: a skill confirmed moments ago outlives one omission.
  for (const a of state.active ?? []) {
    if (wanted.has(a.id)) continue;
    const skill = skills.find((s) => s.id === a.id);
    if (skill && at - lastSeenOf(a) < skill.stickyTurns) active.push(a);
  }

  const log = [{ at, ids: active.map((a) => a.id), reason, via }, ...(state.log ?? [])].slice(0, 20);
  return { ...state, active, decidedAt: at, log };
}

/** When the selector last confirmed this skill. Falls back for older states. */
function lastSeenOf(a: ActiveSkill): number {
  return a.lastSeen ?? a.since;
}

export function matchSkillName(skills: Skill[], raw: string): Skill | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const want = norm(raw);
  if (!want) return null;
  return (
    skills.find((s) => s.id === raw)
    ?? skills.find((s) => norm(s.name) === want)
    ?? skills.find((s) => norm(s.id) === want)
    ?? skills.find((s) => norm(s.name).startsWith(want) && want.length >= 4)
    ?? null
  );
}

// ---------------------------------------------------------------- composing

export interface ComposeInput {
  skills: Skill[];
  /** Hard token ceiling for the whole block. */
  budget: number;
  /** Names in the scene, purely so the header can address the writer directly. */
  characterName?: string;
}

export interface ComposedSkills {
  text: string;
  tokens: number;
  /** What each skill got: full doc, trimmed sections, digest, or nothing. */
  levels: Record<string, 'full' | 'sections' | 'digest' | 'dropped'>;
}

const SKILL_HEADER = [
  'ACTIVE SKILLS — craft knowledge you may draw on this turn.',
  'These are reference material, not events, not memories, and not instructions to show off.',
  'Adapt them to who this character actually is and to the world they are in: a trained fighter',
  'moves differently from a terrified amateur, and a period setting rules out modern technique.',
  'If a skill does not fit the moment or the character, ignore it. Never mention, quote, name or',
  'explain a skill in your reply — it must only show in how well the action is written.',
].join(' ');

/**
 * Build the prompt block, degrading each skill rather than dropping the lot.
 *
 * The order of surrender matters. A skill reduced to its digest still tells the
 * model *that* this character can fight and roughly how it should read, which
 * is most of the value; a skill dropped entirely takes the scene back to
 * generic flailing. So everything is offered a digest before anything is cut,
 * and cuts start from the lowest priority.
 */
export function composeSkillBlock(input: ComposeInput): ComposedSkills {
  const levels: Record<string, 'full' | 'sections' | 'digest' | 'dropped'> = {};
  if (!input.skills.length || input.budget <= 0) return { text: '', tokens: 0, levels };

  const header = SKILL_HEADER;
  const headerCost = estimateTokens(header);
  let room = input.budget - headerCost;
  if (room <= 0) return { text: '', tokens: 0, levels };

  // Priority order decides who eats first and who is cut last.
  const ordered = [...input.skills].sort((a, b) => b.priority - a.priority);
  const rendered = new Map<string, string>();

  // Pass 1 — everyone gets at least a digest, cheapest first, so a big skill
  // cannot starve three small ones.
  for (const skill of ordered) {
    const digest = renderDigest(skill);
    const cost = estimateTokens(digest);
    if (cost <= room) {
      rendered.set(skill.id, digest);
      levels[skill.id] = 'digest';
      room -= cost;
    } else {
      levels[skill.id] = 'dropped';
    }
  }

  // Pass 2 — upgrade toward the full document with whatever is left.
  for (const skill of ordered) {
    if (levels[skill.id] === 'dropped') continue;
    const current = rendered.get(skill.id)!;
    const currentCost = estimateTokens(current);

    const full = renderFull(skill);
    const fullCost = estimateTokens(full);
    if (fullCost - currentCost <= room) {
      rendered.set(skill.id, full);
      levels[skill.id] = 'full';
      room -= fullCost - currentCost;
      continue;
    }
    const partial = renderSections(skill, currentCost + room);
    if (partial) {
      const partialCost = estimateTokens(partial);
      if (partialCost > currentCost) {
        rendered.set(skill.id, partial);
        levels[skill.id] = 'sections';
        room -= partialCost - currentCost;
      }
    }
  }

  const blocks = ordered
    .filter((s) => rendered.has(s.id))
    .map((s) => rendered.get(s.id)!);
  if (!blocks.length) return { text: '', tokens: 0, levels };

  const text = [header, ...blocks].join('\n\n');
  return { text, tokens: estimateTokens(text), levels };
}

function renderDigest(skill: Skill): string {
  const digest = skill.digest?.trim() || skill.description;
  return `### SKILL: ${skill.name}\n${skill.description}\n${digest}`;
}

function renderFull(skill: Skill): string {
  return `### SKILL: ${skill.name}\n${skill.description}\n\n${skill.body.trim()}`;
}

/** As many whole sections as fit, in author order, with an honest note. */
function renderSections(skill: Skill, maxTokens: number): string | null {
  if (!skill.sections.length) return null;
  const head = `### SKILL: ${skill.name}\n${skill.description}`;
  const note = '(remaining sections omitted for space)';
  let used = estimateTokens(head) + estimateTokens(note);
  const kept: string[] = [];
  for (const section of skill.sections) {
    const chunk = section.heading ? `#### ${section.heading}\n${section.body}` : section.body;
    const cost = estimateTokens(chunk);
    if (used + cost > maxTokens) break;
    kept.push(chunk);
    used += cost;
  }
  if (!kept.length) return null;
  const omitted = kept.length < skill.sections.length;
  return [head, '', ...kept, ...(omitted ? [note] : [])].join('\n');
}

// ------------------------------------------------------------------ budget

export interface SkillBudgetInput {
  /** Context left for prompt content after output reservation and margin. */
  usable: number;
  /** What the fixed scaffolding already costs. */
  fixedPromptTokens: number;
  /** What memory took — skills queue behind the brain, never in front of it. */
  brainTokens: number;
  share: number;
  /** Floor of transcript that must survive no matter what. */
  minHistory?: number;
}

/**
 * How many tokens skills may spend this turn.
 *
 * Skills are the *last* claimant on context. Memory is who the character is and
 * history is what is happening; skills only change how well one kind of moment
 * is written. So they take a capped share of the window and, beyond that, only
 * what is genuinely free once the transcript floor is protected. When skills are
 * off this returns zero and every one of those tokens goes back to history —
 * which is exactly why turning them off makes the model remember more.
 */
export function planSkillBudget(input: SkillBudgetInput): number {
  const minHistory = input.minHistory ?? 512;
  const share = Math.min(Math.max(input.share, 0), MAX_SKILL_SHARE);
  const cap = Math.floor(input.usable * share);
  const free = input.usable - input.fixedPromptTokens - input.brainTokens - minHistory;
  return Math.max(0, Math.min(cap, Math.floor(free)));
}
