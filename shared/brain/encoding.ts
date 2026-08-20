/**
 * Encoding: appraised event → memory node(s).
 *
 * Most of experience is never encoded (§2.2). What survives the salience gate
 * is stamped with the emotion *this character* felt (§5.4), given a permanent
 * boost proportional to arousal (§5.1), and — above the trauma threshold —
 * split into a strong sensory trace plus a weakened contextual one (§8).
 */
import { clamp01, emotionalBoost } from './activation';
import {
  appraiseToAffect, contextBindingFor, isTraumatic, personalizeAppraisal,
} from './emotion';
import { canonicalizeActors, learnAliasGroups } from './entities';
import { autoLink } from './graph';
import type {
  Affect, AppraisedEvent, BrainState, MemoryKind, MemoryNode,
} from './types';

export interface EncodeContext {
  now: number;
  chatId?: string;
  chapterId?: string;
  /** Names in the scene — used to tell "Wren the character" from "Wren the NPC". */
  cast?: string[];
  /** Deterministic id source so consolidation is reproducible in tests. */
  makeId: () => string;
  /**
   * Neuromodulatory encoding gain (`neuromodulation.ts`). Noradrenaline is the
   * consolidation modulator: a keyed-up character lays down stronger traces of
   * everything, an exhausted one lays down weaker ones. 1 is baseline.
   */
  encodingGain?: number;
}

export interface EncodeResult {
  node: MemoryNode | null;
  /** Trauma S-rep created alongside the (weakened) episodic node (§8). */
  sensory: MemoryNode | null;
  /** Encoded strength before the gate — exposed for the audit log. */
  salience: number;
  skipped: boolean;
}

/**
 * How memorable was this, before we decide whether to keep it?
 *
 * Multiplicative-ish blend of the encoding determinants in §2.1: elaboration
 * proxy (the encoder's own salience), arousal, goal relevance, novelty, and
 * self-reference. Deliberately biased toward discarding — humans discard.
 */
export function salienceOf(event: AppraisedEvent, affect: Affect): number {
  const a = event.appraisal;
  const core =
    0.30 * clamp01(event.salience) +
    0.28 * clamp01(affect.arousal) +
    0.22 * clamp01(a.goalRelevance) +
    0.12 * clamp01(a.novelty) +
    0.08 * clamp01(Math.abs(affect.valence));
  // Identity-relevant material is privileged: self-defining memories stick (§1.3).
  const identityLift = event.identityRelevant ? 0.22 : 0;
  // Norm violations in either direction are sticky (pride and shame both last).
  const normLift = 0.10 * clamp01(Math.abs(a.norms));
  return clamp01(core + identityLift + normLift);
}

export function encodeEvent(
  brain: BrainState,
  event: AppraisedEvent,
  ctx: EncodeContext,
): EncodeResult {
  const p = brain.config.params;

  // 1. Appraise through this character's own lens — the individuality mechanism.
  const appraisal = personalizeAppraisal(event.appraisal, brain.traits, brain.workingSelf);
  const affect = appraiseToAffect(appraisal, brain.traits);
  const salience = salienceOf({ ...event, appraisal }, affect);

  if (salience < p.encodeThreshold) {
    return { node: null, sensory: null, salience, skipped: true };
  }

  learnAliasGroups(brain, event.aliases, ctx.cast);
  const actors = canonicalizeActors(brain, event.actors, ctx.cast);

  const traumatic = brain.config.traumaEnabled && isTraumatic(affect, appraisal, p);
  const binding = contextBindingFor(affect, appraisal);

  const kind: MemoryKind = event.identityRelevant ? 'identity' : 'episodic';
  const gain = ctx.encodingGain ?? 1;
  const boost = emotionalBoost(affect, p, {
    identityRelevant: event.identityRelevant,
    goalRelevance: appraisal.goalRelevance,
  }) * gain;

  const node: MemoryNode = {
    id: ctx.makeId(),
    kind,
    gist: event.gist.trim(),
    verbatim: event.verbatim?.trim() || undefined,
    detail: event.detail?.trim() || undefined,
    encodedAt: ctx.now,
    uses: [ctx.now],
    useCount: 1,
    /**
     * Trauma weakens the *contextual* trace even as it strengthens the sensory
     * one (§8) — but only the arousal-derived part. A formative event stays
     * formative: what the person can no longer do is narrate it cleanly, not
     * remember that it defined them.
     */
    permanentBoost: traumatic
      ? Math.max(boost * 0.45, event.identityRelevant ? 1.4 : 0)
      : boost,
    affect,
    appraisal,
    vividness: clamp01(0.35 + 0.65 * affect.arousal),
    confidence: clamp01(0.55 + 0.4 * salience),
    fidelity: clamp01(0.72 + 0.28 * binding),
    actors,
    place: event.place?.trim() || undefined,
    tags: dedupe(event.tags).slice(0, 12),
    chapterId: ctx.chapterId,
    contextBinding: traumatic ? Math.min(binding, 0.3) : binding,
    suppressed: 0,
    status: 'active',
    sourceChatId: ctx.chatId,
    sourceMessageIds: event.sourceMessageIds,
    characterId: brain.characterId,
  };

  brain.nodes[node.id] = node;
  brain.stats.totalEncoded++;
  autoLink(brain, node);

  let sensory: MemoryNode | null = null;
  if (traumatic) {
    sensory = {
      ...node,
      id: ctx.makeId(),
      kind: 'sensory',
      // The S-rep is the raw sensory fragment, not the narrative.
      gist: event.detail?.trim() || event.verbatim?.trim() || event.gist.trim(),
      verbatim: event.verbatim?.trim() || undefined,
      detail: event.detail?.trim() || undefined,
      // Near-permanent: extreme arousal, no ordinary decay path.
      permanentBoost: boost * 1.9,
      intrusive: true,
      contextBinding: clamp01(binding * 0.35),
      // No time/place binding is the defining property of an S-rep.
      place: undefined,
      chapterId: undefined,
      vividness: 1,
      confidence: clamp01(node.confidence + 0.15),
      fidelity: clamp01(node.fidelity - 0.1),
      uses: [ctx.now],
      useCount: 1,
      suppressed: 0,
      status: 'active',
    };
    brain.nodes[sensory.id] = sensory;
    brain.stats.totalEncoded++;
    // Bind the fragment to its (weak) narrative parent so therapy/contextualisation
    // has something to grow along.
    brain.edges.push({
      from: sensory.id, to: node.id, kind: 'during', weight: 0.4, createdAt: ctx.now,
      note: 'sensory fragment of a weakly contextualised episode',
    });
  }

  return { node, sensory, salience, skipped: false };
}

function dedupe(list: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list ?? []) {
    const v = (raw ?? '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
