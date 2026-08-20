/**
 * Consolidation → psyche.
 *
 * The bridge between the memory pass (what happened, and what is worth keeping)
 * and the mind that lived through it (what it cost, and who they now are).
 *
 * Deliberately a *server* module rather than part of the pure engine: it reads
 * the brain graph, which the psyche layer must not depend on directly. The
 * psyche stays a pure function of its own state plus a `GraphSummary`, so it
 * remains testable in isolation.
 */
import {
  DEFAULT_PSYCHE_PARAMS, assessCondition, buildSelfConcept, classifyChapter,
  emptyTheoryOfMind, formTrauma, inferInterlude, isSupportive, mentate,
  normalizePsyche, recordWitnessed, relationalDamage, restScene, stepScene,
  transferPriors, updateBond, updateWorkingModel,
  type Bond, type ChapterArc, type GraphSummary, type PsycheState, type SceneCost,
  type SelfConcept,
} from '../../shared/psyche';
import { appraiseToAffect } from '../../shared/brain/emotion';
import { baseLevel } from '../../shared/brain/activation';
import type {
  AppraisedEvent, BrainState, ConsolidationReport, MemoryNode,
} from '../../shared/brain/types';

/** Summarise the graph for the condition read-out (§P.5). */
export function summariseGraph(brain: BrainState, now: number): GraphSummary {
  const nodes = Object.values(brain.nodes).filter((n) => n.status !== 'dormant');
  const p = brain.config.params;

  /**
   * Beliefs *about the self*. Negative self-concept is measured from these, so
   * the filter matters: a belief that the world is dangerous is not a belief that
   * one is worthless, and conflating them would make every frightened character
   * read as self-loathing.
   */
  const selfBeliefs = nodes
    .filter((n) => (n.kind === 'schema' || n.kind === 'identity') && aboutSelf(n, brain.characterName))
    .map((n) => ({
      gist: n.gist,
      valence: n.affect.valence,
      strength: Math.max(0, baseLevel(n, now, p)) + n.permanentBoost,
    }));

  const goals = brain.workingSelf.goals;

  return {
    nodes,
    selfBeliefs,
    relationTrust: Object.values(brain.people).map((r) => r.trust),
    goalsFailed: goals.filter((g) => g.status === 'blocked' || g.status === 'abandoned').length,
    goalsTotal: goals.length,
  };
}

/** Narrative identity read-out: the life story and the self-concept (§P.6.2). */
export function readIdentity(brain: BrainState, now: number): {
  arcs: ChapterArc[];
  self: SelfConcept;
} {
  const nodes = Object.values(brain.nodes);
  return {
    arcs: brain.chapters.map((c) => classifyChapter(c, nodes, now, brain.config.params)),
    self: buildSelfConcept(nodes, brain.characterName, now, brain.config.params),
  };
}

/**
 * Update every relationship touched by this pass (§P.6.1).
 *
 * Runs *before* the scene step, because who these people are expected to be is
 * part of how the moment gets appraised — and a betrayal has to be measured
 * against the expectation that existed before it happened, not after.
 */
export function updateBonds(
  brain: BrainState,
  events: AppraisedEvent[],
  psyche: PsycheState,
  now: number,
): string[] {
  const notes: string[] = [];
  const self = brain.characterName.toLowerCase();

  for (const event of events) {
    for (const actorName of event.actors) {
      const key = actorName.toLowerCase();
      if (key === self) continue;

      let rel = brain.people[key] as Bond | undefined;
      if (!rel) {
        rel = {
          key,
          displayName: actorName,
          trust: 0, affection: 0, fear: 0, respect: 0, resentment: 0, debt: 0,
          familiarity: 0, model: '', interactions: 0,
          firstMetAt: now, lastSeenAt: now,
        };
        // A stranger who resembles someone from before does not start neutral.
        const { bond, matched, aware } = transferPriors(
          rel,
          Object.values(brain.people) as Bond[],
          psyche,
          event.gist,
        );
        rel = bond;
        if (matched) {
          notes.push(
            `${actorName} reminded them of ${matched.displayName}`
            + (aware ? ' — and they noticed themselves doing it' : ', without them noticing'),
          );
        }
        brain.people[key] = rel;
      }

      const a = event.appraisal;
      // Only events this person actually caused update the model of them.
      if (a.agency !== 'other') continue;

      const result = updateBond(rel, psyche, {
        behaviour: a.intent,
        stakes: Math.max(a.goalRelevance, event.salience),
        promise: event.tags.includes('promise')
          ? (a.norms > 0.2 ? 'kept' : a.norms < -0.2 ? 'broken' : undefined)
          : undefined,
        now,
      });
      brain.people[key] = result.bond;
      if (result.rupture || result.repair) notes.push(result.note);
    }
  }
  return notes;
}

/**
 * Is this belief about the character themselves?
 *
 * Heuristic on purpose: the encoder writes gists in the third person about the
 * character, so their name plus first-person markers catches the great majority,
 * and a false negative merely under-counts rather than inventing a symptom.
 */
function aboutSelf(node: MemoryNode, name: string): boolean {
  const g = node.gist.toLowerCase();
  const n = name.toLowerCase();
  if (node.kind === 'identity') return true;
  if (!node.actors.length && g.includes(n)) return true;
  return /\b(i am|i'm|she is|he is|they are|myself|herself|himself)\b/.test(g) && g.includes(n);
}

export interface PsycheStepInput {
  brain: BrainState;
  /** Events the encoder produced this pass. */
  events: AppraisedEvent[];
  report: ConsolidationReport;
  /** Names present in the scene. */
  cast: string[];
  /** The transcript slice this pass read, for trauma cue matching. */
  transcript: string;
  now: number;
}

/**
 * Advance the psyche by one consolidation pass.
 *
 * One pass is treated as one scene. The *peak* event drives the appraisal rather
 * than the average, because that is how episodes are actually remembered and felt
 * — a calm hour containing thirty seconds of terror is a frightening hour.
 */
export function advancePsyche(input: PsycheStepInput): PsycheState {
  const { brain, events, report, now } = input;
  const p = DEFAULT_PSYCHE_PARAMS;
  let psyche = normalizePsyche(brain.psyche, brain.traits);
  const notes: string[] = [];

  /**
   * Time first. Whatever happened between the last pass and this one happened
   * *before* this scene, and a character who was left mid-crisis three weeks ago
   * should not still be standing in that moment.
   */
  const interlude = inferInterlude(
    psyche.updatedAt,
    now,
    psyche.body.safety > 0.5,
  );
  if (interlude) {
    const rested = mentate(psyche, interlude, summariseGraph(brain, now), p);
    psyche = rested.psyche;
    notes.push(...rested.events);
  }

  // Relationships update before appraisal, so a betrayal is measured against the
  // expectation that existed *before* it happened.
  notes.push(...updateBonds(brain, events, psyche, now));

  /**
   * Who saw what (§N.2.1).
   *
   * Presence at the moment is the strongest evidence that a person knows
   * something, and it is free: the encoder already tells us who was in the event.
   * The negative is the valuable half — anyone in the cast who was *not* an actor
   * in this event gets no record, and that absence is what later stops the
   * character referring to it as shared knowledge.
   */
  psyche = { ...psyche, theoryOfMind: psyche.theoryOfMind ?? emptyTheoryOfMind() };
  for (const event of events) {
    /**
     * Only a real match counts.
     *
     * This used to fall back to `report.encoded[0]` — the first memory formed
     * this pass, which for every event after the first is simply the wrong one.
     * The ledger then recorded "these people witnessed <unrelated event>", and
     * that is the record the character later reasons from when deciding what is
     * safe to say in front of whom. Events that were echoes, or that the
     * salience gate dropped, have no node at all and belong in no ledger.
     */
    const wanted = event.gist.trim();
    const nodeId = report.encoded.find((id) => brain.nodes[id]?.gist === wanted);
    if (!nodeId) continue;
    const present = event.actors.filter(
      (a) => a.toLowerCase() !== brain.characterName.toLowerCase(),
    );
    if (!present.length) continue;
    psyche = {
      ...psyche,
      theoryOfMind: recordWitnessed(psyche.theoryOfMind!, {
        nodeId,
        gist: event.gist,
        present,
        cast: input.cast,
        now,
      }),
    };
  }

  const graph = summariseGraph(brain, now);

  // Nothing happened worth appraising: the scene still passes, the body still
  // recovers, and the condition is still re-read — that is how quiet stretches
  // heal people.
  if (!events.length) {
    const rested = restScene(psyche, { scenes: 1, slept: false, safe: true }, p);
    return {
      ...rested,
      attachment: updateWorkingModel(rested, Object.values(brain.people) as Bond[]),
      condition: assessCondition(rested, graph, p),
      updatedAt: now,
    };
  }

  const peak = events.reduce((a, b) => (intensityOf(a) >= intensityOf(b) ? a : b));
  const agent = peak.actors.find((a) => a.toLowerCase() !== brain.characterName.toLowerCase());
  const relation = agent ? brain.people[agent.toLowerCase()] : undefined;

  const cost: SceneCost = {
    arousal: Math.max(...events.map((e) => e.appraisal.urgency), peak.salience),
    threatened: peak.appraisal.goalConduciveness < -0.3 && peak.appraisal.intent < -0.2,
    harmed: peak.appraisal.copingPotential < 0.2 && peak.salience > 0.6 ? 0.2 : 0,
    // Support is not "someone is present" — it is someone they would actually
    // reach for, which the bond model can now answer properly.
    supported: input.cast.some((c) => {
      const r = brain.people[c.toLowerCase()] as Bond | undefined;
      return !!r && isSupportive(r, psyche);
    }),
    safe: !(peak.appraisal.urgency > 0.6 && peak.appraisal.goalConduciveness < -0.4),
  };

  const result = stepScene(psyche, {
    appraisal: peak.appraisal,
    deriveAffect: (biased) => appraiseToAffect(biased, brain.traits),
    traits: brain.traits,
    mood: brain.mood,
    actors: input.cast,
    text: input.transcript.slice(-1500),
    nodeGist: (id) => brain.nodes[id]?.gist ?? '',
    relation,
    activeSchemas: graph.selfBeliefs.slice(0, 6),
    graph,
    cost,
    goalFailure: peak.appraisal.goalConduciveness < -0.5 && peak.appraisal.goalRelevance > 0.5,
    now,
  }, p);

  let next = result.psyche;

  // Any trauma the memory pass just formed becomes a live trace with its own
  // trajectory — this is what turns "a sensory node exists" into "this is going
  // to keep happening to her unless something changes".
  for (const nodeId of report.traumaFormed) {
    if (next.traumas.some((t) => t.nodeId === nodeId)) continue;
    const node = brain.nodes[nodeId];
    if (!node) continue;
    const perpetrator = node.actors.find((a) => a.toLowerCase() !== brain.characterName.toLowerCase());
    const rel = perpetrator ? brain.people[perpetrator.toLowerCase()] : undefined;
    const trauma = formTrauma({
      nodeId,
      affect: node.affect,
      appraisal: node.appraisal,
      perpetrator,
      relation: rel,
      contextBinding: node.contextBinding,
      now,
    });
    next = { ...next, traumas: [...next.traumas, trauma] };

    // What it did to the person who did it. Trust falls fast; it will not come
    // back at the same rate.
    if (rel) {
      Object.assign(rel, relationalDamage(rel, trauma));
    }
  }

  next = { ...next, traumas: liveTraumas(next.traumas, brain) };

  return {
    ...next,
    // Earned security: the global working model is the weighted average of the
    // relationships actually lived, so one good bond does not undo a history and
    // a sustained one genuinely moves the baseline.
    attachment: updateWorkingModel(next, Object.values(brain.people) as Bond[]),
    lastMoment: {
      affect: result.affect,
      regulation: result.regulation,
      pull: result.pull,
      at: now,
    },
    condition: assessCondition(next, summariseGraph(brain, now), p),
    updatedAt: now,
  };
}

function intensityOf(e: AppraisedEvent): number {
  return 0.5 * e.salience + 0.3 * Math.abs(e.appraisal.goalConduciveness) + 0.2 * e.appraisal.urgency;
}

/**
 * How many traumas can be *live* at once.
 *
 * Not a claim about how much a person can suffer — it is a bound on the working
 * set. Every trace here is re-examined on every consolidation pass, cue-matched
 * on every recall, and serialised into the brain file on every save, so an
 * unbounded list made a long, violent roleplay progressively slower and heavier
 * with no ceiling at all. Nothing is deleted from *memory*: the sensory node
 * stays in the graph and the story is intact. What ends is the active trace.
 */
const MAX_LIVE_TRAUMAS = 24;

/**
 * The traces still doing something.
 *
 * Three things retire one: the memory it tracks is gone from the graph (an
 * orphan that could only ever render as "(memory gone)"), it has been genuinely
 * worked through, or it is the least active of too many. Integration is the
 * interesting case — `traumaStatus` already calls this state "integrated — it
 * happened, and it is over", and a psyche that keeps re-litigating something it
 * has finished with is not modelling recovery, it is refusing it.
 */
function liveTraumas(traumas: PsycheState['traumas'], brain: BrainState): PsycheState['traumas'] {
  const kept = traumas.filter((t) => {
    if (!brain.nodes[t.nodeId]) return false;
    const integrated = t.elaboration > 0.6 && t.nowness < 0.35 && t.approachCount > t.avoidanceCount;
    return !integrated;
  });
  if (kept.length <= MAX_LIVE_TRAUMAS) return kept;
  // Still too many: keep the ones that are most present, breaking ties by recency.
  const weight = (t: PsycheState['traumas'][number]) =>
    t.nowness * 2 + (1 - t.elaboration) + Math.min(1, t.intrusionCount / 10);
  return [...kept]
    .sort((a, b) => (weight(b) - weight(a)) || (b.encodedAt - a.encodedAt))
    .slice(0, MAX_LIVE_TRAUMAS);
}
