/**
 * Body and allostatic load (§P.2.3, §P.2.4).
 *
 * The whole reason the body exists in this system is one coupling: bodily
 * capacity scales coping potential, and coping potential is the appraisal check
 * that decides whether a threat produces anger or fear (Scherer, §M.5.4).
 *
 * That means an exhausted, injured, unsafe character does not merely *narrate*
 * being tired. The identical provocation that would have produced fury three
 * scenes ago produces fear instead, and the identical threat that would have
 * produced defiance produces collapse. Everything else here serves that.
 */
import { clamp, clamp01, lerp } from './defaults';
import type { Body, Load, PsycheParams } from './types';

/**
 * 0..1 — how much of this character's nominal coping ability is actually
 * available right now.
 *
 * Weighted so that *safety* dominates: a rested, unhurt person in danger still
 * copes poorly, while a person in pain who is safe can still think. Pain and
 * sleep debt subtract, and the floor is deliberately above zero — people in
 * appalling states still act, they just act badly.
 */
export function bodyCapacity(body: Body): number {
  // Additive penalties rather than a product, so an ordinary healthy body sits
  // near 1 and only real deprivation bites. A multiplicative form quietly taxed
  // every character for being merely human, which made *everyone* read as
  // depleted and destroyed the contrast this number exists to create.
  const penalty =
    0.45 * (1 - clamp01(body.energy))
    + 0.35 * clamp01(body.sleepDebt)
    + 0.50 * clamp01(body.pain)
    + 0.40 * (1 - clamp01(body.safety))
    + 0.20 * (1 - clamp01(body.nourishment));
  return clamp(1 - penalty, 0.12, 1);
}

/**
 * Short phrase for the prompt, or empty when nothing is off baseline.
 *
 * Deliberately omitted when the body is fine: a state block that always fires is
 * noise the model learns to ignore, and "she is a bit tired" every single turn is
 * worse than silence.
 */
export function describeBody(body: Body): string {
  const bits: string[] = [];
  if (body.pain > 0.55) bits.push(body.pain > 0.8 ? 'in serious pain' : 'hurting');
  if (body.sleepDebt > 0.6) bits.push(body.sleepDebt > 0.85 ? 'badly sleep-deprived' : 'running on no sleep');
  if (body.energy < 0.3) bits.push(body.energy < 0.15 ? 'physically spent' : 'exhausted');
  if (body.safety < 0.3) bits.push(body.safety < 0.15 ? 'in immediate danger' : 'unsafe');
  if (body.nourishment < 0.3) bits.push('hungry');
  return bits.join(', ');
}

export interface SceneCost {
  /** Peak arousal reached this scene. */
  arousal: number;
  /** Did anything actually threaten them. */
  threatened?: boolean;
  /** Were they physically hurt. */
  harmed?: number;
  /** Did they get real connection from someone. */
  supported?: boolean;
  /** Did they sleep. */
  slept?: boolean;
  /** Is the situation currently safe. */
  safe?: boolean;
  /** Scenes elapsed, for time-based recovery. */
  scenes?: number;
}

/**
 * Advance the body one scene.
 *
 * Recovery is gated on safety, not on time: a character who is never safe never
 * recovers, no matter how many scenes pass. That asymmetry is the mechanism
 * behind captivity arcs feeling different from ordinary hard days.
 */
export function stepBody(body: Body, cost: SceneCost, p: PsycheParams): Body {
  const scenes = Math.max(1, cost.scenes ?? 1);
  const safe = cost.safe ?? true;

  let sleepDebt = clamp01(body.sleepDebt + p.sleepDebtRate * scenes);
  if (cost.slept) {
    // Sleeping while unsafe barely counts — vigilance fragments rest.
    sleepDebt = clamp01(sleepDebt - (safe ? 0.55 : 0.18) * scenes);
  }

  const drain = 0.05 * scenes + 0.12 * clamp01(cost.arousal) + 0.1 * clamp01(cost.harmed ?? 0);
  const recover = cost.slept && safe ? 0.45 * scenes : safe ? 0.06 * scenes : 0;
  const energy = clamp01(body.energy - drain + recover) * (1 - 0.25 * sleepDebt);

  const pain = clamp01(
    body.pain + clamp01(cost.harmed ?? 0) - (safe ? 0.08 : 0.03) * scenes,
  );

  // Safety tracks the situation quickly upward-down, slowly downward-up: it takes
  // one moment to stop feeling safe and a long time to start again.
  const safetyTarget = safe ? (cost.threatened ? 0.45 : 0.85) : 0.1;
  const safety = safetyTarget < body.safety
    ? lerp(body.safety, safetyTarget, 0.7)
    : lerp(body.safety, safetyTarget, 0.15 + (cost.supported ? 0.15 : 0));

  return {
    energy: clamp01(energy),
    sleepDebt,
    pain,
    safety: clamp01(safety),
    nourishment: clamp01(body.nourishment - 0.03 * scenes + (safe && cost.slept ? 0.15 : 0)),
  };
}

/**
 * Advance allostatic load one scene.
 *
 * Accumulation is fast and recovery is slow, and recovery additionally requires
 * safety *plus* rest *plus* connection — which is why one scene of genuine care
 * measurably helps and why a character who is never held never comes down.
 */
export function stepLoad(load: Load, body: Body, cost: SceneCost, p: PsycheParams): Load {
  const scenes = Math.max(1, cost.scenes ?? 1);
  const added = p.loadPerArousal * clamp01(cost.arousal) * scenes
    + (cost.threatened ? 0.05 : 0) * scenes
    + 0.08 * clamp01(cost.harmed ?? 0);

  // Relief is earned, and each ingredient is worth something on its own.
  const reliefFactor =
    (body.safety > 0.6 ? 1 : body.safety > 0.35 ? 0.4 : 0)
    * (1 - 0.5 * clamp01(body.sleepDebt))
    + (cost.supported ? 0.6 : 0)
    + (cost.slept && body.safety > 0.5 ? 0.5 : 0);
  const removed = p.reliefRate * reliefFactor * scenes;

  const level = clamp01(load.level + added - removed);
  const strained = level >= p.strainThreshold;

  return {
    level,
    sustainedScenes: strained ? load.sustainedScenes + scenes : 0,
    scenesSinceRelief: level > 0.3 ? load.scenesSinceRelief + scenes : 0,
    peak: Math.max(load.peak, level),
  };
}

/**
 * Chronicity multiplier, 1..~1.8.
 *
 * Load at 0.7 for twenty scenes is a categorically different injury from load at
 * 0.7 for one, and the literature on allostatic load is precisely about the
 * cumulative cost rather than the peak. This is how the difference gets felt.
 */
export function chronicity(load: Load): number {
  return 1 + Math.min(0.8, Math.log1p(load.sustainedScenes) / 4);
}

/** Short phrase for the prompt; empty below the strain threshold. */
export function describeLoad(load: Load, p: PsycheParams): string {
  if (load.level < p.strainThreshold) return '';
  const chronic = load.sustainedScenes > 8;
  if (load.level > 0.85) {
    return chronic
      ? 'at the absolute end of what they can carry, and have been for a long time'
      : 'at the end of what they can carry';
  }
  if (load.level > 0.7) return chronic ? 'worn down to nothing, for weeks now' : 'stretched dangerously thin';
  return chronic ? 'running on reserves they no longer have' : 'under real strain';
}
