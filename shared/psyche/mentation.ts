/**
 * Offline mentation (§P.7) — the mind between scenes.
 *
 * v1 consolidated on message count alone, so a character was exactly as wrecked
 * after a week of safety as they were the moment the scene ended. Real minds
 * process *time*.
 *
 * The sleep model is the load-bearing part. Slow-wave and REM sleep contribute
 * differently: after sleep, item-level detail is reduced while category-level
 * representation is preserved and strengthened, and REM supports integration of
 * schema-congruent material and the decontextualisation of new memories. Our
 * consolidation pass already implements gist abstraction and verbatim decay — it
 * simply never knew that sleep is what drives them.
 *
 * The asymmetry that makes this matter dramatically: **sleep only helps memories
 * that have been elaborated.** Time heals what you have looked at. It does
 * nothing at all for what you have refused to look at — which is why a character
 * who avoids can be given three peaceful weeks and come back no better.
 */
import { clamp01, lerp } from './defaults';
import { restScene } from './step';
import { restTrauma } from './trauma';
import { assessCondition, type GraphSummary } from './condition';
import { retuneDynamics } from './dynamics';
import type { PsycheParams, PsycheState, RegulationMove } from './types';

/** What happened to this character while nothing was being narrated. */
export interface Interlude {
  /** In-fiction hours that passed. */
  hours: number;
  /** Were they able to sleep. */
  slept: boolean;
  /** Were they safe for most of it. */
  safe: boolean;
  /** Was anyone with them. */
  supported?: boolean;
  now: number;
}

export interface MentationResult {
  psyche: PsycheState;
  /** What their mind did with the time, for the audit log and the Mind page. */
  events: string[];
}

/**
 * How many "scenes" of drift an interlude is worth.
 *
 * Sub-linear on purpose: the first night away from something does most of the
 * work, and the tenth adds little. A linear rate would let a long time-skip
 * trivially cure anything, which is both wrong and dramatically ruinous.
 */
function scenesFor(hours: number): number {
  if (hours <= 0) return 0;
  return Math.min(24, Math.log2(1 + hours / 6) * 3);
}

/**
 * Advance the psyche across a gap in the narration.
 *
 * Runs the four things minds do with unstructured time — recover, sleep, brood,
 * or work at it — and picks between the last two from the character's own state
 * rather than at random. A depressed, loaded character broods; a reflective, safe
 * one processes; that difference compounds across every gap in the story.
 */
export function mentate(
  psyche: PsycheState,
  interlude: Interlude,
  graph: GraphSummary,
  p: PsycheParams,
): MentationResult {
  const scenes = scenesFor(interlude.hours);
  if (scenes < 0.5) return { psyche, events: [] };

  const events: string[] = [];
  let next = restScene(psyche, {
    scenes,
    slept: interlude.slept,
    safe: interlude.safe,
    supported: interlude.supported,
  }, p);

  if (interlude.slept && interlude.safe) {
    events.push(`slept for ${Math.round(interlude.hours)}h — some of it settled`);
  } else if (!interlude.safe) {
    events.push('never off guard long enough for any of it to settle');
  }

  // --- what the mind did with the quiet ---------------------------------
  /**
   * Brooding versus deliberate rumination is the single fork that separates
   * chronic distress from post-traumatic growth. Both are "thinking about it".
   * Only one of them integrates anything.
   */
  /**
   * Functional avoidance is a *habit*, not a mood.
   *
   * Without this term, a character with high defensive maturity would sit down in
   * a quiet week and process something they have refused to look at nine times —
   * which is precisely the thing that does not happen. Avoidance of a specific
   * memory keeps that memory out of reach of deliberate work, and pushes the
   * quiet time into brooding instead. This is the CaR-FA-X avoidance mechanism.
   */
  const avoidanceHabit = next.traumas.length
    ? clamp01(mean(next.traumas.map((t) =>
      (t.avoidanceCount + t.approachCount) > 0
        ? t.avoidanceCount / (t.avoidanceCount + t.approachCount)
        : 0)))
    : 0;

  const broodPressure =
    0.4 * next.condition.depression.severity
    + 0.3 * next.load.level
    + 0.3 * (1 - next.defenseMaturity)
    + 0.3 * avoidanceHabit;
  const workPressure = (
    0.4 * next.defenseMaturity
    + 0.3 * (interlude.safe ? 1 : 0)
    + 0.3 * next.dynamics.granularity
  ) * (1 - 0.8 * avoidanceHabit);

  const mode: RegulationMove | null = next.traumas.length || next.condition.depression.severity > 0.2
    ? (broodPressure > workPressure ? 'ruminate_brood' : 'ruminate_deliberate')
    : null;

  if (mode) {
    const reps = Math.max(1, Math.round(scenes / 4));
    next = {
      ...next,
      copingHistory: [
        ...next.copingHistory,
        ...Array.from({ length: reps }, () => ({
          at: interlude.now,
          move: mode,
          level: (mode === 'ruminate_deliberate' ? 'mature' : 'neurotic') as 'mature' | 'neurotic',
        })),
      ].slice(-60),
    };

    if (mode === 'ruminate_brood') {
      // Brooding reactivates without integrating: the memory gets *stronger* and
      // no more bearable, which is the mechanism behind depressive persistence.
      events.push('could not leave it alone, and got no further with it');
      next = {
        ...next,
        load: { ...next.load, level: clamp01(next.load.level + 0.02 * scenes) },
        traumas: next.traumas.map((t) => ({
          ...t,
          nowness: clamp01(t.nowness + 0.02 * scenes),
          appraisals: {
            ...t.appraisals,
            selfBlame: clamp01(t.appraisals.selfBlame + 0.015 * scenes),
          },
        })),
      };
    } else {
      events.push('turned it over deliberately, and got somewhere with it');
      next = {
        ...next,
        traumas: next.traumas.map((t) => ({
          ...t,
          elaboration: clamp01(t.elaboration + 0.03 * scenes),
          nowness: clamp01(t.nowness - 0.02 * scenes),
        })),
        defenseMaturity: clamp01(next.defenseMaturity + p.maturityGain * scenes * 0.3),
      };
    }
  }

  // --- sleep works on what has been elaborated --------------------------
  if (interlude.slept) {
    const before = next.traumas.map((t) => t.nowness);
    next = {
      ...next,
      traumas: next.traumas.map((t) => restTrauma(t, scenes, true)),
    };
    const softened = next.traumas.some((t, i) => t.nowness < before[i] - 0.02);
    if (softened) events.push('sleep put some distance between them and it');
    else if (next.traumas.length) events.push('sleep did nothing for the part they will not look at');
  }

  // --- everything relaxes toward its set-point --------------------------
  const relax = clamp01(scenes / 20);
  next = {
    ...next,
    // Acute states are acute by definition.
    condition: {
      ...next.condition,
      dissociation: {
        ...next.condition.dissociation,
        acute: clamp01(next.condition.dissociation.acute * (1 - relax)),
      },
    },
    // Instability decays: a stretch with nothing happening is, by construction,
    // a stretch without emotional swings.
    dynamics: {
      ...next.dynamics,
      instability: clamp01(lerp(next.dynamics.instability, 0, relax * 0.5)),
    },
    attachment: interlude.supported
      ? {
        anxiety: clamp01(next.attachment.anxiety - 0.01 * scenes),
        avoidance: clamp01(next.attachment.avoidance - 0.015 * scenes),
      }
      : next.attachment,
    scenes: next.scenes,
    updatedAt: interlude.now,
  };

  next = {
    ...next,
    dynamics: retuneDynamics(next.dynamics, next.load, next.body, next.condition, p),
  };
  next = { ...next, condition: assessCondition(next, graph, p) };

  return { psyche: next, events };
}

/**
 * Estimate the interlude from wall-clock time between consolidation passes.
 *
 * Real time is a poor proxy for story time, so this is deliberately conservative:
 * it maps a real-world gap onto a plausible in-fiction one and assumes the
 * character slept if the gap spans what would be a night. The alternative —
 * ignoring gaps entirely — means a character who was abandoned mid-crisis three
 * weeks ago is still mid-crisis, which is worse.
 */
export function inferInterlude(lastAt: number, now: number, safe: boolean): Interlude | null {
  const hours = (now - lastAt) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 4) return null;
  return {
    // Cap it: a character left alone for a year has not lived a year of story.
    hours: Math.min(hours, 24 * 14),
    slept: hours >= 7,
    safe,
    now,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
