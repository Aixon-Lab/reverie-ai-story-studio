/**
 * Mentation — what the mind does when nothing is happening to it.
 *
 * Until now this engine only ever moved when a message arrived. Between turns
 * the character was, quite literally, not there: no mood settling, no turning
 * something over, no arriving at a conclusion nobody prompted. That is the
 * single most mechanical thing about a conversational character, and it is not
 * a prompt problem — it is a missing loop.
 *
 * OpenHuman's subconscious supplies the shape (§B.2 #22–#23): a periodic tick
 * of `observe → reflect → commit`, with a **quiet path that costs nothing** when
 * the world has not changed, and the explicit discipline that *doing nothing is
 * the correct and common outcome*. That last part matters more than the loop. An
 * idle mind that produces a development every few minutes is not alive, it is
 * noisy — most ticks should change almost nothing.
 *
 * What happens on a tick, all of it pure local arithmetic and none of it an LLM
 * call:
 *
 *   **Wandering.** With no external cue, activation is driven by current
 *   concerns, standing goals and mood (Klinger's current-concern account of
 *   spontaneous thought). Whatever surfaces is what the character has been
 *   chewing on. This alone is why they come back different.
 *
 *   **Rumination.** If what surfaces is unresolved and painful, and this
 *   character broods, it is *rehearsed* — which strengthens it and adds to load.
 *   The vicious cycle as a mechanism rather than a description: brooding makes
 *   the memory more available, which makes brooding more likely.
 *
 *   **Incubation.** Memories that surface together and share cues but have never
 *   been linked get linked. Offline replay forming associations is most of what
 *   sleep is for, and it is where "I've just realised" comes from.
 *
 *   **Revaluation.** Eligibility traces let a recent outcome reach back and
 *   recolour what led to it (§B.2 #17). Nothing about the event changes; how it
 *   felt does — and that is what the character acts on next time.
 *
 * Pure, deterministic given an injected rng and clock.
 */
import { addTrace, clamp01, clampSigned } from './activation';
import { TIME_UNIT_MS } from './defaults';
import { updateMood } from './emotion';
import { addEdge, buildIndex, nodeCues } from './graph';
import { gainsOf, modulatorsOf } from './neuromodulation';
import { recall } from './retrieval';
import { eligibilityOf, markEligible, potentiate } from './synapse';
import { restScene } from '../psyche/step';
import { DEFAULT_PSYCHE_PARAMS } from '../psyche/defaults';
import type { Affect, BrainState, MemoryNode, RecallCue } from './types';

/**
 * Shortest gap that counts as time having passed.
 *
 * Below this a tick is not idling, it is polling: the mood would regress in
 * visible steps and the same memory would surface a dozen times an hour. Five
 * minutes matches OpenHuman's own floor, and for the same reason.
 */
export const MIN_TICK_MS = 5 * 60_000;

/** Beyond this, a single tick is capped so a week away does not arrive as one shock. */
export const MAX_TICK_DAYS = 1;

export interface MentationInput {
  now: number;
  makeId: () => string;
  rng?: () => number;
  /**
   * Force the tick to run regardless of elapsed time. The "think now" button;
   * nothing in the app passes it.
   */
  force?: boolean;
}

export interface MentationReport {
  /**
   * Nothing worth persisting happened. The caller must not write the brain back
   * — a quiet tick has to be genuinely free or the loop cannot run often.
   */
  quiet: boolean;
  elapsedMs: number;
  /** Memories that surfaced unbidden. */
  wandered: string[];
  /** Of those, the ones that were brooded over and are now stronger. */
  ruminated: string[];
  /** Associations formed offline. */
  linked: { from: string; to: string }[];
  /** Memories recoloured by how things turned out afterwards. */
  revalued: string[];
  moodBefore: Affect;
  moodAfter: Affect;
  at: number;
}

function emptyReport(brain: BrainState, now: number, elapsedMs: number): MentationReport {
  return {
    quiet: true,
    elapsedMs,
    wandered: [],
    ruminated: [],
    linked: [],
    revalued: [],
    moodBefore: { ...brain.mood },
    moodAfter: { ...brain.mood },
    at: now,
  };
}

/**
 * One tick of the idle mind.
 *
 * Returns `quiet: true` and leaves the brain untouched whenever there is nothing
 * to do, which is most of the time and is the point.
 */
export function mentate(brain: BrainState, input: MentationInput): MentationReport {
  const now = input.now;
  const rng = input.rng ?? Math.random;
  const last = brain.stats.lastMentationAt ?? brain.stats.lastUpdateAt ?? brain.updatedAt ?? now;
  const elapsedMs = Math.max(0, now - last);

  const report = emptyReport(brain, now, elapsedMs);

  // ---- observe: is there anything here at all? ----
  if (!input.force && elapsedMs < MIN_TICK_MS) return report;
  /**
   * A mind with almost nothing in it has nothing to wander through. Ticking it
   * would produce mood regression against an empty history, which is not
   * introspection, it is drift.
   */
  const pool = Object.values(brain.nodes).filter((n) => n.status !== 'dormant');
  if (pool.length < 3) return report;

  const elapsedDays = Math.min(MAX_TICK_DAYS, elapsedMs / TIME_UNIT_MS);
  report.quiet = false;

  // ---- reflect ----
  const gains = gainsOf(modulatorsOf(brain, 'idle'));

  const wandered = wander(brain, now, rng);
  report.wandered = wandered.map((n) => n.id);

  report.ruminated = ruminate(brain, wandered, now, elapsedDays);
  report.linked = incubate(brain, wandered, now);
  report.revalued = revalue(brain, now);

  // Mood settles toward temperament over the time that actually passed, at the
  // rate this character's serotonin allows — a strained mind settles slower.
  const settles = Math.min(4, Math.max(1, Math.round(elapsedDays * 24 / 6)));
  for (let i = 0; i < settles; i++) {
    brain.mood = updateMood(brain.mood, [], brain.traits, brain.config.params, gains.moodInertia);
  }

  /**
   * Whatever surfaced was still felt. A character who spends the gap between
   * scenes turning over the worst thing that happened does not come back to
   * neutral, and this is the only place that shows up.
   */
  const feltAffects = wandered.filter((n) => n.affect.arousal > 0.3).map((n) => n.affect);
  if (feltAffects.length) {
    brain.mood = updateMood(brain.mood, feltAffects, brain.traits, brain.config.params, gains.moodInertia);
  }

  // The psyche has its own between-scenes advance; reuse it rather than
  // reimplementing recovery here.
  if (brain.psyche) {
    const scenes = Math.max(1, Math.round(elapsedDays * 4));
    brain.psyche = restScene(
      brain.psyche,
      {
        scenes,
        // A gap long enough to have slept in.
        slept: elapsedDays >= 0.3,
        safe: (brain.psyche.body.safety ?? 0.5) >= 0.5,
      },
      DEFAULT_PSYCHE_PARAMS,
    );
    // Brooding is work. It costs what it looks like it costs.
    if (report.ruminated.length) {
      brain.psyche = {
        ...brain.psyche,
        load: {
          ...brain.psyche.load,
          level: clamp01(brain.psyche.load.level + 0.03 * report.ruminated.length),
        },
      };
    }
  }

  // ---- commit ----
  report.moodAfter = { ...brain.mood };
  brain.stats.lastMentationAt = now;
  brain.stats.mentationTicks = (brain.stats.mentationTicks ?? 0) + 1;
  brain.updatedAt = now;
  return report;
}

// ---------- wandering ----------

/**
 * What comes to mind when nothing is asking.
 *
 * The cue is built from the working self rather than from anything external:
 * unresolved goals, standing preoccupations, and the mood the character is
 * actually in. That is Klinger's current-concern account, and it is why an idle
 * mind is not a random-access one — it returns, over and over, to the things
 * that are not finished.
 */
function wander(brain: BrainState, now: number, rng: () => number): MemoryNode[] {
  const concerns = brain.workingSelf.concerns ?? [];
  const goals = brain.workingSelf.goals.filter((g) => g.status === 'active' || g.status === 'blocked');

  const cue: RecallCue = {
    text: [...concerns, ...goals.map((g) => g.text)].join('. '),
    actors: [],
    keywords: concerns.map((c) => c.toLowerCase()),
    mood: brain.mood,
    goals: goals.map((g) => g.text),
    now,
  };

  /**
   * Spontaneous recall is *noisier* than cued recall, not merely weaker.
   *
   * With nothing outside steering it, what surfaces is far less determined —
   * which is both the phenomenology of mind-wandering and the thing that stops
   * an idle mind returning the same three memories on every tick for a week.
   * Raising the noise is the principled way to get that; a separate random gate
   * on top would be the same effect bolted on twice.
   *
   * Mutation is off: what surfaces is decided here, and its consequences are
   * applied deliberately below rather than as retrieval side effects.
   */
  const idle = gainsOf(modulatorsOf(brain, 'idle'));
  const result = recall(brain, cue, {
    rng,
    mutate: false,
    phase: 'idle',
    gains: { ...idle, noiseScale: idle.noiseScale * 2.2 },
    limit: 12,
  });

  const picked: MemoryNode[] = [];
  for (const hit of result.hits) {
    /**
     * Beliefs and self-defining memories are not *events* that come back to
     * you — they are the lens you are looking through. Surfacing them as though
     * they had just occurred to the character is a category error, and it reads
     * as one.
     */
    if (hit.node.kind === 'schema' || hit.node.kind === 'identity') continue;
    picked.push(hit.node);
    if (picked.length >= 3) break;
  }

  for (const n of picked) {
    // Surfacing is a use — that is what makes idle thought consolidating.
    addTrace(n, now, brain.config.params);
    markEligible(n, now);
  }
  return picked;
}

// ---------- rumination ----------

/**
 * Does this character brood, and did they just brush against something raw?
 *
 * Brooding is not a personality label here; it is read off the psyche — low
 * defense maturity, high load, an unresolved trauma — so a character who has
 * been through a hard stretch ruminates *because of* the hard stretch, and stops
 * when they recover.
 */
function ruminate(
  brain: BrainState,
  wandered: MemoryNode[],
  now: number,
  elapsedDays: number,
): string[] {
  const psyche = brain.psyche;
  if (!psyche) return [];

  const brooding = clamp01(
    0.4 * psyche.load.level
    + 0.3 * (1 - psyche.defenseMaturity)
    + 0.3 * (psyche.condition.depression.brooding ?? 0),
  );
  if (brooding < 0.45) return [];

  const out: string[] = [];
  for (const node of wandered) {
    // Only the unresolved and unpleasant get chewed on.
    if (node.affect.valence > -0.25 || node.affect.arousal < 0.35) continue;
    /**
     * Rehearsal without resolution: the memory gets stronger and *less* accurate.
     * Going over something repeatedly does not recover detail, it smooths the
     * account and deepens the groove — which is exactly why rumination is
     * maintaining rather than therapeutic.
     */
    addTrace(node, now, brain.config.params);
    potentiate(node, 0.04 * Math.min(3, elapsedDays * 8), now);
    node.fidelity = clamp01(node.fidelity - 0.004);
    node.confidence = clamp01(node.confidence + 0.01);
    out.push(node.id);
  }
  return out;
}

// ---------- incubation ----------

/**
 * Associations formed offline between things that surfaced together.
 *
 * Two memories that keep arriving in the same idle moment and share their cues
 * are, for this mind, about the same thing — whether or not anything in the
 * transcript ever said so. Linking them is what replay is for, and it is where
 * a connection nobody wrote comes from.
 */
function incubate(brain: BrainState, wandered: MemoryNode[], now: number): { from: string; to: string }[] {
  if (wandered.length < 2) return [];
  const index = buildIndex(brain);
  const made: { from: string; to: string }[] = [];

  for (let i = 0; i < wandered.length; i++) {
    for (let j = i + 1; j < wandered.length; j++) {
      const a = wandered[i];
      const b = wandered[j];
      // Already connected? Then there is nothing to realise.
      const linked = (index.adjacency.get(a.id) ?? []).some(
        (e) => e.from === b.id || e.to === b.id,
      );
      if (linked) continue;

      const shared = sharedCues(a, b);
      if (shared < 2) continue;
      const edge = addEdge(brain, a.id, b.id, 'reminds_of', Math.min(0.6, 0.2 + 0.12 * shared),
        'connected while the mind was idling');
      if (edge) made.push({ from: a.id, to: b.id });
    }
  }
  return made;
}

function sharedCues(a: MemoryNode, b: MemoryNode): number {
  const set = new Set(nodeCues(b));
  let n = 0;
  for (const cue of nodeCues(a)) if (set.has(cue)) n++;
  return n;
}

// ---------- revaluation ----------

/**
 * Let how things turned out reach back and recolour what led there.
 *
 * The distal reward problem (§B.2 #17): the outcome arrives long after the
 * moments that produced it, so something has to remember which moments were
 * live. That is the eligibility trace. The most recent strongly-felt memory acts
 * as the outcome signal, and everything still eligible is pulled a little toward
 * how it turned out.
 *
 * This is the mechanism behind "I should have seen it coming" — nothing new was
 * learned about that evening, but it does not feel the way it used to.
 */
function revalue(brain: BrainState, now: number): string[] {
  const outcome = mostRecentSignal(brain, now);
  if (!outcome) return [];

  const out: string[] = [];
  for (const node of Object.values(brain.nodes)) {
    if (node.id === outcome.id) continue;
    if (node.pinned || node.kind === 'sensory') continue;
    // Only what came *before* the outcome can be explained by it.
    if (node.encodedAt >= outcome.encodedAt) continue;

    const c = eligibilityOf(node, now);
    if (c < 0.2) continue;

    const before = node.affect.valence;
    const pull = 0.18 * c * Math.abs(outcome.affect.valence);
    const after = clampSigned(before + (outcome.affect.valence - before) * pull);
    if (Math.abs(after - before) < 0.03) continue;
    node.affect = { ...node.affect, valence: after };
    out.push(node.id);
  }
  return out;
}

/** The strongest recent feeling — the thing that turned out to matter. */
function mostRecentSignal(brain: BrainState, now: number): MemoryNode | null {
  let best: MemoryNode | null = null;
  let bestScore = 0;
  for (const node of Object.values(brain.nodes)) {
    const ageDays = (now - node.encodedAt) / TIME_UNIT_MS;
    if (ageDays > 2 || ageDays < 0) continue;
    const score = Math.abs(node.affect.valence) * node.affect.arousal;
    if (score > bestScore) { bestScore = score; best = node; }
  }
  // A weak signal explains nothing and should not repaint anything.
  return bestScore >= 0.35 ? best : null;
}

/**
 * Plain-language account of a tick, for the Mind page and the audit log.
 * Never shown to the model — the character does not narrate their own idling.
 */
export function describeMentation(report: MentationReport, name: string): string {
  if (report.quiet) return `${name} was still.`;
  const bits: string[] = [];
  if (report.wandered.length) bits.push(`${report.wandered.length} thing${report.wandered.length === 1 ? '' : 's'} came back to them`);
  if (report.ruminated.length) bits.push(`turned ${report.ruminated.length} of them over without resolving anything`);
  if (report.linked.length) bits.push(`connected ${report.linked.length} pair${report.linked.length === 1 ? '' : 's'} that had not been connected`);
  if (report.revalued.length) bits.push(`${report.revalued.length} older memor${report.revalued.length === 1 ? 'y' : 'ies'} started to feel different`);
  const moodShift = report.moodAfter.valence - report.moodBefore.valence;
  if (Math.abs(moodShift) > 0.08) bits.push(moodShift > 0 ? 'settled a little' : 'sank a little');
  return bits.length ? `${name} ${bits.join('; ')}.` : `${name} was still.`;
}
