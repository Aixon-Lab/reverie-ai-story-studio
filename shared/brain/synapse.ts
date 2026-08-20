/**
 * Synaptic dynamics — the fast timescale ACT-R does not model.
 *
 * ACT-R's base-level activation (`activation.ts`) is a *slow* law: it says how
 * available a memory is given its history over days. It is silent about the
 * seconds-to-minutes behaviour that dominates a conversation, where the same
 * synapse is used twice in a row. Two well-established mechanisms fill that gap,
 * and their absence is why recall currently feels like a fresh database query
 * every turn instead of a mind following a thread:
 *
 *   - **Facilitation** (`u`): a trace used again soon after is *easier* to use.
 *     This is priming. It is why one memory pulls the next one out, and why a
 *     character who has just brought something up will keep circling it.
 *   - **Depression** (`R`): each use consumes a finite resource that recovers
 *     over time. This is habituation. It is why a person stops flogging the same
 *     anecdote — and its absence is the single most robotic thing a ranked-recall
 *     system does.
 *
 * Both come from Tsodyks & Markram (1997), ported from Brain-Cog's `STP.py`
 * (`braincog/base/learningrule/STP.py`) — see docs/research/brain-integration-2026.md §B.2 #15.
 * The efficacy of a trace is the product `R·u`, and because our activation
 * equation lives in log space the whole mechanism enters as one additive term
 * that is exactly zero at rest.
 *
 * Two slower quantities live here as well, both from Cerememory's decay engine
 * (`crates/cerememory-decay/src/math.rs`, §B.2 #2–#4):
 *
 *   - **Stability** (`S`): retrieval does not merely raise activation, it makes a
 *     memory structurally harder to lose. `S` grows with diminishing returns and
 *     appears as the time constant of fidelity decay. This is spaced repetition,
 *     and it is why some memories become effectively permanent.
 *   - **Noise** (`N`): accumulated interference, tracked separately from fidelity.
 *     Fidelity says *how accurate* a memory is and licenses hedging; noise says
 *     *how corrupted* it is and drives actual distortion (§B.2 #3, #6).
 *
 * And one homeostatic rule, from Brain-Cog's `BCM.py` (§B.2 #16): a sliding
 * threshold that tracks a node's own recent activity, so potentiation shuts off
 * for a trace that is already dominating. Without it `permanentBoost` grows
 * without bound on whatever gets echoed most, and a long conversation collapses
 * onto the same five memories forever.
 *
 * Everything here is pure and deterministic. Time is always passed in, never read.
 */
import { clamp01 } from './activation';
import { TIME_UNIT_MS } from './defaults';
import type { MemoryKind, MemoryNode } from './types';

// ---------- state ----------

/**
 * Per-node synaptic state. Optional on `MemoryNode`: a brain saved before this
 * existed is seeded at rest by `ensureSynapse`, so it acquires the dynamics
 * rather than being reset.
 */
export interface SynapticState {
  /** `u` — utilisation / facilitation. Rests at `U`, rises toward 1 with close-together use. */
  facilitation: number;
  /** `R` — available resources. Rests at 1, depletes on use, recovers over `tauRecovery`. */
  resources: number;
  /** `S` — stability, in days. The time constant of fidelity decay; grows on retrieval. */
  stability: number;
  /** `N` — accumulated interference noise, 0..1. Drives distortion at compose time. */
  noise: number;
  /** `θ` — BCM sliding threshold: EMA of this node's own recent activity. */
  bcmThreshold: number;
  /**
   * `c` — eligibility trace, 0..1. How recently this memory was live, and
   * therefore how much a *later* outcome should reach back and recolour it.
   *
   * Izhikevich's answer to the distal reward problem, ported from Brain-Cog's
   * `dACC.py` (§B.2 #17). Without it, an event can only ever be coloured by how
   * it felt at the time — but people re-read their own past constantly, and an
   * evening that seemed fine becomes, in hindsight, the evening it started
   * going wrong. That revision is not a new memory; it is the old one changing.
   */
  eligibility: number;
  /** When `facilitation` and `resources` were last relaxed. */
  at: number;
  /**
   * When `fidelity` and `noise` were last advanced.
   *
   * Separate from `at` on purpose. The two clocks run at wildly different
   * speeds — priming relaxes over half an hour, accuracy erodes over weeks — and
   * sharing one timestamp meant whichever mechanism touched it first silently
   * swallowed the other's elapsed time. Retrieval advances both; a maintenance
   * pass with no retrieval advances only this one.
   */
  decayedAt: number;
}

/**
 * Tunables. Defaults chosen so that, at the conversational cadence this engine
 * actually runs at, priming is felt across a turn or two and depletion clears
 * within a scene — see the calibration tests in `synapse.test.ts`.
 */
export interface SynapseParams {
  /** `U` — baseline utilisation. Also the resting facilitation. */
  baseUtilisation: number;
  /** `tau_fac` — facilitation decay, in days. Short: priming is a within-scene effect. */
  tauFacilitation: number;
  /** `tau_rec` — resource recovery, in days. Longer than facilitation, so fatigue outlasts priming. */
  tauRecovery: number;
  /**
   * Fraction of `u` actually consumed per use, 0..1.
   *
   * Tsodyks–Markram uses `R ← R·(1 − u)`, where the same quantity governs both
   * how much is released and how much is spent — physical for vesicles, and far
   * too steep for a memory. At the full rate, three recalls in a scene burn
   * three-quarters of a trace's availability and ordinary emphasis reads as
   * exhaustion. This decouples the two so a topic survives being mentioned a
   * few times and only genuine repetition wears it out.
   */
  depletionRate: number;
  /** Multiplier on the log-efficacy term added to activation. 0 disables STP entirely. */
  efficacyGain: number;
  /** How far below rest efficacy may drag a node, in nats. Depletion must not erase a memory. */
  maxEfficacyPenalty: number;
  /** `b` — stability boost per retrieval, before the `S^(−0.2)` diminishing-returns factor. */
  stabilityBoost: number;
  /** Interference accrued per √day at zero fidelity. */
  interferenceRate: number;
  /** `tau` — BCM threshold EMA window, in samples. */
  bcmWindow: number;
  /** Ceiling on `permanentBoost`, enforced through the BCM gate. */
  maxPermanentBoost: number;
  /** `tau_c` — eligibility decay, in days. How far back an outcome can reach. */
  tauEligibility: number;
}

export const DEFAULT_SYNAPSE: SynapseParams = {
  /**
   * Low, because memory is a *facilitating* synapse, not a depressing one.
   *
   * `R ← R·(1 − u)` means the resource consumed per use is `u` itself, so a high
   * baseline makes the very first recall net-depleting — bringing something up
   * once would make it immediately harder to bring up again, which is the exact
   * opposite of priming. At 0.15 the crossover lands where conversation puts it:
   * the first three mentions warm a memory up, the fourth and beyond wear it out.
   */
  baseUtilisation: 0.15,
  tauFacilitation: 0.02,   // ~30 min — priming fades within a scene
  tauRecovery: 0.35,       // ~8 h — a depleted memory is fresh again next day
  depletionRate: 0.45,     // three mentions warm it, six wear it out
  efficacyGain: 0.6,
  maxEfficacyPenalty: 0.9,
  stabilityBoost: 1.5,
  interferenceRate: 0.06,
  bcmWindow: 12,
  maxPermanentBoost: 4.0,
  // ~2½ days: an outcome reaches back over the scene it grew out of, not over a
  // whole arc. Long enough for "that was where it started", short enough that a
  // bad week does not retroactively poison a year.
  tauEligibility: 2.5,
};

/**
 * Per-kind decay profile (§B.2 #4).
 *
 * A habit and a one-off scene must not forget at the same rate, and until now
 * they did: one global `d` governed everything. `activationScale` multiplies the
 * ACT-R exponent, so `episodic` keeps exactly its previous behaviour (1.0) and
 * only the kinds that *should* outlast episodes are slowed. `fidelityDecay` and
 * `interference` govern the new accuracy curve.
 *
 * Values follow Cerememory's per-store constants, adjusted for our richer kind
 * taxonomy: their five stores map onto our seven kinds, with `identity` and
 * `schema` slower than anything they model because self-definition and belief
 * are the two things our engine explicitly refuses to let go of.
 */
export interface DecayProfile {
  /** Multiplier on ACT-R `d`. Below 1 = persists longer. */
  activationScale: number;
  /** Exponent of the fidelity power law. */
  fidelityDecay: number;
  /** Multiplier on `interferenceRate`. */
  interference: number;
  /** Initial stability in days. */
  stability0: number;
}

const PROFILES: Record<MemoryKind, DecayProfile> = {
  // The reference case: unchanged from the single-`d` behaviour.
  episodic:   { activationScale: 1.00, fidelityDecay: 0.30, interference: 1.00, stability0: 1 },
  // Decontextualised knowledge outlives the episodes it came from.
  semantic:   { activationScale: 0.55, fidelityDecay: 0.15, interference: 0.50, stability0: 4 },
  // A belief is what you have left when the evidence has gone.
  schema:     { activationScale: 0.35, fidelityDecay: 0.10, interference: 0.30, stability0: 8 },
  // Self-defining memories are rehearsed for life (§M.1.3).
  identity:   { activationScale: 0.25, fidelityDecay: 0.08, interference: 0.20, stability0: 12 },
  // Trauma S-reps stay vivid; that is the whole complaint about them (§M.8).
  sensory:    { activationScale: 0.30, fidelityDecay: 0.12, interference: 0.40, stability0: 6 },
  // Working models of people update often and blur between updates.
  relational: { activationScale: 0.70, fidelityDecay: 0.18, interference: 0.60, stability0: 3 },
  // Habits are the slowest thing to lose and the slowest to notice losing.
  procedural: { activationScale: 0.40, fidelityDecay: 0.10, interference: 0.20, stability0: 6 },
};

export function decayProfile(kind: MemoryKind): DecayProfile {
  return PROFILES[kind] ?? PROFILES.episodic;
}

/** Effective ACT-R decay exponent for a node's kind. */
export function effectiveDecay(kind: MemoryKind, baseDecay: number): number {
  return baseDecay * decayProfile(kind).activationScale;
}

// ---------- lifecycle ----------

export function emptySynapse(kind: MemoryKind, now: number, p = DEFAULT_SYNAPSE): SynapticState {
  return {
    facilitation: p.baseUtilisation,
    resources: 1,
    stability: decayProfile(kind).stability0,
    noise: 0,
    bcmThreshold: 0,
    eligibility: 0,
    at: now,
    decayedAt: now,
  };
}

/**
 * Read a node's synaptic state, seeding it at rest if absent.
 *
 * Mutates, deliberately: every caller wants the state attached, and returning a
 * detached copy was how the first draft silently dropped every update.
 */
export function ensureSynapse(node: MemoryNode, now: number, p = DEFAULT_SYNAPSE): SynapticState {
  if (!node.synapse) {
    node.synapse = emptySynapse(node.kind, node.lastRetrievedAt ?? node.encodedAt ?? now, p);
  } else {
    // Seeded by an earlier version of this module: fill in what it lacks rather
    // than resetting a trace that has already lived.
    if (node.synapse.decayedAt === undefined) node.synapse.decayedAt = node.synapse.at ?? now;
    if (node.synapse.eligibility === undefined) node.synapse.eligibility = 0;
  }
  return node.synapse;
}

function daysBetween(now: number, then: number): number {
  return Math.max(0, (now - then) / TIME_UNIT_MS);
}

// ---------- Tsodyks–Markram ----------

/**
 * Advance facilitation and resources to `now` without using the synapse.
 *
 * ```
 *   u(t) = U + (u₀ − U)·e^(−Δt/τ_fac)      facilitation relaxes to baseline
 *   R(t) = 1 − (1 − R₀)·e^(−Δt/τ_rec)      resources recover toward full
 * ```
 *
 * This is the recovery half of Tsodyks–Markram, written as an explicit relaxation
 * rather than their inter-spike-interval form because our "spikes" are irregular
 * and we need the state to be correct at an arbitrary read time, not only at the
 * next use.
 */
export function relaxSynapse(syn: SynapticState, now: number, p = DEFAULT_SYNAPSE): SynapticState {
  const dt = daysBetween(now, syn.at);
  if (dt <= 0) return syn;
  const qu = Math.exp(-dt / Math.max(1e-6, p.tauFacilitation));
  const qr = Math.exp(-dt / Math.max(1e-6, p.tauRecovery));
  syn.facilitation = p.baseUtilisation + (syn.facilitation - p.baseUtilisation) * qu;
  syn.resources = 1 - (1 - syn.resources) * qr;
  // The eligibility window closes on its own schedule — slower than priming,
  // faster than anything structural.
  syn.eligibility = (syn.eligibility ?? 0) * Math.exp(-dt / Math.max(1e-6, p.tauEligibility));
  syn.at = now;
  return syn;
}

/**
 * Mark this memory as live: whatever happens next may reach back and recolour it.
 *
 * Called wherever a memory is encoded or brought to mind. The trace saturates
 * rather than accumulating without bound, because "was this recently on their
 * mind" is a yes-or-no question with a soft edge, not a running total.
 */
export function markEligible(node: MemoryNode, now: number, p = DEFAULT_SYNAPSE): void {
  const syn = ensureSynapse(node, now, p);
  relaxSynapse(syn, now, p);
  syn.eligibility = clamp01(syn.eligibility + 0.6 * (1 - syn.eligibility));
}

/** How live this memory currently is, as of `now`, without advancing it. */
export function eligibilityOf(node: MemoryNode, now: number, p = DEFAULT_SYNAPSE): number {
  const syn = node.synapse;
  if (!syn?.eligibility) return 0;
  const dt = daysBetween(now, syn.at);
  return clamp01(syn.eligibility * Math.exp(-dt / Math.max(1e-6, p.tauEligibility)));
}

/**
 * Use the synapse: the memory has just been retrieved or re-encountered.
 *
 * ```
 *   u ← u + U·(1 − u)        facilitation climbs toward 1
 *   R ← R·(1 − c·u)          the used fraction is consumed, at rate c
 * ```
 *
 * Returns the efficacy `R·u` *at the moment of use*, i.e. before depletion — the
 * quantity Tsodyks–Markram calls the postsynaptic response.
 */
export function useSynapse(node: MemoryNode, now: number, p = DEFAULT_SYNAPSE): number {
  const syn = ensureSynapse(node, now, p);
  relaxSynapse(syn, now, p);
  const uBefore = syn.facilitation;
  const u = uBefore + p.baseUtilisation * (1 - uBefore);
  const efficacy = syn.resources * u;
  syn.facilitation = clamp01(u);
  syn.resources = clamp01(syn.resources * (1 - clamp01(p.depletionRate) * u));
  syn.at = now;
  return efficacy;
}

/**
 * The additive activation term contributed by short-term plasticity, in nats.
 *
 * Zero at rest by construction: `ln(R·u / U)` with `R = 1`, `u = U` is `ln(1)`.
 * That matters more than it looks — it means a brain with no synaptic history
 * behaves *exactly* as it did before this module existed, so the existing
 * calibration of `threshold`, `fadeBelow` and `dormantBelow` still holds and the
 * whole mechanism can be switched off with `efficacyGain: 0`.
 *
 * Pure: reads the state as of `now` without advancing the stored copy, because
 * ranking every node during recall must not itself be a use.
 */
export function stpTerm(node: MemoryNode, now: number, p = DEFAULT_SYNAPSE): number {
  if (p.efficacyGain <= 0) return 0;
  const syn = node.synapse;
  if (!syn) return 0;
  const dt = daysBetween(now, syn.at);
  const u = p.baseUtilisation + (syn.facilitation - p.baseUtilisation) * Math.exp(-dt / Math.max(1e-6, p.tauFacilitation));
  const r = 1 - (1 - syn.resources) * Math.exp(-dt / Math.max(1e-6, p.tauRecovery));
  const rest = Math.max(1e-6, p.baseUtilisation);
  const ratio = Math.max(1e-6, (r * u) / rest);
  const term = p.efficacyGain * Math.log(ratio);
  // Depletion may make a memory hard to reach for a while; it may never delete it.
  return Math.max(-p.maxEfficacyPenalty, term);
}

// ---------- stability and fidelity (Cerememory) ----------

/**
 * `S ← S·(1 + b·S^(−0.2))` — stability grows on retrieval, with diminishing returns.
 *
 * The exponent is what makes this spaced repetition rather than runaway growth:
 * the hundredth recall of something adds far less durability than the second.
 */
export function boostStability(stability: number, p = DEFAULT_SYNAPSE): number {
  const s = Math.max(0.05, stability);
  return s * (1 + p.stabilityBoost * Math.pow(s, -0.2));
}

/**
 * Advance fidelity and noise to `now`.
 *
 * ```
 *   F ← F·(1 + Δt/S_eff)^(−d_F)              S_eff = S·(1 + ½·arousal)
 *   N ← N + r·√Δt·(1 − F)
 * ```
 *
 * Arousal enters through stability rather than as Cerememory's multiplicative
 * `E_mod`, which could raise fidelity above where it started. Emotion should slow
 * the loss of accuracy, never manufacture accuracy that was never there.
 *
 * Noise grows as fidelity falls, so a memory does not merely become *less sure* —
 * it becomes *actively corrupted*, which is what the composer needs in order to
 * produce a confident error rather than a hedge (§B.2 #6).
 */
export function advanceFidelity(
  node: MemoryNode,
  now: number,
  p = DEFAULT_SYNAPSE,
  opts: { interferenceScale?: number } = {},
): void {
  const syn = ensureSynapse(node, now, p);
  const dt = daysBetween(now, syn.decayedAt);
  if (dt <= 0) return;
  syn.decayedAt = now;

  const profile = decayProfile(node.kind);
  const arousal = clamp01(node.affect?.arousal ?? 0);
  const stabilityEff = Math.max(0.05, syn.stability * (1 + 0.5 * arousal));

  node.fidelity = clamp01(node.fidelity * Math.pow(1 + dt / stabilityEff, -profile.fidelityDecay));

  const rate = p.interferenceRate * profile.interference * (opts.interferenceScale ?? 1);
  syn.noise = clamp01(syn.noise + rate * Math.sqrt(dt) * (1 - node.fidelity));
}

/**
 * How corrupted this memory is right now, 0..1.
 *
 * Combines tracked interference with the accuracy shortfall, because both make a
 * recollection wrong in the same way and the composer only needs one number.
 * Pinned memories are exempt: the user has asserted this one is correct.
 */
export function corruptionOf(node: MemoryNode): number {
  if (node.pinned) return 0;
  const noise = clamp01(node.synapse?.noise ?? 0);
  const shortfall = clamp01(1 - node.fidelity);
  return clamp01(Math.max(noise, shortfall * 0.8) * 0.7 + Math.min(noise, shortfall) * 0.3);
}

// ---------- BCM homeostasis ----------

/**
 * Sliding-threshold potentiation gate (Brain-Cog `BCM.py`).
 *
 * ```
 *   θ ← ((τ − 1)·θ + s) / τ          the threshold chases recent activity
 *   Δ ∝ s·(s − θ)                     potentiate above it, depress below
 * ```
 *
 * `s` is the activity of this sample, 0..1. The consequence is the point: a trace
 * that has been firing constantly raises its own bar until further potentiation
 * stops, so `permanentBoost` cannot run away on whatever happens to be echoed
 * most often. Homeostasis, not reward.
 *
 * Returns the signed potentiation factor; the caller scales its own increment by
 * it. Updating `θ` is the side effect and has to happen even when the factor is
 * negative, or the threshold never comes back down.
 */
export function bcmPotentiation(node: MemoryNode, activity: number, now: number, p = DEFAULT_SYNAPSE): number {
  const syn = ensureSynapse(node, now, p);
  const s = clamp01(activity);
  const tau = Math.max(2, p.bcmWindow);
  const theta = syn.bcmThreshold;
  syn.bcmThreshold = ((tau - 1) * theta + s) / tau;
  return s * (s - theta);
}

/**
 * Grow `permanentBoost` through the BCM gate.
 *
 * The increment a caller asks for is what it *would* apply with no homeostasis;
 * what lands is scaled by how far this node's activity sits above its own running
 * average, and hard-capped. A memory the character keeps returning to still
 * strengthens — it just stops strengthening without limit.
 */
export function potentiate(node: MemoryNode, increment: number, now: number, p = DEFAULT_SYNAPSE): number {
  const factor = bcmPotentiation(node, 1, now, p);
  // `factor` is ≤ 0 once this node is already the dominant one; it never subtracts,
  // because forgetting has its own machinery and this gate is only about growth.
  const applied = increment * Math.max(0, factor);
  node.permanentBoost = Math.min(p.maxPermanentBoost, (node.permanentBoost ?? 0) + applied);
  return applied;
}

/**
 * Record a retrieval: use the synapse, stabilise, and let the trace settle.
 *
 * The single entry point retrieval should call, so the three coupled quantities
 * can never be advanced out of step.
 */
/**
 * Predict when this memory will slip out of reach if nobody brings it up
 * (`decay_forecast`, §B.2 #11).
 *
 * The ACT-R curve is monotonic in time, so a short binary search on a
 * cloned timestamp window is exact enough for a UI readout and cheap
 * enough to run on every node of the graph. Pinned, identity and trauma
 * traces are exempt: they do not fade on this machinery.
 */
export interface DecayForecast {
  /** ms from `now` until the node would become `faded`. Null = it will not. */
  fadeInMs: number | null;
  /** ms from `now` until the node would become `dormant`. Null = it will not. */
  dormantInMs: number | null;
  daysToFade: number | null;
  daysToDormant: number | null;
  /** One line for the inspector. */
  label: string;
}

export function forecastDecay(
  node: MemoryNode,
  now: number,
  p: { decay: number; fadeBelow: number; dormantBelow: number },
): DecayForecast {
  const exempt = node.pinned || node.kind === 'identity' || node.kind === 'sensory' || node.kind === 'schema';
  if (exempt) {
    return {
      fadeInMs: null,
      dormantInMs: null,
      daysToFade: null,
      daysToDormant: null,
      label: node.kind === 'schema'
        ? 'A belief does not fade on its own — it fades when its evidence does.'
        : 'This one does not slip away on its own.',
    };
  }

  const suppressed = node.suppressed ?? 0;
  // Local walker — this file cannot import `activation.ts` (it already
  // imports us for `effectiveDecay`). The two agree on the exact form.
  const strengthNow = approxBase(node, now, p.decay) - suppressed;

  if (strengthNow < p.dormantBelow) {
    return {
      fadeInMs: 0,
      dormantInMs: 0,
      daysToFade: 0,
      daysToDormant: 0,
      label: 'Already out of reach.',
    };
  }

  const fadeInMs = strengthNow < p.fadeBelow
    ? 0
    : searchCrossing(node, now, p.decay, p.fadeBelow + suppressed);
  const dormantInMs = searchCrossing(node, now, p.decay, p.dormantBelow + suppressed);

  const daysToFade = fadeInMs === null ? null : fadeInMs / TIME_UNIT_MS;
  const daysToDormant = dormantInMs === null ? null : dormantInMs / TIME_UNIT_MS;

  return {
    fadeInMs,
    dormantInMs,
    daysToFade,
    daysToDormant,
    label: formatForecast(daysToFade, daysToDormant, node.status),
  };
}

function approxBase(node: MemoryNode, at: number, decay: number): number {
  const d = effectiveDecay(node.kind, decay);
  const boost = node.permanentBoost ?? 0;
  const uses = node.uses?.length ? node.uses : [node.encodedAt];
  const trimmed = node.useCount > uses.length;
  const age = (then: number) => Math.max(0.01, (at - then) / TIME_UNIT_MS);
  if (trimmed) {
    const life = age(node.encodedAt);
    const n = Math.max(1, node.useCount);
    return Math.log(n / (1 - d)) - d * Math.log(life) + boost;
  }
  let sum = 0;
  for (const t of uses) sum += Math.pow(age(t), -d);
  if (sum <= 0) return -Infinity;
  return Math.log(sum) + boost;
}

/** First future offset (ms) at which baseLevel drops below `threshold`. */
function searchCrossing(node: MemoryNode, now: number, decay: number, threshold: number): number | null {
  if (approxBase(node, now, decay) < threshold) return 0;
  // Ten years is "effectively permanent" for a readout.
  const horizon = 10 * 365 * TIME_UNIT_MS;
  if (approxBase(node, now + horizon, decay) >= threshold) return null;
  let lo = 0;
  let hi = horizon;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (approxBase(node, now + mid, decay) >= threshold) lo = mid;
    else hi = mid;
  }
  return hi;
}

function formatForecast(
  daysToFade: number | null,
  daysToDormant: number | null,
  status: MemoryNode['status'],
): string {
  if (status === 'dormant') return 'Already out of reach.';
  if (status === 'faded') {
    if (daysToDormant === null) return 'Faded, but will stay recallable with a strong cue.';
    if (daysToDormant < 1) return 'Faded — will slip out of reach within a day if not brought up.';
    return `Faded — will slip out of reach in about ${describeDays(daysToDormant)} if not brought up.`;
  }
  if (daysToFade === null) return 'Will stay available for years if left alone.';
  if (daysToFade < 1) return 'Will fade within a day if not brought up.';
  return `Will fade in about ${describeDays(daysToFade)} if not brought up.`;
}

function describeDays(days: number): string {
  if (days < 2) return 'a day';
  if (days < 11) return `${Math.round(days)} days`;
  if (days < 45) return `${Math.round(days / 7)} weeks`;
  if (days < 400) return `${Math.round(days / 30)} months`;
  return `${Math.round(days / 365)} years`;
}

export function recordSynapticUse(node: MemoryNode, now: number, p = DEFAULT_SYNAPSE): void {
  advanceFidelity(node, now, p);
  const syn = ensureSynapse(node, now, p);
  syn.stability = boostStability(syn.stability, p);
  // Retrieval also *cleans* a trace slightly: reconsolidation rewrites it in a
  // currently-coherent form, which is why rehearsed memories are smooth and wrong
  // rather than rough and wrong.
  syn.noise = clamp01(syn.noise * 0.94);
  useSynapse(node, now, p);
  // Anything brought to mind is now in the window a later outcome can reach.
  markEligible(node, now, p);
}
