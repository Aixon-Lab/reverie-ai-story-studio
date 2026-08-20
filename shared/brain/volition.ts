/**
 * Volition — what the character is trying to do, and why they will not stop.
 *
 * `WorkingSelf.goals` has existed since the beginning and nothing has ever
 * written to it. That is not a small omission: a character with memory, feeling
 * and a personality but no *want* is a very sophisticated reactive system. They
 * answer well and they never push. Every scene is something that happens to
 * them.
 *
 * OpenHuman's three-layer model is the right shape (§B.2 #24–#27), and the
 * middle layer is the one that matters here:
 *
 *   **Long-term goals** — few, durable, capped, maintained by a periodic curator
 *   that is explicitly allowed to do nothing. These are who the character is
 *   pointed at across the whole story.
 *
 *   **Scene intention** — exactly one, with a **time to live**. This is the
 *   dramatic objective: not "she wants to be safe" but "she wants to get him to
 *   say where he was on Tuesday". An intention that never expires is not an
 *   intention, it is a personality trait, which is why the TTL is not optional.
 *
 *   **Steering** — an external directive, also with a TTL, that biases which
 *   intention forms. This is the hook a story-direction feature steers through:
 *   it does not script the character, it tilts what they reach for, and the
 *   psyche still decides whether they can.
 *
 * Everything here is local arithmetic over state the engine already computes —
 * relationships, goals, load, trauma, appraisal. No LLM call, and the intention
 * is chosen from a small taxonomy of dramatic objectives rather than written,
 * so it is inspectable and cannot hallucinate a motive the character never had.
 */
import { clamp01 } from './activation';
import { TIME_UNIT_MS } from './defaults';
import { personKey } from './personality';
import { resolvePerson } from './entities';
import type { AppraisedEvent, BrainState, Goal, RelationModel } from './types';

// ---------- intention ----------

/**
 * The small taxonomy of dramatic objectives.
 *
 * Deliberately small. A larger set would be more expressive and far less
 * legible, and the point of choosing structurally rather than generating prose
 * is that a reader of the Mind page can see *why* the character is behaving as
 * they are.
 */
export type IntentionKind =
  /** Advance a standing goal. */
  | 'pursue'
  /** Mend something with someone they still care about. */
  | 'repair'
  /** Say the thing they have been carrying. */
  | 'confront'
  /** Keep something from being found out. */
  | 'conceal'
  /** Get out of this — the situation, the conversation, the room. */
  | 'withdraw'
  /** Find out where they actually stand with someone. */
  | 'test'
  /** Get through it. Not a goal so much as a floor. */
  | 'endure'
  /** Nothing pressing: be here. */
  | 'enjoy';

export interface Intention {
  id: string;
  kind: IntentionKind;
  /** Who it is aimed at, if anyone. */
  target?: string;
  /** The long-term goal it serves, if it serves one. */
  goalId?: string;
  /** The objective in plain words — what goes in the prompt. */
  text: string;
  /** 0..1 — how hard they are pushing on it. */
  urgency: number;
  formedAt: number;
  /**
   * Turns of life remaining. Decremented every generation; at zero the
   * intention lapses and a new one may form. Without this a character locks
   * onto one objective and pursues it for the rest of the story.
   */
  ttl: number;
  status: 'active' | 'satisfied' | 'thwarted' | 'expired';
  /** −1 fully blocked … +1 achieved. Accumulated from appraisal, not asserted. */
  progress: number;
  /** Why this one and not another. Mind page only. */
  rationale: string;
}

/**
 * An external nudge on what the character reaches for.
 *
 * Expires, exactly as OpenHuman's steering directives do (§B.2 #27). A directive
 * with no TTL is indistinguishable from an instruction in the system prompt, and
 * it would quietly become permanent the moment anybody forgot to clear it.
 */
export interface SteeringDirective {
  /** What the story wants from this stretch, in the director's own words. */
  text: string;
  /** Bias toward this objective, when the director named one. */
  prefer?: IntentionKind;
  setAt: number;
  /** Turns remaining. */
  ttl: number;
}

/** Turns a freshly formed intention lives for, before urgency scaling. */
export const INTENTION_TTL = 10;

/**
 * How much better a candidate must score to displace the current intention.
 *
 * Without hysteresis the objective flickers turn to turn as relationship numbers
 * jitter, and a character who changes what they want every time you speak reads
 * as having no interior at all.
 */
const SWITCH_MARGIN = 0.18;

export interface IntentionContext {
  /** Names present in the scene. */
  present: string[];
  now: number;
  makeId: () => string;
}

interface Candidate {
  kind: IntentionKind;
  score: number;
  target?: string;
  goalId?: string;
  text: string;
  rationale: string;
}

/**
 * Choose what the character is trying to do right now.
 *
 * Returns the existing intention unchanged when nothing has displaced it, which
 * is the common case and is what makes an objective feel *held* rather than
 * re-derived.
 */
export function formIntention(brain: BrainState, ctx: IntentionContext): Intention {
  const current = brain.intention;
  const candidates = scoreCandidates(brain, ctx);
  const best = candidates[0];

  // A live intention keeps the floor unless something clearly beats it.
  if (current && current.status === 'active' && current.ttl > 0) {
    const currentScore = candidates.find((c) => c.kind === current.kind && c.target === current.target)?.score ?? 0;
    if (!best || best.score < currentScore + SWITCH_MARGIN) return current;
  }

  const urgency = clamp01(best.score);
  return {
    id: ctx.makeId(),
    kind: best.kind,
    target: best.target,
    goalId: best.goalId,
    text: best.text,
    urgency,
    formedAt: ctx.now,
    // Something urgent burns brighter and shorter; a low simmer lasts.
    ttl: Math.max(4, Math.round(INTENTION_TTL * (1.4 - 0.6 * urgency))),
    status: 'active',
    progress: 0,
    rationale: best.rationale,
  };
}

function scoreCandidates(brain: BrainState, ctx: IntentionContext): Candidate[] {
  const out: Candidate[] = [];
  const psyche = brain.psyche;
  const name = brain.characterName;
  const steer = activeSteer(brain, ctx.now);

  const present = ctx.present
    .map((p) => brain.people[resolvePerson(brain, p)] ?? brain.people[personKey(p)])
    .filter((r): r is RelationModel => !!r);

  // --- pursue: the strongest standing goal ---
  const goal = [...brain.workingSelf.goals]
    .filter((g) => g.status === 'active')
    .sort((a, b) => b.priority - a.priority)[0];
  if (goal) {
    out.push({
      kind: 'pursue',
      score: 0.3 + 0.4 * clamp01(goal.priority),
      goalId: goal.id,
      text: goal.text,
      rationale: 'their strongest standing goal',
    });
  }

  for (const rel of present) {
    // --- repair: still cares, and something is wrong ---
    const damage = Math.max(0, rel.resentment) + Math.max(0, -rel.trust);
    if (rel.affection > 0.25 && damage > 0.35) {
      out.push({
        kind: 'repair',
        score: 0.35 + 0.35 * clamp01(damage) + 0.2 * clamp01(rel.affection),
        target: rel.displayName,
        text: `get back to something workable with ${rel.displayName}`,
        rationale: `still cares about ${rel.displayName} and something is badly wrong`,
      });
    }

    /**
     * --- confront: a grievance they have the nerve to raise ---
     *
     * Nerve scales the *whole* score rather than being added to a floor. A
     * character who is terrified of somebody does not reach for confrontation
     * slightly less often; they do not reach for it. Giving it a base score
     * meant a cowed character would still, eventually, square up — which is a
     * different story than the one their state is telling.
     */
    const nerve = clamp01(0.5 + 0.5 * brain.traits.courage) * (1 - clamp01(rel.fear));
    if (rel.resentment > 0.4) {
      out.push({
        kind: 'confront',
        score: (0.25 + 0.55 * clamp01(rel.resentment)) * nerve,
        target: rel.displayName,
        text: `say the thing they have been carrying about ${rel.displayName}`,
        rationale: `resents ${rel.displayName} and is not too frightened to say so`,
      });
    }

    // --- test: they genuinely do not know where they stand ---
    if (rel.familiarity < 0.55 && Math.abs(rel.trust) < 0.3) {
      out.push({
        kind: 'test',
        score: 0.25 + 0.3 * (1 - rel.familiarity),
        target: rel.displayName,
        text: `work out what ${rel.displayName} actually wants from them`,
        rationale: `does not yet know what to make of ${rel.displayName}`,
      });
    }
  }

  if (psyche) {
    // --- conceal: something they cannot afford to have found out ---
    const shame = Math.max(
      0,
      ...psyche.traumas.map((t) => t.appraisals.shame),
    );
    if (shame > 0.4 && present.length) {
      out.push({
        kind: 'conceal',
        score: 0.3 + 0.45 * shame,
        target: present[0].displayName,
        text: 'keep the conversation away from what they cannot talk about',
        rationale: 'carrying something they are ashamed of, with company present',
      });
    }

    // --- withdraw: out of capacity ---
    const spent = clamp01(0.5 * psyche.load.level + 0.3 * (1 - psyche.body.energy) + 0.2 * psyche.condition.ptsd.avoidance);
    if (spent > 0.55) {
      out.push({
        kind: 'withdraw',
        score: 0.2 + 0.6 * spent,
        text: 'get out of this without a scene',
        rationale: 'has nothing left to spend on it',
      });
    }

    // --- endure: nothing is available except getting through it ---
    const cornered = clamp01(0.5 * (1 - psyche.body.safety) + 0.3 * psyche.body.pain + 0.2 * psyche.load.level);
    if (cornered > 0.6) {
      out.push({
        kind: 'endure',
        score: 0.25 + 0.55 * cornered,
        text: 'get through the next few minutes intact',
        rationale: 'not safe enough to want anything else yet',
      });
    }
  }

  // --- enjoy: the floor. Somebody with nothing pressing is not motiveless. ---
  out.push({
    kind: 'enjoy',
    score: 0.22,
    text: present.length
      ? `be present with ${present.map((r) => r.displayName).join(' and ')}`
      : 'be where they are',
    rationale: `nothing is pressing on ${name} right now`,
  });

  /**
   * The director's thumb on the scale.
   *
   * A bias, not an override: a steered objective still has to be one the
   * character could plausibly hold, and a terrified character told to confront
   * will still, correctly, withdraw. Steering that could force any behaviour
   * would make the whole psyche layer decorative.
   */
  if (steer?.prefer) {
    for (const c of out) {
      if (c.kind === steer.prefer) {
        c.score += 0.3;
        c.rationale = `${c.rationale}; the scene is leaning this way`;
      }
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

// ---------- advancing ----------

export interface IntentionOutcome {
  intention: Intention | null;
  /** Set when this call ended one. */
  resolved?: 'satisfied' | 'thwarted' | 'expired';
}

/**
 * Spend one turn of the current intention.
 *
 * Called once per generation. Expiry is the interesting case: an objective that
 * simply runs out is how a scene changes subject, and it happens far more often
 * than an objective being achieved.
 */
export function spendIntention(brain: BrainState): IntentionOutcome {
  const intention = brain.intention;
  if (!intention || intention.status !== 'active') return { intention: intention ?? null };

  intention.ttl -= 1;
  if (intention.ttl > 0) return { intention };

  intention.status = 'expired';
  return { intention, resolved: 'expired' };
}

/**
 * Read progress off the appraisals of what just happened.
 *
 * `goalConduciveness` is already computed for every event by the encoder, and it
 * is exactly the question "did that help or hinder what they are trying to do".
 * Using it means progress is *observed* rather than asserted — the character does
 * not get to declare their own objective satisfied.
 */
export function scoreIntention(brain: BrainState, events: AppraisedEvent[]): IntentionOutcome {
  const intention = brain.intention;
  if (!intention || intention.status !== 'active' || !events.length) {
    return { intention: intention ?? null };
  }

  const target = intention.target?.toLowerCase();
  const relevant = events.filter((e) => {
    if (e.appraisal.goalRelevance < 0.25) return false;
    if (!target) return true;
    return e.actors.some((a) => a.toLowerCase() === target);
  });
  if (!relevant.length) return { intention };

  const mean = relevant.reduce((s, e) => s + e.appraisal.goalConduciveness, 0) / relevant.length;
  intention.progress = Math.max(-1, Math.min(1, intention.progress + mean * 0.4));

  if (intention.progress >= 0.7) {
    intention.status = 'satisfied';
    // Getting what you wanted advances the goal it served.
    if (intention.goalId) {
      const goal = brain.workingSelf.goals.find((g) => g.id === intention.goalId);
      if (goal) goal.priority = clamp01(goal.priority - 0.15);
    }
    return { intention, resolved: 'satisfied' };
  }
  if (intention.progress <= -0.7) {
    intention.status = 'thwarted';
    if (intention.goalId) {
      const goal = brain.workingSelf.goals.find((g) => g.id === intention.goalId);
      // A goal that keeps being blocked is a goal that is blocked.
      if (goal) goal.status = 'blocked';
    }
    return { intention, resolved: 'thwarted' };
  }
  return { intention };
}

// ---------- steering ----------

/** The directive currently in force, or null once it has run out. */
export function activeSteer(brain: BrainState, now: number): SteeringDirective | null {
  const steer = brain.steer;
  if (!steer) return null;
  if (steer.ttl <= 0) return null;
  // A directive older than a day is stale whatever its turn count says — the
  // scene it was written for is over.
  if (now - steer.setAt > TIME_UNIT_MS) return null;
  return steer;
}

/** Spend one turn of the steering directive. */
export function spendSteer(brain: BrainState): void {
  if (brain.steer && brain.steer.ttl > 0) brain.steer.ttl -= 1;
}

/** Default life of a freshly applied directive, in turns. */
export const STEER_TTL = 12;

/**
 * Map a director intensity (1 quiet seed … 5 happens now) onto a TTL.
 *
 * High intensity is short: the scene is supposed to move *now*, and a
 * directive that outlives the beat it was written for becomes an instruction.
 * A quiet seed is allowed to sit for longer and colour what they reach for.
 */
export function ttlFromIntensity(intensity: number | undefined): number {
  const i = Number.isFinite(intensity) ? Math.max(1, Math.min(5, Math.round(intensity as number))) : 3;
  return i >= 5 ? 6 : i >= 4 ? 8 : i >= 3 ? 12 : i >= 2 ? 16 : 18;
}

/**
 * Plant a steering directive on this mind.
 *
 * Replaces whatever was there. A new instruction is a new instruction; stacking
 * them would make the character chase two scenes at once.
 */
export function setSteer(
  brain: BrainState,
  input: { text: string; prefer?: IntentionKind; now: number; ttl?: number },
): SteeringDirective {
  const text = input.text.trim().slice(0, 900);
  const steer: SteeringDirective = {
    text,
    prefer: input.prefer,
    setAt: input.now,
    ttl: Math.max(1, Math.round(input.ttl ?? STEER_TTL)),
  };
  brain.steer = text ? steer : undefined;
  return steer;
}

// ---------- the goal curator ----------

/** How many long-term goals a character may hold. OpenHuman's cap, for the same reason. */
export const MAX_GOALS = 8;

/** Days of being untouched before a goal is treated as abandoned. */
const STALE_GOAL_DAYS = 21;

export interface GoalReview {
  added: string[];
  retired: string[];
  blocked: string[];
  reprioritised: string[];
}

/**
 * The periodic curator (§B.2 #25).
 *
 * Minimal, justified changes only, and **doing nothing is a valid outcome** —
 * the discipline OpenHuman's Goals Curator states outright, and the reason its
 * goal list stays worth reading. A curator that churns produces a list nobody
 * trusts, which is worse than no list.
 *
 * Local: goals are promoted from what the character has repeatedly and
 * emotionally engaged with, which is visible in the memory graph without asking
 * a model.
 */
export function reviewGoals(brain: BrainState, now: number, makeId: () => string): GoalReview {
  const review: GoalReview = { added: [], retired: [], blocked: [], reprioritised: [] };
  const goals = brain.workingSelf.goals;

  // --- retire what has gone quiet ---
  for (const goal of goals) {
    if (goal.status !== 'active' && goal.status !== 'blocked') continue;
    const ageDays = (now - goal.updatedAt) / TIME_UNIT_MS;
    if (ageDays > STALE_GOAL_DAYS && goal.priority < 0.5) {
      goal.status = 'abandoned';
      goal.updatedAt = now;
      review.retired.push(goal.id);
    }
  }

  /**
   * --- promote what they keep coming back to ---
   *
   * A schema is, by construction, a conclusion drawn from several converging
   * episodes. One that is emotionally charged and not yet reflected in any goal
   * is the clearest local evidence that something matters to this character and
   * nobody has written it down.
   */
  const active = goals.filter((g) => g.status === 'active');
  if (active.length < MAX_GOALS) {
    for (const node of Object.values(brain.nodes)) {
      if (node.kind !== 'schema' || node.status !== 'active') continue;
      if (Math.abs(node.affect.valence) < 0.4 || node.useCount < 3) continue;
      const text = goalFromSchema(node.gist, node.affect.valence);
      if (!text) continue;
      if (goals.some((g) => overlaps(g.text, text))) continue;

      const goal: Goal = {
        id: makeId(),
        text,
        priority: clamp01(0.4 + 0.4 * Math.abs(node.affect.valence)),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      goals.push(goal);
      review.added.push(goal.id);
      if (goals.filter((g) => g.status === 'active').length >= MAX_GOALS) break;
    }
  }

  /**
   * --- keep the list small ---
   *
   * Over the cap, the weakest active goal is retired rather than the oldest.
   * A long-standing quiet commitment is more characteristic than a loud recent
   * one, and dropping by age would churn the list every time something happened.
   */
  const stillActive = goals.filter((g) => g.status === 'active').sort((a, b) => a.priority - b.priority);
  for (const goal of stillActive.slice(0, Math.max(0, stillActive.length - MAX_GOALS))) {
    goal.status = 'abandoned';
    goal.updatedAt = now;
    review.retired.push(goal.id);
  }

  return review;
}

/**
 * Turn a belief into something to want.
 *
 * Only the two shapes that reliably imply an objective. A belief that does not
 * suggest one is left alone rather than forced into the list — most beliefs are
 * not goals, and pretending otherwise is how a goal list fills with noise.
 */
function goalFromSchema(gist: string, valence: number): string | null {
  const clean = gist.replace(/\s+/g, ' ').trim();
  if (clean.length < 12) return null;
  const core = clean.replace(/\s*—?\s*this keeps turning out to be true\.?$/i, '').trim();
  if (!core) return null;
  /**
   * The belief keeps its own capitalisation. Lower-casing the first word to make
   * it read as a clause silently destroys the proper noun that is usually
   * sitting there — "Rell cannot be relied on" became "rell cannot be relied
   * on", and the goal stopped naming the person it is about.
   */
  return valence < 0
    ? `Stop being caught out by this again: ${core}`
    : `Hold on to this: ${core}`;
}

function overlaps(a: string, b: string): boolean {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) > 0.55;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// ---------- composition ----------

/**
 * The prompt line for the current objective.
 *
 * One sentence, because this is the most expensive kind of context there is: it
 * changes behaviour directly. Returns empty when the character genuinely wants
 * nothing in particular, rather than padding the prompt with "they are content".
 */
export function describeIntention(intention: Intention | null | undefined, name: string): string {
  if (!intention || intention.status !== 'active') return '';
  const push = intention.urgency > 0.65 ? 'They are pushing for this' : 'They would like this';
  const held = intention.kind === 'conceal' || intention.kind === 'withdraw'
    ? ' — without announcing it'
    : '';
  return `**What ${name} wants out of this scene:** ${intention.text}. ${push}${held}, and it shapes what they steer toward and what they let pass.`;
}

/** Plain-language read-out for the Mind page. Never shown to the model. */
export function describeVolition(brain: BrainState): string {
  const i = brain.intention;
  if (!i) return 'No particular objective.';
  const state = i.status === 'active'
    ? `${i.ttl} turn${i.ttl === 1 ? '' : 's'} left`
    : i.status;
  return `${i.kind}${i.target ? ` → ${i.target}` : ''}: ${i.text} (${state}; ${i.rationale})`;
}
