/**
 * The scene step — one turn of the whole loop (§P.1).
 *
 * This is the only place the five layers are wired together, and the order is
 * load-bearing:
 *
 *   1. retune the machinery from current condition (dynamics follow the person)
 *   2. bias the appraisal (perception is already personal)
 *   3. derive and blend affect (with their own inertia and reactivity)
 *   4. check what the moment stirs up (intrusions)
 *   5. choose regulation, and pay for it
 *   6. advance body and load
 *   7. re-read the condition from the graph
 *
 * Steps 2 and 7 are what close the loop: the condition computed at the end of
 * this scene biases the perception at the start of the next one. That feedback,
 * running over dozens of scenes, is the character arc — and no part of it is
 * scripted.
 */
import { biasAppraisal, type BiasInput } from './bias';
import { applyEmotion, retuneDynamics, actionTendency, describeFeeling } from './dynamics';
import { stepBody, stepLoad, bodyCapacity, type SceneCost } from './body';
import { chooseRegulation, applyRegulation, express, type RegulationContext } from './regulation';
import { assessCondition, type GraphSummary } from './condition';
import { checkIntrusions, processIntrusion } from './trauma';
import { clamp01 } from './defaults';
import type { Affect, Appraisal, RelationModel, TraitVector } from '../brain/types';
import type {
  AppraisalTrace, ExpressedAffect, PsycheParams, PsycheState, RegulationChoice,
} from './types';

export interface SceneInput {
  /** Appraisal as the encoder reported it — the situation, not yet the person. */
  appraisal: Appraisal;
  /** Affect the brain's own `appraiseToAffect` derived from the biased appraisal. */
  deriveAffect: (biased: Appraisal) => Affect;
  traits: TraitVector;
  mood: Affect;
  /** Who is here. */
  actors: string[];
  /** Relation model for the event's agent, when identifiable. */
  relation?: RelationModel;
  /** Text of the moment, for trauma cue matching. */
  text: string;
  /** Gist lookup so trauma cues can match against the graph. */
  nodeGist: (nodeId: string) => string;
  /** Schemas that matched this moment. */
  activeSchemas?: { gist: string; valence: number; strength: number }[];
  /** For the condition read-out at the end of the scene. */
  graph: GraphSummary;
  /** Physical facts of the scene. */
  cost: SceneCost;
  goalFailure?: boolean;
  now: number;
}

export interface SceneResult {
  psyche: PsycheState;
  mood: Affect;
  /** What they felt and what they let show. */
  affect: ExpressedAffect;
  /** Full bias audit — why they read it that way. */
  trace: AppraisalTrace;
  /** What they did about the feeling. */
  regulation: RegulationChoice;
  /** Traumas that surfaced, most pressing first. */
  intrusions: { nodeId: string; text: string; probability: number }[];
  /** What the emotion wants them to do. */
  pull: string;
}

/** Run one scene through the psyche. Pure: returns new state, mutates nothing. */
export function stepScene(
  psyche: PsycheState,
  input: SceneInput,
  p: PsycheParams,
): SceneResult {
  // --- 1. the machinery follows the person -------------------------------
  const dynamics = retuneDynamics(psyche.dynamics, psyche.load, psyche.body, psyche.condition, p);
  let next: PsycheState = { ...psyche, dynamics };

  // --- 2. perception is already personal ---------------------------------
  const biasInput: BiasInput = {
    psyche: next,
    traits: input.traits,
    moodValence: input.mood.valence,
    relation: input.relation,
    activeSchemas: input.activeSchemas,
    goalFailure: input.goalFailure,
  };
  const trace = biasAppraisal(input.appraisal, biasInput);

  // --- 3. affect, with their own inertia and reactivity -------------------
  const derived = input.deriveAffect(trace.biased);
  const blended = applyEmotion(next.dynamics, { event: derived, mood: input.mood });
  next = { ...next, dynamics: blended.dynamics };

  // --- 4. what the moment stirs up ---------------------------------------
  const pending = checkIntrusions(next, input.text, input.actors, input.nodeGist);
  const fired = pending.filter((c) => c.probability > 0.3).slice(0, 2);

  // --- 5. what they do about it ------------------------------------------
  const safe = (input.cost.safe ?? true) && next.body.safety > 0.45;
  const ctx: RegulationContext = {
    // An intrusion is felt on top of whatever the scene itself produced.
    felt: fired.length
      ? {
        ...blended.emotion,
        arousal: clamp01(blended.emotion.arousal + 0.25 * fired[0].probability),
        dominance: Math.min(blended.emotion.dominance, -0.2),
      }
      : blended.emotion,
    supportAvailable: !!input.cost.supported,
    safeToExpress: safe,
    fromIntrusion: fired.length > 0,
  };
  const regulation = chooseRegulation(next, ctx, p.maturityRegression);
  next = applyRegulation(next, regulation, input.now, p.maturityGain);

  // Every intrusion that fired is now changed by how it was handled. This is the
  // branch that decides whether this character heals or gets worse.
  if (fired.length) {
    const handled = new Map(fired.map((f) => [f.trauma.nodeId, f.trauma]));
    next = {
      ...next,
      traumas: next.traumas.map((t) =>
        handled.has(t.nodeId)
          ? processIntrusion(t, regulation.move, {
            safe,
            supported: !!input.cost.supported,
            now: input.now,
          }, p)
          : t),
    };
  }

  // Dissociating is an acute state, not only a choice: it lingers into the next
  // scene and decays from there.
  const acuteDissociation = regulation.move === 'dissociate'
    ? clamp01(next.condition.dissociation.acute + 0.45)
    : clamp01(next.condition.dissociation.acute * 0.6);

  // --- 6. the body pays --------------------------------------------------
  const cost: SceneCost = { ...input.cost, arousal: ctx.felt.arousal };
  const body = stepBody(next.body, cost, p);
  const load = stepLoad(next.load, body, cost, p);
  next = {
    ...next,
    body,
    load,
    scenes: next.scenes + Math.max(1, cost.scenes ?? 1),
    condition: { ...next.condition, dissociation: { ...next.condition.dissociation, acute: acuteDissociation } },
  };

  // --- 7. re-read the condition ------------------------------------------
  next = { ...next, condition: assessCondition(next, input.graph, p), updatedAt: input.now };

  const affect = express(ctx.felt, regulation, next.dynamics.granularity);

  return {
    psyche: next,
    mood: blended.mood,
    affect,
    trace,
    regulation,
    intrusions: fired.map((f) => ({
      nodeId: f.trauma.nodeId,
      text: input.nodeGist(f.trauma.nodeId),
      probability: f.probability,
    })),
    pull: actionTendency(ctx.felt),
  };
}

/**
 * Advance the psyche over elapsed time with no scene — the mind between scenes
 * (§P.7). Sleep recovers load and softens *elaborated* memories only; everything
 * else relaxes toward its set-point at its own rate.
 */
export function restScene(
  psyche: PsycheState,
  opts: { scenes: number; slept: boolean; safe: boolean; supported?: boolean },
  p: PsycheParams,
): PsycheState {
  const cost: SceneCost = {
    arousal: 0.1,
    slept: opts.slept,
    safe: opts.safe,
    supported: opts.supported,
    scenes: opts.scenes,
  };
  const body = stepBody(psyche.body, cost, p);
  const load = stepLoad(psyche.load, body, cost, p);
  return {
    ...psyche,
    body,
    load,
    scenes: psyche.scenes + opts.scenes,
    condition: {
      ...psyche.condition,
      dissociation: {
        ...psyche.condition.dissociation,
        acute: clamp01(psyche.condition.dissociation.acute * 0.4),
      },
    },
  };
}

/** Convenience for the composer: the one-line state read. */
export function describeState(psyche: PsycheState, affect: ExpressedAffect): string {
  return describeFeeling(affect.felt, psyche.dynamics.granularity);
}

export { bodyCapacity };
