/**
 * Recall: cue → spreading activation → ranked memories.
 *
 * A_i = B_i + Σ_j W_j·S_ji + Σ_l P·M_li + ε  (§4.2), plus mood congruence
 * (§5.5), minus retrieval-induced suppression (§7.4), plus an involuntary
 * intrusion pass for trauma S-reps that bypasses the threshold entirely (§8).
 *
 * Pure. Noise comes from an injected rng so tests are reproducible.
 */
import {
  addTrace, assocStrength, baseLevel, clamp01, degradeFidelity, logisticNoise,
  moodCongruence, recallProbability, similarity, tokenSet,
} from './activation';
import { buildIndex, competitorsOf, neighbors, nodeCues, type BrainIndex } from './graph';
import {
  BASELINE, contrastTerm, gainsOf, modulatorsOf,
  type CognitivePhase, type ModulatoryGains,
} from './neuromodulation';
import { reconstructOnRecall } from './reconstruction';
import { DEFAULT_SYNAPSE, ensureSynapse, recordSynapticUse, relaxSynapse, stpTerm } from './synapse';
import type {
  ActivationBreakdown, BrainParams, BrainState, MemoryNode, RecallCue, RecallHit, RecallResult,
} from './types';

export interface RecallOptions {
  /** Stop after this many hits (the budget layer usually decides instead). */
  limit?: number;
  /** Ignore the retrieval threshold — used by the inspector / debug recall. */
  includeBelowThreshold?: boolean;
  /** Apply the side effects of retrieval (trace, RIF, fidelity drift). Default false. */
  mutate?: boolean;
  rng?: () => number;
  /** Prebuilt index, when the caller already has one. */
  index?: BrainIndex;
  /**
   * What the mind is doing. Only reaches the modulators, but it matters:
   * an idle pass should not recall the way an in-scene turn does.
   */
  phase?: CognitivePhase;
  /** Override the derived gains — tests pin these to baseline. */
  gains?: ModulatoryGains;
}

/** Turn a cue into weighted source-activation terms (§4.2 W_j). */
function cueTerms(cue: RecallCue): { token: string; weight: number }[] {
  const terms = new Map<string, number>();
  const bump = (t: string, w: number) => terms.set(t, Math.max(terms.get(t) ?? 0, w));

  // Actors present are the strongest contextual cue in a conversation.
  for (const a of cue.actors ?? []) bump(`@${a.toLowerCase()}`, 1.0);
  if (cue.place) bump(`#${cue.place.toLowerCase()}`, 0.8);
  for (const k of cue.keywords ?? []) bump(k.toLowerCase(), 0.7);
  // Active goals act as standing cues — the working self gates retrieval (§1.2).
  for (const g of cue.goals ?? []) for (const t of tokenSet(g)) bump(t, 0.55);
  for (const t of tokenSet(cue.text)) bump(t, 0.5);

  const list = [...terms.entries()].map(([token, weight]) => ({ token, weight }));
  // Normalise so total source activation is W regardless of how wordy the cue is.
  const total = list.reduce((s, x) => s + x.weight, 0) || 1;
  return list.map((x) => ({ token: x.token, weight: x.weight / total }));
}

export function activationOf(
  node: MemoryNode,
  cue: RecallCue,
  brain: BrainState,
  index: BrainIndex,
  rng: () => number = Math.random,
  /**
   * Global neuromodulatory gains. Derived once per recall by the caller rather
   * than per node, because they are a property of the character's state and not
   * of the memory being scored.
   */
  gains: ModulatoryGains = gainsOf(BASELINE),
): ActivationBreakdown {
  const p = brain.config.params;
  const base = baseLevel(node, cue.now, p);

  // --- spreading activation from cue elements this node carries ---
  const cues = new Set(nodeCues(node));
  let spreading = 0;
  for (const term of cueTerms(cue)) {
    if (!cues.has(term.token)) continue;
    const fan = index.fan.get(term.token) ?? 1;
    spreading += p.sourceActivation * term.weight * assocStrength(fan, p);
  }

  // --- one hop of graph spread: neighbours of directly cued nodes lend support ---
  let indirect = 0;
  for (const n of neighbors(index, node.id)) {
    const other = brain.nodes[n.id];
    if (!other || other.status === 'dormant') continue;
    const otherCues = new Set(nodeCues(other));
    let touched = 0;
    for (const term of cueTerms(cue)) if (otherCues.has(term.token)) touched += term.weight;
    if (touched > 0) indirect += 0.45 * n.weight * touched * p.maxAssoc;
  }
  spreading += indirect;

  // --- partial matching: similar-but-not-identical still retrieves, at a cost ---
  const sim = similarity(cue.text, `${node.gist} ${node.tags.join(' ')}`);
  const partialMatch = p.mismatchPenalty * (sim - 1) * 0.5; // ≤ 0

  /**
   * Arousal-biased competition (§B.2 #19).
   *
   * Under noradrenaline the emotionally charged rise and the neutral sink, which
   * is why frightened recall is vivid and narrow rather than simply louder. It
   * redistributes rather than inflates: a memory of median salience is unmoved
   * at any arousal, and every memory is unmoved at baseline arousal.
   */
  const boost = contrastTerm(node, gains);
  const suppression = -(node.suppressed ?? 0);
  // Low serotonin weights mood-congruent material harder — the depressive
  // retrieval bias, emergent from load rather than authored.
  const congruence = moodCongruence(node, cue.mood) * gains.congruenceGain;
  const noise = logisticNoise(p.noise * gains.noiseScale, rng);
  /**
   * Priming and habituation (§B.2 #15).
   *
   * A trace used a moment ago is easier to reach — this is what makes recall
   * chain instead of re-ranking from scratch every turn — and one used over and
   * over is temporarily spent, which is what stops a character repeating their
   * best anecdote until it stops meaning anything. Read-only: scoring a node
   * during ranking must not itself count as using it.
   */
  const availability = stpTerm(node, cue.now);

  const total = base + spreading + partialMatch + boost + suppression + congruence + availability + noise;
  return {
    base,
    spreading,
    partialMatch,
    boost,
    suppression,
    moodCongruence: congruence,
    noise,
    availability,
    total,
  };
}

/**
 * Trauma intrusion: an S-rep with weak context binding fires on raw sensory/
 * lexical overlap, without being asked for and without passing the threshold
 * (§8). This is what makes a triggered flashback feel involuntary.
 */
function intrusionScore(node: MemoryNode, cue: RecallCue): number {
  if (!node.intrusive) return 0;
  const cueTokens = tokenSet(`${cue.text} ${cue.keywords.join(' ')}`);
  const nodeTokens = tokenSet(`${node.gist} ${node.detail ?? ''} ${node.tags.join(' ')}`);
  let hits = 0;
  for (const t of nodeTokens) if (cueTokens.has(t)) hits++;
  const actorHit = (node.actors ?? []).some((a) => cue.actors.some((c) => c.toLowerCase() === a.toLowerCase()));
  const placeHit = !!node.place && !!cue.place && node.place.toLowerCase() === cue.place.toLowerCase();
  // Weak context binding means *fewer* cues are needed to set it off.
  const sensitivity = 1 + (1 - clamp01(node.contextBinding)) * 1.5;
  return (hits * 0.22 + (actorHit ? 0.35 : 0) + (placeHit ? 0.3 : 0)) * sensitivity;
}

export function recall(
  brain: BrainState,
  cue: RecallCue,
  opts: RecallOptions = {},
): RecallResult {
  const p: BrainParams = brain.config.params;
  const rng = opts.rng ?? Math.random;
  const index = opts.index ?? buildIndex(brain);
  const gains = opts.gains ?? gainsOf(modulatorsOf(brain, opts.phase ?? 'engaged'));
  /**
   * Vigilance narrows the aperture (Easterbrook): under threat fewer memories
   * clear the threshold and the ones that do are more cue-locked. Low serotonin
   * widens it, which is why a depressed character is flooded rather than focused.
   */
  const threshold = p.threshold + gains.thresholdShift;

  const scored: RecallHit[] = [];
  for (const node of Object.values(brain.nodes)) {
    const breakdown = activationOf(node, cue, brain, index, rng, gains);
    const intrusion =
      brain.config.intrusionsEnabled && node.intrusive === true && intrusionScore(node, cue) >= 0.55;

    // Self-defining memories are disproportionately available — that is what
    // makes them self-defining (§1.3). They are never gated by the threshold,
    // any more than a pinned memory or a trauma intrusion is.
    const passes =
      opts.includeBelowThreshold ||
      intrusion ||
      node.pinned === true ||
      node.kind === 'identity' ||
      breakdown.total >= threshold;
    if (!passes) continue;

    scored.push({
      node,
      activation: breakdown.total,
      probability: recallProbability(breakdown.total, p),
      breakdown,
      intrusion,
    });
  }

  // Intrusions jump the queue — they are not chosen, they arrive.
  scored.sort((a, b) => {
    if (a.intrusion !== b.intrusion) return a.intrusion ? -1 : 1;
    return b.activation - a.activation;
  });

  const hits = opts.limit ? scored.slice(0, opts.limit) : scored;
  const retrievedIds = new Set(hits.map((h) => h.node.id));

  // Competitors: same-cue rivals that did *not* win. They get suppressed (§7.4).
  const competitorSet = new Set<string>();
  for (const h of hits.slice(0, 8)) {
    for (const id of competitorsOf(index, h.node, retrievedIds)) competitorSet.add(id);
  }
  const competitors = [...competitorSet];

  if (opts.mutate) {
    applyRetrievalEffects(brain, hits, competitors, cue.now, index, rng);
  }

  return { hits, competitors, cue };
}

/**
 * The read-modify-write half of retrieval.
 *
 * Retrieved memories gain a trace (testing effect) and lose a little fidelity
 * (reconstruction). Unretrieved competitors are suppressed. Both are real,
 * well-replicated human effects and both are what make a character's account of
 * the past *crystallise* around the version they keep telling.
 */
export function applyRetrievalEffects(
  brain: BrainState,
  hits: RecallHit[],
  competitors: string[],
  now: number,
  index?: BrainIndex,
  rng: () => number = Math.random,
): void {
  const p = brain.config.params;
  const retrieved = new Set(hits.map((h) => h.node.id));

  for (const h of hits) {
    const node = brain.nodes[h.node.id];
    if (!node) continue;
    addTrace(node, now, p);
    /**
     * Two different losses, applied in order.
     *
     * `recordSynapticUse` settles the *time-based* curve — fidelity decays and
     * interference noise accrues for however long this memory sat untouched —
     * and then stabilises the trace, because a memory that keeps being recalled
     * becomes structurally durable rather than merely momentarily available.
     * `degradeFidelity` is the separate, per-reconstruction cost: the act of
     * remembering rebuilds the memory and each rebuild risks drift.
     */
    recordSynapticUse(node, now);
    node.fidelity = degradeFidelity(node, 0.012);
    // Confidence barely moves — the flashbulb dissociation (§5.3).
    node.confidence = clamp01(node.confidence + 0.004);
    /**
     * …and once a trace is degraded enough, rebuilding it is where it actually
     * goes wrong (`reconstruction.ts`). Committed here rather than rendered at
     * compose time so the memory *stays* wrong: a character who misremembers
     * something differently every turn is not unreliable, they are glitching.
     */
    reconstructOnRecall(brain, node, now, { rng });
    // Retrieval in a safe, ordinary context slowly contextualises trauma (§8).
    if (node.intrusive && !h.intrusion) {
      node.contextBinding = clamp01(node.contextBinding + 0.02);
      if (node.contextBinding > 0.62) node.intrusive = false;
    }
    node.suppressed = Math.max(0, (node.suppressed ?? 0) - p.rifPenalty * 0.5);
    if (node.status !== 'active') node.status = 'active';
  }

  /**
   * Retrieval-induced *facilitation* (§B.2 #10).
   *
   * We have modelled only the suppressive half of retrieval competition, which
   * left recall oddly flat: remembering one thing made everything nearby harder
   * to reach and nothing easier. In a real network the neighbours of what just
   * fired are left partly primed, which is why remembering a room brings back
   * who was in it. Neighbours get a fraction of a use — enough to lift them a
   * little for the next turn, not enough to spend them.
   */
  if (index) {
    for (const h of hits) {
      for (const n of neighbors(index, h.node.id)) {
        if (retrieved.has(n.id)) continue;
        const other = brain.nodes[n.id];
        if (!other || other.status === 'dormant') continue;
        const syn = ensureSynapse(other, now);
        relaxSynapse(syn, now);
        // Facilitation only: resources are untouched, so priming a neighbour
        // never costs it anything.
        const lift = DEFAULT_SYNAPSE.baseUtilisation * n.weight * 0.5;
        syn.facilitation = clamp01(syn.facilitation + lift * (1 - syn.facilitation));
      }
    }
  }

  for (const id of competitors) {
    const node = brain.nodes[id];
    if (!node || node.pinned || node.kind === 'identity' || node.kind === 'sensory') continue;
    node.suppressed = Math.min(2.5, (node.suppressed ?? 0) + p.rifPenalty);
  }
  brain.stats.totalRecalls++;
}

/** Build a recall cue from live chat context. */
export function cueFromContext(input: {
  recentText: string;
  actors: string[];
  place?: string;
  brain: BrainState;
  now?: number;
  extraKeywords?: string[];
}): RecallCue {
  const now = input.now ?? Date.now();
  const keywords = new Set<string>(input.extraKeywords?.map((k) => k.toLowerCase()) ?? []);
  for (const c of input.brain.workingSelf.concerns) for (const t of tokenSet(c)) keywords.add(t);
  return {
    text: input.recentText,
    actors: input.actors,
    place: input.place,
    keywords: [...keywords],
    mood: input.brain.mood,
    goals: input.brain.workingSelf.goals.filter((g) => g.status === 'active').map((g) => g.text),
    now,
  };
}
