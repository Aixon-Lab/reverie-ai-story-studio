/**
 * Engram maturation — a memory is not finished the moment it is made.
 *
 * Systems consolidation takes time. A trace laid down an hour ago is not yet the
 * memory it will become: it is fragile, poorly integrated, and — the part that
 * matters here — *not yet the thing that comes to mind unbidden*. This is why a
 * concussion erases the hour before it and nothing earlier, and it is why a
 * person who has just been told something enormous cannot reason about it
 * fluently for a while. "It hasn't sunk in yet" is a real cognitive state and
 * nothing in this engine had it.
 *
 * ## Why this makes recall *better*, not just more faithful
 *
 * Without maturation, freshly encoded nodes dominate every recall: `baseLevel`
 * is recency-weighted, so the newest memory is the most activated thing in the
 * graph almost by construction. But the newest events are **already in the
 * prompt** — they are the last few messages of chat history, verbatim. Spending
 * the memory budget on them buys nothing and crowds out the older material that
 * only the brain can supply.
 *
 * So maturation is subtractive in the useful direction: it tilts recall away
 * from what the model can already see and toward what it cannot. The character
 * remembers the last five minutes through the transcript and through working
 * memory (`working.ts`), exactly as a person does, rather than through
 * long-term retrieval.
 *
 * ## The clock is passes, not wall-time
 *
 * Story time and wall-clock time are not the same thing here — six messages can
 * cover three weeks, and a user may play for twenty minutes a day. Measuring
 * maturity in *consolidation passes* sidesteps both problems: one pass is one
 * scene's worth of living, which is the unit the rest of the psyche already
 * thinks in. A node that has been through two passes is settled.
 *
 * ## What never waits
 *
 * A flashbulb memory is available immediately, and a flashback starts the same
 * night — the whole clinical point of an intrusive trace is that it arrives
 * before it has been integrated. Those are exempt, along with everything else
 * the engine already privileges.
 *
 * Pure. No clock, no rng.
 */
import { clamp01 } from './activation';
import type { BrainState, MemoryNode } from './types';

/**
 * Activation withheld from a brand-new trace.
 *
 * Sized against τ = −1.0 and s = 0.25: enough to lose a close contest with an
 * established memory, never enough to push an ordinary event below the floor on
 * its own. A fresh memory is *outranked*, not unavailable.
 */
export const MAX_WITHHELD = 0.5;

/**
 * Passes at which a trace is half settled.
 *
 * `stats.updates` is incremented at the *end* of a pass, so a node encoded during
 * pass N is first recalled at N+1 — one pass old, never zero. Placing the
 * half-life at 1.5 therefore puts the steep part of the curve exactly where a
 * memory's first two recalls fall, and leaves it effectively settled by the
 * third. At the shipped cadence of six messages per pass that is roughly
 * eighteen messages, which reads as a couple of scenes.
 */
export const HALF_LIFE_PASSES = 1.5;

/** Above this, a trace is settled and pays exactly nothing. */
const SETTLED = 0.995;

/** Steepness of the sigmoid. Lower is sharper. */
const K = 0.62;

/**
 * A permanent boost at or above this is a life-marking event.
 *
 * At the shipped `arousalGain` of 1.6 an ordinary beat earns ~0.7 and the trauma
 * threshold earns ~1.9, so this selects the events that would be remembered
 * instantly and forever — which is exactly the flashbulb exemption.
 */
export const FLASHBULB_BOOST = 1.8;

/** Traces that are retrievable the moment they exist. */
export function maturesInstantly(node: MemoryNode): boolean {
  return node.kind === 'identity'
    || node.kind === 'sensory'
    || node.intrusive === true
    || node.pinned === true
    || (node.permanentBoost ?? 0) >= FLASHBULB_BOOST;
}

/**
 * 0..1 — how consolidated this trace is.
 *
 * A node written before this field existed has no `encodedAtPass` and is treated
 * as fully mature, which is correct: it has been sitting on disk through every
 * pass since. That default is what makes the mechanism safe to add to brains
 * that already exist.
 */
export function maturity(node: MemoryNode, brain: BrainState): number {
  if (maturesInstantly(node)) return 1;
  const encodedAt = node.encodedAtPass;
  if (encodedAt === undefined) return 1;
  const passes = Math.max(0, (brain.stats.updates ?? 0) - encodedAt);
  return clamp01(1 / (1 + Math.exp(-(passes - HALF_LIFE_PASSES) / K)));
}

/**
 * Activation withheld from a trace that has not settled yet — always ≤ 0.
 *
 * The `SETTLED` cutoff makes the term reach *exactly* zero rather than trailing
 * the sigmoid's asymptote forever. That matters more than it looks: without it
 * every memory in every brain would carry a small permanent penalty, and every
 * threshold the engine was calibrated against would quietly shift.
 */
export function maturationTerm(node: MemoryNode, brain: BrainState): number {
  const m = maturity(node, brain);
  if (m >= SETTLED) return 0;
  return -MAX_WITHHELD * clamp01(1 - m);
}
