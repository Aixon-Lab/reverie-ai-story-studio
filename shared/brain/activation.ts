/**
 * Memory strength and activation — the formal core.
 *
 * Direct implementation of the ACT-R declarative memory equations
 * (research dossier §4), extended with emotional modulation (§5.1) and the
 * fuzzy-trace verbatim/gist split (§7.3).
 *
 *   B_i = ln( Σ_k t_k^(−d) ) + β_i                      base-level learning
 *   A_i = B_i + Σ_j W_j·S_ji + Σ_l P·M_li + ε           total activation
 *   S_ji = S − ln(fan_j)                                associative strength
 *   P_i = 1 / (1 + e^(−(A_i − τ)/s))                    recall probability
 *   T_i = F · e^(−A_i)                                  retrieval latency
 *
 * Everything here is pure. Noise is injected through an explicit `rng` so tests
 * are deterministic.
 */
import { MIN_AGE, TIME_UNIT_MS } from './defaults';
import { effectiveDecay } from './synapse';
import type { Affect, BrainParams, MemoryNode } from './types';

/** Age in decay time units (days), floored so t=0 cannot blow up. */
export function ageIn(now: number, then: number): number {
  return Math.max(MIN_AGE, (now - then) / TIME_UNIT_MS);
}

/**
 * Base-level activation: recency × frequency over independently decaying traces.
 *
 * Exact form while the trace history is small enough to keep; the ACT-R
 * optimised approximation `ln(n/(1−d)) − d·ln(L)` once it has been capped.
 * Both produce the power-law forgetting curve and Jost's law (§3.1, §4.1).
 */
export function baseLevel(node: MemoryNode, now: number, p: BrainParams): number {
  /**
   * The exponent is per-kind, not global (§B.2 #4).
   *
   * `episodic` scales by exactly 1.0, so the reference case — and with it every
   * threshold in `DEFAULT_PARAMS` — is unchanged. Only the kinds that ought to
   * outlast episodes are slowed: a belief a character has held for months should
   * not fade on the same curve as what somebody said on Tuesday.
   */
  const d = effectiveDecay(node.kind, p.decay);
  const boost = node.permanentBoost ?? 0;

  const uses = node.uses?.length ? node.uses : [node.encodedAt];
  const trimmed = node.useCount > uses.length;

  if (trimmed) {
    // Optimised approximation over the whole lifetime — O(1) for hot nodes.
    const life = ageIn(now, node.encodedAt);
    const n = Math.max(1, node.useCount);
    const approx = Math.log(n / (1 - d)) - d * Math.log(life);
    return approx + boost;
  }

  let sum = 0;
  for (const t of uses) {
    sum += Math.pow(ageIn(now, t), -d);
  }
  if (sum <= 0) return -Infinity;
  return Math.log(sum) + boost;
}

/**
 * Associative strength of cue j toward a node: S − ln(fan_j).
 *
 * A cue linked to everything discriminates nothing — the fan effect, which is
 * this engine's interference model (§4.3).
 */
export function assocStrength(fan: number, p: BrainParams): number {
  return p.maxAssoc - Math.log(Math.max(1, fan));
}

/** Logistic noise with scale s (ACT-R ε; variance π²s²/3). */
export function logisticNoise(s: number, rng: () => number = Math.random): number {
  if (s <= 0) return 0;
  // Inverse CDF of the logistic distribution.
  const u = Math.min(1 - 1e-9, Math.max(1e-9, rng()));
  return s * Math.log(u / (1 - u));
}

/** P(recall) = 1 / (1 + e^(−(A − τ)/s)) (§4.4). */
export function recallProbability(activation: number, p: BrainParams): number {
  if (!Number.isFinite(activation)) return 0;
  const s = Math.max(1e-6, p.noise);
  return 1 / (1 + Math.exp(-(activation - p.threshold) / s));
}

/** Retrieval latency in seconds: T = F·e^(−A). Used for UI pacing, not gating. */
export function retrievalLatency(activation: number, latencyFactor = 0.35): number {
  if (!Number.isFinite(activation)) return Infinity;
  return latencyFactor * Math.exp(-activation);
}

/**
 * β_i — the permanent boost emotion grants a trace.
 *
 * Arousal is the primary consolidation modulator (§5.1); extremity of valence
 * adds a smaller contribution (§5.2). Identity-relevant events get a further
 * lift because self-defining memories are rehearsed and privileged (§1.3).
 */
export function emotionalBoost(
  affect: Affect,
  p: BrainParams,
  opts: { identityRelevant?: boolean; goalRelevance?: number } = {},
): number {
  const arousal = clamp01(affect.arousal);
  const extremity = Math.min(1, Math.abs(affect.valence));
  let boost = p.arousalGain * arousal * (1 + p.valenceGain * extremity);
  if (opts.goalRelevance) boost += 0.4 * clamp01(opts.goalRelevance);
  if (opts.identityRelevant) boost += 0.9;
  return boost;
}

/**
 * Verbatim survival: V(t) = (1 + h·t)^(−f_v), with f_v well above the gist
 * decay so exact wording is lost long before meaning (§7.3).
 */
export function verbatimStrength(node: MemoryNode, now: number, p: BrainParams): number {
  const t = ageIn(now, node.lastRetrievedAt ?? node.encodedAt);
  // Emotional vividness protects surface detail somewhat — the flashbulb effect.
  const protection = 1 + 1.2 * clamp01(node.affect?.arousal ?? 0);
  return Math.pow(1 + t / protection, -p.verbatimDecay);
}

/**
 * Fidelity decay per reconstruction. Recall is reconstructive: each retrieval
 * risks schema-driven drift, while confidence barely moves (§5.3, §7.3).
 */
export function degradeFidelity(node: MemoryNode, amount = 0.03): number {
  // Well-bound, frequently rehearsed memories drift more slowly.
  const resistance = 0.5 + 0.5 * clamp01(node.contextBinding);
  return clamp01(node.fidelity - amount / resistance);
}

/** Mood-congruent retrieval bonus: sad moods surface sad memories (§5.5). */
export function moodCongruence(node: MemoryNode, mood: Affect | undefined, weight = 0.35): number {
  if (!mood) return 0;
  const dv = Math.abs((node.affect?.valence ?? 0) - mood.valence) / 2; // 0..1
  return weight * (1 - 2 * dv); // +weight when identical, −weight when opposite
}

/**
 * Similarity for partial matching, in 0..1. Token overlap over the union
 * (Jaccard) with a small bonus for shared rare tokens. Deliberately simple and
 * deterministic — no embeddings, no network calls, works offline.
 */
export function similarity(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 ? inter / union : 0;
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'is', 'was', 'were', 'be', 'been', 'are', 'am', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'they', 'we', 'me', 'him', 'her', 'them', 'us',
  'my', 'your', 'his', 'their', 'our', 'as', 'by', 'from', 'so', 'if', 'then', 'than',
  'not', 'no', 'do', 'did', 'does', 'have', 'has', 'had', 'will', 'would', 'can',
  'could', 'should', 'about', 'into', 'over', 'up', 'down', 'out', 'just', 'very',
]);

export function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text || '').toLowerCase().split(/[^a-z0-9']+/)) {
    const t = raw.replace(/^'+|'+$/g, '');
    if (t.length < 3 || STOP.has(t)) continue;
    out.add(t);
  }
  return out;
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export function clampSigned(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(-1, n)) : 0;
}

/**
 * Record an encounter with a memory: another independently decaying trace.
 * This is what produces the spacing effect and the testing effect (§3.3, §7.4)
 * without any special-case code.
 */
export function addTrace(node: MemoryNode, at: number, p: BrainParams): void {
  node.uses = node.uses ?? [];
  node.uses.push(at);
  node.useCount = (node.useCount ?? node.uses.length - 1) + 1;
  if (node.uses.length > p.maxTraceHistory) {
    // Keep the most recent window; the approximation covers the rest.
    node.uses = node.uses.slice(-Math.floor(p.maxTraceHistory / 2));
  }
  node.lastRetrievedAt = at;
}
