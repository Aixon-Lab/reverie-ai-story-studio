/**
 * Context budgeting — the one-third rule.
 *
 * Requirement (docs/brain-system.md §5): the brain may never occupy more than
 * a third of the model's context; whatever it does not use goes to chat
 * history; and when the model changes, the plan re-fits to the new window —
 * shrinking immediately, or growing back up to the new third.
 *
 * Pure math. The actual context-window lookup lives in
 * server/providers/contextLimits.ts.
 */
import { MAX_BRAIN_SHARE } from './defaults';

export interface ContextPlanInput {
  /** Total context window of the *model*, in tokens. */
  modelContext: number;
  /** Tokens reserved for the reply (preset max_tokens). */
  reservedOutput: number;
  /** User's requested share, clamped to [0, 1/3]. */
  share?: number;
  /** Tokens the brain would use if unconstrained (all active memories). */
  brainDemand?: number;
  /** Tokens the fixed prompt scaffolding already consumes. */
  fixedPromptTokens?: number;
  /** Fractional safety margin for tokenizer drift between estimator and model. */
  safetyFraction?: number;
}

export interface ContextPlan {
  modelContext: number;
  reservedOutput: number;
  safetyMargin: number;
  /** Context left for prompt content after output reservation and margin. */
  usable: number;
  /** Hard ceiling the brain may never exceed. */
  brainCap: number;
  /** What the brain actually gets this turn. */
  brainBudget: number;
  /** Everything else — history gets the remainder, always. */
  historyBudget: number;
  /** Effective share of usable context the brain takes this turn. */
  effectiveShare: number;
  /** True when the brain is capped rather than demand-limited. */
  saturated: boolean;
}

const MIN_HISTORY_TOKENS = 512;

/**
 * Build the plan.
 *
 * Note the ordering: the cap is computed from the *model's* usable context, not
 * from what is left after the fixed prompt. That keeps the guarantee stable and
 * legible ("the brain is at most a third of the context") regardless of how
 * heavy the preset happens to be. Fixed prompt cost is then charged to the
 * history side, which is where it belongs.
 */
export function planContext(input: ContextPlanInput): ContextPlan {
  const modelContext = Math.max(2048, Math.floor(input.modelContext || 8192));
  const reservedOutput = Math.max(0, Math.min(Math.floor(input.reservedOutput || 0), Math.floor(modelContext * 0.5)));
  const safetyFraction = input.safetyFraction ?? 0.04;
  const safetyMargin = Math.ceil(modelContext * safetyFraction);

  const usable = Math.max(1024, modelContext - reservedOutput - safetyMargin);

  const share = clamp(input.share ?? MAX_BRAIN_SHARE, 0, MAX_BRAIN_SHARE);
  let brainCap = Math.floor(usable * share);

  // History is never starved: even a fully saturated brain leaves room to talk.
  const fixed = Math.max(0, Math.floor(input.fixedPromptTokens ?? 0));
  const maxBrainGivenHistory = Math.max(0, usable - fixed - MIN_HISTORY_TOKENS);
  brainCap = Math.min(brainCap, maxBrainGivenHistory);

  const demand = Math.max(0, Math.floor(input.brainDemand ?? brainCap));
  const brainBudget = Math.min(brainCap, demand);
  const historyBudget = Math.max(0, usable - brainBudget - fixed);

  return {
    modelContext,
    reservedOutput,
    safetyMargin,
    usable,
    brainCap,
    brainBudget,
    historyBudget,
    effectiveShare: usable > 0 ? brainBudget / usable : 0,
    saturated: brainBudget >= brainCap && demand > brainCap,
  };
}

/**
 * Re-fit an existing plan to a new model. Nothing is destroyed on shrink — the
 * composer simply emits fewer memories — and growth is immediate when the new
 * window is larger.
 */
export function refitPlan(previous: ContextPlan, next: ContextPlanInput): ContextPlan {
  return planContext({
    ...next,
    share: next.share ?? previous.effectiveShare,
  });
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return hi;
  return Math.min(hi, Math.max(lo, n));
}

/** Cheap, dependency-free token estimate (~4 chars/token, punctuation-aware). */
export function estimateBrainTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}
