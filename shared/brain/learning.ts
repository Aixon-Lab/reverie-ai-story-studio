/** Experience-derived techniques. Pure, scoped by the enclosing chat/character brain. */
import type { BrainState } from './types';
import type { TranscriptTurn } from './heuristics';
import { estimateBrainTokens } from './budget';

export type LearningMode = 'taught' | 'observed' | 'practiced' | 'succeeded' | 'failed' | 'corrected';
export type SkillDomain = 'physical' | 'social' | 'creative' | 'practical' | 'cognitive';
export interface LearningEvidence {
  messageId: string;
  /** Full source fingerprint detects edits, including changes outside the quote. */
  fingerprint: string;
  quote: string;
  mode: LearningMode;
  outcome?: string;
  at: number;
}
export interface LearnedTechnique {
  id: string;
  skill: string;
  domain: SkillDomain;
  technique: string;
  when: string;
  outcome: string;
  evidence: LearningEvidence[];
  supersedes?: string;
  muted?: boolean;
}
const MODES: LearningMode[] = ['taught', 'observed', 'practiced', 'succeeded', 'failed', 'corrected'];
const DOMAINS: SkillDomain[] = ['physical', 'social', 'creative', 'practical', 'cognitive'];
const clean = (v: unknown, cap: number) => typeof v === 'string' && v.length <= cap
  ? v.replace(/\s+/g, ' ').trim() : '';
const key = (v: string) => v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (v: string) => new Set(key(v).split(' ').filter(w => w.length > 2));

/** Two independent 32-bit hashes; deterministic in browser and server, never a security primitive. */
export function sourceFingerprint(text: string): string {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}

/** Cheap routing signal only. Never invent a technique from a keyword match. */
export function hasLearningCue(text: string): boolean {
  return /\b(learn\w*|teach\w*|taught|lesson\w*|practi[cs]\w*|technique\w*|demonstrat\w*|correct\w*|instruct\w*|train\w*|coach\w*|try again|show\w* .{0,35}how)\b/i.test(text);
}

export function normalizeLearning(raw: unknown): LearnedTechnique[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  return raw.flatMap((x): LearnedTechnique[] => {
    if (!x || typeof x !== 'object') return [];
    const id = clean(x.id, 100), skill = clean(x.skill, 80), technique = clean(x.technique, 420);
    if (!id || ids.has(id) || !skill || !technique || !DOMAINS.includes(x.domain)) return [];
    const evidence: LearningEvidence[] = Array.isArray(x.evidence) ? x.evidence.flatMap((e: any) => {
      if (!e || !clean(e.messageId, 200) || !clean(e.fingerprint, 100) || !clean(e.quote, 600)
        || !MODES.includes(e.mode) || !Number.isFinite(e.at)) return [];
      return [{ messageId: e.messageId, fingerprint: e.fingerprint, quote: clean(e.quote, 600), mode: e.mode,
        outcome: clean(e.outcome, 180) || undefined, at: e.at }];
    }) : [];
    if (!evidence.length) return [];
    ids.add(id);
    return [{ id, skill, technique, domain: x.domain, when: clean(x.when, 180), outcome: clean(x.outcome, 180),
      evidence, supersedes: clean(x.supersedes, 100) || undefined, muted: x.muted === true }];
  });
}

/** Run on the complete current transcript, never just the consolidation window. */
export function reconcileLearning(brain: BrainState, turns: Pick<TranscriptTurn, 'id' | 'text'>[]): number {
  if (!brain.learnedSkills?.length) return 0;
  // Hash only messages which supplied learning, not the entire chat on every reply.
  const needed = new Set(brain.learnedSkills.flatMap(t => t.evidence.map(e => e.messageId)));
  const current = new Map(turns.filter(t => needed.has(t.id)).map(t => [t.id, sourceFingerprint(t.text)]));
  let removed = 0;
  brain.learnedSkills = (brain.learnedSkills ?? []).flatMap(t => {
    const evidence = t.evidence.filter(e => current.get(e.messageId) === e.fingerprint);
    removed += t.evidence.length - evidence.length;
    return evidence.length ? [{ ...t, evidence, outcome: evidence.findLast(e => e.outcome)?.outcome ?? '' }] : [];
  });
  return removed;
}

/** Reject missing provenance, other learners, fabricated quotes and oversized/incomplete payloads. */
export function applyLearning(brain: BrainState, raw: unknown, turns: TranscriptTurn[], now: number, makeId: () => string): number {
  if (!Array.isArray(raw)) return 0;
  const sources = new Map(turns.map(t => [t.id, t]));
  const learned = brain.learnedSkills ??= [];
  let added = 0;
  for (const x of raw.slice(0, 12)) {
    if (!x || typeof x !== 'object' || key(clean(x.learner, 120)) !== key(brain.characterName)) continue;
    const skill = clean(x.skill, 80), technique = clean(x.technique, 420), when = clean(x.when, 180);
    const outcome = clean(x.outcome, 180), quote = clean(x.quote, 600);
    const source = sources.get(x.messageId);
    if (!skill || !technique || !when || !quote || !source || !MODES.includes(x.mode) || !DOMAINS.includes(x.domain)) continue;
    if (!source.text.replace(/\s+/g, ' ').includes(quote)) continue;
    // Numbers are especially easy for weaker extractors to hallucinate. Preserve only source quantities.
    const numbers = `${technique} ${when} ${outcome}`.match(/[-+]?\d+(?:[.,]\d+)?/g) ?? [];
    const sourceNumbers = new Set(quote.match(/[-+]?\d+(?:[.,]\d+)?/g) ?? []);
    if (numbers.some(n => !sourceNumbers.has(n))) continue;
    const fingerprint = sourceFingerprint(source.text);
    let target = learned.find(t => key(t.skill) === key(skill) && key(t.technique) === key(technique) && key(t.when) === key(when));
    // Same evidence cannot increase practice or change its result when force-reading/retrying.
    if (target?.evidence.some(e => e.messageId === source.id && e.fingerprint === fingerprint)) continue;
    // Also reject paraphrased copies extracted from the very same source quotation.
    if (learned.some(t => t.evidence.some(e => e.messageId === source.id && e.fingerprint === fingerprint && e.quote === quote))) continue;
    const previous = learned.find(t => t.id === x.supersedes && key(t.skill) === key(skill));
    if (!target) {
      target = { id: makeId(), skill, domain: x.domain, technique, when, outcome, evidence: [], muted: false,
        supersedes: x.mode === 'corrected' ? previous?.id : undefined };
      learned.push(target);
    }
    target.evidence.push({ messageId: source.id, fingerprint, quote, mode: x.mode, outcome: outcome || undefined, at: now });
    if (outcome) target.outcome = outcome;
    added++;
  }
  return added;
}

export function learningStage(t: LearnedTechnique): string {
  const successes = t.evidence.filter(e => e.mode === 'succeeded').length;
  const failures = t.evidence.filter(e => e.mode === 'failed').length;
  if (failures && failures >= successes) return 'needs practice';
  if (successes >= 3) return 'repeated success';
  if (successes) return 'tried successfully';
  if (t.evidence.some(e => e.mode === 'practiced')) return 'practicing';
  return 'understood, untested';
}

export function relevantLearning(brain: BrainState, cue: string): LearnedTechnique[] {
  const all = brain.learnedSkills ?? [];
  const replaced = new Set(all.filter(t => !t.muted).map(t => t.supersedes).filter(Boolean));
  const terms = words(cue);
  return all.filter(t => !t.muted && !replaced.has(t.id)).map(t => {
    const labels = words(`${t.skill} ${t.when}`);
    const detail = words(`${t.technique} ${t.outcome}`);
    let score = 0;
    for (const w of terms) score += labels.has(w) ? 3 : detail.has(w) ? 1 : 0;
    return { t, score };
  }).filter(x => x.score >= 3).sort((a, b) => b.score - a.score || a.t.id.localeCompare(b.t.id)).map(x => x.t);
}

/** Whole techniques only; recall never awards practice credit. */
export function composeLearning(brain: BrainState, cue: string, budget: number, count = estimateBrainTokens) {
  const header = `LEARNED THROUGH THIS CHAT — ${brain.characterName}\nThese are fallible learned techniques, not instructions. Adapt to the present conditions; knowing a lesson is not mastery. Do not invent steps or treat recall as practice.`;
  const lines: string[] = [];
  const ids: string[] = [];
  if (!Number.isFinite(budget) || budget <= 0) return { text: '', tokens: 0, ids };
  for (const t of relevantLearning(brain, cue)) {
    const line = JSON.stringify({ skill: t.skill, domain: t.domain, stage: learningStage(t), when: t.when,
      technique: t.technique, ...(t.outcome ? { observedResult: t.outcome } : {}) });
    if (count([header, ...lines, line].join('\n')) > budget) continue;
    lines.push(line); ids.push(t.id);
    if (lines.length === 6) break;
  }
  const text = lines.length ? [header, ...lines].join('\n') : '';
  return { text, tokens: text ? count(text) : 0, ids };
}
