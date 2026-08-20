/**
 * Consolidation — the offline "sleep" pass (§10).
 *
 * Runs periodically, not per message, because that is both what the biology
 * does and what keeps the LLM cost sane. One pass performs, in order:
 * encode → reconsolidate → link → transform → schematise → decay → relate →
 * drift → mood → prune.
 *
 * Pure: takes a brain plus already-appraised events, returns a mutated brain
 * and a full report. All LLM work happens before this function is called.
 */
import {
  addTrace, ageIn, baseLevel, clamp01, clampSigned, emotionalBoost, similarity, verbatimStrength,
} from './activation';
import { appraiseToAffect, updateMood } from './emotion';
import { addEdge, autoLink, decayEdges, removeNodeEdges } from './graph';
import { encodeEvent, type EncodeContext } from './encoding';
import {
  abstractionFactor, gainsOf, modulatorsOf,
  type CognitivePhase, type ModulatoryGains,
} from './neuromodulation';
import { applyDrift, traitPressure, updateRelation } from './personality';
import { advanceFidelity, potentiate, recordSynapticUse } from './synapse';
import { reviewGoals, scoreIntention } from './volition';
import { attachWarrant, recomputeWarrants } from './warrant';
import { holdEvents } from './working';
import type {
  Affect, AppraisedEvent, BrainState, ConsolidationReport, MemoryNode,
} from './types';

export interface ConsolidateInput {
  events: AppraisedEvent[];
  now: number;
  chatId?: string;
  chapterId?: string;
  makeId: () => string;
  /** Optional cap on total active memory footprint (tokens) from the budget layer. */
  activeTokenCap?: number;
  /** Rough token estimator, injected so the engine stays dependency-free. */
  countTokens?: (text: string) => number;
  /**
   * Force the maintenance tail on or off.
   *
   * Left undefined it is decided by elapsed time — see `MAINTENANCE_MIN_GAP_MS`.
   * Tests set it explicitly; nothing in the app needs to.
   */
  maintenance?: boolean;
  /**
   * Names present in the scene. Used only to tell "the encoder shortened my own
   * name" apart from "somebody else here happens to share part of it".
   */
  cast?: string[];
  /**
   * What the mind is doing while this pass runs. `rest` is the offline sleep
   * pass: low acetylcholine, so abstraction is favoured over taking in more
   * (Hasselmo — §B.2 #19). Defaults to `rest`, which is what a consolidation
   * pass has always been.
   */
  phase?: CognitivePhase;
  /** Override the derived neuromodulatory gains. Tests pin these. */
  gains?: ModulatoryGains;
}

/**
 * How much wall-clock time must pass between maintenance tails.
 *
 * Decay, drift and mood regression model *time passing*, not *work being done*.
 * They used to run once per `consolidate()` call, which was fine while a pass
 * was one call — and became badly wrong once a long history was read as one
 * chunk after another. A twenty-chunk "Re-read all" applied twenty rounds of
 * fidelity decay, multiplied every edge by 0.995 twenty times, and blended the
 * mood 21% toward baseline twenty times over, erasing it. The same thing
 * happened for free whenever the encoder returned nothing usable several passes
 * running: no events, but the full decay tail every time.
 *
 * A gap means a burst of chunks counts as the single moment of elapsed time it
 * actually is, while ordinary play — where passes are minutes apart — decays
 * exactly as before.
 */
export const MAINTENANCE_MIN_GAP_MS = 60_000;

export function consolidate(brain: BrainState, input: ConsolidateInput): ConsolidationReport {
  const p = brain.config.params;
  const now = input.now;
  const gains = input.gains ?? gainsOf(modulatorsOf(brain, input.phase ?? 'rest'));
  const ctx: EncodeContext = {
    now,
    chatId: input.chatId,
    chapterId: input.chapterId,
    makeId: input.makeId,
    encodingGain: gains.encodingGain,
    cast: input.cast,
  };

  const report: ConsolidationReport = {
    encoded: [], skipped: 0, reconsolidated: [], reconsolidationBlocked: [],
    semanticised: [], schemasFormed: [], faded: [], dormant: [], pruned: [],
    traumaFormed: [], traitDrift: {}, moodBefore: { ...brain.mood }, moodAfter: { ...brain.mood },
    peopleUpdated: [], at: now,
  };

  const feltAffects: Affect[] = [];
  const pressures: ReturnType<typeof traitPressure>[] = [];
  const newNodes: MemoryNode[] = [];

  // ---- 1. reconsolidation of existing memories, then encoding of new ones ----
  for (const event of input.events) {
    // A repeated event is not a new memory — it is another trace on an old one
    // (§3.3 spacing). Check that before creating anything.
    const echo = findEcho(brain, event, now);
    if (echo) {
      addTrace(echo, now, p);
      recordSynapticUse(echo, now);
      // Recurrence deepens conviction and, mildly, the permanent boost.
      echo.confidence = clamp01(echo.confidence + 0.03);
      /**
       * Through the BCM gate (§B.2 #16) rather than as a flat increment.
       *
       * The first few recurrences strengthen the memory exactly as before; once
       * a trace has been echoed so often that it sits above its own running
       * average, further potentiation tapers to nothing. Unbounded growth here
       * is how a long conversation ends up with five memories that win every
       * recall forever, which reads as obsession rather than as a good memory.
       */
      potentiate(echo, 0.05, now);
      if (echo.status !== 'active') echo.status = 'active';
      report.reconsolidated.push(echo.id);
      feltAffects.push(echo.affect);
      /**
       * A repetition still happened *to somebody*.
       *
       * This used to `continue` straight past the relationship pass, so the
       * second, third and fourth time a character was betrayed by the same
       * person moved trust not at all — only the first, novel-enough-to-encode
       * one did. Recurrence is precisely what should harden a view of someone.
       */
      for (const actor of echo.actors) {
        if (isSelf(brain, actor, input.cast)) continue;
        updateRelation(brain, actor, echo, now);
        if (!report.peopleUpdated.includes(actor)) report.peopleUpdated.push(actor);
      }
      continue;
    }

    // Explicit contradictions/extensions go through the prediction-error gate (§6).
    let handledByUpdate = false;
    for (const upd of event.updates ?? []) {
      const target = brain.nodes[upd.nodeId];
      if (!target) continue;
      const pe = predictionError(target, event);
      /**
       * Dopamine is what makes evidence count (§B.2 #19). A character who is
       * depleted, hopeless or anhedonic has a *higher* bar for rewriting what
       * they already believe — the mind stops updating — while an engaged one
       * revises more readily. Dividing rather than scaling the error keeps the
       * threshold's own age-and-strength structure intact.
       */
      const required = destabilisationThreshold(target, now, brain) / Math.max(0.15, gains.plasticity);
      if (pe > required) {
        applyReconsolidation(target, event, upd.kind, upd.newGist, now, brain);
        report.reconsolidated.push(target.id);
        handledByUpdate = upd.kind === 'extends';
      } else {
        report.reconsolidationBlocked.push({ nodeId: target.id, pe, required });
      }
    }
    if (handledByUpdate) continue;

    const result = encodeEvent(brain, event, ctx);
    if (result.skipped || !result.node) {
      report.skipped++;
      continue;
    }
    report.encoded.push(result.node.id);
    newNodes.push(result.node);
    feltAffects.push(result.node.affect);
    pressures.push(traitPressure(result.node));

    if (result.sensory) {
      report.traumaFormed.push(result.sensory.id);
      newNodes.push(result.sensory);
      pressures.push(traitPressure(result.sensory));
    }

    holdEvents(brain, [{
      gist: result.node.gist,
      actors: result.node.actors,
      salience: result.salience,
      nodeId: result.node.id,
    }], now, input.makeId);

    // Explicit links the encoder asked for.
    for (const link of event.links ?? []) {
      addEdge(brain, result.node.id, link.nodeId, link.kind, 0.6);
    }

    /**
     * Relationship models (§9.2) — for *other* people.
     *
     * The encoder lists every actor in an event, including the character whose
     * head this is, so without this guard a character accumulates a relationship
     * with themselves and the UI shows "Scarlet Wren: trust −0.4, fear +0.6" in
     * Scarlet Wren's own People list. Self-directed feeling is real, but it belongs
     * in self-concept and traits, not in the model of another person.
     */
    for (const actor of result.node.actors) {
      if (isSelf(brain, actor, input.cast)) continue;
      updateRelation(brain, actor, result.node, now);
      if (!report.peopleUpdated.includes(actor)) report.peopleUpdated.push(actor);
    }
  }

  /**
   * ---- 2. transformation: episodic → semantic gist (§7, §13.1) ----
   *
   * How much converging evidence this takes is set by acetylcholine: the sleep
   * pass abstracts as readily as it always has, while a mind still busy taking
   * things in needs more repetitions before it decides what they mean.
   */
  const abstractAfter = Math.max(2, Math.round(p.semanticiseAfter * abstractionFactor(gains)));
  report.semanticised.push(...semanticise(brain, now, input.makeId, abstractAfter));

  // ---- 3. schema induction (§9.1) ----
  report.schemasFormed.push(...induceSchemas(brain, now, input.makeId));

  /**
   * Does the clock move this pass?
   *
   * Status transitions and pruning are read from `baseLevel(node, now)` and are
   * therefore idempotent — they always run. Only the four operations that
   * *advance* something per call are gated.
   */
  const sinceMaintenance = now - (brain.stats.lastMaintenanceAt ?? 0);
  const maintain = input.maintenance ?? sinceMaintenance >= MAINTENANCE_MIN_GAP_MS;

  // ---- 4. decay pass: verbatim fade, status transitions (§3, §7.3) ----
  const decayed = decayPass(brain, now, maintain);
  report.faded.push(...decayed.faded);
  report.dormant.push(...decayed.dormant);
  if (maintain) decayEdges(brain);

  // ---- 5. budget pressure: forget the weakest when over cap (§5 of the spec) ----
  if (input.activeTokenCap && input.countTokens) {
    // These are demoted to `faded`, not `dormant` — the audit log used to say
    // "N slipped away" about memories that are still one recall from active.
    report.faded.push(...enforceFootprint(brain, now, input.activeTokenCap, input.countTokens));
  }

  // ---- 6. personality drift + mood (§9.3, §5.5) ----
  // Schemas exert *standing* pressure — a fact about time passing, not about
  // this stretch, so it only counts when the clock moved.
  if (maintain) {
    for (const node of Object.values(brain.nodes)) {
      if (node.kind === 'schema' && node.status === 'active') {
        const pr = traitPressure(node);
        for (const k of Object.keys(pr) as (keyof typeof pr)[]) pr[k] = (pr[k] ?? 0) * 0.25;
        pressures.push(pr);
      }
    }
  }
  // Evidence always drifts and always colours the mood; only the idle regression
  // toward baseline is a function of time.
  if (pressures.length) {
    // Plasticity gates how far the same evidence moves a personality.
    const scaled = pressures.map((pr) => {
      const out = { ...pr };
      for (const k of Object.keys(out) as (keyof typeof out)[]) out[k] = (out[k] ?? 0) * gains.plasticity;
      return out;
    });
    report.traitDrift = applyDrift(brain, scaled, p);
  }
  if (feltAffects.length || maintain) {
    brain.mood = updateMood(brain.mood, feltAffects, brain.traits, p, gains.moodInertia);
  }
  report.moodAfter = { ...brain.mood };
  if (maintain) brain.stats.lastMaintenanceAt = now;

  // ---- 7. prune only what is genuinely gone (§3.2 — never delete the reachable) ----
  report.pruned.push(...prune(brain, now));

  /**
   * Beliefs rest on episodes. After decay and prune have had their say,
   * re-read every warrant so a schema whose evidence has gone quietly
   * loses conviction rather than living on as an unexamined fact (§B.2 #7).
   */
  if (maintain) recomputeWarrants(brain);

  // ---- 8. relink new nodes now that semantics/schemas exist ----
  for (const node of newNodes) {
    if (brain.nodes[node.id]) autoLink(brain, brain.nodes[node.id], { maxLinks: 3 });
  }

  /**
   * Retire a relationship the character has with themselves.
   *
   * This runs here rather than at load because here the cast is known. An
   * encoder told the character is "Scarlet Wren" writes actors as `["Wren", …]`,
   * so a legacy brain can carry a `people['wren']` entry that is really the
   * character; but a scene can equally contain somebody who is *actually*
   * called Wren, and deleting her on sight was how a real relationship
   * disappeared. `isSelf` can tell the two apart once it can see who else is in
   * the room — at load it cannot, so it used to guess, and guessing destroyed
   * data every time it was wrong.
   */
  for (const key of Object.keys(brain.people)) {
    if (isSelf(brain, brain.people[key].displayName || key, input.cast)) delete brain.people[key];
  }

  /**
   * ---- 9. volition (`volition.ts`) ----
   *
   * Progress on the current objective is read off the appraisals that were just
   * produced — `goalConduciveness` already answers "did that help or hinder" for
   * every event, so the character never gets to simply declare their own
   * objective satisfied.
   *
   * The goal curator runs only on a maintenance pass. Goals are the slowest-
   * moving thing in the brain, and re-reviewing them for every chunk of a long
   * re-read would churn a list whose value is entirely in its stability.
   */
  const outcome = scoreIntention(brain, input.events);
  report.intentionResolved = outcome.resolved;
  if (maintain) {
    report.goalReview = reviewGoals(brain, now, input.makeId);
  }

  brain.stats.updates++;
  brain.stats.lastUpdateAt = now;
  brain.updatedAt = now;
  return report;
}

/**
 * Is this actor the character themselves?
 *
 * Matches on the full name and on the first name, because an encoder that is told
 * the character is "Scarlet Wren" will happily write actors as `["Wren", "Rooke"]`.
 */
export function isSelf(brain: BrainState, actor: string, cast?: Iterable<string>): boolean {
  const a = actor.trim().toLowerCase();
  if (!a) return true;
  const self = brain.characterName.trim().toLowerCase();
  if (!self) return false;
  if (a === self) return true;
  /**
   * A part-name only means "me" when it belongs to nobody else in the scene.
   *
   * "Scarlet Wren" matching the actor "Wren" is the case this exists for, but the
   * same rule silently swallowed an NPC who was *actually called* Wren: every
   * memory of her was filed as self-directed and her relationship record was
   * deleted on every load. When somebody else in the cast answers to the name,
   * the name is theirs.
   */
  if (cast) {
    for (const other of cast) {
      const o = other.trim().toLowerCase();
      if (o && o !== self && o === a) return false;
    }
  }
  const parts = self.split(/\s+/);
  const first = parts[0];
  const last = parts.at(-1) ?? '';
  return (first.length > 2 && a === first) || (last.length > 2 && a === last);
}

// ---------- recurrence ----------

/**
 * Is this event essentially something already in memory? If so it is a
 * repetition, and repetition is what makes memory durable (§3.3, §4.1).
 */
function findEcho(brain: BrainState, event: AppraisedEvent, now: number): MemoryNode | null {
  let best: MemoryNode | null = null;
  let bestScore = 0;
  const actors = new Set(event.actors.map((a) => a.toLowerCase()));
  for (const node of Object.values(brain.nodes)) {
    if (node.kind === 'sensory' || node.kind === 'schema') continue;
    const sim = similarity(event.gist, node.gist);
    if (sim < 0.62) continue;
    const actorOverlap = node.actors.filter((a) => actors.has(a.toLowerCase())).length;
    const score = sim + 0.1 * actorOverlap;
    if (score > bestScore) { bestScore = score; best = node; }
  }
  // Very recent identical text is more likely a duplicate parse than a real repeat,
  // but either way the right action is the same: add a trace, not a node.
  return bestScore >= 0.7 ? best : null;
}

// ---------- reconsolidation (§6) ----------

/**
 * Mismatch between what the memory predicts and what actually happened.
 *
 * Both flavours of update carry error, because both mean the memory failed to
 * predict something: a contradiction says it was wrong, an extension says it
 * was incomplete. Contradiction weighs more, and more still when the new event
 * feels the opposite way to the stored one.
 */
export function predictionError(node: MemoryNode, event: AppraisedEvent): number {
  const contentDelta = 1 - similarity(node.gist, event.gist);
  const newAffect = appraiseToAffect(event.appraisal);
  const affectDelta = Math.abs(node.affect.valence - newAffect.valence) / 2;
  const flagged = (event.updates ?? []).find((u) => u.nodeId === node.id);
  const explicit = flagged?.kind === 'contradicts' ? 0.45 : flagged?.kind === 'extends' ? 0.25 : 0;
  return clamp01(0.55 * contentDelta + 0.30 * affectDelta + explicit);
}

/**
 * How much prediction error it takes to destabilise this memory.
 * Older and stronger memories resist more — which is exactly why deep
 * convictions are not overturned by a single counterexample (§6).
 */
export function destabilisationThreshold(node: MemoryNode, now: number, brain: BrainState): number {
  const p = brain.config.params;
  const strength = Math.max(0, baseLevel(node, now, p));
  const ageDays = ageIn(now, node.encodedAt);
  let required = p.peBase + p.peStrengthWeight * strength + p.peAgeWeight * Math.log(1 + ageDays);
  if (node.kind === 'identity') required += 0.25;
  if (node.kind === 'schema') required += 0.15;
  if (node.pinned) required = Infinity;
  return required;
}

function applyReconsolidation(
  node: MemoryNode,
  event: AppraisedEvent,
  kind: 'contradicts' | 'extends',
  newGist: string | undefined,
  now: number,
  brain: BrainState,
): void {
  const p = brain.config.params;
  if (kind === 'extends') {
    node.gist = (newGist || `${node.gist} — ${event.gist}`).trim();
  } else {
    // A contradiction that gets through rewrites the meaning and shakes conviction.
    node.gist = (newGist || event.gist).trim();
    node.confidence = clamp01(node.confidence - 0.18);
  }
  // Every restabilisation costs accuracy — this is where false memory comes from (§7.3).
  node.fidelity = clamp01(node.fidelity - 0.09);
  node.verbatim = undefined; // the old wording does not survive a rewrite
  addTrace(node, now, p);
  const newAffect = appraiseToAffect(event.appraisal, brain.traits);
  node.affect = {
    valence: clampSigned(node.affect.valence * 0.6 + newAffect.valence * 0.4),
    arousal: clamp01(Math.max(node.affect.arousal * 0.85, newAffect.arousal)),
    dominance: clampSigned(node.affect.dominance * 0.6 + newAffect.dominance * 0.4),
    label: newAffect.arousal > node.affect.arousal ? newAffect.label : node.affect.label,
  };
  node.permanentBoost = Math.max(
    node.permanentBoost,
    emotionalBoost(node.affect, p, { goalRelevance: event.appraisal.goalRelevance }),
  );
  node.status = 'active';
}

// ---------- transformation: episodic → semantic (§7) ----------

function semanticise(
  brain: BrainState,
  now: number,
  makeId: () => string,
  after: number = brain.config.params.semanticiseAfter,
): string[] {
  const made: string[] = [];
  const episodics = Object.values(brain.nodes).filter(
    (n) => n.kind === 'episodic' && n.status !== 'dormant',
  );

  const used = new Set<string>();
  for (const seed of episodics) {
    if (used.has(seed.id)) continue;
    // Only mature memories transform — this takes time, by design.
    if (ageIn(now, seed.encodedAt) < 1) continue;

    const family = episodics.filter(
      (n) => !used.has(n.id) && n.id !== seed.id && similarity(seed.gist, n.gist) >= 0.42,
    );
    if (family.length + 1 < after) continue;

    const members = [seed, ...family];
    // Do not re-derive a semantic node we already have for this cluster.
    const already = Object.values(brain.nodes).some(
      (n) => n.kind === 'semantic' && similarity(n.gist, seed.gist) >= 0.55,
    );
    if (already) {
      for (const m of members) used.add(m.id);
      continue;
    }

    const gist = abstractGist(members);
    const affect = meanAffect(members);
    const node: MemoryNode = {
      id: makeId(),
      kind: 'semantic',
      gist,
      encodedAt: now,
      uses: members.map((m) => m.encodedAt).slice(-16),
      useCount: members.reduce((s, m) => s + m.useCount, 0),
      // Semantic knowledge outlives the episodes it came from.
      permanentBoost: Math.max(...members.map((m) => m.permanentBoost)) * 0.8 + 0.4,
      affect,
      appraisal: members[0].appraisal,
      vividness: 0.25,
      confidence: clamp01(Math.max(...members.map((m) => m.confidence))),
      fidelity: clamp01(mean(members.map((m) => m.fidelity)) - 0.05),
      actors: dedupe(members.flatMap((m) => m.actors)),
      place: undefined, // decontextualised — loss of time and place is the point
      tags: dedupe(members.flatMap((m) => m.tags)).slice(0, 12),
      contextBinding: 0.2,
      suppressed: 0,
      status: 'active',
      characterId: brain.characterId,
    };
    brain.nodes[node.id] = node;
    made.push(node.id);
    attachWarrant(brain, node, members, `happened ${members.length} times`);

    for (const m of members) {
      used.add(m.id);
      addEdge(brain, m.id, node.id, 'instance_of', 0.7);
      // Transformation weakens the episode — it never deletes it (§13.1).
      m.permanentBoost = Math.max(0, m.permanentBoost - 0.25);
      m.verbatim = undefined;
    }
  }
  return made;
}

function abstractGist(members: MemoryNode[]): string {
  // Pick the most representative member (highest mean similarity to the rest)
  // and mark it as a generalisation. The LLM refines these on later passes.
  let best = members[0];
  let bestScore = -1;
  for (const m of members) {
    const score = mean(members.filter((o) => o !== m).map((o) => similarity(m.gist, o.gist)));
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return `Repeatedly true: ${stripEpisodeMarkers(best.gist)} (happened ${members.length} times)`;
}

function stripEpisodeMarkers(gist: string): string {
  return gist
    .replace(/^(that time|the time|once|when|earlier|yesterday|today|last night)[,\s]+/i, '')
    .trim();
}

// ---------- schema induction (§9.1) ----------

function induceSchemas(brain: BrainState, now: number, makeId: () => string): string[] {
  const made: string[] = [];
  const semantics = Object.values(brain.nodes).filter((n) => n.kind === 'semantic' && n.status === 'active');
  if (semantics.length < 2) return made;

  // A schema forms where several semantic generalisations share an actor and a
  // consistent emotional signature — "people like X do Y to me, and it feels Z".
  const byActor = new Map<string, MemoryNode[]>();
  for (const n of semantics) {
    for (const a of n.actors) {
      const key = a.toLowerCase();
      byActor.set(key, [...(byActor.get(key) ?? []), n]);
    }
  }

  for (const [actor, group] of byActor) {
    if (group.length < 2) continue;
    const affect = meanAffect(group);
    if (Math.abs(affect.valence) < 0.25) continue;
    const belief = `${titleCase(actor)} ${affect.valence < 0 ? 'cannot be relied on the way I once assumed' : 'has proven dependable'} — this keeps turning out to be true.`;
    if (Object.values(brain.nodes).some((n) => n.kind === 'schema' && similarity(n.gist, belief) > 0.6)) continue;

    const node: MemoryNode = {
      id: makeId(),
      kind: 'schema',
      gist: belief,
      encodedAt: now,
      uses: [now],
      useCount: group.reduce((s, g) => s + g.useCount, 0),
      permanentBoost: 1.2,
      affect,
      appraisal: group[0].appraisal,
      vividness: 0.15,
      confidence: clamp01(0.6 + 0.1 * group.length),
      fidelity: 0.7,
      actors: [titleCase(actor)],
      tags: dedupe(group.flatMap((g) => g.tags)).slice(0, 8),
      contextBinding: 0.1,
      suppressed: 0,
      status: 'active',
      characterId: brain.characterId,
    };
    brain.nodes[node.id] = node;
    made.push(node.id);
    attachWarrant(
      brain,
      node,
      group,
      `keeps turning out to be true of ${titleCase(actor)}`,
    );
    for (const g of group) addEdge(brain, g.id, node.id, 'instance_of', 0.75);
  }
  return made;
}

// ---------- decay ----------

/**
 * Status transitions are recomputed from `baseLevel(now)` every pass — they are
 * idempotent, so a burst of chunks reaches the same answer as one call. Fidelity
 * loss is not: it is a per-call decrement, so it only applies when `advance`.
 */
function decayPass(
  brain: BrainState,
  now: number,
  advance: boolean,
): { faded: string[]; dormant: string[] } {
  const p = brain.config.params;
  const faded: string[] = [];
  const dormant: string[] = [];

  for (const node of Object.values(brain.nodes)) {
    // Verbatim goes first and goes completely — meaning survives, wording does not.
    if (node.verbatim && verbatimStrength(node, now, p) < p.verbatimFloor) {
      node.verbatim = undefined;
    }

    if (node.pinned || node.kind === 'identity' || node.kind === 'sensory' || node.kind === 'schema') {
      node.status = 'active';
      continue;
    }

    const strength = baseLevel(node, now, p) - (node.suppressed ?? 0);
    const before = node.status;
    if (strength < p.dormantBelow) node.status = 'dormant';
    else if (strength < p.fadeBelow) node.status = 'faded';
    else node.status = 'active';

    if (node.status !== before) {
      if (node.status === 'faded') faded.push(node.id);
      if (node.status === 'dormant') dormant.push(node.id);
    }

    /**
     * Accuracy erodes on its own power law, and interference accumulates as it
     * does (§B.2 #1–#3). Confidence is deliberately left alone: people stay sure
     * of things that have drifted, and that gap is what the composer turns into
     * a confident error rather than a hedge.
     *
     * The old flat `−0.002` per pass ignored both elapsed time and what kind of
     * memory it was, so a schema and a passing remark blurred at the same rate
     * and a brain that was consolidated twice in a minute aged twice.
     */
    if (advance) advanceFidelity(node, now);
  }
  return { faded, dormant };
}

/**
 * When the brain's active footprint exceeds its context share, it must let
 * something go — the "with every update, check if it needs to forget something"
 * requirement. Weakest first; identity, trauma, schemas and pins are untouchable.
 */
function enforceFootprint(
  brain: BrainState,
  now: number,
  cap: number,
  count: (text: string) => number,
): string[] {
  const p = brain.config.params;
  const active = Object.values(brain.nodes).filter((n) => n.status === 'active');
  const cost = (n: MemoryNode) => count(`${n.gist} ${n.verbatim ?? ''}`) + 6;
  let total = active.reduce((s, n) => s + cost(n), 0);
  if (total <= cap) return [];

  const demotable = active
    .filter((n) => !n.pinned && n.kind !== 'identity' && n.kind !== 'sensory' && n.kind !== 'schema')
    .map((n) => ({ n, strength: baseLevel(n, now, p) - (n.suppressed ?? 0) }))
    .sort((a, b) => a.strength - b.strength);

  const pushed: string[] = [];
  for (const { n } of demotable) {
    if (total <= cap) break;
    /**
     * Credit the cost as it stood *before* stripping.
     *
     * The old code cleared `verbatim` first and then subtracted 60% of the
     * now-smaller cost, so each step removed a node from the active set while
     * accounting for a fraction of it. On a verbatim-heavy brain that meant
     * demoting every demotable memory and still finishing over the cap — the
     * loop simply ran out of nodes. `total` measures the *active* footprint and
     * this node has just left it, so the whole of it comes off.
     */
    total -= cost(n);
    n.status = 'faded';
    // The gist stays reachable; the expensive wording does not.
    n.verbatim = undefined;
    pushed.push(n.id);
  }
  return pushed;
}

// ---------- pruning ----------

function prune(brain: BrainState, now: number): string[] {
  const p = brain.config.params;
  const removed: string[] = [];
  for (const node of Object.values(brain.nodes)) {
    if (node.status !== 'dormant') continue;
    if (node.pinned || node.kind === 'identity' || node.kind === 'sensory' || node.kind === 'schema' || node.kind === 'semantic') continue;
    // Only delete what has also been abstracted away or never mattered.
    const strength = baseLevel(node, now, p) - (node.suppressed ?? 0);
    if (strength > p.pruneBelow) continue;
    if (node.permanentBoost > 1.0) continue;
    delete brain.nodes[node.id];
    removeNodeEdges(brain, node.id);
    removed.push(node.id);
    brain.stats.totalPruned++;
  }
  return removed;
}

// ---------- small helpers ----------

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function meanAffect(nodes: MemoryNode[]): Affect {
  return {
    valence: clampSigned(mean(nodes.map((n) => n.affect.valence))),
    arousal: clamp01(mean(nodes.map((n) => n.affect.arousal))),
    dominance: clampSigned(mean(nodes.map((n) => n.affect.dominance))),
    label: nodes.reduce((a, b) => (a.affect.arousal >= b.affect.arousal ? a : b)).affect.label,
  };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
